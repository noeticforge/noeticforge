/**
 * renderer/modules/utils.js
 * 通用工具函数、Toast、invoke 包装、下拉菜单与 Markdown 渲染
 */

import { el, dropdownRoot, st, OUT_LIMIT } from './state.js';

/* ================= 通用工具 ================= */
export const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

export function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch (_e) { return String(v); }
}

export const trunc = (s, n = OUT_LIMIT) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

export function pretty(v) {
  if (v == null) return '{}';
  if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch (_e) { return v; } }
  try { return JSON.stringify(v, null, 2); } catch (_e) { return String(v); }
}

export function argsSummary(args) {
  try {
    const o = typeof args === 'string' ? JSON.parse(args) : args;
    const keys = o && typeof o === 'object' ? Object.keys(o) : [];
    if (!keys.length) return '';
    return keys.slice(0, 2).map((k) => {
      const v = o[k];
      // 多行字符串（如写文件的 content）显示行数而非内容
      if (typeof v === 'string' && v.includes('\n')) return `${k}=[${v.split('\n').length} 行]`;
      return `${k}=${trunc(String(v).replace(/\s+/g, ' '), 24)}`;
    }).join('  ');
  } catch (_e) { return trunc(String(args), 40); }
}

export function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

export function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  return Math.floor(diff / 86_400_000) + ' 天前';
}

export const scrollBottom = () => { el.messages.scrollTop = el.messages.scrollHeight; };
export const autoGrow = () => { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px'; };

/* ================= Toast ================= */
export function toast(text, type = 'err') {
  const n = h('div', 'toast toast-' + type, text);
  el.toastBox.appendChild(n);
  setTimeout(() => n.classList.add('toast-out'), 3200);
  setTimeout(() => n.remove(), 3600);
}

/* ================= invoke 统一包装 ================= */
export const ERR_TEXT = {
  E_INVALID_MESSAGE: '消息不合法：必须是内容非空的用户消息',
  E_LOOP_BUSY: '当前会话有循环正在运行，请先停止或等待其完成',
  E_NO_PENDING_APPROVAL: '没有待审批的工具调用',
  E_LLM_ERROR: '模型调用出错',
  E_MAX_ITERATIONS: '已达到最大迭代次数，循环终止',
  E_INTERNAL: '后端内部错误',
  E_PROVIDER_NOT_CONFIGURED: '尚未配置模型，请在「模型设置」中填写 API Key',
  E_PROVIDER_UNSUPPORTED: '不支持的模型提供商',
  E_INVALID_CONFIG: '配置无效，请检查 apiKey / model / baseUrl',
  E_SESSION_NOT_FOUND: '会话不存在或已被删除',
  E_SESSION_IN_USE: '会话有正在进行的任务，暂不可删除',
  E_PATH_NOT_FOUND: '目录不存在',
  E_PLUGIN_VALIDATION_FAILED: '插件校验失败，请检查 manifest.json',
  E_PLUGIN_LOAD_FAILED: '插件加载失败',
  E_PLUGIN_NOT_FOUND: '插件不存在或已卸载',
  E_PLUGIN_IN_USE: '插件工具正在执行，暂不可卸载',
  E_PLUGIN_UNINSTALL_FAILED: '插件卸载失败：文件删除出错',
  E_PLUGIN_BUILTIN: '内置插件不允许卸载',
  E_PLUGIN_NOT_IN_REGISTRY: '插件注册表中没有这个插件',
  E_CHECKSUM_MISMATCH: '插件包校验失败（sha256 不符），已中止安装',
  E_REGISTRY_FETCH_FAILED: '插件注册表获取失败，请检查网络',
  E_MCP_NOT_FOUND: 'MCP 服务器不存在',
};

let openSettingsHandler = null;
export function setOpenSettingsHandler(fn) {
  openSettingsHandler = fn;
}

export async function invoke(p, label) {
  let res;
  try { res = await p; } catch (e) {
    toast('调用 ' + label + ' 异常：' + (e.message || e)); return { ok: false, data: null };
  }
  if (!res || res.ok === false) {
    const e = (res && res.error) || {};
    toast(label + '失败：' + (ERR_TEXT[e.code] || e.message || e.code || '未知错误'));
    if (e.code === 'E_PROVIDER_NOT_CONFIGURED' && typeof openSettingsHandler === 'function') {
      openSettingsHandler('models');
    }
    return { ok: false, data: null, error: e };
  }
  return { ok: true, data: res ? res.data : null };
}

/* ================= 下拉菜单组件 ================= */
let menuSeq = 0; // @ 选择器竞态守卫：只有最新一次请求才允许渲染菜单
export const getMenuSeq = () => menuSeq;
export const nextMenuSeq = () => ++menuSeq;

export function closeMenu() {
  dropdownRoot.innerHTML = '';
  st.activeMenu = null;
  menuSeq++;
  document.removeEventListener('mousedown', onMenuDocDown);
  window.removeEventListener('resize', closeMenu);
}

function onMenuDocDown(e) {
  if (st.activeMenu && !st.activeMenu.contains(e.target) && !e.target.closest('.pill') && !e.target.closest('.round-btn')) closeMenu();
}

/** items: '-' 分隔线；{head:'..'} 小标题；{ico,label,sub,active,onClick} */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = h('div', 'menu');
  for (const it of items) {
    if (it === '-') { menu.appendChild(h('div', 'menu-sep')); continue; }
    if (it.head) { menu.appendChild(h('div', 'menu-head', it.head)); continue; }
    const b = h('button', 'menu-item');
    if (it.ico) b.appendChild(h('span', 'mi-ico', it.ico));
    const main = h('span', 'mi-main', it.label);
    if (it.sub) main.appendChild(h('span', 'mi-sub', it.sub));
    b.appendChild(main);
    if (it.active) b.appendChild(h('span', 'mi-check', '✓'));
    b.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
    menu.appendChild(b);
  }
  dropdownRoot.appendChild(menu);
  st.activeMenu = menu;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = Math.min(r.left, window.innerWidth - mw - 14);
  let y = r.bottom + 8;
  if (y + mh > window.innerHeight - 14) y = Math.max(12, r.top - mh - 8);
  menu.style.left = Math.max(10, x) + 'px';
  menu.style.top = y + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', onMenuDocDown);
    window.addEventListener('resize', closeMenu);
  }, 0);
}

/* ================= Markdown ================= */
export function renderMarkdown(text) {
  const plain = () => { const d = h('div', 'stream-content'); d.textContent = text; return d; };
  if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') return plain();
  try {
    const d = h('div', 'stream-content md');
    d.innerHTML = window.DOMPurify.sanitize(window.marked.parse(String(text ?? '')));
    return d;
  } catch (_e) { return plain(); }
}
