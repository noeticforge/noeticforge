/**
 * agent-base 全局类型定义
 * 这是整个底座的「宪法」：循环引擎、Provider、插件全部围绕这些接口工作。
 * 修改任何接口前先想清楚——它们是插件作者和 UI 开发者的依赖契约。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 模型发起的一次工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 统一消息格式（Provider 负责把它翻译成各家 API 的格式） */
export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant 消息携带的工具调用列表 */
  toolCalls?: ToolCall[];
  /** role 为 tool 时，对应 ToolCall.id */
  toolCallId?: string;
}

/** 暴露给 LLM 的工具描述（JSON Schema 格式的参数定义） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** LLM 一轮响应的统一格式 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
}

/** LLM 单次调用的可选项：中断信号 + 流式增量回调 */
export interface ChatOptions {
  signal?: AbortSignal;
  /** 流式输出：provider 每产出一小段文本就回调一次；非流式 provider 在结束时回调一次全文 */
  onChunk?: (delta: string) => void;
}

/** 模型适配器接口：接新厂商 = 实现这一个方法 */
export interface LLMProvider {
  readonly id: string;
  chat(messages: ChatMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse>;
}

/** 插件权限枚举 */
export type Permission = 'fs:read' | 'fs:write' | 'shell:exec' | 'net:http';

/** 插件清单：每个插件文件夹内 manifest.json 的结构 */
export interface PluginManifest {
  /** 全局唯一 ID，kebab-case */
  name: string;
  /** semver 版本号 */
  version: string;
  displayName: string;
  description: string;
  author?: string;
  /** 插件声明的权限范围，工具的权限必须是它的子集 */
  permissions: Permission[];
  /** 入口 js 文件相对插件目录的路径 */
  entry: string;
  /** 插件协议版本（缺省视为 1）；加载器拒绝高于底座支持的版本 */
  protocolVersion?: number;
  /** 插件设置页的 JSON Schema（富插件协议 v2）；值由用户配置后注入 ToolContext.settings */
  settings?: Record<string, unknown>;
}

/** 工具执行结果（喂回 LLM 的内容就在 output 里） */
export interface ToolResult {
  ok: boolean;
  output: string;
  /** 预置错误码（插件也可用自定义值）：tool-not-found / rejected-by-user / permission-denied / invalid-arguments / tool-crashed */
  error?: string;
}

/** 工具执行时由底座注入的上下文 */
export interface ToolContext {
  pluginName: string;
  workingDir: string;
  /** 插件在设置页配置的值（由 manifest.settings Schema 约定结构） */
  settings?: Record<string, unknown>;
}

/** 工具：插件提供的最小能力单元 */
export interface AgentTool {
  /** 全局唯一，命名约定 "插件名.工具名" */
  name: string;
  /** 给 LLM 看的用途说明 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, unknown>;
  /** 必须是插件 manifest.permissions 的子集 */
  permissions: Permission[];
  /** 为 true 时执行前需要用户批准（审批钩子） */
  requiresApproval?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 插件：manifest + 工具集合（manifest 由加载器在校验后回填） */
export interface Plugin {
  manifest: PluginManifest;
  tools: AgentTool[];
  /** 生命周期钩子（富插件协议 v2）：安装成功后 / 卸载前回调，抛错不影响装卸主流程 */
  onInstall?: () => Promise<void>;
  onUninstall?: () => Promise<void>;
}

/** 循环引擎对外抛出的全部事件（IPC 事件协议的来源，一一对应） */
export type LoopEvent =
  | { type: 'assistant-message'; content: string; toolCalls: ToolCall[] }
  | { type: 'tool-started'; call: ToolCall }
  | { type: 'tool-result'; call: ToolCall; result: ToolResult }
  | { type: 'approval-required'; call: ToolCall }
  | { type: 'loop-done'; content: string; iterations: number }
  | { type: 'loop-error'; error: string };

export type ApprovalDecision = 'approved' | 'rejected';

/** 审批回调的返回值：简单批准/拒绝，或带参数覆盖、拒绝原因的结构化决定 */
export type ApprovalResolution =
  | ApprovalDecision
  | {
      decision: ApprovalDecision;
      /** 批准时可覆盖模型生成的参数（用户在审批框里微调过） */
      arguments?: Record<string, unknown>;
      /** 拒绝原因，回填给模型参考 */
      reason?: string;
    };

export interface LoopOptions {
  maxIterations: number;
  onEvent: (event: LoopEvent) => void;
  /** 流式输出回调（透传给 provider） */
  onChunk?: (delta: string) => void;
  /** 中断信号：abort 后循环在最近的检查点终止 */
  signal?: AbortSignal;
  /** 审批钩子：返回 'rejected' 时工具不执行，拒绝信息喂回模型 */
  requestApproval?: (call: ToolCall) => Promise<ApprovalResolution>;
  /**
   * 运行时权限白名单：工具要求的权限有任一项不在名单内 → 不执行，
   * 返回 error: 'permission-denied' 喂回模型，循环继续。未配置 = 全部放行。
   * 注意：这是运行时策略层，不是沙箱——插件进程内调用原生 API 仍不受物理拦截（沙箱在 Roadmap 后续阶段）。
   */
  allowedPermissions?: Permission[];
  /** 强制审批的权限列表：工具权限命中即必须审批，可覆盖插件 requiresApproval: false 的声明 */
  forceApprovalPermissions?: Permission[];
  /** 查询插件设置值（富插件协议 v2）：注入 ToolContext.settings；未配置返回 undefined */
  pluginSettings?: (pluginName: string) => Record<string, unknown> | undefined;
}
