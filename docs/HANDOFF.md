# 接力开发指南（Handoff）

> 给下一位开发者：这份文档让你在 30 分钟内掌握"怎么跑、怎么测、哪里不能碰"。
> 深度背景见 `docs/DEVELOPMENT_PLAN.md`（战略路线）与两份协议文档（接口契约）。

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
| `npm run test:unit` | vitest 单元测试 80 项（上下文裁剪/Schema/注册表/会话存储/Provider 流解析/知识库 kb） | 无（离线） |
| `npm run test:ipc` | IPC 协议 89 项（含权限模式/排队/压缩/子代理/MCP/通道接线完整性） | 无（离线） |
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
3. **新增 IPC 通道三件套缺一不可**：preload 声明 + main `handle()` + service 方法。`test:ipc` 的"通道接线完整性"检查会自动抓漏（当前 66 通道；历史教训：v0.4 曾漏注册导致对话全挂）
4. **错误码**只能出自 `src/shared/error-codes.ts`（check:codes 强制同步三方）
5. 工具路径用 `ctx.workingDir`，禁 `process.cwd()`；插件必须 try/catch 返回 ToolResult

## 五、已知边界（接力时别踩）

- **沙箱**：声明式信任 + 审批 + MCP stdio 进程隔离；`preview-file`/`read-attachment`/`@` 可读任意绝对路径（信任渲染进程）。插件受控执行 API 在 Roadmap
- **终端**：非 PTY——交互式全屏程序（vim/top）不支持
- **win32 窗口最大化**：透明无边框窗口原生 `maximize()` 失效，底座在 win32 用逻辑最大化（`setBounds(工作区)` + 手工维护状态，`win:state` 推送语义不变）。Win+方向键等系统级窗口操作与逻辑状态可能短暂不同步（见 `docs/CODE_REVIEW.md` F1）
- **Anthropic + 推理力度**：带工具历史的请求自动不透传 thinking（API 协议限制，底座不存储 thinking 块）；首轮无工具历史时正常透传
- **reasoning_effort**：OpenAI 兼容端点需 config.json `"enableReasoningEffort": true` 才透传（严格网关兼容）；Anthropic 恒透传 thinking
- **打包**：`npm run dist` 产出 release/win-unpacked；应用 cwd 即数据目录（config.json/sessions/audit.log 所在）
- **测试注意**：journeys 依赖 18099/9226 端口，重跑前杀干净旧进程（`taskkill //F //IM electron.exe` + 按端口杀）**并清空 `journeys/sessions/`**（遗留会话会让 J8 的会话数断言失败）；`journeys/mcp.json` 被 gitignore，新机器需自行创建（`{"mcpServers":{"mock":{"command":"node","args":["../dist/scripts/mock-mcp-server.js"],"approval":"never"}}}`，相对路径从 journeys 目录解析）；mock 是无状态按内容路由的，改路由先想"工具结果回来后模型该怎么收尾"
