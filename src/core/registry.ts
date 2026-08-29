import type { AgentTool, Plugin, PluginManifest, ToolDefinition } from '../types.js';

interface RegistryEntry {
  manifest: PluginManifest;
  tool: AgentTool;
}

/**
 * 工具注册表：循环引擎唯一认识的东西。
 * 它不关心插件从哪来（内置/用户安装），只负责登记、查找、注销。
 */
export class ToolRegistry {
  private readonly plugins = new Map<string, Plugin>();
  private readonly tools = new Map<string, RegistryEntry>();

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.name)) {
      throw new Error(`插件重复注册: ${plugin.manifest.name}`);
    }
    for (const tool of plugin.tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(
          `工具名冲突: "${tool.name}"（已被插件 ${this.tools.get(tool.name)!.manifest.name} 注册）`,
        );
      }
    }
    this.plugins.set(plugin.manifest.name, plugin);
    for (const tool of plugin.tools) {
      this.tools.set(tool.name, { manifest: plugin.manifest, tool });
    }
  }

  unregister(pluginName: string): boolean {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;
    for (const tool of plugin.tools) {
      this.tools.delete(tool.name);
    }
    this.plugins.delete(pluginName);
    return true;
  }

  getTool(name: string): { pluginName: string; tool: AgentTool } | undefined {
    const entry = this.tools.get(name);
    if (!entry) return undefined;
    return { pluginName: entry.manifest.name, tool: entry.tool };
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  listPlugins(): Plugin[] {
    return [...this.plugins.values()];
  }
}
