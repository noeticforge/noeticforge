import { readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MockProvider } from '../src/providers/mock.js';
import { ToolRegistry } from '../src/core/registry.js';
import { runLoop } from '../src/core/loop.js';
import { loadPluginsFromRoot } from '../src/plugins/loader.js';
import type { ChatMessage, LoopEvent, LoopOptions } from '../src/types.js';

/**
 * 冒烟测试：不需要网络和 API Key。
 * 用 MockProvider 脚本化模型行为，验证完整链路：
 * 插件加载 → 循环 → 工具调用 → 审批（批准 + 拒绝两条路径）→ 结果回喂 → 正常收尾。
 */
const OUTPUT_FILE = 'smoke-test-output.txt';

function check(ok: boolean, label: string): void {
  const mark = ok ? '✅' : '❌';
  console.log(`${mark} ${label}`);
  if (!ok) {
    console.error('冒烟测试失败');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // 1. 插件加载
  const registry = new ToolRegistry();
  const report = await loadPluginsFromRoot(path.resolve('plugins'), registry);
  check(report.loaded.length === 4 && ['read-file','write-file','shell-exec','web-fetch'].every((n) => report.loaded.includes(n)), '4 个内置插件全部加载成功');
  check(report.failed.length === 0, `无插件加载失败${report.failed.length ? `: ${JSON.stringify(report.failed)}` : ''}`);
  check(registry.definitions().length === 4, '工具注册表登记了 4 个工具');

  // 2. 脚本化模型：读 README → 写文件(批准) → 写文件(拒绝) → 收尾
  const mock = new MockProvider([
    {
      content: '',
      toolCalls: [{ id: 'call_1', name: 'read-file.read', arguments: { path: 'README.md' } }],
      finishReason: 'tool_calls',
    },
    {
      content: '',
      toolCalls: [{ id: 'call_2', name: 'write-file.write', arguments: { path: OUTPUT_FILE, content: 'hello-agent' } }],
      finishReason: 'tool_calls',
    },
    {
      content: '',
      toolCalls: [{ id: 'call_3', name: 'write-file.write', arguments: { path: 'forbidden.txt', content: 'x' } }],
      finishReason: 'tool_calls',
    },
    { content: '任务完成。', toolCalls: [], finishReason: 'stop' },
  ]);

  const events: LoopEvent[] = [];
  const approvals: ('approved' | 'rejected')[] = ['approved', 'rejected'];
  const options: LoopOptions = {
    maxIterations: 10,
    onEvent: (e) => events.push(e),
    requestApproval: async () => approvals.shift() ?? 'rejected',
  };

  const history: ChatMessage[] = [];
  const result = await runLoop({
    provider: mock,
    registry,
    systemPrompt: 'smoke-test',
    userMessage: '读取 README 并写一个测试文件',
    history,
    options,
  });

  // 3. 断言
  check(result.content === '任务完成。', '循环正常收尾并返回最终回答');
  check(result.iterations === 4, `迭代次数正确（实际 ${result.iterations}，期望 4）`);

  const readResult = events.find((e) => e.type === 'tool-result' && e.call.id === 'call_1');
  check(!!readResult && readResult.type === 'tool-result' && readResult.result.ok, 'read-file 工具真实执行成功');
  check(!!readResult && readResult.type === 'tool-result' && readResult.result.output.includes('agent-base'), '读取到 README 真实内容');

  check(
    events.some((e) => e.type === 'approval-required' && e.call.id === 'call_2'),
    '写文件前触发了 approval-required 事件',
  );
  check(existsSync(OUTPUT_FILE) && readFileSync(OUTPUT_FILE, 'utf-8') === 'hello-agent', '批准路径：文件被真实写入');

  const rejected = events.find((e) => e.type === 'tool-result' && e.call.id === 'call_3');
  check(
    !!rejected && rejected.type === 'tool-result' && rejected.result.error === 'rejected-by-user',
    '拒绝路径：未执行，错误喂回模型',
  );
  check(!existsSync('forbidden.txt'), '拒绝路径：文件确实没有被写入');

  check(
    events.some((e) => e.type === 'loop-done'),
    'loop-done 事件正常发出',
  );

  // 工具结果确实进入了消息历史（会回喂给模型）
  const toolMsgs = result.history.filter((m) => m.role === 'tool');
  check(toolMsgs.length === 3, `3 条 tool 消息进入历史（实际 ${toolMsgs.length}）`);

  rmSync(OUTPUT_FILE, { force: true });

  // ---- 场景组 2：安全修复的四个新场景 ----

  // 场景 A：模型生成的参数不合法 → invalid-arguments，不执行
  {
    const events2: LoopEvent[] = [];
    await runLoop({
      provider: new MockProvider([
        {
          content: '',
          toolCalls: [{ id: 'ia_1', name: 'read-file.read', arguments: { wrong: 1 } }],
          finishReason: 'tool_calls',
        },
        { content: 'done', toolCalls: [], finishReason: 'stop' },
      ]),
      registry,
      systemPrompt: 'smoke-test',
      userMessage: '非法参数场景',
      history: [],
      options: { maxIterations: 5, onEvent: (e) => events2.push(e) },
    });
    const r = events2.find((e) => e.type === 'tool-result' && e.call.id === 'ia_1');
    check(
      !!r && r.type === 'tool-result' && r.result.error === 'invalid-arguments',
      '场景A：非法参数被 Schema 校验拦截（invalid-arguments），错误喂回模型',
    );
  }

  // 场景 B：运行时权限白名单拒绝 → permission-denied，且不触发 tool-started
  {
    const events2: LoopEvent[] = [];
    await runLoop({
      provider: new MockProvider([
        {
          content: '',
          toolCalls: [{ id: 'pd_1', name: 'write-file.write', arguments: { path: 'denied.txt', content: 'x' } }],
          finishReason: 'tool_calls',
        },
        { content: 'done', toolCalls: [], finishReason: 'stop' },
      ]),
      registry,
      systemPrompt: 'smoke-test',
      userMessage: '权限拒绝场景',
      history: [],
      options: {
        maxIterations: 5,
        onEvent: (e) => events2.push(e),
        allowedPermissions: ['fs:read'], // 只放行读，写被策略拒绝
      },
    });
    const r = events2.find((e) => e.type === 'tool-result' && e.call.id === 'pd_1');
    check(
      !!r && r.type === 'tool-result' && r.result.error === 'permission-denied',
      '场景B：权限不在白名单 → permission-denied，错误喂回模型',
    );
    check(
      !events2.some((e) => e.type === 'tool-started' && e.call.id === 'pd_1'),
      '场景B：权限被拒时连 tool-started 都不触发（校验先于执行）',
    );
    check(!existsSync('denied.txt'), '场景B：文件确实没有被写入');
  }

  // 场景 C：强制审批列表覆盖插件声明（read-file 本不需要审批，被强制后拒绝）
  {
    const events2: LoopEvent[] = [];
    await runLoop({
      provider: new MockProvider([
        {
          content: '',
          toolCalls: [{ id: 'fa_1', name: 'read-file.read', arguments: { path: 'README.md' } }],
          finishReason: 'tool_calls',
        },
        { content: 'done', toolCalls: [], finishReason: 'stop' },
      ]),
      registry,
      systemPrompt: 'smoke-test',
      userMessage: '强制审批场景',
      history: [],
      options: {
        maxIterations: 5,
        onEvent: (e) => events2.push(e),
        forceApprovalPermissions: ['fs:read'], // 强制所有读操作也需审批
        requestApproval: async () => 'rejected',
      },
    });
    const r = events2.find((e) => e.type === 'tool-result' && e.call.id === 'fa_1');
    check(
      !!r && r.type === 'tool-result' && r.result.error === 'rejected-by-user',
      '场景C：forceApprovalPermissions 覆盖插件声明，未批准即拒绝',
    );
    check(
      events2.some((e) => e.type === 'approval-required' && e.call.id === 'fa_1'),
      '场景C：被强制的读操作也发出了 approval-required',
    );
  }

  // 场景 D：审批时用户修改参数 → 修改后的参数生效（且过了 Schema 校验）
  {
    const events2: LoopEvent[] = [];
    const MODIFIED = 'smoke-test-modified.txt';
    await runLoop({
      provider: new MockProvider([
        {
          content: '',
          toolCalls: [{ id: 'ma_1', name: 'write-file.write', arguments: { path: MODIFIED, content: 'original' } }],
          finishReason: 'tool_calls',
        },
        { content: 'done', toolCalls: [], finishReason: 'stop' },
      ]),
      registry,
      systemPrompt: 'smoke-test',
      userMessage: '改参审批场景',
      history: [],
      options: {
        maxIterations: 5,
        onEvent: (e) => events2.push(e),
        requestApproval: async () => ({
          decision: 'approved' as const,
          arguments: { path: MODIFIED, content: 'modified-args' },
        }),
      },
    });
    check(
      existsSync(MODIFIED) && readFileSync(MODIFIED, 'utf-8') === 'modified-args',
      '场景D：审批时修改的参数真实生效（写入的是 modified-args）',
    );
    rmSync(MODIFIED, { force: true });
  }

  console.log('\n冒烟测试全部通过 🎉');
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
