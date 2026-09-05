# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。所有对外行为变化（IPC 通道、事件 payload、插件协议、错误码）都必须记录在此。

## [0.5.4] - 2026-09-05（自动更新安装目录定位与私有仓库 Token 修复，何惜）

### 修复
- **桌面快捷方式启动时读取配置文件失败导致自动更新被静默关闭的 Bug**：
  - 修复 `main.ts` 写死 `process.cwd()` 导致从桌面快捷方式启动时工作目录飘至用户根目录的问题；
  - 引入智能目录判定：打包安装环境优先使用 `path.dirname(process.execPath)` 定位配置与数据，确保准确读取 `config.json` 中的 `autoUpdate.enabled`；
  - 自动从 Windows 系统/用户环境变量映射读取 `GH_TOKEN` 注入 `process.env`，彻底解决私有 GitHub Releases 401 权限校验失败问题。

## [0.5.3] - 2026-09-05（响应速度与 Prompt 缓存极致优化，何惜）

### 性能优化与体验增强
- **网络层持久化连接池（HTTP Keep-Alive）**：
  - OpenAI 兼容接口请求头增加 `Connection: keep-alive`，实现 TCP/TLS 长连接复用；
  - 彻底消灭多轮工具循环中重复握手建立连接的 300~800ms 往返网络时延。
- **大模型前缀缓存（Prompt Cache）保活重构**：
  - 上下文整轮截断提示语由动态插值改为静态绝对固定文本（`（因上下文长度限制，较早的部分历史消息已被省略）`）；
  - 消除因截断数字漂移导致的 Prompt Cache 全盘击穿问题，使 DeepSeek、Claude 等大模型在多轮对话中能够 85%~95% 稳定命中前缀缓存，首字延迟（TTFT）大幅缩短。
- **渲染层流式打字 RAF 节流批处理**：
  - 前端收到文本分片由“逐字强刷 DOM 与强制回流”重构为基于 `requestAnimationFrame`（16ms 帧率节流）的批量写入与滚动更新；
  - 解决文字密集到达时主线程阻塞、光标卡顿与 CPU 高占用的问题，打字机流式输出流畅丝滑。
- **思维链实时透传支持**：
  - `OpenAICompatibleProvider` 增加对 `delta.reasoning_content` 的实时流式解析支持，DeepSeek-R1 等模型的思考过程即来即显，彻底告别盲等转圈。
- **推理强度平衡**：
  - `config.example.json` 将默认推理强度调整为更均衡的 `medium`，避免无脑最高思维链导致的首字漫长等待。

## [0.5.2] - 2026-09-05（UI 自动更新管理面板与下载流，何惜）

### 新增
- **常规设置页「软件版本更新」控制面板**：
  - 增加可视化的「自动检查更新」开关，支持运行时开启/关闭并自动持久化到 `config.json`；
  - 增加「检查更新」按钮，主动触发检测并实时展示状态标签（检查中/发现新版本/已是最新版/下载中/下载完成/出错）；
  - 发现新版本时弹出专属更新信息卡片，展示新版本号与发布说明，提供「立即下载更新」按钮；
  - 增加下载进度条（0-100% 百分比平滑流式推送），下载完成后自动转为「立即重启安装」按钮。
- **IPC 通道扩充**：
  - 新增 `set-auto-update-enabled` 通道，支持前端界面直接开启或关闭更新服务；
  - `updater-state` 事件全链路接入渲染进程响应，状态变化秒级同步。
- **单元测试补充**：
  - `tests/updater.test.ts` 补充 `setEnabled` 动态启停与配置文件持久化验证，测试总数增至 81 项。

## [0.5.1] - 2026-09-05（交互体验与模型配置增强，何惜）

### 新增
- **AI 决策 ABCD 交互选择弹窗系统**（`plugins/builtin/ask-user` + 原生液态玻璃模态框 `#choice-modal`）：
  - 任务面临多种技术方案、架构分歧或不确定需求时，AI 自动弹出液态玻璃选择卡片；
  - 清晰列出 A/B/C/D 选项，高亮【AI 推荐】发光徽标并附推荐理由；
  - 支持键盘快捷键一键选择（按 A/B/C/D 或 1/2/3/4 直接选中，Enter 确认，Esc 拒绝）；
  - 支持自定义自由输入补充意见，决策结果无缝回填给 Agent 循环继续执行。
- **一键拉取远程模型列表**：
  - 新增 `fetch-models` IPC 通道，自动请求端点 `/v1/models`；
  - 设置页增加 `[⚡ 一键拉取远程模型]` 按钮，一键把端点上全部模型自动导入并持久化。

### 修复
- **设置页“返回工作区”点击极其困难的 Bug**：修复 Electron 顶栏 48px 拖拽区域（`-webkit-app-region: drag`）与返回按钮点击判定冲突，增加 `-webkit-app-region: no-drag !important` 并扩大点击热区；
- **自定义模型切换报错与配置丢失 Bug**：修复下拉切换模型时漏传 `baseUrl` 导致 `E_INVALID_CONFIG` 报错并将已存 URL 刷成 undefined 的问题，实现平滑继承；
- **推理强度真实对接**：为 DeepSeek 和 OpenAI 兼容端点默认开启 `reasoning_effort` 参数透传，彻底解决此前被底层静默拦截的问题。

