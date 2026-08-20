import type { Candle } from './candles';

/** Read one indicator column off a candle as a number, or null when absent. */
export function valueAt(candle: Candle, col: string): number | null {
  const v = candle[col];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export type OverlayDef = {
  id: string;
  label: string;
  color: string;
  /** Columns the backend sends for this overlay; drawn as one line each. */
  cols: string[];
  defaultOn: boolean;
  /** Columns drawn dashed rather than solid (e.g. the Bollinger midline). */
  dashed?: string[];
};

/** Price-pane overlays. Every column here is already returned by /candles. */
export const OVERLAYS: OverlayDef[] = [
  { id: 'sma20', label: 'SMA 20', color: '#2563eb', cols: ['sma_20'], defaultOn: true },
  { id: 'sma50', label: 'SMA 50', color: '#f59e0b', cols: ['sma_50'], defaultOn: true },
  { id: 'ema9', label: 'EMA 9', color: '#0ea5e9', cols: ['ema_9'], defaultOn: false },
  { id: 'ema21', label: 'EMA 21', color: '#a855f7', cols: ['ema_21'], defaultOn: false },
  {
    id: 'bb',
    label: 'Bollinger 20, 2',
    color: '#94a3b8',
    cols: ['bb_upper', 'bb_mid', 'bb_lower'],
    dashed: ['bb_mid'],
    defaultOn: false,
  },
  { id: 'vwap', label: 'VWAP', color: '#7c3aed', cols: ['vwap'], defaultOn: true },
  { id: 'supertrend', label: 'Supertrend 10, 3', color: '#0e9f6e', cols: ['supertrend'], defaultOn: false },
];

export type OscSeriesDef = { col: string; type: 'line' | 'hist'; color?: string };

export type OscDef = {
  id: string;
  label: string;
  series: OscSeriesDef[];
  /** Horizontal guide levels, e.g. RSI 30/70. */
  bands?: number[];
  /** Lock the pane's scale, for bounded oscillators. */
  range?: [number, number];
};

/** Lower-pane studies. One at a time, like the pane selector in the old app. */
export const OSCILLATORS: OscDef[] = [
  {
    id: 'rsi',
    label: 'RSI (14)',
    series: [{ col: 'rsi', type: 'line', color: '#7c3aed' }],
    bands: [30, 70],
    range: [0, 100],
  },
  {
    id: 'macd',
    label: 'MACD (12, 26, 9)',
    series: [
      { col: 'macd_hist', type: 'hist' },
      { col: 'macd', type: 'line', color: '#2563eb' },
      { col: 'macd_signal', type: 'line', color: '#f59e0b' },
    ],
    bands: [0],
  },
  {
    id: 'stoch',
    label: 'Stochastic (14, 3)',
    series: [
      { col: 'stoch_k', type: 'line', color: '#2563eb' },
      { col: 'stoch_d', type: 'line', color: '#f59e0b' },
    ],
    bands: [20, 80],
    range: [0, 100],
  },
  { id: 'atr', label: 'ATR (14)', series: [{ col: 'atr', type: 'line', color: '#0891b2' }] },
  { id: 'volume', label: 'Volume', series: [{ col: 'volume', type: 'hist' }] },
  { id: 'none', label: 'None', series: [] },
];

export const CHART_TYPES = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow candles' },
  { id: 'heikin', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
] as const;

export type ChartType = (typeof CHART_TYPES)[number]['id'];

/** Heikin Ashi smooths each bar against the previous synthetic bar. */
export function heikinAshi(rows: Candle[]) {
  const out: { time: string; open: number; high: number; low: number; close: number }[] = [];
  let prev: { open: number; close: number } | null = null;
  for (const c of rows) {
    // Annotated explicitly: `prev` is assigned from these same locals, which
    // TypeScript otherwise reads as a circular inference.
    const haClose: number = (c.open + c.high + c.low + c.close) / 4;
    const haOpen: number = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    out.push({
      time: c.time,
      open: haOpen,
      close: haClose,
      high: Math.max(c.high, haOpen, haClose),
      low: Math.min(c.low, haOpen, haClose),
    });
    prev = { open: haOpen, close: haClose };
  }
  return out;
}

const STORE_KEY = 'overlays';

export function loadOverlayPrefs(): Record<string, boolean> {
  const defaults = Object.fromEntries(OVERLAYS.map((o) => [o.id, o.defaultOn]));
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...defaults, ...saved } : defaults;
  } catch {
    return defaults;
  }
}

export function saveOverlayPrefs(prefs: Record<string, boolean>) {
  localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
}
