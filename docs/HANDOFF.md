# 接力开发指南（Handoff）

> 给下一位开发者：这份文档让你在 30 分钟内掌握"怎么跑、怎么测、哪里不能碰"。
> 深度背景见 `docs/DEVELOPMENT_PLAN.md`（战略路线）与两份协议文档（接口契约）。
>
> **🤖 AI 代理进场第一读**：任何 AI 编码代理接入本项目，**先完整读本文件再动代码**——
> §〇 是最近一次交付快照，§四 铁律与 §五 已知边界是硬约束；读完按 §二 跑一遍防线验证环境。（规则同样写入根目录 `AGENTS.md` §0）

## 〇、最新一轮交付快照（v0.7.3，2026-09-09，ZCode 协作）

**主线：主进程崩溃日志落盘**（了结 DEVELOPMENT_PLAN §3.6-3 / v0.6.0 快照下一轮建议②）：

- 新模块 `src/electron/crash-log.ts`：`uncaughtException` 记录后按原语义退出（与无 handler 时的崩溃行为一致，只是留下证据）、
  `unhandledRejection` 记录后存活；报告（ISO 时间戳 + 应用/Node 版本 + 平台架构 + 堆栈）追加至数据目录 `crash.log`；
  超 512KB 自动截断；写盘失败静默（兜底路径禁止二次异常）。模块零 electron 依赖，`main.ts` 在数据目录解析后第一时间安装。
- IPC 协议 / 错误码零改动，不触发契约先行流程；新增 10 项 vitest 单测。

**本轮验证**：五条防线本地全绿（build / smoke 24 / unit **139** / ipc **94 断言·72 通道** / codes / window 7 项）；
journeys E2E 本轮未重跑（改动不触及对话链路，main.ts 仅新增 3 行接线）。

**此前两轮（v0.7.0–v0.7.2 + Ultra 旗舰版，2026-09-08，Ljj041120 / 何惜，明细见 CHANGELOG）**：
插件协议 parallelSafe / 设置页 / 子代理角色 → 发布流水线竞态修复 + RELEASE_NOTES 自动生成 + 私有仓库 404 可行动提示 →
完全访问免审批 / 工具聚合折叠盒 / Claude Code 风格流光思考胶囊（`renderer/modules/thought-module.js` 独立模块）/
WebGL2 推理力度滑块 / 四大艺术主题 / 官方插件注册表（真实 SHA-256）/ 用户配置物理隔离 Roaming；
registry.json downloadUrl 已全部指向公开仓库 raw 地址（**仓库已转公开，插件市场免认证**）。

**下一轮建议（沿 v0.6.0 清单收敛，②已了结）**：
① `live:check` 真模型联测（最老欠案，需真实 API Key）；
③ 生态最后一公里：SDK 发 npm / `npm create` 脚手架 / 文档站——M3 门槛「3 个外部插件」仍是唯一未达标核心验收；
④ 插件沙箱（utilityProcess）与签名排 v1.0（等有外部插件再动）。

### 前轮快照存档（v0.6.0，2026-09-06，Ljj041120 / ZCode 协作）

**主线：上下文摘要压缩 v2**（完整设计与验证数据见 `docs/CONTEXT_COMPACTION_REPORT.md`）：

- 超预算旧轮摘要**做一次就留底**：持久化于 `session.meta.compaction`（`{upTo, summary, updatedAt}`），
  复用期间零 LLM 调用；仅"丢弃边界增长"时增量重写（旧摘要并入新摘要，上下文不丢）；
- 复用期发给模型的前缀**逐字节稳定**（Prompt Cache 命中，IPC 自测有逐字节断言）；
  磁盘历史保持全量契约不变；`core/loop.ts` 零改动；
- `summarize` 开关（config.json，默认 true，false 退回纯截断）+ `context-compacted` 推送（协议 §7.5）+ UI 单行提示；
- 注意边界：`meta.compaction.upTo` 依赖历史 append-only（`replaceMessages` 只许追加尾部，见 §五）。

**验证与发布状态**：本地七项防线全绿（build / typecheck / smoke 24 / unit **85** / ipc **94 断言·72 通道** / codes / window）；
journeys E2E 16 段 **23/23 全绿**；代码审查未发现新缺陷。已推送 main 并发布 **GitHub Release v0.6.0**（9 资产，正式版）。

**本轮顺带修的既有问题**：journeys harness 适配 v0.5.7 自动起标题——v0.5.7 修 `isUntitled` 后默认会话每轮被起标题，
mock 兜底回显把会话改成乱码名（J8 失配）、后台标题请求覆盖 J11 的请求捕获文件；journeys 自 v0.5.0 时代后无人重跑故未暴露，
**非 v0.6.0 引入**。修法：mock 对标题请求恒回「默认会话」且不写 `last-request.json`（详见 `journeys/mock-openai.mjs` 注释与 journeys/README）。

