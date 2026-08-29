import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
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

/** 提取 mock fetch 收到的请求体 */
function sentBody(mock: ReturnType<typeof vi.fn>, call = 0): Record<string, any> {
  const init = (mock.mock.calls[call] as [string, RequestInit])[1];
  return JSON.parse(String(init.body));
}

describe('AnthropicProvider.chat（mock fetch）', () => {
  it('非流式：解析 text / tool_use 块与 stop_reason', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 't1', name: 'read-file.read', input: { path: 'a.txt' } },
      ],
      stop_reason: 'tool_use',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // 不传 onChunk：传了即切流式路径（SSE），非流式解析走不到
    const res = await provider().chat([({ role: 'user', content: 'hi' }) as ChatMessage], []);

    expect(res.content).toBe('好的');
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'read-file.read', arguments: { path: 'a.txt' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('消息转换：system 提取到顶层；连续 tool 结果合并进同一条 user 消息', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const messages: ChatMessage[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '做' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: {} }, { id: 't2', name: 'b', arguments: {} }] },
      { role: 'tool', content: '结果1', toolCallId: 't1' },
      { role: 'tool', content: '结果2', toolCallId: 't2' },
    ];
    await provider().chat(messages, []);

    const body = sentBody(fetchMock);
    expect(body.system).toBe('系统提示');
    expect(body.messages).toHaveLength(3);
    const toolUser = body.messages[2];
    expect(toolUser.role).toBe('user');
    expect(toolUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '结果1' },
      { type: 'tool_result', tool_use_id: 't2', content: '结果2' },
    ]);
  });

  it('SSE 流式：text_delta 即时回调，input_json_delta 聚合成 tool 参数', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t9","name":"web-fetch.get"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"url\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"https://x\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const res = await provider().chat([({ role: 'user', content: 'hi' }) as ChatMessage], [], { onChunk: (d) => deltas.push(d) });

    expect(deltas.join('')).toBe('你好');
    expect(res.content).toBe('你好');
    expect(res.toolCalls).toEqual([{ id: 't9', name: 'web-fetch.get', arguments: { url: 'https://x' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  describe('推理力度（thinking）与工具历史共存', () => {
    it('历史无工具调用 → 正常透传 thinking', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await provider().chat([({ role: 'user', content: 'hi' }) as ChatMessage], [], { reasoningEffort: 'high' });
      const body = sentBody(fetchMock);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
      expect(body.max_tokens).toBeGreaterThan(16384);
    });

    it('历史已存在带 tool_calls 的 assistant 消息 → 本轮降级不透传 thinking（避免 API 400）', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const messages: ChatMessage[] = [
        { role: 'user', content: '做' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: {} }] },
        { role: 'tool', content: '结果', toolCallId: 't1' },
      ];
      await provider().chat(messages, [], { reasoningEffort: 'high' });
      const body = sentBody(fetchMock);
      expect(body.thinking).toBeUndefined();
      expect(body.max_tokens).toBe(8192);
    });
  });

  it('非 2xx → 抛出带状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    await expect(provider().chat([], [])).rejects.toThrow(/401/);
  });
});

function provider(): AnthropicProvider {
  return new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-test' });
}
