import { cp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
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
import { loadPluginFromDir, loadPluginsFromRoot } from '../plugins/loader.js';
import { createProvider } from '../providers/provider.js';
import { AgentLoopError } from '../core/errors.js';

/** IPC 统一返回包装（协议 §2.2）：handler 永不 throw */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: LoopError };

/** IPC 统一错误结构（协议 §6.1） */
export interface LoopError {
  code: string;
  message: string;
  phase: 'receive' | 'llm' | 'tool' | 'approval' | 'unknown';
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

/** 主进程 → UI 的全部推送通道 */
export type PushChannel =
  | 'message-chunk'
  | 'tool-started'
  | 'tool-result'
  | 'approval-required'
  | 'loop-done'
  | 'loop-error'
  | 'plugins-changed';

export interface AgentServiceOptions {
  /** 项目根目录（config.json 与 plugins/ 所在地） */
  appDir: string;
  /** 推送回调：Electron 里是 webContents.send，测试里是收集器 */
  pushEvent: (channel: PushChannel, payload: unknown) => void;
  /** 测试注入；生产环境从 config.json 构造 */
  initialProvider?: LLMProvider;
  maxIterations?: number;
  /** 运行时权限白名单（undefined = 全部放行） */
  allowedPermissions?: Permission[];
  /** 强制审批的权限列表：命中即必须审批，覆盖插件 requiresApproval 声明 */
  forceApprovalPermissions?: Permission[];
}

const SYSTEM_PROMPT = `你是一个桌面端助手，可以通过提供的工具读写用户电脑上的文件来完成任务。
工具的执行结果会以 tool 消息返回给你。如果工具返回了错误，请如实告知用户，不要虚构结果。`;

interface RunningLoop {
  messageId: string;
  abort: AbortController;
  partialContent: string;
}

/**
 * AgentService：IPC 事件协议的完整业务实现，不含任何 Electron API。
 * Electron main 只做薄薄一层 ipcMain.handle → service 转发；这样全部逻辑可以脱离 GUI 自测。
 */
export class AgentService {
  readonly registry = new ToolRegistry();
  private provider: LLMProvider | null;
  private readonly appDir: string;
  private readonly pushEvent: (channel: PushChannel, payload: unknown) => void;
  private readonly maxIterations: number;
  private readonly allowedPermissions: Permission[] | undefined;
  private readonly forceApprovalPermissions: Permission[] | undefined;
  private history: ChatMessage[] = [];
  private running: RunningLoop | null = null;
  private messageCounter = 0;
  /** 每个服务实例的随机前缀：多窗口/多实例下 messageId 也不会撞号 */
  private readonly sessionPrefix = Math.random().toString(36).slice(2, 8);
  /** key: `${messageId}:${toolCallId}`，value: 挂起中的审批 resolve */
  private readonly pendingApprovals = new Map<string, (r: ApprovalResolution) => void>();
  /** 正在执行工具（含等待审批）的插件名，卸载前检查 */
  private readonly pluginsInUse = new Set<string>();

  constructor(opts: AgentServiceOptions) {
    this.appDir = opts.appDir;
    this.pushEvent = opts.pushEvent;
    this.maxIterations = opts.maxIterations ?? 15;
    this.allowedPermissions = opts.allowedPermissions;
    this.forceApprovalPermissions = opts.forceApprovalPermissions;
    this.provider = opts.initialProvider ?? null;
  }

  /** 启动初始化：读配置 → 建 Provider → 加载插件 → 推送首帧插件列表 */
  async init(): Promise<void> {
    const cfgPath = path.join(this.appDir, 'config.json');
    if (!this.provider && existsSync(cfgPath)) {
      try {
        this.provider = createProvider(JSON.parse(await readFile(cfgPath, 'utf-8')));
      } catch {
        this.provider = null; // 配置损坏 = 未配置，等 UI 重新 set-model-config
      }
    }
    await loadPluginsFromRoot(path.join(this.appDir, 'plugins'), this.registry);
    this.pushEvent('plugins-changed', { plugins: this.snapshot() });
  }

  // ---------- UI → 主进程（协议 §3） ----------

  /** §3.1 send-message */
  sendMessage(req: { message: ChatMessage }): IpcResult<{ messageId: string }> {
    const msg = req?.message;
    if (!msg || msg.role !== 'user' || typeof msg.content !== 'string' || !msg.content.trim()) {
      return err('E_INVALID_MESSAGE', 'message 必须是 role 为 user 且 content 非空的消息', 'receive');
    }
    if (this.running) {
      return err('E_LOOP_BUSY', '上一轮循环尚未结束', 'receive');
    }
    if (!this.provider) {
      return err('E_PROVIDER_NOT_CONFIGURED', '尚未配置 LLM Provider，请先调用 set-model-config', 'llm');
    }
    const messageId = `${this.sessionPrefix}-m${++this.messageCounter}`;
    this.running = { messageId, abort: new AbortController(), partialContent: '' };
    // 异步启动循环：立即返回 messageId，结果全部走推送通道
    void this.runLoopTask(messageId, msg.content);
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
    resolve(req.reason ? { decision: 'rejected', reason: req.reason } : 'rejected');
    return { ok: true, data: null };
  }

