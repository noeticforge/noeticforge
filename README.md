# agent-base

开源、Agent 优先、治理强的**桌面端 AI Agent 壳**。技术栈：**TypeScript + Node.js + Electron**。
愿景与路线图见 [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md)；[贡献指南](CONTRIBUTING.md)。

## 你拿到的是什么

```
src/
├── types.ts                  全局类型契约（消息/工具/插件/事件/审批）
├── shared/error-codes.ts     错误码单一事实源（CI 强制与文档/UI 同步）
├── providers/
│   ├── registry.ts           Provider 注册表（openai-compatible 通用预设 + 三家内置）
│   ├── openai-compatible.ts  DeepSeek / OpenAI / Ollama / 智谱… 一切兼容厂商（SSE 流式 + 可中断）
│   ├── anthropic.ts          Anthropic Messages API（SSE 流式）
│   └── mock.ts               脚本化假模型（测试用，不联网）
├── core/
│   ├── loop.ts               Agent 循环引擎（心脏：工具/模型/UI 三无关 + 三道安全关卡）
│   ├── context.ts            上下文预算与整轮截断（只影响发给模型的内容）
│   ├── session-store.ts      多会话持久化（每会话一 JSON，原子写）
│   ├── registry.ts           工具注册表
│   └── errors.ts             结构化循环错误（AgentLoopError）
├── plugins/loader.ts         插件加载器（manifest/协议版本校验 + 动态 import + 热更新缓存穿透）
├── mcp/manager.ts            MCP 客户端桥（stdio/HTTP、注解→审批映射、断线重连）
└── electron/
    ├── agent-service.ts      IPC 事件协议完整业务实现（不含 Electron API，可独立自测）
    ├── main.ts               Electron 主进程（ipcMain 薄转发层）
    └── preload.ts            contextBridge 暴露 window.agentBase（UI 唯一入口）

renderer/                     桌面 UI（会话侧栏/流式聊天/Markdown/审批弹窗/插件与 MCP 管理/模型配置）
plugins/builtin/              内置插件（read-file / write-file，审批钩子演示）
plugins/user/                 用户插件安装位置        plugins/settings/ 插件设置值
sdk/                          @agent-base/sdk：插件作者的类型与 definePlugin
templates/plugin-basic/       插件模板（5 分钟出第一个插件）
registry/                     插件注册表（PR 投稿 + sha256 校验）
scripts/                      smoke / ipc-selftest / mock-mcp-server / live-check
docs/                         协议文档 + 交付文档 + 开发规划
```

## 快速开始

```bash
npm install        # 国内网络：先 set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build

npm run smoke        # 循环链路冒烟（无需 API Key）
npm run test:ipc     # IPC 协议自测（无需 API Key / GUI，含 MCP mock 全链路）
npm run check:codes  # 错误码三方一致性校验

npm run electron     # 桌面应用

# 真实模型链路自检（配好 config.json 后）
npm run live:check            # 非流式 + 流式
npm run live:check -- --tools # 加测工具调用解析

# 或终端直聊
cp config.example.json config.json   # 填入 apiKey
npm run cli
```

## 换模型 = 改配置（或 UI 里点一下）

```jsonc
// config.json
{ "provider": "deepseek", "apiKey": "sk-...", "model": "deepseek-chat" }

// 任意 OpenAI 兼容端点（Ollama / LM Studio / 智谱 / 通义 / 月之暗面…）即插：
{ "provider": "openai-compatible", "apiKey": "ollama", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3" }

// 可选策略字段
{
  "contextTokenBudget": 24000,          // 上下文 token 预算（估算），超限从最旧整轮截断
  "allowedPermissions": ["fs:read"],    // 运行时权限白名单（缺省全放行）
  "forceApprovalPermissions": ["fs:write"], // 命中即强制审批（覆盖插件声明）
  "pluginRegistryUrl": "https://…/registry.json" // 插件注册表索引
}
```

## 接 MCP 工具生态

项目根目录 `mcp.json`（与 Claude Desktop 格式兼容）：

```jsonc
{
  "mcpServers": {
    "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/docs"] },
    "docs": { "url": "http://127.0.0.1:3000/mcp", "approval": "auto" }
  }
}
```

