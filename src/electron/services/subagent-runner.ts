import { ToolRegistry } from '../../core/registry.js';
import { runLoop } from '../../core/loop.js';
import type { LLMProvider, LoopEvent, ToolResult } from '../../types.js';
import type { ProviderConfig } from '../../providers/provider.js';
import { createProvider } from '../../providers/provider.js';
import type { ApprovalAuditService } from './approval-audit-service.js';
import type { RuntimePolicy } from './model-policy-service.js';
import {
  buildRoleCatalog,
  buildSubagentSystemPrompt,
  filterToolNames,
  resolveRoleProviderConfig,
  roleOverridesProvider,
  type SubagentRole,
  type SubagentSettings,
} from './subagent-roles.js';

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
  /** 角色表（config.json → subagents）；缺省 = 无角色，行为回落到「跟随主代理模型」 */
  getSubagentSettings?: () => SubagentSettings;
  /** provider 工厂，测试可注入以断言实际请求的模型 */
  createProviderFor?: (cfg: ProviderConfig) => LLMProvider;
}

/**
 * 子代理回执上限。回执会原样进主对话上下文，20k 等于把「隔离省下的 token」
 * 又从摘要这一头还了回去；6k 足够装下【结论】【依据】【未完成】三段。
 */
const MAX_OUTPUT_CHARS = 6_000;

/** 保留换行（结构化产出被压成一行就没有意义了），且截断必须可行动 */
function truncatePreserveLines(s: string, max: number): string {
  if (s.length <= max) return s;
  // 明确告知被截断 + 该怎么办，否则主代理会拿半截结论当完整结论下判断
  return `${s.slice(0, max)}\n…（回执超出 ${max} 字符已被截断，以上内容不完整。`
    + '需要更多细节请重新委派并限定回执范围，或自己用 read-file 查看原始文件）';
}

/**
 * core-subagent registration and isolated sub-agent loop execution.
 * The sub-agent shares the policy and approval pipeline but cannot see or
 * spawn another sub-agent. Roles (config.json → subagents) let each sub-agent
 * run on a different model with its own prompt and tool whitelist.
 */
export class SubagentRunner {
  private readonly opts: SubagentRunnerOptions;
  /** 按「角色 + 解析后的模型坐标」缓存 provider，避免每次委派都重建 */
  private readonly providerCache = new Map<string, LLMProvider>();

  constructor(opts: SubagentRunnerOptions) {
    this.opts = opts;
  }

  private settings(): SubagentSettings {
    return this.opts.getSubagentSettings?.() ?? { roles: new Map(), defaultRole: null, base: { provider: 'openai-compatible' } };
  }

