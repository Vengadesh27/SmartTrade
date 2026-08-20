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

export function BotPanel({
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
  const [squareOff, setSquareOff] = useState('15:15');
  const [allowShort, setAllowShort] = useState(false);
  const [status, setStatus] = useState<BotStatus>({ running: false });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<{ strategies: Strategy[] }>('/bot/strategies').then((res) => setStrategies(res.strategies));
    api.get<BotStatus>('/bot/status').then(setStatus);
  }, []);

  useEffect(() => {
    setExchange(defaultExchange);
    setSymbol(defaultSymbol);
  }, [defaultExchange, defaultSymbol]);

  function appendLog(entry: LogEntry) {
    if (entry.seq <= logSeq.current) return;
    logSeq.current = entry.seq;
    setLogs((prev) => [...prev.slice(-500), entry]);
  }

  const handleFeed = (msg: Tick) => {
    if (msg.type === 'bot_log') {
      appendLog(msg as unknown as LogEntry);
    } else if (msg.type === 'bot_status') {
      setStatus(msg as unknown as BotStatus);
    } else if (msg.type === 'snapshot') {
      // no bot backlog in the snapshot; /bot/logs below covers anything missed
    }
  };
  useLiveFeed(handleFeed, enabled);

  // Safety net if the socket dropped and reconnected — mirrors the old
  // Electron app's reconcileBot().
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(async () => {
      const [logsRes, statusRes] = await Promise.all([
        api.get<{ logs: LogEntry[] }>(`/bot/logs?since=${logSeq.current}`),
        api.get<BotStatus>('/bot/status'),
      ]);
      logsRes.logs.forEach(appendLog);
      setStatus(statusRes);
    }, 20_000);
    return () => clearInterval(id);
  }, [enabled]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [logs]);

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
          `The bot will place real orders of ${qty} qty without asking again.\n\n` +
          `Caps: max ${maxTrades} trades, stops at -₹${maxLoss}, squares off at ${squareOff}.\n\n` +
          `Only continue if you want live orders sent automatically.`
      );
      if (!ok) return;
      cfg.confirm_live = true;
    }
    logSeq.current = 0;
    setLogs([]);
    try {
      await api.post('/bot/start', cfg);
    } catch (err) {
      appendLog({ seq: 1, level: 'error', msg: `bot failed to start: ${err instanceof Error ? err.message : err}` });
    }
  }

  async function stopBot() {
    await api.post('/bot/stop');
  }

  const desc = strategies.find((s) => s.id === strategy)?.desc || '';
  const badgeClass = status.running ? (status.config?.mode === 'LIVE' ? 'live' : 'paper') : 'idle';

  return (
    <footer className="panel bot">
      <div className="bot-config">
        <div className="panel-head">
          <h2>Strategy bot</h2>
          <div className="bot-actions">
            <span className={`badge ${badgeClass}`}>{status.running ? badgeClass : 'idle'}</span>
            <button className="primary sm" disabled={status.running} onClick={startBot}>
              Start bot
            </button>
            <button className="ghost sm" disabled={!status.running} onClick={stopBot}>
              Stop
            </button>
          </div>
        </div>
        <div className="bot-grid">
          <label>
            Strategy
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Exchange
            <select
              value={exchange}
              onChange={(e) => {
                setExchange(e.target.value);
                setSquareOff(e.target.value === 'MCX' ? '23:15' : '15:15');
              }}
            >
              {['NSE', 'MCX', 'NFO', 'BSE'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            Symbol
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </label>
          <label>
            Interval
            <select value={interval} onChange={(e) => setInterval_(e.target.value)}>
              <option value="ONE_MINUTE">1m</option>
              <option value="THREE_MINUTE">3m</option>
              <option value="FIVE_MINUTE">5m</option>
              <option value="FIFTEEN_MINUTE">15m</option>
            </select>
          </label>
          <label>
            Qty
            <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </label>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as 'PAPER' | 'LIVE')}>
              <option value="PAPER">PAPER (simulated)</option>
              <option value="LIVE">LIVE (real money)</option>
            </select>
          </label>
          <label>
            Poll (s)
            <input type="number" min={10} value={poll} onChange={(e) => setPoll(Number(e.target.value))} />
          </label>
          <label>
            Max trades
            <input type="number" min={1} value={maxTrades} onChange={(e) => setMaxTrades(Number(e.target.value))} />
          </label>
          <label>
            Max loss (₹)
            <input type="number" min={0} value={maxLoss} onChange={(e) => setMaxLoss(Number(e.target.value))} />
          </label>
          <label>
            Square off
            <input value={squareOff} onChange={(e) => setSquareOff(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} />
            <span>Allow short</span>
          </label>
        </div>
        <p className="strategy-desc muted">{desc}</p>
        {status.config && (
          <div className="bot-stats">
            <span>
              <b>Position</b>
              <span className={cls(status.position)}>
                {(status.position ?? 0) > 0 ? 'LONG' : (status.position ?? 0) < 0 ? 'SHORT' : 'flat'}
              </span>
            </span>
            <span>
              <b>Entry</b>
              {status.entry_price || '—'}
            </span>
            <span>
              <b>Last</b>
              {status.last_price || '—'}
            </span>
            <span>
              <b>Realized</b>
              <span className={cls(status.realized_pnl)}>{signed(status.realized_pnl)}</span>
            </span>
            <span>
              <b>Open</b>
              <span className={cls(status.unrealized_pnl)}>{signed(status.unrealized_pnl)}</span>
            </span>
            <span>
              <b>Trades</b>
              {status.trades}
            </span>
          </div>
        )}
      </div>
      <div className="bot-log">
        <div className="panel-head">
          <h2>Log</h2>
          <button className="ghost sm" onClick={() => setLogs([])}>
            Clear
          </button>
        </div>
        <div className="log" ref={logRef}>
          {logs.map((e) => (
            <div key={e.seq}>
              <span className="ts">{e.ts || ''}</span>
              <span className={e.level}>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
