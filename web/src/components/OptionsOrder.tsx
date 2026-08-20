import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmt, cls } from '../lib/format';
import type { ChainResponse, OptionLeg } from '../lib/options';
import { ConfirmModal } from './ConfirmModal';

type PendingOrder = {
  side: 'BUY' | 'SELL';
  label: string;
  symbol: string;
  token: string;
  exchange: string;
  quantity: number;
  order_type: string;
  price: number;
};

const ATM_WINDOW = 8; // strikes above and below ATM to show

export function OptionsOrder({
  underlyingSpot,
}: {
  underlyingSpot: number | null;
}) {
  const [underlying, setUnderlying] = useState('NIFTY');
  const [expiry, setExpiry] = useState('');
  const [optType, setOptType] = useState<'CE' | 'PE'>('CE');
  const [strike, setStrike] = useState<number | null>(null);
  const [lots, setLots] = useState(1);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [limitPrice, setLimitPrice] = useState(0);
  const [pending, setPending] = useState<PendingOrder | null>(null);
  const [log, setLog] = useState('');

  const { data: expiries } = useQuery({
    queryKey: ['opt-expiries', underlying],
    queryFn: () => api.get<{ expiries: string[] }>(`/options/expiries?underlying=${underlying}`),
  });

  useEffect(() => {
    if (expiries?.expiries.length && !expiries.expiries.includes(expiry)) {
      setExpiry(expiries.expiries[0]);
    }
  }, [expiries, expiry]);

  const { data: chain } = useQuery({
    queryKey: ['opt-chain', underlying, expiry],
    queryFn: () => api.get<ChainResponse>(`/options/chain?underlying=${underlying}&expiry=${expiry}`),
    enabled: !!expiry,
    refetchInterval: 5_000,
    staleTime: 4_000,
  });

  const rows = chain?.rows ?? [];

  // ATM index and visible window
  const spot = underlyingSpot ?? chain?.spot ?? null;
  const atmStrike = spot && rows.length
    ? rows.reduce((b, r) => Math.abs(r.strike - spot) < Math.abs(b - spot) ? r.strike : b, rows[0].strike)
    : null;

  // Trim to ±ATM_WINDOW strikes around ATM
  const visibleRows = (() => {
    if (!atmStrike) return rows;
    const idx = rows.findIndex((r) => r.strike === atmStrike);
    if (idx < 0) return rows;
    return rows.slice(Math.max(0, idx - ATM_WINDOW), idx + ATM_WINDOW + 1);
  })();

  // Selected leg
  const selectedRow = rows.find((r) => r.strike === strike);
  const selectedLeg: OptionLeg | null = selectedRow ? (selectedRow[optType] ?? null) : null;
  const lotSize = selectedLeg?.lotsize ?? 1;
  const totalQty = lots * lotSize;

  // Auto-select ATM when chain loads
  useEffect(() => {
    if (atmStrike && strike === null) setStrike(atmStrike);
  }, [atmStrike]);

  function requestOrder(side: 'BUY' | 'SELL') {
    if (!selectedLeg || !chain) return;
    const label = `${side} ${lots}L · ${strike}${optType} · ${underlying} ${expiry}`;
    setPending({
      side,
      label,
      symbol: selectedLeg.symbol,
      token: selectedLeg.token,
      exchange: chain.exchange,
      quantity: totalQty,
      order_type: orderType,
      price: orderType === 'LIMIT' ? limitPrice : 0,
    });
  }

  async function confirmOrder() {
    if (!pending) return;
    const o = pending;
    setPending(null);
    try {
      await api.post('/order', {
        symbol: o.symbol,
        exchange: o.exchange,
        side: o.side,
        quantity: o.quantity,
        order_type: o.order_type,
        product: 'CARRYFORWARD',
        price: o.price,
      });
      setLog(`✓ ${o.label} sent`);
    } catch (err) {
      setLog(`✗ ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="tab-body options-order">
      {/* underlying + expiry selector */}
      <div className="oo-controls">
        <select
          className="oo-underlying"
          value={underlying}
          onChange={(e) => { setUnderlying(e.target.value); setStrike(null); }}
        >
          {['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'].map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
        <select
          className="oo-expiry"
          value={expiry}
          onChange={(e) => { setExpiry(e.target.value); setStrike(null); }}
        >
          {(expiries?.expiries ?? []).map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      </div>

      {/* CE / PE toggle */}
      <div className="oo-type-toggle">
        <button
          className={`oo-type-btn${optType === 'CE' ? ' active-ce' : ''}`}
          onClick={() => setOptType('CE')}
        >
          CALL (CE)
        </button>
        <button
          className={`oo-type-btn${optType === 'PE' ? ' active-pe' : ''}`}
          onClick={() => setOptType('PE')}
        >
          PUT (PE)
        </button>
      </div>

      {/* selected option LTP + greeks */}
      {selectedLeg && (
        <div className="oo-ltp-row">
          <span className="oo-ltp">₹{fmt(selectedLeg.ltp)}</span>
          {selectedLeg.iv != null && (
            <span className="oo-greek">IV {selectedLeg.iv}%</span>
          )}
          {selectedLeg.delta != null && (
            <span className={`oo-greek ${cls(selectedLeg.delta)}`}>Δ {selectedLeg.delta}</span>
          )}
          {selectedLeg.theta != null && (
            <span className="oo-greek muted">θ {selectedLeg.theta}</span>
          )}
        </div>
      )}

      {/* strike list */}
      <div className="oo-strikes">
        {visibleRows.map((r) => {
          const leg = r[optType];
          const isAtm = r.strike === atmStrike;
          const isSel = r.strike === strike;
          return (
            <button
              key={r.strike}
              className={`oo-strike-row${isSel ? ' selected' : ''}${isAtm ? ' atm' : ''}`}
              onClick={() => setStrike(r.strike)}
            >
              <span className="oo-strike-val">{r.strike}</span>
              <span className={`oo-strike-ltp${isAtm ? ' atm' : ''}`}>
                {leg?.ltp != null ? fmt(leg.ltp) : '—'}
              </span>
            </button>
          );
        })}
      </div>

      {/* qty + order type */}
      <div className="oo-footer">
        <div className="oo-qty-row">
          <label className="oo-label">
            Lots
            <input
              type="number"
              min={1}
              value={lots}
              onChange={(e) => setLots(Math.max(1, Number(e.target.value)))}
              className="oo-qty-input"
            />
          </label>
          <span className="oo-qty-hint muted">= {totalQty} qty (1L = {lotSize})</span>
        </div>

        <div className="oo-type-row">
          <button
            className={`oo-order-type${orderType === 'MARKET' ? ' active' : ''}`}
            onClick={() => setOrderType('MARKET')}
          >
            MKT
          </button>
          <button
            className={`oo-order-type${orderType === 'LIMIT' ? ' active' : ''}`}
            onClick={() => setOrderType('LIMIT')}
          >
            LMT
          </button>
          {orderType === 'LIMIT' && (
            <input
              type="number"
              step={0.05}
              value={limitPrice}
              onChange={(e) => setLimitPrice(Number(e.target.value))}
              placeholder="Price"
              className="oo-limit-input"
            />
          )}
        </div>

        {/* action buttons */}
        <div className="oo-actions">
          <button
            className="oo-btn buy"
            disabled={!selectedLeg}
            onClick={() => requestOrder('BUY')}
          >
            BUY {optType}
          </button>
          <button
            className="oo-btn sell"
            disabled={!selectedLeg}
            onClick={() => requestOrder('SELL')}
          >
            SELL {optType}
          </button>
        </div>

        {log && <p className={`note ${log.startsWith('✓') ? 'status-ok' : 'status-err'}`}>{log}</p>}
      </div>

      {pending && (
        <ConfirmModal
          title="Confirm order"
          message={pending.label}
          detail={`${pending.order_type} · CARRYFORWARD · qty ${pending.quantity}${pending.price ? ` · ₹${fmt(pending.price)}` : ''}\n\nReal order on AngelOne account.`}
          onConfirm={confirmOrder}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
