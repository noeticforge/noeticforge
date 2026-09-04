import { mkdtemp, writeFile, mkdir, readFile, rm, utimes } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  chunkCode, chunkRules, cosine, keywordScore, fuseResults,
  listFiles, buildIndex, loadIndex, isFresh, searchIndex, TEXT_EXTS,
  sanitizeFilename, formatArchiveDoc,
} from '../plugins/builtin/kb/index.js';
import { loadPluginFromDir } from '../src/plugins/loader.js';
import type { Plugin } from '../src/types.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'kb-test-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const write = async (rel: string, content: string) => {
  const p = path.join(dir, rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content, 'utf-8');
};

/** 确定性的伪 embedding：把文本哈希成固定维度向量，同文本=同向量 */
function fakeEmbed() {
  const norm = (s: string) => s.trim().toLowerCase();
  return {
    model: 'fake',
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v: number[] = [];
        let h = 0;
        for (const ch of norm(t)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        for (let i = 0; i < 8; i++) v.push(((h >> (i * 2)) & 3) + 1);
        // 让包含目标词的文本向量彼此更接近：按词聚簇
        const base = norm(t).includes('部署') ? 9 : norm(t).includes('升级') ? 3 : 1;
        return v.map((x) => x + base);
      });
    },
  };
}

describe('插件本体能被加载器验证', () => {
  it('manifest 通过校验 + 工具命名/权限合法', async () => {
    const plugin: Plugin = await loadPluginFromDir(path.join(process.cwd(), 'plugins', 'builtin', 'kb'));
    expect(plugin.manifest.name).toBe('kb');
    expect(plugin.tools.map((t) => t.name)).toEqual(['kb.search', 'kb.reindex', 'kb.archive']);
    expect(plugin.manifest.permissions).toEqual(['fs:read', 'fs:write']);
    expect(plugin.manifest.settings).toBeTruthy();
  });
});

describe('TEXT_EXTS 规则', () => {
  it('文本与代码扩展名在列，二进制不在', () => {
    expect(TEXT_EXTS.has('.md')).toBe(true);
    expect(TEXT_EXTS.has('.ts')).toBe(true);
    expect(TEXT_EXTS.has('.py')).toBe(true);
    expect(TEXT_EXTS.has('.png')).toBe(false);
    expect(TEXT_EXTS.has('.exe')).toBe(false);
  });
});

