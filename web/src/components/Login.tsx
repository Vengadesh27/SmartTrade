import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';

export function Login({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [mpin, setMpin] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [notice, setNotice] = useState('');
  const mouseRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (!mouseRef.current) return;
      const rect = mouseRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      mouseRef.current.style.setProperty('--mx', `${x}%`);
      mouseRef.current.style.setProperty('--my', `${y}%`);
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post<{ username: string }>('/auth/login', { username, password });
      onLoggedIn(res.username);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid credentials.');
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirm) return setError('Passwords do not match.');
    if (newPassword.length < 8) return setError('Minimum 8 characters.');
    setBusy(true);
    try {
      const res = await api.post<{ username: string }>('/auth/reset', { mpin, new_password: newPassword });
      setResetting(false);
      setMpin(''); setNewPassword(''); setConfirm('');
      setUsername(res.username);
      setPassword('');
      setNotice(`Password updated. Sign in as ${res.username}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ln-root" ref={mouseRef} onMouseMove={handleMouseMove}>
      {/* animated background */}
      <div className="ln-bg">
        <div className="ln-orb ln-orb1" />
        <div className="ln-orb ln-orb2" />
        <div className="ln-orb ln-orb3" />
        <div className="ln-grid" />
        <Ticker />
      </div>

      <div className="ln-card">
        {/* logo */}
        <div className="ln-logo">
          <svg viewBox="0 0 40 40" fill="none">
            <rect x="4" y="20" width="6" height="16" rx="1" fill="var(--up)" opacity="0.9"/>
            <rect x="14" y="12" width="6" height="24" rx="1" fill="var(--up)"/>
            <rect x="24" y="6" width="6" height="30" rx="1" fill="var(--primary)"/>
            <rect x="34" y="16" width="6" height="20" rx="1" fill="var(--down)" opacity="0.8"/>
            <line x1="4" y1="18" x2="40" y2="10" stroke="var(--primary)" strokeWidth="1.5" opacity="0.5"/>
          </svg>
        </div>
        <h1 className="ln-title">SmartTrade</h1>
        <p className="ln-sub">{resetting ? 'Reset your password' : 'Welcome back'}</p>

        {notice && <div className="ln-notice">{notice}</div>}
        {error && <div className="ln-err">{error}</div>}

        {resetting ? (
          <form onSubmit={submitReset} className="ln-form">
            <div className="ln-field">
              <label>AngelOne MPIN</label>
              <input type="password" inputMode="numeric" maxLength={6} value={mpin}
                onChange={(e) => setMpin(e.target.value)} autoFocus required placeholder="••••" />
            </div>
            <div className="ln-field">
              <label>New password</label>
              <input type="password" value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)} minLength={8} required placeholder="Min 8 chars" />
            </div>
            <div className="ln-field">
              <label>Confirm password</label>
              <input type="password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} minLength={8} required placeholder="Repeat password" />
            </div>
            <button type="submit" className="ln-btn" disabled={busy}>
              {busy ? <span className="ln-spin" /> : 'Update password'}
            </button>
            <button type="button" className="ln-link" onClick={() => { setResetting(false); setError(''); }}>
              ← Back to sign in
            </button>
          </form>
        ) : (
          <form onSubmit={submit} className="ln-form">
            <div className="ln-field">
              <label>Username</label>
              <input value={username} onChange={(e) => setUsername(e.target.value)}
                autoFocus required placeholder="admin" />
            </div>
            <div className="ln-field">
              <label>Password</label>
              <div className="ln-pw">
                <input type={showPw ? 'text' : 'password'} value={password}
                  onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" />
                <button type="button" className="ln-eye" onClick={() => setShowPw((v) => !v)}>
                  {showPw ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <button type="submit" className="ln-btn" disabled={busy}>
              {busy ? <span className="ln-spin" /> : 'Sign in'}
            </button>
            <button type="button" className="ln-link" onClick={() => { setResetting(true); setError(''); }}>
              Forgot password?
            </button>
          </form>
        )}

        <p className="ln-footer">AngelOne SmartAPI · Secure session</p>
      </div>
    </div>
  );
}

/* animated mini ticker at the bottom of the bg */
function Ticker() {
  const pairs = [
    { label: 'NIFTY 50', val: '24,231', chg: '+0.42%', up: true },
    { label: 'CRUDE OIL', val: '8,351', chg: '-0.18%', up: false },
    { label: 'BANKNIFTY', val: '51,842', chg: '+0.61%', up: true },
    { label: 'SENSEX', val: '79,468', chg: '+0.38%', up: true },
    { label: 'GOLD', val: '72,340', chg: '-0.05%', up: false },
    { label: 'SILVER', val: '89,120', chg: '+1.2%', up: true },
  ];
  const items = [...pairs, ...pairs];
  return (
    <div className="ln-ticker-wrap">
      <div className="ln-ticker">
        {items.map((p, i) => (
          <span key={i} className="ln-tick-item">
            <span className="ln-tick-label">{p.label}</span>
            <span className="ln-tick-val">{p.val}</span>
            <span className={`ln-tick-chg ${p.up ? 'up' : 'dn'}`}>{p.chg}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
