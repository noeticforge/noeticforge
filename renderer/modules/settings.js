/**
 * renderer/modules/settings.js
 * 设置页各子面板（模型/MCP/插件/外观主题/常规信息）
 */

import { $, el, st, POLICY_LABEL } from './state.js';
import { h, invoke, toast, setOpenSettingsHandler } from './utils.js';
import { refreshAppInfo } from './menus.js';

export const setPageBuilders = {
  models: renderModelsPage,
  mcp: renderMcpPage,
  plugins: renderPluginsPage,
  appearance: renderAppearancePage,
  general: renderGeneralPage,
};

export async function openSettings(page) {
  el.settingsView.classList.remove('hidden');
  document.querySelectorAll('.set-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.set-page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== page));
  const builder = setPageBuilders[page];
  if (builder) await builder();
}

setOpenSettingsHandler(openSettings);

export async function renderModelsPage() {
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

export function renderProviderDetail(meta) {
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

export function modelChip(name, wrap) {
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

export async function saveProvider() {
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

export async function handleFetchModels() {
  const provider = $('#pd-models').dataset.provider;
  if (!provider) return;
  const apiKey = $('#pd-apikey').value.trim();
  const baseUrl = $('#pd-baseurl').value.trim();
  const btn = $('#pd-fetch-models');
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '⏳ 查询中...';
  try {
    const r = await invoke(window.agentBase.fetchModels({ provider, apiKey, baseUrl }), '拉取远程模型');
    if (r.ok && Array.isArray(r.data?.models) && r.data.models.length) {
      const container = $('#pd-models');
      const existing = new Set([...container.querySelectorAll('.mc-name')].map((n) => n.textContent.trim()));
      let added = 0;
      for (const m of r.data.models) {
        if (!existing.has(m)) {
          container.appendChild(modelChip(m, container));
          existing.add(m);
          added++;
        }
      }
      toast(`成功拉取 ${r.data.models.length} 个模型（新增 ${added} 个）`, 'ok');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

export async function renderMcpPage() {
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

export async function saveMcpJson() {
  let parsed;
  try { parsed = JSON.parse($('#mcp-json').value); } catch (_e) { toast('mcp.json 不是合法 JSON'); return; }
  const config = parsed && parsed.mcpServers ? parsed.mcpServers : parsed;
  const r = await invoke(window.agentBase.setMcpConfig({ config }), '保存 MCP 配置');
  if (r.ok) { toast('MCP 配置已保存并应用', 'ok'); renderMcpPage(); }
}

export async function renderPluginsPage() {
  const r = await invoke(window.agentBase.listPlugins(), '加载插件列表');
  if (!r.ok) return;
  renderPluginList(r.data.plugins, $('#plugin-list-settings'), $('#plugin-empty-settings'));
}

export function renderPluginList(plugins, listEl, emptyEl) {
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

export async function handleInstall() {
  const dir = $('#plugin-dir').value.trim();
  if (!dir) { toast('请先填写插件目录的绝对路径'); return; }
  const r = await invoke(window.agentBase.installPlugin({ pluginDir: dir }), '安装插件');
  if (r.ok && r.data.plugin) {
    toast('插件「' + (r.data.plugin.displayName || r.data.plugin.name) + '」安装成功', 'ok');
    $('#plugin-dir').value = '';
    renderPluginsPage();
  }
}

export function renderAppearancePage() {
  const theme = document.body.classList.contains('theme-dark') ? 'theme-dark' : 'theme-light';
  document.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('active', c.dataset.theme === theme));
  $('#opt-anim').checked = !document.body.classList.contains('no-anim');
}

export function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark');
  document.body.classList.add(theme);
  localStorage.setItem('ab-theme', theme);
  renderAppearancePage();
}

export async function renderGeneralPage() {
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

  // 渲染自动更新控制与状态
  if (window.agentBase?.getUpdaterState) {
    const r = await invoke(window.agentBase.getUpdaterState(), '查询更新状态');
    if (r.ok && r.data) onUpdaterState(r.data);
  }
}

export function onUpdaterState(state) {
  if (!state) return;
  const chk = $('#opt-autoupdate');
  if (chk) chk.checked = Boolean(state.enabled);
  const tag = $('#update-status-tag');
  const banner = $('#update-banner');
  const dlBtn = $('#btn-download-update');
  const instBtn = $('#btn-install-update');
  const prgWrap = $('#update-progress-wrap');
  const prgBar = $('#update-progress-bar');
  const prgTxt = $('#update-progress-txt');

  const statusText = {
    disabled: '已关闭', idle: '就绪', checking: '正在检查...',
    available: '发现新版本', 'not-available': '已是最新版',
    downloading: '下载中...', downloaded: '下载完成', error: '更新出错'
  };
  if (tag) tag.textContent = statusText[state.status] || state.status;

  if (state.status === 'available') {
    banner?.classList.remove('hidden');
    $('#update-new-ver').textContent = 'v' + (state.version || '');
    $('#update-notes').textContent = state.releaseNotes || '包含常规改进与稳定性修复。';
    dlBtn?.classList.remove('hidden');
    instBtn?.classList.add('hidden');
    prgWrap?.classList.add('hidden');
  } else if (state.status === 'downloading') {
    banner?.classList.remove('hidden');
    dlBtn?.classList.add('hidden');
    prgWrap?.classList.remove('hidden');
    const p = Math.max(0, Math.min(100, state.percent || 0));
    if (prgBar) prgBar.style.width = p + '%';
    if (prgTxt) prgTxt.textContent = p + '%';
  } else if (state.status === 'downloaded') {
    banner?.classList.remove('hidden');
    dlBtn?.classList.add('hidden');
    prgWrap?.classList.add('hidden');
    instBtn?.classList.remove('hidden');
  } else if (state.status === 'not-available' || state.status === 'disabled') {
    banner?.classList.add('hidden');
  } else if (state.status === 'error' && state.error) {
    banner?.classList.remove('hidden');
    $('#update-notes').textContent = '检查失败: ' + state.error;
    dlBtn?.classList.add('hidden');
    instBtn?.classList.add('hidden');
  }
}
