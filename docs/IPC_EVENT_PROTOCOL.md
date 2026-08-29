# IPC 事件协议规范（IPC Event Protocol）

> 适用范围：本项目 UI（渲染进程 / renderer）与 Agent 底座（主进程 / main）之间的全部通信。
> 读者对象：渲染进程前端开发、主进程 Agent 循环维护者。
> 所有通道名与消息字段以本文档为准，字段类型与素材库（`src`）中的接口保持一致。

---

## 1. 概述

主进程与渲染进程通过 Electron 的两种 IPC 原语通信：

| 原语 | 方向 | 用途 |
|---|---|---|
| `ipcMain.handle` + `ipcRenderer.invoke` | UI → 主进程 | 请求-响应式调用（一问一答），如发送消息、装卸插件、改配置 |
| `webContents.send` + `ipcRenderer.on` | 主进程 → UI | 单向事件推送（流式增量、工具状态、审批请求、会话终结），UI 只收不发 |

### 1.1 通道总览

**UI → 主进程（invoke，共 8 个事件）：**

| 通道名 | 用途 | 是否异步 |
|---|---|---|
| `send-message` | 用户提交一条消息给 Agent | 立即返回，接受后经 `message-chunk` 流式回吐 |
| `approve-tool` | 用户批准一个待审批的工具调用 | 立即返回 |
| `reject-tool` | 用户拒绝一个待审批的工具调用 | 立即返回 |
| `stop` | 终止当前正在进行的 Agent 循环 | 立即返回 |
| `list-plugins` | 查询已安装插件列表 | 立即返回 |
| `install-plugin` | 从本地目录安装一个插件 | 立即返回（含校验结果） |
| `uninstall-plugin` | 卸载一个插件 | 立即返回 |
| `set-model-config` | 更新 LLM Provider 配置（密钥/模型/地址） | 立即返回 |

**主进程 → UI（webContents.send 推送，共 7 个事件）：**

| 通道名 | 触发时机 |
|---|---|
| `message-chunk` | 模型流式输出的每个增量文本 |
| `tool-started` | 一个工具调用管道开始执行时 |
| `tool-result` | 工具执行完成（成功或失败）时 |
| `approval-required` | 工具需要用户审批时 |
| `loop-done` | 一轮 Agent 循环正常结束 |
| `loop-error` | 一轮 Agent 循环出错（结构见 §6.3） |
| `plugins-changed` | 插件注册表发生变化（安装/卸载/热更新后） |

---

## 2. 通用约定

1. **类型命名**：请求 payload 用 `Ipc…Request`，推送 payload 用 `…Event`，便于快速区分方向。
2. **统一返回包装**：所有 `invoke` 事件无论成功失败都返回下面的包装，**主进程 handler 不主动 throw**：

```typescript
type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: LoopError };
```

