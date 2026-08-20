import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { signed, cls } from '../lib/format';
import { useLiveFeed, type Tick } from '../lib/useLiveFeed';

type Strategy = { id: string; name: string; desc: string };
type BotStatus = {
  running: boolean;
  position?: number;
  entry_price?: number;
  last_price?: number;
  realized_pnl?: number;
  unrealized_pnl?: number;
  trades?: number;
  config?: { mode: string } | null;
};
type LogEntry = { seq: number; level: string; msg: string; ts?: string };

export function BotConfig({
  defaultSymbol,
  defaultExchange,
  enabled,
}: {
  defaultSymbol: string;
  defaultExchange: string;
  enabled: boolean;
}) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategy, setStrategy] = useState('sma_crossover');
  const [exchange, setExchange] = useState(defaultExchange);
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [interval, setInterval_] = useState('FIVE_MINUTE');
  const [qty, setQty] = useState(1);
  const [mode, setMode] = useState<'PAPER' | 'LIVE'>('PAPER');
  const [poll, setPoll] = useState(30);
  const [maxTrades, setMaxTrades] = useState(6);
  const [maxLoss, setMaxLoss] = useState(2000);
  const [squareOff, setSquareOff] = useState(defaultExchange === 'MCX' ? '23:15' : '15:15');
  const [allowShort, setAllowShort] = useState(false);
  const [status, setStatus] = useState<BotStatus>({ running: false });
  const logSeq = useRef(0);

  useEffect(() => {
    api.get<{ strategies: Strategy[] }>('/bot/strategies').then((r) => setStrategies(r.strategies));
    api.get<BotStatus>('/bot/status').then(setStatus);
  }, []);

  useEffect(() => {
    setExchange(defaultExchange);
    setSymbol(defaultSymbol);
    setSquareOff(defaultExchange === 'MCX' ? '23:15' : '15:15');
  }, [defaultExchange, defaultSymbol]);

  const handleFeed = (msg: Tick) => {
    if (msg.type === 'bot_status') setStatus(msg as unknown as BotStatus);
    if (msg.type === 'bot_log') {
      const e = msg as unknown as LogEntry;
      if (e.seq > logSeq.current) logSeq.current = e.seq;
    }
  };
  useLiveFeed(handleFeed, enabled);

  async function startBot() {
    const cfg = {
      strategy,
      symbol: symbol.toUpperCase(),
      exchange,
      interval,
      quantity: qty,
      mode,
      poll_seconds: poll,
      max_trades: maxTrades,
      max_daily_loss: maxLoss,
      square_off: squareOff,
      allow_short: allowShort,
      confirm_live: false,
    };
    if (mode === 'LIVE') {
      const ok = window.confirm(
        `LIVE trading: ${strategy} on ${cfg.symbol} (${exchange})\n\n` +
        `Real orders of ${qty} qty. Caps: ${maxTrades} trades, -₹${maxLoss} loss, square-off ${squareOff}.\n\nContinue?`
      );
      if (!ok) return;
      cfg.confirm_live = true;
    }
    logSeq.current = 0;
    await api.post('/bot/start', cfg).catch(() => {});
  }

  const desc = strategies.find((s) => s.id === strategy)?.desc || '';
  const badgeClass = status.running ? (status.config?.mode === 'LIVE' ? 'live' : 'paper') : 'idle';

  return (
    <div className="tab-body bot-config-tab">
      {/* status bar */}
      <div className="bot-status-row">
        <span className={`badge ${badgeClass}`}>{status.running ? badgeClass : 'idle'}</span>
        <button className="primary sm" disabled={status.running} onClick={startBot}>Start</button>
        <button className="ghost sm" disabled={!status.running} onClick={() => api.post('/bot/stop')}>Stop</button>
      </div>

      {status.config && (
        <div className="bot-stats">
          <span><b>Pos</b><span className={cls(status.position)}>{(status.position ?? 0) > 0 ? 'LONG' : (status.position ?? 0) < 0 ? 'SHORT' : 'flat'}</span></span>
          <span><b>Entry</b>{status.entry_price || '—'}</span>
          <span><b>R-PnL</b><span className={cls(status.realized_pnl)}>{signed(status.realized_pnl)}</span></span>
          <span><b>U-PnL</b><span className={cls(status.unrealized_pnl)}>{signed(status.unrealized_pnl)}</span></span>
          <span><b>Trades</b>{status.trades}</span>
        </div>
      )}

      <div className="form">
        <label>Strategy
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <p className="note">{desc}</p>
        <div className="row2">
          <label>Exchange
            <select value={exchange} onChange={(e) => { setExchange(e.target.value); setSquareOff(e.target.value === 'MCX' ? '23:15' : '15:15'); }}>
              {['NSE', 'MCX', 'NFO', 'BSE'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label>Symbol
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </label>
        </div>
        <div className="row2">
          <label>Interval
            <select value={interval} onChange={(e) => setInterval_(e.target.value)}>
              <option value="ONE_MINUTE">1m</option>
              <option value="THREE_MINUTE">3m</option>
              <option value="FIVE_MINUTE">5m</option>
              <option value="FIFTEEN_MINUTE">15m</option>
            </select>
          </label>
          <label>Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as 'PAPER' | 'LIVE')}>
              <option value="PAPER">PAPER</option>
              <option value="LIVE">LIVE</option>
            </select>
          </label>
        </div>
        <div className="row2">
          <label>Qty<input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} /></label>
          <label>Poll (s)<input type="number" min={10} value={poll} onChange={(e) => setPoll(Number(e.target.value))} /></label>
        </div>
        <div className="row2">
          <label>Max trades<input type="number" min={1} value={maxTrades} onChange={(e) => setMaxTrades(Number(e.target.value))} /></label>
          <label>Max loss ₹<input type="number" min={0} value={maxLoss} onChange={(e) => setMaxLoss(Number(e.target.value))} /></label>
        </div>
        <label>Square off<input value={squareOff} onChange={(e) => setSquareOff(e.target.value)} /></label>
        <label className="check">
          <input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} />
          Allow short
        </label>
      </div>
    </div>
  );
}
