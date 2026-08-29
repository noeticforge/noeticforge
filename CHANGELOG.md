# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。所有对外行为变化（IPC 通道、事件 payload、插件协议、错误码）都必须记录在此。

## [未发布]（维护轮次：测试覆盖 + 代码审查，维护者 Ljj041120）

详见 `docs/CODE_REVIEW.md`。本轮为维护性修改：只修问题、补测试，无新功能。

### 修复
- **win32 透明无边框窗口无法最大化**：Electron 对 `transparent:true` 窗口的 `maximize()` 静默失效（`test:window` 基线失败暴露）。win32 改为逻辑最大化（记录原 bounds → `setBounds(工作区)`），`win:state` 推送语义不变；非 win32 保持原生行为
- **MCP：`mcp.json` 初始 `enabled:false` 的 server 运行中启用永不连接**：`setConfig` 把禁用占位连接误判为已存在；现在占位（closed）也走连接流程
- **损坏的插件 zip 击穿「handler 永不 throw」契约**：`install-plugin-from-registry` 的解压异常转 `E_PLUGIN_LOAD_FAILED`；`install-plugin` 的 `stat` 竞态加守卫；manifest 非法 JSON 归类为校验失败
- **Anthropic 推理力度（thinking）+ 工具历史第二轮必 400**：API 要求带 `tool_use` 的 assistant 消息携带 thinking 块而底座不存储 thinking；现对含工具历史的请求自动降级不透传 thinking（首轮照常）
- 纯空白文本消息绕过非空校验直发模型；自动起标题覆盖用户手动改名；Windows 停止终端不杀子进程树（`taskkill /T /F`）
- 版本号同源 `package.json`（CLI 横幅硬编码 v0.1.0、`APP_VERSION` 双写清除）；`get-app-info.model` 改为真实记录的当前模型（此前用 `models[0]` 猜测）

### 新增
- **vitest 单元测试层**（`npm run test:unit`，49 项）：循环上下文裁剪 / 参数 Schema / 工具注册表 / 会话存储 / 全局类型 / 错误码 / OpenAI 与 Anthropic 的消息转换与 SSE 流解析（mock fetch）
- CI 增加 `npm run test:unit`；矩阵调整为 Node 22 / 24（移除已 EOL 的 18 与 20，vitest 4 要求 Node ≥ 20.12），`engines.node` 提到 `>=22`（CI 覆盖的两个版本线，22 为维护者开发机版本）

### 测试基建说明
- `test:window` 不在 CI（无头环境）：必须本地跑，本轮它抓到了 win32 最大化 bug
- journeys E2E 重跑前清空 `journeys/sessions/`（遗留会话会让 J8 的会话数断言失败）；`journeys/mcp.json` 被 gitignore，新机器需自行创建（`node ../dist/scripts/mock-mcp-server.js` 相对路径可用）

### 修复（v0.4 深度审查批次，历史记录）
- **对话全挂的根因**：渲染层 send-message 发裸消息对象，而协议要求 `{ message, sessionId }` 包装——所有普通文本消息被误判 E_INVALID_MESSAGE；已修正并补端到端验证（mock OpenAI 服务器 + 真实 UI 全链路）
- 排队的多模态消息被 JSON.stringify 成字符串（出队后图片丢失）→ 队列保存原始分片
- deleteSession 不清队列 + runLoopTask 空会话非空断言 → 竞态下主进程崩溃风险；两侧加守卫
- reasoning_effort 透传改为 **opt-in**（config.json `enableReasoningEffort: true`）：默认不发送，严格网关不再 400（Anthropic thinking 不受影响）
- 退出不杀终端子进程（孤儿 cmd.exe）→ before-quit 兜底
- listWorkspaceFiles 根层遍历 node_modules → 任何层级跳过
- 中止/报错时当轮用户消息不落盘 → catch 路径补落盘
- 附件发送失败不回滚 → 失败后附件与文本还给输入框
- diff 行号错算 → 正确双侧行号 + 中段上下文折叠
- @ 选择器竞态（迟到响应覆盖新菜单）→ 序号守卫
- 进程卡同名工具状态互串 → 按 toolCallId 配对
- safeParseJson 兜底：模型流式参数夹带裸换行（非法 JSON）时转义重试（DeepSeek 历史问题）
- 协议文档补齐 §8（策略/附件/终端/子代理/持久化语义）；registry/README 信任边界补充
- preload sendMessage 类型对齐协议（多模态 content + contextFiles）

### 新增（v0.4 对标补齐批次）
- **子代理编排**：`subagent.run` 工具把子任务委托给隔离的 Agent 循环——子代理拥有全部工具但禁止嵌套派生，工具审批透传到主对话，事件内联可视化；`core-` 前缀插件不可卸载
- **@ 上下文引用**：输入 `@` 弹出工作目录文件选择菜单（可下钻目录），发送时文件内容自动注入消息尾部（≤5 个文件，单文件 2 万字符）
- **附件与图片输入（多模态）**：`＋→添加附件`（≤4 个，图片 ≤5MB/文本 ≤400KB）；消息内容升级为多模态分片（OpenAI image_url / Anthropic base64 双格式转换）
- **内置终端面板**：右侧「终端」标签页，持久 shell 会话（cmd/$SHELL）、输出实时推流、历史截断保护
- **真·推理力度**：低/高/最高 → OpenAI 兼容 `reasoning_effort`、Anthropic `thinking` 预算（2k/8k/16k，自动抬高 max_tokens）

### 新增（v0.3 批次，同发布）
- **AGENTS.md 分层提示**：`~/.agent-base/AGENTS.md`（全局）+ 项目根 `AGENTS.md`（项目），自动合并进系统提示，每轮发送时读取、改文件即生效
- **消息排队**：会话循环进行中继续发送不再拒绝，自动排队（消息带"已排队"徽标），循环结束后按序续发；stop 会清空队列
- **上下文压缩**：超过 token 预算时把较旧轮次经一次模型调用压成要点摘要（磁盘历史保持全量），摘要失败回退整轮截断
- **官方插件 shell-exec**：执行 shell 命令（超时控制 + 输出截断 + `requiresApproval` 强制审批）
- **官方插件 web-fetch**：抓取 HTTP/HTTPS 网页与只读接口（20s 超时、二进制跳过、截断保护）
- **写文件审批 diff 预览**：`write-file.write` 审批时展示行级差异（LCS diff，+N/−N 统计，新文件显示行数徽标）；新增 `preview-file` 通道
- **anthropic-compatible 供应商**：任意 Anthropic Messages 格式端点即插（自建网关场景）
- 工具行摘要：多行参数显示 `[N 行]` 行数而非内容；打包产物 release/win-unpacked

### 规划中（见 docs/DEVELOPMENT_PLAN.md）
- 子代理并行执行（当前串行委派）；@ 引用的目录级递归注入
- 终端 PTY 化（交互式程序支持）；插件受控执行 API / utilityProcess 进程池；插件签名与信任分级

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