3. **错误对象**：`LoopError` 结构在 §6 定义，UI 层只需读 `error.code` / `error.message` 即可。
4. **消息关联**：主进程在 `send-message` 成功后生成 `messageId`，此后该轮的所有推送事件（`message-chunk`、`tool-started`、`tool-result`、`loop-done`、`loop-error`）都携带同一个 `messageId`，UI 据此归并到对话条目。
5. **核心消息类型**（与源码一致，IPC payload 复用之，勿改）：

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
```

---

## 3. UI → 主进程事件（ipcRenderer.invoke）

### 3.1 `send-message`

用户提交一条消息，启动（或继续）Agent 循环。

```typescript
interface SendMessageRequest {
  message: ChatMessage;      // 通常是 role: 'user'
}
// 返回：
//   ok: true  → data: { messageId: string }
//   ok: false → error.code ∈ ['E_INVALID_MESSAGE','E_PROVIDER_NOT_CONFIGURED','E_LOOP_BUSY']
```

- 接受后主进程立即生成 `messageId` 返回；该轮会话后续推送都携带它。
- `message.role` 必须为 `'user'`（其余 role 走内部 flush）。`'tool'` 消息的 `content` 与 `toolCallId` 由主进程在循环内维护，UI 不应主动发送。
- 若上一轮循环尚未结束（`loop-done`/`loop-error` 未推送）又收到新消息，返回 `E_LOOP_BUSY`。
- 未配置任何 Provider 时返回 `E_PROVIDER_NOT_CONFIGURED`。

### 3.2 `approve-tool`

用户批准 `approval-required` 事件列出的工具调用继续执行。

```typescript
interface ApproveToolRequest {
  messageId: string;
  toolCallId: string;        // 来自 approval-required 事件
}
// 返回：ok: true → data: null
//       ok: false → error.code ∈ ['E_TOOL_NOT_FOUND','E_NO_PENDING_APPROVAL']
```

- 批准后，主进程执行该工具并推送 `tool-result`（`tool-started` 已在审批前推送过）。
- 若用户想微调参数再执行，UI 应携带完整新参数的 `arguments` 一并传入（字段可选，见下）：

```typescript
interface ApproveToolRequest {
  messageId: string;
  toolCallId: string;
  arguments?: Record<string, unknown>;   // 可选：覆盖执行参数（用户在审批框修改后的完整参数）
}
```

- 主进程对修改后的 `arguments` **有义务重新做 JSON Schema 校验**（依据该工具的 `parameters`，流程见《插件协议规范》§4.5；模型生成的原始参数同样要过这一关）。校验失败 → 工具**不执行**，以 `{ ok:false, output:'参数校验失败: <具体错误>', error:'invalid-arguments' }` 回填模型并推送 `tool-result`（按 `invalid-arguments` 处理，见 §6.2）；校验通过才真正执行。
- 对同一 `toolCallId` 重复批准返回 `E_NO_PENDING_APPROVAL`。

### 3.3 `reject-tool`

用户拒绝待审批的工具调用。

```typescript
interface RejectToolRequest {
  messageId: string;
  toolCallId: string;
  reason?: string;           // 可选：拒绝原因，回填给模型参考
}
// 返回：ok: true → data: null
//       ok: false → error.code ∈ ['E_TOOL_NOT_FOUND','E_NO_PENDING_APPROVAL']
```

- 拒绝后该 tool call 不执行；主进程构造 `{ ok:false, output:'用户拒绝了该工具的执行', error:'rejected-by-user' }`（作为带 `toolCallId` 的 `'tool'` 消息）回填给模型，并推送 `tool-result`，Agent 循环继续（模型可据此换方案）。

### 3.4 `stop`

请求立即终止当前 Agent 循环。

```typescript
interface StopRequest {
  // 无字段（空对象）
}
// 返回：ok: true → data: null
```

- 主进程收到后：中断 LLM 流式响应、丢弃待执行的 tool call 队列、结束本轮循环，并推送一条 `loop-done`（`stopped: true`）。
- 若当前没有进行中的循环，返回 `ok: true` 但不做任何事（幂等）。

### 3.5 `list-plugins`

查询已注册插件快照，用于 UI 插件管理页的首帧渲染。

```typescript
interface ListPluginsRequest {
  // 无字段（空对象）
}
// 返回：ok: true → data: { plugins: PluginInfo[] }
```

```typescript
interface PluginInfo {
  name: string;          // manifest.name
  version: string;       // manifest.version
  displayName: string;
  description: string;
  author?: string;
  permissions: string[]; // 已声明的权限
  tools: string[];       // 该插件暴露的工具完整名（如 "read-file.read"）
}
```

### 3.6 `install-plugin`

从本地目录安装（或热更新）一个插件。

```typescript
interface InstallPluginRequest {
  pluginDir: string;       // 插件文件夹的绝对路径（含 manifest.json）
}
// 返回：
//   ok: true  → data: { plugin: PluginInfo }
//   ok: false → error.code ∈ ['E_PLUGIN_LOAD_FAILED','E_PLUGIN_VALIDATION_FAILED','E_PLUGIN_ALREADY_EXISTS','E_PATH_NOT_FOUND']
```

- 加载与校验规则见《插件协议规范》§5.1-5.2（`manifest` 校验、命名、schema、权限、工具重名）。
- 安装成功（含热更新替换旧同 name 插件）后，主进程必然推送一次 `plugins-changed`。

### 3.7 `uninstall-plugin`

卸载一个插件。

```typescript
interface UninstallPluginRequest {
  name: string;            // 插件唯一 ID（manifest.name）
}
// 返回：
//   ok: true  → data: { plugin: PluginInfo }
//   ok: false → error.code ∈ ['E_PLUGIN_NOT_FOUND','E_PLUGIN_IN_USE','E_PLUGIN_UNINSTALL_FAILED']
```

- 插件工具正在执行时返回 `E_PLUGIN_IN_USE`（也可以等待完成后再卸载，见主进程实现策略）。
- 成功后推送 `plugins-changed`。

### 3.8 `set-model-config`

更新 LLM Provider 配置。Provider 适配层为统一接口，支持 `DeepSeek` / `OpenAI` / `Anthropic`。

```typescript
interface ModelProviderConfig {
  provider: 'deepseek' | 'openai' | 'anthropic';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;    // 0-2，默认 1
  maxTokens?: number;      // 单次回答最大 token
}

