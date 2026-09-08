/**
 * LLM 请求的瞬时故障重试。
 *
 * 为什么必须有：一次编排任务要跑几十次模型往返、持续几分钟，网关掐一次连接
 * （ECONNRESET）就会让整轮对话归零。但重试必须挑对象——
 * 用户主动 stop 和 4xx 语义错误重试一百次也是错，只会白等。
 */

/** 带 HTTP 状态码的 API 错误：让重试策略能按状态码判断，而不是去正则匹配文案 */
export class LLMHttpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LLMHttpError';
    this.status = status;
  }
}

/** 重试可能成功的连接层错误码 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/** 值得重试的 HTTP 状态：限流、请求超时、并发冲突、以及所有 5xx */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  // 用户按了停止：立刻上抛，重试会把「停」这个意图吃掉
  if (isAbort(err)) return false;
  if (err instanceof LLMHttpError) return isTransientStatus(err.status ?? 0);
  // fetch 失败的真实原因藏在 cause 链里（TypeError: fetch failed ← Error: read ECONNRESET）
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    const msg = (cur as Error).message ?? '';
    if (/fetch failed|socket hang up|network|other side closed/i.test(msg)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  attempts?: number;
  /** 首次退避基数（毫秒），默认 600，之后指数退避 + 抖动 */
  baseDelayMs?: number;
  signal?: AbortSignal;
  /** 每次重试前回调，用于日志与 UI 提示 */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * 只包裹「建立响应」这一步，不要包住流式消费：
 * SSE 已经开始吐字之后再重试，会让 onChunk 把同一段内容重复推给 UI。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const base = Math.max(0, opts.baseDelayMs ?? 600);
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || i === attempts - 1) throw err;
      const delay = Math.round(base * 2 ** i + Math.random() * 200);
      opts.onRetry?.(i + 2, delay, err);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}