## [0.5.0] - 2026-08-30

> 本版本由三个轮次累积而成：知识库轮（Ljj041120）+ 模块化拆分轮（何惜）+ 维护轮（Ljj041120）。
> 发布内容按轮次分节如下；各轮详细报告见 `docs/CODE_REVIEW.md` 与 `docs/REFACTOR_REPORT.md`。

### 知识库轮（Ljj041120）

### 新增
- **kb 知识库插件**（`plugins/builtin/kb`，完全插件化，零底座改动）：
  - `kb.search`：本地知识库检索（query 留空 = 列清单与统计）；`kb.reindex` 强制重建索引；`kb.archive` 对话要点与方案一键沉淀归档至知识库并实时联动刷新索引
  - **代码感知切块**：.ts/.js/.py 按函数/类/装饰器等语法逻辑边界切，文档按标题/段落切；纯 JS，零原生依赖
  - **双路检索**：关键词（中文子串友好）+ 向量（OpenAI 兼容 `/v1/embeddings`）RRF 融合；embedding 服务不可用自动降级纯关键词，检索不断供
  - 设置项（富插件协议 v2）：`kbDir` / `chunking` / `embedEnabled` / `embedBaseUrl` / `embedModel`，默认预设 `VTXAI/vtx-embed-7M`（HF 超轻量代码 embedding）
  - 索引 `知识库/.kb-index.json` 自动构建与失效（mtime 对比），仓库附 `知识库/` 示例目录（3 篇文档）
- **本地 embedding 服务脚本**（`scripts/serve-vtx-embed.py`，`npm run serve:vtx`）：OpenAI 兼容的 `/v1/embeddings` 端点，自动拉取并加载 `VTXAI/vtx-embed-7M`，纯标准库 HTTP 服务零额外 Web 框架依赖
- 测试：`tests/kb.test.ts` 20 项（切块边界/余弦/关键词/RRF/索引新鲜度/归档沉淀联动/降级/加载器校验）

### 模块化拆分轮（何惜，PR #1）

详见 `docs/REFACTOR_REPORT.md`。本轮为大型重构 + 自动更新功能 + 若干修复；全部离线门禁与 16 段 E2E 通过。

### 重构
- **后端**：`agent-service.ts` 1287 行 → 293 行门面 + `types.ts` 与 7 个 `services/` 领域模块（全部 ≤300 行）；门面对 main/preload 的方法签名 100% 不变，running 锁与排队仲裁保留在门面
- **前端**：`renderer/app.js` 1284 行 → 145 行 ESM 主入口 + 10 个 `renderer/modules/` 模块（全部 ≤300 行）；index.html 切换 `<script type="module">`（无构建约束下的方案对比后选定）

### 新增
- **自动更新**（Roadmap，默认关闭）：`src/electron/updater.ts` + IPC 四通道（check/download/install/get-updater-state）+ `updater-state` 推送；强制 `autoDownload=false`、`autoInstallOnAppQuit=false`，下载与安装均需用户确认，无静默路径；`config.json` `autoUpdate.enabled` 控制
- **CI 窗口自测**：test job 增加 `Window selftest`（仅 Windows runner）+ `timeout-minutes: 10`——win32「逻辑最大化」分支首次获得 CI 防线
- **journeys J16 窗控旅程**：最大化/还原/最小化/关闭 + `win:state` 推送断言；平台相关项警告降级，README 更新为 16 段

### 修复
- `JOURNEY-README-MARKER` 在 50e7d5a 文档清理中被误删导致全量 E2E 从 J3 起必挂：按 3e4f567 原版式恢复
- 错误码扫描器写死旧路径，拆分后防线失效（后端使用 19→6、UI 覆盖 22→0）：改为扫描 `src/electron/services/*.ts` 与 `renderer/modules/*.js`，恢复 22/19/22
- J8 会话切换竞态：`onLoopDone` 将 `setBusy(false)` 提前到文本渲染之前，消除 E2E 观察窗口期的忙态吞切换
- 会话内联改名 commit 双触发（Enter+blur）二次 remove 抛 NotFoundError：加一次性提交守卫
- electron-updater 的 `autoUpdater` 为懒加载 getter 导出，ESM 命名导入致应用启动即崩：改默认导入 + 解构（该崩溃仅 E2E 真实启动可捕获，test:window 独立入口不加载 main.ts）
- `electron-builder.yml` publish owner/repo 修正为 noeticforge/noeticforge（原 agent-base 与实际仓库不符）；补 `private: true`（私有仓库必须）
- `scripts/ipc-selftest.ts` 纳入 updater 4 通道，接线完整性检查 58 → 66 通道

### 维护轮（Ljj041120）

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
