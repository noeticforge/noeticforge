import readline from 'node:readline/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage, LoopEvent, LoopOptions } from './types.js';
import { createProvider } from './providers/provider.js';
import { ToolRegistry } from './core/registry.js';
import { runLoop } from './core/loop.js';
import { loadPluginsFromRoot } from './plugins/loader.js';

const SYSTEM_PROMPT = `你是一个桌面端助手，可以通过提供的工具读写用户电脑上的文件来完成任务。
工具的执行结果会以 tool 消息返回给你。如果工具返回了错误，请如实告知用户，不要虚构结果。`;

async function main(): Promise<void> {
  const cfgPath = process.argv[2] ?? 'config.json';
  if (!existsSync(cfgPath)) {
    console.error(`未找到配置文件 ${cfgPath}。请复制 config.example.json 为 config.json 并填入 API Key。`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));

  const provider = createProvider(cfg);
  const registry = new ToolRegistry();
  const pluginsRoot = path.resolve('plugins');
  const report = await loadPluginsFromRoot(pluginsRoot, registry);

  console.log(`agent-base v0.1.0 | 模型: ${cfg.provider} (${cfg.model ?? '默认'})`);
  console.log(`已加载插件: ${report.loaded.join(', ') || '无'}`);
  if (report.failed.length) {
    console.warn(`加载失败的插件: ${report.failed.map((f) => `${f.dir}(${f.error})`).join('; ')}`);
  }
  console.log('输入消息开始对话，输入 exit 退出。\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatMessage[] = [];

  while (true) {
    const userMessage = await rl.question('你> ');
    const trimmed = userMessage.trim();
    if (!trimmed) continue;
    if (trimmed === 'exit' || trimmed === 'quit') break;

    let approvalCount = 0;
    const options: LoopOptions = {
      maxIterations: 15,
      onEvent: (e) => printEvent(e),
      // config.json 可选字段：运行时权限白名单 + 强制审批权限列表
      allowedPermissions: Array.isArray(cfg.allowedPermissions) ? cfg.allowedPermissions : undefined,
      forceApprovalPermissions: Array.isArray(cfg.forceApprovalPermissions) ? cfg.forceApprovalPermissions : undefined,
      requestApproval: async (call) => {
        approvalCount++;
        const ans = await rl.question(
          `  ⚠ 工具 "${call.name}" 需要批准，参数: ${JSON.stringify(call.arguments)}\n  批准吗？(y/n) `,
        );
        return ans.trim().toLowerCase().startsWith('y') ? 'approved' : 'rejected';
      },
    };

    try {
      const result = await runLoop({
        provider,
        registry,
        systemPrompt: SYSTEM_PROMPT,
        userMessage: trimmed,
        history,
        // config.json 可选：上下文 token 预算，超限整轮截断（只影响发给模型的内容）
        contextTokenBudget: typeof cfg.contextTokenBudget === 'number' ? cfg.contextTokenBudget : undefined,
        options,
      });
      history.length = 0;
      history.push(...result.history);
    } catch {
      // 错误已通过 loop-error 事件打印，继续下一轮对话
    }
  }
  rl.close();
}

function printEvent(e: LoopEvent): void {
  switch (e.type) {
    case 'tool-started':
      console.log(`  🔧 调用工具 ${e.call.name} ${JSON.stringify(e.call.arguments)}`);
      break;
    case 'tool-result':
      console.log(
        e.result.ok
          ? `  ✅ ${e.call.name} → ${truncate(e.result.output, 200)}`
          : `  ❌ ${e.call.name} → ${e.result.error ?? '失败'}: ${truncate(e.result.output, 200)}`,
      );
      break;
    case 'assistant-message':
      if (e.content) console.log(`\n助手> ${e.content}`);
      break;
    case 'loop-done':
      console.log(`  （本轮结束，共 ${e.iterations} 次迭代）\n`);
      break;
    case 'loop-error':
      console.error(`  💥 ${e.error}\n`);
      break;
    default:
      break; // message-chunk / approval-required 在 CLI 里由其他输出覆盖
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? one.slice(0, n) + '…' : one;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
