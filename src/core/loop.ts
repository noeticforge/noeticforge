import type {
  ChatMessage,
  LLMProvider,
  LoopEvent,
  LoopOptions,
  MessageContent,
  ToolCall,
  ToolResult,
} from '../types.js';
import type { ToolRegistry } from './registry.js';
import { validateArguments } from './schema.js';
import { AgentLoopError } from './errors.js';
import { trimHistory } from './context.js';

export interface RunLoopInput {
  provider: LLMProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  userMessage: MessageContent;
  /** 传入的会话历史（函数内部会追加本轮消息后返回新数组） */
  history: ChatMessage[];
  options: LoopOptions;
  /** 工具的相对路径基准目录（默认 process.cwd()） */
  workingDir?: string;
  /**
   * 上下文 token 预算（估算值）：超预算时从最旧一轮开始整轮截断，
   * 磁盘/内存中的完整历史不受影响，只影响发给模型的内容。0/undefined = 不限制。
   */
  contextTokenBudget?: number;
}

export interface RunLoopResult {
  content: string;
  iterations: number;
  history: ChatMessage[];
}

/**
 * Agent 循环引擎——整个底座的心脏。
 *
 *   用户输入 → LLM → 要调工具？→ 执行 → 结果喂回 → 再问 LLM → …… → 不调了 → 输出
 *
 * 设计约束：循环本身不认识任何具体工具、任何具体模型、任何具体 UI。
 * 它只认 LLMProvider 接口和 ToolRegistry 接口，所以以后加多少插件、换多少模型都不用改这里。
 */
