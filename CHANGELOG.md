# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。所有对外行为变化（IPC 通道、事件 payload、插件协议、错误码）都必须记录在此。

## [未发布]

### 规划中（见 docs/DEVELOPMENT_PLAN.md）
- electron-builder 首次打包发布与自动更新（配置已备）
- 插件受控执行 API / utilityProcess 进程池；插件签名与信任分级

## [0.3.0] - 2026-08

### 新增
- **MCP 客户端桥**：stdio/StreamableHTTP 双传输；`mcp.json` 与 Claude Desktop 格式兼容；注解→审批映射（readOnlyHint 免审批，其余默认审批）；断线指数退避重连；server 崩溃转错误结果回喂模型；新增 IPC 通道 `list-mcp-servers` / `set-mcp-config` / `toggle-mcp-server` 与推送 `mcp-status-changed`
- **Anthropic SSE 流式**（text_delta / input_json_delta 分片拼接）+ `maxTokens` 配置化
- **审计日志**：工具执行与审批决定落 `audit.log`（JSONL）
- **富插件协议 v2**：manifest `protocolVersion` 校验、`settings` 设置页 Schema（值注入 `ctx.settings`）、`onInstall`/`onUninstall` 生命周期钩子、`ToolResult.render` 渲染提示（markdown 等，UI 端消毒）
- **插件生态基建**：`sdk/`（@agent-base/sdk 类型 + definePlugin）、`templates/plugin-basic/` 模板、`registry/`（PR 投稿 + sha256 校验）与 `install-plugin-from-registry` 通道
- IPC 新增：`get-plugin-settings` / `set-plugin-settings` / `install-plugin-from-registry`

### 变更
- 错误码重构：`src/shared/error-codes.ts` 单一事实源 + `npm run check:codes` 三方一致性 CI 校验；v0.1 文档预留的 6 个未实现错误码正式废弃
- 循环错误结构化（`AgentLoopError`：`E_LLM_ERROR`/`E_MAX_ITERATIONS`），废除字符串匹配
- 内置插件禁止卸载（`E_PLUGIN_BUILTIN`），卸载只清理 `plugins/user/`
- 全部推送事件增加 `sessionId`；`send-message` 支持指定会话

## [0.2.0] - 2026-08

### 新增
- **多会话**：`SessionStore` 每会话一 JSON 原子落盘；会话 CRUD 通道（`list/create/switch/rename/delete-session`）+ 推送 `sessions-changed`；多会话并行循环（per-session 锁）；首轮对话自动起标题
- **上下文管理**：token 预算估算 + 整轮截断（默认 24000，`contextTokenBudget` 可配）；只影响发给模型的内容，持久化历史完整
- **Provider 注册表**：`openai-compatible` 通用预设（Ollama/LM Studio/智谱/通义/月之暗面即插）+ 新通道 `list-providers`；`set-model-config` 放宽为注册表校验
- **桌面 UI**：会话侧栏、Markdown 渲染（marked + DOMPurify 消毒）、MCP 状态面板、Provider 动态列表；`window.agentBase.protocolVersion` 协议版本协商

### 修复
- `loop-error` 错误码三方漂移（协议文档 21 / 后端 14 / UI 6 个失效）全面对齐

## [0.1.0] - 2026-08

首个可运行版本。

- Agent 循环引擎（工具调用 / 流式 / 可中断 / 审批钩子）
- Provider 适配层（DeepSeek / OpenAI / Anthropic + Mock）
- 插件加载器（manifest 校验 / 热装卸 / 缓存穿透）
- Electron 外壳 + IPC 事件协议 15 通道
- 安全三道关卡（权限白名单 / 强制审批 / 参数 Schema 校验）
- 测试页 renderer/ + 冒烟测试 + IPC 自测
