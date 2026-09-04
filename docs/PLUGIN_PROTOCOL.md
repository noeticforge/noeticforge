# 插件协议规范（Plugin Protocol）

> 适用范围：本仓库（Electron + TypeScript 桌面端 AI Agent）的插件开发者与主进程维护者。
> 本文描述插件与 Agent 底座之间的全部契约。所有 `interface` / 字段名与 `src` 源码保持一致，**不得自行增删字段**。

---

## 1. 概述与设计理念

### 1.1 一切皆插件

Agent 底座本身**不内置任何具体工具**（不内置 read-file、不内置 web-search……）。
所有能力都以「插件」的形式提供，每个插件通过 `manifest.json` 声明自身，并通过 **index.ts 入口**导出工具列表。

### 1.2 底座不认识任何具体工具

Agent 循环引擎（Agent Loop）对工具只有一套抽象认知：

- 工具长什么样 → 看 `ToolDefinition` / `AgentTool` 的 `name`、`description`、`parameters`；
- 工具怎么跑 → 调 `execute(args, ctx)`，拿到 `ToolResult`；
- 工具结果怎么回喂 LLM → 写入 role 为 `'tool'` 的 `ChatMessage`，并通过 `toolCallId` 与 assistant 消息里的 `tool_calls` 一一对应。

底座**不关心**插件内部实现语言细节（用 node:fs、还是 fetch、还是子进程），只认接口。这保证了：

- 新增能力 = 新增插件，不改底座；
- 卸载插件 = 能力消失，底座无残留逻辑；
- 插件之间的工具互不可见，只能各自暴露给 LLM。

> 以上"不关心"建立在**信任假设**之上：底座会把插件代码直接 `import()` 进主进程执行，当前**不审查源码、不提供沙箱**，插件可调用任何原生 API（见 §4.6）。

### 1.3 两句话契约

- **插件给底座什么**：一个 `Plugin` 对象 = `manifest`（声明身份/权限/入口）+ `tools`（AgentTool 数组）。
- **底座给插件什么**：仅一个执行上下文 `ToolContext`（本次会话信息），以及一个高度可预期的「权限 → 执行 → 回填」管线。

---

## 2. 插件目录结构与 manifest.json

### 2.1 目录结构

一个插件 = 一个文件夹，对外**唯一标识是 `manifest.name`**。

```
read-file/                  ← 插件文件夹（名称建议与 name 一致，非强制）
├── manifest.json           ← 清单（必填）
├── src/
│   └── index.ts            ← 源码（必填，TypeScript）
├── dist/                   ← 构建产物（入口指向这里，见下）
│   └── index.js
└── assets/…                ← 可选资源
```

> 注意：`manifest.entry` 指向**入口 JS 文件**（不是 TS）。项目约定插件发布形态为编译后的 `dist/index.js`。

### 2.2 manifest.json 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | ✅ | 插件唯一 ID。必须为 **kebab-case**（`^[a-z0-9]+(-[a-z0-9]+)*$`），全库唯一，用于卸载/识别。 |
| `version` | `string` | ✅ | 语义化版本，遵循 **semver**（`x.y.z`）。热更新升级时据此判断新旧。 |
| `displayName` | `string` | ✅ | 人类可读名称，展示在 UI 插件列表。 |
| `description` | `string` | ✅ | 一句话说明插件干什么。 |
| `author` | `string` | ❌ | 作者名，无格式约束。 |
| `permissions` | `Permission[]` | ✅ | 插件声明需要的权限集合。枚举见 §4.1。底座在加载时校验工具权限是该集合的子集（见 §4.2）；但底座**不审查插件源码、不提供沙箱**，插件在 `execute()` 内部仍可直接调用 `node:fs` 等原生 API——声明之外的调用不会在执行时被拦截（见 §4.6）。 |
| `entry` | `string` | ✅ | 入口 JS 文件的**相对路径**（相对插件文件夹根），如 `"./dist/index.js"`。保持静态路径即可，底座加载时会在动态 `import()` 的 URL 后追加 `?t=<时间戳毫秒>` 查询参数以绕过 ESM 模块缓存（见 §5.1 / §5.5）。 |

