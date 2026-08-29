import { ipcMain, type BrowserWindow } from 'electron';

/**
 * 窗口外壳控制（液态玻璃无边框窗口专用）。
 * 独立于 agent IPC 协议：走 ipcMain.on 单向通道 + win:state 状态推送。
 * main.ts 与 scripts/window-selftest.ts 共用本模块，保证被测路径 == 生产路径。
 */
export function registerWindowControls(getWindow: () => BrowserWindow | null): void {
  ipcMain.on('win:minimize', () => getWindow()?.minimize());
  ipcMain.on('win:toggle-maximize', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('win:close', () => getWindow()?.close());
}

/** 最大化状态变化推给渲染层：玻璃板去掉圆角与外边距，铺满屏幕 */
export function attachWindowStatePush(getWindow: () => BrowserWindow | null): void {
  const sendState = () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('win:state', { maximized: win.isMaximized() });
    }
  };
  // 事件挂在窗口实例上：调用方在创建窗口后接入
  const win = getWindow();
  win?.on('maximize', sendState);
  win?.on('unmaximize', sendState);
}
