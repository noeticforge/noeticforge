# agent-base 插件注册表（v0）

**形态：一个 GitHub 仓库就是注册表**——不建服务器、不建账号体系，收录走 PR 人工审查。
应用内「插件市场」通过 `config.json` 的 `pluginRegistryUrl`（默认指向本仓库的 raw 地址）拉取 `registry.json` 并一键安装。

## registry.json 条目格式

```json
{
  "name": "web-clipper",
  "version": "1.2.0",
  "displayName": "网页剪藏",
  "description": "把网页正文存为 Markdown 文件",
  "author": "someone",
  "permissions": ["net:http", "fs:write"],
  "downloadUrl": "https://github.com/xxx/web-clipper/releases/download/v1.2.0/web-clipper-1.2.0.zip",
  "sha256": "…（zip 文件的 sha256，16 进制小写）",
  "protocolVersion": 1,
  "homepage": "https://github.com/xxx/web-clipper"
}
```

## 投稿流程（PR）

1. 把插件打包成 zip（**zip 根直接是 manifest.json**，或恰好一层同名目录包住）；
2. 计算 sha256：
   - Windows：`certutil -hashfile web-clipper.zip SHA256`
   - macOS/Linux：`shasum -a 256 web-clipper.zip`
3. 把 zip 放到可稳定下载的位置（GitHub Release 最佳），在 `registry.json` 追加条目；
4. 提 PR，审查人核对：
   - manifest 字段完整、`protocolVersion` ≤ 底座支持版本；
   - 权限声明与功能匹配（最小权限）；
   - 危险工具（`fs:write` / `shell:exec`）声明了 `requiresApproval`；
   - sha256 与 zip 一致；
5. 合并即上架。

## 信任边界（如实说明）

- 当前底座**没有沙箱**：插件代码在主进程内 `import()` 执行，声明式权限约束的是「声明与行为匹配」的纪律，不是物理隔离；
- 注册表审查 = 人工目检源码 + 校验和，**不能替代沙箱**；
- 建议用户优先安装官方/认证插件；执行敏感任务时留意审批弹窗内容。
- 进程隔离沙箱（MCP stdio / utilityProcess）落地后，本节会同步更新。

## 本地文件与网络通道的信任边界（v0.4 补充）

- `preview-file` / `read-attachment` / `@ 引用` 接受工作目录相对路径或**任意绝对路径**：信任假设是渲染进程可信（contextIsolation + DOMPurify 加固）。渲染进程一旦被攻破，这些通道可被用于读取本机文件；
- `web-fetch` 在「完全访问」模式下可访问内网地址（含 localhost），权限模式收紧（如计划模式）时会被运行时策略直接拒绝；
- 审计日志（`audit.log`）记录全部工具调用与审批决定，可据此排查异常使用。