字段完整实现（与源码一致）：

```typescript
interface PluginManifest {
  name: string;              // 唯一 ID，kebab-case
  version: string;           // semver
  displayName: string;
  description: string;
  author?: string;
  permissions: Permission[]; // 'fs:read' | 'fs:write' | 'shell:exec' | 'net:http'
  entry: string;             // 入口 js 文件相对路径
}
```

### 2.3 完整示例 manifest.json

```json
{
  "name": "read-file",
  "version": "1.0.0",
  "displayName": "File Reader",
  "description": "读取本地文本文件内容，供模型分析代码与配置",
  "author": "agent-team",
  "permissions": ["fs:read"],
  "entry": "./dist/index.js"
}
```

---

## 3. AgentTool 接口详解

### 3.1 接口定义（与源码一致）

```typescript
interface AgentTool {
  name: string;              // 全局唯一，建议 "插件名.工具名"
  description: string;       // 给 LLM 看的用途说明
  parameters: JSONSchema;    // OpenAI 风格 JSON Schema
  permissions: Permission[];
  requiresApproval?: boolean; // 若为 true，执行前必须先经过用户批准（审批钩子，默认 false）
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  ok: boolean;
  output: string;            // 喂回 LLM 的文本
  error?: string;
}
```

### 3.2 字段逐一说明

| 字段 | 说明 |
|---|---|
| `name` | 全局唯一。遵循 `插件名.工具名` 命名（如 `read-file.read`、`web.http-get`）。LLM 在 tool_calls 里填的就是这个名字。名字一经发布即成为对外 API，谨慎变更。 |
| `description` | 给 LLM 看的功能描述。写清楚：干什么、何时用、典型输入。**改好描述比改代码更能提升模型调用准确率**。 |
| `parameters` | OpenAI 风格 JSON Schema，只接受 `type: "object"` 包裹、以 `properties` + `required` 描述参数。模型按此生成 `arguments`。 |
| `permissions` | 本工具实际用到的权限，必须**是该插件 manifest.permissions 的子集**，否则插件校验失败。 |
| `requiresApproval` | 可选，默认 `false`。为 `true` 时该工具**执行前必须先经过用户批准**（审批钩子，机制见 §4.3）；缺省则直接执行，除非工具权限命中底座的 `forceApprovalPermissions` 强制审批列表。 |
| `execute(args, ctx)` | 真正的执行函数。约定见 §3.5。 |

### 3.3 ToolContext（执行上下文）

`ToolContext` 由底座在每次执行前注入，当前仅承载**进程运行元数据**，用于日志与追踪：

```typescript
interface ToolContext {
  pluginName: string;   // 当前插件唯一 ID（= manifest.name）
  workingDir: string;   // 本次执行的工作目录（默认 process.cwd()，Electron 下为 app 根目录）
}
```

`ToolContext` 目前**不提供**任何与权限绑定的受控执行 API（如带权限校验的文件句柄）——插件在 `execute()` 内部对 `node:fs` 等原生 API 的调用不受底座拦截。此类受控执行能力将随沙箱阶段一起提供（见 §4.6）。

### 3.4 ToolResult 字段说明

| 字段 | 说明 |
|---|---|
| `ok` | 执行是否成功。 |
| `output` | 喂回 LLM 的纯文本结果。成功时是工具输出；失败时可为 `""` 或一句说明。**不要往 output 里塞二进制，过大的输出会被截断后回填**。 |
| `error` | 错误描述，仅失败时填写。会被追加进回填的 tool 消息，模型可据此修复参数再次调用。底座构造的失败以预置错误码表达（见下表）。 |

`error` 的 **5 个预置值**（由底座构造；插件也可返回自定义 error 字符串，但新增约定值需同步更新本文档与源码常量）：

