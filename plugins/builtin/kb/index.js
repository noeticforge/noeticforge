import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 知识库插件（kb）——纯本地、零原生依赖、完全插件化。
 *
 * 设计要点（对应用户的"全部插件化"要求，不含任何底座改动）：
 *  - 切块：code 策略按函数/类等语法逻辑边界切（代码友好），rules 策略按标题/段落切；
 *  - 检索：关键词（子串，中文友好）+ 向量（可配 OpenAI 兼容 /v1/embeddings，如 VTXAI/vtx-embed-7M）双路，RRF 融合；
 *  - 降级：embedding 服务不可用时自动回退纯关键词，检索始终可用；
 *  - 索引：存为知识库目录内的 .kb-index.json（点号文件），切块/搜索时自动跳过；目录变动自动重建。
 *
 * 工具：
 *  - kb.search    检索（query 留空=返回知识库清单与统计）
 *  - kb.reindex   强制重建索引（首次或切块/embedding 配置变更后手动用）
 */

export const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.log', '.html', '.xml', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.vue', '.css', '.toml',
]);
const MAX_FILES = 500;       // 最多扫描文件数
const MAX_DEPTH = 4;         // 目录下钻深度
const MAX_BYTES = 1_000_000; // 单文件读取上限
const MAX_CHUNK = 800;       // 块长度上限（约中英混合一屏）
const MIN_CHUNK = 120;       // 低于此长度的块不再单独成块（避免碎块噪音）
const TOP_K = 10;            // 返回条数
const EMBED_BATCH = 64;      // embedding 单次批处理条数
const INDEX_NAME = '.kb-index.json';
const INDEX_VERSION = 1;

function fileKey(rel) {
  return createHash('md5').update(rel).digest('hex').slice(0, 12);
}
function isDot(rel) {
  return rel.split('/').some((p) => p.startsWith('.'));
}

/* ---------------- 切块 ---------------- */

function isDeclLine(lang, line) {
  const t = line.trim();
  if (lang === 'py') return /^(async\s+def|def|class)\b/.test(t) || t.startsWith('@');
  if (lang === 'js' || lang === 'ts') {
    return /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum)\b/.test(t);
  }
  return false;
}

/** code 策略：按声明行 + 大括号聚合的语法逻辑边界切块 */
export function chunkCode(text, lang = 'ts') {
  const lines = text.split('\n');
  const blocks = [];
  let cur = [];
  let brace = 0;
  const flush = () => {
    const s = cur.join('\n').trim();
    if (s) blocks.push(s);
    cur = [];
  };
  for (const line of lines) {
    const t = line.trim();
    // 顶层（brace=0）遇到新的声明行：先把已攒的块收掉
    if (brace === 0 && cur.length > 0 && isDeclLine(lang, line)) {
      flush();
    }
    cur.push(line);
    brace += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    if (brace < 0) brace = 0;
    // 块过长且回到顶层 → 收块
    if (brace === 0 && cur.join('\n').length > MAX_CHUNK) flush();
    // 空行在顶层也能作为弱边界：攒的内容已够长就收
    if (brace === 0 && t === '' && cur.join('\n').length >= MIN_CHUNK) flush();
  }
  if (cur.join('\n').trim()) flush();
  return blocks;
}

