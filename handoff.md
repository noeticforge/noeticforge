# 交接文档（handoff）

> **⚠️ 本文件是一次性交接文档，读完即可删除**（正式文档在 `docs/` 目录，本文件与之重复的部分以 `docs/` 为准）。
>
> 交接人：AI 维护助手（代理维护者 Ljj041120 执行）　日期：2026-08-29
> 项目：**agent-base** v0.4.0 —— 开源桌面端 AI Agent 壳（TypeScript + Node.js + Electron）

---

## 一、这轮交接发生了什么（TL;DR）

1. 项目从原开发者的压缩包（xmh.zip）提取，**原开发者署名匿名**（git 历史 `agent-base <dev@agent-base.local>`），git 历史完整保留。
2. **项目归属 noeticforge 组织，维护者 [@Ljj041120](https://github.com/Ljj041120)**：本轮起的新提交全部以 Ljj041120 身份署名；`package.json` 增加 `contributors`；README/CONTRIBUTING 已标注。
3. 完成了一轮**维护性工作**（不加新功能）：
   - 全量**代码审查** → 报告在 [`docs/CODE_REVIEW.md`](docs/CODE_REVIEW.md)，修复 8 项真 bug（F1-F8）
   - **补测试覆盖**：引入 vitest，新增 `tests/` 8 个文件 49 项单元测试（`npm run test:unit`）
   - 全部验证通过：smoke ✅ / unit 49 ✅ / ipc 89 ✅ / codes ✅ / **window 自测 ✅（基线时是失败的，被修好了）** / E2E 15 段 ✅
4. 所有 markdown 文档已同步更新（README / CHANGELOG / CONTRIBUTING / docs/* / journeys/README）。

## 二、这轮修了什么（细节见 CODE_REVIEW.md）

| 编号 | 一句话 |
|---|---|
| F1 | Windows 上透明无边框窗口**原生 maximize 静默失效**（真实应用最大化按钮是坏的）→ win32 改逻辑最大化；这正是 `test:window` 基线失败的原因 |
| F2 | mcp.json 初始 `enabled:false` 的 server，运行中"启用"永不连接 |
| F3 | 损坏插件 zip 击穿"handler 永不 throw"契约 |
| F4 | Anthropic thinking + 工具历史第二轮必 400 → 自动降级不透传 |
| F5 | 纯空白消息绕过校验直发模型 |
| F6 | "当前模型"从未存储，AppInfo 用 models[0] 猜 |
| F7 | 自动起标题会覆盖用户手动改名 |
| F8 | Windows 停终端不杀子进程树 → taskkill /T /F |

另有版本号同源、错误分类等小修——完整清单与"记录不动的设计欠账"（如 agent-service.ts 1252 行超项目行数规则，**本轮刻意不拆**）都在 `docs/CODE_REVIEW.md`。

## 三、30 秒跑起来

```bash
npm install          # 国内网络先 set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build
npm run electron     # 桌面应用
```

## 四、改代码前必跑（五条防线 + E2E）

```bash
npm run smoke        # 循环链路冒烟（离线）
npm run test:unit    # vitest 单元测试 49 项（离线）★本轮新增
npm run test:ipc     # IPC 协议自测 89 项（离线）
npm run check:codes  # 错误码三方一致（离线）
npm run test:window  # 窗口控制（需要桌面环境；CI 不跑，必须本地跑）★基线曾失败，已修复
```

E2E（用户视角 15 段旅程）：跑法与**重跑前必做的清理**见 [`journeys/README.md`](journeys/README.md)——
重点：重跑前清空 `journeys/sessions/`，`journeys/mcp.json` 被忽略需自行创建（不清理会导致 J8 假失败）。

## 五、本仓库的现状与注意事项

- **git**：`main` 分支，远端 **https://github.com/noeticforge/noeticforge**（私有）。工作区有一处**刻意保留的未提交删除**：`iOS27透明液态玻璃/` 设计技能文件（zip 里就是删除状态，历史中可找回）——不影响构建与测试，处置由维护者定夺。
- **git 身份**：本仓库配置 `user.name=Ljj041120 / user.email=Ljj041120@users.noreply.github.com`（新提交自动归属维护者）。
- **测试基建的已知盲区**：`test:window` 不在 CI（无头环境）；journeys E2E 不含窗控旅程。这两层目前只能本地兜底。
- **架构铁律没变**：契约先行（先改 docs 协议再动码）、`core/loop.ts` 三无关、错误码单一事实源、IPC 三件套、工具路径用 `ctx.workingDir`。全文见 `README.md`「核心设计约束」与 `CONTRIBUTING.md`。

## 六、建议的下一步（供维护者决策，本轮未做）

1. `agent-service.ts`（1252 行）与 `renderer/app.js`（1283 行）超出项目自身行数规则，建议未来按领域小步拆分（每步跑全量测试兜底）；
2. Roadmap 未完成项：electron-builder 自动更新、插件受控执行 API（真沙箱）、插件签名与信任分级；
3. journeys E2E 可补一段窗控旅程（最大化/还原），把 F1 类平台 bug 也纳入 E2E 防线；
4. CI 增加 macOS 跑 `test:window`（ xvfb 或 wrapped 环境）的可行性评估。
