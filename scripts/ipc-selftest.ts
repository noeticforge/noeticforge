import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentService, type PushChannel } from '../src/electron/agent-service.js';
import { MockProvider } from '../src/providers/mock.js';

/**
 * IPC 自测：不用 Electron、不用网络、不用 API Key。
 * 直接驱动 AgentService（Electron main 只是它的薄转发层），
 * 按 IPC_EVENT_PROTOCOL.md 验证 15 个事件通道的完整行为。
 */

interface Collected {
  channel: PushChannel;
  payload: any;
}

function check(ok: boolean, label: string): void {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    console.error('IPC 自测失败');
    process.exit(1);
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000, label = '条件'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  // 隔离环境：临时 appDir + 复制一份插件目录，测试不污染真实 config.json / plugins/
  const appDir = await mkdtemp(path.join(tmpdir(), 'agent-base-ipc-'));
  await cp(path.join(projectRoot, 'plugins'), path.join(appDir, 'plugins'), { recursive: true });

  const events: Collected[] = [];
  const push = (channel: PushChannel, payload: unknown) => events.push({ channel, payload });

  // ---------- 1. 未配置 Provider ----------
  const bare = new AgentService({ appDir, pushEvent: push });
  await bare.init();
  const r1 = bare.sendMessage({ message: { role: 'user', content: 'hi' } });
  check(r1.ok === false && r1.error.code === 'E_PROVIDER_NOT_CONFIGURED', '未配置 Provider → E_PROVIDER_NOT_CONFIGURED');
  const r1b = await bare.setModelConfig({ config: { provider: 'moonshot' as any, apiKey: 'x' } });
  check(r1b.ok === false && r1b.error.code === 'E_PROVIDER_UNSUPPORTED', '非法 provider → E_PROVIDER_UNSUPPORTED');

  // ---------- 2. 完整会话：流式 + 读文件 + 审批批准（参数覆盖）+ 拒绝（带原因） ----------
  const mock = new MockProvider([
    { content: '', toolCalls: [{ id: 'tc_1', name: 'read-file.read', arguments: { path: path.join(projectRoot, 'README.md') } }], finishReason: 'tool_calls' },
    { content: '', toolCalls: [{ id: 'tc_2', name: 'write-file.write', arguments: { path: 'approved.txt', content: '原始内容' } }], finishReason: 'tool_calls' },
    { content: '', toolCalls: [{ id: 'tc_3', name: 'write-file.write', arguments: { path: 'forbidden.txt', content: 'x' } }], finishReason: 'tool_calls' },
    { content: '任务完成，这是最终回答。', toolCalls: [], finishReason: 'stop' },
  ]);
  const service = new AgentService({ appDir, pushEvent: push, initialProvider: mock });
  await service.init();
  check(events.some((e) => e.channel === 'plugins-changed' && e.payload.plugins.length === 2), 'init 推送 plugins-changed（2 个内置插件）');

  // 非法消息
  const bad = service.sendMessage({ message: { role: 'assistant', content: 'x' } as any });
  check(bad.ok === false && bad.error.code === 'E_INVALID_MESSAGE', '非 user 消息 → E_INVALID_MESSAGE');

  // 发送合法消息
  const send = service.sendMessage({ message: { role: 'user', content: '读 README 并写文件' } });
  check(send.ok === true, 'send-message 返回 ok');
  const messageId = (send as { ok: true; data: { messageId: string } }).data.messageId;

  // 等第一个工具执行（read-file 免审批）
  await waitFor(() => events.some((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'tc_1'), 5000, 'tc_1 完成');
  const readResult = events.find((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'tc_1')!;
  check(readResult.payload.result.ok === true && readResult.payload.result.output.includes('agent-base'), 'read-file 真实执行，README 内容回喂');

  // 等审批请求（write-file）→ 批准并覆盖参数
  await waitFor(() => events.some((e) => e.channel === 'approval-required' && e.payload.toolCallId === 'tc_2'), 5000, 'tc_2 审批请求');
  check(
    events.some((e) => e.channel === 'tool-started' && e.payload.toolCallId === 'tc_2' && e.payload.name === 'write-file.write'),
    '审批前已推送 tool-started（尚未执行）',
  );
  const noEarlyWrite = !existsSync(path.join(appDir, 'approved.txt'));
  check(noEarlyWrite, '审批前文件未被写入');

  const approval = events.find((e) => e.channel === 'approval-required' && e.payload.toolCallId === 'tc_2')!;
  check(approval.payload.messageId === messageId && approval.payload.reason, 'approval-required 携带 messageId 与 reason');
  const dup = service.approveTool({ messageId, toolCallId: 'tc_2' });
  // 先重复批准一次（此刻应仍是 pending，因为 approve 是同步 resolve…实际 pending 已在第一次批准时删除）
  check(dup.ok === true, '第一次批准成功');
  const ap2 = service.approveTool({ messageId, toolCallId: 'tc_2' });
  check(ap2.ok === false && ap2.error.code === 'E_NO_PENDING_APPROVAL', '重复批准 → E_NO_PENDING_APPROVAL');

  await waitFor(() => events.some((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'tc_2'), 5000, 'tc_2 完成');
  check(existsSync(path.join(appDir, 'approved.txt')), '批准后文件被写入');

  // 第二个审批 → 拒绝（带原因）
  await waitFor(() => events.some((e) => e.channel === 'approval-required' && e.payload.toolCallId === 'tc_3'), 5000, 'tc_3 审批请求');
  const rj = service.rejectTool({ messageId, toolCallId: 'tc_3', reason: '路径敏感' });
  check(rj.ok === true, '拒绝成功');
  await waitFor(() => events.some((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'tc_3'), 5000, 'tc_3 结果');
  const rejected = events.find((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'tc_3')!;
  check(
    rejected.payload.result.error === 'rejected-by-user' && rejected.payload.result.output.includes('路径敏感'),
    '拒绝结果固定 error=rejected-by-user 且带原因回喂',
  );
  check(!existsSync(path.join(appDir, 'forbidden.txt')), '被拒绝的文件未被写入');

  // 等循环收尾
  await waitFor(() => events.some((e) => e.channel === 'loop-done'), 5000, 'loop-done');
  const done = events.find((e) => e.channel === 'loop-done')!;
  check(done.payload.messageId === messageId && done.payload.stopped === false && done.payload.content === '任务完成，这是最终回答。', 'loop-done 携带最终回答且 stopped=false');

  // 流式 chunk：最终回答被切成多个 delta
  const chunks = events.filter((e) => e.channel === 'message-chunk');
  check(chunks.length >= 2 && chunks.every((c) => c.payload.messageId === messageId && c.payload.role === 'assistant'), `message-chunk 流式到达（${chunks.length} 段，全部携带 messageId）`);
  const assembled = chunks.map((c) => c.payload.delta).join('');
  check(assembled === '任务完成，这是最终回答。', 'chunk 拼接后等于完整回答');

  // ---------- 3. stop：审批挂起时中断 ----------
  const mock2 = new MockProvider([
    { content: '', toolCalls: [{ id: 'tc_9', name: 'write-file.write', arguments: { path: 'stopped.txt', content: 'x' } }], finishReason: 'tool_calls' },
    { content: '不会到达', toolCalls: [], finishReason: 'stop' },
  ]);
  const service2 = new AgentService({ appDir, pushEvent: push, initialProvider: mock2 });
  await service2.init();
  const send2 = service2.sendMessage({ message: { role: 'user', content: '再写一个' } });
  const mid2 = (send2 as { ok: true; data: { messageId: string } }).data.messageId;
  await waitFor(() => events.some((e) => e.channel === 'approval-required' && e.payload.messageId === mid2), 5000, 'mid2 审批');
  const busy = service2.sendMessage({ message: { role: 'user', content: 'busy?' } });
  check(busy.ok === false && busy.error.code === 'E_LOOP_BUSY', '循环进行中 → E_LOOP_BUSY');
  service2.stop();
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.messageId === mid2), 5000, 'mid2 loop-done');
  const stopped = events.find((e) => e.channel === 'loop-done' && e.payload.messageId === mid2)!;
  check(stopped.payload.stopped === true, 'stop() → loop-done(stopped=true)');
  check(!existsSync(path.join(appDir, 'stopped.txt')), 'stop 时挂起的审批未执行');
  const stopIdle = service2.stop();
  check(stopIdle.ok === true, 'stop 幂等（空闲时调用也返回 ok）');

  // ---------- 4. 插件热装卸 ----------
  const list = service.listPlugins();
  check(list.ok === true && list.ok && list.data.plugins.length === 2, 'list-plugins 返回 2 个插件');

  // 造一个临时插件（echo 工具，无权限要求）
  const tmpPluginDir = path.join(appDir, 'incoming-echo');
  await mkdir(tmpPluginDir, { recursive: true });
  await writeFile(path.join(tmpPluginDir, 'manifest.json'), JSON.stringify({
    name: 'tmp-echo', version: '0.1.0', displayName: '临时回声', description: '测试用', permissions: [], entry: 'index.js',
  }));
  await writeFile(path.join(tmpPluginDir, 'index.js'), `export const plugin = { tools: [{
    name: 'tmp-echo.echo', description: '原样返回文本', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    permissions: [], async execute(args) { return { ok: true, output: String(args.text) }; },
  }] };\n`);

  const beforeInstall = events.filter((e) => e.channel === 'plugins-changed').length;
  const inst = await service.installPlugin({ pluginDir: tmpPluginDir });
  check(inst.ok === true && inst.ok && inst.data.plugin.name === 'tmp-echo', 'install-plugin 安装成功');
  await waitFor(() => events.filter((e) => e.channel === 'plugins-changed').length > beforeInstall, 3000, 'plugins-changed');
  check(existsSync(path.join(appDir, 'plugins', 'user', 'tmp-echo', 'index.js')), '插件被复制到 plugins/user/');
  const list2 = service.listPlugins();
  check(list2.ok === true && list2.ok && list2.data.plugins.some((p) => p.name === 'tmp-echo'), '安装后 list-plugins 可见');

  const badPath = await service.installPlugin({ pluginDir: path.join(appDir, 'no-such-dir') });
  check(badPath.ok === false && badPath.error.code === 'E_PATH_NOT_FOUND', '安装不存在的目录 → E_PATH_NOT_FOUND');

  const un = await service.uninstallPlugin({ name: 'tmp-echo' });
  check(un.ok === true, 'uninstall-plugin 卸载成功');
  check(!existsSync(path.join(appDir, 'plugins', 'user', 'tmp-echo')), '卸载后插件目录被删除');
  const unMissing = await service.uninstallPlugin({ name: 'tmp-echo' });
  check(unMissing.ok === false && unMissing.error.code === 'E_PLUGIN_NOT_FOUND', '卸载不存在插件 → E_PLUGIN_NOT_FOUND');

  // ---------- 5. set-model-config 持久化 ----------
  const cfg = await service.setModelConfig({ config: { provider: 'deepseek', apiKey: 'sk-test-only', model: 'deepseek-chat' } });
  check(cfg.ok === true, 'set-model-config 成功');
  const persisted = JSON.parse(await readFile(path.join(appDir, 'config.json'), 'utf-8'));
  check(persisted.provider === 'deepseek' && persisted.apiKey === 'sk-test-only', '配置持久化到 config.json（隔离目录）');
  const noKey = await service.setModelConfig({ config: { provider: 'openai' } });
  check(noKey.ok === false && noKey.error.code === 'E_INVALID_CONFIG', '缺少 apiKey → E_INVALID_CONFIG');

  await rm(appDir, { recursive: true, force: true });
  console.log('\nIPC 自测全部通过 🎉');
}

main().catch((e) => {
  console.error('IPC 自测异常:', e);
  process.exit(1);
});
