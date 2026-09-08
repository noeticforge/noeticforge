import { describe, expect, it, vi } from 'vitest';
import { LLMHttpError, isTransientError, withRetry } from '../src/providers/retry.js';

function fetchFailed(causeCode: string): Error {
  const cause = Object.assign(new Error(`read ${causeCode}`), { code: causeCode, errno: -4077 });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('瞬时故障判定', () => {
  it('连接层错误值得重试', () => {
    expect(isTransientError(fetchFailed('ECONNRESET'))).toBe(true);
    expect(isTransientError(fetchFailed('ECONNREFUSED'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('socket hang up'), {}))).toBe(true);
  });

  it('用户主动停止绝不重试——重试会把「停」这个意图吃掉', () => {
    expect(isTransientError(new DOMException('Aborted', 'AbortError'))).toBe(false);
    expect(isTransientError(Object.assign(new Error('boom'), { name: 'AbortError' }))).toBe(false);
  });

  it('HTTP 状态码按语义分流：限流与 5xx 重试，4xx 不重试', () => {
    expect(isTransientError(new LLMHttpError('x', 429))).toBe(true);
    expect(isTransientError(new LLMHttpError('x', 500))).toBe(true);
    expect(isTransientError(new LLMHttpError('x', 503))).toBe(true);
    expect(isTransientError(new LLMHttpError('x', 400))).toBe(false);
    expect(isTransientError(new LLMHttpError('x', 401))).toBe(false);
    expect(isTransientError(new LLMHttpError('x'))).toBe(false);
  });

  it('与网络无关的业务错误不重试', () => {
    expect(isTransientError(new Error('API 返回中没有 choices'))).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe('withRetry', () => {
  it('瞬时故障后重试并最终成功', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 3) throw fetchFailed('ECONNRESET');
      return 'ok';
    }, { attempts: 3, baseDelayMs: 1 });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('非瞬时错误第一次就抛出，不浪费时间', async () => {
    const fn = vi.fn(async () => {
      throw new LLMHttpError('bad request', 400);
    });
    await expect(withRetry(fn, { attempts: 5, baseDelayMs: 1 })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('重试次数用尽后把最后一次错误原样抛出', async () => {
    const fn = vi.fn(async () => {
      throw fetchFailed('ECONNRESET');
    });
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('每次重试都回调 onRetry，带上第几次与等待时长', async () => {
    const seen: number[] = [];
    await withRetry(
      async () => {
        if (seen.length < 2) throw fetchFailed('ECONNRESET');
        return 1;
      },
      { attempts: 4, baseDelayMs: 1, onRetry: (attempt) => seen.push(attempt) },
    ).catch(() => undefined);
    expect(seen).toEqual([2, 3]);
  });

  it('等待期间用户按停止：立刻中断，不再发起下一次请求', async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = withRetry(
      async () => {
        calls++;
        throw fetchFailed('ECONNRESET');
      },
      { attempts: 5, baseDelayMs: 5_000, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('signal 已经 aborted 时一次都不发起', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn(async () => 'never');
    await expect(withRetry(fn, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });
});
