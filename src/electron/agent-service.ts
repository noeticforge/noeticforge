import { cp, rm, readFile, writeFile, stat, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type {
  ApprovalResolution,
  ChatMessage,
  LLMProvider,
  LoopEvent,
  Permission,
  Plugin,
  ToolCall,
} from '../types.js';
import { ToolRegistry } from '../core/registry.js';
import { runLoop } from '../core/loop.js';
import { AgentLoopError } from '../core/errors.js';
import { SessionStore, type Session } from '../core/session-store.js';
import { loadPluginFromDir, loadPluginsFromRoot } from '../plugins/loader.js';
import { createProvider, type ProviderConfig } from '../providers/provider.js';
import { listProviderMetas } from '../providers/registry.js';
import { McpManager, type McpServerConfig, type McpServerStatus } from '../mcp/manager.js';

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

const POLICY_PRESETS: Record<PermissionMode, { allowed?: Permission[]; force: Permission[] }> = {
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
  | 'plugins-changed'
  | 'sessions-changed'
  | 'mcp-status-changed';

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

const SYSTEM_PROMPT = `你是一个桌面端助手，可以通过提供的工具读写用户电脑上的文件来完成任务。
工具的执行结果会以 tool 消息返回给你。如果工具返回了错误，请如实告知用户，不要虚构结果。`;

const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/agent-base/registry/main/registry.json';

const APP_VERSION = '0.3.0';

interface RunningLoop {
  messageId: string;
  abort: AbortController;
  partialContent: string;
}

/**
 * AgentService：IPC 事件协议的完整业务实现，不含任何 Electron API。
 * Electron main 只做薄薄一层 ipcMain.handle → service 转发；这样全部逻辑可以脱离 GUI 自测。
 *
 * v0.2/v0.3 新增：多会话持久化、上下文裁剪、Provider 注册表、MCP 桥接、审计日志、
 * 插件设置、生命周期钩子、registry 远程安装。
 */
export class AgentService {
  readonly registry = new ToolRegistry();
  private provider: LLMProvider | null;
  private readonly appDir: string;
  private readonly pushEvent: (channel: PushChannel, payload: unknown) => void;
  private maxIterations: number;
  /** 上下文 token 预算（估算值）。构造参数显式指定则优先，否则可被 config.json 覆盖 */
  private contextTokenBudget: number;
  private readonly explicitBudget: boolean;
  /** 权限模式 + 由其派生的策略参数（构造参数显式注入时以注入值为准，模式切换不再覆盖） */
  private permissionMode: PermissionMode = 'full';
  private readonly manualPolicy: boolean;
  private allowedPermissions: Permission[] | undefined;
  private forceApprovalPermissions: Permission[] | undefined;
  /** 当前 provider 保存过的模型列表（设置页维护，输入框下拉消费） */
  private models: string[] = [];
  /** 当前 provider 保存的 baseUrl（设置页回填） */
  private savedBaseUrl: string | null = null;
  private readonly pluginRegistryUrl: string;

  private readonly store: SessionStore;
  private activeSessionId: string | null = null;
  /** key: sessionId —— v0.2 起支持多会话并行循环 */
  private readonly running = new Map<string, RunningLoop>();
  private messageCounter = 0;
  /** 每个服务实例的随机前缀：多窗口/多实例下 messageId 也不会撞号 */
  private readonly sessionPrefix = Math.random().toString(36).slice(2, 8);
  /** key: `${messageId}:${toolCallId}`，value: 挂起中的审批 resolve */
  private readonly pendingApprovals = new Map<string, (r: ApprovalResolution) => void>();
  /** 正在执行工具（含等待审批）的插件名，卸载前检查 */
  private readonly pluginsInUse = new Set<string>();
  /** 插件设置缓存（key: 插件名） */
  private readonly settingsCache = new Map<string, Record<string, unknown>>();
  private mcp: McpManager;

  constructor(opts: AgentServiceOptions) {
    this.appDir = opts.appDir;
    this.pushEvent = opts.pushEvent;
    this.maxIterations = opts.maxIterations ?? 15;
    this.explicitBudget = typeof opts.contextTokenBudget === 'number';
    this.contextTokenBudget = opts.contextTokenBudget ?? 24_000;
    this.manualPolicy = opts.allowedPermissions !== undefined || opts.forceApprovalPermissions !== undefined;
    this.allowedPermissions = opts.allowedPermissions;
    this.forceApprovalPermissions = opts.forceApprovalPermissions;
    this.applyPolicy();
    this.pluginRegistryUrl = opts.pluginRegistryUrl ?? DEFAULT_REGISTRY_URL;
    this.provider = opts.initialProvider ?? null;
    this.store = new SessionStore(path.join(this.appDir, 'sessions'));
    this.mcp = new McpManager(this.registry, (channel, payload) => {
      this.pushEvent(channel as PushChannel, payload);
    }, this.appDir);
  }

  /** 启动初始化：读配置 → 建 Provider → 加载插件 → 会话存储 → MCP → 推送首帧 */
  async init(): Promise<void> {
    let cfg: Record<string, unknown> = {};
    const cfgPath = path.join(this.appDir, 'config.json');
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
      } catch {
        cfg = {}; // 配置损坏 = 未配置，等 UI 重新 set-model-config
      }
      // Provider 只在未注入时从配置创建；策略字段（权限模式/预算/模型列表）无论如何都要加载
      if (!this.provider) {
        try {
          this.provider = createProvider(cfg as unknown as ProviderConfig);
        } catch {
          // 配置不完整 = 未配置，等 UI 重新 set-model-config
        }
      }
    }
    // config.json 可覆盖的运行时策略（构造参数显式指定的优先）
    if (!this.explicitBudget && typeof cfg.contextTokenBudget === 'number' && cfg.contextTokenBudget > 0) {
      this.contextTokenBudget = cfg.contextTokenBudget;
    }
    if (typeof cfg.permissionMode === 'string' && PERMISSION_MODES.includes(cfg.permissionMode as PermissionMode)) {
      this.permissionMode = cfg.permissionMode as PermissionMode;
      this.applyPolicy();
    }
    if (!this.manualPolicy && typeof cfg.maxIterations === 'number' && cfg.maxIterations >= 1 && cfg.maxIterations <= 100) {
      this.maxIterations = cfg.maxIterations;
    }
    if (Array.isArray(cfg.models)) {
      this.models = (cfg.models as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim());
    }
    if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) {
      this.savedBaseUrl = cfg.baseUrl.trim();
    }
    await loadPluginsFromRoot(path.join(this.appDir, 'plugins'), this.registry);
    await this.store.init();
    if (this.store.list().length === 0) {
      await this.store.create('默认会话');
    }
    this.activeSessionId = this.store.list()[0].id;
    await this.mcp.init();
    this.pushEvent('plugins-changed', { plugins: this.snapshot() });
    this.pushEvent('sessions-changed', { sessions: this.store.list() });
    this.pushEvent('mcp-status-changed', { servers: this.mcp.status() });
  }

  /** 进程退出前调用：断开全部 MCP server */
  async shutdown(): Promise<void> {
    await this.mcp.shutdown();
  }

  // ---------- 会话（协议 §3.9-3.12） ----------

  /** §3.9 list-sessions */
  listSessions(): IpcResult<{ sessions: SessionMetaDTO[] }> {
    return { ok: true, data: { sessions: this.store.list() } };
  }

  /** §3.10 create-session */
  async createSession(req: { title?: string }): Promise<IpcResult<{ session: SessionDTO }>> {
    const session = await this.store.create(req?.title);
    this.activeSessionId = session.id;
    this.pushEvent('sessions-changed', { sessions: this.store.list() });
    return { ok: true, data: { session: toSessionDTO(session) } };
  }

  /** §3.11 switch-session：切换并返回完整消息（UI 据此重建聊天区） */
  async switchSession(req: { id: string }): Promise<IpcResult<{ session: SessionDTO }>> {
    const session = this.store.get(req?.id);
    if (!session) return err('E_SESSION_NOT_FOUND', `会话不存在: ${req?.id}`, 'session');
    this.activeSessionId = session.id;
    return { ok: true, data: { session: toSessionDTO(session) } };
  }

  /** §3.12 rename-session */
  async renameSession(req: { id: string; title: string }): Promise<IpcResult<null>> {
    const session = this.store.get(req?.id);
    if (!session) return err('E_SESSION_NOT_FOUND', `会话不存在: ${req?.id}`, 'session');
    if (typeof req.title !== 'string' || !req.title.trim()) {
      return err('E_INVALID_CONFIG', 'title 不能为空', 'session');
    }
    await this.store.setTitle(req.id, req.title);
    this.pushEvent('sessions-changed', { sessions: this.store.list() });
    return { ok: true, data: null };
  }

  /** §3.13 delete-session：进行中的会话拒绝删除 */
  async deleteSession(req: { id: string }): Promise<IpcResult<null>> {
    const id = req?.id;
    if (!this.store.get(id)) return err('E_SESSION_NOT_FOUND', `会话不存在: ${id}`, 'session');
    if (this.running.has(id)) {
      return err('E_SESSION_IN_USE', '该会话有正在进行的任务，请先停止再删除', 'session');
    }
    await this.store.remove(id);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.store.list()[0]?.id ?? null;
      if (!this.activeSessionId) {
        const created = await this.store.create('默认会话');
        this.activeSessionId = created.id;
      }
    }
    this.pushEvent('sessions-changed', { sessions: this.store.list() });
    return { ok: true, data: null };
  }

  // ---------- UI → 主进程（协议 §3） ----------

  /** §3.1 send-message（v0.2 起带可选 sessionId，缺省用当前活跃会话） */
  sendMessage(req: { message: ChatMessage; sessionId?: string }): IpcResult<{ messageId: string }> {
    const msg = req?.message;
    if (!msg || msg.role !== 'user' || typeof msg.content !== 'string' || !msg.content.trim()) {
      return err('E_INVALID_MESSAGE', 'message 必须是 role 为 user 且 content 非空的消息', 'receive');
    }
    const sid = req.sessionId ?? this.activeSessionId;
    const session = sid ? this.store.get(sid) : undefined;
    if (!session) {
      return err('E_SESSION_NOT_FOUND', `会话不存在: ${sid}`, 'session');
    }
    if (this.running.has(session.id)) {
      return err('E_LOOP_BUSY', '该会话上一轮循环尚未结束', 'receive');
    }
    if (!this.provider) {
      return err('E_PROVIDER_NOT_CONFIGURED', '尚未配置 LLM Provider，请先调用 set-model-config', 'llm');
    }
    const messageId = `${this.sessionPrefix}-m${++this.messageCounter}`;
    this.running.set(session.id, { messageId, abort: new AbortController(), partialContent: '' });
    // 异步启动循环：立即返回 messageId，结果全部走推送通道
    void this.runLoopTask(session.id, msg.content);
    return { ok: true, data: { messageId } };
  }

  /** §3.2 approve-tool */
  approveTool(req: { messageId: string; toolCallId: string; arguments?: Record<string, unknown> }): IpcResult<null> {
    const key = `${req?.messageId}:${req?.toolCallId}`;
    const resolve = this.pendingApprovals.get(key);
    if (!resolve) {
      return err('E_NO_PENDING_APPROVAL', `没有待审批的工具调用 ${req?.toolCallId}`, 'approval');
    }
    this.pendingApprovals.delete(key);
    void this.appendAudit({ type: 'approval', decision: 'approved', messageId: req.messageId, toolCallId: req.toolCallId });
    resolve(req.arguments ? { decision: 'approved', arguments: req.arguments } : 'approved');
    return { ok: true, data: null };
  }

  /** §3.3 reject-tool */
  rejectTool(req: { messageId: string; toolCallId: string; reason?: string }): IpcResult<null> {
    const key = `${req?.messageId}:${req?.toolCallId}`;
    const resolve = this.pendingApprovals.get(key);
    if (!resolve) {
      return err('E_NO_PENDING_APPROVAL', `没有待审批的工具调用 ${req?.toolCallId}`, 'approval');
    }
    this.pendingApprovals.delete(key);
    void this.appendAudit({ type: 'approval', decision: 'rejected', messageId: req.messageId, toolCallId: req.toolCallId, reason: req.reason });
    resolve(req.reason ? { decision: 'rejected', reason: req.reason } : 'rejected');
    return { ok: true, data: null };
  }

  /** §3.4 stop：幂等，中断当前所有会话的循环 */
  stop(): IpcResult<null> {
    if (this.running.size === 0) return { ok: true, data: null };
    for (const [sid, running] of this.running) {
      for (const [key, resolve] of this.pendingApprovals) {
        if (key.startsWith(`${running.messageId}:`)) {
          resolve('rejected');
          this.pendingApprovals.delete(key);
        }
      }
      running.abort.abort();
      void this.appendAudit({ type: 'stop', sessionId: sid, messageId: running.messageId });
    }
    return { ok: true, data: null };
  }

  /** §3.5 list-plugins */
  listPlugins(): IpcResult<{ plugins: PluginInfo[] }> {
    return { ok: true, data: { plugins: this.snapshot() } };
  }

  /** §3.14 list-providers：返回注册表元信息，UI 动态渲染 */
  listProviders(): IpcResult<{ providers: ReturnType<typeof listProviderMetas> }> {
    return { ok: true, data: { providers: listProviderMetas() } };
  }

  /** §3.6 install-plugin：校验 → 复制到 plugins/user/ → 注册（同名 = 热更新） */
  async installPlugin(req: { pluginDir: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    const sourceDir = req?.pluginDir;
    if (!sourceDir || !existsSync(sourceDir) || !(await stat(sourceDir)).isDirectory()) {
      return err('E_PATH_NOT_FOUND', `目录不存在: ${sourceDir}`, 'unknown');
    }
    let plugin: Plugin;
    try {
      plugin = await loadPluginFromDir(sourceDir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isValidation = message.includes('manifest') || message.includes('协议版本');
      return err(
        isValidation ? 'E_PLUGIN_VALIDATION_FAILED' : 'E_PLUGIN_LOAD_FAILED',
        `插件加载失败: ${message}`,
        'unknown',
      );
    }
    const name = plugin.manifest.name;
    // 热更新：先注销旧版本
    if (this.registry.listPlugins().some((p) => p.manifest.name === name)) {
      this.registry.unregister(name);
    }
    // 源目录不在插件根目录下时，复制一份到 plugins/user/（内置目录只读）
    const pluginsRoot = path.resolve(this.appDir, 'plugins');
    if (!path.resolve(sourceDir).startsWith(pluginsRoot)) {
      const target = path.join(pluginsRoot, 'user', name);
      await rm(target, { recursive: true, force: true });
      await cp(sourceDir, target, { recursive: true });
    }
    this.registry.register(plugin);
    try {
      await plugin.onInstall?.();
    } catch {
      // 生命周期钩子失败不影响安装主流程
    }
    this.pushEvent('plugins-changed', { plugins: this.snapshot() });
    return { ok: true, data: { plugin: toPluginInfo(plugin) } };
  }

  /** §3.15 install-plugin-from-registry：从注册表索引下载安装（sha256 校验） */
  async installPluginFromRegistry(req: { name: string; registryUrl?: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    const name = req?.name;
    if (typeof name !== 'string' || !name.trim()) {
      return err('E_PLUGIN_NOT_IN_REGISTRY', '缺少插件名', 'unknown');
    }
    let entries: Array<Record<string, unknown>>;
    try {
      const res = await fetch(req.registryUrl ?? this.pluginRegistryUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      entries = (body?.plugins ?? []) as Array<Record<string, unknown>>;
    } catch (e) {
      return err('E_REGISTRY_FETCH_FAILED', `注册表获取失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
    }
    const entry = entries.filter((x) => x.name === name).sort((a, b) => String(b.version).localeCompare(String(a.version)))[0];
    if (!entry) {
      return err('E_PLUGIN_NOT_IN_REGISTRY', `注册表中没有插件: ${name}`, 'unknown');
    }
    let zipBuf: ArrayBuffer;
    try {
      const res = await fetch(String(entry.downloadUrl));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      zipBuf = await res.arrayBuffer();
    } catch (e) {
      return err('E_REGISTRY_FETCH_FAILED', `插件包下载失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
    }
    const digest = createHash('sha256').update(Buffer.from(zipBuf)).digest('hex');
    if (entry.sha256 && digest !== String(entry.sha256)) {
      return err('E_CHECKSUM_MISMATCH', '插件包 sha256 与注册表不符，已中止安装', 'unknown');
    }
    // 解压到临时目录后走标准安装路径（校验 → 复制 → 注册）
    const tmp = await mkdtemp(path.join(tmpdir(), 'agent-base-registry-'));
    try {
      const zip = new AdmZip(Buffer.from(zipBuf));
      zip.extractAllTo(tmp, true);
      // zip 根若包了一层目录，往下钻一层找 manifest.json
      const dir = existsSync(path.join(tmp, 'manifest.json'))
        ? tmp
        : (await findDirWithManifest(tmp)) ?? tmp;
      return await this.installPlugin({ pluginDir: dir });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** §3.7 uninstall-plugin：正在执行时拒绝；内置插件拒绝 */
  async uninstallPlugin(req: { name: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    const name = req?.name;
    const plugin = this.registry.listPlugins().find((p) => p.manifest.name === name);
    if (!plugin) {
      return err('E_PLUGIN_NOT_FOUND', `插件不存在: ${name}`, 'unknown');
    }
    if (this.pluginsInUse.has(name)) {
      return err('E_PLUGIN_IN_USE', `插件 ${name} 的工具正在执行，暂不可卸载`, 'unknown');
    }
    // 内置插件只读：随仓库分发，卸载后重启会回来，直接拒绝
    if (existsSync(path.join(this.appDir, 'plugins', 'builtin', name))) {
      return err('E_PLUGIN_BUILTIN', `插件 ${name} 是内置插件，不允许卸载`, 'unknown');
    }
    const info = toPluginInfo(plugin);
    try {
      await plugin.onUninstall?.();
    } catch {
      // 生命周期钩子失败不影响卸载主流程
    }
    this.registry.unregister(name);
    const pluginsRoot = path.resolve(this.appDir, 'plugins');
    // 只允许删除插件根目录下的用户插件文件夹（安全边界）
    const dir = path.join(pluginsRoot, 'user', name);
    if (dir.startsWith(pluginsRoot) && existsSync(dir)) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        // 文件删除失败不阻塞注销，但如实报告
        return err('E_PLUGIN_UNINSTALL_FAILED', `删除插件文件失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
      }
    }
    this.pushEvent('plugins-changed', { plugins: this.snapshot() });
    return { ok: true, data: { plugin: info } };
  }

  /** §3.8 set-model-config：立即生效（新循环）+ 持久化到 config.json */
  async setModelConfig(req: { config: Record<string, unknown> }): Promise<IpcResult<null>> {
    const cfg = req?.config;
    const providerId = cfg?.provider;
    if (typeof providerId !== 'string' || !listProviderMetas().some((p) => p.id === providerId)) {
      return err('E_PROVIDER_UNSUPPORTED', `不支持的 provider: ${providerId}`, 'llm');
    }
    // 读旧配置：① 切模型（不重填 Key）时回填已存 Key；② 维护模型列表
    const cfgPath = path.join(this.appDir, 'config.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        existing = JSON.parse(await readFile(cfgPath, 'utf-8'));
      } catch {
        existing = {};
      }
    }
    let apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (!apiKey) {
      const sameProvider = existing.provider === providerId;
      const existingKey = typeof existing.apiKey === 'string' ? existing.apiKey.trim() : '';
      if (sameProvider && existingKey) {
        apiKey = existingKey; // 同 provider 切换模型/地址：复用已保存的 Key
      } else {
        return err('E_INVALID_CONFIG', '缺少 apiKey', 'llm');
      }
    }
    // 模型列表：models 数组（设置页维护）优先；单改 model 时同步进列表
    const models = Array.isArray(cfg.models)
      ? (cfg.models as unknown[]).filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim())
      : undefined;
    const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : models?.[0];
    try {
      this.provider = createProvider({
        provider: providerId,
        apiKey,
        model,
        baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
        maxTokens: typeof cfg.maxTokens === 'number' ? cfg.maxTokens : undefined,
      });
    } catch (e) {
      return err('E_INVALID_CONFIG', `配置无效: ${e instanceof Error ? e.message : String(e)}`, 'llm');
    }
    if (models) this.models = models;
    else if (model && !this.models.includes(model)) {
      this.models = [...(this.models.length ? this.models : []), model].slice(-8);
    } else if (model) {
      this.models = [model, ...this.models.filter((m) => m !== model)];
    }
    if (typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim()) this.savedBaseUrl = cfg.baseUrl.trim();
    // 读改写：保留文件里与 provider 无关的策略字段（contextTokenBudget / 权限等）
    const persist = {
      ...existing,
      provider: providerId,
      apiKey,
      model,
      models: this.models.length ? this.models : undefined,
      baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
      maxTokens: typeof cfg.maxTokens === 'number' ? cfg.maxTokens : undefined,
    };
    try {
      await writeFile(cfgPath, JSON.stringify(persist, null, 2), 'utf-8');
    } catch {
      // 持久化失败不影响本轮使用，重启后需重新配置
    }
    return { ok: true, data: null };
  }

  // ---------- MCP（协议 §3.16-3.18） ----------

  /** §3.16 list-mcp-servers */
  async listMcpServers(): Promise<IpcResult<{ servers: McpServerStatus[]; config: Record<string, McpServerConfig> }>> {
    let config: Record<string, McpServerConfig> = {};
    try {
      config = await this.mcp.readConfig();
    } catch {
      config = {};
    }
    return { ok: true, data: { servers: this.mcp.status(), config } };
  }

  /** §3.17 set-mcp-config：全量替换 mcp.json 并重连 */
  async setMcpConfig(req: { config: Record<string, McpServerConfig> }): Promise<IpcResult<null>> {
    try {
      await this.mcp.setConfig(req?.config ?? {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = (e as Error & { code?: string }).code === 'E_MCP_NOT_FOUND' ? 'E_MCP_NOT_FOUND' : 'E_INVALID_CONFIG';
      return err(code, message, 'unknown');
    }
    return { ok: true, data: null };
  }

  /** §3.18 toggle-mcp-server */
  async toggleMcpServer(req: { name: string; enabled: boolean }): Promise<IpcResult<null>> {
    try {
      await this.mcp.toggleServer(req?.name, !!req?.enabled);
    } catch (e) {
      const code = (e as Error & { code?: string }).code === 'E_MCP_NOT_FOUND' ? 'E_MCP_NOT_FOUND' : 'E_INVALID_CONFIG';
      return err(code, e instanceof Error ? e.message : String(e), 'unknown');
    }
    return { ok: true, data: null };
  }

  // ---------- 策略与应用信息（协议 §3.22-3.24） ----------

  /** 由权限模式派生策略参数；构造参数显式注入的（测试/嵌入场景）不被覆盖 */
  private applyPolicy(): void {
    if (this.manualPolicy) return;
    const preset = POLICY_PRESETS[this.permissionMode];
    this.allowedPermissions = preset.allowed;
    this.forceApprovalPermissions = preset.force.length ? preset.force : undefined;
  }

  /** §3.22 set-agent-policy：权限模式 / 最大迭代数，立即生效并持久化 */
  async setAgentPolicy(req: { permissionMode?: PermissionMode; maxIterations?: number }): Promise<IpcResult<null>> {
    const mode = req?.permissionMode;
    if (mode !== undefined) {
      if (!PERMISSION_MODES.includes(mode)) {
        return err('E_INVALID_CONFIG', `未知权限模式: ${mode}`, 'unknown');
      }
      this.permissionMode = mode;
      this.applyPolicy();
    }
    const iters = req?.maxIterations;
    if (iters !== undefined) {
      if (typeof iters !== 'number' || iters < 1 || iters > 100 || !Number.isInteger(iters)) {
        return err('E_INVALID_CONFIG', 'maxIterations 必须是 1-100 的整数', 'unknown');
      }
      if (!this.manualPolicy) this.maxIterations = iters;
    }
    try {
      const cfgPath = path.join(this.appDir, 'config.json');
      let existing: Record<string, unknown> = {};
      if (existsSync(cfgPath)) {
        try {
          existing = JSON.parse(await readFile(cfgPath, 'utf-8'));
        } catch {
          existing = {};
        }
      }
      await writeFile(cfgPath, JSON.stringify({
        ...existing,
        permissionMode: this.permissionMode,
        maxIterations: this.manualPolicy ? existing.maxIterations : this.maxIterations,
      }, null, 2), 'utf-8');
    } catch {
      // 持久化失败不影响本轮生效
    }
    return { ok: true, data: null };
  }

  /** §3.23 get-app-info：设置页与输入框下拉的一次性数据源 */
  getAppInfo(): IpcResult<{ info: AppInfo }> {
    const info: AppInfo = {
      version: APP_VERSION,
      appDir: this.appDir,
      provider: this.provider?.id ?? null,
      model: this.models[0] ?? null,
      models: [...this.models],
      baseUrl: this.savedBaseUrl,
      permissionMode: this.permissionMode,
      maxIterations: this.maxIterations,
      sessionCount: this.store.list().length,
      pluginCount: this.registry.listPlugins().length,
      mcpCount: this.mcp.status().filter((s) => s.state === 'connected').length,
    };
    return { ok: true, data: { info } };
  }

  /** §3.24 read-audit：审计日志尾部（右侧「审计」标签页） */
  async readAudit(req: { lines?: number }): Promise<IpcResult<{ lines: string[]; total: number }>> {
    const max = Math.min(Math.max(req?.lines ?? 200, 1), 1000);
    const file = path.join(this.appDir, 'audit.log');
    if (!existsSync(file)) return { ok: true, data: { lines: [], total: 0 } };
    try {
      const raw = await readFile(file, 'utf-8');
      const all = raw.split('\n').filter((l) => l.trim());
      return { ok: true, data: { lines: all.slice(-max), total: all.length } };
    } catch (e) {
      return err('E_INTERNAL', `读取审计日志失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
    }
  }

  // ---------- 插件设置（富插件协议 v2） ----------

  /** 读取插件设置值（注入 ToolContext.settings；文件：plugins/settings/<name>.json） */
  getPluginSettings(name: string): Record<string, unknown> | undefined {
    if (this.settingsCache.has(name)) return this.settingsCache.get(name);
    const file = path.join(this.appDir, 'plugins', 'settings', `${sanitizeName(name)}.json`);
    if (!existsSync(file)) return undefined;
    try {
      // 同步读：execute 前注入，量小且低频
      const values = JSON.parse(readFileSync(file, 'utf-8'));
      this.settingsCache.set(name, values);
      return values;
    } catch {
      return undefined;
    }
  }

  /** §3.19 get-plugin-settings：返回 schema（manifest.settings）+ 当前值 */
  async getPluginSettingsInfo(req: { name: string }): Promise<IpcResult<{ schema: Record<string, unknown> | null; values: Record<string, unknown> | null }>> {
    const plugin = this.registry.listPlugins().find((p) => p.manifest.name === req?.name);
    if (!plugin) return err('E_PLUGIN_NOT_FOUND', `插件不存在: ${req?.name}`, 'unknown');
    const values = this.getPluginSettings(req.name) ?? null;
    return { ok: true, data: { schema: plugin.manifest.settings ?? null, values } };
  }

  /** §3.20 set-plugin-settings：落盘并失效缓存 */
  async setPluginSettings(req: { name: string; values: Record<string, unknown> }): Promise<IpcResult<null>> {
    const plugin = this.registry.listPlugins().find((p) => p.manifest.name === req?.name);
    if (!plugin) return err('E_PLUGIN_NOT_FOUND', `插件不存在: ${req?.name}`, 'unknown');
    const dir = path.join(this.appDir, 'plugins', 'settings');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${sanitizeName(req.name)}.json`), JSON.stringify(req.values ?? {}, null, 2), 'utf-8');
    this.settingsCache.set(req.name, req.values ?? {});
    return { ok: true, data: null };
  }

  // ---------- 内部：循环任务与事件映射 ----------

  private async runLoopTask(sessionId: string, userMessage: string): Promise<void> {
    const running = this.running.get(sessionId)!;
    const session = this.store.get(sessionId)!;
    try {
      const result = await runLoop({
        provider: this.provider!,
        registry: this.registry,
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        history: session.messages,
        workingDir: this.appDir,
        contextTokenBudget: this.contextTokenBudget,
        options: {
          maxIterations: this.maxIterations,
          signal: running.abort.signal,
          allowedPermissions: this.allowedPermissions,
          forceApprovalPermissions: this.forceApprovalPermissions,
          pluginSettings: (name) => this.getPluginSettings(name),
          onChunk: (delta) => {
            running.partialContent += delta;
            this.pushEvent('message-chunk', { messageId: running.messageId, sessionId, role: 'assistant', delta });
          },
          onEvent: (e) => this.onLoopEvent(sessionId, running.messageId, e),
          requestApproval: (call) =>
            new Promise<ApprovalResolution>((resolve) => {
              this.pendingApprovals.set(`${running.messageId}:${call.id}`, resolve);
            }),
        },
      });
      // 全量历史（含本轮）持久化
      await this.store.replaceMessages(sessionId, result.history);
      void this.maybeAutoTitle(sessionId);
    } catch (e) {
      if (running.abort.signal.aborted) {
        // 用户主动 stop() → loop-done(stopped)
        this.pushEvent('loop-done', { messageId: running.messageId, sessionId, content: running.partialContent, stopped: true });
      } else {
        const code = e instanceof AgentLoopError ? e.code : 'E_INTERNAL';
        const message = e instanceof Error ? e.message : String(e);
        this.pushEvent('loop-error', { messageId: running.messageId, sessionId, error: { code, message, phase: 'unknown' } });
      }
    } finally {
      for (const key of this.pendingApprovals.keys()) {
        if (key.startsWith(`${running.messageId}:`)) this.pendingApprovals.delete(key);
      }
      this.running.delete(sessionId);
    }
  }

  /** 首轮对话后自动起标题（假模型除外——不消费测试队列） */
  private maybeAutoTitle(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session || !this.store.isUntitled(session) || !this.provider || this.provider.id === 'mock') return;
    const firstUser = session.messages.find((m) => m.role === 'user')?.content ?? '';
    const firstAnswer = session.messages.find((m) => m.role === 'assistant' && m.content)?.content ?? '';
    if (!firstUser.trim()) return;
    const prompt = `为下面这段对话生成一个不超过12个字的标题，直接输出标题本身，不要引号、句号或解释：\n用户：${firstUser.slice(0, 500)}\n助手：${firstAnswer.slice(0, 300)}`;
    void this.provider
      .chat([{ role: 'user', content: prompt }], [])
      .then(async (res) => {
        const title = res.content.trim().replace(/^["'「『]|["'」』]$/g, '').slice(0, 24);
        await this.store.setTitle(sessionId, title || firstUser.slice(0, 20));
      })
      .catch(async () => {
        await this.store.setTitle(sessionId, firstUser.slice(0, 20));
      })
      .then(() => {
        this.pushEvent('sessions-changed', { sessions: this.store.list() });
      });
  }

  /** LoopEvent → IPC 推送协议的逐条映射（协议 §4）；loop-error 在 runLoopTask 的 catch 里结构化推送 */
  private onLoopEvent(sessionId: string, messageId: string, e: LoopEvent): void {
    switch (e.type) {
      case 'tool-started': {
        const entry = this.registry.getTool(e.call.name);
        if (entry) this.pluginsInUse.add(entry.pluginName);
        this.pushEvent('tool-started', {
          messageId,
          sessionId,
          toolCallId: e.call.id,
          name: e.call.name,
          arguments: e.call.arguments,
        });
        break;
      }
      case 'tool-result': {
        const entry = this.registry.getTool(e.call.name);
        if (entry) this.pluginsInUse.delete(entry.pluginName);
        this.pushEvent('tool-result', {
          messageId,
          sessionId,
          toolCallId: e.call.id,
          result: e.result,
        });
        void this.appendAudit({
          type: 'tool',
          sessionId,
          messageId,
          toolCallId: e.call.id,
          name: e.call.name,
          ok: e.result.ok,
          error: e.result.error,
          args: truncate(e.call.arguments, 300),
          outputChars: e.result.output.length,
        });
        break;
      }
      case 'approval-required':
        this.pushEvent('approval-required', {
          messageId,
          sessionId,
          toolCallId: e.call.id,
          name: e.call.name,
          arguments: e.call.arguments,
          reason: '该工具需要用户批准后执行',
        });
        break;
      case 'loop-done':
        this.pushEvent('loop-done', { messageId, sessionId, content: e.content, stopped: false });
        break;
      case 'loop-error':
        // 循环错误统一由 runLoopTask 的 catch 结构化后推送（code 来自 AgentLoopError），此处忽略
        break;
      case 'assistant-message':
        break; // 文本已走 message-chunk，工具调用由 tool-started 宣告
    }
  }

  private async appendAudit(entry: Record<string, unknown>): Promise<void> {
    try {
      await appendFile(
        path.join(this.appDir, 'audit.log'),
        JSON.stringify({ ts: Date.now(), ...entry }) + '\n',
        'utf-8',
      );
    } catch {
      // 审计日志失败不阻塞业务
    }
  }

  private snapshot(): PluginInfo[] {
    return this.registry.listPlugins().map(toPluginInfo);
  }
}

// ---------- 辅助 ----------

function toSessionDTO(session: Session): SessionDTO {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    messages: session.messages,
  };
}

function toPluginInfo(plugin: Plugin): PluginInfo {
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

function err(code: string, message: string, phase: LoopError['phase']): IpcResult<never> {
  return { ok: false, error: { code, message, phase } };
}

function truncate(value: unknown, max: number): string {
  const s = JSON.stringify(value) ?? '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

async function findDirWithManifest(root: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (existsSync(path.join(dir, 'manifest.json'))) return dir;
  }
  return undefined;
}
