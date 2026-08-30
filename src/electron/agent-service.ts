import { ToolRegistry } from '../core/registry.js';
import { runLoop } from '../core/loop.js';
import { AgentLoopError } from '../core/errors.js';
import { estimateMessageTokens } from '../core/context.js';
import { isMessageContent, type MessageContent } from '../types.js';
import type { ChatMessage, LoopEvent } from '../types.js';
import type { McpServerConfig, McpServerStatus } from '../mcp/manager.js';
import type { ProviderMeta } from '../providers/registry.js';
import { SessionService } from './services/session-service.js';
import { McpService } from './services/mcp-service.js';
import { ModelPolicyService } from './services/model-policy-service.js';
import { ApprovalAuditService } from './services/approval-audit-service.js';
import { WorkspaceService } from './services/workspace-service.js';
import { SubagentRunner } from './services/subagent-runner.js';
import { PluginService } from './services/plugin-service.js';
import { DEFAULT_REGISTRY_URL, err } from './types.js';
import type { IpcResult, LoopError, PluginInfo, SessionMetaDTO, SessionDTO, PermissionMode, AppInfo, PushChannel, AgentServiceOptions, RunningLoop } from './types.js';
export type { IpcResult, LoopError, PluginInfo, SessionMetaDTO, SessionDTO, PermissionMode, AppInfo, PushChannel, AgentServiceOptions, RunningLoop } from './types.js';
export { PERMISSION_MODES, POLICY_PRESETS, SYSTEM_PROMPT, DEFAULT_REGISTRY_URL, APP_VERSION } from './types.js';
export class AgentService {
  readonly registry = new ToolRegistry();
  private readonly appDir: string;
  private readonly pushEvent: (channel: PushChannel, payload: unknown) => void;
  private readonly policy: ModelPolicyService;
  private readonly plugins: PluginService;
  private readonly sessions: SessionService;
  private readonly running = new Map<string, RunningLoop>();
  private messageCounter = 0;
  private readonly sessionPrefix = Math.random().toString(36).slice(2, 8);
  private readonly queues = new Map<string, MessageContent[]>();
  private readonly mcpService: McpService;
  private readonly audits: ApprovalAuditService;
  private readonly workspace: WorkspaceService;
  private readonly subagents: SubagentRunner;
  constructor(opts: AgentServiceOptions) {
    this.appDir = opts.appDir;
    this.pushEvent = opts.pushEvent;
    this.policy = new ModelPolicyService({
      appDir: opts.appDir,
      initialProvider: opts.initialProvider,
      maxIterations: opts.maxIterations,
      contextTokenBudget: opts.contextTokenBudget,
      allowedPermissions: opts.allowedPermissions,
      forceApprovalPermissions: opts.forceApprovalPermissions,
    });
    this.sessions = new SessionService(this.appDir, () => this.policy.getRuntimeState().provider, this.pushEvent);
    this.mcpService = new McpService(this.registry, this.pushEvent, this.appDir);
    this.audits = new ApprovalAuditService(this.appDir);
    this.workspace = new WorkspaceService(this.appDir, () => this.policy.getRuntimeState().contextTokenBudget);
    this.plugins = new PluginService(this.registry, this.appDir, this.pushEvent, opts.pluginRegistryUrl ?? DEFAULT_REGISTRY_URL);
    this.subagents = new SubagentRunner({
      registry: this.registry,
      getProvider: () => this.policy.getRuntimeState().provider,
      getSystemPrompt: () => this.workspace.buildSystemPrompt(),
      getPolicy: () => this.policy.getRuntimeState(),
      getPluginSettings: (name) => this.plugins.getPluginSettings(name),
      approvals: this.audits,
      getAbortSignal: (sid) => this.running.get(sid)?.abort.signal,
      workingDir: this.appDir,
      onLoopEvent: (sid, mid, e) => this.onLoopEvent(sid, mid, e),
    });
  }
  async init(): Promise<void> {
    await this.policy.loadConfig();
    this.subagents.registerTool();
    await this.plugins.loadPlugins();
    await this.sessions.init();
    await this.mcpService.init();
    this.pushEvent('plugins-changed', { plugins: this.plugins.snapshot() });
    this.pushEvent('sessions-changed', { sessions: this.sessions.list() });
    this.pushEvent('mcp-status-changed', { servers: this.mcpService.status() });
  }
  async shutdown(): Promise<void> {
    await this.mcpService.shutdown();
  }
  listSessions(): IpcResult<{ sessions: SessionMetaDTO[] }> {
    return this.sessions.listResult();
  }
  createSession(req: { title?: string }): Promise<IpcResult<{ session: SessionDTO }>> {
    return this.sessions.createSession(req?.title);
  }
  switchSession(req: { id: string }): Promise<IpcResult<{ session: SessionDTO }>> {
    return this.sessions.switchSession(req?.id);
  }
  renameSession(req: { id: string; title: string }): Promise<IpcResult<null>> {
    return this.sessions.renameSession(req);
  }
  async deleteSession(req: { id: string }): Promise<IpcResult<null>> {
    const id = req?.id;
    if (!this.sessions.get(id)) return err('E_SESSION_NOT_FOUND', `会话不存在: ${id}`, 'session');
    if (this.running.has(id)) return err('E_SESSION_IN_USE', '该会话有正在进行的任务，请先停止再删除', 'session');
    this.queues.delete(id);
    await this.sessions.removeAndRepairActive(id);
    this.pushEvent('sessions-changed', { sessions: this.sessions.list() });
    return { ok: true, data: null };
  }
  sendMessage(req: { message: ChatMessage; sessionId?: string; contextFiles?: string[] }): IpcResult<{ messageId: string; queued?: boolean }> {
    const msg = req?.message;
    const hasText = typeof msg?.content === 'string' && !!msg.content.trim();
    const hasParts = Array.isArray(msg?.content) && isMessageContent(msg?.content);
    if (!msg || msg.role !== 'user' || (!hasText && !hasParts)) {
      return err('E_INVALID_MESSAGE', 'message 必须是 role 为 user 且内容非空的消息', 'receive');
    }
    const sid = req.sessionId ?? this.sessions.getActiveId();
    const session = sid ? this.sessions.get(sid) : undefined;
    if (!session) return err('E_SESSION_NOT_FOUND', `会话不存在: ${sid}`, 'session');
    if (!this.policy.getRuntimeState().provider) return err('E_PROVIDER_NOT_CONFIGURED', '尚未配置 LLM Provider，请先调用 set-model-config', 'llm');
    let content: MessageContent = msg.content;
    const files = (Array.isArray(req.contextFiles) ? req.contextFiles : []).filter((f): f is string => typeof f === 'string' && !!f.trim()).slice(0, 5);
    if (files.length) content = this.workspace.injectContextFiles(content, files);
    const messageId = `${this.sessionPrefix}-m${++this.messageCounter}`;
    if (this.running.has(session.id)) {
      const q = this.queues.get(session.id) ?? [];
      q.push(content);
      this.queues.set(session.id, q);
      return { ok: true, data: { messageId, queued: true } };
    }
    this.startLoop(session.id, content, messageId);
    return { ok: true, data: { messageId } };
  }
  approveTool(req: { messageId: string; toolCallId: string; arguments?: Record<string, unknown> }): IpcResult<null> {
    if (!this.audits.resolveApproval(req?.messageId, req?.toolCallId, req.arguments ? { decision: 'approved', arguments: req.arguments } : 'approved')) {
      return err('E_NO_PENDING_APPROVAL', `没有待审批的工具调用 ${req?.toolCallId}`, 'approval');
    }
    void this.audits.appendAudit({ type: 'approval', decision: 'approved', messageId: req.messageId, toolCallId: req.toolCallId });
    return { ok: true, data: null };
  }
  rejectTool(req: { messageId: string; toolCallId: string; reason?: string }): IpcResult<null> {
    if (!this.audits.resolveApproval(req?.messageId, req?.toolCallId, req.reason ? { decision: 'rejected', reason: req.reason } : 'rejected')) {
      return err('E_NO_PENDING_APPROVAL', `没有待审批的工具调用 ${req?.toolCallId}`, 'approval');
    }
    void this.audits.appendAudit({ type: 'approval', decision: 'rejected', messageId: req.messageId, toolCallId: req.toolCallId, reason: req.reason });
    return { ok: true, data: null };
  }
  stop(): IpcResult<null> {
    if (this.running.size === 0) return { ok: true, data: null };
    for (const [sid, running] of this.running) {
      this.audits.rejectAll(running.messageId);
      running.abort.abort();
      this.queues.delete(sid);
      void this.audits.appendAudit({ type: 'stop', sessionId: sid, messageId: running.messageId });
    }
    return { ok: true, data: null };
  }
  previewFile(req: { path: string }): Promise<IpcResult<{ exists: boolean; content: string }>> {
    return this.workspace.previewFile(req);
  }
  listPlugins(): IpcResult<{ plugins: PluginInfo[] }> {
    return this.plugins.listPlugins();
  }
  listProviders(): IpcResult<{ providers: ProviderMeta[] }> {
    return this.policy.listProviders();
  }
  installPlugin(req: { pluginDir: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    return this.plugins.installPlugin(req);
  }
  installPluginFromRegistry(req: { name: string; registryUrl?: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    return this.plugins.installPluginFromRegistry(req);
  }
  uninstallPlugin(req: { name: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    return this.plugins.uninstallPlugin(req);
  }
  setModelConfig(req: { config: Record<string, unknown> }): Promise<IpcResult<null>> {
    return this.policy.setModelConfig(req);
  }
  listMcpServers(): Promise<IpcResult<{ servers: McpServerStatus[]; config: Record<string, McpServerConfig> }>> {
    return this.mcpService.listMcpServers();
  }
  setMcpConfig(req: { config: Record<string, McpServerConfig> }): Promise<IpcResult<null>> {
    return this.mcpService.setMcpConfig(req);
  }
  toggleMcpServer(req: { name: string; enabled: boolean }): Promise<IpcResult<null>> {
    return this.mcpService.toggleMcpServer(req);
  }
  setAgentPolicy(req: { permissionMode?: PermissionMode; maxIterations?: number; reasoningEffort?: 'low' | 'medium' | 'high' }): Promise<IpcResult<null>> {
    return this.policy.setAgentPolicy(req);
  }
  getAppInfo(): IpcResult<{ info: AppInfo }> {
    return this.policy.getAppInfo(
      this.appDir,
      this.sessions.list().length,
      this.registry.listPlugins().length,
      this.mcpService.status().filter((s) => s.state === 'connected').length,
    );
  }
  readAudit(req: { lines?: number }): Promise<IpcResult<{ lines: string[]; total: number }>> {
    return this.audits.readAudit(req);
  }
  listWorkspaceFiles(req: { query?: string }): Promise<IpcResult<{ files: Array<{ name: string; rel: string; isDir: boolean }> }>> {
    return this.workspace.listWorkspaceFiles(req);
  }
  readAttachment(req: { path: string }): Promise<IpcResult<{ name: string; kind: 'image' | 'text'; mediaType: string; data?: string; text?: string }>> {
    return this.workspace.readAttachment(req);
  }
  getPluginSettings(name: string): Record<string, unknown> | undefined {
    return this.plugins.getPluginSettings(name);
  }
  getPluginSettingsInfo(req: { name: string }): Promise<IpcResult<{ schema: Record<string, unknown> | null; values: Record<string, unknown> | null }>> {
    return this.plugins.getPluginSettingsInfo(req);
  }
  setPluginSettings(req: { name: string; values: Record<string, unknown> }): Promise<IpcResult<null>> {
    return this.plugins.setPluginSettings(req);
  }
  private startLoop(sessionId: string, content: MessageContent, messageId?: string): void {
    const mid = messageId ?? `${this.sessionPrefix}-m${++this.messageCounter}`;
    this.running.set(sessionId, { messageId: mid, abort: new AbortController(), partialContent: '' });
    void this.runLoopTask(sessionId, content);
  }
  private async runLoopTask(sessionId: string, userMessage: MessageContent): Promise<void> {
    const running = this.running.get(sessionId)!;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const policy = this.policy.getRuntimeState();
    const provider = policy.provider!;
    try {
      let inputHistory = session.messages;
      const est = inputHistory.reduce((sum, m) => sum + estimateMessageTokens(m) + 8, 0);
      if (policy.contextTokenBudget > 0 && est > policy.contextTokenBudget) {
        try {
          inputHistory = await this.workspace.compressHistory(session.messages, provider);
        } catch {
          inputHistory = session.messages;
        }
      }
      const inputLen = inputHistory.length;
      const result = await runLoop({
        provider,
        registry: this.registry,
        systemPrompt: this.workspace.buildSystemPrompt(),
        userMessage,
        history: inputHistory,
        workingDir: this.appDir,
        contextTokenBudget: policy.contextTokenBudget,
        options: {
          maxIterations: policy.maxIterations,
          signal: running.abort.signal,
          allowedPermissions: policy.allowedPermissions,
          forceApprovalPermissions: policy.forceApprovalPermissions,
          reasoningEffort: policy.reasoningEffort,
          pluginSettings: (name) => this.plugins.getPluginSettings(name),
          ctxExtras: () => ({ services: { runSubagent: (args: Record<string, unknown>) => this.subagents.runSubagent(args, sessionId, running.messageId) } }),
          onChunk: (delta) => {
            running.partialContent += delta;
            this.pushEvent('message-chunk', { messageId: running.messageId, sessionId, role: 'assistant', delta });
          },
          onEvent: (e) => this.onLoopEvent(sessionId, running.messageId, e),
          requestApproval: (call) => this.audits.requestApproval(running.messageId, call),
        },
      });
      await this.sessions.replaceMessages(sessionId, [...session.messages, ...result.history.slice(inputLen)]);
      void this.sessions.maybeAutoTitle(sessionId);
    } catch (e) {
      try {
        await this.sessions.appendMessages(sessionId, [{ role: 'user', content: userMessage }]);
      } catch {}
      if (running.abort.signal.aborted) {
        this.pushEvent('loop-done', { messageId: running.messageId, sessionId, content: running.partialContent, stopped: true });
      } else {
        const code = e instanceof AgentLoopError ? e.code : 'E_INTERNAL';
        const message = e instanceof Error ? e.message : String(e);
        this.pushEvent('loop-error', { messageId: running.messageId, sessionId, error: { code, message, phase: 'unknown' } });
      }
    } finally {
      this.audits.clearAll(running.messageId);
      if (this.running.get(sessionId)?.messageId === running.messageId) this.running.delete(sessionId);
      const q = this.queues.get(sessionId);
      if (q?.length && !this.running.has(sessionId)) {
        const next = q.shift();
        if (q.length === 0) this.queues.delete(sessionId);
        if (next) this.startLoop(sessionId, next);
      }
    }
  }
  private onLoopEvent(sessionId: string, messageId: string, e: LoopEvent): void {
    switch (e.type) {
      case 'tool-started':
        this.plugins.markToolStarted(e.call.name);
        this.pushEvent('tool-started', { messageId, sessionId, toolCallId: e.call.id, name: e.call.name, arguments: e.call.arguments });
        break;
      case 'tool-result':
        this.plugins.markToolResult(e.call.name);
        this.pushEvent('tool-result', { messageId, sessionId, toolCallId: e.call.id, result: e.result });
        void this.audits.appendToolAudit(e.call, e.result, sessionId, messageId);
        break;
      case 'approval-required':
        this.pushEvent('approval-required', { messageId, sessionId, toolCallId: e.call.id, name: e.call.name, arguments: e.call.arguments, reason: '该工具需要用户批准后执行' });
        break;
      case 'loop-done':
        this.pushEvent('loop-done', { messageId, sessionId, content: e.content, stopped: false });
        break;
    }
  }
}