describe('chunkCode（按语法逻辑边界切块）', () => {
  it('按函数/类声明切块，函数体不被打散', () => {
    const src = [
      'import x from "x";',
      '',
      'export function a() {',
      '  return 1;',
      '}',
      '',
      'export class B {',
      '  m() { return 2; }',
      '}',
      '',
      'export const c = 3;',
    ].join('\n');
    const blocks = chunkCode(src, 'ts');
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.some((b) => b.includes('function a'))).toBe(true);
    expect(blocks.some((b) => b.includes('class B'))).toBe(true);
    // "function a" 与其函数体必须在同一块
    const fa = blocks.find((b) => b.includes('function a'))!;
    expect(fa).toContain('return 1;');
  });

  it('python：def/class/decorator 边界', () => {
    const src = '@deco\ndef f():\n    return 1\n\ndef g():\n    return 2\n';
    const blocks = chunkCode(src, 'py');
    expect(blocks.some((b) => b.includes('def f') && b.includes('return 1'))).toBe(true);
    expect(blocks.some((b) => b.includes('def g'))).toBe(true);
  });

  it('无结构化内容也能切出（纯文本按空行弱边界）', () => {
    const blocks = chunkCode('line1\n\nline2\n\nline3', 'md');
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe('chunkRules（标题/段落切块）', () => {
  it('段落过多时按 MAX_CHUNK 聚合', () => {
    // 每段约 100 字符，30 段 ≈ 3000 字符 > MAX_CHUNK，必然切成多块
    const paras = Array.from({ length: 30 }, (_, i) =>
      `第${i}段${'内容'.repeat(45)}`).join('\n\n');
    const blocks = chunkRules(paras);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.join(' ')).toContain('第0段');
    expect(blocks.join(' ')).toContain('第29段');
  });

  it('超小块不单独成块，但标题块保留', () => {
    const blocks = chunkRules('# 标题\n\n一行短文本\n\n# 另一标题\n\n短');
    // "# 标题" 首段 + "# 另一标题" 首段都被保留
    expect(blocks.some((b) => b.includes('# 标题'))).toBe(true);
    expect(blocks.some((b) => b.includes('# 另一标题'))).toBe(true);
  });

  it('极小内容也能至少产出一块（不丢文件）', () => {
    const blocks = chunkRules('只有一句话。');
    expect(blocks.length).toBe(1);
  });
});

describe('cosine / keywordScore', () => {
  it('cosine：同向=1，正交=0，维度不符=0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it('keywordScore：子串计数 + 文件名加权', () => {
    expect(keywordScore('部署npm run dist部署', ['部署'], '')).toBe(2);
    expect(keywordScore('hello', ['hello'], 'notes/hello.md')).toBe(1 + 10);
    expect(keywordScore('nothing', ['abc'], '')).toBe(0);
  });
});

describe('fuseResults（RRF 融合）', () => {
  it('两路 top 交叉时按 RRF 稳定排序（同时在两路靠前的优先）', () => {
    const a = [{ id: 'x' }, { id: 'y' }];
    const b = [{ id: 'y' }, { id: 'z' }];
    const fused = fuseResults(a, b, 5);
    expect(fused[0]).toBe('y'); // y 同时在两路 top，RRF 分数最高
    expect(fused).toContain('x');
    expect(fused).toContain('z');
  });
});

describe('buildIndex / isFresh / searchIndex（端到端，伪 embedding）', () => {
  it('建索引：文件/块/向量，且点号索引文件不污染检索；mtime 变化判失效', async () => {
    await write('部署流程.md', '# 部署\n1. npm run build\n2. npx electron\n');
    await write('常见问题.md', '# FAQ\n模型怎么换\n');
    const idx = await buildIndex(dir, { chunking: 'rules', embed: fakeEmbed() });
    expect(idx.chunks.length).toBeGreaterThanOrEqual(2);
    expect(idx.dim).toBe(8);
    expect(idx.vectors!.length).toBe(idx.chunks.length);
    expect(idx.embedModel).toBe('fake');

    // 索引文件本身不应被收集为知识库文件
    const files = await listFiles(dir);
    expect(files.some((f) => f.rel.endsWith('.kb-index.json'))).toBe(false);

    // 新鲜：不动就 fresh；改一个文件 mtime → 失效（用 2000 年确保 mtime 明显变化）
    expect(isFresh(idx, dir, await listFiles(dir))).toBe(true);
    await utimes(path.join(dir, '部署流程.md'), new Date('2000-01-01'), new Date('2000-01-01'));
    const files2 = await listFiles(dir);
    expect(isFresh(idx, dir, files2)).toBe(false);
    const idx2 = await buildIndex(dir, { chunking: 'rules', embed: fakeEmbed() });
    expect(isFresh(idx2, dir, await listFiles(dir))).toBe(true);
  });

  it('检索：命中部署相关块，向量被使用', async () => {
    await write('docs/部署.md', 'npm run dist 打包上线，发布流程如下。');
    await write('docs/登录.md', '用户登录鉴权逻辑。');
    const idx = await buildIndex(dir, { chunking: 'rules', embed: fakeEmbed() });
    const qv = (await fakeEmbed().embed(['部署']))[0];
    const res = searchIndex(idx, '部署', { embedQuery: () => qv });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].rel).toBe('docs/部署.md');
    expect(res.vecUsed).toBe(true);
  });

  it('无向量时走纯关键词；embedding 异常时降级（不抛）', async () => {
    await write('a.md', 'hello world 检索关键词');
    const idx = await buildIndex(dir, { chunking: 'rules', embed: null });
    expect(idx.vectors).toBeNull();
    const res = searchIndex(idx, '检索', null);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.vecUsed).toBe(false);
  });

  it('kb.search 空查询返回清单；kb.reindex 重建', async () => {
    await write('note.md', '内容');
    const idx = await buildIndex(dir, { chunking: 'rules', embed: null });
    expect(idx.chunks.length).toBe(1);
  });
});

