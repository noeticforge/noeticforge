/**
 * 用户视角全功能旅程测试（CDP 驱动真实 UI）。
 * 前置：journeys/ 为工作目录；mock-openai(18099) 与 electron(CDP 9226) 已启动。
 * 覆盖：模型配置 / 对话 / 三种工具 / 改参批准 / 拒绝 / 排队 / 会话管理 / 权限模式 /
 *      推理力度 / @ 引用 / MCP / 子代理 / 终端 / 主题与重启持久性。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

const OUT = 'journey-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9226/json')).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('找不到渲染进程 target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
/** 执行语句（无返回值） */
const run = async (stmts) => {
  const r = await send('Runtime.evaluate', { expression: `(() => { ${stmts};
 return true; })()`, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails));
  return true;
};
/** 取值表达式 */
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(${expr})`, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
const click = (sel) => run(`document.querySelector('${sel}').click();`);
const clickText = async (sel, text) => {
  for (let i = 0; i < 3; i++) {
    const ok = await ev(`[...document.querySelectorAll('${sel}')].some(b => b.textContent.includes('${text}'))`);
    if (ok) {
      await run(`[...document.querySelectorAll('${sel}')].find(b => b.textContent.includes('${text}')).click();`);
      await sleep(120);
      return;
    }
    await sleep(350);
  }
  const candidates = await ev(`[...document.querySelectorAll('${sel}')].slice(0, 8).map(b => b.textContent.slice(0, 24))`);
  throw new Error(`clickText 未找到 ${sel} "${text}"；现有: ${JSON.stringify(candidates)}`);
};
const setValue = (sel, v) => run(`(() => { const el = document.querySelector('${sel}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input')); })()`);
const waitFile = async (path, pred, timeout, label) => {
  const d = Date.now();
  while (Date.now() - d < timeout) {
    try { if (pred(readFileSync(path, 'utf-8'))) return; } catch { /* 还没写出来 */ }
    await sleep(120);
  }
  throw new Error('waitFile 超时: ' + label);
};
const waitFor = async (expr, timeout, label) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await ev(expr)) return;
    await sleep(150);
  }
  console.log('— 诊断：toast =', JSON.stringify(await ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`)));
  console.log('— 诊断：消息区 =', JSON.stringify(await ev(`document.querySelector('#messages').innerText.slice(0, 400)`)));
  console.log('— 诊断：日志 =', JSON.stringify(await ev(`[...document.querySelectorAll('.log-item')].slice(0, 5).map(t => t.textContent.slice(0, 130))`)));
  await shot('fail-' + label.replace(/\W/g, '-'));
  throw new Error('等待超时: ' + label);
};

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failed++; };
const sendViaInput = async (text) => { await setValue('#message-input', text); await click('#send-btn'); };
/** 打开下拉并点选菜单项（带重试：菜单渲染时序不稳定时的兜底） */
const menuClick = async (anchorSel, text) => {
  for (let i = 0; i < 3; i++) {
    await click(anchorSel);
    await sleep(300);
    const ok = await ev(`[...document.querySelectorAll('.menu-item')].some(b => b.textContent.includes('${text}'))`);
    if (ok) { await clickText('.menu-item', text); await sleep(200); return true; }
    await run(`(() => { if (window.__ab && window.__ab.st.activeMenu) { document.body.click(); } })()`);
    await sleep(200);
  }
  throw new Error('menuClick 未找到菜单项: ' + text);
};

await send('Page.enable');
await run(`window.confirm = () => true;`);
await waitFor(`document.querySelectorAll('.session-item').length >= 1`, 8000, 'UI 初始化');

// ============ J1 配置模型（设置页真实流程） ============
await click('#btn-open-settings');
await waitFor(`!document.querySelector('#settings-view').classList.contains('hidden')`, 5000, '打开设置');
await clickText('#provider-list .provider-item', 'OpenAI 兼容');
await setValue('#pd-baseurl', 'http://127.0.0.1:18099/v1');
await setValue('#pd-apikey', 'journey-key');
await setValue('#pd-model-input', 'mock-model');
await click('#pd-model-add');
await click('#pd-save');
await waitFor(`document.querySelector('#chip-provider').textContent.includes('mock-model')`, 5000, 'J1 模型配置生效');
check((await ev(`document.querySelector('#chip-provider').textContent`)).includes('mock-model'), 'J1 芯片显示 provider·模型');
await click('#set-back');
await waitFor(`document.querySelector('#settings-view').classList.contains('hidden')`, 5000, 'J1 返回工作区');

