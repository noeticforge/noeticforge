import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Plugin } from '../../types.js';
import { builtinPluginsDir, loadPluginFromDir, loadPluginsFromRoot } from '../../plugins/loader.js';
import type { ToolRegistry } from '../../core/registry.js';
import { err, findDirWithManifest, sanitizeName, toPluginInfo } from '../types.js';
import type { IpcResult, PluginInfo, PushChannel } from '../types.js';

/**
 * 插件扫描根计算(纯函数,不碰 fs)。来源优先级:数据目录 → cwd → exe 同级 → 内置目录(打包态位于 app.asar)。
 * 去重规则:与已保留根完全重复、或嵌套于任一已保留根的候选直接丢弃——同一插件被两个根重复注册必然名字冲突,
 * 开发态 repo/plugins 天然覆盖 repo/plugins/builtin 正是此场景。存在性检查留给调用方(existsSync)。
 */
export function resolvePluginScanRoots(o: {
  appDir: string;
  cwd: string;
  execPath: string;
  builtinDir: string;
}): string[] {
  const candidates = [
    path.resolve(o.appDir, 'plugins'),
    path.resolve(o.cwd, 'plugins'),
    path.resolve(path.dirname(o.execPath || ''), 'plugins'),
    path.resolve(o.builtinDir),
  ];
  const kept: string[] = [];
  for (const dir of candidates) {
    const covered = kept.some((root) => {
      const rel = path.relative(root, dir);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!covered) kept.push(dir);
  }
  return kept;
}

/** 内置插件目录下的同名目录存在 → 视为内置(打包态 appDir 在 Roaming,必须连 asar 内置目录一起查) */
function isBuiltinPluginName(appDir: string, name: string): boolean {
  return (
    existsSync(path.join(appDir, 'plugins', 'builtin', name)) ||
    existsSync(path.join(builtinPluginsDir(), name))
  );
}

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
    for (const root of resolvePluginScanRoots({
      appDir: this.appDir,
      cwd: process.cwd(),
      execPath: process.execPath || '',
      builtinDir: builtinPluginsDir(),
    })) {
      if (existsSync(root)) await loadPluginsFromRoot(root, this.registry);
    }
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

  async listRegistryPlugins(req?: { registryUrl?: string }): Promise<IpcResult<{ plugins: Array<Record<string, unknown>> }>> {
    let entries: Array<Record<string, unknown>> = [];
    try {
      const res = await fetch(req?.registryUrl ?? this.registryUrl, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const body = (await res.json()) as { plugins?: Array<Record<string, unknown>> };
        entries = body?.plugins ?? [];
      }
    } catch {}
    if (!entries.length) {
      // 离线/内网回退：读取本地仓库或安装包自带的 registry/registry.json
      const localRegistryPath = path.resolve(process.cwd(), 'registry/registry.json');
      if (existsSync(localRegistryPath)) {
        try {
          const body = JSON.parse(await readFile(localRegistryPath, 'utf-8'));
          entries = body?.plugins ?? [];
        } catch {}
      }
    }
    return { ok: true, data: { plugins: entries } };
  }

  async installPluginFromRegistry(req: { name: string; registryUrl?: string }): Promise<IpcResult<{ plugin: PluginInfo }>> {
    const name = req?.name;
    if (!name || !name.trim()) return err('E_PLUGIN_NOT_IN_REGISTRY', '缺少插件名', 'unknown');
    const regResult = await this.listRegistryPlugins({ registryUrl: req.registryUrl });
    const entries = regResult.ok ? regResult.data.plugins : [];
    const entry = entries.filter((x) => x.name === name).sort((a, b) => String(b.version).localeCompare(String(a.version)))[0];
    if (!entry) return err('E_PLUGIN_NOT_IN_REGISTRY', `注册表中没有插件: ${name}`, 'unknown');

    let zipBuf: Buffer | null = null;
    if (entry.downloadUrl) {
      try {
        const res = await fetch(String(entry.downloadUrl), { signal: AbortSignal.timeout(8000) });
        if (res.ok) zipBuf = Buffer.from(await res.arrayBuffer());
      } catch {}
    }
    if (!zipBuf && entry.localPackage) {
      const localZip = path.resolve(process.cwd(), String(entry.localPackage));
      if (existsSync(localZip)) zipBuf = await readFile(localZip);
    }
    if (!zipBuf) return err('E_REGISTRY_FETCH_FAILED', `插件包无法获取或下载超时: ${name}`, 'unknown');

    const digest = createHash('sha256').update(zipBuf).digest('hex');
    if (entry.sha256 && digest !== String(entry.sha256)) {
      return err('E_CHECKSUM_MISMATCH', '插件包 sha256 与注册表不符，已中止安装', 'unknown');
    }
    const tmp = await mkdtemp(path.join(tmpdir(), 'agent-base-registry-'));
    try {
      let dir: string;
      try {
        const zip = new AdmZip(zipBuf);
        zip.extractAllTo(tmp, true);
        dir = existsSync(path.join(tmp, 'manifest.json')) ? tmp : (await findDirWithManifest(tmp)) ?? tmp;
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
    if (isBuiltinPluginName(this.appDir, name) || name.startsWith('core-')) {
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
