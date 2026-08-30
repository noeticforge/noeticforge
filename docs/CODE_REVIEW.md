# 代码审查与测试审查报告

> 审查人：Ljj041120（接管维护）
> 审查范围：v0.4.0 全量源码（src / renderer / plugins / scripts / CI 配置），基线 = 提取自 xmh.zip 的工作区快照
> 性质：维护性审查（测试覆盖 + 代码审查 + 保守修复），**不加新功能，红线是不引入新 bug**
> 每项修复都以测试防线 + 新增单元测试 + journeys E2E 兜底验证
>
> **后续轮次追踪（2026-08-30 更新）**：
> - §三.C 的最大欠账（agent-service 1252 行 / app.js 1283 行超标）已由协作者何惜在「模块化拆分轮」清偿（全部 ≤300 行，见 docs/REFACTOR_REPORT.md）；
> - CI 缺 test:window 的盲区已补（何惜轮 Windows runner 跑窗口自测 + J16 窗控旅程）；
> - 本轮（知识库轮）新增 kb 插件与 17 项单测（tests/kb.test.ts）

## 一、基线（修复前）

| 防线 | 结果 | 说明 |
|---|---|---|
| `npm run smoke` | ✅ 通过 | 循环链路 / 多模态转换 / 严格网关 / 终端 |
| `npm run test:ipc` | ✅ 通过 | 87 项全过（含通道接线完整性） |
| `npm run test:window` | ❌ **失败** | 抓到真 bug F1（见下），非环境问题，重跑 3 次稳定复现 |
| `npm run check:codes` | ✅ 通过 | 错误码三方一致（22 码） |

## 二、测试审查结论

**测得好的（保留不动）**：
- `smoke`：把循环层三道关卡的每条路径（权限拒绝 / 审批改参 / Schema 拦截）都断言到了磁盘副作用层面（"文件确实没有被写入"），是真测试。
- `test:ipc`（87 项）：覆盖排队 / 压缩 / 子代理 / MCP / 附件，第 87 项"通道接线完整性"能自动抓漏注册，价值极高（v0.4 的对话全挂事故就是它防的回归类型）。
- `test:window`：加载真实 renderer + preload 驱动真实窗口，设计正确——**正是它抓到了 F1**。
- `check:codes`：三方一致性守护，简单有效。

**结构性缺口**：
1. **单元测试层完全缺失**（无 jest/vitest）：`trimHistory` / `validateArguments` / `ToolRegistry` / `SessionStore` / SSE 解析等纯逻辑只被高层自测间接覆盖，边界条件（空轮次、损坏会话文件、半截 SSE JSON）无直接断言。→ 本次以 vitest 补齐。
2. **`test:window` 不在 CI 里**（.github/workflows/ci.yml）：CI 只跑 smoke / ipc / codes。F1 因此长期漏网。→ CI 补挂 `test:unit`；`test:window` 因需要显示器仍只能本地跑，已在交接文档标注。
3. ** journeys E2E 不含窗控旅程**：15 段旅程没有覆盖最大化按钮 → F1 从 E2E 层也漏网。已记录，本轮不新增旅程（不加新功能的边界内，靠修复后的 `test:window` 兜底）。
4. IPC 自测缺 MCP「初始 disabled → 再启用」路径（F2 因此漏网）→ 已补自测项。

## 三、代码审查发现与处置

处置原则：**真 bug 修，设计限制记文档，风格问题不动**（AGENTS.md 精准修改纪律）。

### A. 真 bug（已修复）

