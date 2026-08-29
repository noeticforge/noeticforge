import { ipcMain, screen, type BrowserWindow, type Rectangle } from 'electron';

/**
 * 窗口外壳控制（液态玻璃无边框窗口专用）。
 * 独立于 agent IPC 协议：走 ipcMain.on 单向通道 + win:state 状态推送。
 * main.ts 与 scripts/window-selftest.ts 共用本模块，保证被测路径 == 生产路径。
 *
 * Windows 平台限制（CODE_REVIEW.md F1）：transparent:true 的无边框窗口上原生
 * maximize() 静默失效（isMaximized() 恒为 false，最大化按钮无效）。因此 win32
 * 改用「逻辑最大化」：记录原 bounds → setBounds(工作区) → 手工维护并推送状态。
 * 其余平台保持原生 maximize/unmaximize 行为。
 */

interface LogicalMaxState {
  /** 进入逻辑最大化前的 bounds（还原用；null = 当前不是逻辑最大化） */
  restore: Rectangle | null;
}

const maxStates = new WeakMap<BrowserWindow, LogicalMaxState>();

function isEffectivelyMaximized(win: BrowserWindow): boolean {
  if (process.platform !== 'win32') return win.isMaximized();
  return maxStates.get(win)?.restore != null;
}

function sendState(getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('win:state', { maximized: isEffectivelyMaximized(win) });
  }
}

export function registerWindowControls(getWindow: () => BrowserWindow | null): void {
  ipcMain.on('win:minimize', () => getWindow()?.minimize());
  ipcMain.on('win:toggle-maximize', () => {
    const win = getWindow();
    if (!win) return;
    if (process.platform !== 'win32') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return;
    }
    // win32：透明窗口原生最大化失效 → 逻辑最大化
    const state = maxStates.get(win) ?? { restore: null };
    if (state.restore) {
      win.setBounds(state.restore);
      maxStates.set(win, { restore: null });
    } else {
      const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
      maxStates.set(win, { restore: win.getBounds() });
      win.setBounds(workArea);
    }
    sendState(getWindow);
  });
  ipcMain.on('win:close', () => getWindow()?.close());
}

/** 最大化状态变化推给渲染层：玻璃板去掉圆角与外边距，铺满屏幕 */
export function attachWindowStatePush(getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (!win) return;
  // 原生事件：非 win32 的 maximize/unmaximize；win32 的逻辑最大化不触发这些事件，状态在 toggle 时直接推送
  win.on('maximize', () => sendState(getWindow));
  win.on('unmaximize', () => sendState(getWindow));
}
