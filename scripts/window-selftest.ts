import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWindowControls, attachWindowStatePush } from '../src/electron/window-controls.js';

/**
 * 窗口控制自测（不联网、不需要人工点击）：
 * 加载真实 renderer + preload，在页面里执行 window.agentWindow 的按钮调用，
 * 验证「按钮 → ipcRenderer.send → ipcMain → BrowserWindow 行为」与「win:state 推送」全链路。
 * 运行：npm run test:window
 *
 * 注意（CODE_REVIEW.md F1）：win32 上透明窗口原生 maximize 失效，底座改用逻辑最大化
 * （bounds 铺满工作区），因此这里的断言是「铺满工作区」而非 isMaximized()；
 * 非 win32 保持原生行为，两个条件任一满足即通过。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function check(ok: boolean, label: string): void {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    console.error('窗口控制自测失败');
    app.exit(1);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boundsMatchWorkArea(win: BrowserWindow): boolean {
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const b = win.getBounds();
  // DPI 缩放（如 150%）下 DIP↔物理像素换算有 ±1 取整，不能严格相等
  const near = (a: number, v: number) => Math.abs(a - v) <= 2;
  return near(b.x, wa.x) && near(b.y, wa.y) && near(b.width, wa.width) && near(b.height, wa.height);
}

// 自测要观察"窗口销毁后"的状态：屏蔽默认的 window-all-closed 退出行为
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  let win: BrowserWindow | null = null;
  registerWindowControls(() => win);

  win = new BrowserWindow({
    width: 900,
    height: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../src/electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  attachWindowStatePush(() => win);
  win.loadFile(path.resolve(__dirname, '../../renderer/index.html'));

  win.webContents.on('did-finish-load', async () => {
    try {
      const js = win!.webContents.executeJavaScript.bind(win!.webContents);
      check(await js('typeof window.agentWindow === "object"'), 'preload 暴露 window.agentWindow');

      // 最大化 + win:state 推送（win32 逻辑最大化 = bounds 铺满工作区）
      await js('window.__state = null; window.agentWindow.onState(s => window.__state = s); window.agentWindow.toggleMaximize()');
      await wait(500);
      check(win!.isMaximized() || boundsMatchWorkArea(win!), 'win-max 按钮 → 窗口最大化（铺满工作区）');
      const pushed = await js('window.__state');
      check(!!pushed && pushed.maximized === true, 'maximize 事件推送 win:state{maximized:true}');

      // 还原
      await js('window.agentWindow.toggleMaximize()');
      await wait(500);
      check(!win!.isMaximized() && !boundsMatchWorkArea(win!), '再次点击 → 窗口还原');
      const pushed2 = await js('window.__state');
      check(!!pushed2 && pushed2.maximized === false, 'unmaximize 事件推送 win:state{maximized:false}');

      // 最小化
      await js('window.agentWindow.minimize()');
      await wait(400);
      check(win!.isMinimized(), 'win-min 按钮 → 窗口最小化');
      win!.restore();
      await wait(300);

      // 关闭
      await js('window.agentWindow.close()');
      await wait(600);
      check(win!.isDestroyed(), 'win-close 按钮 → 窗口销毁');

      console.log('\n窗口控制自测全部通过 🎉');
      app.exit(0);
    } catch (e) {
      console.error('窗口控制自测异常:', e);
      app.exit(1);
    }
  });
});