interface SetModelConfigRequest {
  config: ModelProviderConfig;
}
// 返回：ok: true → data: null
//       ok: false → error.code ∈ ['E_INVALID_CONFIG','E_PROVIDER_UNSUPPORTED','E_INVALID_API_KEY']
```

- 修改会持久化（主进程侧存储），重启后仍生效。
- `provider` 不在三选一时返回 `E_PROVIDER_UNSUPPORTED`；缺少 `apiKey` 时返回 `E_INVALID_CONFIG`。
- 配置生效后，未开始的新循环使用新配置；进行中的循环不受影响。

---

## 4. 主进程 → UI 事件（webContents.send）

### 4.1 `message-chunk`

LLM 流式输出的一段增量文本。

```typescript
interface MessageChunkEvent {
  messageId: string;
  role: 'assistant';
  delta: string;           // 本次增量文本（可为空字符串，用于结束信号）
}
```

- UI 应按 `messageId` 找到对应对话条目，把 `delta` 拼接进 content。
- 多份 `chunk` 之间保证有序到达。
- 工具调用（tool_calls）不通过本事件下发，模型声明工具的时刻由 `tool-started` 事件暴露。

### 4.2 `tool-started`

一个工具调用开始执行。

```typescript
interface ToolStartedEvent {
  messageId: string;
  toolCallId: string;
  name: string;                        // 工具完整名，如 "read-file.read"
  arguments: Record<string, unknown>;  // 模型生成的原始参数（tool-started 在审批之前推送）
}
```

- UI 用来展示"模型正在调工具 X（参数 …）"的中间态。
- 该事件只宣告调用开始；若工具需要审批（`requiresApproval: true`，或工具权限命中底座的 `forceApprovalPermissions` 强制审批列表），此时**尚未执行**，请等待审批结果（见 §4.4）。
- 若工具调用在推送 `tool-started` **之前**就被拦下（工具不存在、或运行时权限策略拒绝），UI 不会收到 `tool-started`，只会收到一条 `tool-result`（`error` 为 `'tool-not-found'` 或 `'permission-denied'`）。
- tool 执行结果（或拒绝占位结果）以 `tool-result` 事件收尾。

### 4.3 `tool-result`

工具执行完成（成功或失败）后的结果。

```typescript
interface ToolResultEvent {
  messageId: string;
  toolCallId: string;
  result: ToolResult;      // 结构见下（与源码一致）
}
```

```typescript
interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;            // 预置错误码见下（共 5 个），插件也可返回自定义 error
}
```

- `result.ok === true`：UI 展示 `output` 的摘要。
- `result.ok === false && result.error`：UI 展示错误，主进程已同时将其回填给模型。
- 用户拒绝审批时工具**不会执行**，主进程以 `{ ok:false, output:'用户拒绝了该工具的执行', error:'rejected-by-user' }` 推送（详见 §4.4）。
- `result.error` 的**预置值**（由底座构造，均伴随失败回填给模型；插件自定义 error 不在保留词表内）：
  - `'tool-not-found'`：工具在全局工具表未命中，工具不执行（不会推送 `tool-started`）；
  - `'rejected-by-user'`：用户拒绝审批，工具不执行；
  - `'permission-denied'`：工具权限被运行时权限策略（`allowedPermissions` 白名单）拒绝，工具不执行（不会推送 `tool-started`）；
  - `'invalid-arguments'`：参数未通过 JSON Schema 校验（模型原始参数或审批时用户修改后的参数都不例外），工具不执行；
  - `'tool-crashed'`：插件 execute 抛异常被底座兜底捕获。

### 4.4 `approval-required`

满足以下任一条件即触发审批：工具的 `AgentTool.requiresApproval === true`；或工具请求的权限命中底座配置的 `forceApprovalPermissions` 强制审批列表（即使插件自己声明了 `requiresApproval: false`，只要权限命中列表也必须审批）。执行前需要用户批准。

```typescript
interface ApprovalRequiredEvent {
  messageId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;   // 模型生成的原始参数
  reason?: string;             // 底座填充的审批说明（如 "该工具需要用户批准后执行"）
}
```

- 触发时序：该工具相关的 `tool-started` **已推送**（工具不存在 / 权限被策略拒绝等前置故障不会推送 `tool-started`，见 §4.2），但工具**尚未执行**。UI 应以明确的对话框展示工具名与参数，引导用户决定。
- 批准 → 调 `approve-tool`（可选携带修改后的 `arguments`）→ 主进程先对（原始或修改后的）参数**重新做 JSON Schema 校验**（依据工具 `parameters`），校验失败则工具不执行、按 `invalid-arguments` 处理（返回 `{ ok:false, output:'参数校验失败: <具体错误>', error:'invalid-arguments' }`）；校验通过才执行该工具，结果以 `tool-result` 推送；
- 拒绝 → 调 `reject-tool` → 工具不执行，主进程推送 `{ ok:false, output:'用户拒绝了该工具的执行', error:'rejected-by-user' }` 的 `tool-result`；
- 在用户给出决定之前，主进程挂起该 tool call（Agent 循环暂停输出）。

### 4.5 `loop-done`

一轮 Agent 循环正常结束。

```typescript
interface LoopDoneEvent {
  messageId: string;
  content: string;         // 最终整段答案（若中途停止则为已输出部分）
  stopped: boolean;        // true 表示由 stop 事件终止
}
```

- UI 可据此收起流式光标、禁用停止按钮。
- 若循环内最后一次是工具调用且模型未产出最终内容，`content` 可能为空字符串。

### 4.6 `loop-error`

一轮 Agent 循环因错误终止。Paylod 结构见 §6.3。

```typescript
interface LoopErrorEvent {
  messageId: string;
  error: LoopError;        // { code, message, phase, ... }，见 §6
}
```

### 4.7 `plugins-changed`

插件注册表变更后推送一次全量快照，UI 刷新插件管理列表。

```typescript
interface PluginsChangedEvent {
  plugins: PluginInfo[];   // 全量列表（而非增量），UI 直接整体替换
}
```

- 触发时机：`install-plugin` / `uninstall-plugin` 成功、启动时初始加载完成。

---

## 5. 一次完整会话的事件时序

场景：用户发送消息 → 模型流式输出 → 模型调用 `read-file.read`（需要审批）→ 用户批准 → 工具执行并返回 → 模型完成回答。

说明：`read-file.read` 在 AgentTool 上声明了 `requiresApproval: true`（审批同样可由工具权限命中底座 `forceApprovalPermissions` 强制审批列表触发，效果相同），因此 `tool-started` 之后要先过审批；审批通过并**通过参数 Schema 校验**后才真正执行。

```
UI (renderer)                            Agent 底座 (main)                    read-file 插件
     │                                          │                                    │
     │  invoke('send-message',{message})        │                                    │
     │─────────────────────────────────────────>│                                    │
     │  <── {ok:true, data:{messageId:"m1"}} ───│ 生成 messageId=m1, 开始 Agent 循环   │
     │                                          │──────── LLM stream ────────────────>│
     │  on('message-chunk',{messageId:"m1",delta:"明天"})                              │
     │<─────────────────────────────────────────│                                    │
     │  on('message-chunk',{messageId:"m1",delta:"多云"}) …更多增量…                    │
     │<─────────────────────────────────────────│                                    │
     │                                          │ LLM 返回 tool_calls[0]             │
     │  on('tool-started',{messageId:"m1",toolCallId:"tc_1",name:"read-file.read",    │
     │                     arguments:{path:"/tmp/a.txt"}})  ── 仅宣告,尚未执行         │
     │<─────────────────────────────────────────│ tool.requiresApproval===true        │
     │  on('approval-required',{messageId:"m1",toolCallId:"tc_1",                     │
     │                         name:"read-file.read",arguments:{path:"/tmp/a.txt"}})  │
     │<─────────────────────────────────────────│  挂起,等待 UI 决定                  │
     │  invoke('approve-tool',{messageId:"m1",toolCallId:"tc_1"})                    │
     │─────────────────────────────────────────>│                                    │
     │                                          │  参数 Schema 校验(ajv) ✔            │
     │                                          │──── execute(args, ctx) ───────────>│
     │                                          │<── {ok:true, output:"...文件内容…"}│
     │  on('tool-result',{messageId:"m1",toolCallId:"tc_1",result:{ok:true,          │
     │                   output:"...",}})                                             │
     │<─────────────────────────────────────────│ 回填 tool 消息 → 二次调用 LLM       │
     │  on('message-chunk',{messageId:"m1",delta:"该文件内容为…"})                     │
     │<─────────────────────────────────────────│                                    │
     │  on('loop-done',{messageId:"m1",content:"该文件内容为…",stopped:false})         │
     │<─────────────────────────────────────────│                                    │
     │                                          │                                    │