/** rules 策略：按空行/标题分段的规则切块，尽量贴近 MIN_CHUNK~MAX_CHUNK */
export function chunkRules(text) {
  const paras = text.split(/\n\s*\n/);
  const blocks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length + 1 > MAX_CHUNK)) {
      if (cur.length >= MIN_CHUNK || /^#{1,3}\s/.test(cur)) blocks.push(cur.trim());
      cur = p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  // 收尾：块非空才收；若全文只有一小段（blocks 为空），也必须保留这一块，否则小文档被整个丢弃
  if (cur.trim() && (cur.length >= MIN_CHUNK || /^#{1,3}\s/.test(cur) || blocks.length === 0)) {
    blocks.push(cur.trim());
  }
  return blocks;
}

export function chunk(text, lang, strategy) {
  return strategy === 'rules' ? chunkRules(text) : chunkCode(text, lang);
}

function langOf(ext) {
  return ['.js', '.jsx', '.mjs', '.cjs'].includes(ext) ? 'js'
    : ['.ts', '.tsx'].includes(ext) ? 'ts'
    : ext === '.py' ? 'py' : ext === '.md' || ext === '.markdown' ? 'md' : 'rules';
}

/* ---------------- 检索 ---------------- */

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sp = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { sp += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? sp / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

function occurrences(hay, needle) {
  if (!needle) return 0;
  let c = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { c += 1; i += needle.length; }
  return c;
}

/** 关键词得分：每个查询词在文本/路径中出现的次数之和（子串，大小写不敏感） */
export function keywordScore(text, terms, rel = '') {
  const hay = text.toLowerCase();
  const relL = rel.toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += occurrences(hay, term.toLowerCase());
    if (relL.includes(term.toLowerCase())) score += 10;
  }
  return score;
}

/** 双路融合：keywords 顶部 N 与 vector 顶部 N 用 RRF 合并 */
export function fuseResults(listA, listB, k = 5) {
  const score = new Map();
  const push = (list, base) => {
    list.slice(0, k).forEach((item, rank) => {
      score.set(item.id, (score.get(item.id) || 0) + base / (rank + 60));
    });
  };
  push(listA, 1); push(listB, 1);
  return [...score.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
}

/* ---------------- 索引 ---------------- */

async function collectFiles(dir, relBase, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) await collectFiles(abs, rel, depth + 1, out);
    else if (e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
      let mtimeMs = 0;
      try { mtimeMs = (await stat(abs)).mtimeMs; } catch { /* 读不到当 0 */ }
      out.push({ abs, rel, mtimeMs });
    }
  }
}

async function readTruncated(abs) {
  try {
    const c = await readFile(abs, 'utf-8');
    return c.length > MAX_BYTES ? c.slice(0, MAX_BYTES) : c;
  } catch { return null; }
}

function indexPath(kbRoot) { return path.join(kbRoot, INDEX_NAME); }

export async function listFiles(kbRoot) {
  const out = [];
  await collectFiles(kbRoot, '', 0, out);
  return out;
}

export function isFresh(index, kbRoot, files) {
  if (!index || index.version !== INDEX_VERSION || !index.fileMap) return false;
  const current = new Map(files.map((f) => [f.rel, f.mtimeMs]));
  if (current.size !== Object.keys(index.fileMap).length) return false;
  for (const [rel, m] of current) if (index.fileMap[rel] !== m) return false;
  return true;
}

/** 把知识库建成索引。embed 函数缺失/失败 → vectors=null（纯关键词降级）。 */
export async function buildIndex(kbRoot, { chunking = 'code', embed } = {}) {
  const files = await listFiles(kbRoot);
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const chunks = [];
  const fileMap = {};
  for (const f of files) {
    const content = await readTruncated(f.abs);
    if (content === null) continue;
    const lang = langOf(path.extname(f.rel));
    let blocks = content.trim() ? chunk(content, lang, chunking) : [];
    if (blocks.length === 0 && content.trim()) blocks = [content.trim()]; // 小文件不因规则切块被丢弃
    for (const text of blocks) chunks.push({ id: fileKey(f.rel) + '-' + chunks.length, rel: f.rel, text });
    fileMap[f.rel] = f.mtimeMs;
  }
  // 归一化长文本块（截断，避免喂给 embedding 超长）：embedding 侧自行处理，这里限制条目
  const index = {
    version: INDEX_VERSION, builtAt: Date.now(), kbRoot,
    chunking, dim: 0, embedModel: embed?.model ?? null, vectors: null, embedError: null,
    fileMap, chunks,
  };
  if (embed) {
    try {
      const texts = chunks.map((c) => c.text.slice(0, 2000));
      const vecs = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const v = await embed.embed(batch);
        vecs.push(...v);
      }
      if (vecs.length === chunks.length && vecs.length > 0) {
        index.vectors = vecs;
        index.dim = vecs[0].length;
        index.embedModel = embed.model ?? null;
      }
    } catch (e) {
      index.embedError = e instanceof Error ? e.message : String(e);
      index.vectors = null;
    }
  }
  await writeFile(indexPath(kbRoot), JSON.stringify(index), 'utf-8');
  return index;
}

