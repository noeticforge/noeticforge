# agent-base 插件标准规范与开发指令（Prompt 模版）

> **给 AI 的指令说明**：
> 当用户提供本规范并提出某个功能需求时，请严格按照下述两文件架构输出插件源码。
> 插件默认作者统一为：**何惜**。
> 输出格式必须严格符合契约，零冗余第三方库依赖，确保直接放入 `plugins/builtin/` 即可被系统热加载并供 LLM 循环引擎调度。

---

## 一、插件核心哲学与规则（不可违背）

1. **目录即插件**：一个插件对应一个文件夹（推荐小写中划线，如 `my-plugin-name`）。
2. **两文件极简规范**：
   - 根目录下必须包含且仅包含两个核心文件：`manifest.json` 与 `index.js`。
   - 严禁擅自引入未在项目主 package.json 声明的外部 npm 包，优先使用 Node.js 原生模块（`node:fs`、`node:path`、`node:child_process`、原生 `fetch` 等）。
3. **命名强约束**：
   - `manifest.name` 必须是 kebab-case（如 `network-tools`）。
   - `tools` 数组中的工具 `name` **必须强制以 `<manifest.name>.` 为前缀**（例如 `network-tools.ping`、`network-tools.curl`），否则底座注册表会校验失败拒绝加载！
4. **权限最小化声明**：
   - `permissions` 只能从这 4 种中挑选：
     - `"fs:read"`（读取文件）
     - `"fs:write"`（写入/修改文件）
     - `"shell:exec"`（执行命令行）
     - `"net:http"`（发起 HTTP/HTTPS 网络请求）
   - 工具用不到的权限严禁多声明；无系统调用时声明为空数组 `[]`。

---

## 二、标准文件模版

### 1. `manifest.json`（插件清单）
```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "displayName": "插件中文展示名",
  "description": "简明扼要说明该插件提供什么能力，供设置页展示",
  "author": "何惜",
  "permissions": [
    "fs:read"
  ],
  "entry": "index.js",
  "protocolVersion": 1
}
```

### 2. `index.js`（插件执行逻辑）
```javascript
// 支持直接解构导入 Node 原生库
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 1. 定义工具（可在一个插件中定义多个工具）
const demoTool = {
  // 必须以 "插件名." 为前缀
  name: 'my-plugin.action_name',

  // 工具功能说明：AI 循环引擎依靠此描述决定何时、为何调用本工具，必须清晰准确
  description: '详细描述该工具的具体功能，能处理哪些任务，以及什么场景下使用',

  // 参数定义：标准 JSON Schema 规范
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '目标参数的具体说明'
      },
      verbose: {
        type: 'boolean',
        description: '是否开启详细输出模式'
      }
    },
    required: ['target'] // 必填参数列表
  },

  // 该工具执行所需的权限，必须是 manifest.json 中 permissions 的子集
  permissions: ['fs:read'],

  // 是否需要人工弹窗审批：
  // - false: 安全只读操作，直接执行，不打扰用户；
  // - true: 敏感或破坏性操作（如写入、删文件、跑 shell），会弹出液态玻璃审批框由用户确认。
  requiresApproval: false,

  // 核心执行函数
  // args: LLM 提取并传入的符合 parameters Schema 的参数对象
  // ctx: 底座注入的上下文，包含 { workingDir, pluginName, settings }
  async execute(args, ctx) {
    try {
      const baseDir = ctx?.workingDir || process.cwd();
      const targetPath = path.resolve(baseDir, String(args.target || ''));

      // 核心业务逻辑实现...
      const data = await readFile(targetPath, 'utf-8');

      // 标准返回值格式（必须包含 ok 与 output）
      return {
        ok: true,
        output: `读取成功，内容共 ${data.length} 字符：\n${data.slice(0, 500)}`,
        
        // 可选渲染提示（支持 markdown / diff / table）
        render: {
          type: 'markdown',
          content: `✅ **处理完成：** \`${targetPath}\`\n\`\`\`\n${data.slice(0, 300)}\n\`\`\``
        }
      };
    } catch (err) {
      return {
        ok: false,
        output: `执行失败: ${err.message}`,
        error: err.message
      };
    }
  }
};

// 2. 导出插件标准对象
export const plugin = {
  tools: [demoTool]
};
```

---

## 三、如何把写好的插件装入软件？

### 方式 1：内置到软件（开箱即用，最推荐）
把生成好的插件文件夹整个移动到软件工程的内置目录：
`noeticforge/plugins/builtin/<你的插件名>/`
软件启动或下次执行任务时会自动扫描并加载该插件。

### 方式 2：在软件界面一键动态安装
1. 打开 `agent-base` 桌面客户端；
2. 进入「设置」→「插件」；
3. 在“本地目录安装”框中填入插件文件夹的绝对路径（如 `D:\my-plugin`），点击“安装”；
4. 插件将自动被复制并热加载，无需重启软件即可在对话框中直接使用。

---

## 四、下次直接对 AI 使用的召唤指令（复制即可使用）

```text
请参考《agent-base 插件标准规范》，帮我开发一个新插件：
1. 插件功能：[在这里填写你需要的功能，如：系统端口占用查询与进程终止]
2. 插件英文名：[如：port-manager]
3. 作者：何惜
4. 严格按照 manifest.json 与 index.js 的标准结构完整输出代码，确保 tools.name 携带插件名前缀，并给出正确安全的权限声明。
```