```

若用户在审批框点「拒绝」而不是「批准」：

```
     │  invoke('reject-tool',{messageId:"m1",toolCallId:"tc_1",reason:"路径敏感"})       │
     │─────────────────────────────────────────>│  tool 不执行                         │
     │                                          │  构造 {ok:false,                     │
     │                                          │    error:'rejected-by-user',         │
     │                                          │    output:'用户拒绝了该工具的执行'}    │
     │  on('tool-result',{messageId:"m1",toolCallId:"tc_1",result:{ok:false,           │
     │                   output:"用户拒绝了该工具的执行",error:"rejected-by-user"}})     │
     │<─────────────────────────────────────────│  回填 tool 消息 → 模型换方案 → 继续循环 │
     │                                          │                                    │

```

运行时权限策略拒绝（工具权限不在 `allowedPermissions` 白名单内）——此类失败发生在 `tool-started` **之前**，UI 只会收到 `tool-result`，不会收到 `tool-started`：

```
     │                                          │  查 tool.permissions ∩ allowedPermissions
     │                                          │  ── 命中白名单外权限 fs:write ──>
     │                                          │  不执行,构造 {ok:false,
     │                                          │    error:'permission-denied',
     │                                          │    output:'权限 fs:write 未获运行时策略允许'}
     │  on('tool-result',{messageId:"m1",toolCallId:"tc_2",result:{ok:false,
     │                   output:"权限 fs:write 未获运行时策略允许",error:"permission-denied"}})
     │<─────────────────────────────────────────│  未推送 tool-started
     │                                          │  回填 tool 消息 → 模型换方案 → 继续循环
     │                                          │                                    │
