import type { ChatMessage, ChatOptions, LLMProvider, LLMResponse, ToolDefinition } from '../types.js';

interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/** Anthropic 消息格式适配器（system 独立、tool_result 走 user 消息）。v0.1 非流式：全文一次性回调 onChunk。 */
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
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const apiMessages = toAnthropicMessages(
      messages.filter((m) => m.role !== 'system'),
    );

    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: 8192,
      messages: apiMessages,
    };
    if (system) body.system = system;
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

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

    const data = (await res.json()) as any;
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
    if (content) {
      chatOptions?.onChunk?.(content);
    }

    return {
      content,
      toolCalls,
      finishReason: data.stop_reason === 'tool_use' ? 'tool_calls'
        : data.stop_reason === 'max_tokens' ? 'length'
        : 'stop',
    };
  }
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
        content: msg.content,
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
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const c of msg.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }
  return out;
}