  registerTool(): void {
    if (this.opts.registry.listPlugins().some((p) => p.manifest.name === 'core-subagent')) return;
    const self = this;
    const settings = this.settings();
    const roleNames = [...settings.roles.keys()];
    const catalog = buildRoleCatalog(settings);

    const runParams: Record<string, unknown> = {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            '子任务书（自包含：目标 / 涉及范围 / 期望产出 / 验收标准）。子代理看不到主对话历史，' +
            '你没写清楚的东西它只能靠猜——务必给出可核对的验收标准。',
        },
        role: {
          type: 'string',
          ...(roleNames.length ? { enum: roleNames } : {}),
          description: roleNames.length
            ? `执行该子任务的子代理角色，不填则用 defaultRole 或跟随主代理模型。${catalog}`
            : '子代理角色名（当前未配置角色，留空即跟随主代理模型）',
        },
        max_iterations: { type: 'number', description: '子循环最大迭代数（默认取角色配置，否则 8，上限 20）' },
      },
      required: ['task'],
      additionalProperties: false,
    };

    this.opts.registry.register({
      manifest: {
        name: 'core-subagent',
        version: '0.2.0',
        displayName: '子代理',
        description: '底座内置的子任务委派工具：支持按角色分配不同模型、独立上下文与工具白名单',
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
            '反过来，三五步内能自己做完的别拆：子代理看不到本对话历史，会重复读你读过的文件，还多一次往返。' +
            'task 必须写成自包含的任务书：目标、涉及文件、期望产出、验收标准。' +
            `${catalog}\n按任务性质选角色：机械性、判断密度低的活交给轻量角色；需要判断与设计的留给自己。` +
            '多个互不依赖的子任务，请在同一轮里连续发起多个本调用——子代理上下文互相隔离，底座会并发执行它们。' +
            '返回内容按【结论】【依据】【未完成 / 不确定】三段组织，对影响结论的关键判断请抽查证据后再采信。',
          parameters: runParams,
          permissions: [],
          requiresApproval: false,
          // 子代理上下文完全隔离，并发跑不会互相踩踏——这是本特性最主要的收益来源
          parallelSafe: true,
          async execute(args, ctx) {
            const runner = ctx.services as { runSubagent?: (a: Record<string, unknown>) => Promise<ToolResult> } | undefined;
            if (!runner?.runSubagent) return { ok: false, output: '', error: '子代理服务不可用' };
            return runner.runSubagent(args);
          },
        },
        {
          name: 'subagent.roles',
          description:
            '列出当前可用的子代理角色及其模型、职责与工具范围。' +
            '在决定把子任务派给谁之前调用它；配置变更后也用它拿最新结果。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          permissions: [],
          requiresApproval: false,
          parallelSafe: true,
          async execute() {
            return { ok: true, output: self.describeRoles(), render: 'markdown' };
          },
        },
      ],
    });
  }

  /** 角色清单的 markdown 渲染（供 subagent.roles 工具与 description 复用） */
  private describeRoles(): string {
    const s = this.settings();
    if (!s.roles.size) {
      return '当前未配置子代理角色，所有子代理都跟随主代理的模型。\n如需分档，在 config.json 的 subagents.roles 下按名字声明 model 即可。';
    }
    const rows = [...s.roles.values()].map((r) => {
      const scope = r.tools?.length ? r.tools.join(' ') : r.disallowedTools?.length ? `全部（除 ${r.disallowedTools.join(' ')}）` : '全部';
      return `| ${r.displayName ?? r.name} | \`${r.name}\` | ${r.model ?? '跟随主代理'} | ${r.purpose ?? '—'} | ${scope} |`;
    });
    const def = s.defaultRole ? `默认角色：\`${s.defaultRole}\`` : '未设默认角色（不填 role 时跟随主代理模型）';
    return [
      `可用子代理角色（${def}）：`,
      '',
      '| 名称 | role | 模型 | 职责 | 工具范围 |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
    ].join('\n');
  }

  private resolveRole(args: Record<string, unknown>): { role?: SubagentRole; error?: string } {
    const s = this.settings();
    const requested = typeof args.role === 'string' ? args.role.trim() : '';
    if (requested) {
      const role = s.roles.get(requested);
      if (!role) {
        const available = [...s.roles.keys()].join(', ') || '（未配置任何角色）';
        return { error: `未知角色 "${requested}"。可用角色：${available}` };
      }
      return { role };
    }
    if (s.defaultRole) {
      const role = s.roles.get(s.defaultRole);
      if (role) return { role };
    }
    return {};
  }

  /** 角色没换模型就复用主 provider；换了就按解析后的配置新建并缓存 */
  private providerFor(role: SubagentRole | undefined): { provider: LLMProvider | null; modelLabel: string; error?: string } {
    const policy = this.opts.getPolicy();
    const mainModel = policy.currentModel ?? '主代理模型';
    if (!roleOverridesProvider(role)) {
      return { provider: this.opts.getProvider(), modelLabel: role?.model ?? mainModel };
    }
    const cfg = resolveRoleProviderConfig(role, this.settings().base);
    const modelLabel = cfg.model ?? role?.model ?? '未指定';
    const key = `${role?.name ?? ''}|${cfg.provider}|${cfg.model ?? ''}|${cfg.baseUrl ?? ''}`;
    const cached = this.providerCache.get(key);
    if (cached) return { provider: cached, modelLabel };
    try {
      const made = (this.opts.createProviderFor ?? createProvider)(cfg);
      this.providerCache.set(key, made);
      return { provider: made, modelLabel };
    } catch (e) {
      return { provider: null, modelLabel, error: `角色 "${role?.name}" 的模型配置无效: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 子代理工具集：默认继承全部（排除 core- 前缀），角色可用 tools / disallowedTools 收窄 */
  private buildChildRegistry(role?: SubagentRole): ToolRegistry {
    const child = new ToolRegistry();
    const restrict = Boolean(role?.tools?.length || role?.disallowedTools?.length);
    for (const p of this.opts.registry.listPlugins()) {
      if (p.manifest.name === 'core-subagent') continue;
      let tools = p.tools;
      if (restrict) {
        const keep = new Set(filterToolNames(p.tools.map((t) => t.name), role?.tools, role?.disallowedTools));
        tools = p.tools.filter((t) => keep.has(t.name));
      }
      if (!tools.length) continue;
      try {
        child.register({ ...p, tools });
      } catch {
        // A single conflicting plugin must not block the remaining tools.
      }
    }
    return child;
  }

  async runSubagent(args: Record<string, unknown>, sessionId: string, parentMessageId: string): Promise<ToolResult> {
    const task = String(args.task ?? '').trim();
    if (!task) return { ok: false, output: '', error: 'task 不能为空' };

    const { role, error: roleError } = this.resolveRole(args);
    if (roleError) return { ok: false, output: '', error: roleError };

    const policy = this.opts.getPolicy();
    const { provider, modelLabel, error: providerError } = this.providerFor(role);
    if (providerError) return { ok: false, output: '', error: providerError };
    if (!provider) return { ok: false, output: '', error: '模型未配置' };

    const fallbackIter = role?.maxIterations ?? 8;
    let maxIter = Number(args.max_iterations ?? fallbackIter);
    if (!Number.isFinite(maxIter)) maxIter = fallbackIter;
    maxIter = Math.min(Math.max(Math.round(maxIter), 1), 20);

    const childRegistry = this.buildChildRegistry(role);
    const roleName = role?.name ?? 'default';
    try {
      const result = await runLoop({
        provider,
        registry: childRegistry,
        systemPrompt: buildSubagentSystemPrompt(role, this.opts.getSystemPrompt()),
        userMessage: task,
        history: [],
        workingDir: this.opts.workingDir,
        contextTokenBudget: policy.contextTokenBudget,
        options: {
          maxIterations: maxIter,
          signal: this.opts.getAbortSignal(sessionId),
          allowedPermissions: policy.allowedPermissions,
          forceApprovalPermissions: policy.forceApprovalPermissions,
          skipAllApprovals: policy.permissionMode === 'full',
          reasoningEffort: role?.reasoningEffort ?? policy.reasoningEffort,
          maxParallelToolCalls: policy.maxParallelToolCalls,
          pluginSettings: (name) => this.opts.getPluginSettings(name),
          onEvent: (e) => {
            if (e.type === 'tool-started' || e.type === 'tool-result' || e.type === 'approval-required') {
              this.opts.onLoopEvent(sessionId, parentMessageId, e);
            }
          },
          requestApproval: (call) => this.opts.approvals.requestApproval(parentMessageId, call),
        },
      });
      const header = `[子代理 role=${roleName} · 模型 ${modelLabel} · 迭代 ${result.iterations}/${maxIter}]`;
      if (!result.content.trim()) {
        // 空产出必须判失败：把它当成功回喂，主代理会以为这一路已经查完，错误就此静默通过
        return {
          ok: false,
          output: `${header}\n子代理跑完了但没有产出任何文字（多半是把迭代预算耗在了工具调用上）。`
            + '请重新委派并缩小任务范围、明确只要结论，或自己接手这部分。',
          error: 'subagent-empty',
        };
      }
      return { ok: true, output: truncatePreserveLines(`${header}\n${result.content}`, MAX_OUTPUT_CHARS) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `子代理执行失败: ${message}`, error: 'subagent-failed' };
    }
  }
}
