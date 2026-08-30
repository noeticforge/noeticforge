# 交接文档（handoff）

> **⚠️ 本文件是一次性交接文档，读完即可删除**（正式文档在 `docs/` 目录，本文件与之重复的部分以 `docs/` 为准）。
>
> 交接人：AI 维护助手（代理维护者 Ljj041120 执行）　日期：2026-08-30
> 项目：**agent-base** v0.5.0 —— 开源桌面端 AI Agent 壳（TypeScript + Node.js + Electron）

---

## 一、这轮交接发生了什么（TL;DR）

1. 项目从原开发者的压缩包（xmh.zip）提取，**原开发者署名匿名**（git 历史 `agent-base <dev@agent-base.local>`，按交付文档即"何惜"），git 历史完整保留。
2. **项目归属 noeticforge 组织，维护者 [@Ljj041120](https://github.com/Ljj041120)**：本轮起的新提交全部以 Ljj041120 身份署名；`package.json` 增加 `contributors`；README/CONTRIBUTING 已标注。
3. **已发生三轮开发，正式定版 v0.5.0**（纯代码版本，零安装包）：
   - **维护轮**（Ljj041120）：全量代码审查 + 修复 8 项真 bug + vitest 单测层，报告在 `docs/CODE_REVIEW.md`；
   - **模块化拆分轮**（协作者 何惜，PR #1）：agent-service/app.js 拆分为 ≤300 行模块 + electron-updater 自动更新（默认关）+ CI 窗口自测 + J16 窗控旅程，报告在 `docs/REFACTOR_REPORT.md`；
   - **知识库轮**（Ljj041120）：本地知识库 kb 插件（代码感知切块 + 关键词/向量双路检索），见下节。
4. 所有验证通过：smoke ✅ / unit 77 ✅ / ipc ✅ / codes ✅ / window ✅ / journeys E2E ✅ / 云端 CI 4 环境 100% 全绿（Release 打包工作流已按决策移除，纯代码分发）。

## 〇、知识库轮（最新，2026-08-30）

**kb 插件**（`plugins/builtin/kb`）——完全插件化，底座零改动：

- `kb.search` 检索（空 query=清单）/ `kb.reindex` 强制重建；
- 代码感知切块：.ts/.js/.py 按**函数/类/装饰器语法边界**（纯 JS 零原生依赖），文档按标题/段落；
- 双路检索：关键词 + 向量（OpenAI 兼容 `/v1/embeddings`，默认预设 **VTXAI/vtx-embed-7M**，HF 超轻量代码 embedding）RRF 融合；**embedding 不在线自动降级纯关键词**；
- 设置项（插件设置页）：kbDir / chunking / embedEnabled / embedBaseUrl / embedModel；
- 用法：文档丢进 `知识库/`（仓库附 3 篇示例），对话里问即可；索引 `.kb-index.json` 自动失效重建。
- 向量模式需自建 embedding 服务（Python 包 vtx-embed-7M 成 `/v1/embeddings`），未建则纯关键词照样可用。
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
npm run test:unit    # vitest 单元测试 77 项（离线）
npm run test:ipc     # IPC 协议自测（离线，通道数见输出）
npm run check:codes  # 错误码三方一致（离线）
npm run test:window  # 窗口控制（需要桌面环境；CI 无头不跑）
```

E2E（用户视角 16 段旅程）：跑法与**重跑前必做的清理**见 [`journeys/README.md`](journeys/README.md)——
重点：重跑前清空 `journeys/sessions/`，`journeys/mcp.json` 被忽略需自行创建（不清理会导致 J8 假失败）。

## 五、本仓库的现状与注意事项

- **git**：`main` 分支，远端 **https://github.com/noeticforge/noeticforge**（私有）。工作区有一处**刻意保留的未提交删除**：`iOS27透明液态玻璃/` 设计技能文件（zip 里就是删除状态，历史中可找回）——不影响构建与测试，处置由维护者定夺。
- **git 身份**：本仓库配置 `user.name=Ljj041120 / user.email=Ljj041120@users.noreply.github.com`（新提交自动归属维护者）。
- **测试基建的已知盲区**：`test:window` 不在 CI（无头环境）；journeys E2E 不含窗控旅程。这两层目前只能本地兜底。
- **架构铁律没变**：契约先行（先改 docs 协议再动码）、`core/loop.ts` 三无关、错误码单一事实源、IPC 三件套、工具路径用 `ctx.workingDir`。全文见 `README.md`「核心设计约束」与 `CONTRIBUTING.md`。

## 六、建议的下一步（供维护者决策，本轮未做）

1. ~~`agent-service.ts` 1252 行拆分~~ → **已由协作者何惜在模块化拆分轮完成**（全部 ≤300 行）；剩余 Roadmap 项：插件受控执行 API（真沙箱）、插件签名与信任分级——需维护者拍板安全架构选型；
2. ~~自动更新的发布侧动作~~ → **维护者定调：纯代码分发，不发安装包**；`release.yml` 自动打包工作流已从仓库彻底移除，杜绝任何 tag 触发打包；
3. 知识库向量模式落地：Python 包 vtx-embed-7M 为 `/v1/embeddings` 服务（写好脚本即可切换，未建时纯关键词模式已开箱即用）；
4. `live:check` 真模型联测（需真实 API Key，历轮验证均基于 mock）；
5. CI 窗口自测稳定性观察（Windows runner 偶发风险，必要时加重试）；
6. **网络环境备忘**：GitHub API（api.github.com）在本机直连易超时，走本地代理 `https://proxy=http://127.0.0.1:7897`（Clash 混合端口）；git push 主站通道不受影响。
