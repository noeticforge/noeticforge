# @agent-base/sdk

agent-base 插件开发 SDK。两个作用：

1. **类型**：`index.d.ts` 是插件作者面向的全部类型契约（与底座 `src/types.ts` 同步）；
2. **`definePlugin()`**：恒等辅助函数，让 IDE 对插件导出对象做完整类型检查与补全。

## 用法

```bash
npm install @agent-base/sdk
```

```typescript
import { definePlugin, type AgentTool } from '@agent-base/sdk';

const hello: AgentTool = {
  name: 'my-plugin.hello',
  description: '返回一句问候',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '谁' } },
    required: ['name'],
  },
  permissions: [],
  async execute(args, ctx) {
    const greeting = (ctx.settings as any)?.greeting ?? '你好';
    return { ok: true, output: `${greeting}，${args.name}！`, render: 'markdown' };
  },
};

export default definePlugin({
  manifest: {
    name: 'my-plugin',
    version: '1.0.0',
    displayName: 'My Plugin',
    description: '示例插件',
    permissions: [],
    entry: './dist/index.js',
    protocolVersion: 1,
  },
  tools: [hello],
});
```

## 五分钟上手

完整流程（建目录 → manifest → 入口 → 编译 → 安装验证）见项目根 `docs/PLUGIN_PROTOCOL.md` §6；
可直接复制 `templates/plugin-basic/` 作为起点。

## 纪律

- `manifest` / `AgentTool` 字段与底座校验一一对应，**不要自行增删字段**（会被加载器拒绝）；
- `execute` 里任何异常都请 try/catch 成 `{ ok: false, error }` 返回——错误会回喂模型自愈；
- 权限最小化：能不申请就不申请，`tool.permissions ⊆ manifest.permissions` 会被强校验。
