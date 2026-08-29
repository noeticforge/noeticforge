/**
 * ============================================================================
 *  agent-base 渲染进程 — app.js（工作台布局版）
 *  无框架 / 无构建，preload 通过 contextBridge 注入 window.agentBase（协议）
 *  与 window.agentWindow（窗控）。UI 只做「调用 + 订阅推送」。
 *  ----------------------------------------------------------------------------
 *  区块索引：
 *   [0] 常量与状态     [1] 通用工具      [2] Toast        [3] invoke 包装
 *   [4] 下拉菜单       [5] Markdown      [6] 会话侧栏     [7] 对话流（扁平）
 *   [8] 进程卡         [9] 审批弹窗      [10] 策略/模型/力度下拉
 *   [11] 右侧面板      [12] 设置页       [13] 窗口控制    [14] 订阅与初始化
 * ============================================================================
 */
'use strict';

/* ================= [0] 常量与状态 ================= */
const $ = (s) => document.querySelector(s);
const el = {
  // 侧栏
  sessionList: $('#session-list'), sessionEmpty: $('#session-empty'), searchInput: $('#session-search'),
  btnNewSession: $('#btn-new-session'), btnOpenSettings: $('#btn-open-settings'),
  // 顶栏
  chatTitle: $('#chat-title'), chipProvider: $('#chip-provider'), btnTogglePanel: $('#btn-toggle-panel'),
  winMin: $('#win-min'), winMax: $('#win-max'), winClose: $('#win-close'),
  // 对话
  messages: $('#messages'), input: $('#message-input'), sendBtn: $('#send-btn'),
  // 进程卡
  statusCard: $('#status-card'), scCount: $('#sc-count'), scItems: $('#sc-items'),
  scElapsed: $('#sc-elapsed'), scStop: $('#sc-stop'),
  // 思考行
  thinking: $('#thinking'), thinkingText: $('#thinking-text'),
  // 输入框下拉
  btnPlus: $('#btn-plus'), btnPolicy: $('#btn-policy'), btnModel: $('#btn-model'),
  btnEffort: $('#btn-effort'), modelLbl: $('#model-lbl'),
  // 审批
  apvModal: $('#approval-modal'), apvName: $('#apv-tool-name'), apvReason: $('#apv-reason'),
  apvReasonInput: $('#apv-reason-input'), apvTable: $('#apv-args-table'),
  apvTBody: $('#apv-args-table').querySelector('tbody'), apvRaw: $('#apv-args-raw'),
  apvOk: $('#apv-approve-btn'), apvNo: $('#apv-reject-btn'), apvDiff: $('#apv-diff'),
  // 右侧面板
  rightPanel: $('#right-panel'), rpClose: $('#rp-close'), rpEvents: $('#rp-events'),
  rpAudit: $('#rp-audit'), rpAuditList: $('#rp-audit-list'), rpAuditMeta: $('#rp-audit-meta'),
  rpRefreshAudit: $('#rp-refresh-audit'), termOut: $('#term-out'), termIn: $('#term-in'),
  attachChips: $('#attach-chips'),
  // 设置页
  settingsView: $('#settings-view'), setBack: $('#set-back'),
  // toast
  toastBox: $('#toast-box'),
};
const dropdownRoot = $('#dropdown-root');

const st = {
  busy: false, currentSessionId: null, sessions: [], appInfo: null, selectedProvider: null,
  tools: new Map(),            // toolCallId -> { row, t0, name, args, statusEl, outBox, output }
  thinkT0: 0, thinkTimer: null, thinkLive: false,
  scT0: 0, scTimer: null, scToolCount: 0, scDone: 0,
  pending: null, activeMenu: null,
  currentAssistant: null,      // 当前 message 的正文块
  currentMessageId: null,
  attachments: [],             // 待发送附件 [{name,kind,mediaType,data?,text?}]
  termStarted: false,
};
const OUT_LIMIT = 200;
const POLICY_LABEL = { 'ask-before-change': '变更前确认', 'auto-edit': '自动编辑', plan: '计划模式', full: '完全访问' };
const EFFORT_LABEL = { low: '低', medium: '高', high: '最高' };

/* ================= [1] 通用工具 ================= */
const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch (_e) { return String(v); }
}
const trunc = (s, n = OUT_LIMIT) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
function pretty(v) {
  if (v == null) return '{}';
  if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch (_e) { return v; } }
  try { return JSON.stringify(v, null, 2); } catch (_e) { return String(v); }
}
function argsSummary(args) {
  try {
    const o = typeof args === 'string' ? JSON.parse(args) : args;
    const keys = o && typeof o === 'object' ? Object.keys(o) : [];
    if (!keys.length) return '';
    return keys.slice(0, 2).map((k) => {
      const v = o[k];
      // 多行字符串（如写文件的 content）显示行数而非内容
      if (typeof v === 'string' && v.includes('\n')) return `${k}=[${v.split('\n').length} 行]`;
      return `${k}=${trunc(String(v).replace(/\s+/g, ' '), 24)}`;
    }).join('  ');
  } catch (_e) { return trunc(String(args), 40); }
}
function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  return Math.floor(diff / 86_400_000) + ' 天前';
}
const scrollBottom = () => { el.messages.scrollTop = el.messages.scrollHeight; };
const autoGrow = () => { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px'; };

/* ================= [2] Toast ================= */
function toast(text, type = 'err') {
  const n = h('div', 'toast toast-' + type, text);
  el.toastBox.appendChild(n);
  setTimeout(() => n.classList.add('toast-out'), 3200);
  setTimeout(() => n.remove(), 3600);
}

/* ================= [3] invoke 统一包装 ================= */
const ERR_TEXT = {
  E_INVALID_MESSAGE: '消息不合法：必须是内容非空的用户消息',
  E_LOOP_BUSY: '当前会话有循环正在运行，请先停止或等待其完成',
  E_NO_PENDING_APPROVAL: '没有待审批的工具调用',
  E_LLM_ERROR: '模型调用出错',
  E_MAX_ITERATIONS: '已达到最大迭代次数，循环终止',
  E_INTERNAL: '后端内部错误',
  E_PROVIDER_NOT_CONFIGURED: '尚未配置模型，请在「模型设置」中填写 API Key',
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
    if (e.code === 'E_PROVIDER_NOT_CONFIGURED') openSettings('models');
    return { ok: false, data: null, error: e };
  }
  return { ok: true, data: res ? res.data : null };
}

