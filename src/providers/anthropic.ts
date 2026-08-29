import type { ChatMessage, ChatOptions, LLMProvider, LLMResponse, ToolDefinition } from '../types.js';

interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Messages API 的 max_tokens（缺省 8192） */
  maxTokens?: number;
}

/** Anthropic 消息格式适配器（system 独立、tool_result 走 user 消息）。v0.3：SSE 流式 + 可中断。 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  private readonly baseUrl: string;

  constructor(private readonly opts: AnthropicOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    chatOptions?: ChatOptions,
  ): Promise<LLMResponse> {
    const streaming = !!chatOptions?.onChunk;
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n\n');

    const apiMessages = toAnthropicMessages(
      messages.filter((m) => m.role !== 'system'),
    );

    const maxTokens = this.opts.maxTokens ?? 8192;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: maxTokens,
      messages: apiMessages,
    };
    // 推理力度 → 扩展思考预算；max_tokens 必须大于预算。
    // 例外：请求历史中已存在带 tool_calls 的 assistant 消息时不附加 thinking——
    // Anthropic API 要求此类消息携带 thinking 块，而本底座不存储 thinking（持久化的是纯文本历史），
    // 强行透传会导致第二轮起必然 400，因此对含工具历史的请求自动降级为不思考。
    const hasToolHistory = messages.some((m) => m.role === 'assistant' && m.toolCalls?.length);
    if (chatOptions?.reasoningEffort && !hasToolHistory) {
      const budget = { low: 2048, medium: 8192, high: 16384 }[chatOptions.reasoningEffort];
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(maxTokens, budget + 1024);
    }
    if (system) body.system = system;
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    if (streaming) body.stream = true;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: chatOptions?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[anthropic] API 请求失败 ${res.status}: ${text.slice(0, 500)}`);
    }

    if (streaming && res.body) {
      return consumeSseStream(res.body, chatOptions!.onChunk!);
    }

    const data = (await res.json()) as any;
    return parseMessageResponse(data, (full) => chatOptions?.onChunk?.(full));
  }
}

function parseMessageResponse(data: any, onFull?: (full: string) => void): LLMResponse {
  const blocks: any[] = data.content ?? [];
  const content = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: String(b.id ?? ''),
      name: String(b.name ?? ''),
      arguments: (b.input as Record<string, unknown>) ?? {},
    }));

  // 非流式：全文一次性作为"流"的结束块回调
  if (content) onFull?.(content);

  return {
    content,
    toolCalls,
    finishReason: data.stop_reason === 'tool_use' ? 'tool_calls'
      : data.stop_reason === 'max_tokens' ? 'length'
      : 'stop',
  };
}

/**
 * 消费 Anthropic SSE 流：
 *   message_start → content_block_start(text|tool_use) → content_block_delta(text_delta|input_json_delta)*
 *   → content_block_stop → … → message_delta(stop_reason) → message_stop
 * text_delta 即时回调；tool_use 的 input 经 input_json_delta 分片拼接，结束时 JSON.parse。
 */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (delta: string) => void,
): Promise<LLMResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let stopReason: string | null = null;

  // 按 block index 聚合：text 块与 tool_use 块交错到达
  const blocks = new Map<number, { type: 'text' | 'tool_use'; text: string; id: string; name: string; args: string }>();

  const handleEvent = (event: any): void => {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'content_block_start': {
        const b = event.content_block ?? {};
        blocks.set(event.index ?? 0, {
          type: b.type === 'tool_use' ? 'tool_use' : 'text',
          text: typeof b.text === 'string' ? b.text : '',
          id: String(b.id ?? ''),
          name: String(b.name ?? ''),
          args: '',
        });
        break;
      }
      case 'content_block_delta': {
        const block = blocks.get(event.index ?? 0);
        const delta = event.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (block) block.text += delta.text;
          content += delta.text;
          onChunk(delta.text);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (block) block.args += delta.partial_json;
        }
        break;
      }
      case 'message_delta': {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        break;
      }
      default:
        break; // message_start / ping / content_block_stop / message_stop 无需处理
    }
  };

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
      if (!payload) continue;

      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        continue; // 半截 JSON（跨 chunk 分片），等下一轮拼完
      }
      handleEvent(event);
    }
  }

  const textParts: string[] = [];
  const toolCalls: LLMResponse['toolCalls'] = [];
  for (const block of [...blocks.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)) {
    if (block.type === 'text') {
      if (block.text) textParts.push(block.text);
    } else {
      toolCalls.push({ id: block.id, name: block.name, arguments: safeParseJson(block.args) });
    }
  }

  return {
    content: textParts.join(''),
    toolCalls,
    finishReason: stopReason === 'tool_use' ? 'tool_calls'
      : stopReason === 'max_tokens' ? 'length'
      : 'stop',
  };
}

/**
 * Anthropic 要求 tool_result 以 user 消息紧跟在 assistant(tool_use) 之后，
 * 所以连续的 tool 消息要合并进同一条 user 消息。
 */
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: typeof msg.content === 'string' ? msg.content : msg.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } })),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (msg.role === 'assistant') {
      const content: any[] = [];
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) content.push({ type: 'text', text });
      for (const c of msg.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    // user：字符串或文本/图片分片
    if (Array.isArray(msg.content)) {
      out.push({
        role: msg.role,
        content: msg.content.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } },
        ),
      });
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return (raw as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
