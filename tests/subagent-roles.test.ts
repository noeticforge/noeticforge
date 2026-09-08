import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/core/registry.js';
import type {
  AgentTool,
  ChatMessage,
  LLMProvider,
  LLMResponse,
  Plugin,
  ToolDefinition,
} from '../src/types.js';
import type { ProviderConfig } from '../src/providers/provider.js';
import type { RuntimePolicy } from '../src/electron/services/model-policy-service.js';
import type { ApprovalAuditService } from '../src/electron/services/approval-audit-service.js';
import { SubagentRunner } from '../src/electron/services/subagent-runner.js';
import {
  buildRoleCatalog,
  buildSubagentSystemPrompt,
  filterToolNames,
  parseSubagentSettings,
  resolveRoleProviderConfig,
  roleOverridesProvider,
  SUBAGENT_DISCIPLINE,
} from '../src/electron/services/subagent-roles.js';

const BASE: ProviderConfig = {
  provider: 'openai-compatible',
  apiKey: 'sk-main',
  baseUrl: 'http://gateway/v1',
  model: 'big-model',
};

const RAW = {
  defaultRole: 'researcher',
  roles: {
    researcher: { displayName: '研究员', model: 'flash', purpose: '检索汇总' },
    coder: { provider: 'anthropic', apiKey: 'sk-coder', model: 'claude-x', tools: ['read-file.*'] },
    quiet: { systemPrompt: '你只做一件事', reasoningEffort: 'low', maxIterations: 3 },
    broken: 'not-an-object',
  },
};

function makePlugin(name: string, toolNames: string[]): Plugin {
  const tools: AgentTool[] = toolNames.map((t) => ({
    name: t,
    description: `tool ${t}`,
    parameters: { type: 'object' },
    permissions: [],
    execute: async () => ({ ok: true, output: '' }),
  }));
  return {
    manifest: { name, version: '1.0.0', displayName: name, description: name, permissions: [], entry: 'index.js' },
    tools,
  };
}

describe('subagent 角色表解析', () => {
  it('解析角色并跳过非法条目；未声明字段继承主配置', () => {
    const s = parseSubagentSettings(RAW, BASE);
    expect([...s.roles.keys()].sort()).toEqual(['coder', 'quiet', 'researcher']);
    expect(s.defaultRole).toBe('researcher');

    const researcher = resolveRoleProviderConfig(s.roles.get('researcher'), BASE);
    expect(researcher).toMatchObject({ provider: 'openai-compatible', apiKey: 'sk-main', baseUrl: 'http://gateway/v1', model: 'flash' });

    const coder = resolveRoleProviderConfig(s.roles.get('coder'), BASE);
    expect(coder).toMatchObject({ provider: 'anthropic', apiKey: 'sk-coder', model: 'claude-x', baseUrl: 'http://gateway/v1' });
  });

  it('retry 策略随主配置继承给角色 provider，不让子代理偷偷拿默认值', () => {
    const withRetry: ProviderConfig = { ...BASE, retry: { attempts: 1, baseDelayMs: 0 } };
    const s = parseSubagentSettings(RAW, withRetry);
    expect(resolveRoleProviderConfig(s.roles.get('researcher'), withRetry).retry).toEqual({ attempts: 1, baseDelayMs: 0 });
  });

  it('defaultRole 指向不存在的角色时忽略，不静默派给空配置', () => {
    const s = parseSubagentSettings({ ...RAW, defaultRole: 'ghost' }, BASE);
    expect(s.defaultRole).toBeNull();
  });

  it('只有 model/provider/apiKey/baseUrl/maxTokens 才算换模型来源；纯提示词角色复用主 provider', () => {
    const s = parseSubagentSettings(RAW, BASE);
    expect(roleOverridesProvider(s.roles.get('researcher'))).toBe(true);
    expect(roleOverridesProvider(s.roles.get('quiet'))).toBe(false);
    expect(roleOverridesProvider(undefined)).toBe(false);
  });

  it('subagents 缺失或格式错误时返回空表而不是抛错', () => {
    expect(parseSubagentSettings(undefined, BASE).roles.size).toBe(0);
    expect(parseSubagentSettings('nope', BASE).roles.size).toBe(0);
    expect(parseSubagentSettings({ roles: 42 }, BASE).roles.size).toBe(0);
  });
});

