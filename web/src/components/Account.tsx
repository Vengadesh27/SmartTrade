import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmt, signed, cls } from '../lib/format';
import type { Position } from '../lib/tables';

type Trade = {
  tradingsymbol?: string;
  transactiontype?: string;
  fillprice?: string | number;
  price?: string | number;
  fillsize?: string | number;
  quantity?: string | number;
  filltime?: string;
};

export function Account({
  username,
  clientId,
  onBack,
  onLogout,
}: {
  username: string;
  clientId: string;
  onBack: () => void;
  onLogout: () => void;
}) {
  const { data: funds } = useQuery({
    queryKey: ['funds'],
    queryFn: () => api.get<{ availablecash?: string; net?: string }>('/funds'),
  });
  const { data: positions } = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<{ positions: Position[]; total_pnl: number }>('/positions'),
  });
  const { data: trades } = useQuery({
    queryKey: ['trades'],
    queryFn: () => api.get<{ trades: Trade[] }>('/trades'),
  });

  const tradeRows = trades?.trades || [];
  const buys = tradeRows.filter((t) => t.transactiontype === 'BUY').length;
  const sells = tradeRows.filter((t) => t.transactiontype === 'SELL').length;
  const posRows = positions?.positions || [];
  const winners = posRows.filter((p) => Number(p.pnl) > 0).length;
  const losers = posRows.filter((p) => Number(p.pnl) < 0).length;

  const initials = username.slice(0, 2).toUpperCase();

  return (
    <div className="account-page">
      <div className="account-topbar">
        <button className="ghost sm" onClick={onBack}>
          ← Back to dashboard
        </button>
        <button className="ghost sm" onClick={onLogout}>
          Logout
        </button>
      </div>

      <section className="panel account-profile">
        <div className="account-avatar">{initials}</div>
        <div className="account-id">
          <h1>{username}</h1>
          <span className="muted">AngelOne client {clientId}</span>
        </div>
      </section>

      <section className="panel account-balance">
        <div>
          <label className="muted">Trading balance</label>
          <div className="account-balance-value">
            ₹{funds ? fmt(Number(funds.availablecash ?? funds.net ?? 0), 2) : '—'}
          </div>
        </div>
        <div>
          <label className="muted">Day P&amp;L (open positions)</label>
          <div className={`account-balance-value ${positions ? cls(positions.total_pnl) : ''}`}>
            {positions ? signed(positions.total_pnl) : '—'}
          </div>
        </div>
      </section>

      <h2 className="account-section-title">Reports</h2>
      <section className="account-reports">
        <div className="panel account-report-card">
          <h3>Trades &amp; charges</h3>
          <p className="muted">{tradeRows.length} fills today · {buys} buy · {sells} sell</p>
          {tradeRows.length ? (
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Side</th>
                  <th className="num">Qty</th>
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {tradeRows.slice(0, 8).map((t, i) => (
                  <tr key={i}>
                    <td>{t.tradingsymbol}</td>
                    <td className="num">
                      <span className={t.transactiontype === 'BUY' ? 'up' : 'down'}>{t.transactiontype}</span>
                    </td>
                    <td className="num">{fmt(Number(t.fillsize ?? t.quantity ?? 0), 0)}</td>
                    <td className="num">{fmt(Number(t.fillprice ?? t.price ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No trades yet today.</div>
          )}
        </div>

        <div className="panel account-report-card">
          <h3>Profit &amp; loss</h3>
          <p className="muted">
            {posRows.length} open position{posRows.length === 1 ? '' : 's'} · {winners} up · {losers} down
          </p>
          {posRows.length ? (
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Qty</th>
                  <th className="num">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {posRows.map((p, i) => (
                  <tr key={i}>
                    <td>{p.tradingsymbol}</td>
                    <td className="num">{fmt(Number(p.netqty))}</td>
                    <td className={`num ${cls(Number(p.pnl))}`}>{signed(Number(p.pnl))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No open positions.</div>
          )}
        </div>

        <div className="panel account-report-card">
          <h3>Trading insights</h3>
          <div className="account-stats">
            <span>
              <b className="muted">Fills today</b>
              {tradeRows.length}
            </span>
            <span>
              <b className="muted">Open positions</b>
              {posRows.length}
            </span>
            <span>
              <b className="muted">Winners</b>
              <span className="up">{winners}</span>
            </span>
            <span>
              <b className="muted">Losers</b>
              <span className="down">{losers}</span>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