```

审批时用户修改了参数，但修改后的 `arguments` 未通过 JSON Schema 校验 → 工具不执行，按 `invalid-arguments` 处理：

```
     │  invoke('approve-tool',{messageId:"m1",toolCallId:"tc_3",
     │                        arguments:{path:"/tmp/a.txt",encoding:"utf16"}})        │
     │─────────────────────────────────────────>│  重新做 JSON Schema 校验 ── 校验失败
     │                                          │  不执行,构造 {ok:false,
     │                                          │    error:'invalid-arguments',
     │                                          │    output:'参数校验失败: /encoding 不在枚举内'}
     │  on('tool-result',{messageId:"m1",toolCallId:"tc_3",result:{ok:false,
     │                   output:"参数校验失败: ...",error:"invalid-arguments"}})
     │<─────────────────────────────────────────│  回填 tool 消息 → 模型修改参数重试 → 继续循环
     │                                          │                                    │
```

若用户在流式输出中点击停止：

```
     │  invoke('stop',{})                    │                                    │
     │──────────────────────────────────────>│  中断流式/丢弃待执行 tool queue      │
     │  on('loop-done',{messageId:"m1",content:"已输出部分",stopped:true})          │
     │<──────────────────────────────────────│                                    │
```

---

## 6. 错误处理约定

### 6.1 统一错误结构

所有错误（invoke 的 `ok:false` 与 `loop-error` 推送）统一为：

```typescript
interface LoopError {
  code: string;                       // 错误码，见 §6.2（单一事实源：src/shared/error-codes.ts）
  message: string;                    // 人类可读信息（中文/英文依 UI 语言）
  phase: 'receive' | 'llm' | 'tool' | 'approval' | 'session' | 'unknown';  // 出错阶段
  toolCallId?: string;                // 工具相关错误时携带
  details?: Record<string, unknown>;  // 附加信息（如 HTTP 状态码、插件名）
}
```

### 6.2 错误码一览（权威表，与 `src/shared/error-codes.ts`、`renderer/app.js` 由 CI `npm run check:codes` 强制同步）

| 错误码 | 阶段 | 含义 |
|---|---|---|
| `E_INVALID_MESSAGE` | receive | 消息格式非法（role/结构错误） |
| `E_LOOP_BUSY` | receive | 该会话上一轮循环未结束又收到新消息 |
| `E_NO_PENDING_APPROVAL` | approval | 对不存在/已处理的 toolCallId 执行 approve/reject |
| `E_LLM_ERROR` | llm | Provider 调用失败（网络/超时/鉴权等，循环层以 AgentLoopError 结构化抛出） |
| `E_MAX_ITERATIONS` | unknown | 已达最大迭代次数，循环强制终止 |
| `E_INTERNAL` | unknown | 兜底未知错误 |
| `E_PROVIDER_NOT_CONFIGURED` | llm | 尚未配置任何 LLM Provider |
| `E_PROVIDER_UNSUPPORTED` | llm | Provider 不在注册表中（见 §7.3） |
| `E_INVALID_CONFIG` | llm | 配置缺字段或值非法 |
| `E_SESSION_NOT_FOUND` | session | 会话不存在或已被删除（见 §7.1） |
| `E_SESSION_IN_USE` | session | 会话有正在进行的循环，暂不可删除 |
| `E_PATH_NOT_FOUND` | unknown | 指定的目录/文件不存在 |
| `E_PLUGIN_VALIDATION_FAILED` | unknown | manifest/工具/协议版本校验未通过 |
| `E_PLUGIN_LOAD_FAILED` | unknown | 加载入口失败（如 import 抛错） |
| `E_PLUGIN_NOT_FOUND` | unknown | 目标插件不存在 |
| `E_PLUGIN_IN_USE` | unknown | 插件工具正在执行，暂不可卸载 |
| `E_PLUGIN_UNINSTALL_FAILED` | unknown | 卸载过程失败（文件删除出错） |
| `E_PLUGIN_BUILTIN` | unknown | 内置插件不允许卸载 |
| `E_PLUGIN_NOT_IN_REGISTRY` | unknown | 注册表索引中没有该插件 |
| `E_CHECKSUM_MISMATCH` | unknown | 插件包 sha256 与注册表不符，中止安装 |
| `E_REGISTRY_FETCH_FAILED` | unknown | 注册表索引或插件包下载失败 |
| `E_MCP_NOT_FOUND` | unknown | 目标 MCP 服务器不存在（见 §7.2） |

> v0.1 文档曾预留 `E_TOOL_NOT_FOUND` / `E_TOOL_EXECUTION_ERROR` / `E_PERMISSION_DENIED` / `E_STOPPED` / `E_PLUGIN_ALREADY_EXISTS` / `E_INVALID_APPROVAL`：工具层失败统一以 `tool-result`（`ToolResult.error` 预置值）表达而非错误码；停止以 `loop-done(stopped:true)` 表达；同名插件按热更新处理。以上错误码**已废弃**，保留记录防止误用。

> **工具层 `ToolResult.error` 的预置值**（底座在以下 5 种场景固定构造；插件自定义 error 无保留词表，但新增约定值时需同步更新本文档与源码常量）：
>
> - `'tool-not-found'`——工具在全局工具表未命中，工具不执行（不推送 `tool-started`）；
> - `'rejected-by-user'`——用户拒绝审批，工具不执行，固定为 `{ ok:false, output:'用户拒绝了该工具的执行', error:'rejected-by-user' }`（见 §3.3 / §4.4 / §5）；
> - `'permission-denied'`——工具权限被运行时权限策略（`allowedPermissions` 白名单）拒绝，工具不执行（不推送 `tool-started`；策略机制见《插件协议规范》§4.2）；
> - `'invalid-arguments'`——参数未通过 JSON Schema 校验（模型原始参数或审批时用户修改后的参数），工具不执行（校验机制见《插件协议规范》§4.5）；
> - `'tool-crashed'`——插件 execute 抛异常被底座兜底捕获。

### 6.3 `loop-error` 推送结构示例

```json
{
  "messageId": "m1",
  "error": {
    "code": "E_LLM_ERROR",
    "message": "DeepSeek API 调用失败: upstream timeout",
    "phase": "llm",
    "details": { "statusCode": 504, "provider": "deepseek" }
  }
}
```

### 6.4 处理约定

- **主进程**：handler 永不主动 `throw`；捕获一切异常并转成 `{ ok:false, error }`。循环级致命错误以 `loop-error` 推送并结束本轮循环。
- **渲染进程**：`invoke` 成功但 `ok:false` 时，读 `error.code` 决定 UI 文案与重试策略；不可恢复错误给出提示条即可，不要透传原始堆栈给用户。
- 新增错误码：必须同步更新两张文档（本文 + 插件文档）与 `src` 常量，禁止在 UI 层硬编码新码的文案而不回写定义。

---

## 7. v0.2 / v0.3 协议增补（多会话 · Provider 注册表 · MCP · 插件设置）

> 本节是 v0.1 之后新增通道与 payload 变更的权威定义。协议版本常量：preload 暴露
> `window.agentBase.protocolVersion`（当前 `2`），UI 启动时应校验。
> 通道命名与 §3/§4 保持一致：UI→主进程走 invoke，主进程→UI 走推送。

### 7.0 v0.2 起的 payload 变更（既有通道）

| 通道 | 变更 |
|---|---|
| `send-message` 请求 | 增加可选 `sessionId`；缺省写入当前活跃会话。返回值不变 |
| `message-chunk` / `tool-started` / `tool-result` / `approval-required` / `loop-done` / `loop-error` 推送 | 全部增加 `sessionId` 字段（UI 据此把事件归并到会话视图） |
| `loop-error` 的 `error.code` | 由循环层结构化抛出（`E_LLM_ERROR` / `E_MAX_ITERATIONS` / `E_INTERNAL`），废除字符串推断 |

### 7.1 会话通道（invoke，v0.2）

| 通道名 | 请求 payload | 返回 data |
|---|---|---|
| `list-sessions` | — | `{ sessions: SessionMeta[] }` |
| `create-session` | `{ title?: string }` | `{ session: Session }` |
| `switch-session` | `{ id: string }` | `{ session: Session }`（含完整 `messages`，UI 据此重建聊天区） |
| `rename-session` | `{ id: string; title: string }` | `null` |
| `delete-session` | `{ id: string }` | `null`（进行中 → `E_SESSION_IN_USE`；最后一个会话删除后自动新建） |

```typescript
interface SessionMeta { id: string; title: string; createdAt: number; updatedAt: number; messageCount: number; }
interface Session extends SessionMeta { messages: ChatMessage[]; }
```

推送：`sessions-changed` → `{ sessions: SessionMeta[] }`（新建/改名/自动起标题后触发，UI 全量刷新列表）。
会话持久化于 `<appDir>/sessions/<id>.json`，首轮对话结束自动起标题（≤12 字，可改名）。

### 7.2 MCP 通道（invoke，v0.3）

| 通道名 | 请求 payload | 返回 data |
|---|---|---|
| `list-mcp-servers` | — | `{ servers: McpServerStatus[]; config: Record<string, McpServerConfig> }` |
| `set-mcp-config` | `{ config: Record<string, McpServerConfig> }` | `null`（全量替换 mcp.json 并同步连接） |
| `toggle-mcp-server` | `{ name: string; enabled: boolean }` | `null`（不存在 → `E_MCP_NOT_FOUND`） |

```typescript
interface McpServerConfig {
  command?: string; args?: string[]; env?: Record<string, string>;  // stdio 传输
  url?: string;                                                     // Streamable HTTP 传输（与 command 二选一）
  approval?: 'auto' | 'always' | 'never';   // auto（默认）= 按 annotations.readOnlyHint 免审批，其余需审批
  enabled?: boolean;                        // 默认 true
  tools?: Record<string, { requiresApproval?: boolean; permissions?: string[] }>;  // 按工具覆盖
}
interface McpServerStatus { name: string; state: 'connected'|'connecting'|'disconnected'|'error'|'disabled'; transport: 'stdio'|'http'; toolCount: number; error?: string; }
```

推送：`mcp-status-changed` → `{ servers: McpServerStatus[] }`。
桥接规则：每个 MCP 工具注册为 `mcp.<server>.<工具名>`；断线自动指数退避重连；server 崩溃 → 工具错误回喂模型（自愈），不中断循环。配置文件 `<appDir>/mcp.json` 与 Claude Desktop 的 `mcpServers` 格式兼容。

### 7.3 Provider 注册表（invoke，v0.2）

| 通道名 | 请求 payload | 返回 data |
|---|---|---|
| `list-providers` | — | `{ providers: ProviderMeta[] }` |
| `set-model-config` | `{ config: { provider; apiKey?; model?; baseUrl?; maxTokens? } }` | `null`（校验放宽为「provider 必须在注册表中」） |

```typescript
interface ProviderMeta { id: string; label: string; requiresBaseUrl: boolean; defaultBaseUrl?: string; defaultModel?: string; }
```

内置 id：`openai-compatible`（通用，需 baseUrl，Ollama/LM Studio/智谱/通义/月之暗面等即插）、`deepseek`、`openai`、`anthropic`。`maxTokens` 仅 Anthropic 消费（Messages API `max_tokens`）。

### 7.4 插件设置与 registry 安装（invoke，v0.3 / 富插件协议 v2）

| 通道名 | 请求 payload | 返回 data |
|---|---|---|
| `install-plugin-from-registry` | `{ name: string; registryUrl?: string }` | `{ plugin: PluginInfo }`（下载 zip → sha256 校验 → 标准安装） |
| `get-plugin-settings` | `{ name: string }` | `{ schema: object \| null; values: object \| null }`（schema 来自 manifest.settings） |
| `set-plugin-settings` | `{ name: string; values: object }` | `null`（落盘 `<appDir>/plugins/settings/<name>.json`，下次工具执行注入 `ctx.settings`） |
---

## 8. v0.4 协议增补（策略 / 附件 / 终端 / 子代理）

### 8.1 策略通道（invoke）

| 通道名 | 请求 payload | 返回 data |
|---|---|---|
| `set-agent-policy` | `{ permissionMode?, maxIterations?, reasoningEffort? }` | `null`（立即生效并持久化 config.json） |
| `get-app-info` | — | `{ info: AppInfo }` |
| `read-audit` | `{ lines? }`（默认 200，上限 1000） | `{ lines: string[]; total: number }` |
| `preview-file` | `{ path }`（绝对或相对工作目录） | `{ exists: boolean; content: string }`（写文件审批 diff 用） |

```typescript
type PermissionMode = 'ask-before-change' | 'auto-edit' | 'plan' | 'full';
interface AppInfo {
  version: string; appDir: string;
  provider: string | null; model: string | null; models: string[]; baseUrl: string | null;
  permissionMode: PermissionMode; maxIterations: number;
  reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  sessionCount: number; pluginCount: number; mcpCount: number;
}
```

**权限模式 → 底座策略映射**：`ask-before-change` = 强制审批 `[fs:write, shell:exec]`；`auto-edit` = `[shell:exec]`；`plan` = 运行时白名单 `[fs:read]`（写/执行/联网被拒）；`full` = 不限制（插件自声明的审批仍生效）。
**推理力度透传**：OpenAI 兼容端点需在 config.json 显式 `"enableReasoningEffort": true` 才发送 `reasoning_effort`（严格网关兼容）；Anthropic 恒透传 `thinking` 预算（low=2k/medium=8k/high=16k）。

### 8.2 send-message 变更（v0.4）

- 请求增加 `contextFiles?: string[]`（@ 引用的相对路径）：底座读取文件内容（≤5 个 × 2 万字符）注入消息尾部【引用上下文】块
- `message.content` 支持 `ContentPart[]`（多模态：`{type:'text',text}` / `{type:'image',mediaType,data(base64)}`）
- 会话忙时不再返回 `E_LOOP_BUSY`，自动排队并返回 `{ messageId, queued: true }`；循环结束按序续发（stop 清空队列）
- 全部推送事件带 `sessionId`；中止/报错时当轮用户消息也会落盘

### 8.3 附件与文件（invoke）

| 通道名 | 请求 payload | 返回 data |
|---|---|---|
| `pick-files` | — | `{ paths: string[] }`（原生多选对话框） |
| `read-attachment` | `{ path }` | `{ name, kind: 'image'\|'text', mediaType, data?, text? }`（图片 ≤5MB base64；文本 ≤400KB） |
| `list-workspace-files` | `{ query? }` | `{ files: [{ name, rel, isDir }] }`（浅层遍历工作目录，≤50 条，跳过依赖/构建目录） |

### 8.4 内置终端（单向 + 推送）

| 通道 | 方向 | payload |
|---|---|---|
| `term-input` | UI → 主（send） | `{ command }`（空命令 = 拉起持久 shell） |
| `term-stop` | UI → 主（send） | — |
| `term-data` | 主 → UI（push） | `{ text }`（stdout/stderr 追加流） |

实现为持久 shell 会话（Windows cmd / POSIX $SHELL），非 PTY：交互式全屏程序不支持。

### 8.5 子代理（工具面，无新通道）

`subagent.run` 工具由底座注册（`core-subagent`，`core-` 前缀不可卸载）：子任务在隔离 runLoop 中执行
（禁止嵌套派生、共享审批管线与权限策略、工具事件以父 messageId 内联推送），最终答复作为 ToolResult 回喂外层模型。

### 8.6 消息持久化语义（v0.4）

- 会话文件 `<appDir>/sessions/<id>.json` 全量保存（含多模态分片）
- 上下文压缩/裁剪只影响发给模型的内容；中止或报错时当轮用户消息仍会落盘