// ============ J2 基础对话 ============
await sendViaInput('你好呀');
await waitFor(`!document.querySelector('#thinking').classList.contains('live')`, 15_000, 'J2 对话完成');
check((await ev(`document.querySelector('#messages').innerText`)).includes('收到：你好呀'), 'J2 基础对话回复渲染');
check((await ev(`document.querySelector('#thinking').classList.contains('live')`)) === false, 'J2 思考行定格');
check((await ev(`[...document.querySelectorAll('.msg-block-assistant .stream-content.md')].length >= 1`)), 'J2 助手正文 Markdown 渲染');

// ============ J3 读取工具（免审批） ============
await sendViaInput('请读取 README.md 看看内容');
await waitFor(`[...document.querySelectorAll('.tool-row')].some(r => r.classList.contains('tool-row-ok') && r.textContent.includes('read-file.read'))`, 15_000, 'J3 读取工具成功');
await waitFor(`document.querySelector('#messages').innerText.includes('JOURNEY-README-MARKER')`, 10_000, 'J3 文件内容回流展示');

// ============ J4 写文件 + diff + 改参批准 ============
await sendViaInput('把 OK-MARK 写入 out.txt');
await waitFor(`!document.querySelector('#approval-modal').classList.contains('hidden')`, 15_000, 'J4 审批弹窗');
check((await ev(`document.querySelector('#apv-diff').textContent`)).includes('OK-MARK'), 'J4 diff 预览含初始内容');
await run(`(() => { document.querySelector('#apv-args-table td.arg-val[data-key="content"]').innerText = 'CHANGED-MARK'; })()`);
await click('#apv-approve-btn');
await waitFile('out.txt', (t) => t === 'CHANGED-MARK', 15_000, 'J4 改参批准真实生效');
check(true, 'J4 改参批准真实生效（写入 CHANGED-MARK）');
await waitFor(`document.querySelector('#messages').innerText.includes('TOOL-FINAL')`, 15_000, 'J4 收尾回复');

// ============ J5 拒绝（带原因） ============
await sendViaInput('把 secret 写入 reject.txt');
await waitFor(`!document.querySelector('#approval-modal').classList.contains('hidden')`, 15_000, 'J5 审批弹窗');
await setValue('#apv-reason-input', '路径不行');
await click('#apv-reject-btn');
await waitFor(`[...document.querySelectorAll('.tool-row')].some(r => r.classList.contains('tool-row-fail') && r.textContent.includes('write-file.write'))`, 15_000, 'J5 拒绝后工具行失败');
check(!existsSync('reject.txt'), 'J5 拒绝后文件未写入');
await waitFor(`document.querySelector('#messages').innerText.includes('用户拒绝')`, 10_000, 'J5 拒绝原因回喂模型');

// ============ J6 命令执行 + J7 排队（确定性：审批挂起期间入队） ============
await sendViaInput('跑个命令试试 echo');
await waitFor(`!document.querySelector('#approval-modal').classList.contains('hidden')`, 15_000, 'J6 命令审批');
// 审批挂起 = 会话忙：此时发送必然排队
await sendViaInput('消息一');
check((await ev(`[...document.querySelectorAll('.queued-badge')].some(b => b.textContent === '已排队')`)), 'J7 忙时发送显示已排队徽标');
await click('#apv-approve-btn');
await waitFor(`[...document.querySelectorAll('.tool-row')].some(r => r.classList.contains('tool-row-ok') && r.textContent.includes('shell-exec.run'))`, 20_000, 'J6 命令执行成功');
await waitFor(`document.querySelector('#messages').innerText.includes('SHELL-OK') && document.querySelector('#messages').innerText.includes('收到：消息一')`, 25_000, 'J6 命令输出回流 + J7 排队消息自动续发');

// ============ J8 会话管理 ============
await click('#btn-new-session');
await waitFor(`document.querySelectorAll('#messages .msg-block-user').length === 0`, 5000, 'J8 新会话为空');
await clickText('#session-list .session-item .btn-mini', '改');
await waitFor(`!!document.querySelector('#session-list input')`, 3000, 'J8 改名编辑器出现');
await run(`(() => {
  const editor = document.querySelector('#session-list input');
  editor.value = '我的会话';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
})()`);
await waitFor(`[...document.querySelectorAll('.session-name')].some(s => s.textContent === '我的会话')`, 5000, 'J8 内联改名生效');
await setValue('#session-search', '我的');
await sleep(250);
check((await ev(`document.querySelectorAll('#session-list .session-item').length === 1`)), 'J8 搜索过滤到唯一会话');
await setValue('#session-search', '');
await sleep(150);
await clickText('#session-list .session-item', '默认会话');
await waitFor(`document.querySelector('#messages').innerText.includes('收到：消息一')`, 8000, 'J8 切回后历史重建');
check((await ev(`[...document.querySelectorAll('.tool-row')].length >= 1`)), 'J8 历史含工具行');

