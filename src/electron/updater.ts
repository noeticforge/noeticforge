import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// electron-updater 是 CJS 包且 autoUpdater 为懒加载 getter 导出，
// ESM 命名导入在运行时会报 "does not provide an export named 'autoUpdater'"，
// 必须默认导入后解构；类型走 type-only 导入（编译期擦除）。
import electronUpdaterModule from 'electron-updater';
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';

const { autoUpdater } = electronUpdaterModule as typeof import('electron-updater');
import type { IpcResult } from './agent-service.js';

/**
 * electron-updater 封装（Roadmap 遗留项）。
 *
 * 行为模式：检查 → 提示 → 用户确认后下载 → 用户确认后安装。
 * 绝不做静默下载/静默安装：autoDownload 与 autoInstallOnAppQuit 恒为 false，
 * 下载（download-update）与安装（install-update）只能由渲染层显式调用 IPC 通道触发，
 * 本模块不提供任何绕过用户确认的静默安装路径。
 *
 * 默认关闭：仅当 config.json 里 autoUpdate.enabled === true 时才启用；否则状态恒为 disabled。
 *
 * 可测性：不 import electron 主进程 API（版本号从 package.json 读取），
 * 构造时可注入假 updater（AppUpdater 形态），在 node 环境即可自测状态机。
 */

/** 主进程 → UI 的更新状态推送通道（与 preload.ts PUSH_CHANNELS 保持一致） */
export const UPDATER_PUSH_CHANNEL = 'updater-state';

/** 更新生命周期状态机 */
export type UpdateStatus =
  | 'disabled' // 功能未启用（config.json autoUpdate.enabled !== true）
  | 'idle' // 已启用，尚未开始检查
  | 'checking' // 检查中
  | 'available' // 发现新版本，等待用户确认下载
  | 'not-available' // 已是最新版本
  | 'downloading' // 用户已确认，下载中
  | 'downloaded' // 下载完成，等待用户确认安装
  | 'error'; // 出错（网络 / 校验失败等）

/** 通过 updater-state 推送、以及 get-updater-state 返回的状态快照 */
export interface UpdateState {
  status: UpdateStatus;
  enabled: boolean;
  /** 当前运行版本（取自 package.json，与打包产物同源） */
  currentVersion: string;
  /** 最新版本号（status=available / downloaded 时） */
  version?: string;
  /** 发布说明（透传 electron-updater 的 UpdateInfo.releaseNotes） */
  releaseNotes?: UpdateInfo['releaseNotes'];
  /** 下载进度 0-100（status=downloading 时） */
  percent?: number;
  /** 错误信息（status=error 时） */
  error?: string;
}

/** 主进程 → UI 推送回调（与 main.ts 里 webContents.send 的包装同形） */
type Push = (channel: string, payload: unknown) => void;

/** 复用 agent-service 的统一错误码（不新增错误码，避免触发 check:codes 三方同步） */
const UPDATER_ERROR_CODE = 'E_INTERNAL';

function fail(message: string): IpcResult<never> {
  return { ok: false, error: { code: UPDATER_ERROR_CODE, message, phase: 'unknown' } };
}

/** 应用版本（与 package.json 同源，避免与 agent-service 双写漂移） */
let APP_VERSION = 'dev';
try {
  APP_VERSION =
    JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')).version ??
    APP_VERSION;
} catch {
  // 读取失败用占位，不影响功能
}

/** 读 config.json → autoUpdate.enabled（默认 false；配置缺失/损坏一律按未启用处理） */
function readEnabled(appDir: string): boolean {
  const cfgPath = path.join(appDir, 'config.json');
  if (!existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
      autoUpdate?: { enabled?: unknown };
    };
    return cfg.autoUpdate?.enabled === true;
  } catch {
    return false;
  }
}

export class UpdateManager {
  private readonly updater: AppUpdater;
  private readonly appDir: string;
  private readonly push: Push;
  private readonly enabled: boolean;
  private state: UpdateState;

  constructor(appDir: string, push: Push, updater?: AppUpdater) {
    this.appDir = appDir;
    this.push = push;
    this.enabled = readEnabled(appDir);
    this.updater = updater ?? autoUpdater;
    this.state = {
      status: this.enabled ? 'idle' : 'disabled',
      enabled: this.enabled,
      currentVersion: APP_VERSION,
    };
    if (this.enabled) {
      // 强制「不静默」：检查到新版本也不自动下载，退出进程也不自动安装
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      this.bindEvents();
    }
  }

  /** 是否已启用（config.json autoUpdate.enabled === true） */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 当前状态快照（get-updater-state 通道） */
  getState(): IpcResult<UpdateState> {
    return { ok: true, data: this.state };
  }

  /** 启用时启动即检查一次（main.ts 仅当 isEnabled() 时调用） */
  init(): void {
    if (!this.enabled) return;
    void this.checkUpdates();
  }

  /** 检查更新（用户主动或启动时）。发现新版本只提示、不下载。 */
  async checkUpdates(): Promise<IpcResult<UpdateState>> {
    if (!this.enabled) return { ok: true, data: this.state };
    try {
      this.setState({ status: 'checking', error: undefined });
      const result = await this.updater.checkForUpdates();
      // 事件（update-available / update-not-available）由 bindEvents 推状态；
      // result === null 表示 updater 未激活（如未打包、无 app-update.yml），兜底标为 not-available。
      if (result === null) {
        this.setState({ status: 'not-available' });
      }
      return { ok: true, data: this.state };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', error: message });
      return fail(message);
    }
  }

  /** 用户确认后下载。没有可下载的更新时直接报错，绝不触发任何下载。 */
  async downloadUpdate(): Promise<IpcResult<UpdateState>> {
    if (!this.enabled) return { ok: true, data: this.state };
    if (this.state.status !== 'available') {
      return fail(`当前无可下载的更新（status=${this.state.status}）`);
    }
    try {
      this.setState({ status: 'downloading', percent: 0, error: undefined });
      await this.updater.downloadUpdate();
      return { ok: true, data: this.state };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ status: 'error', error: message });
      return fail(message);
    }
  }

  /** 用户确认后安装（退出并运行安装器）。仅下载完成（downloaded）后有效。 */
  installUpdate(): IpcResult<null> {
    if (!this.enabled) return { ok: true, data: null };
    if (this.state.status !== 'downloaded') {
      return fail(`更新尚未下载完成，无法安装（status=${this.state.status}）`);
    }
    this.updater.quitAndInstall(false, true);
    return { ok: true, data: null };
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.push(UPDATER_PUSH_CHANNEL, this.state);
  }

  /** 订阅 electron-updater 事件 → 状态机 → updater-state 推送 */
  private bindEvents(): void {
    this.updater.on('checking-for-update', () => this.setState({ status: 'checking', error: undefined }));
    this.updater.on('update-available', (info: UpdateInfo) => {
      this.setState({
        status: 'available',
        version: info.version,
        releaseNotes: info.releaseNotes,
        error: undefined,
      });
    });
    this.updater.on('update-not-available', () =>
      this.setState({ status: 'not-available', error: undefined }),
    );
    this.updater.on('download-progress', (p: ProgressInfo) => {
      this.setState({ status: 'downloading', percent: Math.round(p.percent) });
    });
    this.updater.on('update-downloaded', (info: UpdateInfo) => {
      this.setState({ status: 'downloaded', version: info.version, percent: 100 });
    });
    this.updater.on('error', (err: Error) => {
      this.setState({ status: 'error', error: err.message });
    });
  }
}
