/**
 * renderer/modules/chat.js
 * 对话流：消息气泡、工具内联卡、思考计时、进程卡与历史重构
 */
import { el, st } from './state.js';
import { h, trunc, toText, argsSummary, toast, renderMarkdown, scrollBottom } from './utils.js';
import { logEvent } from './right-panel.js';
import { loadSessions } from './session.js';
let msgCol = null;
export function ensureMsgCol() {
  if (!msgCol || !msgCol.isConnected) {
    msgCol = h('div', 'msg-col');
    el.messages.appendChild(msgCol);
  }
  return msgCol;
}
export function addUserBlock(content, opts = {}) {
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
    for (const a of opts.attachments) block.appendChild(h('span', 'queued-badge', (a.kind === 'image' ? '🖼 ' : '📎 ') + a.name));
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
    st.currentAssistant.appendChild(h('div', 'stream-content'));
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
  const ico = h('span', 't-ico', '◌'), nm = h('span', 't-name', name), sum = h('span', 't-summary', argsSummary(args)), dur = h('span', 't-dur', '');
  head.append(ico, nm, sum, dur); row.appendChild(head);
  const out = h('div', 'tool-row-output hidden');
  row.appendChild(out); msgCol.appendChild(row); msgCol.appendChild(h('div', 'msg-gap'));
  st.tools.set(toolCallId, { row, ico, dur, out, sum, name, t0: Date.now(), output: '', ok: null });
  row.addEventListener('click', () => {
    if (!out.textContent && st.tools.get(toolCallId)) {
      out.textContent = '';
      out.appendChild(h('pre', null, trunc(st.tools.get(toolCallId).output || '（无输出）', 4000)));
    }
    out.classList.toggle('hidden'); scrollBottom();
  });
  scrollBottom();
  return row;
}
function finishToolRow(toolCallId, result) {
  const t = st.tools.get(toolCallId);
  if (!t) return;
  t.ok = !!result.ok; const ms = Date.now() - t.t0;
  t.row.classList.remove('pending');
  t.row.classList.add(t.ok ? 'tool-row-ok' : 'tool-row-fail');
  t.ico.textContent = t.ok ? '✓' : '✗';
  t.dur.textContent = (ms / 1000).toFixed(1) + 's';
  if (!t.ok && result.error) t.sum.textContent += ' · ' + result.error;
  t.output = result.output || '';
  if (typeof marked !== 'undefined') {
    const renderType = typeof result.render === 'object' ? result.render?.type : result.render;
    const renderText = typeof result.render === 'object' ? result.render?.content : t.output;
    if (renderType === 'markdown' && renderText) {
      t.out.classList.remove('hidden');
      t.out.appendChild(renderMarkdown(trunc(renderText, 4000)));
    }
  }
  scrollBottom();
}
/** 思考行：等待模型响应的耗时（实时秒表） */
export function startThink() {
  stopThink();
  st.thinkT0 = Date.now();
  el.thinking.classList.remove('hidden'); el.thinking.classList.add('live');
  const tick = () => {
    el.thinkingText.textContent = '思考 · ' + ((Date.now() - st.thinkT0) / 1000).toFixed(0) + ' 秒';
    st.thinkTimer = setTimeout(tick, 500);
  };
  tick();
}
export function stopThink(final) {
  if (st.thinkTimer) { clearTimeout(st.thinkTimer); st.thinkTimer = null; }
  el.thinking.classList.remove('live');
  if (final === false) { el.thinking.classList.add('hidden'); return; }
}
function freezeThink() {
  if (st.thinkTimer) {
    clearTimeout(st.thinkTimer); st.thinkTimer = null;
    el.thinking.classList.remove('live');
    el.thinkingText.textContent = '思考 · 持续了 ' + ((Date.now() - st.thinkT0) / 1000).toFixed(0) + ' 秒';
  }
}
export function setBusy(busy) {
  st.busy = busy;
  // 发送按钮保持可用：忙碌时发送 = 排队（后端 queued）
  el.input.placeholder = busy ? '循环进行中，继续输入将自动排队…' : '输入消息，Enter 发送，Shift+Enter 换行；@ 引用文件';
}
/* ================= 进程卡 ================= */
export function showStatusCard() {
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
export function hideStatusCard() {
  if (st.scTimer) { clearTimeout(st.scTimer); st.scTimer = null; }
  el.statusCard.classList.add('hidden');
}
function isCurrentSession(p) {
  return !st.currentSessionId || !p.sessionId || p.sessionId === st.currentSessionId;
}
export function markLastUserQueued() {
  if (!msgCol) return;
  const blocks = msgCol.querySelectorAll('.msg-block-user');
  const last = blocks[blocks.length - 1];
  if (last && !last.querySelector('.queued-badge')) last.appendChild(h('span', 'queued-badge', '已排队'));
}
let pendingChunkText = '';
let chunkRafId = null;
function flushChunk(msgId) {
  if (!pendingChunkText) return;
  const block = ensureAssistantBlock(msgId);
  block.textContent += pendingChunkText;
  pendingChunkText = '';
  scrollBottom();
  chunkRafId = null;
}
/* ================= IPC 推送处理 ================= */
export function onChunk(p) {
  if (!isCurrentSession(p) || !p.delta) return;
  freezeThink();
  pendingChunkText += p.delta;
  if (!chunkRafId) {
    chunkRafId = requestAnimationFrame(() => flushChunk(p.messageId));
  }
}
export function onToolStart(p) {
  logEvent('tool-started', p);
  if (!isCurrentSession(p)) return;
  freezeThink();
  addToolRow(p.toolCallId, p.name, p.arguments);
  scAddTool(p.name, p.toolCallId);
}
export function onToolResult(p) {
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
export function onLoopDone(p) {
  flushChunk(p.messageId);
  logEvent('loop-done', p);
  if (!isCurrentSession(p)) return;
  freezeThink();
  setBusy(false);
  const block = st.currentMessageId === p.messageId ? st.currentAssistant : null;
  const contentEl = block ? block.firstChild : null;
  if (contentEl && p.content && !contentEl.textContent) contentEl.textContent = p.content;
  if (contentEl && contentEl.textContent) contentEl.replaceWith(renderMarkdown(contentEl.textContent));
  hideStatusCard();
  if (p.stopped) toast('已停止生成', 'info');
  loadSessions();
}
export function onLoopErr(p) {
  flushChunk(p.messageId);
  logEvent('loop-error', p);
  if (!isCurrentSession(p)) return;
  freezeThink();
  hideStatusCard();
  setBusy(false);
  const e = p.error || {};
  ensureMsgCol();
  const row = h('div', 'tool-row tool-row-fail');
  row.appendChild(h('div', 'tool-row-head')).append(
    h('span', 't-ico', '✗'), h('span', 't-name', '循环出错'),
    h('span', 't-summary', [e.code, e.message].filter(Boolean).join(' · ')),
  );
  msgCol.appendChild(row);
  scrollBottom();
}

/** 从会话消息数组重建扁平对话流 */
export function renderHistory(messages) {
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
  st.currentAssistant = null; st.currentMessageId = null; scrollBottom();
}
export function resetChatView() {
  el.messages.innerHTML = ''; ensureMsgCol(); st.tools.clear();
  st.currentAssistant = null; st.currentMessageId = null; stopThink(); hideStatusCard();
}
