import { describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/electron/services/workspace-service.js';
import type { ChatMessage, LLMProvider } from '../src/types.js';

const u = (t: string): ChatMessage => ({ role: 'user', content: t });
const a = (t: string): ChatMessage => ({ role: 'assistant', content: t });

/** 可编程假 provider：记录每次摘要提示词，按脚本返回摘要 */
function fakeProvider(summaries: string[]): { provider: LLMProvider; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const provider: LLMProvider = {
    id: 'mock',
    async chat(messages) {
      const c = messages[0]?.content;
      prompts.push(typeof c === 'string' ? c : '');
      const content = summaries[i] ?? `摘要${i + 1}`;
      i++;
      return { content, toolCalls: [], finishReason: 'stop' };
    },
  };
  return { provider, prompts };
}

/** 4 条历史：首轮 u 5000 字符 ≈ 3004 tokens，halfBudget=2000 时首轮整轮被丢（boundary=2） */
const history = (): ChatMessage[] => [u('x'.repeat(5000)), a('a1'), u('问题2'), a('a2')];

describe('WorkspaceService.compressHistory（增量摘要压缩）', () => {
  it('首次压缩：丢弃旧轮进 transcript，摘要对置于保留历史之前，record.upTo 正确', async () => {
    const { provider, prompts } = fakeProvider(['要点一']);
    const svc = new WorkspaceService('/tmp/compaction-unused', () => 4000);
    const r = await svc.compressHistory(history(), provider);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('要点摘要');
    expect(prompts[0]).toContain('x'.repeat(100)); // 被丢弃轮的原文进入 transcript（400 字截断内）
    expect(r.record).toEqual({ upTo: 2, summary: '要点一', updatedAt: expect.any(Number) });
    expect(r.messages).toEqual([
      { role: 'user', content: '【历史摘要】以下是本次会话较早内容的要点：\n要点一' },
      { role: 'assistant', content: '已了解以上背景，请继续。' },
      u('问题2'),
      a('a2'),
    ]);
  });

  it('boundary 未增长时复用：零 LLM 调用，发给模型的前缀逐字节一致（Prompt Cache 稳定）', async () => {
    const { provider, prompts } = fakeProvider(['要点一']);
    const svc = new WorkspaceService('/tmp/compaction-unused', () => 4000);
    const first = await svc.compressHistory(history(), provider);
    const again = await svc.compressHistory(history(), provider, first.record);
    expect(prompts).toHaveLength(1);
    expect(again.messages).toEqual(first.messages);
    expect(again.record).toBe(first.record);
  });

  it('boundary 增长：增量重写，旧摘要与新丢弃轮一起进 transcript，upTo 前移', async () => {
    const { provider, prompts } = fakeProvider(['要点一', '要点二（含要点一）']);
    const svc = new WorkspaceService('/tmp/compaction-unused', () => 4000);
    const first = await svc.compressHistory(history(), provider);
    const grown: ChatMessage[] = [...history(), u('y'.repeat(5000)), a('a3')];
    const second = await svc.compressHistory(grown, provider, first.record);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('要点一'); // 旧摘要并入，上下文不丢
    expect(prompts[1]).toContain('问题2'); // 新被丢弃的轮进入
    expect(prompts[1]).not.toContain('x'.repeat(100)); // 已摘要过的更早轮不再重复
    expect(second.record?.upTo).toBe(4);
    expect((second.messages?.[0] as { content: string }).content).toContain('要点二');
  });

  it('boundary=0（无丢弃）：原样返回、不调 provider、不产生 record', async () => {
    const { provider, prompts } = fakeProvider(['不应被调用']);
    const svc = new WorkspaceService('/tmp/compaction-unused', () => 4000);
    const short = [u('问题'), a('答')];
    const r = await svc.compressHistory(short, provider);
    expect(prompts).toHaveLength(0);
    expect(r.messages).toBe(short);
    expect(r.record).toBeUndefined();
  });
});
