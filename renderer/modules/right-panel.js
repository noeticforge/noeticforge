/**
 * renderer/modules/right-panel.js
 * 右侧面板：审查（事件流）/ 审计（audit.log）/ 终端
 */

import { $, el, st } from './state.js';
import { nowTime, trunc, h, invoke } from './utils.js';

export function logEvent(name, payload) {
  let json = '';
  try { json = JSON.stringify(payload); } catch (_e) { json = String(payload); }
  if (json.length > 360) json = json.slice(0, 360) + '…';
  const line = '[' + nowTime() + '][' + name + '] ' + json;
  el.rpEvents.prepend(h('div', 'log-item', line));
  while (el.rpEvents.children.length > 300) el.rpEvents.lastChild.remove();
}

export async function loadAudit() {
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

export function toggleRightPanel(show) {
  const willShow = show !== undefined ? show : el.rightPanel.classList.contains('hidden');
  el.rightPanel.classList.toggle('hidden', !willShow);
  if (willShow && !el.rpAudit.classList.contains('hidden')) loadAudit();
  if (willShow && !$('#rp-term').classList.contains('hidden')) startTerminal();
}

/** 终端：首次打开即拉起持久 shell；输出追加到滚动区 */
export function startTerminal() {
  if (st.termStarted) return;
  st.termStarted = true;
  window.agentBase.termInput({ command: '' }); // 空命令 = 拉起 shell
  el.termOut.appendChild(h('div', null, '(输入命令后回车执行)'));
  el.termIn.focus();
}

export function onTermData(p) {
  const text = p?.text ?? '';
  el.termOut.appendChild(document.createTextNode(text));
  while (el.termOut.childNodes.length > 1500) el.termOut.firstChild.remove();
  el.termOut.scrollTop = el.termOut.scrollHeight;
}