export async function loadIndex(kbRoot) {
  const p = indexPath(kbRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf-8')); } catch { return null; }
}

/* ---------------- 检索执行 ---------------- */

export function searchIndex(index, query, embed) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const kwRanked = index.chunks.map((c) => ({ id: c.id, score: keywordScore(c.text, terms, c.rel) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ id: x.id }));

  let vecRanked = [];
  if (index.vectors && index.dim > 0 && embed) {
    const qvec = embed.embedQuery(query);
    if (qvec) {
      vecRanked = index.chunks.map((c, i) => ({ id: c.id, s: cosine(index.vectors[i], qvec) }))
        .filter((x) => x.s > 0.05)
        .sort((a, b) => b.s - a.s)
        .map((x) => ({ id: x.id }));
    }
  }
  const fused = fuseResults(kwRanked, vecRanked, 5);
  const byId = new Map(index.chunks.map((c) => [c.id, c]));
  const out = [];
  for (const id of fused) {
    const c = byId.get(id);
    if (c) out.push(c);
    if (out.length >= TOP_K) break;
  }
  return { results: out, vecUsed: vecRanked.length > 0, total: index.chunks.length, terms };
}

function snippet(text, terms) {
  let best = text.slice(0, 120);
  for (const term of terms) {
    const i = text.toLowerCase().indexOf(term.toLowerCase());
    if (i >= 0) {
      const s = Math.max(0, i - 40);
      const e = Math.min(text.length, i + term.length + 80);
      best = (s > 0 ? '…' : '') + text.slice(s, e) + (e < text.length ? '…' : '');
      if (best.length > 200) best = best.slice(0, 200) + '…';
      break;
    }
  }
  return best.replace(/\s+/g, ' ').trim();
}