## 一、30 秒跑起来

```bash
npm install                          # 国内网络先 set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build
npm run electron                     # 桌面应用（UI 里配置模型即可对话）

# 可选：一键启动本地知识库向量服务（VTXAI/vtx-embed-7M 4.7MB，自动缓存）
npm run serve:vtx                    # 启动 http://127.0.0.1:8000/v1/embeddings
```

## 二、五条测试防线（改代码必跑，CI 会卡）

| 命令 | 测什么 | 需要 |
|---|---|---|
| `npm run smoke` | 循环引擎 + providers 多模态转换 + 严格网关兼容 + 终端后端 | 无（离线） |
| `npm run test:unit` | vitest 单元测试 139 项（上下文裁剪/增量摘要压缩/Schema/注册表/会话存储/Provider 流解析/知识库 kb/崩溃兜底） | 无（离线） |
| `npm run test:ipc` | IPC 协议 94 项断言（含权限模式/排队/压缩复用与前缀稳定/子代理/MCP/通道接线完整性） | 无（离线） |
| `npm run test:window` | 窗口控制（最小化/最大化/关闭/状态推送） | 桌面环境（**CI 不跑此防线**，必须本地验证） |
| `npm run check:codes` | 错误码三方一致（事实源=协议文档=UI 文案） | 无（离线） |

**用户视角端到端**（模拟真实模型 + 驱动真实 UI，16 段旅程覆盖全部功能）：

```bash
# 终端 1：mock 模型服务器（模拟 DeepSeek/OpenAI 的流式与非流式）
cd journeys && node mock-openai.mjs
# 终端 2：以 journeys 为工作目录启动应用
cd journeys && "node_modules 里的 electron" --remote-debugging-port=9226 <项目>/dist/src/electron/main.js
# 终端 3：跑 16 段旅程
cd journeys && node e2e-journeys.mjs
```

 journeys 覆盖：模型配置 UI / 流式对话 / 读取·写入·命令工具 / diff 审批 / **改参批准** / 拒绝回喂 / 消息排队 / 会话增删改查+搜索 / 权限四模式（计划模式真拦截）/ 推理力度 / @ 引用注入 / MCP 真实执行 / 子代理 / 终端 / 主题持久化 / 重启后历史重建。

## 三、架构一页图

```
renderer/（UI，可整体替换）── window.agentBase（IPC 协议，docs/IPC_EVENT_PROTOCOL.md）──┐
                                                                                        ▼
src/electron/main.ts（薄转发 + 窗控 + 终端 + 附件对话框）
src/electron/agent-service.ts（全部业务：会话/策略/队列/压缩/子代理/审计）──► core/loop.ts（心脏，勿动）
src/providers/registry.ts（模型注册表）    src/mcp/manager.ts（MCP 桥）    src/plugins/loader.ts（插件；内置含 kb 知识库检索）
```

## 四、改代码前必读（铁律）

1. **契约先行**：动 IPC 通道/事件/插件协议，先改 `docs/` 协议文档再动码（CONTRIBUTING 铁律 1）
2. **`core/loop.ts` 不认识任何具体工具/模型/UI** —— 往里加业务 = 打回
3. **新增 IPC 通道三件套缺一不可**：preload 声明 + main `handle()` + service 方法。`test:ipc` 的"通道接线完整性"检查会自动抓漏（当前 72 通道；历史教训：v0.4 曾漏注册导致对话全挂）
4. **错误码**只能出自 `src/shared/error-codes.ts`（check:codes 强制同步三方）
5. 工具路径用 `ctx.workingDir`，禁 `process.cwd()`；插件必须 try/catch 返回 ToolResult

## 五、已知边界（接力时别踩）

