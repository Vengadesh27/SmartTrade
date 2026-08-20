export type OptionLeg = {
  symbol: string;
  token: string;
  lotsize: number;
  ltp: number | null;
  change_pct: number | null;
  oi: number | null;
  volume: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
} | null;

export type ChainRow = {
  strike: number;
  CE: OptionLeg;
  PE: OptionLeg;
};

export type ChainResponse = {
  underlying: string;
  expiry: string;
  exchange: string;
  /** underlying spot used for the local greek solve */
  spot: number | null;
  /** 'computed' when greeks were derived locally because the broker sent none */
  greeks_source: 'broker' | 'computed';
  rows: ChainRow[];
};
