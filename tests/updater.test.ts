import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  UpdateManager,
  UPDATER_PUSH_CHANNEL,
  type UpdateState,
} from '../src/electron/updater.js';
import type { AppUpdater, UpdateInfo } from 'electron-updater';

/**
 * UpdateManager 状态机自测（不联网、不启动 electron、不触发真实 electron-updater）：
 * 用假 updater 验证「检查 → 提示 → 确认下载 → 确认安装」的完整状态流，
 * 以及「默认关闭 / 禁止静默下载 / 禁止静默安装」三条硬性边界。
 */

const UPDATE_INFO: UpdateInfo = {
  version: '0.5.0',
  files: [{ url: 'https://example.invalid/agent-base-0.5.0-setup.exe', sha512: 'x', size: 1 }],
  path: 'x',
  sha512: 'x',
  releaseName: 'v0.5.0',
  releaseNotes: '测试发布说明',
  releaseDate: '2025-01-01T00:00:00.000Z',
};

/** 模拟 electron-updater：按需 emit 事件，记录调用次数，可注入抛错 */
class FakeUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkResult: { updateInfo: UpdateInfo } | null = { updateInfo: UPDATE_INFO };
  checkError: Error | null = null;
  downloadError: Error | null = null;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  quitArgs: unknown[] = [];
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  async checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null> {
    this.checkCalls += 1;
    if (this.checkError) throw this.checkError;
    this.emit('checking-for-update');
    if (this.checkResult) this.emit('update-available', this.checkResult.updateInfo);
    else this.emit('update-not-available', UPDATE_INFO);
    return this.checkResult;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    this.emit('download-progress', { total: 100, delta: 50, transferred: 50, percent: 50, bytesPerSecond: 1 });
    this.emit('update-downloaded', UPDATE_INFO);
    return ['/tmp/agent-base-0.5.0-setup.exe'];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls += 1;
    this.quitArgs = [isSilent, isForceRunAfter];
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

function makeManager(appDir: string, fake: FakeUpdater, pushes: { channel: string; payload: unknown }[]) {
  const push = (channel: string, payload: unknown) => pushes.push({ channel, payload });
  const mgr = new UpdateManager(appDir, push, fake as unknown as AppUpdater);
  return mgr;
}

async function withAppDir(enabled: boolean | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-base-updater-'));
  if (enabled !== undefined) {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ autoUpdate: { enabled } }), 'utf-8');
  }
  return dir;
}

function lastStatus(pushes: { channel: string; payload: unknown }[]): string {
  const upd = pushes.filter((p) => p.channel === UPDATER_PUSH_CHANNEL).map((p) => p.payload as UpdateState);
  return upd[upd.length - 1]?.status ?? '';
}

