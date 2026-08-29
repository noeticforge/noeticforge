import { describe, expect, it } from 'vitest';
import { estimateMessageTokens, estimateTokens, trimHistory } from '../src/core/context.js';
import type { ChatMessage } from '../src/types.js';

const u = (t: string): ChatMessage => ({ role: 'user', content: t });
const a = (t: string): ChatMessage => ({ role: 'assistant', content: t });
const tool = (id: string, out: string): ChatMessage => ({ role: 'tool', content: out, toolCallId: id });
const callMsg = (id: string, name: string, args: Record<string, unknown>): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: args }],
});

describe('estimateTokens / estimateMessageTokens', () => {
  it('字符数 × 0.6 向上取整', () => {
    expect(estimateTokens('abcdef')).toBe(4); // ceil(3.6)
    expect(estimateTokens('')).toBe(0);
  });

  it('消息成本 = 内容成本 + 4，工具调用追加参数 tokens + 16', () => {
    const msg = callMsg('t1', 'read-file.read', { path: 'abcdef' });
    // 参数按 JSON.stringify 后的字符串估算：'{"path":"abcdef"}' 17 字符 → 11 tokens
    expect(estimateMessageTokens(msg)).toBe(0 + 4 + (11 + 16));
  });

  it('图片分片按固定 800 tokens 估算', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'abc' },
        { type: 'image', mediaType: 'image/png', data: 'aaaa' },
      ],
    };
    expect(estimateMessageTokens(msg)).toBe(2 + 800 + 4);
  });
});

describe('trimHistory', () => {
  it('budget <= 0 或空历史 → 原样返回', () => {
    const h = [u('hi'), a('yo')];
    expect(trimHistory(h, 0)).toEqual({ messages: h, dropped: 0 });
    expect(trimHistory([], 1000)).toEqual({ messages: [], dropped: 0 });
  });

  it('只按整轮裁剪：放不下的最旧轮整轮丢弃', () => {
    const long = 'x'.repeat(1000); // 600 tokens
    const history = [u(long), a('a1'), u(long), a('a2'), u('短'), a('a3')];
    const r = trimHistory(history, 700);
    expect(r.messages).toEqual([u(long), a('a2'), u('短'), a('a3')]);
    expect(r.dropped).toBe(2);
  });

  it('最近一轮永远保留，哪怕自己超预算', () => {
    const huge = 'x'.repeat(100_000);
    const history = [u('早期'), a('历史'), u(huge)];
    const r = trimHistory(history, 100);
    expect(r.messages).toEqual([u(huge)]);
    expect(r.dropped).toBe(2);
  });

  it('tool / assistant 消息归属前导 user 轮，不会从轮中间切断', () => {
    const history = [
      u('做任务'),
      callMsg('t1', 'read-file.read', { path: 'x' }),
      tool('t1', '内容'),
      a('完成'),
      u('新问题'),
      a('答'),
    ];
    const r = trimHistory(history, 10_000);
    expect(r.messages).toEqual(history);
    expect(r.dropped).toBe(0);

    // 预算挤掉第一轮时，4 条必须一起消失
    const r2 = trimHistory(history, 5);
    expect(r2.messages).toEqual([u('新问题'), a('答')]);
    expect(r2.dropped).toBe(4);
  });

  it('历史不以 user 开头时（如压缩产物）首条消息自成一轮且不崩溃', () => {
    const history = [a('孤立的助手消息'), u('问题'), a('答')];
    const r = trimHistory(history, 10_000);
    expect(r.messages).toEqual(history);
  });
});
