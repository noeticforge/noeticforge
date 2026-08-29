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
  providerOptions: $('#provider-options'),
  sessList: $('#session-list'), sessEmpty: $('#session-empty'), sessNew: $('#session-new-btn'), chatTitle: $('#chat-title'),
  mcpList: $('#mcp-list'),
  logList: $('#log-list'), logCount: $('#log-count'), logToggle: $('#log-toggle'), logBody: $('#log-body'),
};
const st = { busy: false, boxes: new Map(), tools: new Map(), pending: null, sessions: [], currentSessionId: null };
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

/** Markdown 渲染（vendor/marked + DOMPurify 消毒；缺失时退回纯文本） */
function renderMarkdown(text) {
  const plain = () => { const d = h('div', 'stream-content'); d.textContent = text; return d; };
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return plain();
  try {
    const d = h('div', 'stream-content md');
    d.innerHTML = DOMPurify.sanitize(marked.parse(String(text ?? '')));
    return d;
  } catch (_e) { return plain(); }
}

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
/** 发送入口：前端防抖 + 调 sendMessage（v0.2 起携带当前会话 id） */
async function handleSend() {
  const content = el.input.value.trim();
  if (!content) return;
  if (st.busy) { toast(ERR_TEXT.E_LOOP_BUSY); return; }
  el.input.value = ''; autoGrow(); addUser(content); setBusy(true);
  const r = await invoke(window.agentBase.sendMessage({ role: 'user', content, sessionId: st.currentSessionId }), '发送消息');
  if (!r.ok) { setBusy(false); return; }
  if (r.data && r.data.messageId) ensureBox(r.data.messageId);
}
/** message-chunk：delta 增量拼接（只追加当前会话），打流式打字机 */
function onChunk(p) {
  log('message-chunk', p);
  if (!isCurrentSession(p)) return;
  const { messageId, delta } = p;
  if (!delta) return;
  const b = ensureBox(messageId);
  b.typing.classList.remove('hidden');
  b.content.textContent += delta;
  scrollBottom();
}
/** 推送事件是否属于当前正在查看的会话（v0.2 多会话：非当前会话的事件只记日志） */
function isCurrentSession(p) {
  return !st.currentSessionId || !p.sessionId || p.sessionId === st.currentSessionId;
}
/** tool-started：插入“🔧 调用 name + 参数”小卡片 */
function onToolStart(p) {
  log('tool-started', p);
  if (!isCurrentSession(p)) return;
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
  if (!isCurrentSession(p)) return;
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
  // render: 'markdown'（富插件协议 v2）→ 工具输出按 Markdown 渲染（DOMPurify 消毒）
  if (d.render === 'markdown' && typeof marked !== 'undefined') {
    const out = h('div', 'tool-output');
    out.appendChild(renderMarkdown(text));
    it.card.append(out);
    scrollBottom();
    return;
  }
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
/** loop-done：收起加载态，流式内容渲染成 Markdown，缺内容时用最终 content 兜底 */
function onLoopDone(p) {
  log('loop-done', p);
  if (!isCurrentSession(p)) return;
  const { messageId, content, stopped } = p;
  const b = ensureBox(messageId);
  b.typing.classList.add('hidden');
  const finalText = b.content.textContent || content || '';
  if (finalText) {
    const md = renderMarkdown(finalText);
    b.content.replaceWith(md);
    b.content = md;
  }
  setBusy(false);
  if (stopped) toast('已停止生成', 'info');
  scrollBottom();
}
/** loop-error：收忙碌态，聊天流内追加错误卡片 + toast */
function onLoopErr(p) {
  log('loop-error', p);
  if (!isCurrentSession(p)) return;
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
  const { messageId, toolCallId, name, arguments: args, reason } = p;  st.pending = { messageId, toolCallId };
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

/* ================= [5.5] 会话管理（v0.2） ================= */
async function loadSessions() {
  const r = await invoke(window.agentBase.listSessions(), '加载会话');
  if (r.ok) renderSessions(r.data.sessions);
  if (r.ok && !st.currentSessionId && r.data.sessions.length) {
    await doSwitchSession(r.data.sessions[0].id, { silent: true });
  }
}
function renderSessions(list) {
  const arr = Array.isArray(list) ? list : [];
  st.sessions = arr;
  el.sessList.innerHTML = '';
  el.sessEmpty.classList.toggle('hidden', arr.length > 0);
  arr.forEach((s) => {
    const item = h('div', 'session-item' + (s.id === st.currentSessionId ? ' active' : ''));
    const name = h('span', 'session-name', s.title || '未命名会话');
    name.title = s.title + ' · ' + (s.messageCount || 0) + ' 条消息';
    const ops = h('div', 'session-ops');
    const rn = h('button', 'btn-mini', '改');
    const del = h('button', 'btn-mini', '删');
    ops.append(rn, del);
    item.append(name, ops);
    el.sessList.appendChild(item);
    item.addEventListener('click', () => doSwitchSession(s.id));
    rn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const title = prompt('新的会话名称：', s.title || '');
      if (title && title.trim()) await invoke(window.agentBase.renameSession({ id: s.id, title: title.trim() }), '重命名会话');
    });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除会话「' + (s.title || s.id) + '」？历史不可恢复。')) return;
      const r = await invoke(window.agentBase.deleteSession({ id: s.id }), '删除会话');
      if (r.ok && st.currentSessionId === s.id) {
        st.currentSessionId = null;
        const rest = st.sessions.filter((x) => x.id !== s.id);
        if (rest.length) await doSwitchSession(rest[0].id, { silent: true });
        else { el.messages.innerHTML = ''; el.chatTitle.textContent = 'Agent Base'; }
      }
    });
  });
}
/** 切换会话：拉全量历史重建聊天区（v0.2 会话隔离） */
async function doSwitchSession(id, opts = {}) {
  if (st.busy && !opts.silent) { toast(ERR_TEXT.E_LOOP_BUSY); return; }
  const r = await invoke(window.agentBase.switchSession({ id }), '切换会话');
  if (!r.ok) return;
  st.currentSessionId = id;
  el.chatTitle.textContent = r.data.session.title || 'Agent Base';
  renderHistory(r.data.session.messages || []);
  renderSessions(st.sessions);
  if (!opts.silent) toast('已切换会话', 'info');
}
/** 从会话消息数组重建聊天区（含工具卡片历史） */
function renderHistory(messages) {
  el.messages.innerHTML = '';
  st.boxes.clear(); st.tools.clear();
  const toolOutput = new Map();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) toolOutput.set(m.toolCallId, m.content);
  }
  let histIdx = 0;
  for (const m of messages) {
    if (m.role === 'user') { addUser(m.content); continue; }
    if (m.role === 'assistant') {
      const box = ensureBox('hist-' + (++histIdx));
      box.typing.classList.add('hidden');
      if (m.content) {
        const md = renderMarkdown(m.content);
        box.content.replaceWith(md);
        box.content = md;
      }
      for (const call of m.toolCalls ?? []) {
        const card = h('div', 'tool-card tool-pending');
        const head = h('div', 'tool-head');
        head.append('🔧 ', h('span', null, '调用 '), h('code', 'tool-name', call.name), h('span', 'tool-status', ''));
        card.append(head, h('pre', 'tool-args', pretty(call.arguments)));
        const out = toolOutput.get(call.id);
        if (out !== undefined) {
          card.classList.remove('tool-pending'); card.classList.add('tool-ok');
          head.querySelector('.tool-status').textContent = '✓';
          card.append(h('pre', 'tool-args', trunc(out)));
        }
        box.tools.appendChild(card);
      }
    }
  }
  scrollBottom();
}
/** sessions-changed：会话列表有变（新建/改名/自动起标题）→ 全量刷新 */
function onSessionsChanged(p) {
  renderSessions(p?.sessions ?? []);
}

