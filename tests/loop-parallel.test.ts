import { describe, expect, it } from 'vitest';
import { runLoop } from '../src/core/loop.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { AgentTool, LLMProvider, LLMResponse, Plugin, ToolCall } from '../src/types.js';

/**
 * 并发调度的四条硬约束：重叠真的发生 / 结果按原始顺序回填 / 串行调用充当屏障 / 上限卡得住。
 *
 * 同步方式：每个工具进场后等「本批次全部进场」再退出。并发时大家瞬间凑齐；
 * 若实现退化成串行，就永远凑不齐，只能靠超时放行——此时 peak 停在 1，被断言抓出来，
 * 而不是把测试挂死。全程不靠 sleep 猜时序。
 */

interface Tracker {
  started: string[];
  finished: string[];
  peak: number;
}

const newTracker = (): Tracker => ({ started: [], finished: [], peak: 0 });

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  private turn = 0;
  constructor(private readonly responses: LLMResponse[]) {}
  async chat(): Promise<LLMResponse> {
    return this.responses[this.turn++] ?? { content: '收尾完成', toolCalls: [], finishReason: 'stop' };
  }
}

function makeTool(name: string, parallelSafe: boolean, tracker: Tracker, expected: number, holdMs = 5): AgentTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    permissions: [],
    parallelSafe,
    async execute() {
      tracker.started.push(name);
      tracker.peak = Math.max(tracker.peak, tracker.started.length - tracker.finished.length);
      const deadline = Date.now() + 300;
      while (tracker.started.length < expected && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }
      await new Promise((r) => setTimeout(r, holdMs));
      tracker.finished.push(name);
      if (name.includes('boom')) throw new Error(`${name} 炸了`);
      return { ok: true, output: `R:${name}` };
    },
  };
}

function makeRegistry(tools: AgentTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  const plugin: Plugin = {
    manifest: { name: 'p', version: '1.0.0', displayName: 'p', description: 'p', permissions: [], entry: 'i.js' },
    tools,
  };
  registry.register(plugin);
  return registry;
}

function turnWith(...names: string[]): LLMResponse {
  const toolCalls: ToolCall[] = names.map((n, i) => ({ id: `c${i}`, name: n, arguments: {} }));
  return { content: '', toolCalls, finishReason: 'tool_calls' };
}

async function run(names: string[], specs: Array<{ parallelSafe: boolean; holdMs?: number }>, maxParallel?: number) {
  const tracker = newTracker();
  const tools = names.map((n, i) => makeTool(n, specs[i].parallelSafe, tracker, names.length, specs[i].holdMs));
  const provider = new ScriptedProvider([turnWith(...names)]);
  const result = await runLoop({
    provider,
    registry: makeRegistry(tools),
    systemPrompt: 'sys',
    userMessage: 'go',
    history: [],
    workingDir: '/tmp',
    options: { maxIterations: 5, onEvent: () => {}, maxParallelToolCalls: maxParallel },
  });
  return { result, tracker };
}

const all = (parallelSafe: boolean) => ({ parallelSafe });

describe('runLoop 并发调度', () => {
  it('连续的 parallelSafe 调用真的重叠执行', async () => {
    const { tracker } = await run(['a', 'b', 'c'], [all(true), all(true), all(true)]);
    expect(tracker.peak).toBe(3);
  });

  it('未声明 parallelSafe 的工具保持串行（向后兼容旧行为）', async () => {
    const { tracker } = await run(['a', 'b', 'c'], [all(false), all(false), all(false)]);
    expect(tracker.peak).toBe(1);
    expect(tracker.started).toEqual(['a', 'b', 'c']);
  });

  it('串行调用充当屏障：它前后的并发调用不跨它重叠', async () => {
    const { tracker } = await run(['p1', 's', 'p2'], [all(true), all(false), all(true)]);
    expect(tracker.peak).toBe(1);
    expect(tracker.started).toEqual(['p1', 's', 'p2']);
  });

  it('maxParallelToolCalls 卡住同时在跑的数量', async () => {
    const { tracker } = await run(['a', 'b', 'c', 'd', 'e'], Array(5).fill(all(true)), 2);
    expect(tracker.peak).toBe(2);
    expect(tracker.finished).toHaveLength(5);
  });

  it('完成顺序乱序时，tool 消息仍按原始调用顺序回填', async () => {
    // 完成顺序应为 b,c,a；消息顺序必须是 a,b,c（provider 要求 tool 消息与 tool_calls 一一对应）
    // 三档耗时拉开量级，避免和屏障轮询的 2ms 粒度抢时序
    const { result, tracker } = await run(
      ['a', 'b', 'c'],
      [{ parallelSafe: true, holdMs: 90 }, { parallelSafe: true, holdMs: 10 }, { parallelSafe: true, holdMs: 45 }],
    );
    const toolMsgs = result.history.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.content)).toEqual(['R:a', 'R:b', 'R:c']);
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['c0', 'c1', 'c2']);
    expect(tracker.finished).toEqual(['b', 'c', 'a']);
  });

  it('同批次里一个工具抛异常，不拖垮其它调用，也不打乱顺序', async () => {
    const { result } = await run(['a', 'boom', 'c'], [all(true), all(true), all(true)]);
    const toolMsgs = result.history.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['c0', 'c1', 'c2']);
    expect(toolMsgs[0].content).toBe('R:a');
    expect(toolMsgs[2].content).toBe('R:c');
    expect(toolMsgs[1].content).toContain('boom 炸了');
  });
});
