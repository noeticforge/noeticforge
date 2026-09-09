import AdmZip from 'adm-zip';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * doc-tools —— 二进制办公文档 → 纯文本提取器(零新增第三方依赖:
 * adm-zip 为底座既有运行时依赖,PDF 解压走 node:zlib)。
 * 支持:.docx / .xlsx / .pptx / .pdf / .rtf / 纯文本族;老式 .doc 明确拒绝。
 * 解析质量:docx/pptx/xlsx 结构完整可用;pdf 对简单文本编码效果好,
 * CID 嵌入字体(常见于中文出版级 PDF)无法还原时如实提示,绝不吐乱码喂模型。
 */

const MAX_CHARS = 100_000;
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const CID_HINT = '该 PDF 疑似使用嵌入子集字体/CID 编码(常见于中文排版 PDF),无法无损提取文本。可尝试:转存为 Word 后重试,或直接粘贴正文。';

/** XML 实体还原(docx/pptx/xlsx 内部均为 XML) */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d) || 32))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16) || 32))
    .replace(/&amp;/g, '&');
}

/** docx:按 </w:p> 切段,段内拼接所有 <w:t> 文本 run */
function docxText(zip) {
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('不是合法的 .docx(缺 word/document.xml)');
  const xml = entry.getData().toString('utf-8');
  return xml.split('</w:p>').map((p) => {
    const runs = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unescapeXml(m[1]));
    if (/<w:tab\/>/.test(p)) runs.push('\t');
    return runs.join('');
  }).filter((l) => l.length).join('\n');
}

/** xlsx:workbook 表序 → 逐 sheet 解析行/单元格;共享字符串表 t="s" 索引回填 */
function xlsxText(zip) {
  const sst = [];
  const sstEntry = zip.getEntry('xl/sharedStrings.xml');
  if (sstEntry) {
    for (const si of sstEntry.getData().toString('utf-8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      sst.push([...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join(''));
    }
  }
  const wb = zip.getEntry('xl/workbook.xml');
  const names = wb ? [...wb.getData().toString('utf-8').matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]) : [];
  const out = [];
  for (let i = 1; i <= 40; i++) {
    const entry = zip.getEntry(`xl/worksheets/sheet${i}.xml`);
    if (!entry) continue;
    out.push(`【工作表:${names[i - 1] ?? 'sheet' + i}】`);
    const xml = entry.getData().toString('utf-8');
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const t = /\bt="([^"]+)"/.exec(c[1])?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1];
        let cell = '';
        if (t === 's' && v !== undefined) cell = sst[Number(v)] ?? '';
        else if (t === 'inlineStr') cell = [...c[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
        else if (v !== undefined) cell = unescapeXml(v);
        cells.push(cell);
      }
      const line = cells.join('\t').trimEnd();
      if (line) out.push(line);
      if (out.join('\n').length > MAX_CHARS) break;
    }
  }
  return out.join('\n');
}

/** pptx:逐 slide 提取 <a:t>,按 </a:p> 换行 */
function pptxText(zip) {
  const slides = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => (parseInt(a.entryName.match(/\d+/)[0], 10) - parseInt(b.entryName.match(/\d+/)[0], 10)));
  if (!slides.length) throw new Error('不是合法的 .pptx(无 slide XML)');
  const out = [];
  slides.forEach((e, i) => {
    out.push(`【幻灯片 ${i + 1}】`);
    out.push(e.getData().toString('utf-8').split('</a:p>').map((p) =>
      [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1])).join(''),
    ).filter((l) => l.length).join('\n'));
  });
  return out.join('\n');
}

/** rtf:粗粒度剥离控制字与组括号(够读不精修) */
function rtfText(s) {
  return s
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]? ?/g, '\n')
    .replace(/\\lin\w+|\\pict|\\[a-zA-Z]+-?\d* ?|[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** PDF 字面量串还原(\n \( \) \\ 八进制) */
function pdfLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, c) => {
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    return map[c] ?? (/[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8) & 0xff) : c);
  });
}

/** 保真过滤:返回保留文本与丢弃数(丢弃占比是 CID 乱码的核心信号) */
function sanitizePdfChars(s) {
  let keep = '';
  let dropped = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160) keep += ch;
    else dropped++;
  }
  return { keep, dropped };
}

