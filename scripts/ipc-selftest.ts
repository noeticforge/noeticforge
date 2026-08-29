import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentService, type PushChannel, type IpcResult } from '../src/electron/agent-service.js';
import { MockProvider } from '../src/providers/mock.js';

/**
 * IPC 自测：不用 Electron、不用网络、不用 API Key。
 * 直接驱动 AgentService（Electron main 只是它的薄转发层），
 * 按 IPC_EVENT_PROTOCOL.md 验证全部事件通道的完整行为。
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

/** 断言 ok 并取出 data（自测里意外失败即终止） */
function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) {
    console.error(`❌ 意外失败: ${r.error.code} ${r.error.message}`);
    process.exit(1);
  }
  return r.data;
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

  // ---------- 6. Provider 注册表（v0.2） ----------
  const provs = service.listProviders();
  check(
    provs.ok && ['openai-compatible', 'deepseek', 'openai', 'anthropic'].every((id) => provs.data.providers.some((p) => p.id === id)),
    'list-providers 返回 4 个内置 provider（含通用 openai-compatible）',
  );
  const noBase = await service.setModelConfig({ config: { provider: 'openai-compatible', apiKey: 'x' } });
  check(noBase.ok === false && noBase.error.code === 'E_INVALID_CONFIG', 'openai-compatible 缺 baseUrl → E_INVALID_CONFIG');
  const withBase = await service.setModelConfig({ config: { provider: 'openai-compatible', apiKey: 'x', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } });
  check(withBase.ok === true, 'openai-compatible 带 baseUrl 配置成功（Ollama 等即插）');

  // ---------- 7. 多会话 CRUD / 隔离 / 内置插件保护（v0.2） ----------
  const sess0 = unwrap(service.listSessions());
  check(sess0.sessions.length === 1 && sess0.sessions[0].messageCount === 8, 'init 自动建默认会话且已含 8 条消息（首轮对话落盘）');
  const created = unwrap(await service.createSession({ title: '测试会话B' }));
  check(created.session.messages.length === 0, 'create-session 建空会话');
  const sidB = created.session.id;
  const sw = unwrap(await service.switchSession({ id: sess0.sessions[0].id }));
  check(sw.session.messages.length === 8, 'switch-session 返回完整历史（会话隔离，B 为空、A 为 8 条）');
  const rn = await service.renameSession({ id: sidB, title: '改名后的B' });
  check(rn.ok, 'rename-session 成功');
  const renamed = unwrap(service.listSessions());
  check(renamed.sessions.some((s) => s.id === sidB && s.title === '改名后的B'), '改名在列表中生效');
  // 删除活跃会话 → 自动回落到剩余会话
  const del = await service.deleteSession({ id: sidB });
  check(del.ok, 'delete-session 成功');
  const afterDel = unwrap(service.listSessions());
  check(afterDel.sessions.length === 1, '删除后只剩原会话');

  const builtinGuard = await service.uninstallPlugin({ name: 'read-file' });
  check(builtinGuard.ok === false && builtinGuard.error.code === 'E_PLUGIN_BUILTIN', '卸载内置插件 → E_PLUGIN_BUILTIN');
  check(existsSync(path.join(projectRoot, 'plugins', 'builtin', 'read-file')), '内置插件目录未被删除');

  // ---------- 8. 会话进行中禁止删除（E_SESSION_IN_USE） ----------
  const mock3 = new MockProvider([
    { content: '', toolCalls: [{ id: 'tc_8', name: 'write-file.write', arguments: { path: 'never.txt', content: 'x' } }], finishReason: 'tool_calls' },
  ]);
  const service3 = new AgentService({ appDir, pushEvent: push, initialProvider: mock3 });
  await service3.init();
  const send3 = service3.sendMessage({ message: { role: 'user', content: 'x' } });
  const mid3 = (send3 as { ok: true; data: { messageId: string } }).data.messageId;
  await waitFor(() => events.some((e) => e.channel === 'approval-required' && e.payload.messageId === mid3), 5000, 'mid3 审批');
  const active3 = unwrap(service3.listSessions()).sessions[0].id;
  const delBusy = await service3.deleteSession({ id: active3 });
  check(delBusy.ok === false && delBusy.error.code === 'E_SESSION_IN_USE', '会话循环进行中删除 → E_SESSION_IN_USE');
  service3.stop();
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.messageId === mid3), 5000, 'mid3 loop-done');

  // ---------- 9. MCP 桥接（v0.3）：mock stdio server 全链路 ----------
  await writeFile(path.join(appDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      mock: {
        command: process.execPath,
        args: [path.join(projectRoot, 'dist', 'scripts', 'mock-mcp-server.js')],
        approval: 'never',
      },
    },
  }));
  const mock4 = new MockProvider([
    { content: '', toolCalls: [{ id: 'mcp1', name: 'mcp.mock.echo', arguments: { text: 'hi' } }], finishReason: 'tool_calls' },
    { content: 'mcp 完成', toolCalls: [], finishReason: 'stop' },
  ]);
  const service4 = new AgentService({ appDir, pushEvent: push, initialProvider: mock4 });
  await service4.init();
  await waitFor(
    () => events.some((e) => e.channel === 'mcp-status-changed' && JSON.stringify(e.payload).includes('"connected"')),
    10000,
    'mock MCP 连接成功',
  );
  const mcpList = unwrap(service4.listPlugins());
  check(
    mcpList.plugins.some((p) => p.name === 'mcp-mock' && p.tools.includes('mcp.mock.echo')),
    'MCP server 工具桥接进注册表（mcp.mock.echo）',
  );
  const send4 = service4.sendMessage({ message: { role: 'user', content: '调 echo' } });
  const mid4 = (send4 as { ok: true; data: { messageId: string } }).data.messageId;
  await waitFor(() => events.some((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'mcp1'), 8000, 'mcp1 结果');
  const mcpResult = events.find((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'mcp1')!;
  check(mcpResult.payload.result.ok === true && mcpResult.payload.result.output.includes('echo: hi'), 'MCP 工具经 stdio 子进程真实执行');
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.messageId === mid4), 8000, 'mid4 loop-done');

  const off = await service4.toggleMcpServer({ name: 'mock', enabled: false });
  check(off.ok === true, 'toggle-mcp-server(false) 成功');
  const mcpOff = unwrap(service4.listPlugins());
  check(!mcpOff.plugins.some((p) => p.name === 'mcp-mock'), '禁用后 MCP 工具从注册表移除');
  const badCfg = await service4.setMcpConfig({ config: { broken: {} as any } });
  check(badCfg.ok === false && badCfg.error.code === 'E_INVALID_CONFIG', '缺 command/url 的 MCP 配置 → E_INVALID_CONFIG');
  const unknownToggle = await service4.toggleMcpServer({ name: 'nope', enabled: true });
  check(unknownToggle.ok === false && unknownToggle.error.code === 'E_MCP_NOT_FOUND', 'toggle 不存在的 MCP server → E_MCP_NOT_FOUND');
  await service4.shutdown();

  // ---------- 10. 策略与应用信息（v0.3）：权限模式 / 审计 / 免 Key 切模型 ----------
  const audit = await service.readAudit({ lines: 50 });
  check(
    audit.ok && (audit.data?.lines.length ?? 0) > 0 && audit.data!.lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
    'read-audit 返回 JSONL 审计记录（此前的工具调用与审批已落盘）',
  );
  const info0 = unwrap(service.getAppInfo()).info;
  check(
    info0.pluginCount >= 2 && info0.sessionCount >= 1 && info0.permissionMode === 'full' && info0.provider === 'openai-compatible',
    'get-app-info 基础字段正确（provider 为第 6 节配置的 openai-compatible）',
  );

  const setPlan = await service.setAgentPolicy({ permissionMode: 'plan' });
  check(setPlan.ok === true, 'set-agent-policy(plan) 成功');
  check(unwrap(service.getAppInfo()).info.permissionMode === 'plan', '权限模式在运行态生效');
  const mock5 = new MockProvider([
    { content: '', toolCalls: [{ id: 'pol1', name: 'write-file.write', arguments: { path: 'plan-blocked.txt', content: 'x' } }], finishReason: 'tool_calls' },
    { content: 'done', toolCalls: [], finishReason: 'stop' },
  ]);
  const service5 = new AgentService({ appDir, pushEvent: push, initialProvider: mock5 });
  await service5.init(); // 从 config.json 读到 plan 模式
  const send5 = service5.sendMessage({ message: { role: 'user', content: 'x' } });
  check(send5.ok === true, '计划模式下发送消息正常');
  await waitFor(() => events.some((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'pol1'), 5000, 'pol1 结果');
  const polRes = events.find((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'pol1')!;
  check(polRes.payload.result.error === 'permission-denied', '计划模式：写工具被运行时策略拒绝（permission-denied）');
  check(!existsSync(path.join(appDir, 'plan-blocked.txt')), '计划模式：文件确实未被写入');
  await service5.shutdown();

  const backFull = await service.setAgentPolicy({ permissionMode: 'full' });
  check(backFull.ok === true, '恢复 full 模式');

  const reKey = await service.setModelConfig({ config: { provider: 'deepseek', apiKey: 'sk-test-only', model: 'deepseek-chat' } });
  check(reKey.ok === true, '重新配置 deepseek + apiKey');
  const rekey = await service.setModelConfig({ config: { provider: 'deepseek', model: 'deepseek-chat' } });
  check(rekey.ok === true, '同 provider 切模型不重填 apiKey → 复用已存 Key');
  const crossNoKey = await service.setModelConfig({ config: { provider: 'anthropic' } });
  check(crossNoKey.ok === false && crossNoKey.error.code === 'E_INVALID_CONFIG', '跨 provider 且无 Key → E_INVALID_CONFIG');

  await rm(appDir, { recursive: true, force: true });
  console.log('\nIPC 自测全部通过 🎉');
}

main().catch((e) => {
  console.error('IPC 自测异常:', e);
  process.exit(1);
});