export async function runLoop(input: RunLoopInput): Promise<RunLoopResult> {
  const { provider, registry, systemPrompt, userMessage, options } = input;
  const workingDir = input.workingDir ?? process.cwd();
  const history = [...input.history];
  // 上下文预算裁剪：只影响发给模型的内容，完整历史照常持久化
  let contextMessages = input.history;
  if (input.contextTokenBudget && input.contextTokenBudget > 0) {
    const trimmed = trimHistory(input.history, input.contextTokenBudget);
    contextMessages = trimmed.messages;
    if (trimmed.dropped > 0) {
      // 保持前缀文本完全静态固定，杜绝因数字变动破坏大模型的 Prompt Cache（前缀缓存）
      contextMessages = [
        { role: 'system', content: '（因上下文长度限制，较早的部分历史消息已被省略）' },
        ...contextMessages,
      ];
    }
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...contextMessages,
    { role: 'user', content: userMessage },
  ];
  history.push({ role: 'user', content: userMessage });

  let iterations = 0;

  try {
    while (iterations < options.maxIterations) {
      // stop() 的检查点：每次迭代开始前检查中断信号
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      iterations++;

      let response;
      try {
        response = await provider.chat(messages, registry.definitions(), {
          signal: options.signal,
          onChunk: options.onChunk,
          reasoningEffort: options.reasoningEffort,
        });
      } catch (err) {
        // 中断信号原样上抛（由调用方按停止处理）；其余错误包装为结构化错误码
        if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new AgentLoopError('E_LLM_ERROR', `[${provider.id}] 模型调用失败: ${message}`, { cause: err });
      }
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMsg);
      history.push(assistantMsg);
      options.onEvent({
        type: 'assistant-message',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // 模型不再调工具 = 任务结束
      if (!response.toolCalls || response.toolCalls.length === 0) {
        options.onEvent({ type: 'loop-done', content: response.content, iterations });
        return { content: response.content, iterations, history };
      }

      await runToolCalls(response.toolCalls, registry, options, workingDir, messages, history);
    }
    throw new AgentLoopError('E_MAX_ITERATIONS', `已达到最大迭代次数 ${options.maxIterations}，循环强制终止`);
  } catch (err) {
    // 用户主动 stop() 不算错误：直接上抛，由调用方决定推送 loop-done(stopped) 还是 loop-error
    if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    options.onEvent({ type: 'loop-error', error: message });
    throw err;
  }
}

/** 并发批次默认上限：再高容易打爆网关配额，收益也递减 */
const DEFAULT_MAX_PARALLEL = 4;

/** 未注册的工具按串行处理——并发跑一个不存在的工具没意义，交给 executeToolCall 报 tool-not-found */
function isParallelSafe(call: ToolCall, registry: ToolRegistry): boolean {
  return registry.getTool(call.name)?.tool.parallelSafe === true;
}

/**
 * 执行本轮全部工具调用。
 *
 * 顺序语义：非 parallelSafe 的调用逐个串行执行并充当屏障；连续的 parallelSafe 调用
 * 聚成一个并发批次，受 maxParallelToolCalls 限流。
 *
 * tool 消息一律按【原始调用顺序】回填：provider 要求 tool 消息与 assistant 的 tool_calls
 * 一一对应，所以完成顺序绝不能影响消息数组顺序。
 */
async function runToolCalls(
  calls: ToolCall[],
  registry: ToolRegistry,
  options: LoopOptions,
  workingDir: string,
  messages: ChatMessage[],
  history: ChatMessage[],
): Promise<void> {
  const limit = Math.max(1, Math.floor(options.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL));
  const push = (call: ToolCall, result: ToolResult): void => {
    const toolMsg: ChatMessage = { role: 'tool', content: result.output, toolCallId: call.id };
    messages.push(toolMsg);
    history.push(toolMsg);
  };

  let i = 0;
  while (i < calls.length) {
    if (!isParallelSafe(calls[i], registry)) {
      push(calls[i], await executeToolCall(calls[i], registry, options, workingDir));
      i++;
      continue;
    }
    const batch: ToolCall[] = [];
    while (i < calls.length && isParallelSafe(calls[i], registry)) {
      batch.push(calls[i]);
      i++;
    }
    const results = await runBatch(batch, Math.min(limit, batch.length), registry, options, workingDir);
    batch.forEach((call, idx) => push(call, results[idx]));
  }
}

/** 固定数量 worker 抢任务位；结果按索引落位，与调用顺序严格一致 */
async function runBatch(
  batch: ToolCall[],
  limit: number,
  registry: ToolRegistry,
  options: LoopOptions,
  workingDir: string,
): Promise<ToolResult[]> {
  const results = new Array<ToolResult>(batch.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= batch.length) return;
      try {
        results[idx] = await executeToolCall(batch[idx], registry, options, workingDir);
      } catch (err) {
        // executeToolCall 已兜住插件异常；走到这里说明底座自身出了岔子。
        // 但一个调用不许拖垮同批次，也不许留下空洞结果（否则消息数组顺序就废了）
        const message = err instanceof Error ? err.message : String(err);
        results[idx] = { ok: false, output: `工具执行异常: ${message}`, error: 'tool-crashed' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return results;
}

async function executeToolCall(call: ToolCall, registry: ToolRegistry, options: LoopOptions, workingDir: string): Promise<ToolResult> {
  const entry = registry.getTool(call.name);
  if (!entry) {
    const result: ToolResult = {
      ok: false,
      output: `错误：工具 "${call.name}" 不存在`,
      error: 'tool-not-found',
    };
    options.onEvent({ type: 'tool-result', call, result });
    return result;
  }

  // 第一道关卡：运行时权限策略（发生在 tool-started 之前，被拒时 UI 不会看到 tool-started）
  if (options.allowedPermissions) {
    const denied = entry.tool.permissions.find((p) => !options.allowedPermissions!.includes(p));
    if (denied) {
      const result: ToolResult = {
        ok: false,
        output: `权限 ${denied} 未获运行时策略允许，工具 "${call.name}" 未执行`,
        error: 'permission-denied',
      };
      options.onEvent({ type: 'tool-result', call, result });
      return result;
    }
  }

  options.onEvent({ type: 'tool-started', call });

  // 第二道关卡：审批（插件声明 requiresApproval，或权限命中底座的强制审批列表）
  const needsApproval =
    entry.tool.requiresApproval === true ||
    entry.tool.permissions.some((p) => options.forceApprovalPermissions?.includes(p));
  if (needsApproval) {
    options.onEvent({ type: 'approval-required', call });
    if (options.requestApproval) {
      const resolution = await options.requestApproval(call);
      const decision = typeof resolution === 'string' ? resolution : resolution.decision;
      if (decision !== 'approved') {
        const reason = typeof resolution === 'object' ? resolution.reason : undefined;
        const result: ToolResult = {
          ok: false,
          output: `用户拒绝了该工具的执行${reason ? `（原因：${reason}）` : ''}`,
          error: 'rejected-by-user',
        };
        options.onEvent({ type: 'tool-result', call, result });
        return result;
      }
      // 用户在审批框里微调过参数 → 覆盖模型生成的参数
      if (typeof resolution === 'object' && resolution.arguments) {
        call.arguments = resolution.arguments;
      }
    }
  }

  // 第三道关卡：参数 Schema 校验（模型的原始参数和用户修改过的参数都过这一关）
  const invalid = validateArguments(call.arguments, entry.tool.parameters);
  if (invalid) {
    const result: ToolResult = {
      ok: false,
      output: `参数校验失败: ${invalid}`,
      error: 'invalid-arguments',
    };
    options.onEvent({ type: 'tool-result', call, result });
    return result;
  }

  try {
    const result = await entry.tool.execute(call.arguments, {
      pluginName: entry.pluginName,
      workingDir,
      settings: options.pluginSettings?.(entry.pluginName),
      ...(options.ctxExtras?.() ?? {}),
    });
    options.onEvent({ type: 'tool-result', call, result });
    return result;
  } catch (err) {
    // 插件崩了不许拖垮主程序：把异常转成工具结果喂回模型，让它自己决定怎么办
    const message = err instanceof Error ? err.message : String(err);
    const result: ToolResult = { ok: false, output: `工具执行异常: ${message}`, error: 'tool-crashed' };
    options.onEvent({ type: 'tool-result', call, result });
    return result;
  }
}