function fmtOutput(res) {
  const lines = [];
  if (res.results.length === 0) {
    lines.push(`知识库检索无命中（共 ${res.total} 个块，向量${res.vecUsed ? '✓' : '✗'}）。`);
    lines.push('建议：换关键词；或 kb.search 不带 query 列出全部文档与统计。');
  } else {
    lines.push(`知识库检索命中 ${res.results.length} 个（共 ${res.total} 块｜检索方式：${res.vecUsed ? '向量+关键词' : '关键词'}）：`);
    res.results.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.rel} ｜ ${snippet(c.text, res.terms)}`);
    });
    lines.push('提示：需要完整内容用 read-file.read 读取上面列出的路径（相对应用目录）。');
  }
  return lines.join('\n');
}

/* ---------------- 工具与默认值 ---------------- */

function settingsOf(ctx) {
  const s = ctx?.settings ?? {};
  const chunking = s.chunking === 'rules' ? 'rules' : 'code';
  return {
    kbDir: typeof s.kbDir === 'string' && s.kbDir.trim() ? s.kbDir.trim() : '知识库',
    chunking,
    embedEnabled: s.embedEnabled !== false,
    embedBaseUrl: typeof s.embedBaseUrl === 'string' ? s.embedBaseUrl.trim() : 'http://127.0.0.1:8000/v1',
    embedModel: typeof s.embedModel === 'string' && s.embedModel.trim() ? s.embedModel.trim() : 'VTXAI/vtx-embed-7M',
  };
}

function resolveRoot(ctx) {
  const cfg = settingsOf(ctx);
  return path.isAbsolute(cfg.kbDir) ? cfg.kbDir : path.resolve(ctx?.workingDir ?? process.cwd(), cfg.kbDir);
}

function makeEmbed(cfg) {
  if (!cfg.embedEnabled) return null;
  const base = cfg.embedBaseUrl.replace(/\/$/, '');
  const model = cfg.embedModel;
  return {
    model,
    async embed(texts) {
      const res = await fetch(base + '/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
      return (data.data ?? []).map((d) => d.embedding);
    },
  };
}

/* ---------------- 对外 ---------------- */

async function ensureFreshIndex(ctx, force) {
  const root = resolveRoot(ctx);
  if (!existsSync(root)) return { root, err: `知识库目录不存在: ${root}\n可在「设置 → 插件 → 知识库」配置 kbDir。` };
  const st = await stat(root);
  if (!st.isDirectory()) return { root, err: `知识库路径不是目录: ${root}` };
  const cfg = settingsOf(ctx);
  const embed = makeEmbed(cfg);
  const files = await listFiles(root);
  const idx = await loadIndex(root);
  if (!force && isFresh(idx, root, files)) return { root, index: idx, cfg, embed, files };
  const index = await buildIndex(root, { chunking: cfg.chunking, embed });
  return { root, index, cfg, embed, files };
}

export const plugin = {
  tools: [
    {
      name: 'kb.search',
      description:
        '在本地知识库中检索文档/代码。知识库是一个文件夹（默认 应用目录/知识库，可配置），含 .md/.txt/.ts/.py/.js 等文本文件。' +
        'query 传关键词（支持中文，多词空格分隔按 AND），返回命中的文件路径与内容片段；query 留空则列出知识库清单与统计。' +
        '检索为「关键词 + 本地向量」混合；需要完整内容时用 read-file.read 读取返回的路径。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词；留空=浏览知识库清单' } },
        required: [],
        additionalProperties: false,
      },
      permissions: ['fs:read'],
      requiresApproval: false,
      async execute(args, ctx) {
        const query = String(args.query ?? '').trim();
        const { root, index, cfg, err } = await ensureFreshIndex(ctx, false);
        if (err) return { ok: false, output: err, error: 'kb-dir-missing' };
        if (!index) return { ok: false, output: '索引构建失败', error: 'kb-index-failed' };

        if (query.length === 0) {
          const lines = [];
          lines.push(`知识库统计：${index.chunks.length} 个块（${Object.keys(index.fileMap).length} 个文件）｜目录: ${root}`);
          lines.push(`向量：${index.vectors ? `✓ ${index.dim} 维（${index.embedModel}）` : index.embedError ? `✗ ${index.embedError.slice(0, 80)}` : '未启用'}｜切块：${index.chunking}`);
          const rels = [...new Set(index.chunks.map((c) => c.rel))];
          rels.slice(0, 50).forEach((r) => lines.push('  - ' + r));
          if (rels.length > 50) lines.push(`  …（其余 ${rels.length - 50} 个文件）`);
          lines.push('提示：kb.search 传关键词可检索内容。');
          return { ok: true, output: lines.join('\n'), render: 'markdown' };
        }

        const embed = makeEmbed(cfg);
        let res;
        if (embed) {
          try {
            const qv = await embed.embed([query]);
            res = searchIndex(index, query, { embedQuery: () => qv[0], ended: '' });
          } catch (e) {
            res = searchIndex(index, query, null);
            res.vecNote = `embedding 不可用已降级: ${e instanceof Error ? e.message : String(e)}`;
          }
        } else {
          res = searchIndex(index, query, null);
        }
        const text = fmtOutput(res) + (res.vecNote ? `\n（${res.vecNote}）` : '');
        return { ok: true, output: text, render: 'markdown' };
      },
    },
    {
      name: 'kb.reindex',
      description: '强制重建知识库索引（切块策略或 embedding 配置变更后使用；通常索引会自动失效重建）。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      permissions: ['fs:read'],
      requiresApproval: false,
      async execute(_args, ctx) {
        const { root, index, cfg } = await ensureFreshIndex(ctx, true);
        if (!index) return { ok: false, output: `索引重建失败: ${root}`, error: 'kb-index-failed' };
        const fold = index.vectors ? '向量✓' : index.embedError ? `向量✗(${index.embedError.slice(0, 60)})` : '向量未启用';
        return { ok: true, output: `知识库重建完成：${index.chunks.length} 块｜${fold}｜目录 ${root}` };
      },
    },
  ],
};

export default plugin;