// ============ J9 权限模式（计划模式真实拦截） ============
await menuClick('#btn-policy', '计划模式');
await waitFor(`document.querySelector('#btn-policy').textContent.includes('计划模式')`, 5000, 'J9 切换计划模式');
await sendViaInput('把计划写入 plan.txt');
await waitFor(`[...document.querySelectorAll('.tool-row')].some(r => r.classList.contains('tool-row-fail') && r.textContent.includes('permission-denied'))`, 15_000, 'J9 计划模式写文件被策略拒绝');
check(!existsSync('plan.txt'), 'J9 计划模式下文件未写入');
await menuClick('#btn-policy', '完全访问');
await waitFor(`document.querySelector('#btn-policy').textContent.includes('完全访问')`, 5000, 'J9 恢复完全访问');

// ============ J10 推理力度 ============
await menuClick('#btn-effort', '高');
await waitFor(`document.querySelector('#btn-effort').textContent.includes('高')`, 5000, 'J10 推理力度切换');

// ============ J11 @ 上下文引用 ============
await setValue('#message-input', '帮我看一下 @REA');
await sleep(700);
await clickText('#dropdown-root .menu-item', '@README.md');
check((await ev(`document.querySelector('#message-input').value`)).includes('@README.md'), 'J11 @ 选择器插入文件引用');
const j11text = await ev(`document.querySelector('#message-input').value`);
await sendViaInput(j11text + ' 总结一下');
await sleep(1500);
const lastReq = JSON.parse(readFileSync('last-request.json', 'utf-8'));
check(JSON.stringify(lastReq.messages).includes('JOURNEY-README-MARKER'), 'J11 @ 引用文件内容注入模型请求');

// ============ J12 MCP（mock stdio server） ============
await click('#btn-open-settings');
await clickText('.set-item', 'MCP 服务器');
await waitFor(`document.querySelector('#mcp-server-list').textContent.includes('已连接')`, 10_000, 'J12 MCP 服务器已连接');
check((await ev(`document.querySelector('#mcp-server-list').textContent`)).includes('mock'), 'J12 mock 服务器出现在列表');
await click('#set-back');
await sendViaInput('用 echo 打个招呼 echo');
await waitFor(`[...document.querySelectorAll('.tool-row')].some(r => r.classList.contains('tool-row-ok') && r.textContent.includes('mcp.mock.echo'))`, 20_000, 'J12 MCP 工具真实执行');
await waitFor(`document.querySelector('#messages').innerText.includes('echo: hi')`, 10_000, 'J12 MCP 输出回流');

// ============ J13 子代理 ============
await sendViaInput('委派一个子代理去生成问候');
await waitFor(`[...document.querySelectorAll('.tool-row')].some(r => r.classList.contains('tool-row-ok') && r.textContent.includes('subagent.run'))`, 20_000, 'J13 子代理执行成功');
await waitFor(`document.querySelector('#messages').innerText.includes('SUB-FINAL')`, 10_000, 'J13 子代理结果回流');

// ============ J14 终端 ============
await click('#btn-toggle-panel');
await clickText('.rp-tab', '终端');
await setValue('#term-in', 'echo TERMX');
await run(`document.querySelector('#term-in').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));`);
await waitFor(`document.querySelector('#term-out').textContent.includes('TERMX')`, 15_000, 'J14 终端执行命令');
await shot('journey-terminal');

// ============ J15 主题 + 重启持久性 ============
await click('#btn-open-settings');
await clickText('.set-item', '外观');
await click('.theme-card[data-theme="theme-dark"]');
check((await ev(`document.body.classList.contains('theme-dark')`)), 'J15 切换深色主题');
await shot('journey-dark');
await send('Page.reload');
await sleep(2500);
await waitFor(`document.querySelectorAll('.session-item').length >= 1`, 10_000, 'J15 重启后会话恢复');
check((await ev(`document.body.classList.contains('theme-dark')`)), 'J15 主题持久化（深色）');
await run(`[...document.querySelectorAll('.session-item')].find(b => b.textContent.includes('默认会话')).click();`);
await waitFor(`document.querySelector('#messages').innerText.includes('收到：消息一')`, 10_000, 'J15 重启后历史重建');
check((await ev(`[...document.querySelectorAll('.tool-row')].length >= 1`)), 'J15 重启后工具行重建');
await shot('journey-reload-history');

console.log(failed === 0 ? '\n用户旅程测试全部通过 🎉' : `\n${failed} 项失败`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
