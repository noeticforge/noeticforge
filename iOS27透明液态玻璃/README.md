# iOS27透明液态玻璃 Design System

A design system reconstruction of **iOS27 Liquid Glass** — Apple's next-generation "meta-material" design language (WWDC 2025 Liquid Glass: lensing refraction, specular highlights, ambient tinting), rebuilt for desktop applications. 这不是移动端移植，而是把玻璃的折射、高光与环境染色转译为桌面产品可直接消费的 token 与组件。

### Source

Reconstructed from Apple HIG "Liquid Glass" principles, WWDC 2025 "Meet Liquid Glass", and iOS system design constants. 原则与常量来自 Apple 公开材料，经分析师整理后固化为本库的 token 体系。

### What this covers

- **Foundations** — 色彩（7 组 liquid scale）、字体（Inter / SF Mono 体系）、间距（4px 基准）、圆角（4–9999px）、阴影（5 层）、玻璃材质（surface-glass 系 token）
- **Components** — 6 个组件：Button / Card / Input / Modal / Navigation / Switch，含预览页与契约 JSON
- **Sample kit** — `preview/` 下 6 个可交互组件预览页，作为 UI Kit 的最小可用样本

## Content Fundamentals

### Voice & tone

UI 文案为简体中文。操作动词一律两个字的祈使句——"新建""删除""创建"——不加敬语、不加尾标点，直给动作与对象。信息架构层的词全部是名词短语：导航项（"首页""最近""收藏""设置"）、开关标签（"通知提醒""自动同步"）、卡片标题（"最近项目"），不带语气词与 emoji。系统场景是一个项目协作工具：模态、卡片、设置项都围绕"项目"实体组织语言（"项目名称""项目描述""删除项目？"）。整体克制、中性、工具感强——文案从不解释自己，只陈述动作与对象；完整短句只出现在内容级文案（卡片摘要、确认信息）里。

### Concrete copy examples (lifted from preview pages)

- 输入框占位：*"搜索项目、文件"* — 动词 + 名词 + 名词的紧凑结构
- 主操作按钮 / 模态标题：*"新建"* / *"新建项目"* — 动作与对象分层表述
- 删除确认：*"删除项目？"* → *"确定删除该项目？"* — 问句标题 + 陈述确认句
- 卡片摘要：*"最近项目与协作动态概览"* — 内容级文案允许完整短句
- 设置开关标签：*"通知提醒"*、*"自动同步"* — 纯名词短语，无动词

### When generating copy

- 操作类文案用两字动词（新建 / 取消 / 删除 / 创建），禁用英文与句末标点
- 占位符用"动词 + 具体对象"（"搜索项目、文件"），不用空泛的"请输入……"
- 破坏性操作必须成对出现：问句标题 + 陈述确认句，操作拆为"取消" + "删除"
- 所有控件文案不含 emoji、语气词与敬语；摘要、提示等内容级文案才允许完整句子

## Visual Foundations

### Color

品牌主色 `#007aff`（--liquid-blue-600），一颗典型的 iOS 系统蓝：饱和但不刺眼，是玻璃高光与环境的锚点，承担主按钮、焦点环（--ring）与链接（--link）。Scale 体系为 7 组 × 10 个 stop（50–900），以 liquid- 前缀命名，主色锚定在 600 档。强调色为紫罗兰 `#af52de`（--liquid-violet-500），只做点缀——出现在玻璃氛围的渐变墙纸（card-media 的 violet → blue）里，不进入操作控件。中性色是一组 10 档的 liquid-gray，工作主力是 `#f2f2f7`（--background）、`#ffffff`（--surface）、`#6d6d72`（--muted-foreground）、`#1c1c1e`（--foreground）。语义色独立于品牌 scale：成功 `#34c759`、警告 `#ff9500`、错误 `#e6251b`、信息 `#1e92aa`——恰好是 iOS 生态的语义四色。整体氛围是"冷色玻璃 + 白灰分层"：蓝紫渐变撑起深度，白色玻璃浮于其上，灰阶负责层级，暖色只在语义状态出现，从不混入品牌语境。

### Typography

主字体 **Inter**（Google Fonts 引入 400 / 500 / 600 / 700 四档字重），在非 Apple 平台替代 SF Pro 承担拉丁与数字字符；中文回退 **PingFang SC**（macOS / iOS）与 **Microsoft YaHei**（Windows）。等宽字体 **SF Mono**，回退 **JetBrains Mono**，用于代码与数据。字号阶梯 56 / 40 / 32 / 24 / 20 / 18 / 16 / 12 px，另加 14px mono；display 与 h1 用 700 字重，h2–h4 用 600，正文与说明 400。行高策略是"标题收紧、正文放松"：display 1.1 → h1 1.2 → h2 1.25 → h3 1.3 → h4 1.4 随层级递减，正文与 lead 放宽到 1.6 / 1.7，caption 1.5——玻璃卡片里的段落不靠字号、而靠 1.6 行高撑出呼吸感。

### Spacing

基准单位 4px，token 覆盖 --space-1 至 --space-8（4 / 8 / 12 / 16 / 24 / 32 / 48 / 64）。控件高度全部落在 4px 网格：按钮 32 / 40 / 48px（sm / md / lg），输入框 36px，图标 16 / 20 / 24px。玻璃卡片默认内边距 space-6（32px），紧凑态压到 space-4（16px）。

### Radius

- **4px**（--radius-sm）— 链接与 chip 的内嵌微圆角
- **10px**（--radius-md）— 一切操作控件的默认语言：按钮、输入框、导航项、工具栏
- **16px**（--radius-lg）— 玻璃卡片、侧边栏、确认弹窗这类"浮层上的大块"
- **28px**（--radius-xl）— 模态面板与 Hero 卡片，玻璃层级越高圆角越大
- **9999px**（--radius-full）— 仅开关、头像这类胶囊元素

