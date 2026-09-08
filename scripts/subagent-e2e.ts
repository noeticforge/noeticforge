import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createProvider, type ProviderConfig } from '../src/providers/provider.js';
import { ToolRegistry } from '../src/core/registry.js';
import { runLoop } from '../src/core/loop.js';
import { loadPluginsFromRoot } from '../src/plugins/loader.js';
import { SYSTEM_PROMPT } from '../src/electron/types.js';
import { SubagentRunner } from '../src/electron/services/subagent-runner.js';
import { parseSubagentSettings } from '../src/electron/services/subagent-roles.js';
import type { ApprovalAuditService } from '../src/electron/services/approval-audit-service.js';
import type { RuntimePolicy } from '../src/electron/services/model-policy-service.js';
import type { ToolCall } from '../src/types.js';

/**
 * 子代理编排的真实链路验收（需要 API Key，CI 不跑）：
 *   npm run build && node dist/scripts/subagent-e2e.js config.e2e.json <scenario>
 *
 * 三个场景各自验一件事，全部不 mock：
 *   forced  —— 命令它委派：验证能力、模型分流、并发
 *   auto    —— 不提子代理：验证「该拆的时候它自己会拆」（委派门槛生效）
 *   trivial —— 一句话能干完：验证「不该拆的时候它不拆」（不过度编排）
 */

interface Scenario {
  task: string;
  /** delegates = 期望 ≥2 次委派；solo = 期望 0 次委派且自己把活干完 */
  expect: 'delegates' | 'solo';
  /** delegates 场景是否额外要求换模型 + 并发 */
  strict?: boolean;
  maxIterations?: number;
}

const SCENARIOS: Record<string, Scenario> = {
  forced: {
    expect: 'delegates',
    strict: true,
    maxIterations: 12,
    task: `这是一次协作能力验证，请严格按以下要求做：

1. 你自己【不要】直接调用 read-file / shell-exec 等工具，全部实际工作必须通过 subagent.run 委派子代理完成。
2. 先调用 subagent.roles 看有哪些角色，然后按角色分工委派两个子任务：
   - 一个「机械统计」类子任务：统计 src/core 目录下 .ts 文件的数量与总行数；
   - 一个「阅读理解」类子任务：读 src/electron/services/subagent-roles.ts，用三句话说清它给子代理带来了什么新能力。
3. 这两个子任务互不依赖：请在【同一轮回复里连续发起】两个 subagent.run 调用，让它们并发跑，不要一个一个等。
4. 每个子任务的任务书里都要写明验收标准。
5. 收齐结果后由你汇总，并明确指出子代理报告了哪些【未完成 / 不确定】项（没有就说没有）。`,
  },

  auto: {
    expect: 'delegates',
    maxIterations: 12,
    task: `我在评估「把插件权限枚举从 4 种扩到 8 种」的影响面，需要你分头查清三件事，最后给我一份影响面清单：

① 权限枚举类型定义在哪些文件、又被哪些地方直接引用；
② 插件加载时的声明校验、与运行时的权限白名单校验，分别在哪里实现、逻辑是什么；
③ 审批触发条件（工具自身声明 + 底座强制审批列表）分别在哪里判定。

三件事彼此独立，最终结论都只需要几行文字。`,
  },

  trivial: {
    expect: 'solo',
    maxIterations: 6,
    task: `读一下 package.json，告诉我 version 字段的值是多少。只要这个值，不要多余解释。`,
  },
};

interface Delegation {
  role: string;
  task: string;
  model: string;
  ok: boolean;
  excerpt: string;
  startedAt: number;
  endedAt: number;
}

function toProviderConfig(cfg: Record<string, unknown>): ProviderConfig {
  const out: ProviderConfig = { provider: String(cfg.provider ?? 'openai-compatible') };
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) out.apiKey = cfg.apiKey.trim();
  if (typeof cfg.model === 'string' && cfg.model.trim()) out.model = cfg.model.trim();
  if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) out.baseUrl = cfg.baseUrl.trim();
  if (typeof cfg.maxTokens === 'number') out.maxTokens = cfg.maxTokens;
  if (typeof cfg.enableReasoningEffort === 'boolean') out.enableReasoningEffort = cfg.enableReasoningEffort;
  return out;
}

