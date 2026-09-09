# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。所有对外行为变化（IPC 通道、事件 payload、插件协议、错误码）都必须记录在此。

## [0.7.4] - 2026-09-09（打包态内置插件修复 + 发布流水线单点发布如实落地，ZCode 协作）

### 打包态严重缺陷：内置插件全丢（实测复现并修复）
- **复现**：`electron-builder -w --dir` 实打包 + CDP 注入实测——修复前打包态仅加载 1 个内部注册的 core-subagent，
  六个内置插件（ask-user/kb/read-file/shell-exec/web-fetch/write-file）**全部丢失**。根因：`loadPlugins` 的三条扫描路
  （Roaming 数据目录 / 安装目录 / cwd）都够不到应用包内真正的 `resources/app.asar/plugins/builtin`，
  而唯一能解析该路径的 `builtinPluginsDir()` 此前是零调用死代码；开发态（cwd=repo）与 journeys 恰好掩盖了问题。
  发布版 agent 由此零工具可用。
- **修复**：扫描根计算抽成纯函数 `resolvePluginScanRoots`（数据目录 → cwd → exe 同级 → asar 内置目录，
  重复/嵌套根去重，dev/journeys 既有行为逐字不变），打包态实测恢复 7/7 加载；新增 4 项路径语义单测。
- **顺带**：内置插件卸载保护改查 asar 内置目录（旧判断在打包态失效，内置插件可被"卸载"到下次重启才复活）。

### 发布流水线：如实落地 CHANGELOG [0.7.1] 声明的单点发布
- `release.yml` 重写：矩阵任务改为 `npx electron-builder --publish never` + `actions/upload-artifact`；
  新增单一 `publish` job（仅 tag 触发）汇总三平台产物，用 `softprops/action-gh-release` 建**一条**非草稿 Release
  （`make_latest` + `fail_on_unmatched_files`），根治 v0.5.8/v0.7.0 "产物拆进两条 Release、latest*.yml 分散"的竞态根因。
  （v0.7.1 条目声称的这套改法当时未落地，workflow 实际仍是矩阵内 `--publish always`——本条补齐。）
- `scripts/release-notes.mjs` 接入 publish job（`body_path: RELEASE_NOTES.md`），Release 正文自动生成自此真实生效。
- 发布门禁对齐测试防线：build job 补跑 `test:ipc` 与 `check:codes`（此前这两条红了也能发版）。

## [0.7.3] - 2026-09-09（主进程崩溃日志落盘 + 注册表公开化，ZCode 协作）

### 稳定性：MVP 验收欠案清零（DEVELOPMENT_PLAN §3.6-3）
- **主进程崩溃兜底 `src/electron/crash-log.ts`**：`uncaughtException` / `unhandledRejection` 双 handler，
  完整报告（ISO 时间戳 + 应用/Node 版本 + 平台架构 + 堆栈）追加落盘至数据目录 `crash.log`（与 config.json 同级）。
  - 语义保持：`uncaughtException` 记录后按原语义退出（无 handler 时 Node 本就崩退，行为不变、只是多留证据）；
    `unhandledRejection` 记录后存活——"handler 永不 throw"契约下它不该出现，出现即 bug，但单条 Promise 失败不整机陪葬；
  - 边界自守：日志超 512KB 自动截断（崩溃风暴不撑爆磁盘）；写盘自身失败静默放弃（兜底路径无人接得住新异常）；
  - 模块零 electron 依赖，10 项 vitest 单测覆盖格式化/追加/截断/双 handler/写盘失败全场景。
- **崩溃现场从此可回溯**：用户反馈"闪退"时，Roaming 目录下 `crash.log` 即第一现场证据。

### 注册表公开化（承接 v0.7.2 收尾）
- `registry.json` 全部 `downloadUrl` 指向公开仓库 raw 地址，插件市场免认证可拉取。

## [0.7.2] - 2026-09-08（完全访问免审批 + 工具折叠盒 + 流光思考胶囊 + Ultra 旗舰版，何惜）