| 预置值 | 触发场景 |
|---|---|
| `'tool-not-found'` | 工具名在全局工具表未命中（不执行、不推送 tool-started） |
| `'rejected-by-user'` | 用户拒绝了审批（工具不执行） |
| `'permission-denied'` | 工具权限被运行时权限策略（allowedPermissions 白名单）拒绝（工具不执行、不推送 tool-started） |
| `'invalid-arguments'` | 参数未通过 JSON Schema 校验（模型生成或审批时用户修改后的参数都不例外） |
| `'tool-crashed'` | 插件 execute 抛异常被底座兜底捕获 |

> `ToolResult` **不包含任何审批字段**。工具是否需要审批完全由 `AgentTool.requiresApproval` 声明、或其权限是否命中底座的 `forceApprovalPermissions` 强制审批列表决定（见 §4.3），工具自身不感知审批流程。

### 3.5 execute 实现约定（重要）

1. **必须 resolve 一个 `ToolResult`，不要 reject**。任何内部异常请 `try/catch` 后转为 `{ ok: false, error: message }`，让错误信息可以回喂给模型，模型有自愈机会。若仍抛出，底座会兜底捕获并转为 `{ ok: false, output: '工具执行异常: <原因>', error: 'tool-crashed' }`，异常信息得以保留并回喂模型。
2. `output` 是给模型看的，不是给 UI 的。需要人类可读的信息直接写在 output 里即可，UI 会原样展示给用户。
3. 是否需要审批由 `AgentTool.requiresApproval` 声明，**并可能因工具权限命中底座的 `forceApprovalPermissions` 强制审批列表而被强制进入审批**（见 §4.3），工具内部**不做**任何审批相关逻辑——`execute` 一旦被调用，就是真正要执行的真实操作。不要自行实现双阶段 / 预检-确认逻辑。

### 3.6 完整可运行示例插件：read-file

#### 目录

```
read-file/
├── manifest.json          ← 见 §2.3
├── src/index.ts           ← 见下
└── dist/index.js          ← tsc 编译产物（entry 指向它）
```

#### 入口源码 `src/index.ts`

```typescript
// read-file/src/index.ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin, AgentTool, ToolResult } from '../../../src/types/plugin.ts';

const manifest = {
  name: 'read-file',
  version: '1.0.0',
  displayName: 'File Reader',
  description: '读取本地文本文件内容',
  permissions: ['fs:read'] as const,
  entry: './dist/index.js',
};

const readTool: AgentTool = {
  name: 'read-file.read',
  description:
    '读取一个文本文件的完整内容并返回给模型。适合读取源码、配置文件。' +
    '参数 path 必须是绝对路径。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要读取的文件绝对路径',
      },
      encoding: {
        type: 'string',
        enum: ['utf-8', 'utf8', 'base64'],
        description: '文件编码，默认 utf-8',
      },
    },
    required: ['path'],
    additionalProperties: false,
  } as const,
  permissions: ['fs:read'],
  async execute(args) {
    const path = resolve(String(args.path));
    const encoding = (args.encoding as string) ?? 'utf-8';
    try {
      const content = await readFile(path, { encoding: encoding as BufferEncoding });
      // output 直接喂回 LLM，截断到合理长度防溢出
      const trimmed = content.length > 8000 ? content.slice(0, 8000) + '\n... [已截断]' : content;
      return { ok: true, output: trimmed };
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: `read failed: ${(err as Error).message}`,
      };
    }
  },
};

const plugin: Plugin = { manifest, tools: [readTool] };

export default plugin;
```

#### 构建与调试

```bash
# 在插件目录或项目根按 tsconfig 编译
npx tsc -p read-file/tsconfig.json     # 产物输出到 read-file/dist/
# 本地起一个临时目录放编译产物，用 IPC install-plugin 安装验证
```

> `export default plugin` 是**硬约定**：主进程加载插件时只看默认导出。命名导出请勿使用。

---

## 4. 权限系统说明

### 4.1 权限枚举

