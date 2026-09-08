/**
 * renderer/modules/claude-effort-card.js
 * Claude Code 官方原版 WebGL2 火焰推理滑块卡片组件 (零抖动平滑驱动版)
 */

import { WebglFireEngine } from './webgl-fire.js';
import { invoke, toast } from './utils.js';
import { st } from './state.js';

const STOPS = [
  { val: 0, label: 'Flow', effort: 'low', desc: '极速敏捷' },
  { val: 25, label: 'Lite', effort: 'low', desc: '轻度推理' },
  { val: 50, label: 'Pro', effort: 'medium', desc: '平衡推理' },
  { val: 75, label: 'Max', effort: 'high', desc: '深度推理' },
  { val: 100, label: 'Ultracode', effort: 'high', desc: '极限思考' },
];

export class ClaudeEffortCard {
  constructor(container, initialVal, onEffortChange) {
    this.container = container;
    this.onEffortChange = onEffortChange;
    const startVal = typeof initialVal === 'number' ? Math.max(0, Math.min(100, initialVal)) : 75;
    this.value = startVal;
    this.targetValue = startVal;
    this.isDragging = false;
    this.animId = null;
    this.prevLabel = '';
    this.initDOM();
    this.initFire();
    this.bindEvents();
    this.updateUI(startVal, false);
  }

  initDOM() {
    this.card = document.createElement('div');
    this.card.className = 'effort-card glass-card';
    this.card.innerHTML = `
      <div class="effort-header">
        <div class="effort-h-left">
          <div class="effort-title">Effort Level</div>
          <div class="effort-sub">Claude Reasoning Controls</div>
        </div>
        <div class="effort-label-wrap">
          <div class="effort-label" id="ef-label">Max</div>
        </div>
      </div>
      <div class="effort-track-wrap" id="ef-track">
        <div class="effort-track-bg"></div>
        <div class="effort-dots">
          ${[0, 0.25, 0.5, 0.75, 1].map((f) => `<span class="ef-dot" style="left:${f * 100}%"></span>`).join('')}
        </div>
        <canvas class="effort-fire-canvas" id="ef-canvas"></canvas>
        <div class="effort-thumb" id="ef-thumb"></div>
      </div>
      <div class="effort-footer">
        <span>Faster</span>
        <span class="effort-tip">按住拖动 · 滑到最右触发 Ultracode</span>
        <span>Smarter</span>
      </div>
    `;
    this.container.appendChild(this.card);
    this.labelEl = this.card.querySelector('#ef-label');
    this.thumbEl = this.card.querySelector('#ef-thumb');
    this.canvasEl = this.card.querySelector('#ef-canvas');
    this.trackEl = this.card.querySelector('#ef-track');
  }

  initFire() {
    this.engine = new WebglFireEngine(this.canvasEl);
  }

  bindEvents() {
    const onMove = (e) => {
      if (!this.isDragging) return;
      const rect = this.trackEl.getBoundingClientRect();
      const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX);
      if (clientX == null) return;
      // 安全边距：滑块中心在 14px 到 rect.width - 14px 之间滑动
      const usable = Math.max(1, rect.width - 28);
      const pos = Math.max(0, Math.min(usable, clientX - rect.left - 14));
      const pct = (pos / usable) * 100;
      this.value = pct;
      this.updateUI(pct, false);
    };

    const onUp = () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.thumbEl.classList.remove('dragging');
      // 松手瞬间弹性吸附到最近档位
      const nearest = STOPS.reduce((prev, curr) => Math.abs(curr.val - this.value) < Math.abs(prev.val - this.value) ? curr : prev);
      this.snapTo(nearest.val);
    };

    this.trackEl.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.trackEl.setPointerCapture(e.pointerId);
      this.thumbEl.classList.add('dragging');
      if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
      onMove(e);
    });

    this.trackEl.addEventListener('pointermove', onMove);
    this.trackEl.addEventListener('pointerup', onUp);
    this.trackEl.addEventListener('pointercancel', onUp);
  }

  snapTo(target) {
    this.targetValue = target;
    const start = this.value;
    const startTime = performance.now();
    const duration = 180;

    const animate = (now) => {
      const p = Math.min(1, (now - startTime) / duration);
      // 舒适的弹性三次方缓动
      const eased = 1 - Math.pow(1 - p, 3);
      this.value = start + (target - start) * eased;
      this.updateUI(this.value, p === 1);
      if (p < 1) {
        this.animId = requestAnimationFrame(animate);
      } else {
        this.value = target;
        this.animId = null;
        this.emitChange(target);
      }
    };
    this.animId = requestAnimationFrame(animate);
  }

  getLabel(val) {
    if (val <= 12) return 'Flow';
    if (val <= 37) return 'Lite';
    if (val <= 62) return 'Pro';
    if (val < 90) return 'Max';
    return 'Ultracode';
  }

  updateUI(pct, isFinal) {
    const norm = Math.max(0, Math.min(1, pct / 100));
    // 安全行程：left 从 0px 到 calc(100% - 28px)，圆钮永不滑出轨道被切边
    this.thumbEl.style.left = `calc(14px + ${norm} * (100% - 28px) - 14px)`;

    const isActive = pct >= 88;
    this.thumbEl.classList.toggle('glowing', isActive);
    this.canvasEl.style.opacity = isActive ? '1' : '0';

    const lbl = this.getLabel(pct);
    if (lbl !== this.prevLabel) {
      this.labelEl.textContent = lbl;
      this.labelEl.classList.remove('effort-flip-up');
      void this.labelEl.offsetWidth; // 触发 reflow 重置动画
      this.labelEl.classList.add('effort-flip-up');
      this.prevLabel = lbl;
    }

    if (this.engine) {
      this.engine.update(norm, isActive);
    }
  }

  emitChange(val) {
    const stop = STOPS.find((s) => s.val === val) || STOPS[3];
    if (this.onEffortChange) {
      this.onEffortChange(stop.effort, stop.label, val);
    }
  }

  destroy() {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.engine) this.engine.destroy();
    this.card.remove();
  }
}
