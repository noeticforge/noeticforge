/**
 * ============================================================================
 *  Agent Base 渲染进程测试页 — app.js
 *  无框架 / 无构建，preload 通过 contextBridge 注入 window.agentBase，UI 只做
 *  "调用 + 订阅推送"，不实现后端任何逻辑。
 *  ----------------------------------------------------------------------------
 *  区块索引：
 *   [0] 常量与 DOM 缓存    [1] 通用工具函数      [2] Toast 提示
 *   [3] invoke 统一包装    [4] 聊天区            [5] 审批对话框
 *   [6] 插件管理           [7] 模型配置          [8] 事件日志
 *   [9] 事件订阅与初始化
 * ============================================================================
 */
'use strict';

/* ================= [0] 常量与 DOM 缓存 ================= */
const $ = (s) => document.querySelector(s);
const el = {
  messages: $('#messages'), input: $('#message-input'), sendBtn: $('#send-btn'),
  thinking: $('#thinking'), stopBtn: $('#stop-btn'), toastBox: $('#toast-box'),
  apvModal: $('#approval-modal'), apvName: $('#apv-tool-name'), apvReason: $('#apv-reason'),
  apvReasonInput: $('#apv-reason-input'), apvTable: $('#apv-args-table'),
  apvTBody: $('#apv-args-table').querySelector('tbody'), apvRaw: $('#apv-args-raw'),
  apvOk: $('#apv-approve-btn'), apvNo: $('#apv-reject-btn'),
  pluginList: $('#plugin-list'), pluginEmpty: $('#plugin-empty'), pluginDir: $('#plugin-dir'), installBtn: $('#install-btn'),
  cfgProvider: $('#cfg-provider'), cfgKey: $('#cfg-apikey'), cfgModel: $('#cfg-model'), cfgUrl: $('#cfg-baseurl'), saveModel: $('#save-model-btn'),
  logList: $('#log-list'), logCount: $('#log-count'), logToggle: $('#log-toggle'), logBody: $('#log-body'),
};
const st = { busy: false, boxes: new Map(), tools: new Map(), pending: null };
const OUT_LIMIT = 200, LOG_LIMIT = 300;

