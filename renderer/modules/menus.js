/**
 * renderer/modules/menus.js
 * 策略 / 模型 / 力度 下拉菜单与身份状态展示
 */

import { el, st, POLICY_LABEL, EFFORT_LABEL } from './state.js';
import { invoke, toast, openMenu } from './utils.js';
import { ClaudeEffortCard } from './claude-effort-card.js';

let activeEffortCard = null;

const handlers = {
  openSettings: (_page) => {},
  newSession: () => {},
  pickAttachments: () => {},
};

export function setMenuHandlers(h) {
  Object.assign(handlers, h);
}

export async function refreshAppInfo() {
  const r = await invoke(window.agentBase.getAppInfo(), '加载应用信息');
  if (r.ok) {
    st.appInfo = r.data.info;
    renderIdentity();
  }
}

export function renderIdentity() {
  const info = st.appInfo;
  if (!info) return;
  el.chipProvider.classList.remove('hidden');
  el.chipProvider.textContent = info.provider ? `${info.provider} · ${info.models[0] || info.model || '默认模型'}` : '未配置模型';
  el.modelLbl.textContent = info.models[0] || (info.provider ? '默认模型' : '未配置');
  el.btnPolicy.querySelector('.pill-lbl').textContent = POLICY_LABEL[info.permissionMode] || '完全访问';
  el.btnPolicy.classList.toggle('pill-warn', info.permissionMode === 'full');
  el.btnEffort.querySelector('.pill-lbl').textContent = info.reasoningEffort ? EFFORT_LABEL[info.reasoningEffort] : '默认';
}

export function openPolicyMenu() {
  const mode = st.appInfo?.permissionMode || 'full';
  openMenu(el.btnPolicy, [
    { head: '权限模式' },
    { ico: '🖐', label: '变更前确认', sub: '改文件、执行命令前先问我', active: mode === 'ask-before-change', onClick: () => applyPolicy('ask-before-change') },
    { ico: '✎', label: '自动编辑', sub: '自动写文件；执行命令仍需批准', active: mode === 'auto-edit', onClick: () => applyPolicy('auto-edit') },
    { ico: '◫', label: '计划模式', sub: '只读：写 / 执行 / 联网被策略拒绝', active: mode === 'plan', onClick: () => applyPolicy('plan') },
    { ico: '⚡', label: '完全访问', sub: '不额外限制（插件声明的审批仍生效）', active: mode === 'full', onClick: () => applyPolicy('full') },
  ]);
}

export async function applyPolicy(mode) {
  const r = await invoke(window.agentBase.setAgentPolicy({ permissionMode: mode }), '切换权限模式');
  if (r.ok) { toast('权限模式：' + POLICY_LABEL[mode], 'ok'); await refreshAppInfo(); }
}

export function openModelMenu() {
  const info = st.appInfo;
  if (!info) return;
  const items = [{ head: '模型（供应商：' + (info.provider || '未配置') + '）' }];
  if (info.models.length) {
    for (const m of info.models) {
      items.push({
        ico: '◈', label: m, active: m === (info.model || info.models[0]),
        onClick: async () => {
          const r = await invoke(window.agentBase.setModelConfig({ config: { provider: info.provider, model: m, baseUrl: info.baseUrl } }), '切换模型');
          if (r.ok) { toast('已切换模型：' + m, 'ok'); await refreshAppInfo(); }
        },
      });
    }
  } else {
    items.push({ ico: '＋', label: '在设置中添加模型', onClick: () => handlers.openSettings('models') });
  }
  items.push('-', { ico: '⚙', label: '管理模型', onClick: () => handlers.openSettings('models') });
  openMenu(el.btnModel, items);
}

export function openEffortMenu() {
  const existing = document.querySelector('.effort-popover');
  if (existing) {
    activeEffortCard?.destroy();
    existing.remove();
    activeEffortCard = null;
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'effort-popover';
  const rect = el.btnEffort.getBoundingClientRect();
  pop.style.left = `${Math.max(12, rect.left - 120)}px`;
  pop.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  document.body.appendChild(pop);

  // 记忆用户当前选中的真实档位百分比
  let initialSliderVal = 75;
  const savedEffort = localStorage.getItem('ab-claude-slider-val');
  if (savedEffort !== null) {
    initialSliderVal = Number(savedEffort);
  } else {
    const curEffort = st.appInfo?.reasoningEffort;
    if (curEffort === 'low') initialSliderVal = 25;
    else if (curEffort === 'medium') initialSliderVal = 50;
    else if (curEffort === 'high') initialSliderVal = 75;
  }

  activeEffortCard = new ClaudeEffortCard(pop, initialSliderVal, async (effort, label, snapVal) => {
    localStorage.setItem('ab-claude-slider-val', String(snapVal));
    const r = await invoke(window.agentBase.setAgentPolicy({ reasoningEffort: effort }), '调整推理力度');
    if (r.ok) {
      toast(`推理档位: ${label} (${EFFORT_LABEL[effort] || effort})`, 'ok');
      await refreshAppInfo();
    }
  });

  const closeOnOutside = (e) => {
    if (!pop.contains(e.target) && !el.btnEffort.contains(e.target)) {
      activeEffortCard?.destroy();
      pop.remove();
      activeEffortCard = null;
      document.removeEventListener('pointerdown', closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeOnOutside), 10);
}

export function openPlusMenu() {
  openMenu(el.btnPlus, [
    { ico: '📎', label: '添加附件', sub: '文本或图片（≤4 个）', onClick: () => handlers.pickAttachments() },
    { ico: '⊕', label: '新建会话', onClick: () => handlers.newSession() },
    '-',
    { ico: '◈', label: '管理模型', onClick: () => handlers.openSettings('models') },
    { ico: '⇄', label: 'MCP 服务器', onClick: () => handlers.openSettings('mcp') },
    { ico: '⬒', label: '插件', onClick: () => handlers.openSettings('plugins') },
  ]);
}
