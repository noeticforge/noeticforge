import type { ProviderConfig } from '../../providers/provider.js';

/**
 * 子代理角色表（config.json → subagents）。
 *
 * 设计原则：角色只声明「差异」，provider / apiKey / baseUrl 一律从主配置继承，
 * 所以用户添加好一个网关后，换模型只需要写一个 model 字段——这就是「模型池」。
 */
export interface SubagentRole {
  /** 角色 ID（config 里的键名） */
  name: string;
  displayName?: string;
  /** 给主 agent 看的「该角色擅长什么、何时派它」，会被编进 subagent.run 的 description */
  purpose?: string;
  /** 覆盖主配置的模型；缺省 = 跟随主 agent */
  model?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  enableReasoningEffort?: boolean;
  /**
   * 提供则【覆盖】主系统提示（轻量模型吃完整主提示会掉工具调用准确率），
   * 缺省 = 主系统提示 + 子代理纪律。
   */
  systemPrompt?: string;
  maxIterations?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** 工具白名单：精确名 'read-file.read' 或前缀 'read-file.*'；缺省 = 全部工具 */
  tools?: string[];
  disallowedTools?: string[];
}

export interface SubagentSettings {
  roles: Map<string, SubagentRole>;
  defaultRole: string | null;
  /** 主配置派生来的 provider/apiKey/baseUrl，角色按需覆盖 */
  base: ProviderConfig;
}

export const EMPTY_BASE_CONFIG: ProviderConfig = { provider: 'openai-compatible' };

export const EMPTY_SETTINGS: SubagentSettings = {
  roles: new Map(),
  defaultRole: null,
  base: EMPTY_BASE_CONFIG,
};

/** 子代理纪律：与主对话隔离 + 只回传摘要，意味着错误没有出口，这三条是出口 */
export const SUBAGENT_DISCIPLINE = `

【子代理工作纪律】
你是被主代理委派来执行单个子任务的子代理。你看不到主对话历史，任务书就是你全部的已知信息。
1. 只做任务书范围内的事，不扩大范围，不去解决任务书没提的问题。
2. 最终答复必须按以下三段组织，缺段就写「无」：
   【结论】一句话说清做成了什么 / 得出了什么。
   【依据】可被独立核对的证据：文件路径+行号、命令原始输出、数据来源。不要写「我认为」「看起来没问题」。
   【未完成 / 不确定】任务书要求但没做到的、以及你拿不准的地方。
3. 任务书缺少验收标准、或信息不足以判断时，不要猜——把缺口写进【未完成 / 不确定】交回主代理决定。
4. 你的答复会被主代理当作事实来源之一。宁可报「不确定」，也不要编一个看起来完整的答案。
5. 回执会被原样转发给主代理并计入它的上下文，所以越短越好：整份回执控制在 500 字以内。
   【依据】只给可核对的指针（文件路径+行号、命令及其关键输出行），不要粘贴大段原文；
   主代理真需要看全文时，写「详见 <路径>」让它自己去读，而不是把内容抄进回执。`;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
  return list.length ? list : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
}

function effort(v: unknown): 'low' | 'medium' | 'high' | undefined {
  return v === 'low' || v === 'medium' || v === 'high' ? v : undefined;
}

/**
 * 解析 config.json 的 subagents 块。
 * 任何非法条目只跳过该条目，不抛错——角色表配错不该让应用起不来。
 */
