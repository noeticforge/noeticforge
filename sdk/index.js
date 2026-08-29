/**
 * @agent-base/sdk 运行时入口：definePlugin 是恒等函数，
 * 唯一作用是给插件作者提供类型标注与 IDE 补全，不改变任何行为。
 */
export function definePlugin(plugin) {
  return plugin;
}
