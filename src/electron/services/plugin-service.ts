import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Plugin } from '../../types.js';
import { loadPluginFromDir, loadPluginsFromRoot } from '../../plugins/loader.js';
import type { ToolRegistry } from '../../core/registry.js';
import { err, findDirWithManifest, sanitizeName, toPluginInfo } from '../types.js';
import type { IpcResult, PluginInfo, PushChannel } from '../types.js';

/**
 * Plugin install/uninstall, remote registry download with checksum,
 * settings persistence and in-use guards for uninstall safety.
 */
export class PluginService {
  private readonly registry: ToolRegistry;
  private readonly appDir: string;
  private readonly pushEvent: (channel: PushChannel, payload: unknown) => void;
  private readonly registryUrl: string;
  private readonly pluginsInUse = new Set<string>();
  private readonly settingsCache = new Map<string, Record<string, unknown>>();

  constructor(
    registry: ToolRegistry,
    appDir: string,
    pushEvent: (channel: PushChannel, payload: unknown) => void,
    registryUrl: string,
  ) {
    this.registry = registry;
    this.appDir = appDir;
    this.pushEvent = pushEvent;
    this.registryUrl = registryUrl;
  }

  async loadPlugins(): Promise<void> {
    await loadPluginsFromRoot(path.join(this.appDir, 'plugins'), this.registry);
  }

  listPlugins(): IpcResult<{ plugins: PluginInfo[] }> {
    return { ok: true, data: { plugins: this.snapshot() } };
  }

