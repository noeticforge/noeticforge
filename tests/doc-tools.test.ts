import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { plugin as docTools } from '../plugins/builtin/doc-tools/index.js';
import { WorkspaceService } from '../src/electron/services/workspace-service.js';

/**
 * doc-tools 提取器与底座拒读引导的自测:
 * 用 adm-zip/zlib 现场构造最小可用的 docx/xlsx/pptx/pdf/rtf 样本喂给插件,
 * 断言文本提取正确;无法解析的分支(.doc/CID PDF/未知二进制)必须给明确原因而不是乱码。
 */

const extract = docTools.tools[0];

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'doc-tools-test-'));
}

function makeZip(entries: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.from(data, 'utf-8'));
  return zip.toBuffer();
}

async function runOn(dir: string, name: string, buf: Buffer | string, args: Record<string, unknown> = {}) {
  const file = path.join(dir, name);
  await writeFile(file, buf);
  return extract.execute({ path: file, ...args }, { workingDir: dir, pluginName: 'doc-tools' });
}

describe('doc-tools.extract', () => {
  it('docx:段落切分 + run 拼接 + XML 实体还原', async () => {
    const dir = await tempDir();
    const docXml = `<?xml version="1.0"?><w:document><w:body>` +
      `<w:p><w:r><w:t>你好</w:t></w:r><w:r><w:t>&amp;世界</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>第二行 &lt;标签&gt;</w:t></w:r></w:p></w:body></w:document>`;
    const r = await runOn(dir, 'a.docx', makeZip({ 'word/document.xml': docXml }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain('你好&世界');
    expect(r.output).toContain('第二行 <标签>');
    expect(r.output.split('\n')[1]).toBe('第二行 <标签>');
    await rm(dir, { recursive: true, force: true });
  });

  it('xlsx:共享字符串索引回填 + 表名 + 行制表符', async () => {
    const dir = await tempDir();
    const r = await runOn(dir, 'b.xlsx', makeZip({
      'xl/workbook.xml': `<workbook><sheets><sheet name="表一"/></sheets></workbook>`,
      'xl/sharedStrings.xml': `<sst><si><t>名称</t></si><si><t>数量</t></si></sst>`,
      'xl/worksheets/sheet1.xml': `<worksheet><row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row r="2"><c><v>42</v></c></row></worksheet>`,
    }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain('【工作表:表一】');
    expect(r.output).toContain('名称\t数量');
    expect(r.output).toContain('42');
    await rm(dir, { recursive: true, force: true });
  });

  it('pptx:逐 slide 提取 a:t 文本', async () => {
    const dir = await tempDir();
    const r = await runOn(dir, 'c.pptx', makeZip({
      'ppt/slides/slide1.xml': `<p:sld><a:p><a:r><a:t>封面标题</a:t></a:r></a:p></p:sld>`,
      'ppt/slides/slide2.xml': `<p:sld><a:p><a:r><a:t>第二页要点</a:t></a:r></a:p></p:sld>`,
    }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain('【幻灯片 1】');
    expect(r.output).toContain('封面标题');
    expect(r.output.indexOf('第二页要点')).toBeGreaterThan(r.output.indexOf('封面标题'));
    await rm(dir, { recursive: true, force: true });
  });

  it('pdf:Flate 内容流的 Tj/TJ 文本提取', async () => {
    const dir = await tempDir();
    const content = `BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n(Hello PDF) Tj\n[(A) -2 (B)] TJ\nET`;
    const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + stream.length + ' >>\n', 'latin1'),
      Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\ntrailer\n%%EOF', 'latin1'),
    ]);
    const r = await runOn(dir, 'd.pdf', pdf);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('Hello PDF');
    expect(r.output).toContain('AB');
    await rm(dir, { recursive: true, force: true });
  });

  it('pdf:CID 嵌入字体(UTF-16 码位流)返回可读性提示而非乱码', async () => {
    const dir = await tempDir();
    const content = `BT\n<004100420043004400450046004700480049004A> Tj\nET`; // 20 字节半数为 NUL 高位
    const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\nstream\n', 'latin1'), stream, Buffer.from('\nendstream\n%%EOF', 'latin1'),
    ]);
    const r = await runOn(dir, 'cid.pdf', pdf);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('嵌入子集字体');
    await rm(dir, { recursive: true, force: true });
  });

  it('rtf:剥控制字与括号,\\par 换行,十六进制转义还原', async () => {
    const dir = await tempDir();
    const r = await runOn(dir, 'e.rtf', `{\\rtf1\\ansi\\deff0 hello\\par wo\\'72ld}`);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('hello');
    expect(r.output).toContain('world');
    expect(r.output).not.toContain('\\');
    await rm(dir, { recursive: true, force: true });
  });

  it('老式 .doc / 未知二进制 / 不存在路径:全部明确拒收', async () => {
    const dir = await tempDir();
    const doc = await runOn(dir, 'old.doc', Buffer.concat([Buffer.from('ÐÏࡱá', 'binary'), Buffer.alloc(64, 0)]));
    expect(doc.ok).toBe(false);
    expect(doc.error).toContain('另存为 .docx');
    const bin = await runOn(dir, 'x.weird', Buffer.concat([Buffer.from('PK\u0003\u0004', 'binary'), Buffer.from([0, 1, 2, 0, 9]) ]));
    expect(bin.ok).toBe(false);
    expect(bin.error).toContain('二进制');
    const miss = await extract.execute({ path: path.join(dir, 'nope.docx') }, { workingDir: dir });
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('文件不存在');
    await rm(dir, { recursive: true, force: true });
  });

  it('纯文本族直读 + maxChars 截断', async () => {
    const dir = await tempDir();
    const r = await runOn(dir, 'notes.md', 'x'.repeat(5000), { maxChars: 100 });
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThan(200);
    expect(r.output).toContain('已截断');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('底座拒读引导(workspace-service)', () => {
  it('@ 引用 docx:注入引导语而非乱码', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'r.docx');
    await writeFile(file, makeZip({ 'word/document.xml': '<w:document><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:document>' }));
    const ws = new WorkspaceService(dir, () => 100_000);
    const out = ws.injectContextFiles('请分析', ['r.docx']);
    const text = JSON.stringify(out);
    expect(text).toContain('doc-tools.extract');
    expect(text).not.toContain('PK');
    await rm(dir, { recursive: true, force: true });
  });

  it('readAttachment 对二进制返回可行动错误', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'r.docx');
    await writeFile(file, makeZip({ 'word/document.xml': '<x/>' }));
    const ws = new WorkspaceService(dir, () => 100_000);
    const r = await ws.readAttachment({ path: file });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('doc-tools.extract');
    await rm(dir, { recursive: true, force: true });
  });

  it('readAttachment 对文件夹给明确人话提示,而非 EISDIR 内部错误', async () => {
    const dir = await tempDir();
    const ws = new WorkspaceService(dir, () => 100_000);
    const r = await ws.readAttachment({ path: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('E_INVALID_CONFIG');
      expect(r.error.message).toContain('文件夹');
      expect(r.error.message).not.toContain('EISDIR');
    }
    await rm(dir, { recursive: true, force: true });
  });
});
