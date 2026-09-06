# agent-base 开发规划（Roadmap & Execution Plan）

> 制定日期：2026-08-29 ｜ 适用版本线：v0.1.x → v1.0
> 战略定位：**开源、Agent 优先、治理强**的桌面 Agent 壳。路径纪律：**产品 → 用户 → 插件作者 → 生态，顺序不可倒**。
> 本文是协作的正式接口：改协议先改文档；每个阶段有明确验收标准（Definition of Done），未过验收不进入下一阶段。
>
> **📋 对账注记（2026-09-06，Ljj041120，截至 v0.6.0）**：复选框已对照代码现状一次性对账——已完成项勾选并标注落地版本；
> 实现方式与规划有偏离的项在原句后补注记（不改正文语义）；仍未完成项保留 `[ ]` 并附现状一句话。
> §1 基线快照保留制定时原文。对外行为演进详见 `CHANGELOG.md`。

---

## 0. 战略路径总览

```
阶段0 项目地基          阶段1 MVP 产品化          阶段2 MCP 互操作           阶段3 生态基建
（1周）                 （2-5周）                 （6-10周）                （11-16周）
git/LICENSE/CI    →    打包安装包 + 真UI    →    MCP 客户端接入       →    插件SDK + 注册表 + 富插件协议
会话/上下文还债         多会话 + Provider 注册表     Anthropic 流式            沙箱收尾 + 社区运营
─────────────            ─────────────             ─────────────             ─────────────
产出：可协作的仓库        产出：v0.2 安装包           产出：v0.3（工具×1000）     产出：v0.4（第三方插件）
门槛：陌生人能跑通        门槛：10个陌生用户          门槛：跑通3个真实MCP服务     门槛：3个外部插件
```

**版本号约定**：v0.2 = MVP 产品；v0.3 = MCP；v0.4 = 生态基建；v1.0 = 三者齐 + 稳定协议。里程碑制而非日历制，排期按"全职当量 × 人周"估，兼职团队自行乘 1.5~2。

---

## 1. 现状基线（2026-08-29 精读结论）

> **维护轮次注记（2026-08，Ljj041120）**：本节是制定规划时的基线快照。上述"欠账"1/3/4/6/7/8 已在 v0.2-v0.4 偿还；
> 2026-08 维护轮次（测试覆盖 + 代码审查，见 `docs/CODE_REVIEW.md`）建立了 vitest 单元测试层并修复 8 项审查问题；
随后协作者何惜完成「模块化拆分轮」（大文件全部 ≤300 行 + electron-updater 自动更新，默认关闭，见 `docs/REFACTOR_REPORT.md`）；
维护者 Ljj041120 完成「知识库轮」（kb 插件：代码感知切块 + 关键词/向量双路检索，纯插件化零底座改动）。
> 2026-09 v0.5.x~v0.6.0（Ljj041120 / 何惜 协作）：官方插件市场与 registry、多会话并发、AI 深度思考胶囊、
> 上下文摘要压缩 v2 相继落地。基线 9 项欠账中 **#2（真模型流量联测）与 #9（apiKey 明文存储）至今仍未偿还**，
> 分别见 §3.1 现状注记与 v1.0 安全议题。

**已有资产（不要重写）：**
- 循环引擎 `loop.ts`（工具/模型/UI 三无关，三道安全关卡，测试覆盖安全场景）
- Provider 适配（OpenAI 兼容 SSE 流式已写好）、插件加载器（热装卸 + 缓存穿透）
- `AgentService` 业务层与 Electron 解耦，可脱离 GUI 自测
- IPC 协议 15 通道 + 两份协议文档 + 两条不联网测试链（smoke 20 项 / ipc 34 项）