  async installPlugin(req: { pluginDir: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    const sourceDir = req?.pluginDir;
    let sourceIsDir = false;
    if (typeof sourceDir === 'string' && existsSync(sourceDir)) {
      try {
        sourceIsDir = (await stat(sourceDir)).isDirectory();
      } catch {
        sourceIsDir = false;
      }
    }
    if (!sourceIsDir) {
      return err('E_PATH_NOT_FOUND', `目录不存在: ${sourceDir}`, 'unknown');
    }
    let plugin: Plugin;
    try {
      plugin = await loadPluginFromDir(sourceDir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isValidation = message.includes('manifest') || message.includes('协议版本');
      return err(
        isValidation ? 'E_PLUGIN_VALIDATION_FAILED' : 'E_PLUGIN_LOAD_FAILED',
        `插件加载失败: ${message}`,
        'unknown',
      );
    }
    const name = plugin.manifest.name;
    if (this.registry.listPlugins().some((p) => p.manifest.name === name)) {
      this.registry.unregister(name);
    }
    const pluginsRoot = path.resolve(this.appDir, 'plugins');
    if (!path.resolve(sourceDir).startsWith(pluginsRoot)) {
      const target = path.join(pluginsRoot, 'user', name);
      await rm(target, { recursive: true, force: true });
      await cp(sourceDir, target, { recursive: true });
    }
    this.registry.register(plugin);
    try {
      await plugin.onInstall?.();
    } catch {
      // Lifecycle hook failure must not fail the install flow.
    }
    this.pushEvent('plugins-changed', { plugins: this.snapshot() });
    return { ok: true, data: { plugin: toPluginInfo(plugin) } };
  }

  async installPluginFromRegistry(req: { name: string; registryUrl?: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    const name = req?.name;
    if (typeof name !== 'string' || !name.trim()) {
      return err('E_PLUGIN_NOT_IN_REGISTRY', '缺少插件名', 'unknown');
    }
    let entries: Array<Record<string, unknown>>;
    try {
      const res = await fetch(req.registryUrl ?? this.registryUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      entries = (body?.plugins ?? []) as Array<Record<string, unknown>>;
    } catch (e) {
      return err('E_REGISTRY_FETCH_FAILED', `注册表获取失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
    }
    const entry = entries.filter((x) => x.name === name).sort((a, b) => String(b.version).localeCompare(String(a.version)))[0];
    if (!entry) {
      return err('E_PLUGIN_NOT_IN_REGISTRY', `注册表中没有插件: ${name}`, 'unknown');
    }
    let zipBuf: ArrayBuffer;
    try {
      const res = await fetch(String(entry.downloadUrl));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      zipBuf = await res.arrayBuffer();
    } catch (e) {
      return err('E_REGISTRY_FETCH_FAILED', `插件包下载失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
    }
    const digest = createHash('sha256').update(Buffer.from(zipBuf)).digest('hex');
    if (entry.sha256 && digest !== String(entry.sha256)) {
      return err('E_CHECKSUM_MISMATCH', '插件包 sha256 与注册表不符，已中止安装', 'unknown');
    }
    const tmp = await mkdtemp(path.join(tmpdir(), 'agent-base-registry-'));
    try {
      let dir: string;
      try {
        const zip = new AdmZip(Buffer.from(zipBuf));
        zip.extractAllTo(tmp, true);
        dir = existsSync(path.join(tmp, 'manifest.json'))
          ? tmp
          : (await findDirWithManifest(tmp)) ?? tmp;
      } catch (e) {
        return err('E_PLUGIN_LOAD_FAILED', `插件包解压失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
      }
      return await this.installPlugin({ pluginDir: dir });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async uninstallPlugin(req: { name: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    const name = req?.name;
    const plugin = this.registry.listPlugins().find((p) => p.manifest.name === name);
    if (!plugin) {
      return err('E_PLUGIN_NOT_FOUND', `插件不存在: ${name}`, 'unknown');
    }
    if (this.pluginsInUse.has(name)) {
      return err('E_PLUGIN_IN_USE', `插件 ${name} 的工具正在执行，暂不可卸载`, 'unknown');
    }
    if (existsSync(path.join(this.appDir, 'plugins', 'builtin', name)) || name.startsWith('core-')) {
      return err('E_PLUGIN_BUILTIN', `插件 ${name} 是内置插件，不允许卸载`, 'unknown');
    }
    const info = toPluginInfo(plugin);
    try {
      await plugin.onUninstall?.();
    } catch {
      // Lifecycle hook failure must not fail the uninstall flow.
    }
    this.registry.unregister(name);
    const pluginsRoot = path.resolve(this.appDir, 'plugins');
    const dir = path.join(pluginsRoot, 'user', name);
    if (dir.startsWith(pluginsRoot) && existsSync(dir)) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        return err('E_PLUGIN_UNINSTALL_FAILED', `删除插件文件失败: ${e instanceof Error ? e.message : String(e)}`, 'unknown');
      }
    }
    this.pushEvent('plugins-changed', { plugins: this.snapshot() });
    return { ok: true, data: { plugin: info } };
  }

  getPluginSettings(name: string): Record<string, unknown> | undefined {
    if (this.settingsCache.has(name)) return this.settingsCache.get(name);
    const file = path.join(this.appDir, 'plugins', 'settings', `${sanitizeName(name)}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const values = JSON.parse(readFileSync(file, 'utf-8'));
      this.settingsCache.set(name, values);
      return values;
    } catch {
      return undefined;
    }
  }

  async getPluginSettingsInfo(req: { name: string }): Promise<IpcResult<{ schema: Record<string, unknown> | null; values: Record<string, unknown> | null }>> {
    const plugin = this.registry.listPlugins().find((p) => p.manifest.name === req?.name);
    if (!plugin) return err('E_PLUGIN_NOT_FOUND', `插件不存在: ${req?.name}`, 'unknown');
    const values = this.getPluginSettings(req.name) ?? null;
    return { ok: true, data: { schema: plugin.manifest.settings ?? null, values } };
  }

  async setPluginSettings(req: { name: string; values: Record<string, unknown> }): Promise<IpcResult<null>> {
    const plugin = this.registry.listPlugins().find((p) => p.manifest.name === req?.name);
    if (!plugin) return err('E_PLUGIN_NOT_FOUND', `插件不存在: ${req?.name}`, 'unknown');
    const dir = path.join(this.appDir, 'plugins', 'settings');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${sanitizeName(req.name)}.json`), JSON.stringify(req.values ?? {}, null, 2), 'utf-8');
    this.settingsCache.set(req.name, req.values ?? {});
    return { ok: true, data: null };
  }

  markToolStarted(toolName: string): void {
    const entry = this.registry.getTool(toolName);
    if (entry) this.pluginsInUse.add(entry.pluginName);
  }

  markToolResult(toolName: string): void {
    const entry = this.registry.getTool(toolName);
    if (entry) this.pluginsInUse.delete(entry.pluginName);
  }

  snapshot(): PluginInfo[] {
    return this.registry.listPlugins().map(toPluginInfo);
  }
}