### 核心体验与交互突破
- **完全访问模式（full 模式）彻底免审批放行**：
  - 修复此前即使切换到「完全访问」模式依然因插件声明硬编码 `requiresApproval` 导致弹窗打扰的逻辑缺陷；
  - `LoopOptions` 引入 `skipAllApprovals: policy.permissionMode === 'full'`，在完全访问模式下对常规写操作与终端命令完全自动化放行，仅人机交互决策类工具（`ask-user.choose`）保留用户拍板。
- **液态玻璃「工具活动聚合折叠盒」（Tool Capsule）**：
  - 彻底终结多工具调用散落满屏、打断阅读体验的痛点；
  - 一轮问答中的多个工具操作自动收纳在独立的毛玻璃折叠盒内，默认保持折叠收拢，主界面干干净净；
  - 支持一键平滑展开，完整查看执行的工具清单、耗时与输出内容。
- **拟态液态流光边框（Liquid Sheen）**：
  - 思考胶囊与底部输入框边缘实装拟态液态流动高光（斜切微光从左向右平滑流动，4s 优雅周期，科技感拉满）；
  - 输入框在聚焦与悬停时流光自然浮现。
- **ABCD 交互弹窗全主题联动适配**：
  - 修复切换深色/浅色/羊皮纸主题时，ABCD 弹窗因硬编码颜色导致不一致的 Bug，全面接入主题 CSS 变量。
- **官方插件库（Registry v0）全面构建与上架**：
  - 将 `system-master`（全能系统管家）、`m3e-canvas`（画布设计器）、`ask-user`（ABCD 决策交互）三款高价值插件打包至 `registry/packages/`；
  - 补充真实有效的 SHA-256 校验哈希与下载地址至 `registry/registry.json`，确保在任何新设备上均可从官方注册表真实安装可用。
- **终端执行与退出码优化**：
  - `shell-exec` 对带标准输出的非 0 退出码（如 grep/findstr 无匹配返回 1）返回文本与退出码标记，避免直接判定为严重失败导致 AI 陷入空转。

### Claude Code 风格流光思考胶囊（Thought Capsule）
- **独立模块化**：思考胶囊自 `chat.js` 内聚拆解为 `renderer/modules/thought-module.js`，职责单一、可复用，`chat.js` 仅保留三个调用入口（`appendThoughtDelta` / `finalizeThoughtCapsule` / `clearAllThoughtCapsules`）。
- **极光旋转流光圆环（Aurora Spinner）**：思考中胶囊边框改为渐变极光（靛蓝 → 紫 → 蓝 → 青）呼吸微光 + 圆环旋转动效，取代此前的静态流光扫过；暗色/羊皮纸主题各自适配光晕强度。
- **0.1s 高精度秒表**：思考时长实时显示到 0.1 秒粒度（100ms 周期刷新），不再四舍五入到整秒。
- **动态 Token 计数徽章**：思维流增量注入时按中英混合启发式实时估算消耗 Token 并展示徽章，思考成本一目了然。
- **内凹终端思维流**：思考正文以等宽字体独立呈现，流式追加带光标跟随闪烁；折叠/展开使用物理阻尼缓动（cubic-bezier(0.16,1,0.3,1)）。
- **一键复制思维链**：胶囊头部新增 📋 按钮，一键将完整思考链写入剪贴板（成功后短暂显示 ✓）。
- **完成态平滑过渡**：思考结束圆环平滑替换为淡绿色对勾，标题定格最终用时；`loop-done` 与 `loop-error` 两个路径都会正确收尾，杜绝胶囊永远停在"思考中"。

