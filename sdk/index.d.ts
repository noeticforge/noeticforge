/**
 * @agent-base/sdk —— 插件作者面向的全部类型。
 * 与底座 src/types.ts 保持同步；底座侧的「宪法」注释同样适用于这里：
 * 这些是插件作者与底座之间的契约，改字段前先过协议评审（CONTRIBUTING.md 铁律 1）。
 */

export type Permission = 'fs:read' | 'fs:write' | 'shell:exec' | 'net:http';

export interface PluginManifest {
  /** 全局唯一 ID，kebab-case；工具名必须以它开头 */
  name: string;
  /** semver */
  version: string;
  /** UI 展示名（未来支持 i18n 对象） */
  displayName: string;
  description: string;
  author?: string;
  /** 插件声明的权限上限，工具的 permissions 必须是其子集 */
  permissions: Permission[];
  /** 入口 js 文件相对路径 */
  entry: string;
  /** 插件协议版本（当前 1；缺省视为 1） */
  protocolVersion?: number;
  /** 插件设置页 JSON Schema；值经 UI 配置后注入 ToolContext.settings */
  settings?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** 喂回 LLM 的文本（UI 也会展示） */
  output: string;
  /** 失败时的错误标识；底座预置：tool-not-found / rejected-by-user / permission-denied / invalid-arguments / tool-crashed */
  error?: string;
  /**
   * UI 渲染提示（富插件协议 v2）：'markdown' | 'code' | 'diff' | 'table'。
   * 仅影响展示，不影响喂给模型的内容。不开放任意 HTML。
   */
  render?: string;
}

export interface ToolContext {
  pluginName: string;
  /** 工具相对路径的基准目录；不要用 process.cwd() */
  workingDir: string;
  /** 用户在设置页配置的值（结构由 manifest.settings 约定） */
  settings?: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  description: string;
  /** OpenAI 风格 JSON Schema */
  parameters: Record<string, unknown>;
  permissions: Permission[];
  /** true 时执行前必须用户批准；权限命中底座 forceApprovalPermissions 也会强制审批 */
  requiresApproval?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface Plugin {
  manifest: PluginManifest;
  tools: AgentTool[];
  /** 安装成功后回调（可选）；抛错不影响安装 */
  onInstall?: () => Promise<void>;
  /** 卸载前回调（可选）；抛错不影响卸载 */
  onUninstall?: () => Promise<void>;
}

/** definePlugin：纯类型辅助，让 IDE 补全与类型检查作用于插件导出对象 */
export declare function definePlugin(plugin: Plugin): Plugin;