圆角哲学：玻璃感靠大圆角维持，操作感靠 10px 统一语言，胶囊只留给切换件。

### Shadow / Elevation

5 层阴影从"静置"到"悬浮"：--shadow-1 `0 1px 2px + 0 1px 1px`（控件静置）、--shadow-2 `0 4px 10px`（卡片）、--shadow-3 `0 8px 24px -6px`（玻璃卡片悬浮）、--shadow-4 `0 16px 40px -10px`（模态）、--shadow-5 `0 28px 64px -16px`（遮罩层）。哲学是"悬浮越高、模糊越重、透明度越低"——每上一层偏移与模糊同涨，负 spread（-6 / -10 / -16px）让光从玻璃四周溢出而非压死边缘。玻璃件永远叠加 `inset 0 1px 0` 顶部高光（--surface-glass-highlight），制造材质感而非纯投影。

### Borders & Backgrounds

- 玻璃表面用发丝级白描边 `rgba(255,255,255,0.24)`（--border-hairline），暗色模式降至 0.16——这是玻璃"边缘感"的唯一来源
- 不透明表面用实体灰 `#d1d1d6`（--border），暗色模式 `#3a3a3c`；焦点环 `#007aff`（暗色 `#47a6ff`），输入框聚焦以 `0 0 0 3px` ring 呈现
- 背景分三层：`--background #f2f2f7`（页面）、`--surface #ffffff`（实体卡片）、`--surface-muted #e5e5ea`（凹入舞台）；遮罩 `--overlay-dimmer rgba(0,0,0,0.28)`（暗色 0.40）

### Glass material

玻璃材质由 5 个 token 定义：`--surface-glass rgba(255,255,255,0.12)`（标准玻璃）、`--surface-glass-clear rgba(255,255,255,0.06)`（更透明的玻璃：导航搜索框、Hero 卡、模态内输入）、`--surface-glass-highlight rgba(255,255,255,0.40)`（顶部高光）、`--surface-popover rgba(255,255,255,0.70)`（暗色模式为 0.80 的深色玻璃）。所有玻璃面统一 `backdrop-filter: blur(20px) saturate(180%)`（模态 24px），叠加发丝描边与 inset 顶部高光，亮面以 `::before` 线性渐变（180deg，highlight → transparent 40–45%）制造镜面反射。染色遵循固定 token 而非环境采样；且**不允许玻璃叠玻璃**——玻璃只能浮在实色或 dimmer 遮罩之上，两层玻璃堆叠是明确的禁用模式。

## Component Patterns

| Component | File | Key Insight |
|---|---|---|
| Button | `preview/component-button.html` · `components/button.json` | 四风格（primary / secondary / ghost / destructive），主按钮靠 inset 顶部高光伪装玻璃凸起，hover 用 brightness 而非换色 |
| Card | `preview/component-card.html` · `components/card.json` | 三密度（regular / compact / clear），blur(20px) + saturate(180%)，hover 从 shadow-2 浮到 shadow-3 |
| Input | `preview/component-input.html` · `components/input.json` | 玻璃内嵌式输入，聚焦靠 `0 0 0 3px` ring 而非描边变色，错误态复用红 ring |
| Modal | `preview/component-modal.html` · `components/modal.json` | 玻璃面板 480px / 确认弹窗 320px，`::before` 线性渐变高光，actions 以发丝线分隔 |
| Navigation | `preview/component-navigation.html` · `components/navigation.json` | 240px 玻璃侧边栏 + 工具栏，选中项用 primary 14% 的 color-mix 染色 |
| Switch | `preview/component-switch.html` · `components/switch.json` | 51×31 标准 / 38×24 小号，on 态直接铺成功绿，thumb 白圆带 shadow-1 |

## Index

- `README.md` — 本文件：品牌叙事、内容规范、视觉基础
- `colors_and_type.css` — 全部设计 token 的单文件 CSS 变量（颜色 / 字体 / 间距 / 圆角 / 阴影 / 玻璃）
- `css.json` — token 的结构化 JSON 形态，供程序化消费
- `components.css` — 从预览页聚合的组件 CSS
- `components/` — 组件契约 JSON 与索引（index.json）
- `preview/` — 6 个可交互组件预览页（component-{slug}.html）
- `SKILL.md` — AI 代理的技能入口清单

## Caveats / known substitutions

1. **SF Pro 在非 Apple 平台不可用**：拉丁字符以 Inter（400–700）替代，中文回退 PingFang SC → Microsoft YaHei；Inter 不含 CJK 字形，中文文案实际由系统字体渲染，跨平台字面存在细微差异。
2. **真实 Liquid Glass 是动态折射 + 环境染色采样**（WWDC 2025），本系统以 CSS `backdrop-filter: blur(20–24px) saturate(180%)` 加静态 rgba token 近似；染色固定，不随壁纸内容变化。
3. **玻璃不叠玻璃**：玻璃面下方必须有实色或 dimmer（`rgba(0,0,0,0.28)`），两层玻璃堆叠的效果未定义，勿自行尝试。
4. **BrandFile 为空**：phase2-brand-analyst.json 未产出 uiCopySamples 与品牌人格，本文档的文案样本取自已交付的 preview 页面，语音风格由文案形态反推，而非品牌方授权。
5. **桌面化数值为推断值**：控件高度（32 / 40 / 48px）、输入框 36px、模态宽度 480 / 320px 是对 iOS 常量的桌面重映射，未经 iOS 端实测校准。
6. **Inter 依赖 Google Fonts CDN**（colors_and_type.css 顶部 @import）；离线环境将整体回退到 -apple-system / PingFang SC / Microsoft YaHei，字面宽度会变化。
