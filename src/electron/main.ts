import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentService } from './agent-service.js';

/**
 * Electron 主进程：唯一的职责是把 ipcMain 通道接到 AgentService 上、把推送转发给窗口。
 * 不写业务逻辑——业务全在 agent-service.ts，因此可以脱离 GUI 完整自测。
 */

// ESM 模式下没有 __dirname，用 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
const service = new AgentService({
  appDir: process.cwd(),
  pushEvent: (channel, payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  },
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'agent-base',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.resolve(__dirname, '../../../renderer/index.html'));
}

/** handler 永不 throw：全部异常在 service 内部转成 {ok:false,error}（协议 §6.4） */
function handle(channel: string, fn: (req: any) => unknown): void {
  ipcMain.handle(channel, (_event, req) => fn(req));
}

app.whenReady().then(async () => {
  // 循环与审批
  handle('send-message', (req) => service.sendMessage(req));
  handle('approve-tool', (req) => service.approveTool(req));
  handle('reject-tool', (req) => service.rejectTool(req));
  handle('stop', () => service.stop());
  // 插件
  handle('list-plugins', () => service.listPlugins());
  handle('install-plugin', (req) => service.installPlugin(req));
  handle('install-plugin-from-registry', (req) => service.installPluginFromRegistry(req));
  handle('uninstall-plugin', (req) => service.uninstallPlugin(req));
  handle('get-plugin-settings', (req) => service.getPluginSettingsInfo(req));
  handle('set-plugin-settings', (req) => service.setPluginSettings(req));
  // 会话
  handle('list-sessions', () => service.listSessions());
  handle('create-session', (req) => service.createSession(req));
  handle('switch-session', (req) => service.switchSession(req));
  handle('rename-session', (req) => service.renameSession(req));
  handle('delete-session', (req) => service.deleteSession(req));
  // 模型
  handle('list-providers', () => service.listProviders());
  handle('set-model-config', (req) => service.setModelConfig(req));
  // MCP
  handle('list-mcp-servers', () => service.listMcpServers());
  handle('set-mcp-config', (req) => service.setMcpConfig(req));
  handle('toggle-mcp-server', (req) => service.toggleMcpServer(req));

  await service.init();
  createWindow();

  // 自动退出模式：无头验证 App 能否正常启动（CI / 冒烟用）
  if (process.env.AGENT_BASE_AUTOQUIT) {
    setTimeout(() => app.exit(0), 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  void service.shutdown();
});
