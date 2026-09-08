import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage, LLMProvider, Permission, Plugin } from '../types.js';
import type { Session } from '../core/session-store.js';

/**
 * IPC 层共享类型与纯工具函数（从 agent-service.ts 拆出的「宪法」部分）。
 * 只放类型、常量与无副作用纯函数；任何依赖实例状态的方法都不在这里。
 */

/** IPC 统一返回包装（协议 §2.2）：handler 永不 throw */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: LoopError };

/** IPC 统一错误结构（协议 §6.1）；code 的合法值见 src/shared/error-codes.ts */
export interface LoopError {
  code: string;
  message: string;
  phase: 'receive' | 'llm' | 'tool' | 'approval' | 'session' | 'unknown';
  toolCallId?: string;
  details?: Record<string, unknown>;
}

/** 插件信息快照（协议 §3.5 PluginInfo） */
export interface PluginInfo {
  name: string;
  version: string;
  displayName: string;
  description: string;
  author?: string;
  permissions: string[];
  tools: string[];
}

/** 会话摘要（协议 §3.9 SessionMeta） */
export type SessionMetaDTO = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

/** 会话完整内容（协议 §3.10） */
export interface SessionDTO extends SessionMetaDTO {
  messages: ChatMessage[];
}

/**
 * 权限模式（UI 编排层的四个预设，映射到循环层三道关卡的策略参数）：
 *   ask-before-change 变更前确认：写文件/执行命令前必须审批
 *   auto-edit         自动编辑：写文件免审批，执行命令仍需审批
 *   plan              计划模式：只读（写/执行/联网在运行时策略层直接拒绝）
 *   full              完全访问：不额外限制（插件自身声明的审批钩子仍然生效）
 */
export type PermissionMode = 'ask-before-change' | 'auto-edit' | 'plan' | 'full';

export const PERMISSION_MODES: PermissionMode[] = ['ask-before-change', 'auto-edit', 'plan', 'full'];

export const POLICY_PRESETS: Record<PermissionMode, { allowed?: Permission[]; force: Permission[] }> = {
  'ask-before-change': { force: ['fs:write', 'shell:exec'] },
  'auto-edit': { force: ['shell:exec'] },
  plan: { allowed: ['fs:read'], force: [] },
  full: { force: [] },
};

/** 应用信息快照（协议 §3.21 get-app-info） */
export interface AppInfo {
  version: string;
  appDir: string;
  provider: string | null;
  model: string | null;
  models: string[];
  baseUrl: string | null;
  permissionMode: PermissionMode;
  maxIterations: number;
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  sessionCount: number;
  pluginCount: number;
  mcpCount: number;
}

/** 主进程 → UI 的全部推送通道 */
export type PushChannel =
  | 'message-chunk'
  | 'tool-started'
  | 'tool-result'
  | 'approval-required'
  | 'loop-done'
  | 'loop-error'
  | 'context-compacted'
  | 'plugins-changed'
  | 'sessions-changed'
  | 'mcp-status-changed'
  | 'term-data'
  | 'updater-state';

export interface AgentServiceOptions {
  /** 项目根目录（config.json / plugins/ / sessions/ 所在地） */
  appDir: string;
  /** 推送回调：Electron 里是 webContents.send，测试里是收集器 */
  pushEvent: (channel: PushChannel, payload: unknown) => void;
  /** 测试注入；生产环境从 config.json 构造 */
  initialProvider?: LLMProvider;
  maxIterations?: number;
  /** 上下文 token 预算（估算），超限整轮截断；默认 24000 */
  contextTokenBudget?: number;
  /** 运行时权限白名单（undefined = 全部放行） */
  allowedPermissions?: Permission[];
  /** 强制审批的权限列表：命中即必须审批，覆盖插件 requiresApproval 声明 */
  forceApprovalPermissions?: Permission[];
  /** 插件注册表索引 URL（默认官方 registry 仓库） */
  pluginRegistryUrl?: string;
}

