import { fmt, signed, cls } from '../lib/format';
import { keyOf, PINNED_TICKERS, type Instrument, type Quote } from '../lib/types';

const TICKER_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 3 22 20H2z" />
  </svg>
);

export function TickerStrip({
  quotes,
  active,
  onSelect,
}: {
  quotes: Record<string, Quote>;
  active: Instrument | null;
  onSelect: (item: Instrument) => void;
}) {
  return (
    <div className="ticker-strip">
      {PINNED_TICKERS.map((item) => {
        const k = keyOf(item);
        const q = quotes[k];
        const isActive = active && keyOf(active) === k;
        return (
          <div
            key={k}
            className={`ticker-pill${isActive ? ' active' : ''}`}
            onClick={() => onSelect(item)}
          >
            <span className="ticker-icon">{TICKER_ICON}</span>
            <div>
              <div className="ticker-name">{item.label}</div>
              <div className="ticker-row">
                <span className="ticker-price">{q ? fmt(q.ltp) : '—'}</span>
                <span className={`ticker-chg ${q ? cls(q.change) : ''}`}>
                  {q && q.change != null
                    ? `${Number(q.change) >= 0 ? '▲' : '▼'} ${signed(q.change)} (${signed(q.change_pct)}%)`
                    : ''}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
