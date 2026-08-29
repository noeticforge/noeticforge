import { contextBridge, ipcRenderer } from 'electron';

/**
 * preload：把 IPC 通道包装成类型友好的 window.agentBase API 暴露给渲染进程。
 * 渲染进程代码只允许通过这个对象与底座通信——这就是 UI 与底座的全部边界。
 * 通道名与 docs/IPC_EVENT_PROTOCOL.md 一一对应，禁止绕过协议直连 ipcRenderer。
 */

const INVOKE_CHANNELS = [
  'send-message',
  'approve-tool',
  'reject-tool',
  'stop',
  'list-plugins',
  'install-plugin',
  'uninstall-plugin',
  'set-model-config',
] as const;

const PUSH_CHANNELS = [
  'message-chunk',
  'tool-started',
  'tool-result',
  'approval-required',
  'loop-done',
  'loop-error',
  'plugins-changed',
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
  // ---- 请求（UI → 主进程，返回 {ok:true,data} | {ok:false,error}）----
  sendMessage: (message: { role: 'user'; content: string }) =>
    invoke<{ messageId: string } | { ok: false; error: unknown }>('send-message', { message }),
  approveTool: (req: { messageId: string; toolCallId: string; arguments?: Record<string, unknown> }) =>
    invoke('approve-tool', req),
  rejectTool: (req: { messageId: string; toolCallId: string; reason?: string }) =>
    invoke('reject-tool', req),
  stop: () => invoke('stop'),
  listPlugins: () => invoke('list-plugins'),
  installPlugin: (req: { pluginDir: string }) => invoke('install-plugin', req),
  uninstallPlugin: (req: { name: string }) => invoke('uninstall-plugin', req),
  setModelConfig: (req: {
    config: {
      provider: 'deepseek' | 'openai' | 'anthropic';
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
  }) => invoke('set-model-config', req),

  // ---- 订阅（主进程 → UI 推送）----
  on,
};

contextBridge.exposeInMainWorld('agentBase', agentBase);

export type AgentBaseApi = typeof agentBase;
