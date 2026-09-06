/**
 * 错误码单一事实源（Single Source of Truth）。
 *
 * 同步纪律（CONTRIBUTING.md 铁律 4）：
 *   新增/删除错误码必须同步三处——本文件、docs/IPC_EVENT_PROTOCOL.md §6.2、renderer/app.js 的 ERR_TEXT。
 *   `npm run check:codes` 会在 CI 校验三方一致性。
 *
 * 后端构造 LoopError 时只准使用本表的 code；UI 层据 code 出中文文案。
 */
export const ERROR_CODES = {
  // ---- 消息与循环 ----
  E_INVALID_MESSAGE: '消息不合法：必须是内容非空的用户消息',
  E_LOOP_BUSY: '当前会话有循环正在运行，请先停止或等待其完成',
  E_NO_PENDING_APPROVAL: '没有待审批的工具调用',
  E_LLM_ERROR: '模型调用出错',
  E_MAX_ITERATIONS: '已达到最大迭代次数，循环终止',
  E_INTERNAL: '后端内部错误',

  // ---- Provider 配置 ----
  E_PROVIDER_NOT_CONFIGURED: '尚未配置模型，请在「模型设置」中填写 API Key',
  E_PROVIDER_UNSUPPORTED: '不支持的模型提供商',
  E_INVALID_CONFIG: '配置无效，请检查 apiKey / model / baseUrl',

  // ---- 会话 ----
  E_SESSION_NOT_FOUND: '会话不存在或已被删除',
  E_SESSION_IN_USE: '会话有正在进行的任务，暂不可删除',

  // ---- 插件 ----
  E_PATH_NOT_FOUND: '目录不存在',
  E_PLUGIN_VALIDATION_FAILED: '插件校验失败，请检查 manifest.json',
  E_PLUGIN_LOAD_FAILED: '插件加载失败',
  E_PLUGIN_NOT_FOUND: '插件不存在或已卸载',
  E_PLUGIN_IN_USE: '插件工具正在执行，暂不可卸载',
  E_PLUGIN_UNINSTALL_FAILED: '插件卸载失败：文件删除出错',
  E_PLUGIN_BUILTIN: '内置插件不允许卸载',
  E_PLUGIN_NOT_IN_REGISTRY: '插件注册表中没有这个插件',
  E_CHECKSUM_MISMATCH: '插件包校验失败（sha256 不符），已中止安装',
  E_REGISTRY_FETCH_FAILED: '插件注册表获取失败，请检查网络',

  // ---- MCP ----
  E_MCP_NOT_FOUND: 'MCP 服务器不存在',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