/* ================= [1] 通用工具函数 ================= */
const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch (_e) { return String(v); }
}
const trunc = (s, n = OUT_LIMIT) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
/** 参数美化：字符串先尝试解析，输出缩进 JSON */
function pretty(v) {
  if (v == null) return '{}';
  if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch (_e) { return v; } }
  try { return JSON.stringify(v, null, 2); } catch (_e) { return String(v); }
}
/** 快捷建元素：h('div'|'span'|'code'..., 类名, 文本) */
function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
const scrollBottom = () => { el.messages.scrollTop = el.messages.scrollHeight; };
const autoGrow = () => { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px'; };

/* ================= [2] Toast 提示（type: err|ok|info） ================= */
function toast(text, type = 'err') {
  const n = h('div', 'toast toast-' + type, text);
  el.toastBox.appendChild(n);
  setTimeout(() => n.classList.add('toast-out'), 3500);
  setTimeout(() => n.remove(), 3900);
}

/* ================= [3] invoke 统一包装（ok:false → 顶部 toast 中文错误码） ================= */
const ERR_TEXT = {
  E_INVALID_MESSAGE: '消息不合法：必须是内容非空的用户消息',
  E_LOOP_BUSY: '当前会话有循环正在运行，请先停止或等待其完成',
  E_NO_PENDING_APPROVAL: '没有待审批的工具调用',
  E_LLM_ERROR: '模型调用出错',
  E_MAX_ITERATIONS: '已达到最大迭代次数，循环终止',
  E_INTERNAL: '后端内部错误',
  E_PROVIDER_NOT_CONFIGURED: '尚未配置模型，请在「模型配置」中填写 API Key',
  E_PROVIDER_UNSUPPORTED: '不支持的模型提供商',
  E_INVALID_CONFIG: '配置无效，请检查 apiKey / model / baseUrl',
  E_SESSION_NOT_FOUND: '会话不存在或已被删除',
  E_SESSION_IN_USE: '会话有正在进行的任务，暂不可删除',
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
  E_MCP_NOT_FOUND: 'MCP 服务器不存在',
};
async function invoke(p, label) {
  let res;
  try { res = await p; } catch (e) {
    toast('调用 ' + label + ' 异常：' + (e.message || e)); return { ok: false, data: null };
  }
  if (!res || res.ok === false) {
    const e = (res && res.error) || {};
    toast(label + '失败：' + (ERR_TEXT[e.code] || e.message || e.code || '未知错误'));
    return { ok: false, data: null };
  }
  return { ok: true, data: res ? res.data : null };
}

/* ================= [4] 聊天区 ================= */
/** 追加用户消息（右对齐，仅本地展示） */
function addUser(content) {
  const bubble = h('div', 'bubble bubble-user', content);
  el.messages.appendChild(h('div', 'msg msg-user')).appendChild(bubble);
  scrollBottom();
}
/** 获取/创建某 messageId 的助手容器：气泡内含【正文 / 生成中提示 / 工具卡片区】*/
function ensureBox(id) {
  let box = st.boxes.get(id);
  if (box) return box;
  const msg = h('div', 'msg msg-assistant');
  const bubble = h('div', 'bubble bubble-assistant');
  const content = h('div', 'stream-content');
  const typing = h('div', 'typing hidden', '▍正在生成…');
  const tools = h('div', 'tools-area');
  bubble.append(content, typing, tools);
  msg.appendChild(bubble);
  el.messages.appendChild(msg);
  scrollBottom();
  box = { content, typing, tools };
  st.boxes.set(id, box);
  return box;
}
/** 切换忙碌态：显示“思考中…”+ 停止按钮，发送按钮置灰 */
function setBusy(busy) {
  st.busy = busy;
  el.thinking.classList.toggle('hidden', !busy);
  el.sendBtn.disabled = busy;
}
/** 发送入口：前端防抖 + 调 sendMessage */
async function handleSend() {
  const content = el.input.value.trim();
  if (!content) return;
  if (st.busy) { toast(ERR_TEXT.E_LOOP_BUSY); return; }
  el.input.value = ''; autoGrow(); addUser(content); setBusy(true);
  const r = await invoke(window.agentBase.sendMessage({ role: 'user', content }), '发送消息');
  if (!r.ok) { setBusy(false); return; }
  if (r.data && r.data.messageId) ensureBox(r.data.messageId);
}
/** message-chunk：delta 增量拼接，打流式打字机 */
function onChunk(p) {
  log('message-chunk', p);
  const { messageId, delta } = p;
  if (!delta) return;
  const b = ensureBox(messageId);
  b.typing.classList.remove('hidden');
  b.content.textContent += delta;
  scrollBottom();
}
/** tool-started：插入“🔧 调用 name + 参数”小卡片 */
function onToolStart(p) {
  log('tool-started', p);
  const { messageId, toolCallId, name, arguments: args } = p;
  const card = h('div', 'tool-card tool-pending');
  card.dataset.toolCallId = toolCallId;
  const head = h('div', 'tool-head');
  const status = h('span', 'tool-status', '执行中…');
  head.append('🔧 ', h('span', null, '调用 '), h('code', 'tool-name', name), status);
  card.append(head, h('pre', 'tool-args', pretty(args)));
  ensureBox(messageId).tools.appendChild(card);
  st.tools.set(toolCallId, { card, status, full: '', expanded: false });
  scrollBottom();
}
/** tool-result：绿=成功 / 红=失败，输出>200字截断可展开 */
function onToolResult(p) {
  log('tool-result', p);
  const { toolCallId, result } = p;
  const it = st.tools.get(toolCallId);
  if (!it) return;
  const d = result || {};
  const ok = !!d.ok;
  it.card.classList.remove('tool-pending');
  it.card.classList.add(ok ? 'tool-ok' : 'tool-fail');
  it.status.textContent = ok ? '✓ 成功' : '✗ 失败';
  const text = d.output !== undefined ? toText(d.output) : (d.error ? toText(d.error) : '');
  if (!text) return;
  it.full = text;
  const code = h('pre', null, trunc(text));
  const toggle = h('button', 'tool-toggle');
  if (text.length > OUT_LIMIT) {
    toggle.textContent = '展开全文';
    toggle.addEventListener('click', () => {
      it.expanded = !it.expanded;
      code.textContent = it.expanded ? it.full : trunc(it.full);
      toggle.textContent = it.expanded ? '收起' : '展开全文';
    });
  } else toggle.classList.add('hidden');
  const out = h('div', 'tool-output');
  out.appendChild(code);
  it.card.append(out, toggle);
  scrollBottom();
}
/** loop-done：收起加载态，流式缺内容时用最终 content 兜底 */
function onLoopDone(p) {
  log('loop-done', p);
  const { messageId, content, stopped } = p;
  const b = ensureBox(messageId);
  b.typing.classList.add('hidden');
  if (content && !b.content.textContent) b.content.textContent = content;
  setBusy(false);
  if (stopped) toast('已停止生成', 'info');
  scrollBottom();
}
/** loop-error：收忙碌态，聊天流内追加错误卡片 + toast */
function onLoopErr(p) {
  log('loop-error', p);
  const { messageId, error } = p;
  const e = error || {};
  setBusy(false);
  const b = ensureBox(messageId);
  b.typing.classList.add('hidden');
  const text = ['[阶段:' + (e.phase || '-') + ']', e.code, e.message].filter(Boolean).join(' ');
  b.tools.appendChild(h('div', 'tool-card tool-fail', null)).append('⛔ ', h('span', null, '循环出错'), h('pre', 'tool-args', text));
  toast('循环出错：' + (ERR_TEXT[e.code] || e.message || e.code || '未知错误'));
  scrollBottom();
}

/* ================= [5] 审批对话框 ================= */
/** approval-required：工具名 + 参数 JSON 表格 + 批准/拒绝（拒绝可填原因） */
function onApproval(p) {
  log('approval-required', p);
  const { messageId, toolCallId, name, arguments: args, reason } = p;
  st.pending = { messageId, toolCallId };
  el.apvName.textContent = name;
  el.apvReason.classList.toggle('hidden', !reason);
  el.apvReason.textContent = reason ? '原因：' + reason : '';
  el.apvReasonInput.value = '';

  let parsed = args;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (_e) { parsed = null; } }
  const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
  el.apvTBody.innerHTML = '';
  if (keys.length) {
    keys.forEach((k) => el.apvTBody.appendChild(h('tr', null, null)).append(h('td', 'arg-key', k), h('td', 'arg-val', toText(parsed[k]))));
    el.apvTable.classList.remove('hidden'); el.apvRaw.classList.add('hidden');
  } else {
    el.apvTable.classList.add('hidden');
    el.apvRaw.textContent = args == null ? '（无参数）' : trunc(toText(args));
    el.apvRaw.classList.remove('hidden');
  }
  el.apvModal.classList.remove('hidden');
  setApprovalBusy(false);
}
const setApprovalBusy = (b) => { el.apvOk.disabled = b; el.apvNo.disabled = b; };
const closeApproval = () => { el.apvModal.classList.add('hidden'); st.pending = null; };
async function onApprove() {
  const r = st.pending;
  if (!r) return;
  setApprovalBusy(true);
  await invoke(window.agentBase.approveTool({ messageId: r.messageId, toolCallId: r.toolCallId }), '批准工具');
  closeApproval(); // 关闭后等待 tool-result 更新卡片
}
async function onReject() {
  const r = st.pending;
  if (!r) return;
  const reason = el.apvReasonInput.value.trim();
  setApprovalBusy(true);
  await invoke(window.agentBase.rejectTool({ messageId: r.messageId, toolCallId: r.toolCallId, reason: reason || undefined }), '拒绝工具');
  closeApproval();
}