/* ================= [4] 下拉菜单组件 ================= */
let menuSeq = 0; // @ 选择器竞态守卫：只有最新一次请求才允许渲染菜单
function closeMenu() {
  dropdownRoot.innerHTML = '';
  st.activeMenu = null;
  menuSeq++;
  document.removeEventListener('mousedown', onMenuDocDown);
  window.removeEventListener('resize', closeMenu);
}
function onMenuDocDown(e) {
  if (st.activeMenu && !st.activeMenu.contains(e.target) && !e.target.closest('.pill') && !e.target.closest('.round-btn')) closeMenu();
}
/** items: '-' 分隔线；{head:'..'} 小标题；{ico,label,sub,active,onClick} */
function openMenu(anchor, items) {
  closeMenu();
  const menu = h('div', 'menu');
  for (const it of items) {
    if (it === '-') { menu.appendChild(h('div', 'menu-sep')); continue; }
    if (it.head) { menu.appendChild(h('div', 'menu-head', it.head)); continue; }
    const b = h('button', 'menu-item');
    if (it.ico) b.appendChild(h('span', 'mi-ico', it.ico));
    const main = h('span', 'mi-main', it.label);
    if (it.sub) main.appendChild(h('span', 'mi-sub', it.sub));
    b.appendChild(main);
    if (it.active) b.appendChild(h('span', 'mi-check', '✓'));
    b.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
    menu.appendChild(b);
  }
  dropdownRoot.appendChild(menu);
  st.activeMenu = menu;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = Math.min(r.left, window.innerWidth - mw - 14);
  let y = r.bottom + 8;
  if (y + mh > window.innerHeight - 14) y = Math.max(12, r.top - mh - 8);
  menu.style.left = Math.max(10, x) + 'px';
  menu.style.top = y + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', onMenuDocDown);
    window.addEventListener('resize', closeMenu);
  }, 0);
}

/* ================= [5] Markdown ================= */
function renderMarkdown(text) {
  const plain = () => { const d = h('div', 'stream-content'); d.textContent = text; return d; };
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return plain();
  try {
    const d = h('div', 'stream-content md');
    d.innerHTML = DOMPurify.sanitize(marked.parse(String(text ?? '')));
    return d;
  } catch (_e) { return plain(); }
}

/* ================= [6] 会话侧栏 ================= */
function filteredSessions() {
  const q = (el.searchInput.value || '').trim().toLowerCase();
  if (!q) return st.sessions;
  return st.sessions.filter((s) => (s.title || '').toLowerCase().includes(q));
}
function renderSessions() {
  const list = filteredSessions();
  el.sessionList.innerHTML = '';
  el.sessionEmpty.classList.toggle('hidden', list.length > 0);
  el.sessionEmpty.textContent = st.sessions.length ? '没有匹配的会话' : '暂无会话';
  for (const s of list) {
    const item = h('div', 'session-item' + (s.id === st.currentSessionId ? ' active' : ''));
    item.appendChild(h('span', 'ico-folder', '🗄'));
    const main = h('div', 'session-main');
    main.appendChild(h('span', 'session-name', s.title || '未命名会话'));
    main.appendChild(h('span', 'session-time', relTime(s.updatedAt) + ' · ' + (s.messageCount || 0) + ' 条'));
    item.appendChild(main);
    const ops = h('div', 'session-ops');
    const rn = h('button', 'btn-mini', '改');
    const del = h('button', 'btn-mini', '删');
    ops.append(rn, del);
    item.appendChild(ops);
    el.sessionList.appendChild(item);
    item.addEventListener('click', () => doSwitchSession(s.id));
    rn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Electron 不支持 window.prompt：用内联输入改名
      const old = s.title || '';
      const nameSpan = item.querySelector('.session-name');
      nameSpan.style.display = 'none';
      const editor = h('input');
      editor.value = old;
      editor.style.cssText = 'flex:1;min-width:0;background:var(--field-bg);border:1px solid var(--active-border);border-radius:6px;padding:2px 6px;font-size:12px;outline:none';
      main.insertBefore(editor, nameSpan);
      editor.focus(); editor.select();
      const commit = async () => {
        const title = editor.value.trim();
        editor.remove();
        nameSpan.style.display = '';
        if (title && title !== old) await invoke(window.agentBase.renameSession({ id: s.id, title }), '重命名会话');
      };
      editor.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { editor.value = old; commit(); }
      });
      editor.addEventListener('blur', commit);
    });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除会话「' + (s.title || s.id) + '」？历史不可恢复。')) return;
      const r = await invoke(window.agentBase.deleteSession({ id: s.id }), '删除会话');
      if (r.ok && st.currentSessionId === s.id) {
        st.currentSessionId = null;
        const rest = st.sessions.filter((x) => x.id !== s.id);
        if (rest.length) await doSwitchSession(rest[0].id, { silent: true });
        else { resetChatView(); el.chatTitle.textContent = 'agent-base'; }
      }
    });
  }
}
async function loadSessions() {
  const r = await invoke(window.agentBase.listSessions(), '加载会话');
  if (!r.ok) return;
  st.sessions = r.data.sessions;
  if (!st.currentSessionId && st.sessions.length) {
    await doSwitchSession(st.sessions[0].id, { silent: true });
  } else {
    renderSessions();
  }
}
async function doSwitchSession(id, opts = {}) {
  if (st.busy && !opts.silent) { toast(ERR_TEXT.E_LOOP_BUSY); return; }
  const r = await invoke(window.agentBase.switchSession({ id }), '切换会话');
  if (!r.ok) return;
  st.currentSessionId = id;
  el.chatTitle.textContent = r.data.session.title || 'agent-base';
  renderHistory(r.data.session.messages || []);
  renderSessions();
  if (!opts.silent) toast('已切换会话', 'info');
}
async function newSession() {
  const r = await invoke(window.agentBase.createSession({}), '新建会话');
  if (r.ok && r.data.session) {
    st.currentSessionId = r.data.session.id;
    el.chatTitle.textContent = r.data.session.title || '新的会话';
    resetChatView();
    renderSessions();
    el.searchInput.value = '';
    el.input.focus();
  }
}
function resetChatView() {
  el.messages.innerHTML = '';
  ensureMsgCol();
  st.tools.clear();
  st.currentAssistant = null;
  st.currentMessageId = null;
  stopThink();
  hideStatusCard();
}
function onSessionsChanged(p) {
  st.sessions = (p && p.sessions) || [];
  renderSessions();
  const cur = st.sessions.find((s) => s.id === st.currentSessionId);
  if (cur) el.chatTitle.textContent = cur.title || 'agent-base';
}

