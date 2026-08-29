---
name: ios27-liquid-glass-design
description: Use this skill to generate well-branded interfaces for iOS 27 透明液态玻璃. Contains colors, type, fonts, assets, and UI kit for prototyping app UIs.
user-invocable: true
---
# iOS 27 透明液态玻璃 Design Skill

Read the `README.md` file within this skill, and explore the other available files.

If creating visual artifacts, copy assets out and create static HTML files. If working on production code, read the rules here to become an expert in designing with this brand.

## Quick map

- `README.md` — brand context, content fundamentals, visual foundations (read first)
- `colors_and_type.css` — drop-in CSS variables for colors, type, radius, shadow, spacing
- `css.json` — structured token understanding source
- `components.css` — aggregated component CSS extracted from previews
- `preview/` — small HTML cards illustrating foundations and components
- `components/index.json` — component index + cross-component patterns

## Essentials at a glance

- Brand primary `#007aff` — iOS system blue, the anchor tint for glass elements; accent violet `#af52de` for secondary highlights.
- Radius 4/10/16/28 — controls 4-10, cards 16, sheets 28, pills full (9999px); matches iOS native glass curves.
- 40px default button height (md), 36px input height, 4px base spacing unit on an 8-pt grid.
- Type: Inter (Latin, via Google Fonts import); PingFang SC / Microsoft YaHei (CN fallbacks); SF Mono / JetBrains Mono for code.
- Voice: Chinese-first, concise, calm, no emoji in product UI.
- Shadow: 5 soft ambient levels from control rest (`0 1px 2px`) to overlay (`0 28px 64px`), always diffuse, never hard.
- Glass is a first-class token: `surface-glass` / `surface-glass-clear` / `surface-glass-highlight` with hairline `rgba(255,255,255,0.24)` borders — never glass-on-glass.

## Components

| Slug | Name | Key Insight |
|------|------|-------------|
| button | Button 按钮 | Tinted glass primary with specular highlight and liquid press feedback |
| card | Card 玻璃卡片 | Regular/Clear dual glass materials with hairline border and specular highlight |
| input | Input 输入框 | Glass field with blue focus ring and red error semantics |
| navigation | Navigation 导航 | Floating glass sidebar with tinted capsule selection |
| modal | Modal 模态面板 | Floating glass sheet over dimmed wallpaper, 28px radius |
| switch | Switch 开关 | iOS pill toggle: green tinted on / glass off |