/* ================= [5.6] MCP 状态（v0.3） ================= */
async function loadMcp() {
  const r = await invoke(window.agentBase.listMcpServers(), '加载 MCP 状态');
  if (r.ok) renderMcp(r.data.servers || []);
}
function renderMcp(servers) {
  el.mcpList.innerHTML = '';
  if (!servers.length) {
    el.mcpList.appendChild(h('div', 'mcp-empty', 'MCP：未配置（编辑项目根目录 mcp.json 后重启）'));
    return;
  }
  for (const s of servers) {
    const dot = h('span', 'mcp-dot ' + (s.state || ''));
    dot.title = (s.error ? s.error + ' · ' : '') + 'state=' + s.state;
    const name = h('span', 'mcp-name', s.name);
    const tools = h('span', 'mcp-tools', s.state === 'connected' ? (s.toolCount + ' 工具') : s.state);
    el.mcpList.appendChild(h('div', 'mcp-item')).append(dot, name, tools);
  }
}
function onMcpStatus(p) {
  log('mcp-status-changed', p);
  // 推送可能是单个 server 的增量，也可能是全量：合并进已有列表
  const incoming = Array.isArray(p?.servers) ? p.servers : [];
  if (incoming.length && incoming[0].toolCount !== undefined && p.full !== false) renderMcp(incoming);
  else loadMcp();
}

/* ================= [5.7] Provider 动态列表（v0.2） ================= */
async function loadProviders() {
  const r = await invoke(window.agentBase.listProviders(), '加载 Provider 列表');
  if (!r.ok) return;
  el.providerOptions.innerHTML = '';
  for (const p of r.data.providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.label = p.label + (p.requiresBaseUrl ? '（需填 Base URL）' : '');
    el.providerOptions.appendChild(opt);
  }
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
  if (api.protocolVersion !== 2) {
    toast('UI 与底座协议版本不一致（预期 2），可能出现字段缺失', 'info');
  }
  api.on('message-chunk', onChunk);
  api.on('tool-started', onToolStart);
  api.on('tool-result', onToolResult);
  api.on('approval-required', onApproval);
  api.on('loop-done', onLoopDone);
  api.on('loop-error', onLoopErr);
  api.on('plugins-changed', onPluginsChanged);
  api.on('sessions-changed', onSessionsChanged);
  api.on('mcp-status-changed', onMcpStatus);
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
  el.sessNew.addEventListener('click', async () => {
    const r = await invoke(window.agentBase.createSession({}), '新建会话');
    if (r.ok && r.data.session) await doSwitchSession(r.data.session.id, { silent: true });
  });
  el.logToggle.addEventListener('click', () => {
    const folded = el.logBody.classList.toggle('collapsed');
    const arrow = el.logToggle.querySelector('.log-arrow');
    if (arrow) arrow.textContent = folded ? '▸' : '▾';
  });
  if (!subscribe()) return;
  loadPlugins();
  loadSessions();
  loadProviders();
  loadMcp();
  toast('加载完成，开始对话吧', 'info');
  el.input.focus();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();