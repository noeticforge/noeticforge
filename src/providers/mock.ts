import type { LLMProvider, LLMResponse, ToolDefinition, ChatMessage, ChatOptions } from '../types.js';

/**
 * 脚本化的假模型：按顺序吐出预设响应。
 * 用途：冒烟测试 / IPC 自测 + 没有网络/API Key 时验证整条循环链路，永远不该出现在生产配置里。
 * 支持 onChunk：把预设文本切成小段模拟流式输出，让 UI 的打字机效果可以被测试。
 */
export class MockProvider implements LLMProvider {
  readonly id = 'mock';
  private readonly queue: LLMResponse[];

  constructor(responses: LLMResponse[]) {
    this.queue = [...responses];
  }

  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const next = this.queue.shift();
    if (!next) {
      return { content: '（mock 脚本已用完）', toolCalls: [], finishReason: 'stop' };
    }
    if (options?.onChunk && next.content) {
      // 按每段 6 个字符切片，模拟真实模型的流式增量
      for (let i = 0; i < next.content.length; i += 6) {
        options.onChunk(next.content.slice(i, i + 6));
      }
    }
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return next;
  }
}