describe('UpdateManager（默认关闭）', () => {
  it('无 config.json → disabled，且不触碰 autoDownload / 事件', async () => {
    const dir = await withAppDir(undefined);
    try {
      const fake = new FakeUpdater();
      const pushes: { channel: string; payload: unknown }[] = [];
      const mgr = makeManager(dir, fake, pushes);
      expect(mgr.isEnabled()).toBe(false);
      const state = (mgr.getState() as { ok: true; data: UpdateState }).data;
      expect(state.status).toBe('disabled');
      expect(state.enabled).toBe(false);
      // 未启用：不订阅事件、不强制关闭 autoDownload（保留 electron-updater 默认值）
      expect(fake.autoDownload).toBe(true);
      expect(fake.handlers.size).toBe(0);
      // init 不触发检查
      mgr.init();
      expect(fake.checkCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('autoUpdate.enabled=false → disabled', async () => {
    const dir = await withAppDir(false);
    try {
      const fake = new FakeUpdater();
      const mgr = makeManager(dir, fake, []);
      expect(mgr.isEnabled()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('UpdateManager（启用后：检查 → 提示 → 确认下载 → 确认安装）', () => {
  it('启用后强制 autoDownload=false / autoInstallOnAppQuit=false（无静默路径）', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      const mgr = makeManager(dir, fake, []);
      expect(mgr.isEnabled()).toBe(true);
      expect(fake.autoDownload).toBe(false);
      expect(fake.autoInstallOnAppQuit).toBe(false);
      const state = (mgr.getState() as { ok: true; data: UpdateState }).data;
      expect(state.status).toBe('idle');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checkUpdates → available（推送版本号与发布说明，不下载）', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      const pushes: { channel: string; payload: unknown }[] = [];
      const mgr = makeManager(dir, fake, pushes);
      const r = await mgr.checkUpdates();
      expect(r.ok).toBe(true);
      const state = (r as { ok: true; data: UpdateState }).data;
      expect(state.status).toBe('available');
      expect(state.version).toBe('0.5.0');
      expect(state.releaseNotes).toBe('测试发布说明');
      expect(fake.downloadCalls).toBe(0); // 只提示，不自动下载
      expect(lastStatus(pushes)).toBe('available');
      // 推送通道名正确
      expect(pushes.some((p) => p.channel === UPDATER_PUSH_CHANNEL)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('未发现新版本 → not-available', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      fake.checkResult = null;
      const mgr = makeManager(dir, fake, []);
      const r = await mgr.checkUpdates();
      expect((r as { ok: true; data: UpdateState }).data.status).toBe('not-available');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downloadUpdate：available → downloading(percent) → downloaded', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      const pushes: { channel: string; payload: unknown }[] = [];
      const mgr = makeManager(dir, fake, pushes);
      await mgr.checkUpdates();
      const r = await mgr.downloadUpdate();
      expect(r.ok).toBe(true);
      expect(fake.downloadCalls).toBe(1);
      expect((r as { ok: true; data: UpdateState }).data.status).toBe('downloaded');
      expect((r as { ok: true; data: UpdateState }).data.percent).toBe(100);
      // 推送序列覆盖 downloading（50）与 downloaded
      const statuses = pushes
        .filter((p) => p.channel === UPDATER_PUSH_CHANNEL)
        .map((p) => (p.payload as UpdateState).status);
      expect(statuses).toContain('downloading');
      expect(statuses).toContain('downloaded');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installUpdate：downloaded 后 quitAndInstall(false, true)', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      const mgr = makeManager(dir, fake, []);
      await mgr.checkUpdates();
      await mgr.downloadUpdate();
      const r = mgr.installUpdate();
      expect(r.ok).toBe(true);
      expect(fake.installCalls).toBe(1);
      expect(fake.quitArgs).toEqual([false, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('UpdateManager（硬边界：无静默安装）', () => {
  it('未 available 直接 downloadUpdate → 报错且不下载', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      const mgr = makeManager(dir, fake, []);
      // 初始 idle，未检查 → 拒绝下载
      const r = await mgr.downloadUpdate();
      expect(r.ok).toBe(false);
      expect(fake.downloadCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('未 downloaded 直接 installUpdate → 报错且不安装', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      const mgr = makeManager(dir, fake, []);
      await mgr.checkUpdates(); // available，但尚未下载
      const r = mgr.installUpdate();
      expect(r.ok).toBe(false);
      expect(fake.installCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('检查出错 → status=error 且返回统一错误包装', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      fake.checkError = new Error('网络不可达');
      const pushes: { channel: string; payload: unknown }[] = [];
      const mgr = makeManager(dir, fake, pushes);
      const r = await mgr.checkUpdates();
      expect(r.ok).toBe(false);
      expect((r as { ok: false; error: { message: string } }).error.message).toBe('网络不可达');
      expect(lastStatus(pushes)).toBe('error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('下载出错 → status=error 且不触发安装', async () => {
    const dir = await withAppDir(true);
    try {
      const fake = new FakeUpdater();
      fake.downloadError = new Error('校验失败');
      const mgr = makeManager(dir, fake, []);
      await mgr.checkUpdates();
      const r = await mgr.downloadUpdate();
      expect(r.ok).toBe(false);
      expect(fake.installCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('setEnabled 动态开启与关闭自动更新并持久化到 config.json', async () => {
    const dir = await withAppDir(false);
    try {
      const fake = new FakeUpdater();
      const mgr = makeManager(dir, fake, []);
      expect(mgr.isEnabled()).toBe(false);
      await mgr.setEnabled(true);
      expect(mgr.isEnabled()).toBe(true);
      await mgr.setEnabled(false);
      expect(mgr.isEnabled()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