`Permission` 类型只有 4 个合法值：

| 取值 | 含义 | 风险 |
|---|---|---|
| `'fs:read'` | 读写能力之外：只读本地文件系统 | 低 |
| `'fs:write'` | 创建 / 修改 / 删除本地文件 | **高** |
| `'shell:exec'` | 执行任意子进程命令 | **高** |
| `'net:http'` | 发起任意 HTTP/HTTPS 出站请求 | 中 |

**双层声明**：插件在 `manifest.permissions` 声明插件级权限；每个 `AgentTool` 在自己的 `permissions` 再次声明工具级权限。校验规则：`tool.permissions ⊆ manifest.permissions`，越界即插件加载失败。

### 4.2 权限校验链路

权限体系分**两层**，均属于「声明层 / 策略层」校验，**不构成进程隔离沙箱**：

```
声明层（加载时）:  校验 manifest.permissions ⊇ 每个 tool.permissions
策略层（执行时）:  每个工具调用执行前，校验 tool.permissions ⊆ LoopOptions.allowedPermissions
```

- **加载校验（声明层）**：任何工具要求 manifest 未声明的权限 → 整个插件校验失败，不予注册，返回具体错误字段（见 §5.2 第 5 条）。此层只做声明比对，不审查插件源码。
- **运行时权限策略（策略层）**：`LoopOptions` 新增可选字段 `allowedPermissions?: Permission[]`，作为运行时权限白名单。循环在**每个工具调用执行前**检查：工具 `permissions` 中若有任何一项不在白名单内 → 不执行，构造 `{ ok: false, output: '权限 xx 未获运行时策略允许', error: 'permission-denied' }` 回喂给模型并推送 `tool-result` 事件，循环继续（不崩）。该校验发生在 `tool-started` 事件**之前**——校验失败时 UI 不会收到 `tool-started`。**未配置 `allowedPermissions` 时默认全部放行**。
- **范围说明**：以上两层都无法拦截插件在 `execute()` 内部直接调用 `node:fs` 等原生 API——真正的进程隔离沙箱在 Roadmap 后续阶段（见 §4.6）。

### 4.3 审批钩子（AgentTool.requiresApproval）

审批机制解决「模型想干、但人类必须点头」的场景。**审批声明在 AgentTool 上，不在 ToolResult 上**：给工具加一个可选字段 `requiresApproval?: boolean`（默认 `false`），声明为 `true` 表示「该工具执行前必须先经过用户批准」。

**强制审批（`forceApprovalPermissions`）**：`LoopOptions` 新增可选字段 `forceApprovalPermissions?: Permission[]`，允许底座强制「某类权限必须审批」。审批触发条件为 `tool.requiresApproval === true` **或** `tool.permissions` 命中 `forceApprovalPermissions`——即使插件自己声明了 `requiresApproval: false`，只要工具请求的权限命中该列表，仍会被强制进入审批流程（底座配置覆盖插件声明）。

完整流程（事件名见《IPC 事件协议规范》）：

1. 模型发起该工具的 tool_call（携带 id / name / arguments）——该调用在此之前已通过运行时权限策略（§4.2）；
2. 底座推送 `tool-started` 事件——宣告模型想调用此工具，**此刻尚未执行**；
3. 检查是否需要审批：`tool.requiresApproval === true`，**或** `tool.permissions` 命中底座配置的 `forceApprovalPermissions`：
   - 命中 → 推送 `approval-required` 事件，该 tool call **挂起**，Agent 循环暂停输出，等待 UI 决定；
   - 未命中 → 直接进入第 6 步；
4. 用户决定（对应下述 `requestApproval` 回调可返回的三种结果）：
   - `'approved'`（字符串）→ 批准，进入第 5 步；
   - `'rejected'`（字符串，或 `{ decision: 'rejected', reason? }`）→ **工具不执行**，底座直接构造 `{ ok: false, output: '用户拒绝了该工具的执行', error: 'rejected-by-user' }` 回喂模型，并照常推送 `tool-result`，Agent 循环继续；
   - `{ decision: 'approved', arguments }` → 批准，且用户在 UI 里**修改过参数**，`arguments` 将**替换**原模型生成的调用参数后进入第 5 步；