describe('子代理工具集裁剪', () => {
  const all = ['read-file.read', 'write-file.write', 'shell-exec.run', 'kb.search', 'core-subagent.run'];

  it('恒定剔除 core- 前缀：子代理不能嵌套派生', () => {
    expect(filterToolNames(all)).not.toContain('core-subagent.run');
    expect(filterToolNames(all)).toHaveLength(4);
  });

  it('白名单支持前缀通配与精确名，黑名单在其后生效', () => {
    expect(filterToolNames(all, ['read-file.*'])).toEqual(['read-file.read']);
    expect(filterToolNames(all, ['*'], ['shell-exec.run'])).toEqual(['read-file.read', 'write-file.write', 'kb.search']);
    expect(filterToolNames(all, ['kb.search', 'read-file.read'])).toEqual(['read-file.read', 'kb.search']);
  });
});

describe('子代理提示词与角色清单', () => {
  it('未覆盖时保留主提示，并追加三段式产出纪律', () => {
    const p = buildSubagentSystemPrompt(undefined, 'MAIN_PROMPT');
    expect(p).toContain('MAIN_PROMPT');
    expect(p).toContain(SUBAGENT_DISCIPLINE.trim().slice(0, 12));
    expect(p).toContain('【依据】');
    expect(p).toContain('不要猜');
  });

  it('纪律含回执瘦身条款：长度上限 + 只给指针不抄原文', () => {
    const p = buildSubagentSystemPrompt(undefined, 'MAIN_PROMPT');
    expect(p).toContain('500 字');
    expect(p).toContain('不要粘贴大段原文');
    expect(p).toContain('详见');
  });

  it('角色自带 systemPrompt 时【覆盖】主提示（轻量模型不需要整套主提示）', () => {
    const s = parseSubagentSettings(RAW, BASE);
    const p = buildSubagentSystemPrompt(s.roles.get('quiet'), 'MAIN_PROMPT');
    expect(p).not.toContain('MAIN_PROMPT');
    expect(p).toContain('你只做一件事');
    expect(p).toContain('【结论】');
  });

  it('角色清单进 description：模型名与职责都要让主 agent 看得见', () => {
    const s = parseSubagentSettings(RAW, BASE);
    const c = buildRoleCatalog(s);
    expect(c).toContain('researcher');
    expect(c).toContain('flash');
    expect(c).toContain('检索汇总');
    expect(buildRoleCatalog(parseSubagentSettings(undefined, BASE))).toBe('');
  });
});

// ---------- 集成：SubagentRunner 真的按角色换了模型吗 ----------

class RecordingProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly seen: { messages: ChatMessage[]; tools: ToolDefinition[] }[] = [];
  constructor(id: string, model: string, private readonly reply: string) {
    this.id = id;
    this.model = model;
  }
  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMResponse> {
    // 快照：runLoop 会在调用返回后继续往同一个数组里追加，直接存引用会看到后续状态
    this.seen.push({ messages: messages.map((m) => ({ ...m })), tools });
    return { content: this.reply, toolCalls: [], finishReason: 'stop' };
  }
}

function makePolicy(provider: LLMProvider): RuntimePolicy {
  return {
    provider, maxIterations: 15, contextTokenBudget: 24_000, summarize: true,
    permissionMode: 'full', allowedPermissions: undefined, forceApprovalPermissions: undefined,
    reasoningEffort: undefined, models: ['big-model'], currentModel: 'big-model', savedBaseUrl: 'http://gateway/v1',
  };
}

function makeRunner(
  settings: ReturnType<typeof parseSubagentSettings>,
  main: RecordingProvider,
  createdReply: (model: string) => string = (m) => `子代理答复(${m})`,
) {
  const registry = new ToolRegistry();
  registry.register(makePlugin('read-file', ['read-file.read']));
  registry.register(makePlugin('write-file', ['write-file.write']));
  registry.register(makePlugin('core-subagent', ['core-subagent.run']));
  const created: RecordingProvider[] = [];
  const runner = new SubagentRunner({
    registry,
    getProvider: () => main,
    getSystemPrompt: () => 'MAIN_PROMPT',
    getPolicy: () => makePolicy(main),
    getPluginSettings: () => undefined,
    approvals: { requestApproval: async () => 'approved' } as unknown as ApprovalAuditService,
    getAbortSignal: () => undefined,
    workingDir: '/tmp',
    onLoopEvent: () => {},
    getSubagentSettings: () => settings,
    createProviderFor: (cfg) => {
      const model = cfg.model ?? 'unknown';
      const p = new RecordingProvider(cfg.provider, model, createdReply(model));
      created.push(p);
      return p;
    },
  });
  return { runner, created };
}

