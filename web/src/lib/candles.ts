const IST_OFFSET = 5.5 * 3600;

/** lightweight-charts renders UTCTimestamp as UTC wall-clock; shifting by the
 * IST offset makes it display IST wall-clock time without a timezone plugin. */
export const barTime = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000) + IST_OFFSET;

/** Every indicator column /candles returns (see INDICATOR_COLUMNS in sidecar.py). */
export type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sma_20?: number | null;
  sma_50?: number | null;
  ema_9?: number | null;
  ema_21?: number | null;
  bb_upper?: number | null;
  bb_mid?: number | null;
  bb_lower?: number | null;
  vwap?: number | null;
  supertrend?: number | null;
  supertrend_dir?: number | null;
  rsi?: number | null;
  macd?: number | null;
  macd_signal?: number | null;
  macd_hist?: number | null;
  atr?: number | null;
  stoch_k?: number | null;
  stoch_d?: number | null;
  [key: string]: unknown;
};

export type CandlesResponse = {
  symbol: string;
  token: string;
  exchange: string;
  interval: string;
  session: string;
  market_open: boolean;
  /** Set when the broker was throttled and the last good payload was served. */
  stale?: boolean;
  stale_reason?: string;
  candles: Candle[];
  smc: {
    structure: { index: number; from: number; price: number; type: 'BOS' | 'CHoCH'; side: 'bull' | 'bear' }[];
    zones: {
      kind: 'fvg' | 'ifvg' | 'ob' | 'breaker';
      side: 'bull' | 'bear';
      /** bar indices into `candles` — the backend sends these, so zones can be
       *  drawn as boxes rather than flat price lines */
      start: number;
      end: number;
      top: number;
      bottom: number;
      mitigated: boolean;
      label: string;
    }[];
    sweeps: { index: number; side: 'bull' | 'bear'; price: number; level: number; label: string }[];
    liquidity: { index: number; price: number; side: 'BSL' | 'SSL'; end: number }[];
    equal: { side: 'EQH' | 'EQL'; price: number; start: number; end: number }[];
    range: {
      start: number;
      end: number;
      top: number;
      bottom: number;
      equilibrium: number;
      position: 'premium' | 'discount';
      pct: number;
    } | null;
    counts: Record<string, number>;
  } | null;
  summary: {
    open: number;
    high: number;
    low: number;
    last: number;
    change: number;
    change_pct: number;
    support: number[];
    resistance: number[];
    prev_high: number | null;
    prev_low: number | null;
  } | null;
};

export const INTERVALS = [
  { id: 'ONE_MINUTE', label: '1m' },
  { id: 'THREE_MINUTE', label: '3m' },
  { id: 'FIVE_MINUTE', label: '5m' },
  { id: 'FIFTEEN_MINUTE', label: '15m' },
  { id: 'THIRTY_MINUTE', label: '30m' },
  { id: 'ONE_HOUR', label: '1h' },
];

// Trading days, not calendar days — server caps this at 90 regardless.
export const RANGES = [
  { days: 1, label: '1D' },
  { days: 5, label: '5D' },
  { days: 22, label: '1M' },
  { days: 66, label: '3M' },
  { days: 90, label: '4M' },
];
