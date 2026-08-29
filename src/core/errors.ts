import type { ErrorCode } from '../shared/error-codes.js';

/**
 * 循环层的结构化错误：带稳定错误码上抛，调用方（AgentService）据此构造
 * loop-error 推送，废除旧的字符串匹配判定（`error.includes('迭代')`）。
 */
export class AgentLoopError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AgentLoopError';
  }
}
