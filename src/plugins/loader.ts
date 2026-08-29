import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Permission, Plugin, PluginManifest } from '../types.js';
import type { ToolRegistry } from '../core/registry.js';

const VALID_PERMISSIONS: Permission[] = ['fs:read', 'fs:write', 'shell:exec', 'net:http'];

/** 底座支持的插件协议版本；manifest.protocolVersion 高于此值 → 拒绝加载 */
export const SUPPORTED_PLUGIN_PROTOCOL_VERSION = 1;

export interface LoadPluginsReport {
  loaded: string[];
  failed: { dir: string; error: string }[];
}

/**
 * 插件加载器：扫描目录 → 校验 manifest → 动态 import → 回填 manifest → 注册。
 * 扫描规则：从 rootDir 向下找（最多两层，支持 plugins/builtin/xxx 这样的分组），
 * 含 manifest.json 的目录视为一个插件。
 */
export async function loadPluginsFromRoot(
  rootDir: string,
  registry: ToolRegistry,
): Promise<LoadPluginsReport> {
  const report: LoadPluginsReport = { loaded: [], failed: [] };
  const pluginDirs = await collectPluginDirs(rootDir, 0);

  for (const pluginDir of pluginDirs) {
    const relName = path.relative(rootDir, pluginDir);
    try {
      const plugin = await loadPluginFromDir(pluginDir);
      registry.register(plugin);
      report.loaded.push(plugin.manifest.name);
    } catch (err) {
      report.failed.push({
        dir: relName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

async function collectPluginDirs(dir: string, depth: number): Promise<string[]> {
  if (depth > 2) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.isFile() && e.name === 'manifest.json')) {
    return [dir];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push(...(await collectPluginDirs(path.join(dir, entry.name), depth + 1)));
  }
  return out;
}

export async function loadPluginFromDir(pluginDir: string): Promise<Plugin> {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const raw = await readFile(manifestPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // 带上 "manifest" 关键字：安装通道据此归类为校验失败（E_PLUGIN_VALIDATION_FAILED）
    throw new Error(`manifest.json 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const manifest = validateManifest(parsed, pluginDir);

  const entryPath = path.join(pluginDir, manifest.entry);
  // 查询参数用于穿透 ESM import 缓存：热更新插件时必须拿到磁盘上的新代码而不是旧模块
  const mod = (await import(`${pathToFileURL(entryPath).href}?t=${Date.now()}`)) as {
    plugin?: Omit<Plugin, 'manifest'>;
    default?: Omit<Plugin, 'manifest'>;
  };
  const exported = mod.plugin ?? mod.default;
  if (!exported || !Array.isArray(exported.tools)) {
    throw new Error('入口文件未导出 { tools: [...] } 形式的 plugin 对象');
  }

  const plugin: Plugin = { manifest, tools: exported.tools };
  // 富插件协议 v2：生命周期钩子（可选）
  if (typeof exported.onInstall === 'function') plugin.onInstall = exported.onInstall;
  if (typeof exported.onUninstall === 'function') plugin.onUninstall = exported.onUninstall;
  validateTools(plugin);
  return plugin;
}

function validateManifest(raw: unknown, pluginDir: string): PluginManifest {
  const m = raw as Partial<PluginManifest>;
  const required: (keyof PluginManifest)[] = ['name', 'version', 'displayName', 'description', 'permissions', 'entry'];
  for (const key of required) {
    if (m[key] === undefined || m[key] === null) {
      throw new Error(`manifest.json 缺少必填字段 "${key}"`);
    }
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name!)) {
    throw new Error(`插件名 "${m.name}" 必须是 kebab-case`);
  }
  if (!Array.isArray(m.permissions) || m.permissions.some((p) => !VALID_PERMISSIONS.includes(p))) {
    throw new Error(`permissions 含非法值（合法值: ${VALID_PERMISSIONS.join(', ')}）`);
  }
  if (typeof m.entry !== 'string' || !m.entry.endsWith('.js')) {
    throw new Error('entry 必须指向 .js 文件');
  }
  if (m.protocolVersion !== undefined) {
    if (typeof m.protocolVersion !== 'number' || !Number.isInteger(m.protocolVersion) || m.protocolVersion < 1) {
      throw new Error('manifest.protocolVersion 必须是正整数');
    }
    if (m.protocolVersion > SUPPORTED_PLUGIN_PROTOCOL_VERSION) {
      throw new Error(
        `插件协议版本过高: manifest 要求 ${m.protocolVersion}，底座支持 ${SUPPORTED_PLUGIN_PROTOCOL_VERSION}，请升级底座`,
      );
    }
  }
  if (m.settings !== undefined && (typeof m.settings !== 'object' || m.settings === null || Array.isArray(m.settings))) {
    throw new Error('manifest.settings 必须是 JSON Schema 对象');
  }
  return {
    name: m.name!,
    version: m.version!,
    displayName: m.displayName!,
    description: m.description!,
    author: m.author,
    permissions: m.permissions!,
    entry: m.entry!,
    protocolVersion: m.protocolVersion,
    settings: m.settings,
  };
}

/** 最小权限校验：工具要求的每项权限都必须在插件 manifest 声明的范围内 */
function validateTools(plugin: Plugin): void {
  for (const tool of plugin.tools) {
    if (!tool.name || !tool.description || typeof tool.execute !== 'function') {
      throw new Error(`工具 ${tool.name ?? '(未命名)'} 缺少 name/description/execute`);
    }
    if (!tool.name.startsWith(`${plugin.manifest.name}.`)) {
      throw new Error(`工具名 "${tool.name}" 必须以 "${plugin.manifest.name}." 开头`);
    }
    for (const p of tool.permissions ?? []) {
      if (!plugin.manifest.permissions.includes(p)) {
        throw new Error(
          `工具 "${tool.name}" 要求权限 ${p}，但插件 manifest 未声明（最小权限原则）`,
        );
      }
    }
  }
}

/** 内置插件目录的绝对路径（编译后位于 dist/src/plugins/builtin 不存在，内置插件放在仓库 plugins/ 下） */
export function builtinPluginsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..', 'plugins', 'builtin');
}