/* ================= [6] 插件管理 ================= */
async function loadPlugins() {
  const r = await invoke(window.agentBase.listPlugins(), '加载插件列表');
  if (r.ok) renderPlugins(r.data.plugins);
}
/** plugins-changed：全量刷新列表 */
function onPluginsChanged(p) {
  log('plugins-changed', p);
  renderPlugins(p.plugins);
}
function renderPlugins(plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  el.pluginList.innerHTML = '';
  el.pluginEmpty.classList.toggle('hidden', list.length > 0);
  list.forEach((p) => {
    const info = h('div', 'plugin-info');
    info.append(h('span', 'plugin-name', p.displayName || p.name), h('span', 'plugin-version', 'v' + (p.version || '?')));
    const un = h('button', 'btn-uninstall', '卸载');
    const head = h('div', 'plugin-head');
    head.append(info, un);
    const tags = h('div', 'plugin-tags');
    (p.permissions || []).forEach((x) => tags.appendChild(h('span', 'tag tag-perm', x)));
    (p.tools || []).forEach((x) => tags.appendChild(h('span', 'tag tag-tool', x)));
    const row = h('div', 'plugin-item');
    row.append(head, h('div', 'plugin-desc', p.description || ''), tags);
    el.pluginList.appendChild(row);

    const label = p.displayName || p.name;
    un.addEventListener('click', async () => {
      if (!confirm('确定卸载插件「' + label + '」？')) return;
      const r = await invoke(window.agentBase.uninstallPlugin({ name: p.name }), '卸载插件');
      if (r.ok) toast('插件「' + label + '」已卸载', 'ok');
    });
  });
}
/** 从本地目录安装插件 */
async function handleInstall() {
  const dir = el.pluginDir.value.trim();
  if (!dir) { toast('请先填写插件目录的绝对路径'); return; }
  const r = await invoke(window.agentBase.installPlugin({ pluginDir: dir }), '安装插件');
  if (r.ok && r.data && r.data.plugin) {
    toast('插件「' + (r.data.plugin.displayName || r.data.plugin.name) + '」安装成功', 'ok');
    el.pluginDir.value = '';
  }
}

