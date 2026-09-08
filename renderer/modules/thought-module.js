/**
 * renderer/modules/thought-module.js
 * Claude Code 风格的流光思考胶囊（Thought Capsule）
 * 包含：双轨流分流、极光旋转流光环、0.1s 毫秒级秒表、动态 Token 计数、
 * 物理阻尼平滑折叠、思维流光标跟随与一键复制思维链。
 */

import { h } from './utils.js';

const thoughtCapsules = new Map();

/** 估算思考 Token 消耗（中英混合启发式） */
function calcThoughtTokens(text) {
  return Math.max(1, Math.round(text.length * 0.75));
}

export function appendThoughtDelta(messageId, delta, msgCol, scrollBottom) {
  let tc = thoughtCapsules.get(messageId);
  if (!tc || !tc.capsule.isConnected) {
    const capsule = h('div', 'thought-capsule thinking');
    const head = h('div', 'thought-header');

    // 1. 思考中：极光旋转流光环 (Aurora Spinner)
    const spinner = h('span', 'thought-spinner');
    const title = h('span', 'thought-title', '思考中 (0.1s)...');
    const metaBox = h('div', 'thought-meta');
    const tokenBadge = h('span', 'thought-tokens', '0 tokens');

    // 5. 一键复制按钮
    const copyBtn = h('button', 'thought-copy-btn', '📋');
    copyBtn.title = '复制思考链内容';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tc && tc.rawText) {
        navigator.clipboard.writeText(tc.rawText).then(() => {
          copyBtn.textContent = '✓';
          setTimeout(() => (copyBtn.textContent = '📋'), 1500);
        });
      }
    });

    const arrow = h('span', 'thought-arrow', '▾');
    metaBox.append(tokenBadge, copyBtn, arrow);
    head.append(spinner, title, metaBox);

    // 4. 内凹终端思维流
    const body = h('div', 'thought-body');
    const contentSpan = h('span', 'thought-text');
    const cursor = h('span', 'thought-stream-cursor', '▋');
    body.append(contentSpan, cursor);
    capsule.append(head, body);

    // 折叠展开点击交互
    head.addEventListener('click', () => {
      capsule.classList.toggle('expanded');
    });

    // 2. 高精度秒表（100ms 周期，x.xs 显示）
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (capsule.classList.contains('thinking')) {
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        title.textContent = `思考中 (${sec}s)...`;
      }
    }, 100);

    msgCol.appendChild(capsule);
    scrollBottom();

    tc = {
      capsule,
      spinner,
      title,
      tokenBadge,
      arrow,
      body,
      contentSpan,
      cursor,
      t0,
      timer,
      rawText: '',
    };
    thoughtCapsules.set(messageId, tc);
  }

  // 注入思维链文本增量
  tc.rawText += delta;
  tc.contentSpan.textContent = tc.rawText;
  tc.tokenBadge.textContent = `${calcThoughtTokens(tc.rawText)} tokens`;
  scrollBottom();
}

/** 3. 思考完毕：平滑过渡至完成态 (Finalize Transition) */
export function finalizeThoughtCapsule(messageId) {
  const tc = thoughtCapsules.get(messageId);
  if (!tc || !tc.capsule.classList.contains('thinking')) return;

  clearInterval(tc.timer);
  tc.capsule.classList.remove('thinking');
  tc.capsule.classList.add('finished');

  // 流光圆环替换为淡绿色完成勾选 ✓
  tc.spinner.textContent = '✓';
  tc.spinner.className = 'thought-done-ico';

  const finalSec = ((Date.now() - tc.t0) / 1000).toFixed(1);
  tc.title.textContent = `已深度思考（用时 ${finalSec}s）`;

  // 隐藏思考光标
  tc.cursor.classList.add('hidden');
}

/** 清理全部定时器与缓存（会话切换或清空时） */
export function clearAllThoughtCapsules() {
  for (const tc of thoughtCapsules.values()) {
    clearInterval(tc.timer);
  }
  thoughtCapsules.clear();
}