**欠账（按风险排序）：**
1. 无 git / 无 LICENSE / 无 CI —— 开源项目第一天该有的都没有
2. 真模型流量从未打过（SSE 解析未验证）
3. 会话：全局单会话、history 无界增长、重启全丢
4. Provider 硬编码 3 家（`createProvider` switch），与"一切可插拔"自相矛盾
5. 无打包分发；UI 是测试页
6. 错误码三方漂移（协议文档 21 个 / 后端 14 个 / UI 映射表 6 个失效）
7. `loop-error` 错误码靠 `e.error.includes('迭代')` 字符串判定
8. uninstall-plugin 会删除 `plugins/builtin/`，卸载内置插件后重启不回来
9. apiKey 明文存 config.json

---

## 2. 阶段 0：项目地基（1 周，做完才许动代码）

| # | 任务 | 细化 | 验收 |
|---|---|---|---|
| 0.1 | git 仓库 | `git init` + GitHub（可同步 Gitee 镜像）；main 分支保护；PR 协作；commit 规范（feat/fix/docs/chore） | 代码全部入库，禁止再出现"只在一台机器上"的文件 |
| 0.2 | LICENSE | **MIT**（生态愿景下选最宽松，降低插件作者与企业试用顾虑；想保留商标另加 NOTICE） | 根目录 LICENSE 文件 |
| 0.3 | CI | GitHub Actions：push/PR 跑 `npm run build && npm run smoke && npm run test:ipc`；Node 18/20/22 矩阵 | 红了不许合入 |
| 0.4 | 协作文件 | CONTRIBUTING.md（跑测试命令 + 协议变更流程：**改 IPC/插件协议必须先改 docs/ 再改码**）、ISSUE 模板、CODEOWNERS | 外部人知道怎么提 PR |
| 0.5 | 发布纪律 | CHANGELOG.md + git tag + semver；从现在起每个合并进 main 的功能都在 CHANGELOG 记一笔 | — |
| 0.6 | 快速修复包（≤半天每个） | ① `loop-error` 错误码改为结构化传递（loop.ts 抛错带 `code` 字段，废除字符串匹配）② uninstall 禁止删除 `plugins/builtin/`（返回 `E_PLUGIN_BUILTIN`）③ 错误码三方对齐：以后端 14 个为准，更新协议文档 §6.2 与 renderer `ERR_TEXT`，文档中其余标"预留" | smoke/ipc 全绿 |

**阶段门槛：一个陌生人 clone → install → build → 两条测试全绿，且仓库 LICENSE/CONTRIBUTING 齐全。**

---

## 3. 阶段 1：MVP 产品化（2~5 周 → 发布 v0.2.0）

**目标一句话：一个陌生人下载安装包、填个 Key、能用它完成真实任务的桌面应用。**

### 3.1 真模型链路验证（0.5 周，最优先）
- 打 DeepSeek 真流量跑通流式 + 工具调用；OpenAI 次之。发现格式问题修 `openai-compatible.ts`。
- 新增 `scripts/live-check.ts`：环境变量 `AGENT_BASE_LIVE_KEY` 存在时执行真实请求自检（CI 不跑），覆盖：非流式 / 流式 / 流式中带 tool_calls 三种响应的解析断言。
- 顺手：Anthropic 的 `max_tokens` 从硬编码 8192 改为配置项（流式本身留到阶段 2）。

> **现状（2026-09-06）**：`scripts/live-check.ts` 已具备（`npm run live:check [-- --tools]`，覆盖非流式 / 流式 / 工具调用解析），
> 但**因从未配置真实 API Key，真模型联测至今未执行**（`handoff.md` 交接遗留第 4 项）——全项目最老的未销案欠账，优先级最高。