| # | 级别 | 问题 | 根因与修复 |
|---|---|---|---|
| F1 | 高·平台 | **Windows 上透明无边框窗口无法最大化**：真实 UI 的最大化按钮无效，`test:window` 基线失败 | 探针证实 Electron 在 win32 上对 `transparent:true` 窗口的 `maximize()` 静默失效（不透明场景正常）。修复：win32 下改为逻辑最大化（记录原 bounds → `setBounds(工作区)` → 状态推送），非 win32 保持原生行为；自测改为断言 bounds + 推送状态 |
| F2 | 中 | **MCP：mcp.json 里 `enabled:false` 的 server，启动后从 UI「启用」无效**，状态永远停在 disabled | `init()` 为禁用 server 放置占位连接（closed=true），而 `setConfig()` 的连接循环把占位误判为"已存在"跳过连接。修复：占位（closed）也视为可连接，`connectServer` 自带先断开逻辑 |
| F3 | 中·健壮性 | **损坏的插件 zip 会击穿「handler 永不 throw」契约**：渲染层收到裸 rejection 而非 `{ok:false,error}` | `installPluginFromRegistry` 中 `new AdmZip(...)` / `extractAllTo` 不在 try 内，构造抛错直接逃逸。修复：包入 try 并转 `E_PLUGIN_LOAD_FAILED`；顺带把 `installPlugin` 的 `stat` 竞态与 manifest 非法 JSON 的错误分类修正 |
| F4 | 中·协议 | **Anthropic 开启推理力度（thinking）+ 工具调用的第二轮必 400**：API 要求带 `tool_use` 的 assistant 消息携带 thinking 块，本项目不存储 thinking 块 | 修复（provider 内局部降级）：请求历史中已存在带 tool_calls 的 assistant 消息时，本次请求不再附加 `thinking`（首轮照常透传） |
| F5 | 低 | **纯空白消息可以通过校验**发送给模型 | `isMessageContent` 对任意字符串返回 true 导致空白串绕过非空校验。修复：多模态豁免仅对分片数组成立 |
| F6 | 低 | **「当前模型」从未被存储**：`AppInfo.model` 用 `models[0]` 猜测，设置页传入 models 数组时显示错误 | `setModelConfig` / `init` 显式记录当前模型，`getAppInfo` 读取真实值；preload 的 `setAgentPolicy` 类型补齐 `reasoningEffort` |
| F7 | 低 | **自动起标题会覆盖用户手动改名**（竞态） | `maybeAutoTitle` 落标题前检查会话仍是未命名状态 |
| F8 | 低 | **Windows 上停止终端不杀子进程树**（孤儿进程） | `TerminalManager.stop()` 在 win32 用 `taskkill /T /F` 杀整棵进程树，其余平台保持原行为 |

### B. 设计限制（修复不改语义，文档明确记录）

- `preview-file` / `read-attachment` / `@` 引用信任渲染进程、可读任意绝对路径——即 HANDOFF 已记录的声明式信任边界，本轮维持。
- 审批弹窗同一时刻只呈现一个待审批工具（后端串行执行保证不重叠）；多会话并行时非当前会话的审批事件不弹窗，该会话会等待——记录为已知行为。
- `mcp-status-changed` 推送存在"单条"与"全量"两种 payload 形状（UI 端恰好只整页刷新所以无感）——协议文档标注。
- `shell-exec` 超时 kill 的是 shell 本体，孙进程可能残留（与 F8 同源，插件侧保持原样并记录）。
- 压缩调用（`compressHistory`）不挂 abort 信号，用户 stop 时压缩本身不可中断（窗口极小，记录）。

### C. 记录不动的（维护性欠账，接力者知悉）

- `agent-service.ts` 1252 行、`renderer/app.js` 1283 行：远超项目自身 AGENTS.md 行数规则（300/400 行）。**本轮按既定决策不拆分**（拆分风险 > 收益，87 项 IPC 自测是它的安全网）；建议未来以"按领域拆 slice"方式偿还。
- 死代码：`plugins/loader.ts` 的 `builtinPluginsDir()` 无任何调用方；`E_LOOP_BUSY` 后端已不再发出（排队机制取代拒绝），但作为保留错误码与 UI 文案合理存在。均保留。
- 错误分类靠 `message.includes('manifest')` 字符串匹配，脆弱（F3 顺带把最常见的一类补上了，其余维持）。
- `setModelConfig` 持久化时清空 baseUrl 的实现会静默移除 config.json 里旧值（换回默认端点需要这个行为，属预期，记录）。
- `SessionStore.appendMessages` 每次全量重写会话 JSON，大会话有写放大（性能记录项，v0.2 已知取舍）。
- cli.ts 版本横幅硬编码 v0.1.0（F 系列外的顺手修正：改为读取 package.json 版本）；`APP_VERSION='0.4.0'` 与 package.json 重复，存在漂移风险，已改为同源。

### D. 值得表扬的（审查确认的优秀实践）

- src 全量 **零** `process.cwd()` 违规、零 TODO/FIXME 欠账——项目铁律执行到位。
- 循环引擎对工具/模型/UI 的三无关约束在代码里真实成立，不是文档口号。
- 错误码单一事实源 + CI 强制同步，直接消灭了一整类漂移 bug。
- MCP stdio 最小环境变量注入（不透传父进程全部 env）是很多人会漏的安全细节。
- 渲染层无一处未消毒 innerHTML（marked + DOMPurify 全覆盖）。

## 四、修复后的验证门

1. `npm run smoke` / `test:ipc` / `check:codes` 全绿；
2. `test:window` 转绿（F1 修复的直接证据）；
3. 新增 vitest 单元测试全绿（`npm run test:unit`）；
4. `test:ipc` 新增 MCP 初始禁用→启用用例（F2 的回归防护）；
5. journeys E2E 15 段全绿（用户视角兜底）。
