import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';

/** A faint candlestick silhouette used across the parallax layers. */
function CandleRow({ seed }: { seed: number }) {
  const bars = Array.from({ length: 14 }, (_, i) => {
    const h = 20 + ((seed + i * 37) % 60);
    const up = (seed + i) % 2 === 0;
    return { h, up };
  });
  return (
    <svg viewBox="0 0 280 100" className="login-candles" preserveAspectRatio="none">
      {bars.map((b, i) => (
        <rect
          key={i}
          x={i * 20 + 4}
          y={50 - b.h / 2}
          width={10}
          height={b.h}
          fill={b.up ? 'var(--up)' : 'var(--down)'}
          opacity={0.5}
        />
      ))}
    </svg>
  );
}

export function Login({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sceneRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = scene.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5; // -0.5..0.5
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      scene.style.setProperty('--px', String(nx));
      scene.style.setProperty('--py', String(ny));
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
      setError(err instanceof ApiError ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen" ref={sceneRef} onMouseMove={handleMouseMove}>
      <div className="login-parallax">
        <div className="login-layer login-layer-grid" />
        <div className="login-layer login-orb login-orb-a" />
        <div className="login-layer login-orb login-orb-b" />
        <div className="login-layer login-layer-candles login-layer-candles-back">
          <CandleRow seed={3} />
        </div>
        <div className="login-layer login-layer-candles login-layer-candles-front">
          <CandleRow seed={11} />
        </div>
      </div>

      <form className="login-box form" onSubmit={submit}>
        <h1>SmartTrade</h1>
        <span className="muted">Sign in to continue</span>
        {error && <p className="login-error">{error}</p>}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
