import { useState } from 'react';
import { api } from '../lib/api';
import { fmt, signed } from '../lib/format';
import type { Instrument, Quote } from '../lib/types';
import { ConfirmModal } from './ConfirmModal';

type PendingOrder = {
  side: 'BUY' | 'SELL';
  symbol: string;
  exchange: string;
  quantity: number;
  order_type: string;
  product: string;
  price: number;
  trigger_price: number;
};

export function OrderForm({
  active,
  quote,
  onOrderSent,
}: {
  active: Instrument | null;
  quote: Quote | null;
  onOrderSent?: () => void;
}) {
  const [exchange, setExchange] = useState('NSE');
  const [symbol, setSymbol] = useState(active?.sym || '');
  const [qty, setQty] = useState(1);
  const [product, setProduct] = useState('INTRADAY');
  const [orderType, setOrderType] = useState('MARKET');
  const [price, setPrice] = useState(0);
  const [trigger, setTrigger] = useState(0);
  const [pending, setPending] = useState<PendingOrder | null>(null);
  const [log, setLog] = useState('');

  const effectiveSymbol = symbol || active?.sym || '';
  const effectiveExchange = active ? active.exch : exchange;

  function requestOrder(side: 'BUY' | 'SELL') {
    if (!effectiveSymbol || !qty) return;
    setPending({
      side,
      symbol: effectiveSymbol.toUpperCase(),
      exchange: effectiveExchange,
      quantity: qty,
      order_type: orderType,
      product,
      price,
      trigger_price: trigger,
    });
  }

  async function confirmOrder() {
    if (!pending) return;
    const order = pending;
    setPending(null);
    try {
      await api.post('/order', order);
      setLog(`${order.side} ${order.quantity} ${order.symbol} sent.`);
      onOrderSent?.();
    } catch (err) {
      setLog(`Order failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <>
      <div className="tab-body">
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <div className="row2">
            <label>
              Exchange
              <select value={effectiveExchange} onChange={(e) => setExchange(e.target.value)} disabled={!!active}>
                {['NSE', 'MCX', 'NFO', 'BSE', 'CDS'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Symbol
              <input value={effectiveSymbol} onChange={(e) => setSymbol(e.target.value)} />
            </label>
          </div>
          <div className="row2">
            <label>
              Qty
              <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
            </label>
            <label>
              Product
              <select value={product} onChange={(e) => setProduct(e.target.value)}>
                {['INTRADAY', 'DELIVERY', 'CARRYFORWARD', 'MARGIN'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row2">
            <label>
              Type
              <select value={orderType} onChange={(e) => setOrderType(e.target.value)}>
                <option value="MARKET">MARKET</option>
                <option value="LIMIT">LIMIT</option>
                <option value="STOPLOSS_LIMIT">SL</option>
                <option value="STOPLOSS_MARKET">SL-M</option>
              </select>
            </label>
            <label>
              Price
              <input type="number" step={0.05} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
            </label>
          </div>
          {orderType.startsWith('STOPLOSS') && (
            <label>
              Trigger price
              <input
                type="number"
                step={0.05}
                value={trigger}
                onChange={(e) => setTrigger(Number(e.target.value))}
              />
            </label>
          )}
          <div className="ltp-hint">{quote ? `LTP ${fmt(quote.ltp)} (${signed(quote.change_pct)}%)` : '—'}</div>
          <div className="row2">
            <button type="button" className="buy" onClick={() => requestOrder('BUY')}>
              BUY
            </button>
            <button type="button" className="sell" onClick={() => requestOrder('SELL')}>
              SELL
            </button>
          </div>
          <p className="note">Every order asks for confirmation before it is sent.</p>
          {log && <p className="note">{log}</p>}
        </form>
      </div>

      {pending && (
        <ConfirmModal
          title="Send this order?"
          message={`${pending.side} ${pending.quantity} × ${pending.symbol} on ${pending.exchange}`}
          detail={
            `${pending.order_type} · ${pending.product}` +
            (pending.price ? ` · limit ₹${fmt(pending.price)}` : '') +
            (pending.trigger_price ? ` · trigger ₹${fmt(pending.trigger_price)}` : '') +
            '\n\nThis places a real order on your AngelOne account.'
          }
          onConfirm={confirmOrder}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
