# 模块化拆分与功能增强 — 交接报告

> 分支：`refactor/modular-split`（基于 main @ 4426bff）
> 日期：2026-08-30 ｜ 执行：何惜（协作开发者）+ 多智能体流水线（详见文末附注）
> 性质：**大型重构 + 一项新功能 + 若干修复**。全部离线门禁与 16 段 E2E 通过后提交。

---

## 一、这轮要解决什么（背景）

接手时 `handoff.md` 与 `docs/HANDOFF.md` 列出四件遗留事项：

1. `src/electron/agent-service.ts`（1287 行）与 `renderer/app.js`（1284 行）超过项目 300 行硬规则，需按领域拆分
2. Roadmap 三项：自动更新 / 插件沙箱 / 插件签名分级
3. journeys E2E 缺窗控旅程
4. CI 跑 `test:window` 的可行性评估

本轮完成 **1 全部、3 全部、4 全部、2 的自动更新一项**；沙箱与签名两项需要维护者拍板设计方向，未动（见「五、没做什么」）。

---

## 二、做了什么

### 2.1 后端拆分：agent-service.ts 1287 行 → 293 行门面 + 8 个模块

按「领域块」小步拆分，每步跑 `test:ipc` 门禁后再进下一步。拆分后 `agent-service.ts` 只保留**门面职责**：组合子服务、running 锁与消息队列的统一仲裁、IPC 映射；对 `main.ts` / `preload.ts` 的公共方法签名 100% 不变（IPC「三件套」契约未破坏）。

| 新文件 | 行数 | 职责 |
|---|---:|---|
| `src/electron/types.ts` | 190 | IPC DTO、错误定义、模式常量与纯工具函数 |
| `src/electron/services/mcp-service.ts` | 70 | MCP 服务器列表/启停/配置持久化 |
| `src/electron/services/session-service.ts` | 136 | 会话 CRUD、自动起标题 |
| `src/electron/services/model-policy-service.ts` | 265 | Provider 工厂、模型列表、权限模式 |
| `src/electron/services/approval-audit-service.ts` | 89 | 审批挂起映射、audit.log 读写 |
| `src/electron/services/workspace-service.ts` | 166 | 文件预览/遍历/附件/上下文压缩/SystemPrompt |
| `src/electron/services/subagent-runner.ts` | 122 | core-subagent 插件注册与隔离子循环 |
| `src/electron/services/plugin-service.ts` | 213 | 本地/远程 zip 插件安装、校验、设置存储 |
| `src/electron/agent-service.ts`（瘦身后） | 293 | 门面 Facade |

### 2.2 前端拆分：app.js 1284 行 → 142 行入口 + 10 个 ESM 模块

关键约束：**项目无构建步骤**（主进程直接 loadFile）。方案对比后选用原生 ES Modules（`<script type="module">`）而非多 script 标签：依赖显式 import/export、作用域天然隔离。迁移时保持行为零变化（`test:window` 全程门禁）。

| 新文件 | 行数 | 职责 |
|---|---:|---|
| `renderer/modules/state.js` | 57 | 响应式状态 st、DOM 缓存 el |
| `renderer/modules/utils.js` | 169 | 工具函数、Toast、invoke、下拉菜单、Markdown |
| `renderer/modules/session.js` | 121 | 会话侧栏：过滤/改名/删除/切换/新建 |
| `renderer/modules/chat.js` | 299 | 消息流、工具卡、思考秒表、进程卡、历史重放 |
| `renderer/modules/composer.js` | 114 | 发送、@ 文件选择器、附件 |
| `renderer/modules/approval.js` | 162 | 审批弹窗、参数编辑、LCS diff |
| `renderer/modules/menus.js` | 105 | 权限/模型/推理力度菜单 |
| `renderer/modules/right-panel.js` | 54 | 审查事件流、审计、终端 |
| `renderer/modules/settings.js` | 204 | 设置页各面板 |
| `renderer/app.js`（瘦身后） | 145 | ESM 主入口：窗控绑定、IPC 订阅、快捷键、init |

### 2.3 CI：Windows 窗口自测上线（遗留事项 4）

调研结论推翻了原提案（macOS/xvfb）：F1 类 bug 是 win32 专属的「逻辑最大化」分支，mac/xvfb 即使跑通也保护不到它。落地（`.github/workflows/ci.yml`）：

- `test` job 增加 `Window selftest` step（`if: runner.os == 'Windows'` → `npm run test:window`）
- job 级 `timeout-minutes: 10` 防 Electron 挂起拖垮矩阵
- 边际成本低：Windows runner 本来就在跑 build

### 2.4 journeys 新增 J16 窗控旅程（遗留事项 3）

`journeys/e2e-journeys.mjs` 顺延新增第 16 段：断言 `window.agentWindow` 暴露、`toggleMaximize` → `win:state{maximized:true}`、几何覆盖工作区（4px 容差）、还原、最小化、关闭。平台相关的几何/可见性项采用**警告降级而非硬失败**（注释已写明策略），`win:state` IPC 推送保持硬断言。README 同步更新为 16 段。

### 2.5 自动更新功能（Roadmap 之一，**默认关闭**）

新增 `src/electron/updater.ts`（185 行）+ `tests/updater.test.ts`（新增 11 项测试）：