5. 参数 Schema 校验（§4.5）：无论参数是模型原始生成还是审批时被用户修改过，均按 `tool.parameters` 用 ajv 校验；**校验失败 → 工具不执行**，构造 `{ ok: false, output: '参数校验失败: <具体错误>', error: 'invalid-arguments' }` 回喂模型并推送 `tool-result`，循环继续；
6. 执行 `tool.execute(args, ctx)`，得到 `ToolResult` 回填模型，推送 `tool-result`。

声明方式示例：

```typescript
const writeTool: AgentTool = {
  name: 'fs-writer.write-file',
  description: '向本地磁盘写入文件',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  permissions: ['fs:write'],
  requiresApproval: true,               // ← 审批钩子：先批准、后执行
  async execute(args) {
    // 走到这里 = 用户已批准，正常执行真实写入
    await writeFile(String(args.path), String(args.content ?? ''));
    return { ok: true, output: `written: ${args.path}` };
  },
};
```

推荐策略（底座主进程可配置，插件无需感知）：`'fs:write'` 与 `'shell:exec'` 的官方示例插件默认声明 `requiresApproval: true`；`'fs:read'`、`'net:http'` 默认放行。

### 4.4 最小权限原则

- 只申请够用的权限：能 `fs:read` 完成就别声明 `fs:write`；
- 插件越少声明、工具越少声明，模型可用能力面越小，误操作面越小；
- 底座校验「权限声明 ⊆ 算法要求」，也请保持「代码实际行为 ⊆ 权限声明」的对称纪律，避免用高权限接口悄悄越权。

### 4.5 参数 Schema 校验（执行的前置关卡）

在审批之后、真正执行之前，循环会用 **ajv** 按 `tool.parameters`（OpenAI 风格 JSON Schema）对 `call.arguments` 做校验——**模型生成的原始参数、以及审批时用户修改后的参数，都必须通过**。校验失败 → 不执行，构造 `{ ok: false, output: '参数校验失败: <具体错误>', error: 'invalid-arguments' }` 回喂给模型并推送 `tool-result` 事件，循环继续（不崩）。`parameters` 为空 / 未提供时不约束（放行）。

> 每个工具调用执行前的关卡顺序：**运行时权限策略（§4.2）→ `tool-started` 事件 → 审批（§4.3）→ 参数 Schema 校验（本节）→ `execute()`**。

### 4.6 当前信任模型与沙箱路线

当前权限体系是**声明式信任模型**（declarative trust + consent）：

- 底座在**加载时**校验 `tool.permissions ⊆ manifest.permissions`，在**执行时**校验 `tool.permissions ⊆ allowedPermissions` 白名单（§4.2），需要人类点头的场景再叠加审批（consent）；
- **但底座不审查插件源码、不提供沙箱**。插件代码直接在主进程内以 `import()` 加载执行；插件在 `execute()` 内部理论上可以**直接调用 `node:fs` 等原生 API**，底座无法拦截其未声明的原生调用。声明式校验约束的是「声明与行为匹配」的纪律，而非强制隔离（这与 §3.3 中 ToolContext 不提供受控执行 API 一致）；
- 因此当前信任假设是：**插件本身可信**（来自官方 / 受控来源）。声明式协议 + 审批兜住的是「模型想用、但人类没点头」的风险，兜不住「恶意插件自身越权」的风险。

**未来沙箱路线（Roadmap 后续阶段）**：真正的进程隔离沙箱将包括——**进程隔离**（插件跑在独立子进程，经 IPC 通信）、**MCP 独立进程工具**，以及随沙箱提供的**与权限绑定的受控执行 API**（如带权限校验的文件句柄）。届时 `ToolContext`（§3.3）才具备受控执行能力。当前版本对以上能力**不承诺**。