/* ================= [7] 对话流（扁平文档流） ================= */
let msgCol = null;
function ensureMsgCol() {
  if (!msgCol || !msgCol.isConnected) {
    msgCol = h('div', 'msg-col');
    el.messages.appendChild(msgCol);
  }
  return msgCol;
}
function addUserBlock(content, opts = {}) {
  ensureMsgCol();
  const block = h('div', 'msg-block-user');
  // 多模态内容：文本分片 + 图片占位
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p.type === 'text') block.appendChild(document.createTextNode(p.text));
      else block.appendChild(h('span', 'queued-badge', '🖼 图片'));
    }
  } else {
    block.appendChild(document.createTextNode(content));
  }
  if (opts.attachments?.length) {
    for (const a of opts.attachments) {
      block.appendChild(h('span', 'queued-badge', (a.kind === 'image' ? '🖼 ' : '📎 ') + a.name));
    }
  }
  if (opts.queuedBadge) block.appendChild(h('span', 'queued-badge', '已排队'));
  msgCol.appendChild(block);
  msgCol.appendChild(h('div', 'msg-gap'));
  scrollBottom();
  return block;
}
/** 助手正文块（流式追加；loop-done 后转 Markdown） */
function ensureAssistantBlock(messageId) {
  ensureMsgCol();
  if (st.currentMessageId !== messageId || !st.currentAssistant || !st.currentAssistant.isConnected) {
    st.currentMessageId = messageId;
    st.currentAssistant = h('div', 'msg-block-assistant');
    const sc = h('div', 'stream-content');
    st.currentAssistant.appendChild(sc);
    msgCol.appendChild(st.currentAssistant);
    msgCol.appendChild(h('div', 'msg-gap'));
  }
  return st.currentAssistant.firstChild;
}
/** 工具活动行（扁平内联） */
function addToolRow(toolCallId, name, args) {
  ensureMsgCol();
  const row = h('div', 'tool-row pending');
  const head = h('div', 'tool-row-head');
  const ico = h('span', 't-ico', '◌');
  const nm = h('span', 't-name', name);
  const sum = h('span', 't-summary', argsSummary(args));
  const dur = h('span', 't-dur', '');
  head.append(ico, nm, sum, dur);  row.appendChild(head);
  const out = h('div', 'tool-row-output hidden');
  row.appendChild(out);
  msgCol.appendChild(row);
  msgCol.appendChild(h('div', 'msg-gap'));
  st.tools.set(toolCallId, { row, ico, dur, out, sum, name, t0: Date.now(), output: '', ok: null });
  row.addEventListener('click', () => {
    if (!out.textContent && st.tools.get(toolCallId)) {
      out.textContent = '';
      out.appendChild(h('pre', null, trunc(st.tools.get(toolCallId).output || '（无输出）', 4000)));
    }
    out.classList.toggle('hidden');
    scrollBottom();
  });
  scrollBottom();
  return row;
}
function finishToolRow(toolCallId, result) {
  const t = st.tools.get(toolCallId);
  if (!t) return;
  t.ok = !!result.ok;
  const ms = Date.now() - t.t0;
  t.row.classList.remove('pending');
  t.row.classList.add(t.ok ? 'tool-row-ok' : 'tool-row-fail');
  t.ico.textContent = t.ok ? '✓' : '✗';
  t.dur.textContent = (ms / 1000).toFixed(1) + 's';
  // 失败时把错误码直接亮在行上（用户不用展开就能看到拒绝原因）
  if (!t.ok && result.error) t.sum.textContent += ' · ' + result.error;
  t.output = result.output || '';
  if (result.render === 'markdown' && typeof marked !== 'undefined') {
    t.out.classList.remove('hidden');
    t.out.appendChild(renderMarkdown(trunc(t.output, 4000)));
  }
  scrollBottom();
}
/** 思考行：等待模型响应的耗时（实时秒表） */
function startThink() {
  stopThink();
  st.thinkT0 = Date.now();
  el.thinking.classList.remove('hidden');
  el.thinking.classList.add('live');
  const tick = () => {
    el.thinkingText.textContent = '思考 · ' + ((Date.now() - st.thinkT0) / 1000).toFixed(0) + ' 秒';
    st.thinkTimer = setTimeout(tick, 500);
  };
  tick();
}
function stopThink(final) {
  if (st.thinkTimer) { clearTimeout(st.thinkTimer); st.thinkTimer = null; }
  el.thinking.classList.remove('live');
  if (final === false) { el.thinking.classList.add('hidden'); return; }
}
function freezeThink() {
  if (st.thinkTimer) {
    clearTimeout(st.thinkTimer);
    st.thinkTimer = null;
    el.thinking.classList.remove('live');
    el.thinkingText.textContent = '思考 · 持续了 ' + ((Date.now() - st.thinkT0) / 1000).toFixed(0) + ' 秒';
  }
}
function setBusy(busy) {
  st.busy = busy;
  // 发送按钮保持可用：忙碌时发送 = 排队（后端 queued）
  el.input.placeholder = busy ? '循环进行中，继续输入将自动排队…' : '输入消息，Enter 发送，Shift+Enter 换行；@ 引用文件';
}

/* ================= [8] 进程卡 ================= */
function showStatusCard() {
  st.scT0 = Date.now();
  st.scToolCount = 0;
  st.scDone = 0;
  el.scItems.innerHTML = '';
  el.scCount.textContent = '0/0';
  el.statusCard.classList.remove('hidden');
  const tick = () => {
    el.scElapsed.textContent = '已运行 ' + ((Date.now() - st.scT0) / 1000).toFixed(0) + ' 秒';
    st.scTimer = setTimeout(tick, 500);
  };
  tick();
}
function scAddTool(name, toolCallId) {
  st.scToolCount += 1;
  el.scCount.textContent = st.scDone + '/' + st.scToolCount;
  const item = h('div', 'sc-item run');
  item.appendChild(h('span', 's-ico', '◌'));
  item.appendChild(h('span', 's-lbl', name));
  el.scItems.appendChild(item);
  while (el.scItems.children.length > 6) el.scItems.firstChild.remove();
  item.dataset.tcid = toolCallId; // 按 toolCallId 精确配对（内外层同名工具不互串）
  return item;
}
function scDoneTool(toolCallId, ok) {
  st.scDone += 1;
  el.scCount.textContent = st.scDone + '/' + st.scToolCount;
  const items = [...el.scItems.children];
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].dataset.tcid === toolCallId && items[i].classList.contains('run')) {
      items[i].classList.remove('run');
      items[i].classList.add('done');
      items[i].querySelector('.s-ico').textContent = ok ? '✓' : '✗';
      break;
    }
  }
}
function hideStatusCard() {
  if (st.scTimer) { clearTimeout(st.scTimer); st.scTimer = null; }
  el.statusCard.classList.add('hidden');
}

