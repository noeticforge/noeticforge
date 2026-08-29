# my-plugin（agent-base 插件模板）

5 分钟出第一个插件：

```bash
# 1. 复制本目录并改名（manifest.json 与 src/index.ts 里的 name 保持一致）
# 2. 编译
npx tsc -p tsconfig.json          # 产物输出到 dist/index.js（manifest.entry 指向它）

# 3. 安装验证
#    打开 agent-base 桌面应用 → 侧栏「插件与 MCP」→ 填入本目录绝对路径 → 安装
#    预期：列表出现「示例插件」；对话让模型调用 my-plugin.hello，观察工具卡片与审批行为
```

结构说明：
- `manifest.json`：`protocolVersion: 1` + `settings` Schema（UI 据此生成设置表单，值注入 `ctx.settings`）
- `src/index.ts`：`export default plugin` 是硬约定；`execute` 里不要 reject，总是返回 `ToolResult`
- 权限最小化：本模板不需要任何权限；需要读写文件时再声明 `fs:read` / `fs:write`（写操作建议 `requiresApproval: true`）
