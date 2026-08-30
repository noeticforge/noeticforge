# Journeys 测试工作区

JOURNEY-README-MARKER

用户视角端到端测试（E2E）：mock 模型服务器 + 驱动真实 Electron UI，16 段旅程覆盖全部功能（含窗控）。

J16 窗控：驱动 `window.agentWindow` 的最大化/还原/最小化/关闭，断言 `win:state` 推送；窗口几何、页面可见性等平台相关项按降级策略输出警告而非失败。

## 目录即数据目录

本目录同时是应用的**工作目录**（cwd = 数据目录）：`config.json` / `sessions/` / `mcp.json` / `audit.log` 都落在这里。
因此它们被 `.gitignore` 忽略——每台机器自行生成，**不要把本机的运行状态提交进仓库**。

## 跑法（三个终端）

```bash
# 终端 1：mock 模型服务器（端口 18099）
cd journeys && node mock-openai.mjs

# 终端 2：以本目录为工作目录启动应用（CDP 端口 9226）
cd journeys && npx electron --remote-debugging-port=9226 ../dist/src/electron/main.js

# 终端 3：跑 16 段旅程
cd journeys && node e2e-journeys.mjs
```

跑完收尾：杀掉 electron 与 mock 进程（`taskkill //F //IM electron.exe`）。

## 重跑前必做（否则断言会假失败）

1. **清空 `sessions/`**：遗留会话会让 J8 的"搜索过滤到唯一会话"断言失败（历史教训）。
2. **确认 `mcp.json` 存在且路径正确**（被 gitignore，新机器需手动创建）：

   ```json
   {
     "mcpServers": {
       "mock": {
         "command": "node",
         "args": ["../dist/scripts/mock-mcp-server.js"],
         "approval": "never"
       }
     }
   }
   ```

   相对路径从 journeys 目录解析。此前曾有写死开发者本机绝对路径（`E:/ximo2/...`）导致 MCP 旅程在别的机器必挂的教训。