- 每个工具桥接为 `mcp.<server>.<工具名>`，经 stdio **子进程隔离**执行；
- 审批默认策略：`readOnlyHint` 工具免审批，其余需用户批准（`approval` 字段与按工具覆盖可调）；
- 断线自动指数退避重连；server 崩溃转为错误结果回喂模型，循环不中断。

## 写一个新插件（30 秒版）

1. 复制 `templates/plugin-basic/`，改掉插件名；
2. `npx tsc -p tsconfig.json` 编译出 `dist/index.js`；
3. UI「插件与 MCP」里安装（或 IPC `install-plugin`）。

工具名必须以插件名开头；工具权限必须是 manifest 声明的子集；`requiresApproval: true` 的工具执行前必须用户批准。
富插件能力（`protocolVersion` / `settings` 设置页 / 生命周期钩子 / `render` 渲染提示）见 `docs/PLUGIN_PROTOCOL.md` §7；
类型与 `definePlugin` 用 `sdk/`（`@agent-base/sdk`）。

## UI 开发者（渲染进程）怎么接

1. 只允许通过 `window.agentBase`（preload 注入）与底座通信；通道与 payload 见 `docs/IPC_EVENT_PROTOCOL.md`（协议版本 `window.agentBase.protocolVersion`）
2. 全部通道：循环 4 + 插件 6 + 会话 5 + 模型 2 + MCP 3（invoke），推送 9 个（含 `sessions-changed` / `mcp-status-changed`）
3. invoke 返回统一包装 `{ok:true,data} | {ok:false,error:{code,message,phase}}`，按 `error.code` 出文案（码表 `src/shared/error-codes.ts`，CI 校验三方同步）
4. 底座零改动替换整个 `renderer/`

## 核心设计约束（改代码前必读）

- **循环引擎不认识任何具体工具/模型/UI**，只认 `LLMProvider` 和 `ToolRegistry` 两个接口
- **底座不认识任何具体模型厂商**：Provider 走注册表，接新厂商 = `registerProviderFactory` 一行
- **插件崩了不许拖垮主进程**：加载失败跳过并记录，执行异常转错误结果喂回模型自愈
- **工具执行前三道关卡**：① 运行时权限白名单 → ② 审批（批准可改参/拒绝可填原因）→ ③ 参数 JSON Schema 校验（ajv）；三关失败都是错误结果喂回模型，不崩循环
- **权限模型的边界（重要，别对文档吹牛）**：当前是「声明式信任模型」，进程内插件**没有沙箱**；进程隔离主力是 MCP stdio 子进程（见 `docs/PLUGIN_PROTOCOL.md` §4.6 / `registry/README.md`）
- **IPC handler 永不 throw**：全部异常转 `{ok:false,error}`（协议 §6.4）
- 工具相对路径以注入的 `ctx.workingDir` 为基准，**不要用 `process.cwd()`**
- 全部对外行为走事件流：循环层 `LoopEvent` ↔ IPC 推送逐条对应（`docs/IPC_EVENT_PROTOCOL.md`）

## Roadmap

- [x] Provider 层（统一接口 + SSE 流式 + 可中断）与注册表化（openai-compatible 即插任意兼容端点）
- [x] Agent 循环 + 工具注册表 + 审批钩子 + 安全三道关卡
- [x] 插件加载器（校验 / 热装卸 / 缓存穿透）+ 富插件协议 v2（protocolVersion / settings / 钩子 / render）
- [x] 多会话持久化 + 上下文整轮截断 + 自动起标题
- [x] MCP 客户端桥（stdio/HTTP、注解→审批映射、断线重连）+ 审计日志
- [x] Anthropic 流式 + max_tokens 配置化
- [x] 插件 SDK / 模板 / registry（PR 投稿 + sha256）
- [ ] electron-builder 打包分发与自动更新（配置已备，首次发布待签名策略定夺）
- [ ] 插件受控执行 API（带权限校验的文件句柄）与 utilityProcess 进程池
- [ ] 插件签名（minisign/Sigstore）与信任分级
