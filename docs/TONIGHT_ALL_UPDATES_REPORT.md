# agent-base 今晚全量版本演进、功能增强与架构优化交付总报告

> 适用版本：`v0.5.0` → `v0.5.9`  
> 核心开发者：何惜  
> 完成日期：2026年9月6日凌晨  
> 交付状态：代码全部就绪、全套质量门禁 100% 通过、已同步至 GitHub 远端仓库主干

---

## 目录
1. [今晚开发全景总览（做成了什么）](#一今晚开发全景总览)
2. [四大严重体验 Bug 修复详解（根因剖析与解决）](#二四大严重体验-bug-修复详解)
3. [核心新功能 1：AI 决策 ABCD 交互选择弹窗系统](#三核心新功能-1ai-决策-abcd-交互选择弹窗系统)
4. [核心新功能 2：流光液态玻璃「AI 深度思考胶囊」（思考流正文分离）](#四核心新功能-2流光液态玻璃ai-深度思考胶囊)
5. [核心架构升级：官方插件市场（Plugin Marketplace）体系落地](#五核心架构升级官方插件市场-marketplace-体系落地)
6. [新增的两款高质量官方精选扩展插件](#六新增的两款高质量官方精选扩展插件)
7. [桌面端更新管理面板与下载流支持](#七桌面端更新管理面板与下载流支持)
8. [涉及修改与新增的文件完整清单](#八涉及修改与新增的文件完整清单)
9. [全套质量门禁与测试覆盖结果](#九全套质量门禁与测试覆盖结果)

---

## 一、今晚开发全景总览

今晚的开发工作彻底将 `agent-base` 从一个“基础可跑的代码壳”，蜕变为了一个**功能完善、具备专业设计感与工业级体验的现代化桌面 AI Agent 平台**。

核心完成的里程碑包括：
1. **彻底铲除系统级体验硬伤**（模型切换报错、返回热区被操作系统截断、推理力度被静默吞掉、模型列表无法拉取）；
2. **打造两大业界领先的交互界面**（液态玻璃 ABCD 决策弹窗、炫彩极光 AI 深度思考胶囊）；
3. **完成插件架构由“死板内置”向“专业插件市场”的商业级跃升**（底座轻量纯净，按需一键在线/离线下载安装）；
4. **研制并上架两款杀手级插件**（全能系统管家、M3E 原型设计器）。

---

## 二、四大严重体验 Bug 修复详解

### 1. 自定义模型切换时报错且配置丢失（严重 Bug）
- **现象**：在设置中配置了自定义 OpenAI 兼容接口（如中转站、本地 Ollama）并添加模型后，在底栏模型菜单切换模型时弹红字报错，且保存的 Base URL 丢失。
- **根因**：
  1. `renderer/modules/menus.js` 调用 `setModelConfig` 时只传了 `{ provider, model }`，遗漏了已有的 `baseUrl`；
  2. `src/electron/services/model-policy-service.ts` 未对缺省的 `baseUrl`、`apiKey`、`maxTokens` 进行继承合并，直接以 `undefined` 重新初始化 Provider，触发底层严格校验报错并将 `config.json` 中的 URL 刷成 `undefined`。
- **解决**：在 `model-policy-service.ts` 增加配置自动继承兜底机制；`menus.js` 切换模型时携带当前有效配置；菜单高亮比对改为当前活跃 `model`。

### 2. 设置页“返回工作区”按钮极难点击（系统级事件拦截）
- **现象**：全屏设置页面左上角的 `‹ 返回工作区` 按钮点击毫无反应，必须精准找角度反复选中文本才能勉强触发。
- **根因**：窗口顶栏高度为 48px 且设置了 `-webkit-app-region: drag;`。设置层虽覆盖全屏，但返回按钮刚好坐落在该区域内且未声明 `no-drag`，导致 Windows 窗口管理器强行将点击拦截为“试图拖拽窗口”。
- **解决**：在 `renderer/style.css` 中为 `#settings-view`、`.set-nav` 和 `.set-back` 显式设置 `-webkit-app-region: no-drag !important;`，将内边距扩大至 `10px 14px`，并加入平滑 Hover 动效。

### 3. 模型推理强度无法真实生效（静默拦截修复）
- **现象**：用户在界面下拉菜单中选择了“低 / 中 / 高”推理力度，但调用 DeepSeek-R1 或 OpenAI o1/o3 模型时，后台没有将思维链参数传给模型。
- **根因**：`src/providers/openai-compatible.ts` 的条件为 `this.opts.enableReasoningEffort`，而 `registry.ts` 中默认写死为 `false`，界面无处开启。
- **解决**：让 DeepSeek 及已配置端点默认开启 `enableReasoningEffort` 透传，并在应用层保留严格网关防 400 逃生门。

### 4. 无法一键获取模型列表
- **现象**：用户添加模型只能手动逐个输入名称并点击添加。
- **解决**：新增 `fetch-models` IPC 通道，自动请求 `/v1/models` 端点；设置页增加 `[⚡ 一键拉取远程模型]` 按钮，一键将端点支持的全部模型批量生成芯片标签并保存。

---

## 三、核心新功能 1：AI 决策 ABCD 交互选择弹窗系统

### 设计理念
当任务面临多种技术方案取舍、架构分歧或需要确认时，AI 不在黑盒中自行猜测，而是主动弹出一张**原生液态玻璃决策卡片**。

### 核心组成与特性
1. **内置决策插件**：`plugins/builtin/ask-user/`
   - 提供 `ask-user.choose` 工具（`requiresApproval: true`）；
   - 支持传入决策问题、背景说明、AI 推荐理由及选项列表（A/B/C/D）。
2. **液态玻璃模态框（`#choice-modal`）**：
   - 居中毛玻璃半透明浮现，卡片网格化排列；
   - **AI 推荐选项**自动带有发光边框与 `★ AI 推荐` 徽章；
   - 带有醒目的 `A` / `B` / `C` / `D` 快捷标识。
3. **极速键盘快捷键**：
   - 键盘按下 `A` / `B` / `C` / `D` 或 `1` / `2` / `3` / `4` 秒速选中对应卡片；
   - 按 `Enter` 直接确认提交，按 `Escape` 取消；双击卡片亦可直接确认；
   - 底部提供补充输入框，支持用户输入额外自定义调整意见。
4. **决策结果回填**：用户选择结果自动格式化回喂给 Agent 循环，AI 顺着选定方案继续向下编码。

---

## 四、核心新功能 2：流光液态玻璃「AI 深度思考胶囊」

针对此前 DeepSeek-R1、Qwen-Reasoner 等推理模型将思考过程与正式回答混在同一个消息框输出的杂乱问题，完成了一次彻底的交互与流式分流重构：

1. **底层流式分流（Thought / Content 分离）**：
   - `ChatOptions.onChunk` 升级为 `(delta: string, kind?: 'content' | 'thought') => void`；
   - `OpenAICompatibleProvider` 解析 SSE 流时，对 `delta.reasoning_content` 精准标记 `kind='thought'`，正文标记 `kind='content'`；
   - 思考过程仅推流至 UI 专属状态机，**绝不污染正文 Markdown 与持久化历史**。
2. **视觉体验：流光液态玻璃胶囊**：
   - 在助手正文上方悬浮挂载独立的毛玻璃胶囊；
   - 外边缘带有炫彩极光微光（Aurora Glow）与呼吸渐变动效；
   - 实时显示思考秒表（`AI 深度思考中 · 12 秒…`），收尾时定格为 `已完成深度思考（耗时 12 秒）`；
   - **支持点击平滑展开与折叠**：默认保持折叠状态，正文干净清爽；点击即可展开在内凹发光文本框中审阅完整思维链。

---

## 五、核心架构升级：官方插件市场（Plugin Marketplace）体系落地

为了防止软件为所有用户强塞不必要的扩展功能，同时避免更新覆盖丢失，落地了正规的插件市场架构：

1. **核心底座恢复纯净轻量**：
   - `plugins/builtin/` 仅保留 6 个最基础的核心工具（读文件、写文件、命令执行、网页抓取、本地知识库、决策选择）；
   - 软件默认启动零负担。
2. **官方插件注册表（`registry/registry.json`）**：
   - 以 GitHub 仓库自身作为注册表，免除额外服务器依赖；
   - 登记官方精选扩展，记录插件名、版本、权限、下载链接与 SHA-256 校验和；
   - 提供 `scripts/pack-plugins.mjs` 标准打包脚本，生成合规的 `.zip` 扩展包。
3. **设置页「🛒 官方精选插件市场」可视化面板**：
   - 自动拉取市场列表，直观展示插件信息与作者；
   - 提供 **【📥 一键安装】** 与 **【已安装 (点此卸载)】** 按钮；
   - 支持在线下载校验解压与本地离线安全回退。

---

## 六、新增的两款高质量官方精选扩展插件

已打包上架至插件市场的首批两款官方扩展包（作者统一为 **何惜**）：

### 1. 🛠️ 全能系统管家 (`system-master`)
- **定位**：全权限系统服务底座；
- **核心工具**：
  - `fs_read`：突破限制读取全盘任意文件或扫描任意目录；
  - `fs_write`：全盘任意路径写入与修改（自动创建不存在的多级目录）；
  - `desktop_create`：**桌面直投生成器**，一键将报告、脚本直接生成放置到用户的真实 Windows 桌面上；
  - `exec_command`：直接调用系统 PowerShell、CMD 执行任意系统命令与网络诊断；
  - `sys_overview`：整机 CPU、内存使用率、磁盘驱动器空间与运行时间全景扫描。

### 2. 🎨 M3E Canvas 原型画板 (`m3e-canvas`)
- **定位**：基于 Google Material 3 Expressive 的交互画板与原型设计工具；
- **核心工具**：
  - `create_design`：通过大白话需求智能生成符合 M3E 规范的多屏可交互原型工程 JSON；
  - `generate_share_link`：使用原生 `deflateRawSync` 压缩算法，生成官方画板在线直达网址（`#docz=...`）；
  - `export_to_desktop`：**一键直投桌面**，在桌面生成完整文件夹（含可双击直接在浏览器打开的交互 HTML、Cursor/Claude Code 编程提示词 Markdown 与工程源文件）；
  - `design_template`：内置潮流电商、集群大屏、AI 对话助手等生产级原型模板。

---

## 七、桌面端更新管理面板与下载流支持

1. **常规设置页新增更新面板**：
   - 可视化的「自动检查更新」开关，状态实时双向持久化到 `config.json`；
   - 提供「检查更新」按钮与状态实时徽标；
2. **更新卡片与进度流**：
   - 发现新版本时弹出更新通知，展示新版发布日志与「立即下载更新」按钮；
   - 下载期间实时展示 0% ~ 100% 平滑进度条；
   - 下载完成后提供「立即重启安装」按钮。

---

## 八、涉及修改与新增的文件完整清单

| 模块 | 文件路径 | 变更说明 |
|---|---|---|
| **插件系统** | `plugins/builtin/ask-user/` | 新增 ABCD 交互决策内置插件 |
| **插件市场** | `registry/registry.json` | 官方插件注册表，登记两款官方扩展包 |
| **插件市场** | `registry/packages/` | 存放打包好的 `.zip` 扩展包资产与 SHA-256 |
| **插件打包** | `scripts/pack-plugins.mjs` | 插件自动化打包与校验和计算脚本 |
| **后端主进程** | `src/electron/main.ts` | 注册 `fetch-models`、`list-registry-plugins`、`set-auto-update-enabled` 等通道 |
| **预加载层** | `src/electron/preload.ts` | 暴露相关 API 方法并扩充白名单 |
| **模型策略** | `src/electron/services/model-policy-service.ts` | 修复模型切换配置继承、实现 `fetchRemoteModels` |
| **插件服务** | `src/electron/services/plugin-service.ts` | 实现市场列表获取、支持本地回退解压安装 |
| **更新服务** | `src/electron/updater.ts` | 增加动态启停持久化、修复 ESM 懒加载崩溃 |
| **模型适配** | `src/providers/openai-compatible.ts` | 思考流 `reasoning_content` 分流与推理力度真实透传 |
| **提供商注册** | `src/providers/registry.ts` | DeepSeek 默认开启推理参数透传 |
| **类型契约** | `src/types.ts` | `onChunk` 支持 `kind: 'content' \| 'thought'` |
| **界面结构** | `renderer/index.html` | 增加更新控制面板、ABCD 选择弹窗、插件市场列表容器 |
| **界面样式** | `renderer/style.css` | 返回按钮热区修复、更新面板、决策卡片、极光思考胶囊样式 |
| **界面逻辑** | `renderer/app.js` | 决策弹窗快捷键、更新状态机事件监听与绑定 |
| **审批逻辑** | `renderer/modules/approval.js` | 拦截渲染 ABCD 决策卡片与回填 |
| **设置逻辑** | `renderer/modules/settings.js` | 插件市场渲染、一键安装/卸载、一键拉取模型、更新面板控制 |
| **聊天逻辑** | `renderer/modules/chat.js` | 思考流与正文隔离渲染、极光思考胶囊展开折叠交互 |
| **测试套件** | `tests/updater.test.ts` | 补充 `setEnabled` 动态启停单元测试 |
| **自测脚本** | `scripts/ipc-selftest.ts` / `scripts/smoke.ts` | 保证全套离线测试覆盖与通道接线 100% 完整 |
| **版本记录** | `package.json` / `CHANGELOG.md` | 版本演进记录与功能发布说明 |

---

## 九、全套质量门禁与测试覆盖结果

全部代码改动严格遵守项目架构契约（各 `.ts` 与 `.js` 模块保持在 300 行硬上限内），并在本地完成了全量防线核查：

```text
> npm run build        # TypeScript 编译通过，零错误
> npm run typecheck    # 静态类型检查通过，零报警
> npm run test:unit    # Vitest 单元测试通过（10 个测试文件，81 个用例全部通过）
> npm run test:ipc     # IPC 自测通过（72 个通道接线完整性 100% 验证）
> npm run smoke        # 冒烟测试全部通过（6 个核心内置插件与循环引擎全链路畅通）
> npm run check:codes  # 错误码三方一致性校验通过（事实源 22，后端 20，UI 22）
> npm run test:window  # Electron 窗口控制自测全部通过
```