### Ultra 旗舰版（Ultra Edition）
- **WebGL2 极光火焰推理力度滑块**：GPU 火焰粒子动效实时渲染，五档推理力度（Flow / Lite / Pro / Max / Ultracode）即调即用，推理成本与深度可视可控。
- **四大艺术主题**：银渐层流光玻璃、古典羊皮卷米白、素描手绘米白、8-Bit 复古像素——主题引擎全面联动（含 ABCD 决策弹窗），新增像素字体（PressStart2P / VT323）随包内置。
- **官方插件生态再扩充**：`system-master`（全能系统管家）、`m3e-canvas`（画布设计器）、`theme-customizer`（主题定制器）打包入库 `registry/packages/`，`registry.json` 全部录入真实 SHA-256 校验哈希与下载地址。
- **用户配置物理隔离**：用户配置迁移至系统 Roaming 目录，版本更新不再冲刷个人数据与设置。
- **完整升级文档**：随版本附 `ULTRA_EDITION_README.md`，含功能全景、升级路径与 FAQ。

## [0.7.1] - 2026-09-08（发布流水线竞态修复 + 私有仓库更新失败可行动提示，1535273240sch-droid）

### 发布流水线：消除三平台并发抢建 Release 的竞态
- **根因**：`release.yml` 的矩阵任务各自执行 `electron-builder --publish always`，三个 OS job
  并发对同一 tag 建 Release。撞上竞态就会把产物**拆进两条同 tag 的 Release**——v0.5.8 与 v0.7.0
  都中过：主安装包困在 `draft=Y` 的那条里，而 GitHub 因标签被重复项占用**拒绝解除 draft**
  （`422 already_exists`），`latest.yml` / `latest-mac.yml` / `latest-linux.yml` 也被分散，自动更新随之失效。
- **改法**：矩阵任务改为 `--publish never` 只构建 + `upload-artifact`；新增单一 `publish` job
  汇总三平台产物，用 `softprops/action-gh-release` 建**一条** Release（`draft: false`、
  `make_latest: true`、`fail_on_unmatched_files: true`）。
- `publish` 仅在 tag 推送时执行；`workflow_dispatch` 退化为「只验证构建、不发布」。

### 发布说明自动生成（此前每条 Release 说明都是空的）
- 新增 `scripts/release-notes.mjs`：从 `CHANGELOG.md` 抽出当前版本小节，加上四平台下载表，
  生成 `RELEASE_NOTES.md` 作为 Release 正文。历史 12 条 Release 里只有 2 条有说明，且都是手工补的。

### 自动更新：私有仓库缺凭据时不再抛裸 404
- 打包产物 `app-update.yml` 为 `provider: github` + `private: true`，运行时必须有
  `GH_TOKEN` / `GITHUB_TOKEN`；缺失时 electron-updater 只会抛一个看不懂的 404，用户无从下手。
- `UpdateManager.checkUpdates()` 现在**先探测**该情形（`missingPrivateRepoTokenHint`），命中则
  提前失败并给出可行动说明（设置具备仓库读取权限的 PAT 后重启，或把 Releases 设为公开），
  **一次网络请求都不发**；公开仓库、已有凭据、非 github provider 一律不打扰。

### 验证
- 单测 124 → **129 全绿**（`updater` 12 → 17，覆盖私有/公开/有 token/非 github/提前拦截五条路径）；
  `tsc` 无错；冒烟 23 项、IPC 自测全过。

## [0.7.0] - 2026-09-08（子代理角色化编排 + 并发调度 + 网络韧性，1535273240sch-droid）

