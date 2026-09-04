/**
 * renderer/modules/approval.js
 * 审批弹窗、参数动态编辑与 LCS 行级 Diff 算法
 */

import { $, el, st } from './state.js';
import { toText, trunc, h, invoke } from './utils.js';
import { logEvent } from './right-panel.js';

export function onApproval(p) {
  logEvent('approval-required', p);
  if (st.currentSessionId && p.sessionId && p.sessionId !== st.currentSessionId) return;
  const { messageId, toolCallId, name, arguments: args, reason } = p;
  st.pending = { messageId, toolCallId };
  el.apvName.textContent = name;
  el.apvReason.classList.toggle('hidden', !reason);
  el.apvReason.textContent = reason ? '原因：' + reason : '';
  el.apvReasonInput.value = '';
  let parsed = args;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (_e) { parsed = null; } }
  if (name === 'ask-user.choose') {
    renderChoiceModal(p, parsed);
    return;
  }
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
export async function renderApprovalDiff(name, parsedArgs) {
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

export function diffRow(kind, text, lineNo) {
  const row = h('div', 'dl ' + kind);
  row.appendChild(h('span', 'no', lineNo));
  row.appendChild(h('span', 'sign', kind === 'add' ? '+' : kind === 'del' ? '−' : ' '));
  row.appendChild(h('span', 'tx', text.length > 500 ? text.slice(0, 500) + '…' : text));
  return row;
}

/** 简单 LCS 行级 diff；规模超限返回 null（避免 O(n·m) 爆内存） */
export function lineDiff(oldLines, newLines) {
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

export async function onApprove() {
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

export async function onReject() {
  const r = st.pending;
  if (!r) return;
  const reason = el.apvReasonInput.value.trim();
  el.apvOk.disabled = true; el.apvNo.disabled = true;
  await invoke(window.agentBase.rejectTool({ messageId: r.messageId, toolCallId: r.toolCallId, reason: reason || undefined }), '拒绝工具');
  el.apvModal.classList.add('hidden');
  st.pending = null;
}

let selectedChoiceId = null;
let selectedChoiceLabel = '';

export function renderChoiceModal(p, args) {
  const { messageId, toolCallId } = p;
  st.pending = { messageId, toolCallId };
  const modal = $('#choice-modal');
  if (!modal) return;
  const question = args?.question || '请做出决策';
  const desc = args?.description || '';
  const rationale = args?.rationale || '';
  const options = Array.isArray(args?.options) ? args.options : [];

  $('#choice-title').textContent = question;
  const descEl = $('#choice-desc');
  descEl.textContent = desc;
  descEl.classList.toggle('hidden', !desc);

  const recBox = $('#choice-rationale');
  if (rationale) {
    recBox.classList.remove('hidden');
    $('#choice-rationale-text').textContent = rationale;
  } else {
    recBox.classList.add('hidden');
  }

  const container = $('#choice-options');
  container.innerHTML = '';
  selectedChoiceId = null;
  selectedChoiceLabel = '';

  options.forEach((opt, idx) => {
    const id = opt.id || String.fromCharCode(65 + idx);
    const label = opt.label || '';
    const isRec = Boolean(opt.recommended);
    if (isRec && !selectedChoiceId) {
      selectedChoiceId = id;
      selectedChoiceLabel = label;
    }
    const card = h('div', 'choice-card' + (isRec ? ' recommended' : '') + (selectedChoiceId === id ? ' selected' : ''));
    card.dataset.id = id;
    card.dataset.label = label;
    card.append(h('div', 'choice-key-badge', id));
    const content = h('div', 'choice-card-content');
    content.appendChild(h('div', 'choice-card-label', label));
    if (opt.description) content.appendChild(h('div', 'choice-card-desc', opt.description));
    card.appendChild(content);

    card.addEventListener('click', () => {
      container.querySelectorAll('.choice-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedChoiceId = id;
      selectedChoiceLabel = label;
    });
    card.addEventListener('dblclick', () => onChoiceConfirm());
    container.appendChild(card);
  });

  if (!selectedChoiceId && options.length) {
    selectedChoiceId = options[0].id || 'A';
    selectedChoiceLabel = options[0].label || '';
    container.querySelector('.choice-card')?.classList.add('selected');
  }

  const customInput = $('#choice-custom-input');
  if (customInput) customInput.value = '';
  modal.classList.remove('hidden');
}

export async function onChoiceConfirm() {
  const r = st.pending;
  if (!r) return;
  const modal = $('#choice-modal');
  const customInput = $('#choice-custom-input');
  const feedback = customInput ? customInput.value.trim() : '';
  const req = {
    messageId: r.messageId,
    toolCallId: r.toolCallId,
    arguments: {
      selectedId: selectedChoiceId || 'A',
      selectedLabel: selectedChoiceLabel || '',
      userFeedback: feedback,
    },
  };
  await invoke(window.agentBase.approveTool(req), '确认选择');
  modal?.classList.add('hidden');
  st.pending = null;
}

export async function onChoiceCancel() {
  const r = st.pending;
  if (!r) return;
  await invoke(window.agentBase.rejectTool({ messageId: r.messageId, toolCallId: r.toolCallId, reason: '用户取消了选择' }), '拒绝选择');
  $('#choice-modal')?.classList.add('hidden');
  st.pending = null;
}