### 3.2 多会话 + 持久化 + 上下文管理（1~1.5 周，核心还债）
详细设计见 §8.1 / §8.2，任务拆解：
- [x] `SessionStore`（JSON 文件落盘 `userData/sessions/`，含 CRUD + 原子写）（v0.2）
- [x] `AgentService` 从单 `history` 改为按 sessionId 持有会话；`send-message` 带 `sessionId`（v0.2；v0.5.7 进一步解锁多会话并发）
- [x] IPC 新增通道：`list-sessions` / `create-session` / `switch-session` / `rename-session` / `delete-session`（协议升 **v0.2**，文档先行）
- [x] 循环前组装消息时按 token 预算裁剪 history（保 system + 完整近期轮次，丢弃整轮，不加半截）（v0.2；v0.6.0 升级为增量摘要压缩，见 §8.2）
- [x] 会话标题自动生成：首轮对话后用一次廉价调用起名（失败则取用户首句前 20 字）（v0.5.7 增强）
- [x] 扩展 `ipc-selftest`：会话 CRUD、切换后历史隔离、裁剪边界（构造超长 mock 会话断言裁剪点）

### 3.3 Provider 注册表化（0.5 周，兑现"一切可插拔"）
详细设计见 §8.3：
- [x] `registerProviderFactory(id, factory)` + 内置 `openai-compatible` 通用预设（任意 baseUrl+model）
- [x] deepseek/openai 变成 openai-compatible 的预设值；anthropic 独立保留
- [x] IPC：`set-model-config` 放开校验（provider 在注册表内即可）；新增 `list-providers`
- [x] UI：provider 下拉可输自定义（Ollama/LM Studio/智谱/通义/月之暗面 用通用预设即插）
- [x] 自测：注册表 + 未知 provider 拒绝 + 通用预设连通 mock server

### 3.4 UI 产品化（1.5~2 周，与 3.2/3.3 并行）
- [x] 技术栈定夺：**偏离原方案**——最终采用无框架无构建的原生 JS 模块化 UI（`renderer/app.js` + `modules/` 全部 ≤300 行），约束不变：只走 `window.agentBase`，禁直连 ipcRenderer；renderer 可整体替换
- [x] 页面清单：会话侧栏（列表/新建/重命名/删除）、聊天流（Markdown 渲染 + 代码高亮 + 打字机）、工具卡片、审批弹窗、插件管理、模型配置（含自定义 provider）、设置页（v0.2 起，后续版本持续增强至插件市场/更新面板/思考胶囊）
- [x] renderer 构建接入：**偏离原方案**——无构建（prod 直接 `loadFile` 本地文件），未引入 Vite dev server；换来零前端工具链
- [x] ~~`renderer/`（旧测试页）移入 `docs/reference-ui/` 保留~~ → **偏离**：旧测试页被直接重写为产品 UI，未归档（协议参考实现以 `docs/IPC_EVENT_PROTOCOL.md` + preload 为准）
- [x] UI 错误文案表以协议 §6.2 生成的常量为准（单一事实源：`shared/error-codes.ts`，`check:codes` CI 强制三方同步）

### 3.5 打包分发（0.5~1 周）
- [x] electron-builder：win NSIS 安装包 + portable；mac dmg（先不签名，README 注明右键打开）；linux AppImage（v0.5.0）
- [x] electron-updater + GitHub Releases 自动更新（默认关闭、无静默安装；v0.5.0 集成，v0.5.2/0.5.4 完善更新面板与安装目录定位）
- [x] 应用图标 + productName：**偏离**——产品名未另起，仍与 npm 包名同为 `agent-base`（解耦建议未采纳）
- [x] Release 流水线：tag → CI 构建 → Release 附安装包（`.github/workflows/release.yml`，win/mac/linux 三平台）

