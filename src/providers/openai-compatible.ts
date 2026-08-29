import type { ChatMessage, ChatOptions, LLMProvider, LLMResponse, ToolDefinition } from '../types.js';

interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * OpenAI 兼容格式适配器。
 * DeepSeek、OpenAI 以及绝大多数国产模型（通义/智谱/月之暗面…）都走 /chat/completions 这一套，
 * 所以一个类就能覆盖多家——这就是统一接口的价值。
 * 传入 onChunk 时自动切换为 SSE 流式模式，并支持 AbortSignal 中断。
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    chatOptions?: ChatOptions,
  ): Promise<LLMResponse> {
    const streaming = !!chatOptions?.onChunk;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: messages.map(toApiMessage),
      stream: streaming,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: chatOptions?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[${this.id}] API 请求失败 ${res.status}: ${text.slice(0, 500)}`);
    }

    if (streaming && res.body) {
      return consumeSseStream(res.body, chatOptions!.onChunk!);
    }
    return parseCompletionResponse(await res.json());
  }
}

/** 解析非流式响应 */
function parseCompletionResponse(data: any): LLMResponse {
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error('API 返回中没有 choices');
  }
  const rawCalls = choice.message?.tool_calls ?? [];
  const toolCalls = rawCalls.map((c: any) => ({
    id: String(c.id ?? ''),
    name: String(c.function?.name ?? ''),
    arguments: safeParseJson(c.function?.arguments),
  }));
  return {
    content: choice.message?.content ?? '',
    toolCalls,
    finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls'
      : choice.finish_reason === 'length' ? 'length'
      : 'stop',
  };
}

/** 消费 SSE 流：text 增量即时回调，tool_calls 增量拼接后统一返回 */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (delta: string) => void,
): Promise<LLMResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason: LLMResponse['finishReason'] = 'stop';
  // tool_calls 在流里按 index 分片到达：id/name 先来，arguments 分多次传
  const toolCallAcc = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        continue; // 半截 JSON（跨 chunk 分片），等下一轮拼完
      }
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        onChunk(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = toolCallAcc.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCallAcc.set(idx, acc);
        }
      }
      const reason = event.choices?.[0]?.finish_reason;
      if (reason === 'tool_calls') finishReason = 'tool_calls';
      else if (reason === 'length') finishReason = 'length';
    }
  }

  const toolCalls = [...toolCallAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => ({
      id: acc.id,
      name: acc.name,
      arguments: safeParseJson(acc.args),
    }));

  return { content, toolCalls, finishReason };
}

function toApiMessage(msg: ChatMessage): Record<string, unknown> {
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    return {
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  if (msg.role === 'tool') {
    return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
  }
  return { role: msg.role, content: msg.content };
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return (raw as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
