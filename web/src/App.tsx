import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { keyOf, PINNED_TICKERS, type Instrument, type Quote } from './lib/types';
import { fmt } from './lib/format';
import { getTheme, applyTheme, setUserTheme, watchSystemTheme, type Theme } from './lib/theme';
import { useLiveFeed, type Tick } from './lib/useLiveFeed';
import { Login } from './components/Login';
import { MpinGate } from './components/MpinGate';
import { TickerStrip } from './components/TickerStrip';
import { Chart } from './components/Chart';
import { RightPanel } from './components/RightPanel';
import { ChatPanel } from './components/ChatPanel';
import { Account } from './components/Account';
import { BotLogs } from './components/BotLogs';
import { OptionChain } from './components/OptionChain';

type AuthState = 'checking' | 'out' | 'in';
type View = 'dashboard' | 'account' | 'logs';

const WS_COUNT = 3;

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [brokerChecking, setBrokerChecking] = useState(true);
  const [clientId, setClientId] = useState('');
  const [username, setUsername] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [feedStatus, setFeedStatus] = useState<'live' | 'off' | 'error'>('off');
  const [chatOpen, setChatOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [clock, setClock] = useState('');
  const [theme, setTheme] = useState<Theme>(getTheme);

  // Workspace state — each workspace remembers its own active instrument
  const [activeWs, setActiveWs] = useState(0);
  const [wsInstruments, setWsInstruments] = useState<Instrument[]>(
    Array.from({ length: WS_COUNT }, () => PINNED_TICKERS[0])
  );

  const active = wsInstruments[activeWs];
  const setActive = (inst: Instrument) =>
    setWsInstruments((prev) => prev.map((v, i) => (i === activeWs ? inst : v)));

  const tokenToKey = useRef<Record<string, string>>({});
  const pendingTicksRef = useRef<Record<string, Tick>>({});
  const tickRafRef = useRef<number | null>(null);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => watchSystemTheme(setTheme), []);

  // session check
  useEffect(() => {
    api.get<{ username: string }>('/auth/me')
      .then((res) => { setUsername(res.username); setAuth('in'); })
      .catch(() => setAuth('out'));
  }, []);

  // seed quotes once broker is live
  useEffect(() => {
    if (!brokerConnected) return;
    (async () => {
      for (const item of PINNED_TICKERS) {
        try {
          const q = await api.get<Quote>(`/quote?symbol=${item.sym}&exchange=${item.exch}`);
          tokenToKey.current[q.token] = keyOf(item);
          setQuotes((prev) => ({ ...prev, [keyOf(item)]: q }));
        } catch { /* ignore */ }
      }
    })();
  }, [brokerConnected]);

  function handleMpinVerified(id: string) {
    setBrokerConnected(true);
    setClientId(id);
  }

  // skip MPIN gate if broker session already live
  useEffect(() => {
    if (auth !== 'in') return;
    api.get<{ logged_in: boolean; client_id: string | null }>('/health')
      .then((res) => { if (res.logged_in && res.client_id) handleMpinVerified(res.client_id); })
      .catch(() => {})
      .finally(() => setBrokerChecking(false));
  }, [auth]);

  // clock
  useEffect(() => {
    const id = setInterval(() =>
      setClock(new Date().toLocaleTimeString('en-IN', { hour12: false })), 1000);
    return () => clearInterval(id);
  }, []);

  // live feed
  const handleFeed = useCallback((msg: Tick) => {
    if (msg.type === 'socket') {
      setFeedStatus(msg.status === 'open' ? 'live' : 'off');
    } else if (msg.type === 'feed') {
      setFeedStatus(msg.connected ? 'live' : 'error');
    } else if (msg.type === 'snapshot') {
      setFeedStatus(((msg.feed as { connected?: boolean } | undefined)?.connected ? 'live' : 'off'));
      for (const t of (msg.ticks as Tick[]) || []) applyTick(t);
    } else if (msg.type === 'tick') {
      applyTick(msg);
    }
  }, []);

  function applyTick(tick: Tick) {
    const key = tokenToKey.current[String(tick.token)];
    if (!key) return;
    pendingTicksRef.current[key] = { ...pendingTicksRef.current[key], ...tick };
    if (tickRafRef.current === null) {
      tickRafRef.current = requestAnimationFrame(() => {
        tickRafRef.current = null;
        const pending = pendingTicksRef.current;
        pendingTicksRef.current = {};
        setQuotes((prev) => {
          const next = { ...prev };
          for (const [k, t] of Object.entries(pending)) {
            next[k] = { ...prev[k], ...t } as Quote;
          }
          return next;
        });
      });
    }
  }

  const handleOpen = useCallback((send: (msg: unknown) => void) => {
    send({
      action: 'subscribe',
      symbols: PINNED_TICKERS.map((t) => ({ symbol: t.sym, exchange: t.exch })),
    });
  }, []);

  useLiveFeed(handleFeed, auth === 'in' && brokerConnected, handleOpen);

  // header stats: funds + trades count
  const { data: fundsData } = useQuery({
    queryKey: ['funds'],
    queryFn: () => api.get<Record<string, string>>('/funds'),
    enabled: brokerConnected,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
  const { data: tradesData } = useQuery({
    queryKey: ['trades'],
    queryFn: () => api.get<{ trades: unknown[] }>('/trades'),
    enabled: brokerConnected,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const balance = fundsData?.net ? fmt(parseFloat(fundsData.net)) : '—';
  const available = fundsData?.availablecash ? fmt(parseFloat(fundsData.availablecash)) : '—';
  const tradeCount = tradesData?.trades?.length ?? 0;

  // ── boot / auth gates ────────────────────────────────────────────────────
  if (auth === 'checking' || (auth === 'in' && brokerChecking)) {
    return (
      <div className="boot-screen">
        <div className="boot-box">
          <div className="boot-spinner" />
        </div>
      </div>
    );
  }
  if (auth === 'out') {
    return (
      <Login onLoggedIn={(name) => { setUsername(name); setAuth('in'); }} />
    );
  }
  if (!brokerConnected) {
    return <MpinGate onVerified={handleMpinVerified} />;
  }

  const activeQuote = active ? quotes[keyOf(active)] : null;

  if (view === 'account') {
    return (
      <Account
        username={username}
        clientId={clientId}
        feedStatus={feedStatus}
        clock={clock}
        onBack={() => setView('dashboard')}
        onLogout={async () => { await api.post('/auth/logout'); setAuth('out'); }}
      />
    );
  }

  if (view === 'logs') {
    return (
      <div className="app-shell">
        <BotLogs onBack={() => setView('dashboard')} enabled={auth === 'in' && brokerConnected} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* ── NAVBAR ─────────────────────────────────────────────────── */}
      <header className="topbar">
        {/* left: watchlist */}
        <TickerStrip quotes={quotes} active={active} onSelect={setActive} />

        {/* center: brand */}
        <div className="topbar-brand">
          <span
            className={`dot ${feedStatus === 'live' ? 'ok' : feedStatus === 'error' ? 'err' : ''}`}
            title={`Feed ${feedStatus}`}
          />
          <strong>SmartTrade</strong>
        </div>

        {/* right: account stats */}
        <div className="topbar-stats">
          <div className="topbar-stat">
            <span className="topbar-stat-label">Trades</span>
            <span className="topbar-stat-value">{tradeCount}</span>
          </div>
          <div className="topbar-stat">
            <span className="topbar-stat-label">Balance</span>
            <span className="topbar-stat-value">{balance}</span>
          </div>
          <div className="topbar-stat">
            <span className="topbar-stat-label">Available</span>
            <span className="topbar-stat-value">{available}</span>
          </div>
          <span className="topbar-sep" />
          <button className={`ghost${chatOpen ? ' on' : ''}`} onClick={() => setChatOpen((v) => !v)}>
            Assistant
          </button>
          <button className="ghost" onClick={() => setChainOpen(true)}>
            Options
          </button>
          <button className="ghost" onClick={() => setView('logs')}>
            Logs
          </button>
          <button
            className="ghost icon-btn"
            title="Switch theme"
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark';
              setUserTheme(next);
              setTheme(next);
            }}
          >
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
              </svg>
            )}
          </button>
          <button className="account-avatar-btn" title="My account" onClick={() => setView('account')}>
            {username.slice(0, 2).toUpperCase() || '—'}
          </button>
        </div>
      </header>

      {/* ── MAIN BODY ──────────────────────────────────────────────── */}
      <div className="main-body">
        {/* workspace tab bar */}
        <div className="ws-bar">
          {Array.from({ length: WS_COUNT }, (_, i) => (
            <button
              key={i}
              className={`ws-tab${activeWs === i ? ' active' : ''}`}
              onClick={() => setActiveWs(i)}
            >
              WS {i + 1}
            </button>
          ))}
        </div>

        {/* workspace content */}
        <div className={`workspace${chatOpen ? ' with-chat' : ''}`}>
          {/* left 70%: dual charts */}
          <div className="workspace-charts">
            <Chart active={active} tick={activeQuote} defaultInterval="FIFTEEN_MINUTE" />
            <Chart active={active} tick={activeQuote} defaultInterval="THREE_MINUTE" />
          </div>

          {/* right 30%: order / positions / bot */}
          <aside className="workspace-panel">
            <RightPanel active={active} quote={activeQuote} enabled={auth === 'in' && brokerConnected} />
          </aside>

          {/* chat panel slides in on the far right */}
          {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
        </div>
      </div>

      {chainOpen && (
        <OptionChain underlyingLtp={activeQuote?.ltp ?? null} onClose={() => setChainOpen(false)} />
      )}
    </div>
  );
}