/** 扫描区间端点求最大重叠数：证明子代理是「同时在跑」而不是排队 */
function peakConcurrency(spans: Array<{ startedAt: number; endedAt: number }>): number {
  const points: Array<[number, number]> = [];
  for (const s of spans) points.push([s.startedAt, 1], [s.endedAt, -1]);
  points.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  let live = 0;
  let peak = 0;
  for (const [, delta] of points) {
    live += delta;
    peak = Math.max(peak, live);
  }
  return peak;
}

/**
 * 按时间重叠把调用聚成批次，只在最大批次内比较「串行累计 vs 墙钟」。
 * 跨轮次累加会失真：第二批发生在第一批结束之后，把它们加一起会得出
 * 「墙钟 ≥ 串行」这种看着像没并发的假数字。
 */
function biggestCluster(spans: Array<{ startedAt: number; endedAt: number }>): { serial: number; wall: number; size: number } {
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
  let best = { serial: 0, wall: 0, size: 0 };
  let group: Array<{ startedAt: number; endedAt: number }> = [];
  let groupEnd = 0;
  const flush = () => {
    if (!group.length) return;
    const serial = group.reduce((s, d) => s + (d.endedAt - d.startedAt), 0);
    const wall = Math.max(...group.map((d) => d.endedAt)) - Math.min(...group.map((d) => d.startedAt));
    if (group.length > best.size) best = { serial, wall, size: group.length };
  };
  for (const s of sorted) {
    if (group.length && s.startedAt >= groupEnd) {
      flush();
      group = [];
    }
    group.push(s);
    groupEnd = Math.max(groupEnd, s.endedAt);
  }
  flush();
  return best;
}