export const SYSTEM_PROMPT = `你是一个桌面端智能助手，可以通过提供的工具读写用户电脑上的文件、执行终端命令、查询知识库来高效完成任务。

【核心交互规范：主动对齐与方案决策】
当你面对复杂任务、多种可行技术路线/架构选型、重大代码变更/重构、或用户需求有多种解释方向时，严禁盲目猜测并直接动手修改。
你拥有内置交互决策工具：ask-user.choose。
在此类场景下，必须主动调用 ask-user.choose 工具向用户弹出清晰的 A/B/C/D 选项卡片：
1. question：明确写出需要用户拍板的核心问题；
2. options：给出 2~4 个互斥且具可行性的方案（包含标题与方案说明），并将你认为最好的方案标记为 recommended: true；
3. rationale：写明你推荐该方案的技术理由与权衡分析；
得到用户的决策结果后，再严格顺着用户选定的路线实施。

【子任务委派】
先判断任务的形状，再决定自己干还是拆出去：
- 纵向（一步接一步、依赖连贯上下文、要边做边跟用户对齐）→ 你自己干。
- 横向（多个彼此独立的调查面 / 文件面 / 视角，各自能单独验收）→ 默认拆给子代理，并在同一轮里连续发起让它们并发跑。
拆的判据只有一条：这个子步骤「过程很长、结论很短」。满足就拆——它的中间检索、试错和大段文件内容都留在子代理自己的
上下文里，只有一段摘要回到主对话，主对话才能一直保持清醒地做规划与收尾。
不满足就别拆：子代理看不到本对话历史，会重复读你已经读过的文件，还多一次模型往返，为拆而拆更慢更贵。
一个具体的危险信号：当你在同一类操作上连续调用工具超过 3 次（反复 grep、反复换参数试同一条命令、反复列目录），
说明你正在做横向检索——立刻把整块交给子代理，不要继续在主对话里磨。
1. 任务书必须自包含并写明【验收标准】：子代理看不到本对话历史，你漏掉的前提它只能靠猜。
2. 按任务的判断密度选角色（subagent.run 的说明里列了可用角色及其模型）：机械性、可验证的活交给轻量角色，
   需要设计、权衡、跨文件推理的活留给你自己；不确定派给谁时先调 subagent.roles 看清单。
3. 子代理只回传摘要，看不到它的完整过程。对影响最终结论的关键判断，
   用 read-file 等工具抽查它给出的【依据】后再采信；抽查不通过就重新委派或自己接手。
4. 多个互不依赖的子任务，在同一轮里连续发起多个 subagent.run 调用，底座会并发执行它们（默认最多 4 个同时在跑）；
   有前后依赖的子任务则按顺序分批派，别为了并发把依赖打断。
工具的执行结果会以 tool 消息返回给你。如果工具返回了错误，请如实告知用户，不要虚构结果。`;

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/noeticforge/noeticforge/main/registry/registry.json';

/** 应用版本（与 package.json 同源，避免双写漂移；源码与编译产物相对层级一致） */
export const APP_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')).version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

export interface RunningLoop {
  messageId: string;
  abort: AbortController;
  partialContent: string;
}

// ---------- 纯工具函数 ----------

export function toSessionDTO(session: Session): SessionDTO {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    messages: session.messages,
  };
}

export function toPluginInfo(plugin: Plugin): PluginInfo {
  const m = plugin.manifest;
  return {
    name: m.name,
    version: m.version,
    displayName: typeof m.displayName === 'string' ? m.displayName : JSON.stringify(m.displayName),
    description: typeof m.description === 'string' ? m.description : JSON.stringify(m.description),
    author: m.author,
    permissions: m.permissions,
    tools: plugin.tools.map((t) => t.name),
  };
}

export function err(code: string, message: string, phase: LoopError['phase']): IpcResult<never> {
  return { ok: false, error: { code, message, phase } };
}

export function truncate(value: unknown, max: number): string {
  const s = JSON.stringify(value) ?? '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function truncateText(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

export async function findDirWithManifest(root: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (existsSync(path.join(dir, 'manifest.json'))) return dir;
  }
  return undefined;
}