---

## 5. 生命周期

插件全生命周期：**加载 → 校验 → 注册 → 执行 → 卸载**。

### 5.1 加载（load）

- 底座扫描插件目录（或收到 `install-plugin` 请求），读取当前插件的 `manifest.json`；
- 解析 `entry` 相对路径，用 Node.js 动态 `import()`（`pathToFileURL` 处理，保证 Windows 路径正确）加载入口模块；加载时底座**有义务**在入口 URL 后追加 `?t=<时间戳毫秒>` 查询参数（如 `plugins/foo/index.js?t=1756300000000`）以穿透 ESM 模块缓存——`manifest.entry` 始终是静态相对路径，版本参数由底座追加（见 §5.5）；
- 取该模块的 **default export**，即为 `Plugin` 对象。

### 5.2 校验（validate）

逐项检查，全部通过才进入注册，任一失败即终止加载并上报 `loop-error` / 安装失败：

1. `manifest` 字段完整性（见 §2.2 必填项）；
2. `name` 为合法 kebab-case，且与已注册插件不冲突；
3. `version` 符合 semver；
4. `entry` 指向的文件存在且导出了 `Plugin`（默认导出）；
5. 每个 `AgentTool`：`name` 全局唯一（不能与已注册的其他工具撞名）、`parameters` 是合法 JSON Schema（顶层 `type: 'object'`）、`permissions ⊆ manifest.permissions`。

### 5.3 注册（register）

- 插件进入注册表，工具汇总进底座「全局工具表」；
- 底座把工具的 `name / description / parameters` 编译为传给 LLM 的 functions 列表（`ToolDefinition`）；
- 通知 UI：推送 `plugins-changed`（IPC 事件见另一文档）。

### 5.4 执行（execute）

模型在消息里下发 `tool_calls`（`ToolCall[]`，含 `id`/`name`/`arguments`）：

1. Agent 循环按 `name` 在全局工具表查找 `AgentTool`；未命中 → **不执行**，构造 `{ ok:false, output:'错误：工具 "xx" 不存在', error:'tool-not-found' }` 回填并推送 `tool-result`（不会推送 `tool-started`）；
2. 运行时权限策略（§4.2）：`tool.permissions` 有任何一项不在 `allowedPermissions` 白名单 → **不执行**，构造 `{ ok:false, ..., error:'permission-denied' }` 回填并推送 `tool-result`（发生在 `tool-started` **之前**，UI 收不到 `tool-started`）；
3. 推送 `tool-started` 给 UI（宣告调用，尚未执行）；
4. 审批判定（§4.3）：`tool.requiresApproval === true` 或 `tool.permissions` 命中 `forceApprovalPermissions` → 推送 `approval-required` 并挂起，等待用户 `approve-tool`（批准后继续；如携带修改后的 `arguments` 则替换原参数）或 `reject-tool`（不执行，构造 `{ ok:false, output:'用户拒绝了该工具的执行', error:'rejected-by-user' }` 回填）；
5. 参数 Schema 校验（§4.5）：按 `tool.parameters` 校验 `arguments`（含用户修改过的参数），失败 → **不执行**，构造 `{ ok:false, output:'参数校验失败: <具体错误>', error:'invalid-arguments' }` 回填并推送 `tool-result`；
6. 调用 `tool.execute(args, ctx)` 得到 `ToolResult`，作为 `'tool'` 消息（带 `toolCallId`）回填，循环继续；若插件抛异常，底座兜底转为 `{ ok:false, ..., error:'tool-crashed' }`；
7. 无论成功失败都推送 `tool-result` 给 UI，失败信息一并回喂模型。

### 5.5 卸载与热更新（uninstall / hot reload）

