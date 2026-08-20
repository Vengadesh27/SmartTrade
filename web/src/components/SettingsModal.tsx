import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Creds = {
  ANGELONE_API_KEY: string;
  ANGELONE_CLIENT_ID: string;
  ANGELONE_MPIN: string;
  ANGELONE_TOTP_SECRET: string;
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [creds, setCreds] = useState<Creds>({
    ANGELONE_API_KEY: '',
    ANGELONE_CLIENT_ID: '',
    ANGELONE_MPIN: '',
    ANGELONE_TOTP_SECRET: '',
  });
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    api.get<Creds>('/settings').then(setCreds).catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (Object.values(creds).some((v) => !v.trim())) {
      setStatus({ text: 'Fill in all four fields.', ok: false });
      return;
    }
    try {
      const res = await api.post<{ logged_in: boolean; login_error: string | null }>('/settings', creds);
      setStatus({
        text: res.logged_in ? 'Saved and logged in.' : `Saved, but login failed: ${res.login_error}`,
        ok: res.logged_in,
      });
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Save failed.', ok: false });
    }
  }

  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="panel-head">
          <h2>AngelOne API settings</h2>
          <button className="ghost sm" onClick={onClose} type="button">
            ✕
          </button>
        </div>
        <form className="form" onSubmit={save}>
          <label>
            API key
            <input
              type="password"
              value={creds.ANGELONE_API_KEY}
              onChange={(e) => setCreds({ ...creds, ANGELONE_API_KEY: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label>
            Client ID
            <input
              value={creds.ANGELONE_CLIENT_ID}
              onChange={(e) => setCreds({ ...creds, ANGELONE_CLIENT_ID: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label>
            MPIN
            <input
              type="password"
              value={creds.ANGELONE_MPIN}
              onChange={(e) => setCreds({ ...creds, ANGELONE_MPIN: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label>
            TOTP secret
            <input
              type="password"
              value={creds.ANGELONE_TOTP_SECRET}
              onChange={(e) => setCreds({ ...creds, ANGELONE_TOTP_SECRET: e.target.value })}
              autoComplete="off"
            />
          </label>
          <p className="note">Stored server-side in .env. Saving reconnects to AngelOne immediately.</p>
          {status && <p className={`note ${status.ok ? 'status-ok' : 'status-err'}`}>{status.text}</p>}
          <div className="row2">
            <button type="button" className="ghost" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