- **沙箱**：声明式信任 + 审批 + MCP stdio 进程隔离；`preview-file`/`read-attachment`/`@` 可读任意绝对路径（信任渲染进程）。插件受控执行 API 在 Roadmap
- **终端**：非 PTY——交互式全屏程序（vim/top）不支持
- **win32 窗口最大化**：透明无边框窗口原生 `maximize()` 失效，底座在 win32 用逻辑最大化（`setBounds(工作区)` + 手工维护状态，`win:state` 推送语义不变）。Win+方向键等系统级窗口操作与逻辑状态可能短暂不同步（见 `docs/CODE_REVIEW.md` F1）
- **Anthropic + 推理力度**：带工具历史的请求自动不透传 thinking（API 协议限制，底座不存储 thinking 块）；首轮无工具历史时正常透传
- **上下文摘要压缩（v0.6）**：超 `contextTokenBudget` 时被丢弃旧轮增量摘要留底，记录持久化于 `session.meta.compaction`（`upTo` 依赖历史 append-only——`replaceMessages` 只允许追加尾部，勿破坏该约定）；`summarize: false` 可关闭；完整历史永不改写，压缩只影响发给模型的内容
- **reasoning_effort**：OpenAI 兼容端点需 config.json `"enableReasoningEffort": true` 才透传（严格网关兼容）；Anthropic 恒透传 thinking
- **打包**：`npm run dist` 产出 release/win-unpacked；应用 cwd 即数据目录（config.json/sessions/audit.log 所在）
- **测试注意**：journeys 依赖 18099/9226 端口，重跑前杀干净旧进程（`taskkill //F //IM electron.exe` + 按端口杀）**并清空 `journeys/sessions/`**（遗留会话会让 J8 的会话数断言失败）；`journeys/mcp.json` 被 gitignore，新机器需自行创建（`{"mcpServers":{"mock":{"command":"node","args":["../dist/scripts/mock-mcp-server.js"],"approval":"never"}}}`，相对路径从 journeys 目录解析）；mock 是无状态按内容路由的，改路由先想"工具结果回来后模型该怎么收尾"

## 六、历史沿革与 v0.5.0 交接存档（原根目录 `handoff.md` 合并入此，2026-09-06）

> 以下为 2026-08-30 一次性交接文档的存档（原文自述"读完即可删除"，已合并至此并删除源文件）。
> 部分状态自当时已演进，演进点以 **（→ 现状）** 标注。

### 沿革

- 项目从原开发者的压缩包（xmh.zip）提取，**原开发者署名匿名**（git 历史 `agent-base <dev@agent-base.local>`，交付文档即"何惜"），git 历史完整保留；
- 项目归属 **noeticforge** 组织，维护者 [@Ljj041120](https://github.com/Ljj041120)；v0.5.0 起新提交以 Ljj041120 身份署名；
- 三轮开发定版 v0.5.0：**维护轮**（全量代码审查 + 8 项 bug 修复 + vitest 单测层，见 `docs/CODE_REVIEW.md`）→ **模块化拆分轮**（PR #1，agent-service/app.js 全部 ≤300 行 + electron-updater 自动更新默认关 + CI 窗口自测 + J16，见 `docs/REFACTOR_REPORT.md`）→ **知识库轮**（kb 插件，零底座改动）。

### kb 插件要点（知识库轮）

- 完全插件化（`plugins/builtin/kb`），底座零改动：`kb.search`（检索）/ `kb.reindex`（强制重建）/ `kb.archive`（对话要点沉淀至 `知识库/会话归档/`，自动刷新索引立即可查）；
- 代码感知切块：.ts/.js/.py 按**函数/类/装饰器语法边界**（纯 JS 零原生依赖），文档按标题/段落；
- 双路检索：关键词（中文子串）+ 向量（OpenAI 兼容 `/v1/embeddings`，默认预设 **VTXAI/vtx-embed-7M**，`npm run serve:vtx` 一键本地启动 8000 端口）RRF 融合；**embedding 不在线自动降级纯关键词，检索永不断供**；
- 设置项（插件设置页）：kbDir / chunking / embedEnabled / embedBaseUrl / embedModel；索引 `知识库/.kb-index.json` 自动失效重建。

### 维护轮修复 F1~F8（细节见 `docs/CODE_REVIEW.md`）

F1 win32 透明无边框窗口原生 maximize 静默失效 → 逻辑最大化；F2 mcp.json `enabled:false` 的 server 运行中启用永不连接；F3 损坏插件 zip 击穿"handler 永不 throw"契约；F4 Anthropic thinking + 工具历史第二轮必 400 → 自动降级不透传；F5 纯空白消息绕过校验；F6 "当前模型"从未存储；F7 自动起标题覆盖手动改名；F8 Windows 停终端不杀子进程树 → `taskkill /T /F`。

### 仓库现状备忘（2026-08-30 快照）

- 远端 **https://github.com/noeticforge/noeticforge**（私有）；git 身份 `user.name=Ljj041120`（新提交自动归属维护者）；
- **网络环境备忘**：本机访问 GitHub API（api.github.com）直连易超时，走本地代理 `http://127.0.0.1:7897`（Clash 混合端口）；git push 主站通道不受影响；
- **（→ 现状）**"test:window 不在 CI"已过时：v0.5.x 起 CI test job 已含 Windows 窗口自测；journeys E2E 仍需本地手跑（2026-09-06 已全绿验证一轮，见 §〇）。