### 3.6 MVP 验收（Definition of Done）
- [ ] v0.2.0 三平台安装包发布到 GitHub Releases —— **现状**：v0.2.0 时代为纯代码版（零安装包）；安装包 + Release 流水线 v0.5.0 才具备，此后版本由 tag 流水线承接
- [ ] **10 个群外真实用户**安装并完成至少一次"带工具调用的任务"（发问卷/群友转发）—— **现状**：无追踪数据，未确认达成
- [ ] 崩溃率：主进程 0 未捕获异常（加 `process.on('uncaughtException')` 日志落盘）—— **现状**：未实现，`main.ts` 无 uncaughtException/unhandledRejection 兜底
- [ ] README 更新为"产品视角"（截图 + 下载链接），开发视角内容挪 CONTRIBUTING —— **现状**：README 经多轮更新（kb/市场/压缩）但仍以开发者视角为主，产品视角改版未做

> ⛔ **决策门 1**：若发布后 2 周、10 个外部用户目标落空 → 不许继续造平台，回头做场景与产品力（换杀手场景/换目标人群），直到过门。

---

## 4. 阶段 2：MCP 互操作（6~10 周 → 发布 v0.3.0）

**目标一句话：把工具生态从"自建 2 个插件"变成"继承 MCP 数千个 server"，同时白拿进程隔离。**

### 4.1 MCP 客户端（2~3 周，本阶段核心）
详细设计见 §8.4：
- [x] 依赖官方 `@modelcontextprotocol/sdk`；先支持 stdio 子进程 + HTTP 两种 transport（v0.3）
- [x] MCP server 配置文件 `mcp.json`（与 Claude Desktop/Cherry Studio 格式兼容，**降低用户迁移成本**）
- [x] 工具桥：server 的每个 tool → `AgentTool` 包装注册进 `ToolRegistry`（命名 `mcp.<server>.<tool>`）
- [x] 治理映射（默认策略，用户可按 server/按 tool 覆盖）：
  | MCP 注解 | 底座行为 |
  |---|---|
  | `readOnlyHint: true` | 免审批，权限标 `[]` |
  | 其他（含 `destructiveHint`） | 默认 `requiresApproval: true`，权限标 `net:http`/`shell:exec` 类语义由用户在配置里指定 |
- [x] 连接生命周期：启动时懒连接 / UI 显式启停 / 崩溃自动重连（指数退避）+ 状态推送
- [x] IPC 新增：`list-mcp-servers` / `set-mcp-config` / `toggle-mcp-server`；推送 `mcp-status-changed`
- [x] UI：MCP 管理页（添加 stdio 命令或 HTTP 地址、健康状态、工具清单、审批策略覆盖）
- [x] 自测：内置一个 echo mock MCP server 脚本，`ipc-selftest` spawn 它做全链路断言（不依赖网络）

### 4.2 Anthropic 流式（0.5 周）
- [x] `anthropic.ts` 改 SSE：`message_start` / `content_block_delta` / `content_block_stop` 映射到 onChunk；tool_use block 拼接逻辑对齐现有 `LLMResponse`（v0.3~v0.4）
- [ ] live-check 增加 Anthropic 用例 —— **现状**：live-check 为 provider 无关的通用用例（按 config.json 当前 provider 跑），无 Anthropic 专属断言

### 4.3 协议治理（0.5 周，生态前必做）
- [x] manifest 增 `protocolVersion: 1`；loader 拒绝高于底座支持的版本（富插件协议 v2 落地为 `protocolVersion: 2`，见 §5.2）
- [x] `docs/` 增《协议变更流程》—— **偏离**：未单独立文档，以 CONTRIBUTING 铁律 1（契约先行）+ 协议文档 §7/§8"增补节"惯例承载
- [x] LoopEvent/IPC payload 全部过一遍字段冻结评审，之后按 semver 纪律执行（payload 已文档化冻结，v0.6 前保持稳定）

### 4.4 官方插件补齐（0.5 周，补 MCP 不便覆盖的）
- [x] `shell-exec`（`requiresApproval: true` + 命令白名单配置 + 超时杀进程）（v0.3）
- [x] `http-fetch` —— **偏离**：实现名 `web-fetch`（v0.3）
- [ ] `list-dir` / `edit-file`（补文件操作体验，与 MCP filesystem 重叠部分以体验好者为准）—— **现状**：未建（内置已有 read-file/write-file，目录浏览/编辑可由 MCP filesystem server 承担）

