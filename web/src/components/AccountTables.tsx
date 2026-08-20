import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmt, signed, cls } from '../lib/format';
import type { Position, Holding, Order } from '../lib/tables';
import { ConfirmModal } from './ConfirmModal';

const numCell = (v: unknown) => <td className="num">{fmt(Number(v))}</td>;
const pnlCell = (v: unknown) => (
  <td className={`num ${cls(Number(v))}`}>{signed(Number(v) || 0)}</td>
);

export function PositionsTab() {
  const queryClient = useQueryClient();
  const [exiting, setExiting] = useState<Position | null>(null);
  const [squaringOff, setSquaringOff] = useState(false);
  const [log, setLog] = useState('');

  const { data } = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<{ positions: Position[]; total_pnl: number }>('/positions'),
    refetchInterval: 15_000,
  });
  const rows = data?.positions || [];

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['positions'] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  }

  async function confirmExit() {
    if (!exiting) return;
    const qty = Math.abs(Number(exiting.netqty));
    const side = Number(exiting.netqty) > 0 ? 'SELL' : 'BUY';
    setExiting(null);
    try {
      await api.post('/positions/exit', {
        tradingsymbol: exiting.tradingsymbol,
        symboltoken: exiting.symboltoken,
        exchange: exiting.exchange,
        producttype: exiting.producttype,
        quantity: qty,
        side,
      });
      setLog(`Exited ${exiting.tradingsymbol}.`);
      refresh();
    } catch (err) {
      setLog(`Exit failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function confirmSquareOffAll() {
    setSquaringOff(false);
    try {
      const res = await api.post<{ results: { symbol: string; ok: boolean }[] }>('/positions/square-off-all');
      const failed = res.results.filter((r) => !r.ok).length;
      setLog(
        failed
          ? `Squared off ${res.results.length - failed}, ${failed} failed.`
          : `Squared off all ${res.results.length} position(s).`
      );
      refresh();
    } catch (err) {
      setLog(`Square-off failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!rows.length) return <div className="empty">No open positions.</div>;
  return (
    <>
      <div className="positions-toolbar">
        <button className="mini sell" onClick={() => setSquaringOff(true)}>
          Square off all
        </button>
      </div>
      {log && <p className="note">{log}</p>}
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="num">Qty</th>
            <th className="num">Avg</th>
            <th className="num">LTP</th>
            <th className="num">P&amp;L</th>
            <th className="num"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.tradingsymbol}</td>
              {numCell(r.netqty)}
              {numCell(r.avgnetprice ?? r.netprice)}
              {numCell(r.ltp)}
              {pnlCell(r.pnl)}
              <td className="num">
                {Number(r.netqty) !== 0 && (
                  <button className="mini sell" onClick={() => setExiting(r)}>
                    Exit
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {exiting && (
        <ConfirmModal
          title="Exit this position?"
          message={`${Number(exiting.netqty) > 0 ? 'SELL' : 'BUY'} ${Math.abs(Number(exiting.netqty))} × ${exiting.tradingsymbol}`}
          detail="MARKET order, flattens the position immediately."
          onConfirm={confirmExit}
          onCancel={() => setExiting(null)}
        />
      )}
      {squaringOff && (
        <ConfirmModal
          title="Square off ALL positions?"
          message={`This closes all ${rows.length} open position(s) at market, right now.`}
          detail="Cannot be undone once confirmed."
          onConfirm={confirmSquareOffAll}
          onCancel={() => setSquaringOff(false)}
        />
      )}
    </>
  );
}

export function HoldingsTab() {
  const { data } = useQuery({
    queryKey: ['holdings'],
    queryFn: () => api.get<{ holdings: Holding[] }>('/holdings'),
    refetchInterval: 15_000,
  });
  const rows = data?.holdings || [];
  if (!rows.length) return <div className="empty">No holdings.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th className="num">Qty</th>
          <th className="num">Avg</th>
          <th className="num">LTP</th>
          <th className="num">P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.tradingsymbol}</td>
            {numCell(r.quantity)}
            {numCell(r.averageprice)}
            {numCell(r.ltp)}
            {pnlCell(r.profitandloss)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CANCELABLE = new Set(['open', 'trigger pending', 'open pending', 'modified']);

export function OrdersTab() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['orders'],
    queryFn: () => api.get<{ orders: Order[] }>('/orders'),
    refetchInterval: 15_000,
  });
  const rows = data?.orders || [];

  async function cancel(orderId: string, variety: string) {
    try {
      await api.post('/order/cancel', { order_id: orderId, variety: variety || 'NORMAL' });
    } finally {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    }
  }

  if (!rows.length) return <div className="empty">No orders today.</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th className="num">Side</th>
          <th className="num">Qty</th>
          <th className="num">Status</th>
          <th className="num"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.tradingsymbol}</td>
            <td className="num">
              <span className={r.transactiontype === 'BUY' ? 'up' : 'down'}>{r.transactiontype}</span>
            </td>
            {numCell(r.quantity)}
            <td className="num">{r.status}</td>
            <td className="num">
              {CANCELABLE.has(String(r.status).toLowerCase()) && (
                <button className="mini" onClick={() => cancel(r.orderid, r.variety || 'NORMAL')}>
                  Cancel
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
