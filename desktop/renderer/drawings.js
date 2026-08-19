'use strict';

/**
 * Drawing layer for the price chart — the tools lightweight-charts doesn't ship.
 *
 * Shapes are stored in chart space (logical bar index + price), not pixels, so
 * they stay pinned to the same bar and level through pan, zoom and new candles.
 * They are repainted onto a transparent canvas that sits over the chart.
 */

const HIT_PX = 7;
const HANDLE = 4;

const TOOLS = [
  { id: 'cursor', label: 'Cross', icon: '✛', points: 0 },
  { id: 'trend', label: 'Trend line', icon: '╱', points: 2 },
  { id: 'ray', label: 'Ray', icon: '→', points: 2 },
  { id: 'extended', label: 'Extended line', icon: '↔', points: 2 },
  { id: 'hline', label: 'Horizontal line', icon: '─', points: 1 },
  { id: 'vline', label: 'Vertical line', icon: '│', points: 1 },
  { id: 'rect', label: 'Rectangle', icon: '▭', points: 2 },
  { id: 'fib', label: 'Fib retracement', icon: '≡', points: 2 },
  { id: 'brush', label: 'Brush', icon: '✎', points: -1 },
  { id: 'text', label: 'Text', icon: 'T', points: 1 },
  { id: 'measure', label: 'Measure', icon: '⇕', points: 2 },
];

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

class DrawingLayer {
  /**
   * @param {HTMLElement} host   element wrapping the chart (position: relative)
   * @param {object} chart       lightweight-charts chart
   * @param {object} series      the price series drawings anchor to
   * @param {object} opts        {getBars, onChange}
   */
  constructor(host, chart, series, opts = {}) {
    this.host = host;
    this.chart = chart;
    this.series = series;
    this.getBars = opts.getBars || (() => []);
    this.onChange = opts.onChange || (() => {});

    this.shapes = [];
    this.tool = 'cursor';
    this.color = '#2563eb';
    this.magnet = false;
    this.selected = null;
    this.draft = null;
    this.drag = null;

    // Auto-detected Smart Money Concepts, painted under the user's own drawings.
    this.smc = null;
    this.smcOn = {
      fvg: false,
      ob: false,
      structure: false,
      swings: false,
      liquidity: false,
      equal: false,
      range: false,
      hideMitigated: true,
    };

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'draw-layer';
    this.host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._bindEvents();
    this.resize();
  }

  // ---------------------------------------------------------------- geometry
  xOf(logical) {
    const x = this.chart.timeScale().logicalToCoordinate(logical);
    return x === null ? null : x;
  }

  yOf(price) {
    const y = this.series.priceToCoordinate(price);
    return y === null ? null : y;
  }

  logicalAt(x) {
    return this.chart.timeScale().coordinateToLogical(x);
  }

  priceAt(y) {
    return this.series.coordinateToPrice(y);
  }

