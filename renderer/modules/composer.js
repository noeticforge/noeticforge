/**
 * renderer/modules/composer.js
 * 消息发送、@ 文件下钻选择器与附件管理
 */

import { el, st } from './state.js';
import { h, autoGrow, closeMenu, getMenuSeq, nextMenuSeq, openMenu, invoke, toast } from './utils.js';
import { addUserBlock, setBusy, startThink, showStatusCard, stopThink, hideStatusCard, markLastUserQueued } from './chat.js';

const AT_RE = /(^|\s)@([\w\u4e00-\u9fa5\-./\\]*)$/;

/** 输入以 @query 结尾时弹出工作目录文件选择菜单；选中目录继续下钻（带竞态守卫） */
export async function maybeOpenAtPicker() {
  const match = el.input.value.match(AT_RE);
  if (!match) { if (st.activeMenu?.dataset?.at === '1') closeMenu(); return; }
  const query = match[2];
  const mySeq = nextMenuSeq();
  const r = await invoke(window.agentBase.listWorkspaceFiles({ query }), '搜索文件');
  if (!r.ok) return;
  if (mySeq !== getMenuSeq()) return; // 已有更新的输入事件，丢弃迟到响应
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
export async function pickAttachments() {
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

/** 发送：组装 @ 引用与附件 → sendMessage（多模态分片） */
export async function handleSend() {
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
  if (r.data?.queued) markLastUserQueued();
}
