# agent-base

桌面端 AI Agent 底座。技术栈：**TypeScript + Node.js + Electron**。

## 你拿到的是什么

```
src/
├── types.ts                  全局类型契约（消息/工具/插件/事件/审批）
├── providers/                模型适配层
│   ├── provider.ts           工厂：config.json 里换 provider 名即换模型
│   ├── openai-compatible.ts  DeepSeek / OpenAI 及一切兼容厂商（SSE 流式 + 可中断）
│   ├── anthropic.ts          Anthropic Messages API
│   └── mock.ts               脚本化假模型（测试用，不联网）
├── core/
│   ├── loop.ts               Agent 循环引擎（心脏，写完不再改；支持 AbortSignal 中断 + 流式）
│   └── registry.ts           工具注册表
├── plugins/
│   └── loader.ts             插件加载器（manifest 校验 + 动态 import + 热更新缓存穿透）
└── electron/
    ├── agent-service.ts      IPC 事件协议的完整业务实现（不含 Electron API，可独立自测）
    ├── main.ts               Electron 主进程（ipcMain 薄转发层）
    └── preload.ts            contextBridge 暴露 window.agentBase API（UI 唯一入口）

renderer/                     测试页（纯 HTML/CSS/JS，UI 开发者的参考实现，可整体替换）
plugins/builtin/              内置插件（每个插件 = 一个文件夹，纯 JS，无需编译）
├── read-file/                读文件（fs:read，无需审批）
└── write-file/               写文件（fs:write，执行前必须用户批准 ← 审批钩子演示）
plugins/user/                 用户安装的插件落盘位置（install-plugin 自动复制到这里）

scripts/smoke.ts              循环引擎冒烟测试（不联网）
scripts/ipc-selftest.ts       IPC 协议自测（34 项断言，不联网不依赖 GUI）
src/cli.ts                    终端 demo（接真模型）
docs/                         协议文档（插件协议 + IPC 事件协议）
```

## 快速开始

```bash
npm install
npm run build

npm run smoke        # 循环链路冒烟测试（无需 API Key）
npm run test:ipc     # IPC 协议 34 项自测（无需 API Key / GUI）

# 桌面应用（会打开窗口；测试页即是 UI 参考实现）
npm run electron

# 或终端里直接和真模型聊天
cp config.example.json config.json   # 填入你的 apiKey
npm run cli
```

## 换模型 = 改配置（或 UI 里点一下）

```jsonc
// config.json
{ "provider": "deepseek",  "apiKey": "sk-...", "model": "deepseek-chat" }  // 或 "openai" / "anthropic"
```

UI 里调 `set-model-config` 也会持久化到这里。

## UI 开发者（渲染进程）怎么接

1. 只允许通过 `window.agentBase`（preload 注入）与底座通信，通道名见 `docs/IPC_EVENT_PROTOCOL.md`
2. `renderer/` 下的测试页是完整可跑的参考实现：聊天流式、工具卡片、审批对话框、插件管理、模型配置都有
3. 你自己的 UI 可以直接替换 `renderer/` 目录，只要还调同一套 API，底座零改动

## 写一个新插件（30 秒版）

1. 新建 `plugins/my-tool/manifest.json`（声明 name / version / permissions / entry）
2. 新建 `plugins/my-tool/index.js`，导出 `{ tools: [{ name: 'my-tool.xxx', description, parameters, permissions, execute }] }`
3. 重启程序（或在 UI 里 install-plugin），完成。工具名必须以插件名开头，工具要求的权限必须是 manifest 声明的子集。

完整规范见 `docs/PLUGIN_PROTOCOL.md`。

## 核心设计约束（改代码前必读）

- **循环引擎不认识任何具体工具/模型/UI**，只认 `LLMProvider` 和 `ToolRegistry` 两个接口——这是"固定好基础 Agent 循环"的含义
- **插件崩了不许拖垮主进程**：加载失败跳过并记录，执行异常转成错误结果喂回模型
- **危险操作必须过审批钩子**：工具声明 `requiresApproval: true`，或权限命中底座配置的 `forceApprovalPermissions` 强制列表（可覆盖插件声明）
- **工具执行前三道关卡**：① 运行时权限白名单（`allowedPermissions`，越权 → `permission-denied`）→ ② 审批 → ③ 参数 JSON Schema 校验（模型原始参数和审批修改后的参数都过 ajv，不合法 → `invalid-arguments`）。三关失败都是错误结果喂回模型，不崩循环
- **权限模型的边界（重要，别对文档吹牛）**：当前是"声明式信任模型"——加载时校验 tool.permissions ⊆ manifest.permissions，运行时校验白名单，但**没有沙箱**，插件进程内调用原生 API 不受物理拦截；真正的进程隔离沙箱在 Roadmap（与 MCP 独立进程工具合流）
- **IPC handler 永不 throw**：全部异常转成 `{ok:false,error}` 返回（协议 §6.4）
- 工具的相对路径以底座注入的 `ctx.workingDir` 为基准，**不要用 `process.cwd()`**（Electron 里不可靠）
- 所有对外行为通过事件流暴露：循环层是 `LoopEvent`，IPC 层与之逐条对应（见 `docs/IPC_EVENT_PROTOCOL.md`）

## Roadmap

- [x] Provider 层（DeepSeek/OpenAI/Anthropic 统一接口 + SSE 流式 + 可中断）
- [x] Agent 循环 + 工具注册表 + 审批钩子（批准参数覆盖 / 拒绝原因回填）
- [x] 插件加载器（manifest 校验 / 动态加载 / 热装卸 + 热更新缓存穿透）
- [x] Electron 主进程外壳 + IPC 事件桥（15 个通道全部实现）
- [x] 流式输出（provider 逐 token → message-chunk）
- [x] 安全三道关卡（运行时权限白名单 / 强制审批配置 / 参数 Schema 校验）
- [ ] Anthropic 流式（当前非流式，全文一次性回调）
- [ ] 插件沙箱加固（进程隔离 / 资源限额）
- [ ] 插件市场目录与远程安装