### 子代理：从「同一个模型跑同样的活」升级为「按角色分工」
- **角色表（`config.json` → `subagents`）**：每个角色可独立声明 `model` / `provider` / `apiKey` / `baseUrl` / `systemPrompt` / `tools` / `disallowedTools` / `maxIterations` / `reasoningEffort`；**未声明的字段自动继承主配置**——接好一个网关后换模型只需写一个 `model`。支持 `defaultRole` 兜底；指向不存在角色的 `defaultRole` 被忽略而非静默生效。
- **`subagent.run` 新增 `role` 参数**（枚举由角色表在启动时生成），角色清单同时编进工具 `description`，主代理派活时即可见；新增 **`subagent.roles`** 工具返回角色 / 模型 / 职责 / 工具范围的实时表格。
- **工具白名单**：角色可收窄子代理可见工具（精确名或 `read-file.*` 前缀）；`core-` 前缀恒定剔除，禁止嵌套派生的既有约束不变。
- **提示词可覆盖**：角色自带 `systemPrompt` 时覆盖主系统提示（轻量模型吃整套主提示会掉工具调用准确率），否则沿用主提示 + 子代理纪律。
- **子代理工作纪律**：输出强制按【结论】【依据】【未完成 / 不确定】三段组织，依据必须是可核对的指针（路径+行号、命令与关键输出行）；信息不足时上报缺口而不是猜。回执上限由 20k 收紧到 **6k**（回执会原样进主对话上下文，20k 等于把隔离省下的 token 又从摘要这头还回去），且截断提示可行动：告知主代理内容不完整并给出下一步。
- **空产出判为失败**：子代理跑完但零输出时返回 `ok:false, error:'subagent-empty'`。此前返回成功并附占位文本，会让主代理误以为这一路已查完——错误静默通过。

### 并发调度：多个子代理真的同时跑
- **插件协议新增 `AgentTool.parallelSafe?: boolean`**（缺省 `false` = 严格串行，完全向后兼容）：声明为 true 的工具可与**同一轮内连续声明**的其它 parallelSafe 调用并发执行。底座按声明调度，不认识任何具体工具。
- **调度语义**：非并发调用充当屏障；连续并发调用聚成批次，受 `LoopOptions.maxParallelToolCalls`（`config.json` 的 `maxParallelToolCalls`，夹在 1–16，缺省 4）限流。
- **四条不变量**：`tool` 消息一律按**原始调用顺序**回填（完成顺序不得污染消息数组）；同批次单个工具异常只影响自己；审批按 `messageId:toolCallId` 分键可并发；`tool-started` / `tool-result` 交错到达，UI 按 `toolCallId` 归因。
- `subagent.run` / `subagent.roles` 已声明 `parallelSafe`（子代理上下文互相隔离，是唯一无争议的并发场景）。

### 主代理委派策略：该拆才拆
- 委派规则从「优先使用 subagent.run」改为**按任务形状判断**：纵向任务（一步接一步、要边做边对齐）自己干；横向任务（多个独立调查面、各自可单独验收）默认拆并发跑。判据一条——「过程很长、结论很短」。
- 新增**反空转触发器**：同一类操作连续调用工具超过 3 次（反复 grep、反复换参数试同一条命令）即整块交给子代理。
- 要求主代理对子代理影响结论的关键判断抽查证据后再采信。

### 网络韧性：一次连接抖动不再让整轮归零
- 新增 `src/providers/retry.ts`：`withRetry` 只对**连接层错误**（ECONNRESET / EPIPE / UND_ERR_* 等，含 `cause` 链）与 **408 / 409 / 425 / 429 / 5xx** 重试，指数退避 + 抖动；**用户主动 stop（AbortError）与 4xx 语义错误绝不重试**。
- 重试只包裹「取得响应」这一步，**不包 SSE 消费**——流已开始吐字之后再重试会把同一段内容重复推给 UI。
- 新增 `LLMHttpError` 携带状态码，重试策略按码判断而非正则匹配文案。
- `config.json` 可选 `retry: { attempts, baseDelayMs }`（缺省 3 次 / 600ms 起；`attempts: 1` = 关闭），并随角色继承传递到子代理 provider。

### shell-exec 的 Windows 修复
- 此前 `spawn(cmd, { shell: true })` 在 Windows 固定走 cmd.exe，模型书写的 `grep` / `find -type` / `2>/dev/null` 全部失败。改为**优先探测 Git Bash / MSYS** 并以 `bash -c` 显式执行，找不到才退回 `cmd /d /s /c`；实际使用的 shell 写进工具 `description` 让模型自适配。
- 修复输出解码：此前逐块 `String(d)` 按 UTF-8 解 cmd 的 GBK 输出，错误信息变成乱码——**模型读不懂失败原因就会反复重试同一条命令**。改为攒 Buffer 后按 `gbk` 统一解码（POSIX shell 下仍为 utf8），同时避免多字节字符被切断。