  /** Snap the price to the nearest OHLC of the bar under the cursor. */
  snap(point) {
    if (!this.magnet) return point;
    const bars = this.getBars();
    const i = Math.round(point.logical);
    const bar = bars[i];
    if (!bar) return point;
    const candidates = [bar.open, bar.high, bar.low, bar.close];
    let best = point.price;
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - point.price);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return { logical: i, price: best };
  }

  pointFromEvent(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    const logical = this.logicalAt(x);
    const price = this.priceAt(y);
    if (logical === null || price === null) return null;
    return this.snap({ logical, price });
  }

  // ---------------------------------------------------------------- events
  _bindEvents() {
    this._onDown = (e) => this.handleDown(e);
    this._onMove = (e) => this.handleMove(e);
    this._onUp = (e) => this.handleUp(e);
    this._onKey = (e) => this.handleKey(e);

    // Listeners live on the host: the canvas stays pointer-events:none so the
    // chart keeps its own pan/zoom behaviour when no tool is active.
    this.host.addEventListener('mousedown', this._onDown, true);
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('keydown', this._onKey);

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.repaint());
    this.chart.subscribeCrosshairMove(() => this.repaint());
  }

  destroy() {
    this.host.removeEventListener('mousedown', this._onDown, true);
    window.removeEventListener('mousemove', this._onMove);
    window.removeEventListener('mouseup', this._onUp);
    window.removeEventListener('keydown', this._onKey);
    this.canvas.remove();
  }

  freezeChart(frozen) {
    this.chart.applyOptions({
      handleScroll: !frozen,
      handleScale: !frozen,
    });
  }

  handleDown(evt) {
    if (evt.button !== 0) return;
    const pt = this.pointFromEvent(evt);
    if (!pt) return;

    if (this.tool === 'cursor') {
      const hit = this.hitTest(evt);
      if (hit) {
        this.selected = hit.shape;
        this.drag = { shape: hit.shape, handle: hit.handle, start: pt };
        this.freezeChart(true);
        evt.stopPropagation();
        evt.preventDefault();
      } else {
        this.selected = null;
      }
      this.repaint();
      return;
    }

    // A tool is armed — the chart must not pan while we lay the shape down.
    evt.stopPropagation();
    evt.preventDefault();
    this.freezeChart(true);

    const spec = TOOLS.find((t) => t.id === this.tool);
    if (this.tool === 'text') {
      this.promptText(pt, evt);
      return;
    }
    if (spec.points === 1) {
      this.commit({ type: this.tool, points: [pt], color: this.color });
      this.setTool('cursor');
      return;
    }
    if (this.tool === 'brush') {
      this.draft = { type: 'brush', points: [pt], color: this.color };
      return;
    }
    this.draft = { type: this.tool, points: [pt, pt], color: this.color };
  }

  handleMove(evt) {
    if (this.draft) {
      const pt = this.pointFromEvent(evt);
      if (!pt) return;
      if (this.draft.type === 'brush') this.draft.points.push(pt);
      else this.draft.points[1] = pt;
      this.repaint();
      return;
    }
    if (this.drag) {
      const pt = this.pointFromEvent(evt);
      if (!pt) return;
      const { shape, handle, start } = this.drag;
      if (handle === -1) {
        const dl = pt.logical - start.logical;
        const dp = pt.price - start.price;
        shape.points = shape.points.map((p) => ({ logical: p.logical + dl, price: p.price + dp }));
        this.drag.start = pt;
      } else {
        shape.points[handle] = pt;
      }
      this.repaint();
      return;
    }
    if (this.tool === 'cursor') {
      const hit = this.hitTest(evt);
      this.host.style.cursor = hit ? 'move' : '';
    }
  }

  handleUp() {
    if (this.draft) {
      const d = this.draft;
      this.draft = null;
      const degenerate =
        d.type !== 'brush' &&
        Math.abs(d.points[0].logical - d.points[1].logical) < 0.01 &&
        Math.abs(d.points[0].price - d.points[1].price) < 1e-9;
      if (!degenerate) this.commit(d);
      if (d.type !== 'measure') this.setTool('cursor');
      else this.repaint();
    }
    if (this.drag) {
      this.drag = null;
      this.onChange(this.shapes);
    }
    this.freezeChart(false);
  }

  handleKey(evt) {
    if (evt.key === 'Escape') {
      this.draft = null;
      this.selected = null;
      this.setTool('cursor');
      this.repaint();
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((evt.key === 'Delete' || evt.key === 'Backspace') && this.selected && !typing) {
      this.remove(this.selected);
    }
  }

  promptText(pt, evt) {
    const input = document.createElement('input');
    input.className = 'draw-text-input';
    input.style.left = `${evt.clientX - this.canvas.getBoundingClientRect().left}px`;
    input.style.top = `${evt.clientY - this.canvas.getBoundingClientRect().top}px`;
    input.placeholder = 'note…';
    this.host.appendChild(input);
    input.focus();
    const done = (save) => {
      const text = input.value.trim();
      input.remove();
      this.setTool('cursor');
      this.freezeChart(false);
      if (save && text) this.commit({ type: 'text', points: [pt], color: this.color, text });
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
      e.stopPropagation();
    };
    input.onblur = () => done(true);
  }

  // ---------------------------------------------------------------- model
  commit(shape) {
    shape.id = `d${Date.now()}${this.shapes.length}`;
    this.shapes.push(shape);
    this.selected = shape;
    this.onChange(this.shapes);
    this.repaint();
  }

  remove(shape) {
    this.shapes = this.shapes.filter((s) => s !== shape);
    if (this.selected === shape) this.selected = null;
    this.onChange(this.shapes);
    this.repaint();
  }

  clear() {
    this.shapes = [];
    this.selected = null;
    this.onChange(this.shapes);
    this.repaint();
  }

  load(shapes) {
    this.shapes = Array.isArray(shapes) ? shapes : [];
    this.selected = null;
    this.repaint();
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'cursor') this.selected = null;
    this.host.classList.toggle('drawing', tool !== 'cursor');
    document.dispatchEvent(new CustomEvent('drawtool', { detail: tool }));
    this.repaint();
  }

  setColor(color) {
    this.color = color;
    if (this.selected) {
      this.selected.color = color;
      this.onChange(this.shapes);
      this.repaint();
    }
  }

  // ---------------------------------------------------------------- hit test
  hitTest(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;

    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const shape = this.shapes[i];
      const pts = this.projected(shape);
      if (!pts) continue;

      for (let h = 0; h < pts.length; h++) {
        if (Math.hypot(pts[h].x - px, pts[h].y - py) <= HIT_PX + 2) {
          return { shape, handle: h };
        }
      }
      if (this.near(shape, pts, px, py)) return { shape, handle: -1 };
    }
    return null;
  }

  near(shape, pts, px, py) {
    const seg = (a, b) => distToSegment(px, py, a.x, a.y, b.x, b.y) <= HIT_PX;
    switch (shape.type) {
      case 'hline':
        return Math.abs(pts[0].y - py) <= HIT_PX;
      case 'vline':
        return Math.abs(pts[0].x - px) <= HIT_PX;
      case 'trend':
      case 'measure':
        return seg(pts[0], pts[1]);
      case 'ray':
      case 'extended': {
        const ends = this.lineEnds(shape, pts);
        return seg(ends[0], ends[1]);
      }
      case 'rect': {
        const [a, b] = pts;
        const l = Math.min(a.x, b.x);
        const r = Math.max(a.x, b.x);
        const t = Math.min(a.y, b.y);
        const bo = Math.max(a.y, b.y);
        const onEdge =
          (Math.abs(px - l) <= HIT_PX || Math.abs(px - r) <= HIT_PX) && py >= t - HIT_PX && py <= bo + HIT_PX;
        const onSide =
          (Math.abs(py - t) <= HIT_PX || Math.abs(py - bo) <= HIT_PX) && px >= l - HIT_PX && px <= r + HIT_PX;
        return onEdge || onSide;
      }
      case 'fib': {
        const [a, b] = pts;
        const l = Math.min(a.x, b.x);
        const r = Math.max(a.x, b.x);
        if (px < l - HIT_PX || px > r + HIT_PX) return false;
        return FIB_LEVELS.some((lv) => Math.abs(a.y + (b.y - a.y) * lv - py) <= HIT_PX);
      }
      case 'brush':
        for (let i = 1; i < pts.length; i++) if (seg(pts[i - 1], pts[i])) return true;
        return false;
      case 'text':
        return Math.abs(pts[0].x + 30 - px) < 40 && Math.abs(pts[0].y - py) < 10;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- painting
  projected(shape) {
    const out = [];
    for (const p of shape.points) {
      const x = this.xOf(p.logical);
      const y = this.yOf(p.price);
      if (x === null || y === null) return null;
      out.push({ x, y });
    }
    return out;
  }

  /** Extend a two-point line to the canvas edges (ray = one way, extended = both). */
  lineEnds(shape, pts) {
    const [a, b] = pts;
    const w = this.canvas.clientWidth;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 1e-6) {
      return [
        { x: a.x, y: shape.type === 'extended' ? 0 : a.y },
        { x: a.x, y: this.canvas.clientHeight },
      ];
    }
    const slope = dy / dx;
    const at = (x) => ({ x, y: a.y + slope * (x - a.x) });
    if (shape.type === 'ray') return [a, at(dx > 0 ? w : 0)];
    return [at(0), at(w)];
  }

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.repaint();
  }

  repaint() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    this.paintSmc();
    for (const shape of this.shapes) this.paint(shape, shape === this.selected);
    if (this.draft) this.paint(this.draft, false, true);
  }

  // ---------------------------------------------------------------- SMC layer
  setSmc(smc) {
    this.smc = smc;
    this.repaint();
  }

  toggleSmc(key, on) {
    this.smcOn[key] = on;
    this.repaint();
  }

  paintSmc() {
    const s = this.smc;
    if (!s) return;
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const tint = (side, alpha) =>
      side === 'bull' ? `rgba(14,159,110,${alpha})` : `rgba(224,36,36,${alpha})`;

    ctx.save();
    ctx.font = '10px Inter, system-ui, sans-serif';

    // dealing range: premium above equilibrium, discount below
    if (this.smcOn.range && s.range) {
      const r = s.range;
      const x0 = this.xOf(r.start);
      const yTop = this.yOf(r.top);
      const yMid = this.yOf(r.equilibrium);
      const yBot = this.yOf(r.bottom);
      if (x0 !== null && yTop !== null && yMid !== null && yBot !== null) {
        ctx.fillStyle = 'rgba(224,36,36,0.05)';
        ctx.fillRect(x0, yTop, w - x0, yMid - yTop);
        ctx.fillStyle = 'rgba(14,159,110,0.05)';
        ctx.fillRect(x0, yMid, w - x0, yBot - yMid);
        ctx.strokeStyle = '#94a3b8';
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, yMid);
        ctx.lineTo(w, yMid);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#6b7686';
        ctx.fillText('equilibrium', x0 + 4, yMid - 3);
        ctx.fillText('premium', x0 + 4, yTop + 11);
        ctx.fillText('discount', x0 + 4, yBot - 4);
      }
    }

    // FVG / inversion FVG / order blocks / breakers
    for (const z of s.zones || []) {
      const isBlock = z.kind === 'ob' || z.kind === 'breaker';
      if (!this.smcOn[isBlock ? 'ob' : 'fvg']) continue;
      if (this.smcOn.hideMitigated && z.mitigated) continue;

      const x0 = this.xOf(z.start);
      const x1 = this.xOf(z.end);
      const yTop = this.yOf(z.top);
      const yBot = this.yOf(z.bottom);
      if (x0 === null || x1 === null || yTop === null || yBot === null) continue;

      const alpha = z.mitigated ? 0.05 : isBlock ? 0.14 : 0.1;
      ctx.fillStyle = tint(z.side, alpha);
      ctx.fillRect(x0, yTop, Math.max(x1 - x0, 2), yBot - yTop);
      ctx.strokeStyle = tint(z.side, z.mitigated ? 0.3 : 0.75);
      ctx.setLineDash(z.kind === 'breaker' || z.kind === 'ifvg' ? [4, 3] : []);
      ctx.strokeRect(x0, yTop, Math.max(x1 - x0, 2), yBot - yTop);
      ctx.setLineDash([]);
      ctx.fillStyle = tint(z.side, 0.95);
      ctx.fillText(z.label, x0 + 3, yTop - 2);
    }

    // BOS / CHoCH
    if (this.smcOn.structure) {
      for (const e of s.structure || []) {
        const x0 = this.xOf(e.from);
        const x1 = this.xOf(e.index);
        const y = this.yOf(e.price);
        if (x0 === null || x1 === null || y === null) continue;
        ctx.strokeStyle = e.side === 'bull' ? '#0e9f6e' : '#e02424';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = e.type === 'CHoCH' ? '#b45309' : ctx.strokeStyle;
        ctx.fillText(e.type, (x0 + x1) / 2 - 12, y - 3);
      }
    }

    // HH / HL / LH / LL
    if (this.smcOn.swings) {
      ctx.fillStyle = '#6b7686';
      for (const p of s.swings || []) {
        const x = this.xOf(p.index);
        const y = this.yOf(p.price);
        if (x === null || y === null) continue;
        const above = p.label === 'HH' || p.label === 'LH';
        ctx.fillText(p.label, x - 8, above ? y - 5 : y + 12);
      }
    }

    // resting liquidity (untapped swing highs/lows)
    if (this.smcOn.liquidity) {
      for (const l of s.liquidity || []) {
        const x = this.xOf(l.index);
        const y = this.yOf(l.price);
        if (x === null || y === null) continue;
        ctx.strokeStyle = l.side === 'BSL' ? 'rgba(224,36,36,0.7)' : 'rgba(14,159,110,0.7)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(l.side, w - 26, y - 3);
      }
    }

    // equal highs / lows
    if (this.smcOn.equal) {
      for (const e of s.equal || []) {
        const x0 = this.xOf(e.start);
        const x1 = this.xOf(e.end);
        const y = this.yOf(e.price);
        if (x0 === null || x1 === null || y === null) continue;
        ctx.strokeStyle = '#7c3aed';
        ctx.setLineDash([1, 2]);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#7c3aed';
        ctx.fillText(e.side, x1 + 3, y + 3);
      }
    }

    ctx.restore();
  }

  paint(shape, selected, isDraft) {
    const pts = this.projected(shape);
    if (!pts) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = shape.color || '#2563eb';
    ctx.fillStyle = shape.color || '#2563eb';
    ctx.lineWidth = 1.5;
    ctx.setLineDash(isDraft ? [4, 3] : []);
    ctx.font = '11px Inter, system-ui, sans-serif';

    const w = this.canvas.clientWidth;
    const line = (a, b) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };

    switch (shape.type) {
      case 'hline': {
        line({ x: 0, y: pts[0].y }, { x: w, y: pts[0].y });
        this.tag(ctx, w - 4, pts[0].y, shape.points[0].price.toFixed(2), 'right');
        break;
      }
      case 'vline':
        line({ x: pts[0].x, y: 0 }, { x: pts[0].x, y: this.canvas.clientHeight });
        break;
      case 'trend':
        line(pts[0], pts[1]);
        break;
      case 'ray':
      case 'extended': {
        const ends = this.lineEnds(shape, pts);
        line(ends[0], ends[1]);
        break;
      }
      case 'rect': {
        const [a, b] = pts;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const rw = Math.abs(b.x - a.x);
        const rh = Math.abs(b.y - a.y);
        ctx.globalAlpha = 0.1;
        ctx.fillRect(x, y, rw, rh);
        ctx.globalAlpha = 1;
        ctx.strokeRect(x, y, rw, rh);
        break;
      }
      case 'fib': {
        const [a, b] = pts;
        const p0 = shape.points[0].price;
        const p1 = shape.points[1].price;
        const l = Math.min(a.x, b.x);
        const r = Math.max(a.x, b.x);
        for (const lv of FIB_LEVELS) {
          const y = a.y + (b.y - a.y) * lv;
          const price = p0 + (p1 - p0) * lv;
          ctx.globalAlpha = 0.75;
          ctx.setLineDash(lv === 0 || lv === 1 ? [] : [3, 3]);
          line({ x: l, y }, { x: r, y });
          ctx.globalAlpha = 1;
          ctx.fillText(`${(lv * 100).toFixed(1)}%  ${price.toFixed(2)}`, l + 4, y - 3);
        }
        break;
      }
      case 'brush':
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        break;
      case 'text':
        ctx.fillText(shape.text || '', pts[0].x + 4, pts[0].y);
        break;
      case 'measure': {
        const [a, b] = pts;
        const p0 = shape.points[0].price;
        const p1 = shape.points[1].price;
        const bars = Math.abs(Math.round(shape.points[1].logical - shape.points[0].logical));
        const diff = p1 - p0;
        const pct = p0 ? (diff / p0) * 100 : 0;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.globalAlpha = 1;
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        const label = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)  ${bars} bars`;
        this.tag(ctx, (a.x + b.x) / 2, Math.min(a.y, b.y) - 6, label, 'center');
        break;
      }
    }

    if (selected) {
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = shape.color || '#2563eb';
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, HANDLE, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  tag(ctx, x, y, text, align) {
    ctx.save();
    ctx.font = '11px Inter, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 8;
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(left, y - 8, w, 15);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, left + 4, y + 3);
    ctx.restore();
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

window.DrawingLayer = DrawingLayer;
window.DRAW_TOOLS = TOOLS;
