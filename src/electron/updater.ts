import { existsSync, readFileSync, writeFile } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const writeFileAsync = promisify(writeFile);
// electron-updater 是 CJS 包且 autoUpdater 为懒加载 getter 导出，
// ESM 命名导入在运行时会报 "does not provide an export named 'autoUpdater'"，
// 必须默认导入后解构；类型走 type-only 导入（编译期擦除）。
import electronUpdaterModule from 'electron-updater';
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';

import type { IpcResult } from './agent-service.js';

/**
 * 惰性获取真实 autoUpdater。electron-updater 对 autoUpdater 是懒加载 getter，
 * 一旦访问就实例化平台 Updater，其构造依赖 Electron 的 app——
 * 因此绝不能在模块加载期解构（vitest/CI 等非 Electron 环境会启动即崩），
 * 只能在 Electron 主进程内、且功能启用时才调用本函数。
 */
export function resolveAutoUpdater(): AppUpdater {
  return (electronUpdaterModule as typeof import('electron-updater')).autoUpdater;
}

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

/**
 * 私有仓库 + 无凭据时，electron-updater 只会抛一个裸 404，用户完全看不出该干什么。
 * 这里在真正发请求之前先看一眼 app-update.yml：provider 是 github 且 private: true，
 * 而环境里没有 GH_TOKEN / GITHUB_TOKEN，就直接给出可行动的说明。
 *
 * 返回 null = 不适用（公开仓库 / 已有凭据 / 读不到配置），照常走原流程。
 */
export function missingPrivateRepoTokenHint(appDir: string): string | null {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return null;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'app-update.yml') : '',
    path.join(appDir, 'app-update.yml'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const txt = readFileSync(file, 'utf-8');
      if (/provider:\s*github/.test(txt) && /^\s*private:\s*true\s*$/m.test(txt)) {
        return '自动更新需要访问凭据：本应用从私有 GitHub 仓库检查更新，当前未检测到 GH_TOKEN / GITHUB_TOKEN。'
          + '请设置一个具备该仓库读取权限的 Personal Access Token 到环境变量 GH_TOKEN 后重启应用；'
          + '或把仓库的 Releases 设为公开。';
      }
      return null;
    } catch {
      // 读不到配置就按「不适用」处理，让真实错误自己冒出来
    }
  }
  return null;
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
  private enabled: boolean;
  private state: UpdateState;

  constructor(appDir: string, push: Push, updater?: AppUpdater) {
    this.appDir = appDir;
    this.push = push;
    this.enabled = readEnabled(appDir);
    this.updater = updater ?? resolveAutoUpdater();
    this.state = {
      status: this.enabled ? 'idle' : 'disabled',
      enabled: this.enabled,
      currentVersion: APP_VERSION,
    };
    if (this.enabled) {
      // 强制「不静默」：检查到新版本也不自动下载，退出进程也不自动安装
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      try { this.updater.logger = console; } catch {}
      this.bindEvents();
    }
  }

  /** 开启或关闭自动更新（支持运行时在设置页切换并持久化） */
  async setEnabled(enabled: boolean): Promise<IpcResult<UpdateState>> {
    this.enabled = enabled;
    const cfgPath = path.join(this.appDir, 'config.json');
    let cfg: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { cfg = {}; }
    }
    cfg.autoUpdate = { ...(cfg.autoUpdate as Record<string, unknown> || {}), enabled };
    try {
      await writeFileAsync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (e) {
      return fail(`保存自动更新配置失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.setState({ enabled, status: enabled ? 'idle' : 'disabled' });
    if (enabled) {
      this.bindEvents();
      void this.checkUpdates();
    }
    return { ok: true, data: this.state };
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
    // 私有仓库缺凭据时提前拦下：省掉一次注定 404 的请求，并给出能照着做的指引
    const hint = missingPrivateRepoTokenHint(this.appDir);
    if (hint) {
      this.setState({ status: 'error', error: hint });
      return fail(hint);
    }
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
