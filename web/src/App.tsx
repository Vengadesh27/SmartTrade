import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { fmt, signed, cls } from './lib/format';
import { keyOf, PINNED_TICKERS, type Instrument, type Quote } from './lib/types';
import { getTheme, applyTheme, setUserTheme, watchSystemTheme, type Theme } from './lib/theme';
import { useLiveFeed, type Tick } from './lib/useLiveFeed';
import { Login } from './components/Login';
import { MpinGate } from './components/MpinGate';
import { TickerStrip } from './components/TickerStrip';
import { Chart } from './components/Chart';
import { RightPanel } from './components/RightPanel';
import { ChatPanel } from './components/ChatPanel';
import { BotPanel } from './components/BotPanel';
import { Account } from './components/Account';
import { OptionChain } from './components/OptionChain';

type AuthState = 'checking' | 'out' | 'in';
type View = 'dashboard' | 'account';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [brokerChecking, setBrokerChecking] = useState(true);
  const [clientId, setClientId] = useState('');
  const [username, setUsername] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [active, setActive] = useState<Instrument | null>(PINNED_TICKERS[0]);
  const [feedStatus, setFeedStatus] = useState<'live' | 'off' | 'error'>('off');
  const [chatOpen, setChatOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [clock, setClock] = useState('');
  const [theme, setTheme] = useState<Theme>(getTheme);
  const tokenToKey = useRef<Record<string, string>>({});

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // ---- follow the OS theme live, unless the user has explicitly overridden it ----
  useEffect(() => watchSystemTheme(setTheme), []);

  // ---- session check on load ----
  useEffect(() => {
    api
      .get<{ username: string }>('/auth/me')
      .then((res) => {
        setUsername(res.username);
        setAuth('in');
      })
      .catch(() => setAuth('out'));
  }, []);

  // ---- once the broker session is verified (MPIN gate), seed quotes ----
  useEffect(() => {
    if (!brokerConnected) return;
    (async () => {
      for (const item of PINNED_TICKERS) {
        try {
          const q = await api.get<Quote>(`/quote?symbol=${item.sym}&exchange=${item.exch}`);
          tokenToKey.current[q.token] = keyOf(item);
          setQuotes((prev) => ({ ...prev, [keyOf(item)]: q }));
        } catch {
          /* quote fetch failures surface via the "—" placeholder */
        }
      }
    })();
  }, [brokerConnected]);

  function handleMpinVerified(id: string) {
    setBrokerConnected(true);
    setClientId(id);
  }

  // ---- skip the MPIN gate if the backend's broker session is already live
  // (e.g. a page reload while the Python process is still running) ----
  useEffect(() => {
    if (auth !== 'in') return;
    api
      .get<{ logged_in: boolean; client_id: string | null }>('/health')
      .then((res) => {
        if (res.logged_in && res.client_id) handleMpinVerified(res.client_id);
      })
      .catch(() => {})
      .finally(() => setBrokerChecking(false));
  }, [auth]);

  // ---- clock ----
  useEffect(() => {
    const id = setInterval(() => setClock(new Date().toLocaleTimeString('en-IN', { hour12: false })), 1000);
    return () => clearInterval(id);
  }, []);

  // ---- live feed ----
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
    setQuotes((prev) => ({ ...prev, [key]: { ...prev[key], ...tick } as Quote }));
  }

  const handleOpen = useCallback((send: (msg: unknown) => void) => {
    send({
      action: 'subscribe',
      symbols: PINNED_TICKERS.map((t) => ({ symbol: t.sym, exchange: t.exch })),
    });
  }, []);

  useLiveFeed(handleFeed, auth === 'in' && brokerConnected, handleOpen);

  const { data: funds } = useQuery({
    queryKey: ['funds'],
    queryFn: () => api.get<{ availablecash?: string; net?: string }>('/funds'),
    enabled: brokerConnected,
    refetchInterval: 15_000,
  });
  const { data: positions } = useQuery({
    queryKey: ['positions'],
    queryFn: () => api.get<{ total_pnl: number }>('/positions'),
    enabled: brokerConnected,
    refetchInterval: 15_000,
  });

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
      <Login
        onLoggedIn={(name) => {
          setUsername(name);
          setAuth('in');
        }}
      />
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
        onBack={() => setView('dashboard')}
        onLogout={async () => {
          await api.post('/auth/logout');
          setAuth('out');
        }}
      />
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="dot ok" />
          <strong>SmartTrade</strong>
        </div>
        <TickerStrip quotes={quotes} active={active} onSelect={setActive} />
        <div className="topstats">
          <div className="stat">
            <label>Client</label>
            <span>{clientId || '—'}</span>
          </div>
          <div className="stat">
            <label>Available</label>
            <span>{funds ? '₹' + fmt(Number(funds.availablecash ?? funds.net ?? 0), 0) : '—'}</span>
          </div>
          <div className="stat">
            <label>Day P&amp;L</label>
            <span className={positions ? cls(positions.total_pnl) : ''}>
              {positions ? signed(positions.total_pnl) : '—'}
            </span>
          </div>
          <div className="stat">
            <label>Feed</label>
            <span className={feedStatus === 'live' ? 'up' : 'muted'}>{feedStatus}</span>
          </div>
          <div className="stat">
            <label>Clock</label>
            <span>{clock}</span>
          </div>
        </div>
        <button className="ghost" onClick={() => setChainOpen(true)}>
          Options
        </button>
        <button className={`ghost${chatOpen ? ' on' : ''}`} onClick={() => setChatOpen((v) => !v)}>
          Assistant
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
        <button className="ghost" onClick={() => setView('account')}>
          Settings
        </button>
        <button
          className="ghost"
          onClick={async () => {
            await api.post('/auth/logout');
            setAuth('out');
          }}
        >
          Logout
        </button>
        <button className="account-avatar-btn" title="My account" onClick={() => setView('account')}>
          {username.slice(0, 2).toUpperCase() || '—'}
        </button>
      </header>

      <main className={`grid${chatOpen ? ' with-chat' : ''}`}>
        <Chart active={active} tick={activeQuote} />
        <RightPanel active={active} quote={activeQuote} />
        {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
      </main>

      <BotPanel defaultSymbol={active?.sym || 'NIFTY'} defaultExchange={active?.exch || 'NSE'} enabled={auth === 'in'} />

      {chainOpen && (
        <OptionChain underlyingLtp={activeQuote?.ltp ?? null} onClose={() => setChainOpen(false)} />
      )}
    </>
  );
}