/* ================= [7] 模型配置 ================= */
/** 保存模型配置：仅提交已填字段，空字段保持后端原值 */
async function handleSaveModel() {
  const c = { provider: el.cfgProvider.value };
  if (el.cfgKey.value.trim()) c.apiKey = el.cfgKey.value.trim();
  if (el.cfgModel.value.trim()) c.model = el.cfgModel.value.trim();
  if (el.cfgUrl.value.trim()) c.baseUrl = el.cfgUrl.value.trim();
  const r = await invoke(window.agentBase.setModelConfig({ config: c }), '保存模型配置');
  if (r.ok) { el.cfgKey.value = ''; toast('模型配置已保存', 'ok'); }
}

/* ================= [8] 事件日志 ================= */
/** 记录推送事件：时间倒序置顶、限长、大字段截断（供调试） */
function log(name, payload) {
  let json = '';
  try { json = JSON.stringify(payload); } catch (_e) { json = String(payload); }
  if (json.length > 500) json = json.slice(0, 500) + '…(截断)';
  el.logList.prepend(h('div', 'log-item', '[' + nowTime() + '][' + name + '] ' + json));
  while (el.logList.children.length > LOG_LIMIT) el.logList.lastChild.remove();
  el.logCount.textContent = String(el.logList.children.length);
}

/* ================= [9] 事件订阅与初始化 ================= */
function subscribe() {
  const api = window.agentBase;
  if (!api || typeof api.on !== 'function') {
    toast('未检测到 window.agentBase，请通过 Electron 渲染进程打开本页面');
    return false;
  }
  api.on('message-chunk', onChunk);
  api.on('tool-started', onToolStart);
  api.on('tool-result', onToolResult);
  api.on('approval-required', onApproval);
  api.on('loop-done', onLoopDone);
  api.on('loop-error', onLoopErr);
  api.on('plugins-changed', onPluginsChanged);
  return true;
}
function init() {
  el.sendBtn.addEventListener('click', handleSend);
  el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });
  el.input.addEventListener('input', autoGrow);
  el.stopBtn.addEventListener('click', () => invoke(window.agentBase.stop(), '停止生成'));
  el.apvOk.addEventListener('click', onApprove);
  el.apvNo.addEventListener('click', onReject);
  el.installBtn.addEventListener('click', handleInstall);
  el.pluginDir.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleInstall(); });
  el.saveModel.addEventListener('click', handleSaveModel);
  el.logToggle.addEventListener('click', () => {
    const folded = el.logBody.classList.toggle('collapsed');
    const arrow = el.logToggle.querySelector('.log-arrow');
    if (arrow) arrow.textContent = folded ? '▸' : '▾';
  });
  if (!subscribe()) return;
  loadPlugins();
  toast('测试台加载完成，可在下方输入框开始对话', 'info');
  el.input.focus();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();