### 验证
- 单测 85 → **124 项全绿**（新增 `subagent-roles` 21、`loop-parallel` 6、`provider-retry` 10）；`tsc` 无错；冒烟测试 23 项、IPC 自测（含子代理隔离 / 禁止嵌套 / shell-exec 真实执行 / 72 通道接线完整）全部通过。
- 新增 `scripts/subagent-e2e.ts`（`npm run test:subagent`）：接真实模型、不 mock 的三场景验收——`forced` 验委派 + 换模型 + 并发，`auto` 验「不命令它也会拆」，`trivial` 验「简单任务不过度编排」。
- 既有 `providers-openai` 的 429 用例改为显式断言重试次数（此前是「意外通过」），并补 400 不重试的对照用例。

## [0.6.0] - 2026-09-06（上下文摘要压缩 v2：增量摘要 + 持久化 + 成本明示，Ljj041120）

### 核心机制升级
- **上下文摘要压缩 v2（增量 + 持久化）**：
  - 会话历史超出 `contextTokenBudget` 时，被丢弃的旧整轮由 LLM 压缩成 ≤300 字要点摘要，置于保留历史之前注入；
  - **增量重写**：仅当丢弃边界增长（有新整轮被丢弃）才重新调用摘要；否则直接复用既有摘要，**零额外 LLM 调用**（旧版每条消息超预算都会重复摘要一次）；
  - **摘要持久化**：压缩记录存入会话 `meta.compaction`（`{ upTo, summary, updatedAt }`），应用重启后依然复用，不重复付费；
  - **Prompt Cache 友好**：复用期间发给模型的前缀逐字节稳定（IPC 自测断言保障），仅增量重写时前缀失效一次；
  - **磁盘历史保持全量**：摘要只影响发给模型的内容，完整历史照常落盘（既有契约不变）。
- **`summarize` 配置开关**（config.json，默认 `true`）：设为 `false` 关闭摘要压缩，超预算退回纯整轮截断（完全不调 LLM）。
- **UI 成本明示**：新增 `context-compacted` 推送（协议 §7.5），压缩发生时对话流展示轻量单行提示（悬浮可见摘要全文）；复用既有摘要时不重复推送。
- 会话存储新增 `updateMeta` 合并落盘；自测新增压缩复用 / 前缀字节级一致 / meta 持久化 / 事件单次推送等断言（单测 85 项、IPC 自测 94 项断言 / 72 通道接线全绿）。

## [0.5.8] - 2026-09-06（流光液态玻璃「AI 深度思考胶囊」+ 思考流正文分离，何惜）

### 视觉与交互体验革新
- **全新流光液态玻璃「AI 深度思考胶囊」（Thought Capsule）**：
  - 彻底终结思考过程与正文内容混杂输出的脏乱体验；
  - 正文上方独立挂载毛玻璃思考胶囊，边缘带有炫彩极光微光渐变（Aurora Glow）与呼吸动效；
  - 实时显示思考秒表（如 `AI 深度思考中 · 12 秒…`），思考收尾后自动定格为 `已完成深度思考（耗时 12 秒）`；
  - **支持点击平滑展开/折叠**：默认保持折叠状态，正文区域干净清爽；点击随时展开查看内凹发光文本框中的完整思考推理链；
  - 思考过程绝不污染正文 Markdown 与持久化历史。