export function parseSubagentSettings(raw: unknown, base: ProviderConfig): SubagentSettings {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SETTINGS, base };
  const block = raw as Record<string, unknown>;
  const roles = new Map<string, SubagentRole>();
  const rawRoles = block.roles;
  if (rawRoles && typeof rawRoles === 'object') {
    for (const [name, value] of Object.entries(rawRoles as Record<string, unknown>)) {
      if (!name.trim() || !value || typeof value !== 'object') continue;
      const r = value as Record<string, unknown>;
      roles.set(name.trim(), {
        name: name.trim(),
        displayName: str(r.displayName),
        purpose: str(r.purpose),
        model: str(r.model),
        provider: str(r.provider),
        apiKey: str(r.apiKey),
        baseUrl: str(r.baseUrl),
        maxTokens: positiveInt(r.maxTokens),
        enableReasoningEffort: typeof r.enableReasoningEffort === 'boolean' ? r.enableReasoningEffort : undefined,
        systemPrompt: str(r.systemPrompt),
        maxIterations: positiveInt(r.maxIterations),
        reasoningEffort: effort(r.reasoningEffort),
        tools: strArray(r.tools),
        disallowedTools: strArray(r.disallowedTools),
      });
    }
  }
  const defaultRole = str(block.defaultRole) ?? null;
  return {
    roles,
    // defaultRole 指向不存在的角色时忽略，避免静默把任务派给一个不存在的配置
    defaultRole: defaultRole && roles.has(defaultRole) ? defaultRole : null,
    base,
  };
}

/** 角色是否改变了模型来源（决定要不要新建 provider，还是复用主 provider） */
export function roleOverridesProvider(role: SubagentRole | undefined): boolean {
  if (!role) return false;
  return Boolean(role.model || role.provider || role.apiKey || role.baseUrl || role.maxTokens);
}

/** 角色配置叠加到主配置之上；未声明的字段继承主配置 */
export function resolveRoleProviderConfig(role: SubagentRole | undefined, base: ProviderConfig): ProviderConfig {
  if (!role) return base;
  return {
    provider: role.provider ?? base.provider,
    apiKey: role.apiKey ?? base.apiKey,
    model: role.model ?? base.model,
    baseUrl: role.baseUrl ?? base.baseUrl,
    maxTokens: role.maxTokens ?? base.maxTokens,
    enableReasoningEffort: role.enableReasoningEffort ?? base.enableReasoningEffort,
    retry: base.retry,
  };
}

/** 工具名匹配：'*' 全放行；'a.b' 精确；'a.*' 前缀 */
export function matchesToolPattern(toolName: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === '*') return true;
    if (p.endsWith('.*') || p.endsWith('*')) {
      const prefix = p.replace(/\*+$/, '');
      return toolName.startsWith(prefix);
    }
    return toolName === p;
  });
}

/** 计算子代理可见的工具集合：白名单（缺省=全部）→ 黑名单 → 恒定剔除 core- 前缀（禁止嵌套派生） */
export function filterToolNames(
  all: string[],
  allow?: string[],
  deny?: string[],
): string[] {
  let list = all.filter((n) => !n.startsWith('core-'));
  if (allow?.length) list = list.filter((n) => matchesToolPattern(n, allow));
  if (deny?.length) list = list.filter((n) => !matchesToolPattern(n, deny));
  return list;
}

/** 子代理系统提示：角色自带则覆盖主提示（轻量模型不需要整套主提示），否则主提示 + 纪律 */
export function buildSubagentSystemPrompt(role: SubagentRole | undefined, mainPrompt: string): string {
  const base = role?.systemPrompt?.trim() || mainPrompt;
  return `${base}\n\n（你是子代理：专注完成委派的任务，最后输出简洁的最终答复。）${SUBAGENT_DISCIPLINE}`;
}

/** 把角色表编成 description 片段，让主 agent 在派活时就知道该派给谁 */
export function buildRoleCatalog(settings: SubagentSettings): string {
  if (!settings.roles.size) return '';
  const lines = [...settings.roles.values()].map((r) => {
    const label = r.displayName ? `${r.name}（${r.displayName}）` : r.name;
    const bits = [r.model ? `模型 ${r.model}` : '模型跟随主代理', r.purpose].filter(Boolean);
    return `  - ${label}：${bits.join('，')}`;
  });
  return `\n可用角色（role 参数，不填则用主代理当前模型）：\n${lines.join('\n')}`;
}
