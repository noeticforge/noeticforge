/**
 * 端到端对话验证（CDP 驱动真实 UI）：mock OpenAI 服务器 + 工具审批 + 流式回复。
 * 前置：e2e-ws/mock-openai.mjs 已运行（18099 端口）；electron 以 e2e-ws 为 cwd、CDP 9225 启动。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

const OUT = 'e2e-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9225/json')).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('找不到渲染进程 target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
};
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
const click = (sel) => evaluate(`(() => { const el = document.querySelector('${sel}'); if (!el) throw new Error('缺少 ${sel}'); el.click(); return true; })()`);
const waitFor = async (expr, timeout, label) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return;
    await sleep(120);
  }
  await dumpDiagnostics();
  throw new Error('等待超时: ' + label);
};

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? '✅' : '❌'} ${label}`); if (!ok) failed++; };
async function dumpDiagnostics() {
  try {
    console.log('— 诊断：消息区 =', JSON.stringify((await evaluate(`document.querySelector('#messages').innerText.slice(0, 500)`))));
    console.log('— 诊断：toast =', JSON.stringify(await evaluate(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`)));
    console.log('— 诊断：日志尾部 =', JSON.stringify(await evaluate(`[...document.querySelectorAll('.log-item')].slice(0, 8).map(t => t.textContent.slice(0, 120))`)));
    console.log('— 诊断：思考行 =', await evaluate(`!document.querySelector('#thinking').classList.contains('hidden')`));
    await shot('e2e-debug');
  } catch (e) { console.log('诊断失败:', e.message); }
}

await send('Page.enable');
await waitFor(`document.querySelectorAll('.session-item').length >= 1`, 8000, 'UI 初始化');
check(await evaluate(`!!window.agentBase && !!window.agentWindow`), 'preload API 就绪');

// 发消息（走真实输入框路径）
await evaluate(`(() => {
  const input = document.querySelector('#message-input');
  input.value = '请写一个 e2e.txt 文件';
  input.dispatchEvent(new Event('input'));
  document.querySelector('#send-btn').click();
  return true;
})()`);
await sleep(600);
console.log('— 早期诊断：toast =', JSON.stringify(await evaluate(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`)));
console.log('— 早期诊断：思考行 =', await evaluate(`!document.querySelector('#thinking').classList.contains('hidden')`));
console.log('— 早期诊断：设置页 =', await evaluate(`!document.querySelector('#settings-view').classList.contains('hidden')`));
console.log('— 早期诊断：日志尾部 =', JSON.stringify(await evaluate(`[...document.querySelectorAll('.log-item')].slice(0, 5).map(t => t.textContent.slice(0, 150))`)));
console.log('— 消息已发送，等待审批…');
await waitFor(`!document.querySelector('#approval-modal').classList.contains('hidden')`, 15_000, '审批弹窗出现');
check(await evaluate(`document.querySelector('#apv-tool-name').textContent`) === 'write-file.write', '审批工具为 write-file.write');
const diffText = await evaluate(`document.querySelector('#apv-diff').textContent`);
check(diffText.includes('line1') && diffText.includes('line2') && diffText.includes('新文件'), '审批弹窗渲染新文件 diff（line1/line2 + 新文件徽标）');
await shot('e2e-1-approval-diff');

// 批准
await click('#apv-approve-btn');
console.log('— 已批准，等待流式回复…');
await waitFor(`document.querySelector('#messages').textContent.includes('E2E 对话成功')`, 15_000, '流式回复渲染');
check(await evaluate(`document.querySelector('#thinking').classList.contains('live')`) === false, '对话完成，思考行定格（不再跳动）');
check(await evaluate(`!document.querySelector('#status-card').classList.contains('hidden')`) === false, '进程卡收起');
check(await evaluate(`[...document.querySelectorAll('.tool-row')].some(r => r.textContent.includes('write-file.write') && r.classList.contains('tool-row-ok'))`), '工具行显示 write-file 成功');
await shot('e2e-2-final');

check(existsSync('e2e.txt'), '工具真实写盘：e2e.txt 存在');
check(readFileSync('e2e.txt', 'utf-8') === 'line1\nline2', '写入内容与 diff 预览一致');

console.log(failed === 0 ? '\n端到端对话验证全部通过 🎉' : `\n${failed} 项失败`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
