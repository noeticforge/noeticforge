/**
 * renderer/modules/state.js
 * 状态对象、DOM 缓存与常量字典
 */

export const $ = (s) => document.querySelector(s);

export const el = {
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

export const dropdownRoot = $('#dropdown-root');

export const st = {
  busy: false, busySessions: new Set(), currentSessionId: null, sessions: [], appInfo: null, selectedProvider: null,
  tools: new Map(),            // toolCallId -> { row, t0, name, args, statusEl, outBox, output }
  thinkT0: 0, thinkTimer: null, thinkLive: false,
  scT0: 0, scTimer: null, scToolCount: 0, scDone: 0,
  pending: null, activeMenu: null,
  currentAssistant: null,      // 当前 message 的正文块
  currentMessageId: null,
  attachments: [],             // 待发送附件 [{name,kind,mediaType,data?,text?}]
  termStarted: false,
};

export const isSessionBusy = (sid) => st.busySessions.has(sid || st.currentSessionId);

export const OUT_LIMIT = 200;
export const POLICY_LABEL = { 'ask-before-change': '变更前确认', 'auto-edit': '自动编辑', plan: '计划模式', full: '完全访问' };
export const EFFORT_LABEL = { low: '低', medium: '高', high: '最高' };
