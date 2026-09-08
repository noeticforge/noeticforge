import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, toApiMessage } from '../src/providers/openai-compatible.js';
import type { ChatMessage } from '../src/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function sseData(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 提取 mock fetch 收到的请求体 */
function sentBody(mock: ReturnType<typeof vi.fn>, call = 0): Record<string, any> {
  const init = (mock.mock.calls[call] as [string, RequestInit])[1];
  return JSON.parse(String(init.body));
}

describe('toApiMessage（多模态/工具消息转换）', () => {
  it('纯文本消息原样透传', () => {
    expect(toApiMessage({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' });
  });

  it('assistant + toolCalls → tool_calls 数组，参数 JSON 字符串化', () => {
    const out = toApiMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read-file.read', arguments: { path: 'a.txt' } }],
    }) as Record<string, any>;
    expect(out.role).toBe('assistant');
    expect(out.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read-file.read', arguments: '{"path":"a.txt"}' } },
    ]);
  });

  it('tool 消息携带 tool_call_id', () => {
    expect(toApiMessage({ role: 'tool', content: '结果', toolCallId: 'c1' })).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '结果',
    });
  });

  it('多模态分片 → text + image_url(data URL)', () => {
    const out = toApiMessage({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', mediaType: 'image/png', data: 'QUJD' },
      ],
    }) as Record<string, any>;
    expect(out.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });
});

describe('OpenAICompatibleProvider.chat（mock fetch）', () => {
  const provider = () => new OpenAICompatibleProvider({
    id: 'deepseek', baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'deepseek-chat',
  });

  it('非流式：解析 choices / tool_calls / finish_reason，并携带鉴权头', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { content: '你好', tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{"a":1}' } }] },
        finish_reason: 'tool_calls',
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await provider().chat([({ role: 'user', content: 'hi' }) as ChatMessage], []);
    expect(res.content).toBe('你好');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 't', arguments: { a: 1 } }]);
    expect(res.finishReason).toBe('tool_calls');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'deepseek-chat', stream: false });
  });

  it('429 属限流：先重试，次数用尽后仍抛出带状态码的错误', async () => {
    const fetchMock = vi.fn(async () => new Response('quota exceeded', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenAICompatibleProvider({
      id: 'deepseek', baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'deepseek-chat',
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    await expect(p.chat([], [])).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('400 是语义错误：立刻抛出，不浪费退避时间', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenAICompatibleProvider({
      id: 'deepseek', baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'deepseek-chat',
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    await expect(p.chat([], [])).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SSE 流式：content 增量回调 + tool_calls 分片按 index 聚合 + finish_reason', async () => {
    const chunks = [
      sseData({ choices: [{ delta: { content: '你' } }] }),
      sseData({ choices: [{ delta: { content: '好' } }] }),
      // tool_calls：id/name 先到，arguments 跨分片拼接
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'write-file.write', arguments: '{"path":"a' } }] } }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] } }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)));

    const deltas: string[] = [];
    const res = await provider().chat([], [], { onChunk: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe('你好');
    expect(res.content).toBe('你好');
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'c9', name: 'write-file.write', arguments: { path: 'a.txt' } }]);
  });

  it('SSE 兜底：arguments 抽取后夹带裸换行（非法 JSON）仍能转义重试解析', async () => {
    // 模拟 DeepSeek 历史问题：信封合法（\n 已按 JSON 转义），但抽取出的参数字符串里是裸换行
    const innerArgs = '{"content":"第一行\n第二行"}'; // 含真实换行 → 直接 JSON.parse 必失败
    const chunk = sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 't', arguments: innerArgs } }] } }],
    });
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([chunk, 'data: [DONE]\n\n'])));

    const res = await provider().chat([], [], { onChunk: () => {} });
    expect(res.toolCalls[0].arguments).toEqual({ content: '第一行\n第二行' });
  });

  it('reasoningEffort 默认不透传，enableReasoningEffort 开启后才发送', async () => {
    const strict = new OpenAICompatibleProvider({ id: 'x', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' });
    const lenient = new OpenAICompatibleProvider({ id: 'x', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', enableReasoningEffort: true });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await strict.chat([], [], { reasoningEffort: 'high' });
    await lenient.chat([], [], { reasoningEffort: 'high' });

    expect(sentBody(fetchMock, 0).reasoning_effort).toBeUndefined();
    expect(sentBody(fetchMock, 1).reasoning_effort).toBe('high');
  });
});
