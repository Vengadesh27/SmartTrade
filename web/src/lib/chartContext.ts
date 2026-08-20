import type { Candle, CandlesResponse } from './candles';
import { OVERLAYS, valueAt } from './indicators';

/**
 * A snapshot of exactly what the chart is showing, handed to the assistant so
 * its answers refer to the user's current view rather than nothing at all.
 *
 * Read at send time only, so a plain module-level slot is enough — no
 * subscription or re-render plumbing needed.
 */
export type ChartSnapshot = {
  symbol: string;
  exchange: string;
  interval: string;
  range_days: number;
  session: string;
  market_open: boolean;
  bars: number;
  chart_type: string;
  visible_overlays: string[];
  lower_pane: string;
  ltp: number | null;
  last_bar: Record<string, number | string | null>;
  indicators: Record<string, number | null>;
  summary: Record<string, unknown> | null;
  smc: Record<string, unknown> | null;
};

let current: ChartSnapshot | null = null;

export const setChartSnapshot = (snap: ChartSnapshot | null) => {
  current = snap;
};

export const getChartSnapshot = (): ChartSnapshot | null => current;

/** Indicator columns worth sending — the same ones the backend computes. */
const INDICATOR_COLS = [
  'sma_20',
  'sma_50',
  'ema_9',
  'ema_21',
  'bb_upper',
  'bb_mid',
  'bb_lower',
  'vwap',
  'supertrend',
  'supertrend_dir',
  'rsi',
  'macd',
  'macd_signal',
  'macd_hist',
  'atr',
  'stoch_k',
  'stoch_d',
];

export function buildSnapshot(opts: {
  data: CandlesResponse;
  interval: string;
  days: number;
  chartType: string;
  osc: string;
  overlayOn: Record<string, boolean>;
  ltp: number | null;
}): ChartSnapshot | null {
  const { data, interval, days, chartType, osc, overlayOn, ltp } = opts;
  const last: Candle | undefined = data.candles[data.candles.length - 1];
  if (!last) return null;

  const indicators: Record<string, number | null> = {};
  for (const col of INDICATOR_COLS) indicators[col] = valueAt(last, col);

  const smc = data.smc
    ? {
        counts: data.smc.counts,
        range: data.smc.range,
        // only levels still in play are useful to reason about
        open_zones: data.smc.zones
          .filter((z) => !z.mitigated)
          .slice(-8)
          .map((z) => ({ kind: z.kind, side: z.side, top: z.top, bottom: z.bottom })),
        liquidity: data.smc.liquidity.slice(-6),
        equal: data.smc.equal.slice(-4),
        recent_structure: data.smc.structure.slice(-5).map((e) => ({ type: e.type, side: e.side, price: e.price })),
      }
    : null;

  return {
    symbol: data.symbol,
    exchange: data.exchange,
    interval,
    range_days: days,
    session: data.session,
    market_open: data.market_open,
    bars: data.candles.length,
    chart_type: chartType,
    visible_overlays: OVERLAYS.filter((o) => overlayOn[o.id]).map((o) => o.label),
    lower_pane: osc,
    ltp,
    last_bar: {
      time: last.time,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume,
    },
    indicators,
    summary: (data.summary as unknown as Record<string, unknown>) ?? null,
    smc,
  };
}
