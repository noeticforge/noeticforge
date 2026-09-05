/**
 * renderer/modules/session.js
 * 会话侧栏：渲染、过滤、内联重命名、删除、切换与新建
 */

import { el, st } from './state.js';
import { h, relTime, invoke, toast, ERR_TEXT } from './utils.js';

let chatHandlers = {
  renderHistory: (_messages) => {},
  resetChatView: () => {},
};

export function setSessionChatHandlers(handlers) {
  Object.assign(chatHandlers, handlers);
}

export function filteredSessions() {
  const q = (el.searchInput.value || '').trim().toLowerCase();
  if (!q) return st.sessions;
  return st.sessions.filter((s) => (s.title || '').toLowerCase().includes(q));
}

export function renderSessions() {
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
        if (editor.dataset.done) return; // Enter 与 blur 会接连触发，只提交一次
        editor.dataset.done = '1';
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
        else { chatHandlers.resetChatView(); el.chatTitle.textContent = 'agent-base'; }
      }
    });
  }
}

export async function loadSessions() {
  const r = await invoke(window.agentBase.listSessions(), '加载会话');
  if (!r.ok) return;
  st.sessions = r.data.sessions;
  if (!st.currentSessionId && st.sessions.length) {
    await doSwitchSession(st.sessions[0].id, { silent: true });
  } else {
    renderSessions();
  }
}

export async function doSwitchSession(id, opts = {}) {
  // 允许随时切换会话查看历史或开启新会话任务；会话间任务互不阻塞
  const r = await invoke(window.agentBase.switchSession({ id }), '切换会话');
  if (!r.ok) return;
  st.currentSessionId = id;
  st.busy = st.busySessions.has(id);
  el.chatTitle.textContent = r.data.session.title || 'agent-base';
  chatHandlers.renderHistory(r.data.session.messages || []);
  renderSessions();
  if (!opts.silent) toast('已切换会话', 'info');
}

export async function newSession() {
  const r = await invoke(window.agentBase.createSession({}), '新建会话');
  if (r.ok && r.data.session) {
    st.currentSessionId = r.data.session.id;
    st.busy = false;
    el.chatTitle.textContent = r.data.session.title || '新的会话';
    chatHandlers.resetChatView();
    renderSessions();
    el.searchInput.value = '';
    el.input.focus();
  }
}

export function onSessionsChanged(p) {
  st.sessions = (p && p.sessions) || [];
  renderSessions();
  const cur = st.sessions.find((s) => s.id === st.currentSessionId);
  if (cur) el.chatTitle.textContent = cur.title || 'agent-base';
}