- 配置 `config.json` 增 `autoUpdate.enabled`，**缺省/损坏/非 true 均不启用**
- 行为模式：检查 → 提示 → **用户确认后下载** → 用户确认后安装；强制 `autoDownload=false`、`autoInstallOnAppQuit=false`，**无静默路径**
- IPC 新增 4 通道：`check-updates` / `download-update` / `install-update` / `get-updater-state`，推送 `updater-state`；状态机 `disabled/idle/checking/available/not-available/downloading/downloaded/error`
- `scripts/ipc-selftest.ts` 已把 4 个新通道纳入接线完整性检查（58 → 66 通道）

---

## 三、顺手修复的问题（拆分与联调过程中发现）

1. **E2E 基线回归（本轮前就坏了）**：`JOURNEY-README-MARKER` 在 50e7d5a 文档清理时被误删，导致 J3/J11 必挂、全量 E2E 无法运行。已按 3e4f567 原版式恢复到 `journeys/README.md` 第 3 行
2. **错误码扫描器失明**：`scripts/check-error-codes.mjs` 写死扫描 `agent-service.ts` 与 `renderer/app.js` 两个旧路径，拆分后"后端使用 19→6、UI 覆盖 22→0"，防线名存实亡。已改为扫描 `src/electron/services/*.ts` 与 `renderer/modules/*.js` 全目录，恢复 22/19/22
3. **J8 竞态（时序彩票）**：E2E 的 waitFor 可在 `setBusy(false)` 前观察到 loop-done 文本，随后点击切换会话被忙态守卫吞掉 → 历史重建超时。`onLoopDone` 已把 `setBusy(false)` 提前到文本渲染之前，消除竞态窗口（修后 E2E 两轮全绿）
4. **改名框双触发**：内联改名的 commit 同时挂 Enter 与 blur，二次 `editor.remove()` 抛 NotFoundError（基线就有的老 bug）。加一次性提交守卫
5. **electron-updater 的 ESM 导入崩溃**：该包为 CJS 且 `autoUpdater` 是懒加载 getter 导出，`import { autoUpdater }` 会让应用**启动即崩**（`SyntaxError: does not provide an export named 'autoUpdater'`）。改为默认导入 + 解构。注意：此崩溃七条门禁全绿仍漏网——`test:window` 用独立入口不加载真实 main.ts，只有 E2E（真实启动应用）才能抓到

---

## 四、验证结果（提交前全部亲自重跑）

| 门禁 | 结果 |
|---|---|
| `npm run build` / `typecheck` | ✅ |
| `npm run test:unit` | ✅ 60/60（原 49 + updater 11） |
| `npm run test:ipc` | ✅ 66 通道接线完整 |
| `npm run smoke` | ✅ |
| `npm run check:codes` | ✅ 事实源 22 / 后端 19 / UI 22 |
| `npm run test:window` | ✅ |
| journeys 16 段 E2E（真实启动应用） | ✅ 23/23 断言 |
| 应用实机启动 | ✅ 无报错常驻 |

---

## 五、没做什么（及原因）

1. **插件真沙箱执行 API**（Roadmap）：涉及安全架构选型（utilityProcess / worker / 权限模型），需要维护者拍板，不宜由协作者擅自定案
2. **插件签名与信任分级**（Roadmap）：依赖沙箱方案的信任模型，同样待拍板
3. **自动更新的发布侧动作**：功能代码已就绪但**默认关闭**；要真正生效需维护者：确认发布仓库 → 打 NSIS 安装包（portable 对 electron-updater 支持有限）→ 建 GitHub Release（附 latest.yml/.blockmap）→ CI secrets 注入 GH_TOKEN → 升版本号实测升级链路。详细清单见 `acp_tasks` 外的说明：**运行端检查私有仓库更新同样需要 token**，若要面向普通用户透明更新，应改公开 Release 或 generic 匿名更新源
4. **CI 窗口自测的稳定性观察**：Windows runner 是服务器桌面会话，隐藏窗口的 minimize/restore 可能偶发不稳；建议合入后连跑几次 CI 观察，必要时按 `codex_ci_report` 加重试
5. **`live:check`（真模型联测）**：未运行（需要真实 API Key），本轮所有验证基于 mock

---

## 六、维护者需要知道的决策点

1. **`electron-builder.yml` 的 `publish.owner/repo` 已修正**为 `noeticforge/noeticforge`（原填 `agent-base` 与实际仓库不符，会导致更新元数据指向错误仓库）——请复核
2. 行数规则达成：本轮后 `src/` 与 `renderer/` 全部文件 ≤300 行
3. `package-lock.json` 含两处变化：`engines.node >=18→>=22` 同步（npm install 自动）+ `electron-updater@^6.8.9`
4. 提交历史按领域分了 5 个 commit + 1 个 docs commit，方便逐块 review

---

## 七、过程附注（多智能体流水线）

本轮由 ZCode 编排、三个终端智能体（codex / agy / pi）并行执行：codex 承担了大部分编码与接手收尾（5 次派活全成），agy 完成方案与 E2E 基线修复，pi 参与起步后因 CLI 稳定性问题由 codex 接力（4 次中断零工作丢失，靠 worktree 隔离 + 半成品 diff 备份 + 交接任务书）。所有产物经编排者独立重跑验证，未采信任何工人的自报结论。过程档案（任务书、工人报告、半成品备份）在工作区 `acp_tasks/`，不入仓库。