- **卸载**：registered 表删除该插件，全局工具表删除其全部工具，推送 `plugins-changed`。若该插件工具正在执行，底座等待当前 execute 结束后再卸载。
- **热更新**：项目已有 `install-plugin` 级别的热更新实现——同名插件先**注销（unregister）旧版**，再**加载（load）+ 注册（register）**新版（见《IPC 事件协议规范》§3.6）。因 Node.js `import()` 存在 ESM 模块缓存，底座在动态 `import()` 时**有义务**在入口 URL 后追加 `?t=<时间戳毫秒>` 查询参数（如 `plugins/foo/index.js?t=1756300000000`）以穿透缓存；因此 **unregister → load 后得到的必然是全新的模块实例**——插件文件顶层的副作用（模块级初始化、全局状态、定时器等）会重新执行一遍。
- 更新前后版本约定：`plugins-changed` 按 `name` 对齐，UI 根据 version 判断升级。

### 5.6 生命周期流程

```
                        ┌──────────────┐
        install-plugin  │    loading   │ 读取 manifest.json + 定位 entry
      ─────────────────>│              │ 动态 import(<entry>?t=<时间戳>) 穿透 ESM 缓存
                        └──────┬───────┘
                               │ 校验失败 → 上报错误,插件不生效
                               v
                        ┌──────────────┐
                        │   validate   │ 字段/命名/schema/权限声明⊆/重名
                        └──────┬───────┘
                               v
                        ┌──────────────┐   tools 并入全局工具表
                        │   register   │ ──────────> LLM functions 列表
                        └──────┬───────┘
                               │           推送 plugins-changed
                               v
        tool_calls ──> 查找 AgentTool
                              │ 未命中 ──> {ok:false, error:'tool-not-found'} ──> 推送 tool-result ──> 继续循环
                              v 命中
                    运行时权限策略（§4.2，tool-started 之前）
                              │ 有权限不在 allowedPermissions 白名单
                              ├──────────────> {ok:false, error:'permission-denied'} ──> 推送 tool-result ──> 继续循环
                              v 全部放行 / 未配置白名单
                        推送 tool-started
                              │
                    需审批?（requiresApproval 或命中 forceApprovalPermissions）
                     │否                        │是
                     v                          v
              ┌─────────────┐         approval-required ──> UI 弹窗
              │             │                                 │
              │             │         ┌───────────────────────┤
              │             │         │批准（可携带修改后      │拒绝
              │             │         │ arguments,替换原参数）  │
              │             │         v                       │
              │             │   ┌─────┴──────────────┐        │
              │             │   │（与"否"路径合并）    │        v
              │             │   │                    │  {ok:false, error:'rejected-by-user'}
              │             │   └────────┬───────────┘  ──> 推送 tool-result ──> 继续循环
              │             │            v
              └─────────────┼────────────┘
                            v
                 参数 Schema 校验（ajv，§4.5；模型原始参数与用户修改参数都过）
                            │ 失败
                            ├──────────────> {ok:false, error:'invalid-arguments'} ──> 推送 tool-result ──> 继续循环
                            v 通过
                    execute(args, ctx)
                            │
            抛异常 ──> {ok:false, error:'tool-crashed'}
             正常 ToolResult
                            │
                            └────────────> 回填 tool 消息 ──> 推送 tool-result ──> 继续循环

        uninstall-plugin ──> 清理注册表 ──> 推送 plugins-changed
```

---

## 6. 开发者快速上手：5 步创建新插件

**第 1 步：建目录 + 写 manifest.json**

```bash
mkdir my-awesome && cd my-awesome
# 写 manifest.json（字段见 §2.2），permissions 只填真正需要的
```

**第 2 步：写入口 `src/index.ts`，默认导出 Plugin**

```typescript
import type { Plugin } from '<项目类型文件>';
export default { manifest, tools } satisfies Plugin;
```

**第 3 步：实现 AgentTool**

```typescript
const myTool: AgentTool = {
  name: 'my-awesome.do-stuff',
  description: '……给 LLM 看的用途说明……',
  parameters: { type: 'object', properties: { ... }, required: [...] },
  permissions: ['fs:read'],
  async execute(args) { /* try/catch，总是返回 ToolResult */ },
};
```

