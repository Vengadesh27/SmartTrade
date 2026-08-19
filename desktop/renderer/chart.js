'use strict';

/**
 * The chart surface: price pane, oscillator pane, drawing rail, indicator
 * manager and the crosshair legend. app.js owns the data; this owns the view.
 */

const IST_OFFSET = 5.5 * 3600;

const INTERVAL_SECONDS = {
  ONE_MINUTE: 60,
  THREE_MINUTE: 180,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800,
  ONE_HOUR: 3600,
};

const INTERVALS = [
  { id: 'ONE_MINUTE', label: '1m' },
  { id: 'THREE_MINUTE', label: '3m' },
  { id: 'FIVE_MINUTE', label: '5m' },
  { id: 'FIFTEEN_MINUTE', label: '15m' },
  { id: 'THIRTY_MINUTE', label: '30m' },
  { id: 'ONE_HOUR', label: '1h' },
];

const CHART_TYPES = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow candles' },
  { id: 'heikin', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
];

const OVERLAYS = [
  { id: 'sma20', label: 'SMA 20', color: '#2563eb', cols: ['sma_20'], on: true },
  { id: 'sma50', label: 'SMA 50', color: '#f59e0b', cols: ['sma_50'], on: true },
  { id: 'ema9', label: 'EMA 9', color: '#0ea5e9', cols: ['ema_9'], on: false },
  { id: 'ema21', label: 'EMA 21', color: '#a855f7', cols: ['ema_21'], on: false },
  { id: 'bb', label: 'Bollinger 20,2', color: '#94a3b8', cols: ['bb_upper', 'bb_mid', 'bb_lower'], on: false },
  { id: 'vwap', label: 'VWAP', color: '#7c3aed', cols: ['vwap'], on: true },
  { id: 'st', label: 'Supertrend 10,3', color: '#0e9f6e', cols: ['supertrend'], on: false },
];

const SMC_TOGGLES = [
  { id: 'fvg', label: 'Fair value gaps' },
  { id: 'ob', label: 'Order & breaker blocks' },
  { id: 'structure', label: 'Structure (BOS / CHoCH)' },
  { id: 'swings', label: 'Swings (HH / HL / LH / LL)' },
  { id: 'liquidity', label: 'Resting liquidity (BSL / SSL)' },
  { id: 'equal', label: 'Equal highs / lows' },
  { id: 'range', label: 'Premium / discount' },
  { id: 'sweeps', label: 'Liquidity sweeps' },
  { id: 'hideMitigated', label: 'Hide mitigated zones' },
];

const OSCILLATORS = [
  { id: 'rsi', label: 'RSI (14)' },
  { id: 'macd', label: 'MACD (12,26,9)' },
  { id: 'stoch', label: 'Stochastic (14,3)' },
  { id: 'atr', label: 'ATR (14)' },
  { id: 'volume', label: 'Volume' },
];

const COLORS = ['#2563eb', '#0e9f6e', '#e02424', '#f59e0b', '#7c3aed', '#182130'];

const barTime = (iso) => Math.floor(new Date(iso).getTime() / 1000) + IST_OFFSET;
const num = (n, d = 2) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

function readPrefs(key, fallback) {
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || 'null') || {}) };
  } catch {
    return { ...fallback };
  }
}

