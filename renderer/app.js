/**
 * ============================================================================
 *  agent-base 渲染进程 — app.js（工作台布局版）
 *  无框架 / 无构建，preload 通过 contextBridge 注入 window.agentBase（协议）
 *  与 window.agentWindow（窗控）。UI 只做「调用 + 订阅推送」。
 * ============================================================================
 */

import { $, el, st } from './modules/state.js';
import { toast, invoke, closeMenu, autoGrow } from './modules/utils.js';
import { openPolicyMenu, openModelMenu, openEffortMenu, openPlusMenu, refreshAppInfo, setMenuHandlers } from './modules/menus.js';
import { logEvent, loadAudit, toggleRightPanel, startTerminal, onTermData } from './modules/right-panel.js';
import { openSettings, renderProviderDetail, modelChip, saveProvider, renderMcpPage, saveMcpJson, renderPluginsPage, handleInstall, applyTheme, handleFetchModels, onUpdaterState } from './modules/settings.js';
import { setSessionChatHandlers, filteredSessions, renderSessions, loadSessions, doSwitchSession, newSession, onSessionsChanged } from './modules/session.js';
import { onApproval, onApprove, onReject, onChoiceConfirm, onChoiceCancel } from './modules/approval.js';
import { ensureMsgCol, onChunk, onToolStart, onToolResult, onLoopDone, onLoopErr, onContextCompacted, renderHistory, resetChatView, setBusy } from './modules/chat.js';
import { handleSend, maybeOpenAtPicker, pickAttachments, handleDropFiles } from './modules/composer.js';

/* ================= 窗口控制 ================= */
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

/* ================= IPC 推送订阅 ================= */
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
  api.on('context-compacted', onContextCompacted);
  api.on('plugins-changed', () => { if (!$('#settings-view').classList.contains('hidden')) renderPluginsPage(); });
  api.on('sessions-changed', onSessionsChanged);
  api.on('term-data', onTermData);
  api.on('updater-state', onUpdaterState);
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

  // 拖拽文件进入输入框：自动解析为附件芯片（图片/代码文本）
  const composerCard = $('.composer-card');
  if (composerCard) {
    ['dragenter', 'dragover'].forEach((ev) => {
      composerCard.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); composerCard.classList.add('drag-over'); });
    });
    ['dragleave', 'dragend'].forEach((ev) => {
      composerCard.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); composerCard.classList.remove('drag-over'); });
    });
    composerCard.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      composerCard.classList.remove('drag-over');
      if (e.dataTransfer?.files?.length) handleDropFiles(e.dataTransfer.files);
    });
  }

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

  // 审批与交互决策
  el.apvOk.addEventListener('click', onApprove);
  el.apvNo.addEventListener('click', onReject);
  $('#pd-fetch-models')?.addEventListener('click', handleFetchModels);
  $('#choice-confirm-btn')?.addEventListener('click', onChoiceConfirm);
  $('#choice-cancel-btn')?.addEventListener('click', onChoiceCancel);
  $('#choice-custom-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onChoiceConfirm();
  });

  // 更新控制
  $('#opt-autoupdate')?.addEventListener('change', async (e) => {
    await invoke(window.agentBase.setAutoUpdateEnabled({ enabled: e.target.checked }), '更新自动检查设置');
  });
  $('#btn-check-update')?.addEventListener('click', async () => {
    const btn = $('#btn-check-update');
    btn.disabled = true;
    try {
      const r = await invoke(window.agentBase.checkUpdates(), '检查软件更新');
      if (r.ok && r.data) onUpdaterState(r.data);
    } finally {
      btn.disabled = false;
    }
  });
  $('#btn-download-update')?.addEventListener('click', async () => {
    const btn = $('#btn-download-update');
    btn.disabled = true;
    try {
      await invoke(window.agentBase.downloadUpdate(), '下载软件更新');
    } finally {
      btn.disabled = false;
    }
  });
  $('#btn-install-update')?.addEventListener('click', async () => {
    await invoke(window.agentBase.installUpdate(), '安装软件更新');
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    const choiceModal = $('#choice-modal');
    if (choiceModal && !choiceModal.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); onChoiceCancel(); return; }
      if (e.key === 'Enter' && e.target.id !== 'choice-custom-input') { e.preventDefault(); onChoiceConfirm(); return; }
      if (e.target.tagName !== 'INPUT') {
        const k = e.key.toUpperCase();
        const card = $(`#choice-options .choice-card[data-id="${k}"]`);
        if (card) { card.click(); return; }
      }
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); el.searchInput.focus(); el.searchInput.select(); }
    if (e.key === 'Escape' && st.activeMenu) closeMenu();
  });

  setMenuHandlers({ openSettings, newSession, pickAttachments });
  setSessionChatHandlers({ renderHistory, resetChatView, setBusy });
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
