# 上下文摘要压缩 v2 交付报告（v0.6.0）

> 日期：2026-09-06　作者：Ljj041120（ZCode 协作）
> 范围：上下文窗口管理——把 v0.3 的「每条消息重复摘要」升级为「增量摘要 + 会话 meta 持久化 + 配置开关 + 成本明示」。
> 本地七项验证防线全绿后才提交；**本轮未推送远端**（按要求先落本地）。

---

## 一、TL;DR

长会话超出 `contextTokenBudget` 时，旧历史不再被"静默丢掉也不是每轮重复付费摘要"：被丢弃的旧整轮由 LLM 压缩成 ≤300 字要点摘要**做一次就留底**（持久化到会话 meta），后续发送**零 LLM 调用直接复用**，直到有新整轮被丢弃才增量重写（旧摘要合并进新摘要，上下文不丢）。复用期间发给模型的前缀**逐字节稳定**——这是自测断言保障的 Prompt Cache 命中。压缩发生时 UI 推送轻量提示（成本明示），`summarize: false` 一键关回纯截断。完整历史落盘契约不变，`core/loop.ts` 心脏零改动。

## 二、升级前的问题（v0.3 遗留，代码调研证实）

| # | 问题 | 位置 |
|---|---|---|
| 1 | 超预算后**每条消息都重新调 LLM 摘要**（同样旧轮反复付费、输出非确定） | `workspace-service.ts` compressHistory 旧版 |
| 2 | 摘要不持久化 → 摘要文本每轮都变 → systemPrompt 之后整个前缀**每轮 prompt cache miss** | 同上 |
| 3 | 无配置开关（DEVELOPMENT_PLAN §8.2 明确要求 `summarize`） | config 层 |
| 4 | 压缩对用户完全不可见（§8.2 要求"成本要明示用户"） | UI/协议层 |

## 三、四个设计决策（及理由）

1. **摘要存 `session.meta.compaction`，不改写 `session.messages`。**
   `scripts/ipc-selftest.ts` 既有断言"磁盘历史保持全量（压缩只影响发给模型的内容）"是 documented 契约；改写 messages 会丢原始数据。meta 经 `persist` 全量 JSON 落盘天然支持新字段，旧会话文件无该字段 → 首次超预算走全量摘要路径，完全向后兼容。
2. **注入点在 `agent-service.runLoopTask` 组装 inputHistory 时头部注入，`core/loop.ts` 零改动。**
   与 v0.3 产物形状一致（`【历史摘要】`user + 应答 assistant 对置于保留历史之前）；loop 内置 `trimHistory` 已兼容"不以 user 开头的历史"（`tests/context.test.ts` 既有用例）。心脏铁律不破。
3. **增量算法以「丢弃边界」为锚。** `boundary = history.length - keep.length`（keep 是连续尾部，trimHistory 保证）；`boundary ≤ previous.upTo` → 复用（零调用）；`boundary > upTo` → 只把**新增丢弃段** + 旧摘要一起喂给模型重写。正确性依赖"完整历史 append-only"（`replaceMessages` 只追加尾部）——已作为类型注释与 HANDOFF 边界写入文档。
4. **`summarize` 开关默认 `true`（保持现网行为）**，`false` 退回纯整轮截断；`applyConfig` 严格 `typeof === 'boolean'` 解析，`setModelConfig`/`setAgentPolicy` 的持久化经 `...existing` 展开天然保留该字段。

## 四、改动清单（15 文件，+146/−16）

| 层 | 文件 | 改动 |
|---|---|---|
| 会话存储 | `src/core/session-store.ts` | `SessionCompaction` 类型 + `Session.meta.compaction` + `updateMeta()` 合并落盘 |
| 会话服务 | `src/electron/services/session-service.ts` | `updateMeta` 透传 |
| 压缩算法 | `src/electron/services/workspace-service.ts` | `compressHistory` 增量化：`(history, provider, previous?) → { messages, record? }`；摘要对提取为 `withSummaryHeader` |
| 编排 | `src/electron/agent-service.ts` | `runLoopTask`：summarize 开关短路 + previous 传递 + record 落盘 + `context-compacted` 推送（仅增量重写时） |
| 配置 | `src/electron/services/model-policy-service.ts`、`config.example.json` | `RuntimePolicy.summarize`（默认 true）+ 示例配置 |
| 协议 | `docs/IPC_EVENT_PROTOCOL.md` §7.5、`src/electron/types.ts`、`src/electron/preload.ts` | 新推送 `context-compacted` `{messageId, sessionId, coveredCount, summary}`（协议版本保持 2，按增补节惯例登记） |
| UI | `renderer/app.js`、`renderer/modules/chat.js`、`renderer/style.css` | 订阅 + 单行分隔提示（悬浮见摘要全文，`.compact-notice`） |
| 测试 | `tests/workspace-compaction.test.ts`（新）、`scripts/ipc-selftest.ts` §11 | 4 项单测 + 6 项 IPC 断言（复用零调用/前缀字节级一致/事件单推/meta 持久化/磁盘全量） |
| 文档 | `CHANGELOG.md`、`README.md`、`docs/HANDOFF.md`、`docs/DEVELOPMENT_PLAN.md` §8.2、本报告 | 版本 0.6.0、配置说明、边界说明、路线图对账 |