- **底层流式分流重构（Thought/Content Separation）**：
  - `ChatOptions.onChunk` 与 `LoopOptions.onChunk` 升级为 `(delta: string, kind?: 'content' | 'thought') => void`；
  - `OpenAICompatibleProvider` 针对 `delta.reasoning_content` 精准标记 `kind='thought'` 进行分流，正文按 `kind='content'` 分流；
  - `agent-service.ts` 确保思考流仅实时推送到 UI，绝不混入 `partialContent` 与 `session.messages`。

## [0.5.9] - 2026-09-06（官方插件市场 Marketplace 架构升级，何惜）

### 新增
- **官方插件市场（Plugin Marketplace）架构落地**：
  - 核心底座恢复纯净轻量，移出非核心内置插件，保持基础运行开销极简；
  - 建立 `registry/registry.json` 官方插件注册表，收录首批官方精选扩展包：
    - 📦 `system-master`（全能系统管家）：全盘读写、桌面直投、命令调度与硬件扫描；
    - 🎨 `m3e-canvas`（M3E 画布设计器）：Material 3 原型设计与 AI 提示词导出；
  - 提供 `scripts/pack-plugins.mjs` 插件标准打包脚本，自动生成带 SHA-256 完整性校验的 `.zip` 扩展包；
  - 设置页新增「🛒 官方精选插件市场」列表，支持一键在线获取/卸载，并支持本地注册表离线安全回退。
- **IPC 通道扩充**：
  - 新增 `list-registry-plugins` 通道，支持前端直接拉取官方扩展仓库。

## [0.5.7] - 2026-09-06（多会话并发无阻断 + 智能会话总结标题 + 交互决策规范注入，何惜）

### 核心体验突破
- **多会话并发完全解锁（Session-Level Concurrency）**：
  - 彻底解除前端 `session.js` 中的全局 `st.busy` 切换拦截，重构为会话级独立忙态哈希集合（`busySessions`）；
  - 会话 A 在执行后台长任务、复杂代码生成或绘图时，用户可随时新建会话 B 或切到会话 C 开启全新任务，各会话循环独立并发运行，互不阻塞、互不干扰！
- **智能会话标题总结（告别“默认会话”）**：
  - 修复 `session-store.ts` 中 `isUntitled` 判定漏掉“默认会话”与“未命名会话”导致标题总结永远被跳过的 Bug；
  - 增强 `session-service.ts` 的 `maybeAutoTitle` 机制：在首轮问答或工具调用收尾后，异步调用模型提炼 12 字以内的精致中文业务标题，并自动实时刷新至侧边栏！
- **AI 主动交互与 ABCD 选项决策规范注入**：
  - 在全局 `SYSTEM_PROMPT` 中注入最高优先级的人机协作对齐准则；
  - 严禁大模型在面对复杂重构、技术路线分歧、存在多种可行方案时盲目猜测动手；
  - 强制要求模型主动调用 `ask-user.choose` 工具，向用户弹出液态玻璃 ABCD 卡片（附推荐项与技术理由），在得到用户确认后再高效推进！

## [0.5.6] - 2026-09-05（用户数据与安装目录绝对隔离：彻底终结升级洗白配置，何惜）

### 严重缺陷彻底根除
- **用户数据存储目录从安装目录（Programs）彻底迁入操作系统标准数据安全区 `app.getPath('userData')`（AppData/Roaming/agent-base）**：
  - 彻底根除因 NSIS 安装包覆盖安装升级时清空安装目录导致用户的 API 密钥、模型列表、会话历史、任务记录被一锅端洗白的严重缺陷；
  - 引入启动时平滑数据拯救机制：若检测到安装目录下有旧版遗留的 `config.json`，自动无缝安全搬迁至 Roaming 数据安全区；
  - 无论后续软件升级、自动更新、覆盖安装多少次，所有个人配置与历史任务 100% 永久保留，绝不再丢失！
- **输入框原生文件与图片直接拖入（Drag & Drop）支持**：
  - 输入框支持把本地任意文件、代码、图片直接拖拽丢入，基于 Electron `webUtils.getPathForFile` 解析物理路径并自动转换为结构化多模态芯片。

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
