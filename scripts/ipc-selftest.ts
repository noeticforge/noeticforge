import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentService, type PushChannel, type IpcResult } from '../src/electron/agent-service.js';
import { MockProvider } from '../src/providers/mock.js';
import type { LLMProvider } from '../src/types.js';

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
  const BUILTIN_TOTAL = 7; // 6 内置 + core-subagent
  check(events.some((e) => e.channel === 'plugins-changed' && e.payload.plugins.length === BUILTIN_TOTAL), `init 推送 plugins-changed（${BUILTIN_TOTAL - 1} 内置 + core-subagent）`);

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
  check(busy.ok === true && (busy.data as { queued?: boolean }).queued === true, '循环进行中发送 → 自动排队（queued:true）');
  service2.stop();
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.messageId === mid2), 5000, 'mid2 loop-done');
  const stopped = events.find((e) => e.channel === 'loop-done' && e.payload.messageId === mid2)!;
  check(stopped.payload.stopped === true, 'stop() → loop-done(stopped=true)');
  check(!existsSync(path.join(appDir, 'stopped.txt')), 'stop 时挂起的审批未执行');
  const stopIdle = service2.stop();
  check(stopIdle.ok === true, 'stop 幂等（空闲时调用也返回 ok）');

  // ---------- 4. 插件热装卸 ----------
  const list = service.listPlugins();
  check(list.ok === true && list.ok && list.data.plugins.length === BUILTIN_TOTAL, `list-plugins 返回 ${BUILTIN_TOTAL} 个插件（含 core-subagent 与 kb）`);

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
    'list-providers 返回 5 个内置 provider（含通用 openai-compatible / anthropic-compatible）',
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

  // ---------- 9.5 回归（CODE_REVIEW F2）：初始 enabled:false 的 server 运行中启用可真正连接 ----------
  const service4b = new AgentService({ appDir, pushEvent: push, initialProvider: new MockProvider([]) });
  await service4b.init(); // 上一步 toggle(false) 已把 enabled:false 落盘 → 此处应出现 disabled 占位
  const mcpInit = unwrap(await service4b.listMcpServers());
  check(
    mcpInit.servers.find((s) => s.name === 'mock')?.state === 'disabled',
    'F2 前置：mcp.json 初始禁用的 server 在启动后为 disabled 占位',
  );
  const marker = events.length;
  const on = await service4b.toggleMcpServer({ name: 'mock', enabled: true });
  check(on.ok === true, 'F2: 启用初始 disabled 的 MCP server 受理成功');
  await waitFor(
    () => events.slice(marker).some((e) => e.channel === 'mcp-status-changed' && JSON.stringify(e.payload).includes('"connected"')),
    10000,
    'F2: 启用后真实连接（旧实现会卡在 disabled 永不连接）',
  );
  const mcpOn = unwrap(await service4b.listMcpServers());
  check(
    mcpOn.servers.find((s) => s.name === 'mock')?.state === 'connected' &&
      (mcpOn.servers.find((s) => s.name === 'mock')?.toolCount ?? 0) > 0,
    'F2: 启用后状态 connected 且工具已桥接',
  );
  await service4b.shutdown();

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

  // ---------- 11. AGENTS.md 分层 / 消息排队续发 / 上下文压缩 / shell-exec 插件（v0.3） ----------
  await writeFile(path.join(appDir, 'AGENTS.md'), 'AGENTS 测试标记：始终用中文回答。');

  class CapturingProvider {
    readonly id = 'mock';
    calls = 0;
    lastSystem: string | null = null;
    lastFirstUser: string | null = null;
    firstUsers: (string | null)[] = [];
    private mock: MockProvider;
    constructor(responses: ConstructorParameters<typeof MockProvider>[0]) { this.mock = new MockProvider(responses); }
    async chat(messages: any[], tools: any, options: any) {
      this.calls += 1;
      this.lastSystem = messages[0]?.content ?? null;
      this.lastFirstUser = messages.find((m: any) => m.role === 'user')?.content ?? null;
      this.firstUsers.push(this.lastFirstUser);
      return this.mock.chat(messages, tools, options);
    }
  }
  const cap = new CapturingProvider([
    { content: 'first-ok', toolCalls: [], finishReason: 'stop' },
    { content: 'second-ok', toolCalls: [], finishReason: 'stop' },
    { content: '摘要：用户曾发送超长消息。', toolCalls: [], finishReason: 'stop' },
    { content: 'third-ok', toolCalls: [], finishReason: 'stop' },
    { content: 'fourth-ok', toolCalls: [], finishReason: 'stop' },
  ]);
  const service6 = new AgentService({ appDir, pushEvent: push, initialProvider: cap as unknown as LLMProvider, contextTokenBudget: 3000, maxIterations: 5 });
  await service6.init();
  const sid6 = unwrap(await service6.createSession({ title: '压缩测试' })).session.id; // 干净会话，避免复用前面章节的历史
  const s6a = service6.sendMessage({ message: { role: 'user', content: 'A'.repeat(20_000) } });
  check(s6a.ok === true, '首条（超长）消息正常受理');
  const s6b = service6.sendMessage({ message: { role: 'user', content: '第二条消息' } });
  check(s6b.ok === true && (s6b.data as { queued?: boolean }).queued === true, '循环进行中发送第二条 → 排队');
  await waitFor(
    () => events.filter((e) => e.channel === 'loop-done' && e.payload.content === 'second-ok').length === 1,
    10_000,
    '排队第二条完成',
  );
  const s6c = service6.sendMessage({ message: { role: 'user', content: '第三条消息' } });
  check(s6c.ok === true, '第三条消息正常受理');
  await waitFor(
    () => events.some((e) => e.channel === 'loop-done' && e.payload.content === 'third-ok'),
    10_000,
    '第三条完成（含压缩轮）',
  );
  check(cap.calls === 4, `模型调用 4 次（首条/次条/压缩摘要/第三条），实际 ${cap.calls}`);
  check((cap.lastSystem ?? '').includes('AGENTS 测试标记'), '系统提示包含项目 AGENTS.md 内容');
  check((cap.lastFirstUser ?? '').startsWith('【历史摘要】'), '第三轮触发上下文压缩（首轮超预算被摘要）');
  check(
    events.filter((e) => e.channel === 'context-compacted' && e.payload.sessionId === sid6).length === 1,
    'context-compacted 恰好推送 1 次（仅增量重写时推送）',
  );
  // 第四条：无新整轮被丢弃 → 必须复用既有摘要（零摘要调用、前缀字节级稳定）
  const summaryView = cap.firstUsers[3] ?? '';
  const s6d = service6.sendMessage({ message: { role: 'user', content: '第四条消息' } });
  check(s6d.ok === true, '第四条消息正常受理');
  await waitFor(
    () => events.some((e) => e.channel === 'loop-done' && e.payload.content === 'fourth-ok'),
    10_000,
    '第四条完成（复用既有摘要）',
  );
  check(cap.calls === 5, `第四轮复用摘要：模型调用仍只 5 次（无重复摘要调用），实际 ${cap.calls}`);
  check(cap.lastFirstUser === summaryView && summaryView.startsWith('【历史摘要】'), '发给模型的前缀与上一轮逐字节一致（Prompt Cache 稳定）');
  const sess6 = unwrap(await service6.switchSession({ id: unwrap(service6.listSessions()).sessions[0].id })).session;
  check(
    sess6.messages.length === 8 && (sess6.messages[0].content as string).length === 20_000,
    '磁盘历史保持全量（压缩只影响发给模型的内容）',
  );
  const sess6Raw = JSON.parse(await readFile(path.join(appDir, 'sessions', `${sid6}.json`), 'utf-8')) as {
    meta?: { compaction?: { upTo: number; summary: string } };
  };
  check(
    sess6Raw.meta?.compaction?.upTo === 2 && !!sess6Raw.meta.compaction.summary,
    '压缩记录持久化到会话 meta（upTo=2）',
  );
  await service6.shutdown();

  // shell-exec 插件真实执行（含审批）
  const mock7 = new MockProvider([
    { content: '', toolCalls: [{ id: 'sh1', name: 'shell-exec.run', arguments: { command: 'echo hello-agent-base' } }], finishReason: 'tool_calls' },
    { content: 'shell 完成', toolCalls: [], finishReason: 'stop' },
  ]);
  const service7 = new AgentService({ appDir, pushEvent: push, initialProvider: mock7 });
  await service7.init();
  const send7 = service7.sendMessage({ message: { role: 'user', content: '跑个命令' } });
  const mid7 = (send7 as { ok: true; data: { messageId: string } }).data.messageId;
  await waitFor(() => events.some((e) => e.channel === 'approval-required' && e.payload.toolCallId === 'sh1'), 8000, 'sh1 审批');
  await service7.approveTool({ messageId: mid7, toolCallId: 'sh1' });
  await waitFor(() => events.some((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'sh1'), 15_000, 'sh1 结果');
  const shRes = events.find((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'sh1')!;
  check(shRes.payload.result.ok === true && shRes.payload.result.output.includes('hello-agent-base'), 'shell-exec 插件经批准真实执行命令');
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.messageId === mid7), 10_000, 'mid7 loop-done');
  await service7.shutdown();

  // ---------- 12. 子代理 / @ 引用 / 多模态附件 / 推理力度（v0.4） ----------
  class CapturingProvider2 {
    readonly id = 'mock';
    calls = 0;
    lastSystem: string | null = null;
    lastUserText = '';
    lastUserIsArray = false;
    lastEffort: string | undefined = undefined;
    private mock: MockProvider;
    constructor(responses: ConstructorParameters<typeof MockProvider>[0]) { this.mock = new MockProvider(responses); }
    async chat(messages: any[], tools: any, options: any) {
      this.calls += 1;
      this.lastSystem = typeof messages[0]?.content === 'string' ? messages[0].content : null;
      const u = [...messages].reverse().find((m: any) => m.role === 'user');
      this.lastUserIsArray = Array.isArray(u?.content);
      this.lastUserText = typeof u?.content === 'string'
        ? u.content
        : (u?.content ?? []).map((p: any) => (p.type === 'text' ? p.text : '[图片]')).join('');
      this.lastEffort = options?.reasoningEffort;
      return this.mock.chat(messages, tools, options);
    }
  }
  const cap2 = new CapturingProvider2([
    { content: '', toolCalls: [{ id: 'sub1', name: 'subagent.run', arguments: { task: '向子代理问好' } }], finishReason: 'tool_calls' },
    { content: 'sub-hello', toolCalls: [], finishReason: 'stop' },
    { content: 'outer-done', toolCalls: [], finishReason: 'stop' },
    { content: '@ok', toolCalls: [], finishReason: 'stop' },
    { content: 'effort-ok', toolCalls: [], finishReason: 'stop' },
    { content: 'mm-ok', toolCalls: [], finishReason: 'stop' },
  ]);
  const service8 = new AgentService({ appDir, pushEvent: push, initialProvider: cap2 as unknown as LLMProvider, contextTokenBudget: 30_000 });
  await service8.init();
  await service8.createSession({ title: 'v04 测试' });
  await writeFile(path.join(appDir, 'notes.txt'), '上下文标记XYZ');
  await writeFile(path.join(appDir, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  // 子代理：外层派发 → 内层隔离循环 → 结果回喂 → 外层收尾
  const s8 = service8.sendMessage({ message: { role: 'user', content: '委派子代理' } });
  const mid8 = (s8 as { ok: true; data: { messageId: string } }).data.messageId;
  await waitFor(() => events.some((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'sub1'), 10_000, 'sub1 结果');
  const subRes = events.find((e) => e.channel === 'tool-result' && e.payload.toolCallId === 'sub1')!;
  check(subRes.payload.result.ok === true && subRes.payload.result.output.includes('sub-hello'), '子代理隔离循环执行并把最终答复回喂外层');
  check(subRes.payload.result.output.includes('core-subagent') === false, '子代理注册表不含自身（禁止嵌套派生）');
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.messageId === mid8 && e.payload.content === 'outer-done'), 10_000, 'mid8 loop-done');
  check(cap2.calls === 3, `子代理流程模型调用 3 次（外层/内层/外层收尾），实际 ${cap2.calls}`);

  // @ 引用注入
  await service8.sendMessage({ message: { role: 'user', content: '看这个 @notes.txt' }, contextFiles: ['notes.txt'] });
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.content === '@ok'), 8000, '@ 引用轮完成');
  check(cap2.calls === 4, `@ 引用轮后模型调用 4 次，实际 ${cap2.calls}`);
  check(
    cap2.lastUserText.includes('引用上下文') && cap2.lastUserText.includes('上下文标记XYZ'),
    `@ 引用文件内容注入消息尾部（实际: ${JSON.stringify(cap2.lastUserText.slice(0, 90))}）`,
  );

  // 推理力度透传
  await service8.setAgentPolicy({ reasoningEffort: 'low' });
  await service8.sendMessage({ message: { role: 'user', content: '力度测试' } });
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.content === 'effort-ok'), 8000, '力度轮完成');
  check(cap2.lastEffort === 'low', '推理力度 low 透传到 provider 调用');

  // 多模态消息（文本 + 图片分片）
  const mm = await service8.sendMessage({
    message: { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
  });
  check(mm.ok === true, '多模态消息受理');
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.content === 'mm-ok'), 8000, '多模态轮完成');
  check(cap2.lastUserIsArray === true, '图片以内容分片数组传给 provider');

  // 附件读取与 @ 文件枚举
  const att = await service8.readAttachment({ path: 'dot.png' });
  check(att.ok && att.data!.kind === 'image' && att.data!.mediaType === 'image/png' && att.data!.data!.length > 50, 'read-attachment 图片 → base64 分片数据');
  const att2 = await service8.readAttachment({ path: 'notes.txt' });
  check(att2.ok && att2.data!.kind === 'text' && att2.data!.text!.includes('上下文标记XYZ'), 'read-attachment 文本 → UTF-8 内容');
  const ws = await service8.listWorkspaceFiles({ query: 'notes' });
  check(ws.ok && ws.data!.files.some((f) => f.rel === 'notes.txt'), 'list-workspace-files 命中 notes.txt');
  await service8.shutdown();

  // ---------- 13. 回归：排队多模态保真（H1） + 删会话守卫（H2） ----------
  // 注意三条应答的归属：resp1 挂起审批（第一轮）、resp2 'hold-done' 结束第一轮、
  // resp3 'queued-ok' 只能由排队消息 drain 后的**第二轮**产出——
  // 否则 waitFor 会在 drain 前被第一轮的 loop-done 提前满足，lastUserIsArray 断言变成时序彩票
  // （Node 24 调度时序变化让该竞态在 CI 上必现，Node 20/22 只是碰巧没炸）
  const cap3 = new CapturingProvider2([
    { content: '', toolCalls: [{ id: 'hold1', name: 'write-file.write', arguments: { path: 'held.txt', content: 'x' } }], finishReason: 'tool_calls' },
    { content: 'hold-done', toolCalls: [], finishReason: 'stop' },
    { content: 'queued-ok', toolCalls: [], finishReason: 'stop' },
  ]);
  const service9 = new AgentService({ appDir, pushEvent: push, initialProvider: cap3 as unknown as LLMProvider, contextTokenBudget: 30_000 });
  await service9.init();
  await service9.createSession({ title: '回归' });
  const sid9 = unwrap(service9.listSessions()).sessions[0].id;
  // 第一步：write-file 审批挂起 → 会话进入"忙"态
  service9.sendMessage({ message: { role: 'user', content: '占住循环' } });
  await waitFor(() => events.some((e) => e.channel === 'approval-required' && e.payload.toolCallId === 'hold1'), 8000, 'hold1 审批挂起');
  const mid9b = (events.filter((e) => e.channel === 'approval-required' && e.payload.toolCallId === 'hold1').pop() as { payload: { messageId: string } }).payload.messageId;
  // H1：多模态消息在忙时入队
  const s9b = service9.sendMessage({
    message: { role: 'user', content: [{ type: 'text', text: '排队图片' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
  });
  check((s9b as { data?: { queued?: boolean } }).data?.queued === true, 'H1 前置：多模态消息在忙时入队');
  // 第二步：批准挂起的写文件 → 本轮收尾 → 排队消息自动续发
  await service9.approveTool({ messageId: mid9b, toolCallId: 'hold1' });
  await waitFor(() => events.some((e) => e.channel === 'loop-done' && e.payload.content === 'queued-ok'), 12_000, 'H1：排队多模态消息自动续发完成');
  check(cap3.lastUserIsArray === true, 'H1 回归：排队多模态出队后仍为分片数组（不再 JSON 字符串化）');

  // H2：全部完成后删除会话成功且不崩溃（runLoopTask 空守卫 + deleteSession 队列清理）
  const del9 = await service9.deleteSession({ id: sid9 });
  check(del9.ok === true, 'H2 回归：完成后删除会话成功（守卫路径无崩溃）');
  await new Promise((r) => setTimeout(r, 400)); // 若存在 unhandled rejection，此处进程已挂
  await service9.shutdown();

  // ---------- 14. 通道接线完整性：preload 声明的 invoke 通道必须在 main 有 handle/on 注册 ----------
  const preloadDist = readFileSync(path.join(projectRoot, 'dist/src/electron/preload.js'), 'utf-8');
  const mainDist = readFileSync(path.join(projectRoot, 'dist/src/electron/main.js'), 'utf-8');
  const declared = [
    ...preloadDist.matchAll(/'(send-message|approve-tool|reject-tool|stop|list-plugins|install-plugin|install-plugin-from-registry|list-registry-plugins|uninstall-plugin|get-plugin-settings|set-plugin-settings|list-sessions|create-session|switch-session|rename-session|delete-session|list-providers|set-model-config|fetch-models|list-mcp-servers|set-mcp-config|toggle-mcp-server|set-agent-policy|get-app-info|read-audit|preview-file|list-workspace-files|read-attachment|pick-files|term-input|term-stop|check-updates|download-update|install-update|get-updater-state|set-auto-update-enabled)'/g),
  ].map((m) => m[1]);
  const missing = declared.filter((ch) => !mainDist.includes(`handle('${ch}'`) && !mainDist.includes(`on('${ch}'`));
  check(missing.length === 0, `通道接线完整性：preload 的 ${declared.length} 个通道全部在 main 注册（缺失: ${missing.join(', ') || '无'}）`);

  await rm(appDir, { recursive: true, force: true });
  console.log('\nIPC 自测全部通过 🎉');
}

main().catch((e) => {
  console.error('IPC 自测异常:', e);
  process.exit(1);
});
