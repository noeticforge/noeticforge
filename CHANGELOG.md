# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。所有对外行为变化（IPC 通道、事件 payload、插件协议、错误码）都必须记录在此。

## [未发布]

### 计划中（见 docs/DEVELOPMENT_PLAN.md）
- 多会话与持久化、上下文窗口管理
- Provider 注册表化
- MCP 客户端接入
- Anthropic 流式
- electron-builder 打包

## [0.1.0] - 2026-08

首个可运行版本。

- Agent 循环引擎（工具调用 / 流式 / 可中断 / 审批钩子）
- Provider 适配层（DeepSeek / OpenAI / Anthropic + Mock）
- 插件加载器（manifest 校验 / 热装卸 / 缓存穿透）
- Electron 外壳 + IPC 事件协议 15 通道
- 安全三道关卡（权限白名单 / 强制审批 / 参数 Schema 校验）
- 测试页 renderer/ + 冒烟测试 + IPC 自测
