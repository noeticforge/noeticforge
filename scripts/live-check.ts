import { readFileSync, existsSync } from 'node:fs';
import { createProvider } from '../src/providers/provider.js';
import type { ChatMessage } from '../src/types.js';

/**
 * 真实模型链路自检（需要 API Key，CI 不跑）：
 *   1. 非流式对话完成
 *   2. 流式对话：增量 ≥ 2 段且拼接完整
 *   3. （--tools）带工具定义发起请求，验证 tool_calls 解析
 *
 * 用法：npm run live:check [-- --tools]   配置读 config.json（或 argv[2] 指定路径）
 */

function check(ok: boolean, label: string): void {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  const wantTools = process.argv.includes('--tools');
  const cfgPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'config.json';
  if (!existsSync(cfgPath)) {
    console.error(`未找到 ${cfgPath}。请复制 config.example.json 为 config.json 并填入 API Key。`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  const provider = createProvider(cfg);
  console.log(`live-check：provider=${provider.id} model=${cfg.model ?? '(默认)'}`);

  // 1. 非流式
  const plain: ChatMessage[] = [{ role: 'user', content: '只回答两个字：好的' }];
  const r1 = await provider.chat(plain, []);
  check(r1.content.trim().length > 0, `非流式对话完成（finishReason=${r1.finishReason}，内容="${r1.content.slice(0, 30)}"）`);

  // 2. 流式：收集增量
  const deltas: string[] = [];
  const r2 = await provider.chat(
    [{ role: 'user', content: '从 1 数到 5，用顿号分隔，不要其他内容' }],
    [],
    { onChunk: (d) => deltas.push(d) },
  );
  const joined = deltas.join('');
  check(deltas.length >= 2, `流式到达 ${deltas.length} 个增量（≥2）`);
  check(joined === r2.content, '流式增量拼接 == 最终内容');

  // 3. 工具调用解析
  if (wantTools) {
    const r3 = await provider.chat(
      [{ role: 'user', content: '请调用 read-file.read 工具读取 path 为 README.md 的文件。必须调用工具。' }],
      [{
        name: 'read-file.read',
        description: '读取本地文本文件内容',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] },
      }],
    );
    check(r3.toolCalls.length > 0, `tool_calls 解析成功（${r3.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(', ')}）`);
    check(
      r3.toolCalls.length === 0 || typeof r3.toolCalls[0].arguments.path === 'string',
      '工具参数 arguments 为对象且 path 是字符串',
    );
  } else {
    console.log('ℹ️  跳过工具调用检查（加 --tools 启用）');
  }

  console.log('\nlive-check 全部通过 🎉');
}

main().catch((err) => {
  console.error('live-check 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