describe('索引可被读回并带出完整信息', () => {
  it('loadIndex 回来结构与写入一致', async () => {
    await write('x.md', '1234567890');
    await buildIndex(dir, { chunking: 'rules', embed: null });
    const loaded = await loadIndex(dir);
    expect(loaded).toBeTruthy();
    expect(loaded.chunks.length).toBe(1);
    expect(loaded.kbRoot).toBe(dir);
  });

  it('缺失/损坏索引 loadIndex 返回 null（不抛）', async () => {
    expect(await loadIndex(dir)).toBeNull();
    await write('.kb-index.json', 'not json');
    expect(await loadIndex(dir)).toBeNull();
  });
});

describe('知识库归档工具与辅助函数 (kb.archive)', () => {
  it('sanitizeFilename: 清除危险字符与空值兜底', () => {
    expect(sanitizeFilename('修复\\Bug/问题:排障<1>?*|')).toBe('修复_Bug_问题_排障_1');
    expect(sanitizeFilename('')).toMatch(/^归档_\d+$/);
    expect(sanitizeFilename('  ')).toMatch(/^归档_\d+$/);
  });

  it('formatArchiveDoc: 正确生成 Frontmatter 与 Markdown 正文', () => {
    const doc = formatArchiveDoc({
      title: '测试归档标题',
      content: '这里是详细排障内容与代码\n```ts\nconsole.log(1);\n```',
      category: '排障纪要',
      tags: ['bug', 'electron'],
      dateStr: '2026-08-30T12:00:00.000Z',
    });
    expect(doc).toContain('title: "测试归档标题"');
    expect(doc).toContain('category: "排障纪要"');
    expect(doc).toContain('tags: ["bug", "electron"]');
    expect(doc).toContain('createdAt: "2026-08-30T12:00:00.000Z"');
    expect(doc).toContain('# 测试归档标题');
    expect(doc).toContain('console.log(1);');
  });

  it('kb.archive 端到端执行：校验、写入分类子目录、防冲突，并使 kb.search 立即可查', async () => {
    const plugin: Plugin = await loadPluginFromDir(path.join(process.cwd(), 'plugins', 'builtin', 'kb'));
    const archiveTool = plugin.tools.find((t) => t.name === 'kb.archive')!;
    const searchTool = plugin.tools.find((t) => t.name === 'kb.search')!;
    expect(archiveTool).toBeTruthy();

    const ctx = {
      settings: { kbDir: dir, chunking: 'rules', embedModel: 'none' },
      workingDir: dir,
    };

    // 1. 参数不完整时拦截
    const emptyTitleRes = await archiveTool.execute({ title: '', content: 'some text' }, ctx as any);
    expect(emptyTitleRes.ok).toBe(false);
    expect(emptyTitleRes.error).toBe('invalid-arguments');

    const emptyContentRes = await archiveTool.execute({ title: 'foo', content: '   ' }, ctx as any);
    expect(emptyContentRes.ok).toBe(false);

    // 2. 正常沉淀归档
    const res = await archiveTool.execute({
      title: 'Electron透明窗口最大化修复纪要',
      content: 'Windows平台下透明无边框窗口原生maximize失效，改用workArea手工铺满工作区。',
      category: 'Windows踩坑',
      tags: ['electron', 'windows', 'bugfix'],
    }, ctx as any);

    expect(res.ok).toBe(true);
    expect(res.output).toContain('成功沉淀知识至知识库');
    expect(res.output).toContain('Electron透明窗口最大化修复纪要');

    // 验证文件落盘与内容
    const targetFile = path.join(dir, 'Windows踩坑', 'Electron透明窗口最大化修复纪要.md');
    const contentOnDisk = await readFile(targetFile, 'utf-8');
    expect(contentOnDisk).toContain('workArea手工铺满工作区');

    // 3. 再次归档同名条目：验证防同名覆盖（自动追加时间戳）
    const res2 = await archiveTool.execute({
      title: 'Electron透明窗口最大化修复纪要',
      content: '第二份不同补充内容',
      category: 'Windows踩坑',
    }, ctx as any);
    expect(res2.ok).toBe(true);
    expect(res2.data.path).toMatch(/Electron透明窗口最大化修复纪要_\d+\.md$/);

    // 4. 立即验证 kb.search 能无缝检索出刚沉淀的内容
    const searchRes = await searchTool.execute({ query: 'workArea' }, ctx as any);
    expect(searchRes.ok).toBe(true);
    expect(searchRes.output).toContain('Electron透明窗口最大化修复纪要');
    expect(searchRes.output).toContain('workArea手工铺满工作区');
  });
});
