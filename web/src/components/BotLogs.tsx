import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { signed, cls } from '../lib/format';
import { useLiveFeed, type Tick } from '../lib/useLiveFeed';

type LogEntry = { seq: number; level: string; msg: string; ts?: string };
type BotStatus = {
  running: boolean;
  position?: number;
  entry_price?: number;
  last_price?: number;
  realized_pnl?: number;
  unrealized_pnl?: number;
  trades?: number;
  config?: { mode: string; strategy?: string; symbol?: string } | null;
};

export function BotLogs({ onBack, enabled }: { onBack: () => void; enabled: boolean }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<BotStatus>({ running: false });
  const logSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  function appendLog(entry: LogEntry) {
    if (entry.seq <= logSeq.current) return;
    logSeq.current = entry.seq;
    setLogs((prev) => [...prev.slice(-2000), entry]);
  }

  // Initial load + periodic refresh
  useEffect(() => {
    if (!enabled) return;
    const load = async () => {
      const [logsRes, statusRes] = await Promise.all([
        api.get<{ logs: LogEntry[] }>('/bot/logs?since=0'),
        api.get<BotStatus>('/bot/status'),
      ]);
      logsRes.logs.forEach(appendLog);
      setStatus(statusRes);
    };
    load();
    const id = setInterval(async () => {
      const [logsRes, statusRes] = await Promise.all([
        api.get<{ logs: LogEntry[] }>(`/bot/logs?since=${logSeq.current}`),
        api.get<BotStatus>('/bot/status'),
      ]);
      logsRes.logs.forEach(appendLog);
      setStatus(statusRes);
    }, 5_000);
    return () => clearInterval(id);
  }, [enabled]);

  // Live WebSocket events
  const handleFeed = (msg: Tick) => {
    if (msg.type === 'bot_log') appendLog(msg as unknown as LogEntry);
    if (msg.type === 'bot_status') setStatus(msg as unknown as BotStatus);
  };
  useLiveFeed(handleFeed, enabled);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [logs]);

  const badgeClass = status.running
    ? status.config?.mode === 'LIVE' ? 'live' : 'paper'
    : 'idle';

  return (
    <div className="logs-page">
      <div className="logs-topbar">
        <button className="ghost sm" onClick={onBack}>← Back</button>
        <h2>Bot Logs</h2>
        <span className={`badge ${badgeClass}`}>{status.running ? badgeClass : 'idle'}</span>
        {status.config && (
          <span className="logs-ctx muted">
            {status.config.strategy} · {status.config.symbol}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="ghost sm" onClick={() => { setLogs([]); logSeq.current = 0; }}>
          Clear
        </button>
      </div>

      {status.config && (
        <div className="logs-stats">
          <span><b>Position</b><span className={cls(status.position)}>{(status.position ?? 0) > 0 ? 'LONG' : (status.position ?? 0) < 0 ? 'SHORT' : 'flat'}</span></span>
          <span><b>Entry</b>{status.entry_price || '—'}</span>
          <span><b>Last</b>{status.last_price || '—'}</span>
          <span><b>Realized P&L</b><span className={cls(status.realized_pnl)}>{signed(status.realized_pnl)}</span></span>
          <span><b>Open P&L</b><span className={cls(status.unrealized_pnl)}>{signed(status.unrealized_pnl)}</span></span>
          <span><b>Trades</b>{status.trades ?? 0}</span>
        </div>
      )}

      <div className="logs-body" ref={logRef}>
        {logs.length === 0 && (
          <p className="empty">No log entries yet — start the bot to see output here.</p>
        )}
        {logs.map((e) => (
          <div key={e.seq} className={`log-row ${e.level}`}>
            <span className="log-ts">{e.ts || ''}</span>
            <span className="log-msg">{e.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
