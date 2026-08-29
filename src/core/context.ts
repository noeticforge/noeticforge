import type { ChatMessage } from '../types.js';

/**
 * 上下文窗口管理（MVP 策略：整轮截断）。
 *
 * 预算估算用「字符数 × 0.6」的粗糙启发式（中英混合场景够用）；
 * provider 响应中的 usage 字段后续可回填校正。裁剪保证两条硬约束：
 *   1. 消息结构永远合法——只按「轮」裁剪，一轮 = 一条 user 消息及其后所有 assistant/tool 消息；
 *   2. 最近一轮永远保留——哪怕它自己就超预算（兜底：循环至少有本次输入可依据）。
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.6);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let total = estimateTokens(msg.content) + 4;
  for (const call of msg.toolCalls ?? []) {
    total += estimateTokens(JSON.stringify(call.arguments ?? {})) + 16;
  }
  return total;
}

export interface TrimmedHistory {
  /** 裁剪后保留的消息（顺序不变，全部是完整轮次） */
  messages: ChatMessage[];
  /** 被丢弃的消息条数（0 = 未裁剪） */
  dropped: number;
}

export function trimHistory(history: ChatMessage[], budgetTokens: number): TrimmedHistory {
  if (budgetTokens <= 0 || history.length === 0) {
    return { messages: history, dropped: 0 };
  }

  // 切轮：以 user 消息为轮首
  const turns: ChatMessage[][] = [];
  for (const msg of history) {
    if (msg.role === 'user' || turns.length === 0) turns.push([msg]);
    else turns[turns.length - 1].push(msg);
  }

  const keptTurns: ChatMessage[][] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = turns[i].reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    // 已保留至少一轮且放不下 → 停止；第一轮无条件保留
    if (keptTurns.length > 0 && used + cost > budgetTokens) break;
    keptTurns.unshift(turns[i]);
    used += cost;
  }

  const keptCount = keptTurns.reduce((sum, t) => sum + t.length, 0);
  return { messages: keptTurns.flat(), dropped: history.length - keptCount };
}
