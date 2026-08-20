export const fmt = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

export const signed = (n: number | null | undefined, d = 2): string =>
  (Number(n) > 0 ? '+' : '') + fmt(n, d);

export const cls = (n: number | null | undefined): string =>
  Number(n) > 0 ? 'up' : Number(n) < 0 ? 'down' : '';
