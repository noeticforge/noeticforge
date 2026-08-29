// 插件模板入口：复制本目录后改掉插件名，按本文件结构实现你的工具。
// 相对路径一律基于 ctx.workingDir，不要用 process.cwd()（Electron 里不可靠）。

export interface PluginLike {
  manifest: unknown;
  tools: unknown[];
}

interface Args {
  name?: unknown;
}

const helloTool = {
  name: 'my-plugin.hello',
  description: '向指定的人打招呼。给 LLM 看的 description 越清楚，调用越准。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '要问候的人名' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  permissions: [] as string[],
  requiresApproval: false,

  async execute(args: Args, ctx: { workingDir: string; settings?: Record<string, unknown> }) {
    try {
      const name = String(args.name ?? '').trim();
      if (!name) {
        return { ok: false, output: '', error: 'name 不能为空' };
      }
      const greeting = String(ctx.settings?.greeting ?? '你好');
      // render: 'markdown' → UI 会把 output 按 Markdown 渲染（只影响展示，不影响喂给模型）
      return { ok: true, output: `**${greeting}，${name}！**`, render: 'markdown' };
    } catch (err) {
      // 总是返回 ToolResult，不要 reject——错误会回喂模型，模型有机会自愈
      return { ok: false, output: '', error: `hello failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const plugin = {
  manifest: {
    name: 'my-plugin',
    version: '1.0.0',
    displayName: '示例插件',
    description: '演示 settings 注入与 markdown 渲染',
    permissions: [],
    entry: './dist/index.js',
    protocolVersion: 1,
  },
  tools: [helloTool],
  // 可选生命周期钩子（富插件协议 v2）：
  // async onInstall() { ... },
  // async onUninstall() { ... },
};

export default plugin;