**第 4 步：编译产物**

```bash
# tsconfig 输出到 dist/，然后确认 manifest.entry 指向 ./dist/index.js
```

**第 5 步：安装并验证**

```bash
# 通过 UI「插件管理」或 IPC install-plugin 安装该目录
# 预期：收到 plugins-changed、插件出现在 UI 列表；
# 然后在对话框里让模型调用 my-awesome.do-stuff，观察 tool-started / tool-result。
```

完成。新增能力只需要重复以上 5 步，零改动底座代码。

---

## 附：本文档引用的核心类型（与源码一致，勿改）

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

interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

interface AgentTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  permissions: Permission[];
  requiresApproval?: boolean;   // 审批钩子：true 时执行前须用户批准
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

interface Plugin {
  manifest: PluginManifest;
  tools: AgentTool[];
}
```
---

## 7. 富插件协议 v2 增补（v0.3 起实现）

> v1 协议（工具 + 权限 + 审批）全部保持不变；以下是可选的新增能力，全部向后兼容。
> 插件在 manifest 中声明 `protocolVersion`；底座支持版本见 `src/plugins/loader.ts` 的
> `SUPPORTED_PLUGIN_PROTOCOL_VERSION`，声明了更高版本的插件会被拒绝加载（报 `E_PLUGIN_VALIDATION_FAILED`）。

### 7.1 manifest 新增字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocolVersion` | `number` | ❌ | 插件协议版本，当前 `1`；缺省视为 1。必须是正整数，高于底座支持版本 → 加载失败 |
| `settings` | `object` | ❌ | 插件设置页的 JSON Schema（OpenAI 风格）。UI 据此生成设置表单；用户保存的值在每次 `execute` 时注入 `ctx.settings` |

### 7.2 生命周期钩子

插件导出对象可增选实现两个异步钩子（与 `tools` 并列）：

- `onInstall?: () => Promise<void>`——安装（含热更新）注册成功后回调；抛错不影响安装主流程；
- `onUninstall?: () => Promise<void>`——注销前回调；抛错不影响卸载主流程。

用途：初始化资源、清理定时器/临时文件。**禁止**在钩子里做审批绕过或权限提升类操作。

### 7.3 ToolResult.render 渲染提示

`ToolResult` 增加可选字段 `render?: string`，合法值：`'markdown' | 'code' | 'diff' | 'table'`。

- 仅影响 **UI 展示方式**，不影响喂给 LLM 的 `output` 内容；
- UI 端对 markdown 渲染一律经 DOMPurify 消毒，**不开放任意 HTML**；
- 缺省时 UI 按纯文本 `<pre>` 展示（与 v1 行为一致）。

### 7.4 设置注入示例

```json
// manifest.json（节选）
{
  "protocolVersion": 1,
  "settings": {
    "type": "object",
    "properties": { "greeting": { "type": "string", "default": "你好" } }
  }
}
```

```javascript
// execute 内
const greeting = ctx.settings?.greeting ?? '你好';
return { ok: true, output: `**${greeting}，${args.name}！**`, render: 'markdown' };
```

设置值由用户在 UI（`get/set-plugin-settings` 通道）配置，落盘于 `plugins/settings/<name>.json`，属**用户数据**——插件不得直接读写该文件，只能经 `ctx.settings` 获取。

> 实战范例：内置插件 `kb`（知识库）提供了 `kb.search`、`kb.reindex` 与 `kb.archive`（对话沉淀归档）三个工具，并用 settings 暴露了 5 个配置项（kbDir/chunking/embedEnabled/embedBaseUrl/embedModel），见 `plugins/builtin/kb/manifest.json`——设置页自动渲染表单，值注入 `ctx.settings`，插件零 UI 代码。

### 7.5 插件注册表

官方注册表见仓库 `registry/`（`registry.json` 索引 + PR 投稿 + sha256 校验）。
应用内经 `install-plugin-from-registry` 通道安装；信任边界如实说明见 `registry/README.md`。