describe('SubagentRunner 按角色路由模型', () => {
  const settings = parseSubagentSettings(RAW, BASE);

  it('显式指定 role 时用该角色的模型跑子循环，不碰主 provider', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(settings, main);
    const res = await runner.runSubagent({ task: '统计 src 下文件数', role: 'researcher' }, 's1', 'm1');
    expect(res.ok).toBe(true);
    expect(main.seen).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0].model).toBe('flash');
    expect(res.output).toContain('子代理答复(flash)');
  });

  it('defaultRole 命中时不填 role 也走角色模型；输出头保留换行不被压平', async () => {
    const withDefault = parseSubagentSettings(
      { defaultRole: 'researcher', roles: { researcher: { model: 'flash' } } },
      BASE,
    );
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(withDefault, main);
    const res = await runner.runSubagent({ task: '查一下 X 是什么' }, 's1', 'm1');
    expect(created[0].model).toBe('flash');
    expect(res.output).toContain('[子代理 role=researcher · 模型 flash · 迭代 1/8]');
    expect(res.output).toContain('\n');
  });

  it('未配置角色时完全回落到主 provider（向后兼容旧行为）', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(parseSubagentSettings(undefined, BASE), main);
    const res = await runner.runSubagent({ task: '随便' }, 's1', 'm1');
    expect(created).toHaveLength(0);
    expect(main.seen).toHaveLength(1);
    expect(res.output).toContain('role=default');
  });

  it('子代理上下文与主对话隔离：只有 system + 任务书两条消息', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(settings, main);
    await runner.runSubagent({ task: '只看这一句', role: 'researcher' }, 's1', 'm1');
    const msgs = created[0].seen[0].messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[1].content).toBe('只看这一句');
    expect(msgs[0].content).toContain('MAIN_PROMPT');
    expect(msgs[0].content).toContain('【依据】');
  });

  it('角色的工具白名单真的收窄了子代理可见工具，且拿不到 subagent.run', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(settings, main);
    await runner.runSubagent({ task: '只读不改', role: 'coder' }, 's1', 'm1');
    const names = created[0].seen[0].tools.map((t) => t.name);
    expect(names).toEqual(['read-file.read']);
    expect(names).not.toContain('core-subagent.run');
  });

  it('未知角色直接报错并列出可用角色，不悄悄退回主模型干活', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(settings, main);
    const res = await runner.runSubagent({ task: 'x', role: 'ghost' }, 's1', 'm1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未知角色 "ghost"');
    expect(res.error).toContain('researcher');
    expect(created).toHaveLength(0);
  });

  it('同一角色重复委派复用已构造的 provider，不每次重建连接', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(settings, main);
    await runner.runSubagent({ task: 'a', role: 'researcher' }, 's1', 'm1');
    await runner.runSubagent({ task: 'b', role: 'researcher' }, 's1', 'm1');
    expect(created).toHaveLength(1);
  });

  it('task 为空不消耗模型调用', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner, created } = makeRunner(settings, main);
    const res = await runner.runSubagent({ task: '   ', role: 'researcher' }, 's1', 'm1');
    expect(res.ok).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('子代理一个字都没输出时判为失败，不让错误静默通过', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner } = makeRunner(settings, main, () => '   \n  ');
    const res = await runner.runSubagent({ task: 'x', role: 'researcher' }, 's1', 'm1');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('subagent-empty');
    expect(res.output).toContain('重新委派');
  });

  it('回执未超限时原样保留，换行不被压平', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const reply = '【结论】第一行\n【依据】第二行\n【未完成 / 不确定】无';
    const { runner } = makeRunner(settings, main, () => reply);
    const res = await runner.runSubagent({ task: 'x', role: 'researcher' }, 's1', 'm1');
    expect(res.output).toContain(reply);
    expect(res.output).not.toContain('截断');
  });

  it('回执超限时截到 6k，并告诉主代理「被截断了、下一步该怎么办」', async () => {
    const main = new RecordingProvider('main', 'big-model', '主答复');
    const { runner } = makeRunner(settings, main, () => '证据行\n'.repeat(4000)); // 约 16k 字符
    const res = await runner.runSubagent({ task: 'x', role: 'researcher' }, 's1', 'm1');
    expect(res.output.length).toBeLessThan(7000);
    expect(res.output).toContain('已被截断');
    expect(res.output).toContain('read-file');
    expect(res.output).toContain('\n'); // 截断后仍是多行结构，没被压成一行
  });
});
