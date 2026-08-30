import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentService } from './agent-service.js';
import { registerWindowControls, attachWindowStatePush } from './window-controls.js';
import { TerminalManager } from './terminal.js';
import { UpdateManager } from './updater.js';

/**
 * Electron 主进程：唯一的职责是把 ipcMain 通道接到 AgentService 上、把推送转发给窗口。
 * 不写业务逻辑——业务全在 agent-service.ts，因此可以脱离 GUI 完整自测。
 */

// ESM 模式下没有 __dirname，用 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let terminal: TerminalManager | null = null;
let updater: UpdateManager | null = null;
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
    minWidth: 960,
    minHeight: 640,
    title: 'agent-base',
    // 液态玻璃：无边框透明窗口，UI 自绘全部窗体（圆角玻璃板 + 拖拽标题栏 + 窗控按钮）
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.resolve(__dirname, '../../../renderer/index.html'));
  // 最大化状态推给渲染层：玻璃板去掉圆角与外边距，铺满屏幕
  attachWindowStatePush(() => win);
}

/** handler 永不 throw：全部异常在 service 内部转成 {ok:false,error}（协议 §6.4） */
function handle(channel: string, fn: (req: any) => unknown): void {
  ipcMain.handle(channel, (_event, req) => fn(req));
}

app.whenReady().then(async () => {
  // 窗口外壳控制（不属于 agent IPC 协议，走 ipcMain.on 单向通道）
  registerWindowControls(() => win);

  // 内置终端：持久 shell 会话，输出推流到右侧面板
  const term = new TerminalManager((text) => {
    if (win && !win.isDestroyed()) win.webContents.send('term-data', { text });
  }, process.cwd());
  terminal = term;
  ipcMain.on('term-input', (_e, req) => {
    const command = req && typeof req.command === 'string' ? req.command : '';
    if (command.trim()) term.write(command);
    else term.start(); // 空命令 = 拉起 shell
  });
  ipcMain.on('term-stop', () => term.stop());

  // 自动更新（默认关闭；仅 config.json autoUpdate.enabled=true 时启用）
  updater = new UpdateManager(process.cwd(), (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  });
  handle('check-updates', () => updater!.checkUpdates());
  handle('download-update', () => updater!.downloadUpdate());
  handle('install-update', () => updater!.installUpdate());
  handle('get-updater-state', () => updater!.getState());
  if (updater.isEnabled()) {
    void updater.init();
  }

  // 附件选择（原生对话框；读取走 read-attachment 通道）
  handle('pick-files', async () => {
    if (!win || win.isDestroyed()) return { ok: true, data: { paths: [] } };
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: '选择附件（文本或图片）',
    });
    return { ok: true, data: { paths: r.canceled ? [] : r.filePaths } };
  });

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
  // 策略与应用信息
  handle('set-agent-policy', (req) => service.setAgentPolicy(req));
  handle('get-app-info', () => service.getAppInfo());
  handle('read-audit', (req) => service.readAudit(req));
  handle('preview-file', (req) => service.previewFile(req));
  handle('list-workspace-files', (req) => service.listWorkspaceFiles(req));
  handle('read-attachment', (req) => service.readAttachment(req));

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

// 退出链路兜底：杀掉终端子进程（含 darwin 关窗不退出的场景）
app.on('before-quit', () => {
  terminal?.stop();
  void service.shutdown();
});
