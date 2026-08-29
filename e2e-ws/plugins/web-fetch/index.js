const MAX_CHARS = 20_000;

const fetchTool = {
  name: 'web-fetch.get',
  description:
    '抓取一个 HTTP/HTTPS 网页或接口的内容并返回给模型（自动跟随重定向，超时 20 秒）。' +
    '适合读取文档、调用只读 GET 接口、核对资料。返回内容过长时会截断；二进制内容只返回类型信息。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整的 http(s) URL' },
      max_chars: { type: 'number', description: '返回正文的最大字符数（默认 20000）' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  permissions: ['net:http'],
  requiresApproval: false,

  async execute(args) {
    const url = String(args.url ?? '').trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, output: '', error: 'URL 不合法' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, output: '', error: '仅支持 http/https 协议' };
    }
    let maxChars = Number(args.max_chars ?? MAX_CHARS);
    if (!Number.isFinite(maxChars) || maxChars <= 0) maxChars = MAX_CHARS;
    maxChars = Math.min(maxChars, 100_000);

    try {
      const res = await fetch(parsed, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'agent-base-web-fetch/0.1' },
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!/text\/|json|xml|javascript|csv|markdown/i.test(contentType)) {
        return { ok: true, output: `HTTP ${res.status} ${res.statusText} · 二进制内容（${contentType || '未知类型'}，${res.headers.get('content-length') ?? '?'} 字节），已跳过正文。` };
      }
      const text = await res.text();
      const note = `HTTP ${res.status} · ${contentType.split(';')[0]}\n\n`;
      const body = text.length > maxChars ? text.slice(0, maxChars) + `\n…（已截断，原文 ${text.length} 字符）` : text;
      if (!res.ok) {
        return { ok: false, output: note + body, error: `HTTP ${res.status}` };
      }
      return { ok: true, output: note + body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: '', error: `抓取失败: ${message}` };
    }
  },
};

export const plugin = { tools: [fetchTool] };
export default plugin;
