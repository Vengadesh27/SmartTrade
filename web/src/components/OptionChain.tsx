import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { fmt, cls } from '../lib/format';
import type { ChainResponse, OptionLeg } from '../lib/options';
import { ConfirmModal } from './ConfirmModal';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'];

type PendingLeg = { symbol: string; token: string; exchange: string; lotsize: number; side: 'BUY' | 'SELL'; ltp: number | null };

export function OptionChain({ underlyingLtp, onClose }: { underlyingLtp: number | null; onClose: () => void }) {
  const [underlying, setUnderlying] = useState('NIFTY');
  const [expiry, setExpiry] = useState('');
  const [lots, setLots] = useState(1);
  const [pending, setPending] = useState<PendingLeg | null>(null);
  const [log, setLog] = useState('');
  const [showGreeks, setShowGreeks] = useState(() => localStorage.getItem('chainGreeks') !== '0');

  const { data: expiries } = useQuery({
    queryKey: ['option-expiries', underlying],
    queryFn: () => api.get<{ expiries: string[] }>(`/options/expiries?underlying=${underlying}`),
  });

  useEffect(() => {
    if (expiries?.expiries.length && !expiries.expiries.includes(expiry)) {
      setExpiry(expiries.expiries[0]);
    }
  }, [expiries, expiry]);

  const {
    data: chain,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['option-chain', underlying, expiry],
    queryFn: () => api.get<ChainResponse>(`/options/chain?underlying=${underlying}&expiry=${expiry}`),
    enabled: !!expiry,
    refetchInterval: 5_000,
  });

  const rows = chain?.rows || [];
  const atmStrike = underlyingLtp
    ? rows.reduce((best, r) => (Math.abs(r.strike - underlyingLtp) < Math.abs(best - underlyingLtp) ? r.strike : best), rows[0]?.strike ?? 0)
    : null;

  function requestOrder(leg: OptionLeg, side: 'BUY' | 'SELL') {
    if (!leg || !chain) return;
    setPending({ symbol: leg.symbol, token: leg.token, exchange: chain.exchange, lotsize: leg.lotsize, side, ltp: leg.ltp });
  }

  async function confirmOrder() {
    if (!pending) return;
    const order = pending;
    setPending(null);
    try {
      await api.post('/order', {
        symbol: order.symbol,
        exchange: order.exchange,
        side: order.side,
        quantity: order.lotsize * lots,
        order_type: 'MARKET',
        product: 'INTRADAY',
      });
      setLog(`${order.side} ${order.lotsize * lots} × ${order.symbol} sent.`);
    } catch (err) {
      setLog(`Order failed: ${err instanceof ApiError ? err.message : err}`);
    }
  }

  function LegCell({ leg, side }: { leg: OptionLeg; side: 'CE' | 'PE' }) {
    if (!leg) return <td colSpan={showGreeks ? 7 : 4} className="empty">—</td>;
    return (
      <>
        <td className="num">{leg.oi != null ? fmt(leg.oi, 0) : '—'}</td>
        {showGreeks && <td className="num">{leg.delta != null ? fmt(leg.delta, 3) : '—'}</td>}
        {showGreeks && <td className="num">{leg.theta != null ? fmt(leg.theta, 1) : '—'}</td>}
        {showGreeks && <td className="num">{leg.vega != null ? fmt(leg.vega, 2) : '—'}</td>}
        <td className="num">{leg.iv != null ? fmt(leg.iv, 1) : '—'}</td>
        <td className={`num ${leg.change_pct != null ? cls(leg.change_pct) : ''}`}>
          {leg.ltp != null ? fmt(leg.ltp) : '—'}
        </td>
        <td className="num option-actions">
          <button className="mini buy" onClick={() => requestOrder(leg, side === 'CE' ? 'BUY' : 'SELL')}>
            B
          </button>
          <button className="mini sell" onClick={() => requestOrder(leg, side === 'CE' ? 'SELL' : 'BUY')}>
            S
          </button>
        </td>
      </>
    );
  }

  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box option-chain-box">
        <div className="panel-head">
          <h2>Option chain</h2>
          <button className="ghost sm" onClick={onClose} type="button">
            ✕
          </button>
        </div>
        <div className="option-chain-controls">
          <label className="chain-toggle">
            <input
              type="checkbox"
              checked={showGreeks}
              onChange={(e) => {
                setShowGreeks(e.target.checked);
                localStorage.setItem('chainGreeks', e.target.checked ? '1' : '0');
              }}
            />
            <span>Greeks</span>
          </label>
          {chain?.greeks_source === 'computed' && (
            <span className="muted chain-note" title="Black-Scholes from each leg's LTP — the broker returned none">
              greeks computed locally
            </span>
          )}
          <select value={underlying} onChange={(e) => setUnderlying(e.target.value)}>
            {UNDERLYINGS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {(expiries?.expiries || []).map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <label className="option-lots">
            Lots
            <input type="number" min={1} value={lots} onChange={(e) => setLots(Number(e.target.value))} />
          </label>
        </div>

        {isLoading && <div className="empty">Loading chain…</div>}
        {error && <div className="empty">{error instanceof ApiError ? error.message : 'Failed to load chain.'}</div>}
        {log && <p className="note">{log}</p>}

        {!!rows.length && (
          <div className="option-chain-table-wrap">
            <table className="option-chain-table">
              <thead>
                <tr>
                  <th colSpan={showGreeks ? 7 : 4}>CALLS</th>
                  <th>Strike</th>
                  <th colSpan={showGreeks ? 7 : 4}>PUTS</th>
                </tr>
                <tr>
                  <th className="num">OI</th>
                  {showGreeks && <th className="num">Δ</th>}
                  {showGreeks && <th className="num">Θ</th>}
                  {showGreeks && <th className="num">V</th>}
                  <th className="num">IV</th>
                  <th className="num">LTP</th>
                  <th className="num"></th>
                  <th className="num">Strike</th>
                  <th className="num">LTP</th>
                  <th className="num">IV</th>
                  {showGreeks && <th className="num">V</th>}
                  {showGreeks && <th className="num">Θ</th>}
                  {showGreeks && <th className="num">Δ</th>}
                  <th className="num">OI</th>
                  <th className="num"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.strike} className={r.strike === atmStrike ? 'option-atm-row' : ''}>
                    <LegCell leg={r.CE} side="CE" />
                    <td className="num option-strike">{fmt(r.strike, 0)}</td>
                    {r.PE ? (
                      <>
                        <td className="num option-actions">
                          <button className="mini buy" onClick={() => requestOrder(r.PE, 'BUY')}>
                            B
                          </button>
                          <button className="mini sell" onClick={() => requestOrder(r.PE, 'SELL')}>
                            S
                          </button>
                        </td>
                        <td className={`num ${r.PE.change_pct != null ? cls(r.PE.change_pct) : ''}`}>
                          {r.PE.ltp != null ? fmt(r.PE.ltp) : '—'}
                        </td>
                        <td className="num">{r.PE.iv != null ? fmt(r.PE.iv, 1) : '—'}</td>
                        <td className="num">{r.PE.oi != null ? fmt(r.PE.oi, 0) : '—'}</td>
                      </>
                    ) : (
                      <td colSpan={4} className="empty">—</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pending && (
        <ConfirmModal
          title="Send this order?"
          message={`${pending.side} ${pending.lotsize * lots} × ${pending.symbol}`}
          detail={`MARKET · INTRADAY${pending.ltp ? ` · ~₹${fmt(pending.ltp)}` : ''}\n\nThis places a real order on your AngelOne account.`}
          onConfirm={confirmOrder}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
