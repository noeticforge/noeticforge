import { ToolRegistry } from '../../core/registry.js';
import { runLoop } from '../../core/loop.js';
import type { LLMProvider, LoopEvent, ToolResult } from '../../types.js';
import { truncateText } from '../types.js';
import type { ApprovalAuditService } from './approval-audit-service.js';
import type { RuntimePolicy } from './model-policy-service.js';

export interface SubagentRunnerOptions {
  registry: ToolRegistry;
  getProvider: () => LLMProvider | null;
  getSystemPrompt: () => string;
  getPolicy: () => RuntimePolicy;
  getPluginSettings: (name: string) => Record<string, unknown> | undefined;
  approvals: ApprovalAuditService;
  getAbortSignal: (sessionId: string) => AbortSignal | undefined;
  workingDir: string;
  onLoopEvent: (sessionId: string, parentMessageId: string, event: LoopEvent) => void;
}

/**
 * core-subagent registration and isolated sub-agent loop execution.
 * The sub-agent shares the provider, policy and approval pipeline but cannot
 * see or spawn another sub-agent.
 */
export class SubagentRunner {
  private readonly opts: SubagentRunnerOptions;

  constructor(opts: SubagentRunnerOptions) {
    this.opts = opts;
  }

  registerTool(): void {
    if (this.opts.registry.listPlugins().some((p) => p.manifest.name === 'core-subagent')) return;
    this.opts.registry.register({
      manifest: {
        name: 'core-subagent',
        version: '0.1.0',
        displayName: '子代理',
        description: '底座内置的子任务委派工具',
        permissions: [],
        entry: 'core://subagent',
        protocolVersion: 1,
      },
      tools: [
        {
          name: 'subagent.run',
          description:
            '把一个子任务委托给独立的子 Agent 执行。子 Agent 拥有与你相同的工具（但不能再次派生子代理），' +
            '工具审批会同样呈报给用户。适合把可独立完成的研究/多步操作拆出去，避免污染主对话上下文。' +
            'task 必须写成自包含的任务书：目标、涉及文件、期望产出。',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: '子任务描述（自包含：目标/背景/期望产出）' },
              max_iterations: { type: 'number', description: '子循环最大迭代数（默认 8，上限 20）' },
            },
            required: ['task'],
            additionalProperties: false,
          },
          permissions: [],
          requiresApproval: false,
          async execute(args, ctx) {
            const runner = ctx.services as { runSubagent?: (a: Record<string, unknown>) => Promise<ToolResult> } | undefined;
            if (!runner?.runSubagent) return { ok: false, output: '', error: '子代理服务不可用' };
            return runner.runSubagent(args);
          },
        },
      ],
    });
  }

  async runSubagent(args: Record<string, unknown>, sessionId: string, parentMessageId: string): Promise<ToolResult> {
    const task = String(args.task ?? '').trim();
    if (!task) return { ok: false, output: '', error: 'task 不能为空' };
    const provider = this.opts.getProvider();
    if (!provider) return { ok: false, output: '', error: '模型未配置' };
    let maxIter = Number(args.max_iterations ?? 8);
    if (!Number.isFinite(maxIter)) maxIter = 8;
    maxIter = Math.min(Math.max(Math.round(maxIter), 1), 20);

    const childRegistry = new ToolRegistry();
    for (const p of this.opts.registry.listPlugins()) {
      if (p.manifest.name === 'core-subagent') continue;
      try {
        childRegistry.register(p);
      } catch {
        // A single conflicting plugin must not block the remaining tools.
      }
    }

    const policy = this.opts.getPolicy();
    try {
      const result = await runLoop({
        provider,
        registry: childRegistry,
        systemPrompt: this.opts.getSystemPrompt() + '\n\n（你是子代理：专注完成委派的任务，最后输出简洁的最终答复。）',
        userMessage: task,
        history: [],
        workingDir: this.opts.workingDir,
        contextTokenBudget: policy.contextTokenBudget,
        options: {
          maxIterations: maxIter,
          signal: this.opts.getAbortSignal(sessionId),
          allowedPermissions: policy.allowedPermissions,
          forceApprovalPermissions: policy.forceApprovalPermissions,
          reasoningEffort: policy.reasoningEffort,
          pluginSettings: (name) => this.opts.getPluginSettings(name),
          onEvent: (e) => {
            if (e.type === 'tool-started' || e.type === 'tool-result' || e.type === 'approval-required') {
              this.opts.onLoopEvent(sessionId, parentMessageId, e);
            }
          },
          requestApproval: (call) => this.opts.approvals.requestApproval(parentMessageId, call),
        },
      });
      return { ok: true, output: truncateText(result.content || '（子代理未输出内容）', 20_000) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `子代理执行失败: ${message}`, error: 'subagent-failed' };
    }
  }
}