  /** §3.4 stop：幂等，没有进行中的循环时静默成功 */
  stop(): IpcResult<null> {
    if (!this.running) return { ok: true, data: null };
    // 先放行所有挂起的审批（拒绝），再中断信号 → 循环在最近检查点终止并推送 loop-done(stopped)
    for (const [key, resolve] of this.pendingApprovals) {
      if (key.startsWith(`${this.running.messageId}:`)) {
        resolve('rejected');
        this.pendingApprovals.delete(key);
      }
    }
    this.running.abort.abort();
    return { ok: true, data: null };
  }

  /** §3.5 list-plugins */
  listPlugins(): IpcResult<{ plugins: PluginInfo[] }> {
    return { ok: true, data: { plugins: this.snapshot() } };
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
      const isValidation = message.includes('manifest');
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
    this.pushEvent('plugins-changed', { plugins: this.snapshot() });
    return { ok: true, data: { plugin: toPluginInfo(plugin) } };
  }

  /** §3.7 uninstall-plugin：正在执行时拒绝 */
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
    if (providerId !== 'deepseek' && providerId !== 'openai' && providerId !== 'anthropic') {
      return err('E_PROVIDER_UNSUPPORTED', `不支持的 provider: ${providerId}`, 'llm');
    }
    if (typeof cfg.apiKey !== 'string' || !cfg.apiKey.trim()) {
      return err('E_INVALID_CONFIG', '缺少 apiKey', 'llm');
    }
    try {
      this.provider = createProvider({
        provider: providerId,
        apiKey: cfg.apiKey,
        model: typeof cfg.model === 'string' ? cfg.model : undefined,
        baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
      });
    } catch (e) {
      return err('E_INVALID_CONFIG', `配置无效: ${e instanceof Error ? e.message : String(e)}`, 'llm');
    }
    // 持久化（temperature/maxTokens v0.1 暂未透传给 API，仅原样保存）
    const persist = {
      provider: providerId,
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    };
    try {
      await writeFile(path.join(this.appDir, 'config.json'), JSON.stringify(persist, null, 2), 'utf-8');
    } catch {
      // 持久化失败不影响本轮使用，重启后需重新配置
    }
    return { ok: true, data: null };
  }

  // ---------- 内部：循环任务与事件映射 ----------

  private async runLoopTask(messageId: string, userMessage: string): Promise<void> {
    const running = this.running!;
    try {
      const result = await runLoop({
        provider: this.provider!,
        registry: this.registry,
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        history: this.history,
        workingDir: this.appDir,
        options: {
          maxIterations: this.maxIterations,
          signal: running.abort.signal,
          allowedPermissions: this.allowedPermissions,
          forceApprovalPermissions: this.forceApprovalPermissions,
          onChunk: (delta) => {
            running.partialContent += delta;
            this.pushEvent('message-chunk', { messageId, role: 'assistant', delta });
          },
          onEvent: (e) => this.onLoopEvent(messageId, e),
          requestApproval: (call) =>
            new Promise<ApprovalResolution>((resolve) => {
              this.pendingApprovals.set(`${messageId}:${call.id}`, resolve);
            }),
        },
      });
      this.history = result.history;
    } catch (e) {
      // 用户主动 stop() → loop-done(stopped)；其余错误 loop 已通过 onEvent 推送 loop-error
      if (running.abort.signal.aborted) {
        this.pushEvent('loop-done', { messageId, content: running.partialContent, stopped: true });
      }
    } finally {
      for (const key of this.pendingApprovals.keys()) {
        if (key.startsWith(`${messageId}:`)) this.pendingApprovals.delete(key);
      }
      if (this.running?.messageId === messageId) this.running = null;
    }
  }

  /** LoopEvent → IPC 推送协议的逐条映射（协议 §4） */
  private onLoopEvent(messageId: string, e: LoopEvent): void {
    switch (e.type) {
      case 'tool-started': {
        const entry = this.registry.getTool(e.call.name);
        if (entry) this.pluginsInUse.add(entry.pluginName);
        this.pushEvent('tool-started', {
          messageId,
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
          toolCallId: e.call.id,
          result: e.result,
        });
        break;
      }
      case 'approval-required':
        this.pushEvent('approval-required', {
          messageId,
          toolCallId: e.call.id,
          name: e.call.name,
          arguments: e.call.arguments,
          reason: '该工具需要用户批准后执行',
        });
        break;
      case 'loop-done':
        this.pushEvent('loop-done', { messageId, content: e.content, stopped: false });
        break;
      case 'loop-error':
        this.pushEvent('loop-error', {
          messageId,
          error: {
            code: e.error.includes('迭代') ? 'E_INTERNAL' : 'E_LLM_ERROR',
            message: e.error,
            phase: e.error.includes('迭代') ? 'unknown' : 'llm',
          },
        });
        break;
      case 'assistant-message':
        break; // 文本已走 message-chunk，工具调用由 tool-started 宣告
    }
  }

  private snapshot(): PluginInfo[] {
    return this.registry.listPlugins().map(toPluginInfo);
  }
}

function toPluginInfo(plugin: Plugin): PluginInfo {
  const m = plugin.manifest;
  return {
    name: m.name,
    version: m.version,
    displayName: m.displayName,
    description: m.description,
    author: m.author,
    permissions: m.permissions,
    tools: plugin.tools.map((t) => t.name),
  };
}

function err(code: string, message: string, phase: LoopError['phase']): IpcResult<never> {
  return { ok: false, error: { code, message, phase } };
}