### 4.5 阶段验收
- [ ] 用 3 个真实 MCP server（filesystem / fetch / memory）串一个多步任务全程跑通并录 demo GIF —— **现状**：单 server 链路已被 journeys/mock-mcp-server 覆盖，三 server 组合任务与 demo GIF 未做
- [x] v0.3.0 发布；插件与 MCP 工具在 UI 中统一呈现、统一审批（见 CHANGELOG [0.3.0]）
- [x] 审计日志：所有工具/MCP 调用落 `userData/audit.log`（JSONL，含参数摘要与审批结果）（v0.3，`approval-audit-service.ts`）

---

## 5. 阶段 3：生态基建（11~16 周 → 发布 v0.4.0）

**目标一句话：让不认识我们的插件作者，能在 10 分钟内发布一个插件、并被人安全地装上。**

### 5.1 插件开发者体验（DX 优先于功能）
- [x] `@agent-base/sdk`：类型 + `definePlugin()` 辅助 + 参数 schema 工具（解决"插件作者要引底座 types"的痛点）—— **部分**：`sdk/` 目录已在库内落地；**发布到 npm registry 未做**
- [ ] `npm create agent-base-plugin` 模板仓：manifest/入口/tsconfig/调试脚本开箱即用 —— **现状**：仅有库内 `templates/plugin-basic/`，未做 npm 脚手架
- [ ] 文档站（VitePress）：5 分钟上手 / 审批机制 / 权限模型（**如实写明当前信任边界，不吹沙箱**）/ 调试热更新 —— **现状**：未建（现有 docs/*.md 为散装协议与交付文档）
- [ ] 插件本地调试：install-plugin 支持指向开发目录 + 改动自动热更（缓存穿透已具备，补 watch）—— **现状**：缓存穿透已具备（重装即热更），dev 目录 watch 未做

### 5.2 富插件协议 v2（1~1.5 周，范围必须克制）
按需渐进，**每项独立评审，做不完就砍，不阻塞发布**：
- [x] 工具结果渲染声明：`result.render: 'markdown' | 'code' | 'diff' | 'table'`（UI 据此渲染，不开放任意 HTML——安全边界）
- [x] 插件设置页声明：manifest 增 `settings: JSONSchema` → UI 自动生成配置表单，值注入 `ctx.settings`
- [x] 生命周期钩子：`onInstall` / `onUninstall`（先只这两个；`onMessage` 管线钩子明确推迟到 v1.0 后评估——推迟决定仍有效）
- [ ] manifest 增 i18n 字段（`displayName.zh / displayName.en` 结构化，替代自由文本）—— **现状**：未实现，仍为自由文本

### 5.3 插件注册表 v0（1 周）
- [x] 形态：**一个 GitHub 仓库即注册表**（`registry.json` 索引 + PR 投稿），不建服务器——符合当前人力
- [x] 收录门槛：manifest 审查 + 权限合理性 + 源码目检 + `protocolVersion` 匹配
- [x] 应用内"插件市场"页：拉取 registry.json → 浏览/一键安装（下载 zip → 校验 sha256 → install-plugin）（v0.5.9，支持离线回退）
- [x] 真签名（minisign/Sigstore）排 v1.0；当前用"registry 仓库 PR 人工审查 + sha256"如实标注（该决定仍有效，v0.6 亦修复过 registry 包内路径遍历问题佐证人工审查必要性）

### 5.4 沙箱收尾（1 周）
- [x] 明确架构结论：**MCP 进程外工具 = 主流沙箱形态**（文档定位写清楚）（`docs/PLUGIN_PROTOCOL.md` §4.6 + README「核心设计约束」如实标注"声明式信任模型，进程内插件无沙箱"）
- [ ] 进程内插件高危操作改走 Electron `utilityProcess` 池（崩溃隔离 + 内存限额），内置插件先行 —— **现状**：未做（README Roadmap 同款未勾项；需维护者拍板安全架构选型）
- [x] `ToolContext` 保持只读元数据；带权限的受控文件句柄 API 排 v1.0 评估（现状符合：ctx 仅注入 pluginName/workingDir/settings/services）

### 5.5 社区运营（贯穿，每周固定 2 小时）
- [ ] README 双语 + 产品 GIF + 对比定位表（vs Cherry Studio/Claude Desktop：**Agent 优先 + 审批治理 + 开源可换 UI**）—— **现状**：未做
- [x] 双周发版节奏（哪怕小版本）——群项目的生命线是"可见的进展"（实际执行节奏更密：2026-08-30 ~ 09-06 发 v0.5.0~v0.6.0 共 10+ 个版本）
- [ ] good-first-issue 标签 + 插件 Showcase 页（装了谁的插件就展示谁）—— **现状**：未做
- [ ] 每个外部插件/PR = 邀请作者进贡献者名单 —— **现状**：尚无外部插件/PR，机制待首位外部贡献者出现时启用

### 5.6 阶段验收
- [ ] **3 个非群成员的插件**被收录进 registry 并可安装使用 —— **现状**：registry 仅收录 2 个自产包（system-master / m3e-canvas），外部插件为零——**本阶段唯一未达标的核心门槛**
- [ ] 从装应用到装第一个第三方插件全程 ≤ 15 分钟（找新人实测录屏）—— **现状**：未实测
- [ ] v0.4.0 发布，文档站上线 —— **偏离**：v0.4 未单独发版（版本线 0.3.0 → 0.5.0 跳版），生态基建成果由 v0.5.x 系列承载；文档站未上线

---

## 6. v1.0 之后（远期，不做承诺）

- 插件签名与审核分级（信任等级：官方/认证/社区）
- 子代理与后台任务（长任务挂 tray 通知）；定时任务
- 会话记忆层（检索/摘要/知识库，RAG）
- 企业策略包（策略中心下发 allowedPermissions/forceApproval——终态 A 的形态预留）
- UI 皮肤/替换生态（window.agentBase 契约稳定后的红利）
- 移动端/远程入口（明确**不做**，见 §11）

---

## 7. 分工建议（群开发 3~4 人）

| 角色 | 负责面 | 关键产出 | 特质要求 |
|---|---|---|---|
| A 底座核心 | loop/会话/Provider/MCP 桥 | 阶段1 §3.2/3.3、阶段2 §4.1/4.2 | TS 最强，守"loop 不动"纪律 |
| B UI 产品 | renderer 重写 + 打包 | §3.4/3.5、所有 UI 页面 | 有桌面端审美，能定夺交互 |
| C 生态与文档 | SDK/文档站/registry/社区 | §5.1/5.2/5.3/5.5 | 写作好，适合半 contributors 兼职 |
| D 质量与发布（可兼任） | 测试扩充/CI/发版/审计 | 各阶段自测脚本、Release 流水线 | 细，守验收门槛 |

协作规则（沿用并强化现有 DELIVERY 模式）：
1. **契约先行**：跨角色改动 = 先提协议 PR（docs/）评审，再动码
2. **每阶段只有一个 Door**：验收单由 D 把关，未过不许开下一阶段 issue
3. 每人每阶段认领 ≤ 2 个工作流，超额说明阶段该延期而不是人该加班

---

## 8. 关键技术设计（实现细节预案）

### 8.1 多会话与持久化
```ts
// userData/sessions/<id>.json —— 每会话一文件（无原生依赖，避免 better-sqlite3 的 node-gyp 地狱）
interface Session {
  id: string;                    // ulid 或 `${prefix}-${nanoid}`
  title: string;
  createdAt: number; updatedAt: number;
  messages: ChatMessage[];       // 磁盘上永不截断，全量保存
  meta?: { provider: string; model?: string };
}
```
- 写入策略：每轮 loop 结束原子写（临时文件 + rename）；崩溃最多丢当轮
- `AgentService` 变更：`history` → `Map<sessionId, Session>`；`running` 锁升级为 per-session（允许两会话并行循环，事件带 sessionId 归并）
- 迁移：v0.1 的内存 history 直接丢（无真实用户负担）

### 8.2 上下文窗口管理（MVP 用截断，摘要靠后）
```
估算：estimateTokens = Σ ceil(chars × 0.6)   // 中英混合粗糙但够用；响应里的 usage 字段回填后可校正
预算：budget = provider上限 × 0.7 − system − 工具定义开销（可用 definitions 序列化长度估）
组装：从最新消息向前整轮收集（一轮 = user + assistant(+toolCalls) + 其 tool 消息），整轮要么全进要么全丢
兜底：预算装不下任何一轮 → 只保留最近一轮 + 注入 system 提示"历史已截断，必要时请用户复述关键信息"
摘要：config 开关 summarize: true 时，被丢弃的旧轮先经一次廉价调用压缩成一段注入（阶段3再做，成本要明示用户）
```
> **✅ 已落地（v0.6.0）**：`summarize` 开关（默认 true）+ 增量摘要（仅丢弃边界增长时重写，否则零 LLM 调用复用）+
> 摘要持久化于 `session.meta.compaction`（复用期字节级稳定，保障 Prompt Cache）+ `context-compacted` 推送明示成本。
> 详见 `docs/CONTEXT_COMPACTION_REPORT.md`。

### 8.3 Provider 注册表
```ts
const registry = new Map<string, ProviderFactory>();
registerProviderFactory('openai-compatible', cfg => new OpenAICompatibleProvider({ ...通用预设(cfg) }));
registerProviderFactory('deepseek',          cfg => openaiCompatiblePreset(cfg, 'https://api.deepseek.com/v1', 'deepseek-chat'));
registerProviderFactory('anthropic',         cfg => new AnthropicProvider(cfg));
// UI 可传 { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' } → Ollama 即插
```
`createProvider` 保留为兼容入口；`set-model-config` 校验改为"注册表命中"；`list-providers` 返回 `{id, label, requiresBaseUrl}` 供 UI 动态渲染。

### 8.4 MCP 桥
```
mcp.json（兼容 Claude Desktop 格式）
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/docs"] } } }

启动：懒连接（首次工具枚举或用户显式启用）→ Client.connect(StdioClientTransport)
桥接：server.tools → AgentTool{
        name: `mcp.${serverName}.${toolName}`,
        description: tool.description,
        parameters: tool.inputSchema,          // JSON Schema，直接过现有 ajv 关卡 ✅
        permissions: 按 §4.1 映射表,
        requiresApproval: 按 §4.1 映射表,
        execute: (args) => client.callTool({ name, arguments: args }) → 转 ToolResult
      }
注销：server 停止 → registry.unregister 该 server 名下全部工具（复用插件卸载路径）
错误：server 崩溃 = 工具结果 error: 'tool-crashed' 喂回模型（复用现有自愈语义）+ 重连 + mcp-status-changed
范围：本阶段只桥 tools；resources/prompts/sampling 明确推迟，防止范围爆炸
```

### 8.5 协议版本治理
- IPC 协议版本常量 `IPC_PROTOCOL_VERSION`，preload 暴露 `getProtocolVersion()`，UI 启动时校验不匹配即提示
- 插件 manifest `protocolVersion`（阶段2 §4.3）
- 规则：加可选字段 = minor；删字段/改语义 = 必须先 deprecated 标注 ≥1 个 minor 周期
- **文档是契约**：CI 加一步校验——协议文档中出现的错误码集合 == `shared/error-codes.ts` 导出集合（防再次漂移）

---

## 9. 测试与质量防线

| 层 | 手段 | 时机 |
|---|---|---|
| 循环/裁剪/会话 | smoke.ts 扩展（mock provider 脚本化） | 每阶段必扩 |
| IPC 协议 | ipc-selftest 扩展（新通道逐条断言） | 每加通道必扩 |
| Provider | 本地 mock OpenAI/Anthropic HTTP server + live-check（有 Key 才跑） | 阶段1/2 |
| MCP | 内置 echo mock server（stdio）全链路自测 | 阶段2 |
| UI | 手测清单（每 Release 一份 checklist）+ 关键路径截图留档 | 阶段1 起 |
| 打包 | CI 上 win/mac/linux 三平台构建冒烟（AGENT_BASE_AUTOQUIT=1） | 阶段1 起 |

---

## 10. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| 平台-first 复发：底座继续打磨、产品难产 | 高 | 决策门 1 硬卡；每阶段验收都含"外部可见产出" |
| 群项目动力衰减 | 高 | 双周发版 + 每阶段一个"能晒的 Demo"；角色 C 的社区运营是正式工作不是课外活动 |
| MCP SDK/API 变动 | 中 | 锁定版本；桥接层薄封装，SDK 只出现在 `src/mcp/` 内部 |
| 富插件协议范围爆炸 | 中 | §5.2 每项独立评审可砍；`onMessage` 管线钩子明确推迟 |
| mac 签名/公证成本 | 中 | 阶段1 不签名如实标注；接受"mac 用户少一点"直到有收入或赞助 |
| 上下文估算不准导致截断错误 | 中 | 整轮截断策略保证结构合法；usage 字段回填校正；错误可被用户复述兜底 |
| 并行会话引入并发 bug | 中 | per-session 锁；ipc-selftest 增并发用例；必要时先串行（全局锁）再放开 |

---

## 11. 不做清单（防止范围漂移，与 Roadmap 同效力）

1. **不做**自建插件协议与 MCP 的生态对抗（协议定位 = MCP 之上的桌面富插件超集）
2. **不做** marketplace 服务器/账号体系（v1.0 前 registry 就是 GitHub 仓库）
3. **不做**远程/Web 版 UI（window.agentBase 是桌面契约，Web 化是另一个项目）
4. **不做**移动端
5. **不重写** loop.ts / 不把业务塞回 main.ts / 不允许 UI 绕过 window.agentBase
6. **不做**多语言运行时插件（Python/Rust 插件 = 让他们写 MCP server）
7. v1.0 前**不做**付费/云服务，避免动机污染开源社区

---

## 12. 一页纸里程碑速览

> **对账（2026-09-06，v0.6.0）**：M0 ✅ / M1 功能 ✅（"10 外部用户"验收未确认）/ M2 ✅（demo GIF 未录）/
> M3 生态功能基本就绪但**核心门槛"3 个外部插件"未达**（registry 仅 2 个自产包，SDK 未发 npm、无文档站）/
> M4 未启动（签名、utilityProcess 沙箱、协议冻结均在 v1.0 议题）。

| 里程碑 | 交付物 | 唯一验收标准 |
|---|---|---|
| M0（第1周） | git/LICENSE/CI/错误码对齐 | 陌生人 clone 后测试全绿 |
| M1（第2-5周） | v0.2.0 安装包（多会话+真UI+Provider注册表） | 10 个外部用户完成任务 |
| M2（第6-10周） | v0.3.0（MCP 接入 + Anthropic 流式 + 审计日志） | 3 个真实 MCP server 跑通多步任务 |
| M3（第11-16周） | v0.4.0（SDK+文档站+registry+富插件v2） | 3 个外部插件收录并可装 |
| M4（17周+） | v1.0（签名+受控执行API+稳定协议冻结） | 协议冻结，插件生态自增长 |