function pdfContentStreamText(raw) {
  const parts = [];
  let strTotal = 0;
  let nulTotal = 0;
  let droppedTotal = 0;
  const push = (s) => { const r = sanitizePdfChars(s); parts.push(r.keep); droppedTotal += r.dropped; };
  const hexToText = (hex) => {
    const bytes = Buffer.from(hex, 'hex');
    strTotal += bytes.length;
    for (const b of bytes) if (b === 0) nulTotal++;
    return bytes.toString('latin1');
  };
  for (const m of raw.matchAll(/\[((?:[^\[\]\\]|\\.|[\s\S])*?)\]\s*TJ/g)) {
    let line = '';
    for (const str of m[1].matchAll(/\(((?:[^)\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>/g)) {
      line += str[1] !== undefined ? pdfLiteral(str[1]) : hexToText(str[2].replace(/\s+/g, ''));
    }
    push(line);
  }
  for (const m of raw.matchAll(/\(((?:[^)\\]|\\.)*)\)\s*(Tj|'|")|<([0-9A-Fa-f\s]+)>\s*(Tj|'|")|BT\b/g)) {
    if (m[0] === 'BT') { parts.push('\n'); continue; }
    push(m[1] !== undefined ? pdfLiteral(m[1]) : hexToText(m[3].replace(/\s+/g, '')));
  }
  const decoded = strTotal; // 十六进制串总量(字面量不计入 CID 统计,避免误伤纯 ASCII 文档)
  return {
    text: parts.join(' ').replace(/\s+\n/g, '\n').replace(/ {2,}/g, ' '),
    bad: (decoded > 16 && (nulTotal / decoded > 0.35 || droppedTotal / decoded > 0.4)),
  };
}

/** pdf:定位 stream 段,可 Flate 解压则解压,含文本操作符者提取 */
function pdfText(buf) {
  const s = buf.toString('latin1');
  const out = [];
  let anyBad = false;
  let idx = 0;
  while ((idx = s.indexOf('stream', idx)) !== -1) {
    let p = idx + 6;
    if (s[p] === '\r') p++;
    if (s[p] !== '\n') { idx += 6; continue; }
    p++; // 跳过 stream 关键字后的 EOL,否则 zlib 数据头部多一个 \n 必然解压失败
    const end = s.indexOf('endstream', p);
    if (end === -1) break;
    idx = end + 9;
    let q = end;
    while (q > p && (s[q - 1] === '\n' || s[q - 1] === '\r')) q--; // 剔除 endstream 前的尾换行
    let raw = '';
    const chunk = buf.subarray(p, q);
    try { raw = zlib.inflateSync(chunk).toString('latin1'); }
    catch { raw = chunk.toString('latin1'); }
    if (/BT|Tj|TJ/.test(raw)) {
      const r = pdfContentStreamText(raw);
      out.push(r.text);
      if (r.bad) anyBad = true;
    }
    if (out.join('\n').length > MAX_CHARS) break;
  }
  const text = out.join('\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  // CID 子集字体的 2 字节码位含大量 NUL:判为不可还原则返回空串(上层给提示),短而干净的文本不误伤
  return anyBad ? '' : text;
}

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.yml', '.yaml',
  '.js', '.mjs', '.ts', '.py', '.java', '.c', '.h', '.cpp', '.go', '.rs', '.sh', '.bat', '.ini', '.css']);

function extractFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.doc') {
    return { ok: false, error: '老式二进制 .doc 无法解析,请另存为 .docx 后重试' };
  }
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    const zip = new AdmZip(filePath);
    const text = ext === '.docx' ? docxText(zip) : ext === '.xlsx' ? xlsxText(zip) : pptxText(zip);
    return { ok: true, output: text };
  }
  if (ext === '.pdf') {
    const text = pdfText(readFileSync(filePath));
    if (!text.trim()) return { ok: false, output: '', error: CID_HINT };
    return { ok: true, output: text };
  }
  if (ext === '.rtf') return { ok: true, output: rtfText(readFileSync(filePath, 'latin1')) };
  // 兜底:纯文本族直接 utf-8;未知扩展名先嗅探(NUL 判二进制),避免吐乱码
  const buf = readFileSync(filePath);
  if (buf.subarray(0, 8000).includes(0)) {
    return { ok: false, error: `无法识别的文件格式:${ext || '(无扩展名)'}(二进制内容,非文本)` };
  }
  return { ok: true, output: buf.toString('utf-8') };
}

const extractTool = {
  name: 'doc-tools.extract',
  description:
    '把本地办公文档提取为纯文本读入对话。支持 .docx / .xlsx / .pptx / .pdf / .rtf 及各类纯文本/代码文件;' +
    '用户想让你"看/分析/总结"某个文档文件路径(而非已作为附件注入时)就调用本工具。' +
    'path 为绝对路径或相对工作目录的路径;输出超长会截断。无法解析的格式会返回明确原因,请把原因转述给用户,不要编造内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文档文件路径,如 C:\\Users\\me\\报告.docx' },
      maxChars: { type: 'number', description: `输出字符上限,默认 ${MAX_CHARS}` },
    },
    required: ['path'],
  },
  permissions: ['fs:read'],
  requiresApproval: false,
  parallelSafe: true,

  async execute(args, ctx) {
    try {
      const filePath = path.resolve(ctx?.workingDir ?? process.cwd(), String(args.path ?? ''));
      if (!existsSync(filePath)) return { ok: false, output: '', error: `文件不存在: ${args.path}` };
      const size = statSync(filePath).size;
      if (size > MAX_FILE_BYTES) return { ok: false, output: '', error: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限(${(size / 1048576).toFixed(1)}MB)` };
      const r = extractFile(filePath);
      if (!r.ok) return { ok: false, output: r.partial ?? '', error: r.error };
      const cap = typeof args.maxChars === 'number' ? Math.min(args.maxChars, MAX_CHARS) : MAX_CHARS;
      const out = r.output.length > cap ? r.output.slice(0, cap) + `\n…(已截断,原文 ${r.output.length} 字符)` : r.output;
      return { ok: true, output: out || '(提取到空文档)', render: 'code' };
    } catch (err) {
      return { ok: false, output: '', error: `doc-tools 提取失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const plugin = { tools: [extractTool] };
export default plugin;
