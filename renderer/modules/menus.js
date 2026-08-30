/**
 * renderer/modules/menus.js
 * 策略 / 模型 / 力度 下拉菜单与身份状态展示
 */

import { el, st, POLICY_LABEL, EFFORT_LABEL } from './state.js';
import { invoke, toast, openMenu } from './utils.js';

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
        ico: '◈', label: m, active: m === info.models[0],
        onClick: async () => {
          const r = await invoke(window.agentBase.setModelConfig({ config: { provider: info.provider, model: m } }), '切换模型');
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