const TVChart = {
  chart: null,
  oscChart: null,
  price: null, // active price series
  overlays: {}, // column -> line series
  oscSeries: [],
  layer: null,
  data: null,
  candles: [],
  byTime: new Map(),
  type: localStorage.getItem('chartType') || 'candles',
  osc: localStorage.getItem('osc') || 'rsi',
  interval: localStorage.getItem('interval') || 'FIVE_MINUTE',
  overlayOn: readPrefs('overlays', Object.fromEntries(OVERLAYS.map((o) => [o.id, o.on]))),
  smcOn: readPrefs('smc', {
    fvg: false,
    ob: false,
    structure: false,
    swings: false,
    liquidity: false,
    equal: false,
    range: false,
    sweeps: false,
    hideMitigated: true,
  }),
  logScale: false,
  onInterval: () => {},
  onSymbolClick: () => {},

  // ------------------------------------------------------------------ setup
  init(opts) {
    this.onInterval = opts.onInterval || (() => {});
    this.onSymbolClick = opts.onSymbolClick || (() => {});
    this.host = document.getElementById('price-pane');

    this.chart = LightweightCharts.createChart(document.getElementById('chart'), this.theme());
    this.oscChart = LightweightCharts.createChart(
      document.getElementById('osc-chart'),
      this.theme({ timeScale: { visible: false } })
    );

    this.buildPriceSeries();
    this.buildOverlays();
    this.buildOscillator();

    this.layer = new DrawingLayer(this.host, this.chart, this.price, {
      getBars: () => this.candles,
      onChange: (shapes) => this.saveDrawings(shapes),
    });
    this.layer.smcOn = this.smcOn;

    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r) this.oscChart.timeScale().setVisibleLogicalRange(r);
    });
    this.chart.subscribeCrosshairMove((p) => this.updateLegend(p));

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(document.getElementById('chart'));
    ro.observe(document.getElementById('osc-chart'));

    this.buildToolbar();
    this.buildRail();
    document.addEventListener('drawtool', (e) => this.syncRail(e.detail));
  },

  theme(extra = {}) {
    return {
      layout: { background: { color: '#ffffff' }, textColor: '#6b7686', fontSize: 11 },
      grid: { vertLines: { color: '#f1f4f8' }, horzLines: { color: '#f1f4f8' } },
      rightPriceScale: { borderColor: '#e4e8ef', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#e4e8ef', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: {
        mode: 1,
        vertLine: { color: '#9aa4b2', width: 1, style: 2, labelBackgroundColor: '#182130' },
        horzLine: { color: '#9aa4b2', width: 1, style: 2, labelBackgroundColor: '#182130' },
      },
      ...extra,
    };
  },

  buildPriceSeries() {
    if (this.price) this.chart.removeSeries(this.price);
    const up = '#0e9f6e';
    const down = '#e02424';

    if (this.type === 'line') {
      this.price = this.chart.addLineSeries({ color: '#2563eb', lineWidth: 2 });
    } else if (this.type === 'area') {
      this.price = this.chart.addAreaSeries({
        lineColor: '#2563eb',
        topColor: 'rgba(37,99,235,0.28)',
        bottomColor: 'rgba(37,99,235,0.02)',
        lineWidth: 2,
      });
    } else if (this.type === 'bars') {
      this.price = this.chart.addBarSeries({ upColor: up, downColor: down, thinBars: false });
    } else {
      this.price = this.chart.addCandlestickSeries({
        upColor: this.type === 'hollow' ? 'rgba(0,0,0,0)' : up,
        downColor: down,
        borderUpColor: up,
        borderDownColor: down,
        wickUpColor: up,
        wickDownColor: down,
      });
    }
    if (this.layer) this.layer.series = this.price;
  },

  buildOverlays() {
    for (const ov of OVERLAYS) {
      for (const col of ov.cols) {
        this.overlays[col] = this.chart.addLineSeries({
          color: ov.color,
          lineWidth: col === 'bb_mid' ? 1 : 1.5,
          lineStyle: col === 'bb_mid' ? 2 : 0,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          visible: !!this.overlayOn[ov.id],
        });
      }
    }
  },

  buildOscillator() {
    for (const s of this.oscSeries) this.oscChart.removeSeries(s);
    this.oscSeries = [];
    const line = (color) => ({ color, lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false });
    const push = (s) => this.oscSeries.push(s);
    const band = (s, lo, hi) => {
      s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      s.createPriceLine({ price: hi, color: '#e02424', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      s.createPriceLine({ price: lo, color: '#0e9f6e', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    };

    if (this.osc === 'rsi') {
      push(this.oscChart.addLineSeries(line('#7c3aed')));
      band(this.oscSeries[0], 30, 70);
    } else if (this.osc === 'macd') {
      push(this.oscChart.addHistogramSeries({ priceLineVisible: false }));
      push(this.oscChart.addLineSeries(line('#2563eb')));
      push(this.oscChart.addLineSeries(line('#f59e0b')));
    } else if (this.osc === 'stoch') {
      push(this.oscChart.addLineSeries(line('#2563eb')));
      push(this.oscChart.addLineSeries(line('#f59e0b')));
      band(this.oscSeries[0], 20, 80);
    } else if (this.osc === 'atr') {
      push(this.oscChart.addLineSeries(line('#0891b2')));
    } else {
      push(this.oscChart.addHistogramSeries({ priceLineVisible: false }));
    }
    this.paintOscillator();
  },

  // ------------------------------------------------------------------ data
  setData(payload) {
    this.data = payload;
    this.candles = payload.candles || [];
    this.byTime = new Map(this.candles.map((c) => [barTime(c.time), c]));
    this.paintPrice();
    this.paintOverlays();
    this.paintOscillator();
    this.paintMarkers();
    this.layer.setSmc(payload.smc || null);
    this.loadDrawings(`${payload.exchange}:${payload.symbol}`);
    this.chart.timeScale().fitContent();
    this.updateLegend(null);
  },

  /** Heikin Ashi smooths each bar using the previous synthetic bar. */
  heikin(rows) {
    const out = [];
    let prev = null;
    for (const c of rows) {
      const close = (c.open + c.high + c.low + c.close) / 4;
      const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
      const bar = {
        time: barTime(c.time),
        open,
        close,
        high: Math.max(c.high, open, close),
        low: Math.min(c.low, open, close),
      };
      out.push(bar);
      prev = bar;
    }
    return out;
  },

  paintPrice() {
    const rows = this.candles;
    if (!rows.length) return this.price.setData([]);

    if (this.type === 'line' || this.type === 'area') {
      this.price.setData(rows.map((c) => ({ time: barTime(c.time), value: c.close })));
    } else if (this.type === 'heikin') {
      this.price.setData(this.heikin(rows));
    } else {
      this.price.setData(
        rows.map((c) => ({ time: barTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
      );
    }
  },

  paintOverlays() {
    for (const col of Object.keys(this.overlays)) {
      this.overlays[col].setData(
        this.candles.filter((c) => c[col] != null).map((c) => ({ time: barTime(c.time), value: c[col] }))
      );
    }
  },

  paintOscillator() {
    if (!this.oscSeries.length) return;
    const rows = this.candles;
    if (!rows.length) return this.oscSeries.forEach((s) => s.setData([]));
    const series = (col) => rows.filter((c) => c[col] != null).map((c) => ({ time: barTime(c.time), value: c[col] }));

    if (this.osc === 'rsi') this.oscSeries[0].setData(series('rsi'));
    else if (this.osc === 'macd') {
      this.oscSeries[0].setData(
        rows
          .filter((c) => c.macd_hist != null)
          .map((c) => ({
            time: barTime(c.time),
            value: c.macd_hist,
            color: c.macd_hist >= 0 ? 'rgba(14,159,110,.45)' : 'rgba(224,36,36,.45)',
          }))
      );
      this.oscSeries[1].setData(series('macd'));
      this.oscSeries[2].setData(series('macd_signal'));
    } else if (this.osc === 'stoch') {
      this.oscSeries[0].setData(series('stoch_k'));
      this.oscSeries[1].setData(series('stoch_d'));
    } else if (this.osc === 'atr') this.oscSeries[0].setData(series('atr'));
    else {
      this.oscSeries[0].setData(
        rows.map((c) => ({
          time: barTime(c.time),
          value: c.volume,
          color: c.close >= c.open ? 'rgba(14,159,110,.4)' : 'rgba(224,36,36,.4)',
        }))
      );
    }
  },

  /** Liquidity sweeps ride on the price series as markers. */
  paintMarkers() {
    const smc = this.data && this.data.smc;
    if (!smc || !this.smcOn.sweeps) return this.price.setMarkers([]);
    const marks = (smc.sweeps || [])
      .map((s) => {
        const bar = this.candles[s.index];
        if (!bar) return null;
        return {
          time: barTime(bar.time),
          position: s.side === 'bear' ? 'aboveBar' : 'belowBar',
          color: s.side === 'bear' ? '#e02424' : '#0e9f6e',
          shape: s.side === 'bear' ? 'arrowDown' : 'arrowUp',
          text: 'sweep',
        };
      })
      .filter(Boolean);
    this.price.setMarkers(marks);
  },

  /** Fold a live tick into the in-progress bar. */
  applyTick(tick, marketOpen) {
    if (!this.candles.length || !marketOpen) return;
    const secs = INTERVAL_SECONDS[this.interval] || 300;
    const epoch = (tick.ts ? Math.floor(tick.ts / 1000) : Math.floor(Date.now() / 1000)) + IST_OFFSET;
    const bucket = Math.floor(epoch / secs) * secs;
    const last = this.candles[this.candles.length - 1];
    const lastTime = barTime(last.time);
    const price = tick.ltp;

    if (bucket === lastTime) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    } else if (bucket === lastTime + secs) {
      this.candles.push({
        time: new Date((bucket - IST_OFFSET) * 1000).toISOString(),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
      });
    } else {
      return; // stale or gapped — the periodic reload resyncs
    }

    const bar = this.candles[this.candles.length - 1];
    const t = barTime(bar.time);
    if (this.type === 'line' || this.type === 'area') this.price.update({ time: t, value: bar.close });
    else if (this.type === 'heikin') this.price.setData(this.heikin(this.candles));
    else this.price.update({ time: t, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    this.updateLegend(null);
  },

  // ------------------------------------------------------------------ legend
  updateLegend(param) {
    const el = document.getElementById('tv-legend');
    if (!el || !this.data) return;
    let bar = this.candles[this.candles.length - 1];
    if (param && param.time && this.byTime.has(param.time)) bar = this.byTime.get(param.time);
    if (!bar) return;

    const chg = bar.close - bar.open;
    const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    const parts = [
      `<div class="lg-title">${this.data.symbol}<span class="lg-sub">${this.data.exchange} · ${
        INTERVALS.find((i) => i.id === this.interval)?.label || ''
      }</span></div>`,
      `<div class="lg-ohlc"><span>O<b>${num(bar.open)}</b></span><span>H<b>${num(bar.high)}</b></span>` +
        `<span>L<b>${num(bar.low)}</b></span><span>C<b>${num(bar.close)}</b></span>` +
        `<span class="${cls}">${chg >= 0 ? '+' : ''}${num(chg)}</span></div>`,
    ];

    const active = OVERLAYS.filter((o) => this.overlayOn[o.id] && bar[o.cols[0]] != null);
    if (active.length) {
      parts.push(
        '<div class="lg-ind">' +
          active
            // colour comes from a stylesheet class: CSP forbids inline styles
            .map((o) => `<span><i class="sw-${o.id}"></i>${o.label} <b>${num(bar[o.cols[0]])}</b></span>`)
            .join('') +
          '</div>'
      );
    }

    const sum = this.data.summary;
    if (sum) {
      const read = [
        sum.trend,
        sum.rsi != null ? `RSI ${num(sum.rsi, 1)} ${sum.rsi_note}` : null,
        sum.macd_note ? `MACD ${sum.macd_note}` : null,
        sum.supertrend_note ? `Supertrend ${sum.supertrend_note}` : null,
        sum.atr != null ? `ATR ${num(sum.atr)}` : null,
      ].filter(Boolean);
      parts.push(`<div class="lg-read">${read.join(' · ')}</div>`);
    }

    const smc = this.data.smc;
    if (smc && smc.counts && Object.keys(smc.counts).length) {
      const c = smc.counts;
      const r = smc.range;
      parts.push(
        `<div class="lg-smc">FVG <b>${c.fvg_open}</b>/${c.fvg} · OB <b>${c.ob}</b> · Breaker <b>${c.breaker}</b>` +
          ` · BOS <b>${c.bos}</b> · CHoCH <b>${c.choch}</b> · sweeps <b>${c.sweeps}</b>` +
          (r ? ` · <b>${r.position}</b> ${r.pct.toFixed(0)}%` : '') +
          '</div>'
      );
    }
    el.innerHTML = parts.join('');
  },

  // ------------------------------------------------------------------ chrome
  buildToolbar() {
    const iv = document.getElementById('tv-intervals');
    iv.innerHTML = INTERVALS.map(
      (i) => `<button class="tv-int${i.id === this.interval ? ' on' : ''}" data-iv="${i.id}">${i.label}</button>`
    ).join('');
    iv.querySelectorAll('[data-iv]').forEach((b) => {
      b.onclick = () => {
        this.interval = b.dataset.iv;
        localStorage.setItem('interval', this.interval);
        iv.querySelectorAll('.tv-int').forEach((x) => x.classList.toggle('on', x === b));
        this.onInterval(this.interval);
      };
    });

    const type = document.getElementById('tv-type');
    type.innerHTML = CHART_TYPES.map(
      (t) => `<option value="${t.id}"${t.id === this.type ? ' selected' : ''}>${t.label}</option>`
    ).join('');
    type.onchange = () => {
      this.type = type.value;
      localStorage.setItem('chartType', this.type);
      this.buildPriceSeries();
      this.paintPrice();
      this.paintMarkers();
    };

    const osc = document.getElementById('tv-osc');
    osc.innerHTML = OSCILLATORS.map(
      (o) => `<option value="${o.id}"${o.id === this.osc ? ' selected' : ''}>${o.label}</option>`
    ).join('');
    osc.onchange = () => {
      this.osc = osc.value;
      localStorage.setItem('osc', this.osc);
      this.buildOscillator();
    };

    document.getElementById('tv-symbol').onclick = () => this.onSymbolClick();
    document.getElementById('tv-fit').onclick = () => this.chart.timeScale().fitContent();
    const logBtn = document.getElementById('tv-log');
    logBtn.onclick = () => {
      this.logScale = !this.logScale;
      logBtn.classList.toggle('on', this.logScale);
      this.chart.priceScale('right').applyOptions({ mode: this.logScale ? 1 : 0 });
    };

    this.buildIndicatorPanel();
  },

  buildIndicatorPanel() {
    const panel = document.getElementById('tv-ind-panel');
    const row = (checked, id, label, group) =>
      `<label class="ind-row"><input type="checkbox" data-group="${group}" data-id="${id}"${
        checked ? ' checked' : ''
      }><span>${label}</span></label>`;

    panel.innerHTML =
      '<div class="ind-group">Indicators</div>' +
      OVERLAYS.map((o) => row(this.overlayOn[o.id], o.id, o.label, 'overlay')).join('') +
      '<div class="ind-group">Smart money concepts</div>' +
      SMC_TOGGLES.map((s) => row(this.smcOn[s.id], s.id, s.label, 'smc')).join('');

    panel.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.onchange = () => {
        const { group, id } = cb.dataset;
        if (group === 'overlay') {
          this.overlayOn[id] = cb.checked;
          localStorage.setItem('overlays', JSON.stringify(this.overlayOn));
          const ov = OVERLAYS.find((o) => o.id === id);
          ov.cols.forEach((c) => this.overlays[c].applyOptions({ visible: cb.checked }));
          this.updateLegend(null);
        } else {
          this.smcOn[id] = cb.checked;
          localStorage.setItem('smc', JSON.stringify(this.smcOn));
          if (id === 'sweeps') this.paintMarkers();
          else this.layer.toggleSmc(id, cb.checked);
        }
      };
    });

    const btn = document.getElementById('tv-indicators');
    btn.onclick = (e) => {
      e.stopPropagation();
      panel.classList.toggle('hidden');
    };
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && e.target !== btn) panel.classList.add('hidden');
    });
  },

  buildRail() {
    const rail = document.getElementById('tv-rail');
    rail.innerHTML =
      DRAW_TOOLS.map(
        (t) =>
          `<button class="rail-btn${t.id === 'cursor' ? ' on' : ''}" data-tool="${t.id}" title="${t.label}">${t.icon}</button>`
      ).join('') +
      '<div class="rail-sep"></div>' +
      `<button class="rail-btn" id="rail-magnet" title="Magnet — snap to OHLC">🧲</button>` +
      '<div class="rail-sep"></div>' +
      COLORS.map((c, i) => `<button class="rail-color rc${i}" data-color="${c}"></button>`).join('') +
      '<div class="rail-sep"></div>' +
      `<button class="rail-btn" id="rail-clear" title="Remove all drawings">🗑</button>`;

    rail.querySelectorAll('[data-tool]').forEach((b) => {
      b.onclick = () => this.layer.setTool(b.dataset.tool);
    });
    rail.querySelectorAll('[data-color]').forEach((b) => {
      b.onclick = () => {
        this.layer.setColor(b.dataset.color);
        rail.querySelectorAll('.rail-color').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    rail.querySelector('.rail-color').classList.add('on');
    document.getElementById('rail-magnet').onclick = (e) => {
      this.layer.magnet = !this.layer.magnet;
      e.currentTarget.classList.toggle('on', this.layer.magnet);
    };
    document.getElementById('rail-clear').onclick = () => this.layer.clear();
  },

  syncRail(tool) {
    document
      .querySelectorAll('#tv-rail [data-tool]')
      .forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  },

  // ------------------------------------------------------------------ misc
  drawKey: '',

  loadDrawings(key) {
    this.drawKey = key;
    try {
      this.layer.load(JSON.parse(localStorage.getItem(`draw:${key}`) || '[]'));
    } catch {
      this.layer.load([]);
    }
  },

  saveDrawings(shapes) {
    if (this.drawKey) localStorage.setItem(`draw:${this.drawKey}`, JSON.stringify(shapes));
  },

  resize() {
    const c = document.getElementById('chart');
    const o = document.getElementById('osc-chart');
    this.chart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
    this.oscChart.applyOptions({ width: o.clientWidth, height: o.clientHeight });
    this.layer.resize();
  },
};

window.TVChart = TVChart;
window.TV_INTERVALS = INTERVALS;
