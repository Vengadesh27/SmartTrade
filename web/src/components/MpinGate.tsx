import { useState } from 'react';
import { api, ApiError } from '../lib/api';

export function MpinGate({ onVerified }: { onVerified: (clientId: string) => void }) {
  const [mpin, setMpin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post<{ client_id: string }>('/login', { mpin });
      onVerified(res.client_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect.');
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-parallax">
        <div className="login-layer login-layer-grid" />
        <div className="login-layer login-orb login-orb-a" />
        <div className="login-layer login-orb login-orb-b" />
      </div>
      <form className="login-box form" onSubmit={submit}>
        <h1>Verify MPIN</h1>
        <span className="muted">Enter your AngelOne MPIN to connect this session</span>
        {error && <p className="login-error">{error}</p>}
        <label>
          MPIN
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={mpin}
            onChange={(e) => setMpin(e.target.value.replace(/\D/g, ''))}
            autoFocus
            required
          />
        </label>
        <button type="submit" className="primary" disabled={busy || mpin.length < 4}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <p className="note">Never stored — checked live against AngelOne on every login.</p>
      </form>
    </div>
  );
}