## 五、验证数据（本地七项防线，全绿）

| 防线 | 结果 |
|---|---|
| `npm run build` / `typecheck` | ✅ |
| `npm run smoke` | ✅ 全部通过 |
| `npm run test:unit` | ✅ **85/85**（81 存量 + 4 新增，全部通过） |
| `npm run test:ipc` | ✅ **94 项断言**全通过，72 通道接线完整（缺失: 无） |
| `npm run check:codes` | ✅ 错误码三方一致（22 码） |
| `npm run test:window` | ✅ 窗控全通过（本机桌面环境） |
| renderer 语法 | ✅ `node --check` app.js / chat.js（原生 JS 无编译门禁，手动补测） |

**新增关键断言（ipc-selftest §11）**：
1. `cap.calls === 4` 保持成立——第三条消息仍恰好触发一次摘要（旧行为不回归）；
2. 第四条消息（无新丢弃轮）→ `cap.calls === 5`：**复用摘要，零重复摘要调用**；
3. 第三/四轮发给模型的 firstUser **逐字节相等**（Prompt Cache 稳定性）；
4. `context-compacted` 恰好推送 1 次（仅增量重写时推送，复用不推）；
5. 落盘会话 JSON `meta.compaction.upTo === 2` 且摘要非空（持久化）；
6. 磁盘历史 8 条全量、首条 2 万字符原样（契约不回归）。

## 六、代码审查结论（交付前门禁，本轮新增）

对全部 15 个未提交文件做了逐行 diff 审查 + 交叉验证，**未发现新引入缺陷**：

- **调用方收口**：`compressHistory` 签名变更仅 1 个调用方（`agent-service.ts:217`），smoke/sdk/cli 无引用；
- **复用判定**：`compressed.record !== previous` 引用比较精确区分"复用/重写"；`updateMeta` 以展开合并保留同一 record 引用，后续复用判定稳定；
- **失败路径**：摘要调用或落盘异常 → catch 回退全量历史 → loop 内置截断兜底（与升级前行为一致，无新增错误码）；
- **并发**：同会话循环被 running 锁串行化，压缩在 runLoopTask 内同步完成，无竞态；
- **边界情形**：boundary=0 原样返回；`previous.summary` 为空按无记录处理；keep 恒为连续尾部（trimHistory 保证，含"历史不以 user 开头"既有用例）；摘要对自身超预算时被 loop 优先裁掉，降级合理；
- **UI/协议**：通道在 types/preload/renderer 三处同步登记，`node --check` 通过；压缩事件到达非活跃会话时仅记日志不插提示（切换回也不补显）——已知轻量行为，非缺陷。

已知非本次引入的既有问题（未顺手改，遵守精准修改）：协议文档 §3 的推送事件表/计数自 v0.4 起即滞后于实际（权威增补节在 §7）。

## 七、已知边界与后续事项

- **journeys E2E（16 段旅程）本轮未跑**：需三终端手跑 + 清理流程，超出本轮；压缩链路已由 ipc-selftest 服务级全链路覆盖。推送远端后由云端 CI（ubuntu/windows × Node 22/24）复核。
- **`live:check` 真模型联测仍未销案**（历史欠账，需真实 API Key）——摘要质量在真实模型上的表现建议届时一并观察。
- 摘要提示词沿用 v0.3（≤300 字要点）；增量合并场景（旧摘要 + 新丢弃轮）已入 transcript，真实模型效果可在使用中观察调优。
- 会话 meta 的 `upTo` 依赖历史 append-only：`replaceMessages` 勿用于截断/重写历史（HANDOFF 已写边界）。
