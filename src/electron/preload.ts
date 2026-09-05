import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * preload：把 IPC 通道包装成类型友好的 window.agentBase API 暴露给渲染进程。
 * 渲染进程代码只允许通过这个对象与底座通信——这就是 UI 与底座的全部边界。
 * 通道名与 docs/IPC_EVENT_PROTOCOL.md 一一对应，禁止绕过协议直连 ipcRenderer。
 */

const INVOKE_CHANNELS = [
  // 循环与审批
  'send-message',
  'approve-tool',
  'reject-tool',
  'stop',
  // 插件
  'list-plugins',
  'install-plugin',
  'install-plugin-from-registry',
  'uninstall-plugin',
  'get-plugin-settings',
  'set-plugin-settings',
  // 会话（v0.2）
  'list-sessions',
  'create-session',
  'switch-session',
  'rename-session',
  'delete-session',
  // 模型（v0.2）
  'list-providers',
  'set-model-config',
  'fetch-models',
  // MCP（v0.3）
  'list-mcp-servers',
  'set-mcp-config',
  'toggle-mcp-server',
  // 策略与应用信息（v0.3）
  'set-agent-policy',
  'get-app-info',
  'read-audit',
  'preview-file',
  // 上下文与附件 / 终端（v0.4）
  'list-workspace-files',
  'read-attachment',
  'pick-files',
  'term-input',
  'term-stop',
  // 自动更新（v0.4，默认关闭）
  'check-updates',
  'download-update',
  'install-update',
  'get-updater-state',
  'set-auto-update-enabled',
] as const;

const PUSH_CHANNELS = [
  'message-chunk',
  'tool-started',
  'tool-result',
  'approval-required',
  'loop-done',
  'loop-error',
  'plugins-changed',
  'sessions-changed',
  'mcp-status-changed',
  'term-data',
  'updater-state',
] as const;

type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
type PushChannel = (typeof PUSH_CHANNELS)[number];

function invoke<T>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload);
}

function on(channel: PushChannel, callback: (payload: unknown) => void): void {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
}

const agentBase = {
  /** 协议版本（UI 启动时校验与底座是否匹配） */
  protocolVersion: 2,
  // ---- 循环与审批（请求返回 {ok:true,data} | {ok:false,error:{code,message,phase}}）----
  sendMessage: (req: {
    message: {
      role: 'user';
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }>;
    };
    sessionId?: string;
    /** @ 引用的文件（相对工作目录），内容由底座读取注入 */
    contextFiles?: string[];
  }) =>
    invoke<{ messageId: string; queued?: boolean } | { ok: false; error: unknown }>('send-message', req),  approveTool: (req: { messageId: string; toolCallId: string; arguments?: Record<string, unknown> }) =>
    invoke('approve-tool', req),
  rejectTool: (req: { messageId: string; toolCallId: string; reason?: string }) =>
    invoke('reject-tool', req),
  stop: () => invoke('stop'),

  // ---- 插件 ----
  listPlugins: () => invoke('list-plugins'),
  installPlugin: (req: { pluginDir: string }) => invoke('install-plugin', req),
  installPluginFromRegistry: (req: { name: string; registryUrl?: string }) =>
    invoke('install-plugin-from-registry', req),
  uninstallPlugin: (req: { name: string }) => invoke('uninstall-plugin', req),
  getPluginSettings: (req: { name: string }) => invoke('get-plugin-settings', req),
  setPluginSettings: (req: { name: string; values: Record<string, unknown> }) =>
    invoke('set-plugin-settings', req),

  // ---- 会话 ----
  listSessions: () => invoke('list-sessions'),
  createSession: (req: { title?: string }) => invoke('create-session', req),
  switchSession: (req: { id: string }) => invoke('switch-session', req),
  renameSession: (req: { id: string; title: string }) => invoke('rename-session', req),
  deleteSession: (req: { id: string }) => invoke('delete-session', req),

  // ---- 模型 ----
  listProviders: () => invoke('list-providers'),
  setModelConfig: (req: {
    config: {
      provider: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      maxTokens?: number;
    };
  }) => invoke('set-model-config', req),
  fetchModels: (req?: { provider?: string; apiKey?: string; baseUrl?: string }) => invoke('fetch-models', req),

  // ---- MCP ----
  listMcpServers: () => invoke('list-mcp-servers'),
  setMcpConfig: (req: { config: Record<string, unknown> }) => invoke('set-mcp-config', req),
  toggleMcpServer: (req: { name: string; enabled: boolean }) => invoke('toggle-mcp-server', req),

  // ---- 策略与应用信息 ----
  setAgentPolicy: (req: { permissionMode?: string; maxIterations?: number }) =>
    invoke('set-agent-policy', req),
  getAppInfo: () => invoke('get-app-info'),
  readAudit: (req?: { lines?: number }) => invoke('read-audit', req),
  previewFile: (req: { path: string }) => invoke('preview-file', req),
  listWorkspaceFiles: (req?: { query?: string }) => invoke('list-workspace-files', req),
  readAttachment: (req: { path: string }) => invoke('read-attachment', req),
  pickFiles: () => invoke('pick-files'),
  termInput: (req: { command: string }) => ipcRenderer.send('term-input', req),
  termStop: () => ipcRenderer.send('term-stop'),

  // ---- 自动更新（默认关闭；只读 API，无任何静默安装入口）----
  checkUpdates: () => invoke('check-updates'),
  downloadUpdate: () => invoke('download-update'),
  installUpdate: () => invoke('install-update'),
  getUpdaterState: () => invoke('get-updater-state'),
  setAutoUpdateEnabled: (req: { enabled: boolean }) => invoke('set-auto-update-enabled', req),

  // ---- 辅助工具 ----
  getPathForFile: (file: File) => {
    try {
      if (typeof webUtils?.getPathForFile === 'function') return webUtils.getPathForFile(file);
    } catch {}
    return (file as unknown as { path?: string })?.path || '';
  },

  // ---- 订阅（主进程 → UI 推送）----
  on,
};

contextBridge.exposeInMainWorld('agentBase', agentBase);

/**
 * 窗口外壳控制（液态玻璃无边框窗口专用）。
 * 注意：这是窗口管理层，不属于 agent IPC 协议——agentBase 通道保持纯净，
 * 窗控行为对协议无感知，任何 UI 实现都可以自行决定是否使用。
 */
const agentWindow = {
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  onState: (callback: (state: { maximized: boolean }) => void): void => {
    ipcRenderer.on('win:state', (_event, state) => callback(state));
  },
};

contextBridge.exposeInMainWorld('agentWindow', agentWindow);

export type AgentBaseApi = typeof agentBase;
