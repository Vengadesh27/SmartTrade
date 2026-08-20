export type Instrument = { sym: string; exch: string; label?: string };

export type Quote = {
  symbol: string;
  token: string;
  exchange: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  change_pct: number;
};

export const keyOf = (item: Instrument) => `${item.exch}:${item.sym}`;

export const PINNED_TICKERS: Instrument[] = [
  { sym: 'NIFTY', exch: 'NSE', label: 'NIFTY' },
  { sym: 'CRUDEOILM', exch: 'MCX', label: 'CRUDE OIL MINI' },
];
