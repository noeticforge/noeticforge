# agent-base 底座交付文档

> 交付人：何惜（底座 / 主进程）　接收人：UI 开发（渲染进程）
> 结论先行：**底座已全部完成并通过自动化验证，你现在就可以开始整合 UI。**

---

## 一、这次交付了什么

| 模块 | 状态 | 说明 |
|---|---|---|
| Agent 循环引擎 | ✅ 完成 | 支持工具调用、流式输出、可中断（stop）、审批钩子（批准可改参数、拒绝可填原因） |
| 模型适配层 | ✅ 完成 | DeepSeek / OpenAI / Anthropic 统一接口，配置即切换；SSE 流式输出 |
| 插件系统 | ✅ 完成 | manifest 校验、动态加载、权限最小化校验、运行时装卸、热更新 |
| 安全加固 | ✅ 完成 | 工具参数 JSON Schema 校验（Ajv）、强制审批权限（forceApprovalPermissions）、运行时权限白名单（allowedPermissions）、插件热更新缓存穿透 |
| Electron 外壳 | ✅ 完成 | main + preload，IPC 事件协议 **15 个通道全部实现** |
| 测试页 | ✅ 完成 | `renderer/` 完整可跑的参考 UI（聊天/审批/插件管理/配置/事件日志） |
| 协议文档 | ✅ 完成 | `docs/PLUGIN_PROTOCOL.md` + `docs/IPC_EVENT_PROTOCOL.md` |

## 二、跑起来（3 条命令）

```bash
npm install
npm run build
npm run electron        # 打开桌面窗口，就是测试页
```

注意事项：
- Node.js ≥ 18（开发机是 24）
- 国内网络下载 Electron 二进制慢的话，先执行：
  `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 再 `npm install`
- 不配 API Key 也能启动（只是发消息会返回 `E_PROVIDER_NOT_CONFIGURED`，在界面右侧"模型配置"里填好即可）
- 两个不联网的自动化测试，装完依赖后建议先跑一遍确认环境正常：
  ```bash
  npm run smoke        # 循环引擎 13 项断言
  npm run test:ipc     # IPC 协议 34 项断言
  ```

## 三、架构总览

```
┌─────────────────── 渲染进程（你负责）───────────────────┐
│  renderer/  聊天界面 · 审批弹窗 · 插件管理 · 模型配置      │
│  只通过 window.agentBase（preload 注入）与底座通信        │
└────────────────────────┬───────────────────────────────┘
                    IPC（15 通道，见协议文档）
┌────────────────────────┴───────────────────────────────┐
│  主进程（底座，已完成，一般不用动）                          │
│  AgentService  ←→  ipcMain 薄转发（main.ts）              │
│    ├─ Agent 循环引擎（loop.ts，心脏，工具/模型无关）        │
│    ├─ 工具注册表 + 插件加载器（热装卸、权限校验）            │
│    └─ Provider 适配层（DeepSeek/OpenAI/Anthropic 可换）    │
└─────────────────────────────────────────────────────────┘
```

## 四、UI 整合指南（你的工作怎么开始）

**第一步：把测试页跑起来当对照。** `npm run electron` 打开的窗口就是完整参考实现：流式打字机、工具卡片、审批对话框、插件装卸、模型配置都有，代码在 `renderer/`（纯 HTML/CSS/JS，无框架无构建，直接读得懂）。

**第二步：照协议接你自己的 UI。** 你可以用任何框架（Vue/React 都行），只有两条硬性规则：

1. **只能通过 `window.agentBase` 调用底座**，通道名和 payload 格式以 `docs/IPC_EVENT_PROTOCOL.md` 为准，一个字都不要自创
2. **invoke 返回值是统一包装** `{ok:true,data} | {ok:false,error:{code,message}}`，按 `error.code` 出中文文案（错误码表在协议文档 §6.2）

**第三步：替换 renderer 目录即可。** 你的页面放到 `renderer/index.html`，底座零改动。如果要上构建工具（Vite 等），把产物指到这个路径，或在 main.ts 里改 `loadFile` 一行。

**最常用的对接速记**（完整版看协议文档）：

```javascript
// 发消息
const { data } = await window.agentBase.sendMessage({ role: 'user', content: '帮我读一下 README' })
// data.messageId —— 之后所有事件都带它，用来归并到同一条对话

// 收流式输出
window.agentBase.on('message-chunk', e => appendToBubble(e.messageId, e.delta))

// 收到审批请求 → 用户点按钮
window.agentBase.on('approval-required', e => showDialog(e))
await window.agentBase.approveTool({ messageId: e.messageId, toolCallId: e.toolCallId })
// 拒绝：rejectTool({ messageId, toolCallId, reason: '...' })

// 停止按钮
await window.agentBase.stop()   // 之后会收到 loop-done 且 stopped=true
```

## 五、已验证 / 未验证（如实说明）

**已通过自动化验证（都不需要 API Key）：**
- 冒烟测试 20 项：插件加载 → 循环 → 工具真实执行（文件真实读写）→ 审批批准/拒绝两条路径 → 安全场景（强制审批、审批改参真实生效等）
- IPC 自测 34 项：15 个通道逐条验证，含 E_LOOP_BUSY / E_NO_PENDING_APPROVAL / stop 中断 / 插件热装卸 / 配置持久化 / 流式 chunk 拼接等
- Electron 应用启动：窗口正常加载测试页，自动退出模式 exit=0

**未验证（需要你或后续补充）：**
- 真实模型 API 调用（开发机上没有 API Key；DeepSeek/OpenAI 的流式解析逻辑已写好但没打过真流量，接 Key 后如有格式问题在 `src/providers/openai-compatible.ts` 修）
- Anthropic 只做了非流式（全文一次性回调 onChunk），流式留作后续
- 打包安装（electron-builder 未配置，现在只能开发模式跑）

## 六、协议文档索引（都在 zip 里）

| 文档 | 给谁看 |
|---|---|
| `docs/IPC_EVENT_PROTOCOL.md` | **你（必读）**：15 个通道的完整定义 + 时序图 + 错误码表 |
| `docs/PLUGIN_PROTOCOL.md` | 插件开发者：manifest 规范、工具接口、审批机制、装卸流程 |
| `README.md` | 项目总览、快速开始、核心设计约束（改代码前必读） |

## 七、底座侧的遗留事项（不挡 UI 整合）

1. Anthropic 流式输出
2. 插件沙箱加固（当前插件与主进程同权限，上架前必须做进程隔离）
3. electron-builder 打包成安装包
4. 多会话支持（当前全局单一会话历史；协议留了 messageId，扩展时 UI 无感）

有任何接口对不上的地方，以协议文档为准提出来，底座这边改。