/* ================= [9] 发送 / 事件处理 / 审批 ================= */
/** 发送：组装 @ 引用与附件 → sendMessage（多模态分片） */
async function handleSend() {
  const raw = el.input.value;
  const text = raw.trim();
  if (!text && !st.attachments.length) return;
  // 忙碌时不再拒绝：交给后端排队（queued），循环结束按序续发
  if (!st.currentSessionId) { toast('请先新建或选择一个会话'); return; }
  const wasBusy = st.busy;
  // @ 引用：文本里保留 @path（可读），内容注入由后端完成
  const contextFiles = [...new Set([...text.matchAll(/@([^\s，。；）】]+)/g)].map((m) => m[1]))].slice(0, 5);
  // 附件 → 多模态分片
  let message;
  const atts = st.attachments.splice(0);
  renderAttachChips();
  el.input.value = ''; autoGrow();
  addUserBlock(text, { attachments: atts, queuedBadge: wasBusy });
  if (!wasBusy) {
    setBusy(true);
    startThink();
    showStatusCard();
  }
  if (atts.length) {
    const parts = [{ type: 'text', text }];
    for (const a of atts) {
      parts.push(a.kind === 'image'
        ? { type: 'image', mediaType: a.mediaType, data: a.data }
        : { type: 'text', text: `【附件：${a.name}】\n${a.text}` });
    }
    message = { message: { role: 'user', content: parts }, sessionId: st.currentSessionId };
  } else {
    message = { message: { role: 'user', content: text }, sessionId: st.currentSessionId };
  }
  if (contextFiles.length) message.contextFiles = contextFiles;
  const r = await invoke(window.agentBase.sendMessage(message), '发送消息');
  if (!r.ok) {
    // 失败回滚：附件与文本还给输入框，避免用户重打
    st.attachments.unshift(...atts);
    renderAttachChips();
    el.input.value = text;
    autoGrow();
    setBusy(wasBusy);
    if (!wasBusy) { stopThink(false); hideStatusCard(); }
    return;
  }
  if (r.data?.queued) {
    const blocks = msgCol.querySelectorAll('.msg-block-user');
    const last = blocks[blocks.length - 1];
    if (last && !last.querySelector('.queued-badge')) last.appendChild(h('span', 'queued-badge', '已排队'));
  }
}
function isCurrentSession(p) {
  return !st.currentSessionId || !p.sessionId || p.sessionId === st.currentSessionId;
}
function onChunk(p) {
  logEvent('message-chunk', p);
  if (!isCurrentSession(p)) return;
  if (!p.delta) return;
  freezeThink();
  ensureAssistantBlock(p.messageId).textContent += p.delta;
  scrollBottom();
}
function onToolStart(p) {
  logEvent('tool-started', p);
  if (!isCurrentSession(p)) return;
  freezeThink();
  addToolRow(p.toolCallId, p.name, p.arguments);
  scAddTool(p.name, p.toolCallId);
}
function onToolResult(p) {
  logEvent('tool-result', p);
  if (!isCurrentSession(p)) return;
  const t = st.tools.get(p.toolCallId);
  if (!t) {
    // 权限拒绝 / 工具不存在等场景没有 tool-started 前置行——必须给用户可见的失败反馈
    ensureMsgCol();
    const row = h('div', 'tool-row tool-row-fail');
    const head = h('div', 'tool-row-head');
    const d = p.result || {};
    head.append(
      h('span', 't-ico', '✗'),
      h('span', 't-name', '工具未执行'),
      h('span', 't-summary', trunc(d.output || d.error || '被底座拦截', 90)),
      h('span', 't-dur', d.error || ''),
    );
    row.appendChild(head);
    const out = h('div', 'tool-row-output hidden');
    row.appendChild(out);
    row.addEventListener('click', () => {
      if (!out.textContent) out.appendChild(h('pre', null, trunc(toText(d.output), 4000)));
      out.classList.toggle('hidden');
      scrollBottom();
    });
    msgCol.appendChild(row);
    msgCol.appendChild(h('div', 'msg-gap'));
    scrollBottom();
    return;
  }
  finishToolRow(p.toolCallId, p.result || {});
  scDoneTool(p.toolCallId, !!(p.result && p.result.ok));
  // 工具结果已回喂，模型继续思考
  if (st.busy) startThink();
}
function onLoopDone(p) {
  logEvent('loop-done', p);
  if (!isCurrentSession(p)) return;
  freezeThink();
  const block = st.currentMessageId === p.messageId ? st.currentAssistant : null;
  const contentEl = block ? block.firstChild : null;
  if (contentEl && p.content && !contentEl.textContent) contentEl.textContent = p.content;
  if (contentEl && contentEl.textContent) {
    const md = renderMarkdown(contentEl.textContent);
    contentEl.replaceWith(md);
  }
  setBusy(false);
  hideStatusCard();
  if (p.stopped) toast('已停止生成', 'info');
  loadSessions(); // 时间戳/标题可能变了
}
function onLoopErr(p) {
  logEvent('loop-error', p);
  if (!isCurrentSession(p)) return;
  freezeThink();
  hideStatusCard();
  setBusy(false);
  const e = p.error || {};
  ensureMsgCol();
  const row = h('div', 'tool-row tool-row-fail');
  row.appendChild(h('div', 'tool-row-head', null)).append(
    h('span', 't-ico', '⛔'), h('span', 't-name', '循环出错'),
    h('span', 't-summary', [e.code, e.message].filter(Boolean).join(' · ')),
  );
  msgCol.appendChild(row);
  scrollBottom();
}
function onApproval(p) {
  logEvent('approval-required', p);
  if (!isCurrentSession(p)) return;
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
    keys.forEach((k) => {
      const tr = document.createElement('tr');
      tr.appendChild(h('td', 'arg-key', k));
      // 值可编辑：批准时收集修改后的参数（协议的改参批准能力）
      const val = h('td', 'arg-val', toText(parsed[k]));
      val.contentEditable = 'true';
      val.spellcheck = false;
      val.dataset.key = k;
      val.dataset.orig = toText(parsed[k]);
      tr.appendChild(val);
      el.apvTBody.appendChild(tr);
    });
    el.apvTable.classList.remove('hidden'); el.apvRaw.classList.add('hidden');
  } else {
    el.apvTable.classList.add('hidden');
    el.apvRaw.textContent = args == null ? '（无参数）' : trunc(toText(args));
    el.apvRaw.classList.remove('hidden');
  }
  el.apvModal.classList.remove('hidden');
  el.apvOk.disabled = false; el.apvNo.disabled = false;
  renderApprovalDiff(name, parsed);
}
/** 写文件审批的 diff 预览：读取现有内容 → 行级差异（新文件显示行数徽标） */
async function renderApprovalDiff(name, parsedArgs) {
  const box = el.apvDiff = el.apvDiff || $('#apv-diff');
  box.classList.add('hidden');
  box.innerHTML = '';
  if (name !== 'write-file.write' || !window.agentBase?.previewFile) return;
  const targetPath = parsedArgs && typeof parsedArgs === 'object' ? String(parsedArgs.path ?? '') : '';
  if (!targetPath) return;
  const r = await invoke(window.agentBase.previewFile({ path: targetPath }), '读取文件预览');
  if (!r.ok) return;
  const newContent = typeof parsedArgs.content === 'string' ? parsedArgs.content : '';
  const newLines = newContent.split('\n');
  const head = h('div', 'apv-diff-head');
  if (!r.data.exists) {
    head.append(h('span', 'diff-new', `新文件`), h('span', null, targetPath), h('span', 'diff-stat-add', `+${newLines.length} 行`));
    box.append(head);
    const body = h('div', 'apv-diff-body');
    newLines.slice(0, 200).forEach((tx) => body.appendChild(diffRow('add', tx, '')));
    if (newLines.length > 200) body.appendChild(h('div', 'diff-more', `…其余 ${newLines.length - 200} 行`));
    box.appendChild(body);
    box.classList.remove('hidden');
    return;
  }
  const oldLines = r.data.content.split('\n');
  const diff = lineDiff(oldLines, newLines);
  if (!diff) return; // 文件过大，退回纯参数表
  const addCount = diff.filter((d) => d[0] === 'add').length;
  const delCount = diff.filter((d) => d[0] === 'del').length;
  head.append(h('span', null, targetPath), h('span', 'diff-stat-add', `+${addCount}`), h('span', 'diff-stat-del', `−${delCount}`));
  box.append(head);
  const body = h('div', 'apv-diff-body');
  let oldNo = 0, newNo = 0;
  const MAX_ROWS = 400;
  let shown = 0, omitted = 0;
  for (const [kind, tx] of diff) {
    if (kind === 'ctx' && shown > 60 && shown < diff.length - 10) { omitted++; oldNo++; newNo++; continue; } // 中段上下文折叠
    if (shown >= MAX_ROWS) { omitted++; if (kind === 'del') oldNo++; else if (kind === 'add') newNo++; else { oldNo++; newNo++; } continue; }
    if (kind === 'del') { oldNo++; body.appendChild(diffRow(kind, tx, String(oldNo))); }
    else if (kind === 'add') { newNo++; body.appendChild(diffRow(kind, tx, String(newNo))); }
    else { oldNo++; newNo++; body.appendChild(diffRow(kind, tx, String(newNo))); }
    shown++;
  }
  if (omitted > 0) body.appendChild(h('div', 'diff-more', `…省略 ${omitted} 行`));
  box.appendChild(body);
  box.classList.remove('hidden');
}
function diffRow(kind, text, lineNo) {
  const row = h('div', 'dl ' + kind);
  row.appendChild(h('span', 'no', lineNo));
  row.appendChild(h('span', 'sign', kind === 'add' ? '+' : kind === 'del' ? '−' : ' '));
  row.appendChild(h('span', 'tx', text.length > 500 ? text.slice(0, 500) + '…' : text));
  return row;
}
/** 简单 LCS 行级 diff；规模超限返回 null（避免 O(n·m) 爆内存） */
function lineDiff(oldLines, newLines) {
  const n = oldLines.length, m = newLines.length;
  if (n * m > 400_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { out.push(['ctx', oldLines[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', oldLines[i]]); i++; }
    else { out.push(['add', newLines[j]]); j++; }
  }
  while (i < n) out.push(['del', oldLines[i++]]);
  while (j < m) out.push(['add', newLines[j++]]);
  return out;
}
async function onApprove() {
  const r = st.pending;
  if (!r) return;
  el.apvOk.disabled = true; el.apvNo.disabled = true;
  // 收集审批表全部参数（可编辑；批准时按"修改后的完整参数"整体替换——协议 §3.2）
  const edited = {};
  let hasEdit = false;
  el.apvTBody.querySelectorAll('td.arg-val[data-key]').forEach((td) => {
    const key = td.dataset.key;
    const now = td.innerText.replace(/\n$/, '');
    const orig = td.dataset.orig;
    if (now !== orig) hasEdit = true;
    // 按原值类型还原：数字/布尔保持类型，其余为字符串
    let value = now;
    if (orig !== '') {
      try {
        const parsedOrig = JSON.parse(orig);
        if (typeof parsedOrig === 'number') value = Number.isNaN(Number(now)) ? now : Number(now);
        else if (typeof parsedOrig === 'boolean') value = now === 'true';
      } catch { /* 原值为字符串 */ }
    }
    edited[key] = value;
  });
  const req = { messageId: r.messageId, toolCallId: r.toolCallId };
  if (hasEdit) req.arguments = edited; // arguments 为整体替换，必须携带全部字段
  await invoke(window.agentBase.approveTool(req), '批准工具');
  el.apvModal.classList.add('hidden');
  st.pending = null;
}
async function onReject() {
  const r = st.pending;
  if (!r) return;
  const reason = el.apvReasonInput.value.trim();
  el.apvOk.disabled = true; el.apvNo.disabled = true;
  await invoke(window.agentBase.rejectTool({ messageId: r.messageId, toolCallId: r.toolCallId, reason: reason || undefined }), '拒绝工具');
  el.apvModal.classList.add('hidden');
  st.pending = null;
}
/** 从会话消息数组重建扁平对话流 */
function renderHistory(messages) {
  resetChatView();
  const toolOutput = new Map();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) toolOutput.set(m.toolCallId, m.content);
  }
  for (const m of messages) {
    if (m.role === 'user') { addUserBlock(m.content); continue; }    if (m.role === 'assistant') {
      if (m.content) {
        ensureMsgCol();
        const block = h('div', 'msg-block-assistant');
        block.appendChild(renderMarkdown(m.content));
        msgCol.appendChild(block);
        msgCol.appendChild(h('div', 'msg-gap'));
      }
      for (const call of m.toolCalls ?? []) {
        const out = toolOutput.get(call.id);
        addToolRow(call.id, call.name, call.arguments);
        finishToolRow(call.id, { ok: out !== undefined, output: out ?? '（历史记录无输出）' });
        if (out === undefined) {
          const t = st.tools.get(call.id);
          if (t) { t.ico.textContent = '·'; t.row.classList.remove('tool-row-fail'); }
        }
      }
    }
  }
  st.currentAssistant = null;
  st.currentMessageId = null;
  scrollBottom();
}

/* ================= [10] 策略 / 模型 / 力度 下拉 ================= */
async function refreshAppInfo() {
  const r = await invoke(window.agentBase.getAppInfo(), '加载应用信息');
  if (r.ok) {
    st.appInfo = r.data.info;
    renderIdentity();
  }
}
function renderIdentity() {
  const info = st.appInfo;
  if (!info) return;
  el.chipProvider.classList.remove('hidden');
  el.chipProvider.textContent = info.provider ? `${info.provider} · ${info.models[0] || info.model || '默认模型'}` : '未配置模型';
  el.modelLbl.textContent = info.models[0] || (info.provider ? '默认模型' : '未配置');
  el.btnPolicy.querySelector('.pill-lbl').textContent = POLICY_LABEL[info.permissionMode] || '完全访问';
  el.btnPolicy.classList.toggle('pill-warn', info.permissionMode === 'full');
  el.btnEffort.querySelector('.pill-lbl').textContent = info.reasoningEffort ? EFFORT_LABEL[info.reasoningEffort] : '默认';
}
function openPolicyMenu() {
  const mode = st.appInfo?.permissionMode || 'full';
  openMenu(el.btnPolicy, [
    { head: '权限模式' },
    { ico: '🖐', label: '变更前确认', sub: '改文件、执行命令前先问我', active: mode === 'ask-before-change', onClick: () => applyPolicy('ask-before-change') },
    { ico: '✎', label: '自动编辑', sub: '自动写文件；执行命令仍需批准', active: mode === 'auto-edit', onClick: () => applyPolicy('auto-edit') },
    { ico: '◫', label: '计划模式', sub: '只读：写 / 执行 / 联网被策略拒绝', active: mode === 'plan', onClick: () => applyPolicy('plan') },
    { ico: '⚡', label: '完全访问', sub: '不额外限制（插件声明的审批仍生效）', active: mode === 'full', onClick: () => applyPolicy('full') },
  ]);
}
async function applyPolicy(mode) {
  const r = await invoke(window.agentBase.setAgentPolicy({ permissionMode: mode }), '切换权限模式');
  if (r.ok) { toast('权限模式：' + POLICY_LABEL[mode], 'ok'); await refreshAppInfo(); }
}
function openModelMenu() {
  const info = st.appInfo;
  if (!info) return;
  const items = [{ head: '模型（供应商：' + (info.provider || '未配置') + '）' }];
  if (info.models.length) {
    for (const m of info.models) {
      items.push({
        ico: '◈', label: m, active: m === info.models[0],
        onClick: async () => {
          const r = await invoke(window.agentBase.setModelConfig({ config: { provider: info.provider, model: m } }), '切换模型');
          if (r.ok) { toast('已切换模型：' + m, 'ok'); await refreshAppInfo(); }
        },
      });
    }
  } else {
    items.push({ ico: '＋', label: '在设置中添加模型', onClick: () => openSettings('models') });
  }
  items.push('-', { ico: '⚙', label: '管理模型', onClick: () => openSettings('models') });
  openMenu(el.btnModel, items);
}
function openEffortMenu() {
  const cur = st.appInfo?.reasoningEffort;
  const items = [{ head: '推理力度（透传模型 reasoning 参数）' }];
  for (const key of ['low', 'medium', 'high']) {
    items.push({
      ico: '◎', label: EFFORT_LABEL[key],
      active: cur === key,
      onClick: async () => {
        const r = await invoke(window.agentBase.setAgentPolicy({ reasoningEffort: key }), '调整推理力度');
        if (r.ok) { toast('推理力度：' + EFFORT_LABEL[key] + (st.appInfo?.provider === 'anthropic' ? '' : '（OpenAI 兼容端点需 config.json 开启 enableReasoningEffort）'), 'ok'); await refreshAppInfo(); }
      },
    });
  }
  items.push({
    ico: '○', label: '默认', sub: '不透传参数，由模型默认行为决定',
    active: !cur,
    onClick: () => toast('当前为默认（不透传）。设置推理力度后即自动透传。', 'info'),
  });
  openMenu(el.btnEffort, items);
}
function openPlusMenu() {
  openMenu(el.btnPlus, [
    { ico: '📎', label: '添加附件', sub: '文本或图片（≤4 个）', onClick: pickAttachments },
    { ico: '⊕', label: '新建会话', onClick: newSession },
    '-',
    { ico: '◈', label: '管理模型', onClick: () => openSettings('models') },
    { ico: '⇄', label: 'MCP 服务器', onClick: () => openSettings('mcp') },
    { ico: '⬒', label: '插件', onClick: () => openSettings('plugins') },
  ]);
}

/* ================= [10.5] @ 上下文引用选择器 ================= */
const AT_RE = /(^|\s)@([\w\u4e00-\u9fa5\-./\\]*)$/;
/** 输入以 @query 结尾时弹出工作目录文件选择菜单；选中目录继续下钻（带竞态守卫） */
async function maybeOpenAtPicker() {
  const match = el.input.value.match(AT_RE);
  if (!match) { if (st.activeMenu?.dataset?.at === '1') closeMenu(); return; }
  const query = match[2];
  const mySeq = ++menuSeq;
  const r = await invoke(window.agentBase.listWorkspaceFiles({ query }), '搜索文件');
  if (!r.ok) return;
  if (mySeq !== menuSeq) return; // 已有更新的输入事件，丢弃迟到响应
  const files = r.data.files.slice(0, 30);
  if (!files.length) return;
  const items = [{ head: '引用文件（@路径 会注入文件内容）' }];
  for (const f of files) {
    items.push({
      ico: f.isDir ? '📁' : '📄',
      label: '@' + f.rel,
      onClick: () => insertAtSelection(f),
    });
  }
  openMenu(el.input, items);
  st.activeMenu.dataset.at = '1';
}
function insertAtSelection(f) {
  const before = el.input.value.replace(AT_RE, (_m, sp) => sp + '@');
  const insert = f.isDir ? f.rel : f.rel + ' ';
  el.input.value = before + insert;
  el.input.focus();
  if (f.isDir) maybeOpenAtPicker(); // 目录：继续下钻
  autoGrow();
}
/** 附件：选文件 → 读内容/图片 → 芯片展示 → 发送时转多模态分片 */
async function pickAttachments() {
  const r = await invoke(window.agentBase.pickFiles(), '选择附件');
  if (!r.ok || !r.data.paths.length) return;
  for (const p of r.data.paths.slice(0, 4)) {
    const rr = await invoke(window.agentBase.readAttachment({ path: p }), '读取附件');
    if (rr.ok) st.attachments.push(rr.data);
    if (st.attachments.length >= 4) break;
  }
  renderAttachChips();
}
function renderAttachChips() {
  el.attachChips.innerHTML = '';
  el.attachChips.classList.toggle('hidden', !st.attachments.length);
  st.attachments.forEach((a, idx) => {
    const chip = h('span', 'attach-chip');
    chip.appendChild(h('span', null, (a.kind === 'image' ? '🖼 ' : '📎 ') + a.name));
    const del = h('button', 'a-del', '✕');
    del.addEventListener('click', () => { st.attachments.splice(idx, 1); renderAttachChips(); });
    chip.appendChild(del);
    el.attachChips.appendChild(chip);
  });
}

/* ================= [11] 右侧面板：审查（事件流）/ 审计（audit.log）/ 终端 ================= */
function logEvent(name, payload) {
  let json = '';
  try { json = JSON.stringify(payload); } catch (_e) { json = String(payload); }
  if (json.length > 360) json = json.slice(0, 360) + '…';
  const line = '[' + nowTime() + '][' + name + '] ' + json;
  el.rpEvents.prepend(h('div', 'log-item', line));
  while (el.rpEvents.children.length > 300) el.rpEvents.lastChild.remove();
}
async function loadAudit() {
  const r = await invoke(window.agentBase.readAudit({ lines: 200 }), '读取审计日志');
  if (!r.ok) return;
  el.rpAuditMeta.textContent = `共 ${r.data.total} 条，显示最近 ${r.data.lines.length} 条`;
  el.rpAuditList.innerHTML = '';
  for (const line of [...r.data.lines].reverse()) {
    let text = line;
    try {
      const o = JSON.parse(line);
      text = `[${new Date(o.ts).toLocaleString('zh-CN', { hour12: false })}] ${o.type}${o.name ? ' ' + o.name : ''}${o.ok === false ? ' ✗' : ''}${o.error ? ' ' + o.error : ''}${o.decision ? ' ' + o.decision : ''}${o.args ? ' ' + trunc(o.args, 60) : ''}`;
    } catch (_e) { /* 原样显示 */ }
    el.rpAuditList.appendChild(h('div', 'audit-line', text));
  }
}
function toggleRightPanel(show) {
  const willShow = show !== undefined ? show : el.rightPanel.classList.contains('hidden');
  el.rightPanel.classList.toggle('hidden', !willShow);
  if (willShow && !el.rpAudit.classList.contains('hidden')) loadAudit();
  if (willShow && !$('#rp-term').classList.contains('hidden')) startTerminal();
}
/** 终端：首次打开即拉起持久 shell；输出追加到滚动区 */
function startTerminal() {
  if (st.termStarted) return;
  st.termStarted = true;
  window.agentBase.termInput({ command: '' }); // 空命令 = 拉起 shell
  el.termOut.appendChild(h('div', null, '(输入命令后回车执行)'));
  el.termIn.focus();
}
function onTermData(p) {
  const text = p?.text ?? '';
  el.termOut.appendChild(document.createTextNode(text));
  while (el.termOut.childNodes.length > 1500) el.termOut.firstChild.remove();
  el.termOut.scrollTop = el.termOut.scrollHeight;
}

/* ================= [12] 设置页 ================= */
const setPageBuilders = {
  models: renderModelsPage,
  mcp: renderMcpPage,
  plugins: renderPluginsPage,
  appearance: renderAppearancePage,
  general: renderGeneralPage,
};
async function openSettings(page) {
  el.settingsView.classList.remove('hidden');
  document.querySelectorAll('.set-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.set-page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== page));
  const builder = setPageBuilders[page];
  if (builder) await builder();
}
async function renderModelsPage() {
  await refreshAppInfo();
  const info = st.appInfo;
  const provs = await invoke(window.agentBase.listProviders(), '加载 Provider');
  if (!provs.ok) return;
  const list = $('#provider-list');
  list.innerHTML = '';
  if (!st.selectedProvider) {
    st.selectedProvider = info.provider || 'deepseek';
  }
  for (const p of provs.data.providers) {
    const configured = p.id === info.provider;
    const item = h('button', 'provider-item' + (p.id === st.selectedProvider ? ' active' : ''));
    item.appendChild(h('span', null, p.label));
    item.appendChild(h('span', 'p-dot' + (configured ? ' on' : '')));
    item.title = p.id;
    list.appendChild(item);
    item.addEventListener('click', () => { st.selectedProvider = p.id; renderModelsPage(); });
  }
  renderProviderDetail(provs.data.providers.find((p) => p.id === st.selectedProvider));
}
function renderProviderDetail(meta) {
  const info = st.appInfo || { models: [], provider: null, baseUrl: null };
  const isActive = meta && meta.id === info.provider;
  $('#pd-name').textContent = meta ? meta.label : '—';
  const fmt = $('#pd-format');
  fmt.textContent = meta ? (meta.id === 'anthropic' ? 'Anthropic Messages (/v1/messages)' : 'OpenAI 兼容 (/chat/completions)') : '';
  $('#pd-baseurl').value = isActive && info.baseUrl ? info.baseUrl : (meta?.defaultBaseUrl || '');
  $('#pd-baseurl').placeholder = meta?.requiresBaseUrl ? '必填，如 http://127.0.0.1:11434/v1' : '留空使用默认地址';
  $('#pd-apikey').value = '';
  const wrap = $('#pd-models');
  wrap.innerHTML = '';
  const models = isActive && info.models.length ? [...info.models] : (meta?.defaultModel ? [meta.defaultModel] : []);
  models.forEach((m) => wrap.appendChild(modelChip(m, wrap)));
  wrap.dataset.provider = meta ? meta.id : '';
}
function modelChip(name, wrap) {
  const chip = h('div', 'model-chip');
  chip.appendChild(h('span', 'mc-name', name));
  const active = st.appInfo && st.appInfo.models[0] === name && st.selectedProvider === st.appInfo.provider;
  if (active) chip.appendChild(h('span', 'mc-tag', '当前'));
  const del = h('button', 'mc-del', '✕');
  del.title = '移除';
  del.addEventListener('click', () => chip.remove());
  chip.appendChild(del);
  return chip;
}
async function saveProvider() {
  const provider = $('#pd-models').dataset.provider;
  if (!provider) return;
  const models = [...$('#pd-models').querySelectorAll('.mc-name')].map((n) => n.textContent.trim()).filter(Boolean);
  if (!models.length) { toast('至少保留一个模型'); return; }
  const cfg = {
    provider,
    models,
    model: models[0],
  };
  const key = $('#pd-apikey').value.trim();
  if (key) cfg.apiKey = key;
  const baseUrl = $('#pd-baseurl').value.trim();
  if (baseUrl) cfg.baseUrl = baseUrl;
  const r = await invoke(window.agentBase.setModelConfig({ config: cfg }), '保存模型配置');
  if (r.ok) {
    toast('模型配置已保存并启用', 'ok');
    st.selectedProvider = provider;
    await renderModelsPage();
  }
}
async function renderMcpPage() {
  const r = await invoke(window.agentBase.listMcpServers(), '加载 MCP');
  if (!r.ok) return;
  const { servers, config } = r.data;
  const list = $('#mcp-server-list');
  list.innerHTML = '';
  if (!servers.length) list.appendChild(h('div', 'side-placeholder', '暂未配置 MCP 服务器'));
  for (const s of servers) {
    const row = h('div', 'mcp-row');
    row.appendChild(h('span', 'mcp-dot ' + (s.state || '')));
    row.appendChild(h('span', 'mcp-name', s.name));
    row.appendChild(h('span', 'mcp-state', s.state === 'connected' ? `已连接 · ${s.toolCount} 工具` : s.state + (s.error ? ' · ' + s.error : '')));
    const btn = h('button', 'btn-mini', s.state === 'disabled' ? '启用' : '禁用');
    btn.addEventListener('click', async () => {
      const rr = await invoke(window.agentBase.toggleMcpServer({ name: s.name, enabled: s.state === 'disabled' }), '切换 MCP 服务器');
      if (rr.ok) renderMcpPage();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
  $('#mcp-json').value = JSON.stringify({ mcpServers: config }, null, 2);
}
async function saveMcpJson() {
  let parsed;
  try { parsed = JSON.parse($('#mcp-json').value); } catch (_e) { toast('mcp.json 不是合法 JSON'); return; }
  const config = parsed && parsed.mcpServers ? parsed.mcpServers : parsed;
  const r = await invoke(window.agentBase.setMcpConfig({ config }), '保存 MCP 配置');
  if (r.ok) { toast('MCP 配置已保存并应用', 'ok'); renderMcpPage(); }
}
async function renderPluginsPage() {
  const r = await invoke(window.agentBase.listPlugins(), '加载插件列表');
  if (!r.ok) return;
  renderPluginList(r.data.plugins, $('#plugin-list-settings'), $('#plugin-empty-settings'));
}
function renderPluginList(plugins, listEl, emptyEl) {
  const list = Array.isArray(plugins) ? plugins : [];
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', list.length > 0);
  for (const p of list) {
    const info = h('div', 'plugin-info');
    info.append(h('span', 'plugin-name', p.displayName || p.name), h('span', 'plugin-version', 'v' + (p.version || '?')));
    const head = h('div', 'plugin-head');
    const un = h('button', 'btn-uninstall', '卸载');
    head.append(info, un);
    const tags = h('div', 'plugin-tags');
    (p.permissions || []).forEach((x) => tags.appendChild(h('span', 'tag tag-perm', x)));
    (p.tools || []).forEach((x) => tags.appendChild(h('span', 'tag tag-tool', x)));
    const row = h('div', 'plugin-item');
    row.append(head, h('div', 'plugin-desc', p.description || ''), tags);
    listEl.appendChild(row);
    un.addEventListener('click', async () => {
      if (!confirm('确定卸载插件「' + (p.displayName || p.name) + '」？')) return;
      const rr = await invoke(window.agentBase.uninstallPlugin({ name: p.name }), '卸载插件');
      if (rr.ok) { toast('插件「' + (p.displayName || p.name) + '」已卸载', 'ok'); renderPluginsPage(); }
    });
  }
}
async function handleInstall() {
  const dir = $('#plugin-dir').value.trim();
  if (!dir) { toast('请先填写插件目录的绝对路径'); return; }
  const r = await invoke(window.agentBase.installPlugin({ pluginDir: dir }), '安装插件');
  if (r.ok && r.data.plugin) {
    toast('插件「' + (r.data.plugin.displayName || r.data.plugin.name) + '」安装成功', 'ok');
    $('#plugin-dir').value = '';
    renderPluginsPage();
  }
}
function renderAppearancePage() {
  const theme = document.body.classList.contains('theme-dark') ? 'theme-dark' : 'theme-light';
  document.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('active', c.dataset.theme === theme));
  $('#opt-anim').checked = !document.body.classList.contains('no-anim');
}
function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark');
  document.body.classList.add(theme);
  localStorage.setItem('ab-theme', theme);
  renderAppearancePage();
}
async function renderGeneralPage() {
  await refreshAppInfo();
  const info = st.appInfo;
  const kv = $('#general-info');
  kv.innerHTML = '';
  const rows = [
    ['版本', 'v' + info.version],
    ['工作目录', info.appDir],
    ['权限模式', POLICY_LABEL[info.permissionMode]],
    ['当前模型', info.provider ? `${info.provider} · ${info.models[0] || '默认'}` : '未配置'],
    ['会话数', String(info.sessionCount)],
    ['插件数', String(info.pluginCount)],
    ['MCP 已连接', String(info.mcpCount)],
  ];
  for (const [k, v] of rows) {
    const row = h('div', 'kv-row');
    row.append(h('span', 'kv-key', k), h('span', 'kv-val', v));
    kv.appendChild(row);
  }
}

/* ================= [13] 窗口控制 ================= */
function initWindowControls() {
  const w = window.agentWindow;
  if (!w || typeof w.minimize !== 'function') return;
  el.winMin.addEventListener('click', () => w.minimize());
  el.winMax.addEventListener('click', () => w.toggleMaximize());
  el.winClose.addEventListener('click', () => w.close());
  if (typeof w.onState === 'function') {
    w.onState((state) => document.body.classList.toggle('maximized', !!(state && state.maximized)));
  }
}

/* ================= [14] 事件订阅与初始化 ================= */
function subscribe() {
  const api = window.agentBase;
  if (!api || typeof api.on !== 'function') {
    toast('未检测到 window.agentBase，请通过 Electron 渲染进程打开本页面');
    return false;
  }
  if (api.protocolVersion !== 2) toast('UI 与底座协议版本不一致（预期 2）', 'info');
  api.on('message-chunk', onChunk);
  api.on('tool-started', onToolStart);
  api.on('tool-result', onToolResult);
  api.on('approval-required', onApproval);
  api.on('loop-done', onLoopDone);
  api.on('loop-error', onLoopErr);
  api.on('plugins-changed', () => { if (!$('#settings-view').classList.contains('hidden')) renderPluginsPage(); });
  api.on('sessions-changed', onSessionsChanged);
  api.on('term-data', onTermData);
  api.on('mcp-status-changed', (p) => {
    logEvent('mcp-status-changed', p);
    if (!$('#settings-view').classList.contains('hidden') && !$('#settings-view [data-page="mcp"]').classList.contains('hidden')) renderMcpPage();
  });
  return true;
}
function init() {
  // 主题（localStorage 持久化，默认浅色）
  const theme = localStorage.getItem('ab-theme') || 'theme-light';
  document.body.classList.add(theme);
  if (localStorage.getItem('ab-anim') === 'off') document.body.classList.add('no-anim');

  // 输入
  el.sendBtn.addEventListener('click', handleSend);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!st.activeMenu) handleSend(); else closeMenu(); }
  });
  el.input.addEventListener('input', () => { autoGrow(); maybeOpenAtPicker(); });
  el.scStop.addEventListener('click', () => invoke(window.agentBase.stop(), '停止生成'));

  // 下拉
  el.btnPlus.addEventListener('click', () => (st.activeMenu ? closeMenu() : openPlusMenu()));
  el.btnPolicy.addEventListener('click', () => (st.activeMenu ? closeMenu() : openPolicyMenu()));
  el.btnModel.addEventListener('click', () => (st.activeMenu ? closeMenu() : openModelMenu()));
  el.btnEffort.addEventListener('click', () => (st.activeMenu ? closeMenu() : openEffortMenu()));

  // 侧栏
  el.btnNewSession.addEventListener('click', newSession);
  el.searchInput.addEventListener('input', renderSessions);
  el.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = filteredSessions()[0]; if (first) doSwitchSession(first.id); } });

  // 设置
  el.btnOpenSettings.addEventListener('click', () => openSettings('models'));
  el.setBack.addEventListener('click', () => el.settingsView.classList.add('hidden'));
  document.querySelectorAll('.set-item').forEach((b) => b.addEventListener('click', () => openSettings(b.dataset.page)));
  $('#pd-save').addEventListener('click', saveProvider);
  $('#pd-model-add').addEventListener('click', () => {
    const input = $('#pd-model-input');
    const name = input.value.trim();
    if (!name) return;
    $('#pd-models').appendChild(modelChip(name, $('#pd-models')));
    input.value = '';
  });
  $('#pd-model-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pd-model-add').click(); });
  $('#mcp-save').addEventListener('click', saveMcpJson);
  $('#install-btn').addEventListener('click', handleInstall);
  $('#plugin-dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleInstall(); });
  document.querySelectorAll('.theme-card').forEach((c) => c.addEventListener('click', () => applyTheme(c.dataset.theme)));
  $('#opt-anim').addEventListener('change', (e) => {
    document.body.classList.toggle('no-anim', !e.target.checked);
    localStorage.setItem('ab-anim', e.target.checked ? 'on' : 'off');
  });

  // 右侧面板
  el.btnTogglePanel.addEventListener('click', () => toggleRightPanel());
  el.rpClose.addEventListener('click', () => toggleRightPanel(false));
  document.querySelectorAll('.rp-tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.rp-tab').forEach((x) => x.classList.toggle('active', x === t));
    const pages = { events: '#rp-events', audit: '#rp-audit', term: '#rp-term' };
    Object.entries(pages).forEach(([tab, sel]) => $(sel).classList.toggle('hidden', tab !== t.dataset.tab));
    if (t.dataset.tab === 'audit') loadAudit();
    if (t.dataset.tab === 'term') { startTerminal(); el.termIn.focus(); }
  }));
  el.rpRefreshAudit.addEventListener('click', loadAudit);
  el.termIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && el.termIn.value.trim()) {
      window.agentBase.termInput({ command: el.termIn.value });
      el.termIn.value = '';
    }
  });

  // 审批
  el.apvOk.addEventListener('click', onApprove);
  el.apvNo.addEventListener('click', onReject);

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); el.searchInput.focus(); el.searchInput.select(); }
    if (e.key === 'Escape' && st.activeMenu) closeMenu();
  });

  initWindowControls();
  if (!subscribe()) return;
  ensureMsgCol();
  loadSessions();
  refreshAppInfo();
  el.input.focus();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// 调试句柄（E2E/接力开发用）：只读访问内部状态，不做任何行为暴露
window.__ab = { st };
