# 贡献指南

感谢参与 agent-base！这是一份最短必要的协作纪律，请先读完再动手。

> 项目归属 **noeticforge** 组织，维护者：[@Ljj041120](https://github.com/Ljj041120)。

## 环境与验证

```bash
npm install        # 国内网络先 set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run build
npm run smoke      # 循环引擎冒烟（不联网）
npm run test:unit  # vitest 单元测试（核心纯逻辑，不联网）
npm run test:ipc   # IPC 协议自测 89 项（不联网）
npm run check:codes  # 错误码三方一致性校验（文档 == 代码 == UI）
npm run test:window  # 窗口控制自测（本地跑，需要显示器；CI 无头环境不跑）
```

**CI 红了不许合入。** 提 PR 前请本地跑完上面前五条 + `test:window`。

## 铁律（与 README「核心设计约束」同效力）

1. **契约先行**：任何涉及 IPC 通道、`LoopEvent`、插件协议（`types.ts` / manifest）的改动，必须先改 `docs/` 下的协议文档并发起文档 PR 评审，评审通过后再动代码。
2. **循环引擎纪律**：`src/core/loop.ts` 不认识任何具体工具/模型/UI。往里加业务 = 打回。
3. **UI 边界**：渲染进程只准通过 `window.agentBase`（preload）通信，禁止直连 `ipcRenderer`。
4. **错误码单一事实源**：新增错误码必须同步三处——`src/shared/error-codes.ts`、`docs/IPC_EVENT_PROTOCOL.md` §6.2、`renderer/app.js` 的 `ERR_TEXT`。`npm run check:codes` 会校验。
5. 插件崩了不许拖垮主进程；IPC handler 永不 throw；危险操作必须过审批。

## 分支与提交

- `main` 分支保护：只接受 PR，至少一人 review。
- 提交信息格式：`feat|fix|docs|refactor|test|chore: 摘要`（中文摘要即可）。
- 每个功能合并进 `main` 都要在 `CHANGELOG.md` 的「未发布」段记一笔。

## 协议版本纪律

- 新增**可选**字段 = minor；删除字段 / 修改字段语义 = 必须先在文档标注 deprecated，并保留至少一个 minor 版本的兼容期。
- 插件 manifest 带 `protocolVersion`；加载器拒绝高于底座支持的版本。