async function main(): Promise<void> {
  const cfgPath = process.argv[2] ?? 'config.e2e.json';
  const scenarioName = process.argv[3] ?? 'auto';
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`未知场景 "${scenarioName}"，可选：${Object.keys(SCENARIOS).join(' / ')}`);
    process.exit(2);
  }
  if (!existsSync(cfgPath)) {
    console.error(`未找到 ${cfgPath}`);
    process.exit(1);
  }

  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
  const baseCfg = toProviderConfig(cfg);
  const mainModel = baseCfg.model ?? '(默认)';
  const provider = createProvider(baseCfg);

  const registry = new ToolRegistry();
  const report = await loadPluginsFromRoot(path.resolve('plugins'), registry);
  const settings = parseSubagentSettings(cfg.subagents, baseCfg);

  console.log(`【场景 ${scenarioName}】主 agent 模型: ${mainModel}`);
  console.log(`已配置角色: ${[...settings.roles.values()].map((r) => `${r.name}→${r.model ?? '跟随主代理'}`).join('，') || '（无）'}\n`);

  const policy: RuntimePolicy = {
    provider,
    maxIterations: scenario.maxIterations ?? 12,
    contextTokenBudget: typeof cfg.contextTokenBudget === 'number' ? cfg.contextTokenBudget : 24_000,
    summarize: true,
    permissionMode: 'full',
    allowedPermissions: undefined,
    forceApprovalPermissions: undefined,
    reasoningEffort: undefined,
    maxParallelToolCalls: typeof cfg.maxParallelToolCalls === 'number' ? cfg.maxParallelToolCalls : undefined,
    models: [mainModel],
    currentModel: mainModel,
    savedBaseUrl: baseCfg.baseUrl ?? null,
  };

  const runner = new SubagentRunner({
    registry,
    getProvider: () => provider,
    getSystemPrompt: () => SYSTEM_PROMPT,
    getPolicy: () => policy,
    getPluginSettings: () => undefined,
    approvals: { requestApproval: async () => 'approved' } as unknown as ApprovalAuditService,
    getAbortSignal: () => undefined,
    workingDir: process.cwd(),
    onLoopEvent: () => {},
    getSubagentSettings: () => settings,
  });
  runner.registerTool();

  const pending = new Map<string, ToolCall>();
  const startedAt = new Map<string, number>();
  const delegations: Delegation[] = [];
  const ownToolCalls: string[] = [];

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: scenario.task,
    history: [],
    workingDir: process.cwd(),
    contextTokenBudget: policy.contextTokenBudget,
    options: {
      maxIterations: policy.maxIterations,
      pluginSettings: () => undefined,
      // 与 agent-service.ts 的接线一致：subagent.run 的 execute 靠 ctx.services 拿委派入口
      ctxExtras: () => ({ services: { runSubagent: (a: Record<string, unknown>) => runner.runSubagent(a, 'e2e', 'm1') } }),
      requestApproval: async () => 'approved',
      maxParallelToolCalls: policy.maxParallelToolCalls,
      onEvent: (e) => {
        if (e.type === 'assistant-message' && e.content.trim()) {
          console.log(`\n[主 agent] ${e.content.trim().slice(0, 300)}`);
        }
        if (e.type === 'tool-started') {
          pending.set(e.call.id, e.call);
          if (e.call.name === 'subagent.run') startedAt.set(e.call.id, Date.now());
          else ownToolCalls.push(e.call.name);
          console.log(`  ▸ ${e.call.name} ${JSON.stringify(e.call.arguments).slice(0, 120)}`);
        }
        if (e.type === 'tool-result') {
          const call = pending.get(e.call.id);
          if (e.call.name === 'subagent.run' && call) {
            const header = /role=(\S+)\s*·\s*模型\s+(\S+)\s*·/.exec(e.result.output);
            delegations.push({
              role: header?.[1] ?? '(未标注)',
              model: header?.[2] ?? '(未标注)',
              task: String(call.arguments.task ?? '').split('\n')[0].slice(0, 60),
              ok: e.result.ok,
              excerpt: `${e.result.output || e.result.error || ''}`.replace(/\s+/g, ' ').slice(0, 160),
              startedAt: startedAt.get(e.call.id) ?? 0,
              endedAt: Date.now(),
            });
          }
          console.log(`  ${e.result.ok ? '✓' : '✗'} ${e.call.name} → ${e.result.output.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
        if (e.type === 'loop-error') console.log(`  ! loop-error: ${e.error}`);
      },
    },
  });

  const usable = delegations.filter((d) => d.ok && d.model !== '(未标注)');
  const failed = delegations.filter((d) => !d.ok);
  const spans = delegations.filter((d) => d.startedAt > 0);
  const peak = peakConcurrency(spans);
  const cluster = biggestCluster(spans);

  console.log('\n================ 观测 ================');
  console.log(`主 agent 迭代轮数: ${result.iterations}`);
  console.log(`委派子任务: ${delegations.length} 次（有效 ${usable.length} 次）；自己直接调用工具: ${ownToolCalls.length} 次`);
  for (const d of delegations) {
    console.log(`  · role=${d.role} 模型=${d.model} ${d.model !== mainModel && d.model !== '(未标注)' ? '≠主模型' : '=主模型'} ok=${d.ok} 耗时 ${d.endedAt - d.startedAt}ms`);
    console.log(`    ${d.excerpt}`);
  }
  console.log(`\n最终答复（前 900 字）:\n${result.content.slice(0, 900)}`);

  console.log(`\n================ 判定（场景 ${scenarioName}）================`);
  let pass = true;
  const mark = (ok: boolean, label: string) => {
    if (!ok) pass = false;
    console.log(`${ok ? '✅' : '❌'} ${label}`);
  };

  if (scenario.expect === 'delegates') {
    mark(usable.length >= 2, `完成 ≥2 次有效委派（成功 ${usable.length} / 尝试 ${delegations.length}）`);
    mark(result.content.trim().length > 0, '主 agent 给出了最终汇总');
    if (failed.length) {
      console.log(`   ℹ ${failed.length} 次子代理失败：${usable.length >= 2 ? '已被主 agent 重试恢复（期望行为，不计缺陷）' : '且未能恢复'}`);
    }
    if (scenario.strict) {
      mark(usable.some((d) => d.model !== mainModel), `子代理换了模型（存在 ≠ ${mainModel} 的成功执行）`);
      mark(peak >= 2, `子代理并发（同时在跑峰值 ${peak}；最大批次内 串行 ${cluster.serial}ms vs 墙钟 ${cluster.wall}ms）`);
    }
  } else {
    mark(delegations.length === 0, `没有为简单任务派子代理（委派 ${delegations.length} 次，要求 0）`);
    mark(ownToolCalls.length >= 1, `自己动手把活干了（直接调用 ${ownToolCalls.join(', ') || '无'}）`);
    mark(/\d+\.\d+\.\d+/.test(result.content), `给出了正确答案（答复里含版本号）`);
  }

  console.log(pass ? '\n🟢 场景通过' : '\n🔴 场景未通过');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e 崩溃:', e);
  process.exit(1);
});
