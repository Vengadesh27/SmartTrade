import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Creds = {
  ANGELONE_API_KEY: string;
  ANGELONE_CLIENT_ID: string;
  ANGELONE_MPIN: string;
  ANGELONE_TOTP_SECRET: string;
  GEMINI_API_KEY: string;
};

/** Only the AngelOne fields are required; Gemini is optional. */
const BROKER_FIELDS: (keyof Creds)[] = [
  'ANGELONE_API_KEY',
  'ANGELONE_CLIENT_ID',
  'ANGELONE_MPIN',
  'ANGELONE_TOTP_SECRET',
];

/** Credential editor. Lives on the profile page; values never leave the server
 *  except to populate this form. */
export function SettingsForm() {
  const [creds, setCreds] = useState<Creds>({
    ANGELONE_API_KEY: '',
    ANGELONE_CLIENT_ID: '',
    ANGELONE_MPIN: '',
    ANGELONE_TOTP_SECRET: '',
    GEMINI_API_KEY: '',
  });
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Creds>('/settings')
      .then((v) => setCreds((prev) => ({ ...prev, ...v })))
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (BROKER_FIELDS.some((k) => !creds[k].trim())) {
      setStatus({ text: 'Fill in all four AngelOne fields.', ok: false });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ logged_in: boolean; login_error: string | null }>('/settings', creds);
      setStatus({
        text: res.logged_in ? 'Saved and connected to AngelOne.' : `Saved, but login failed: ${res.login_error}`,
        ok: res.logged_in,
      });
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : 'Save failed.', ok: false });
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof Creds, label: string, secret = true) => (
    <label>
      {label}
      <input
        type={secret ? 'password' : 'text'}
        value={creds[key]}
        onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
        autoComplete="off"
      />
    </label>
  );

  return (
    <form className="form" onSubmit={save}>
      <div className="row2">
        {field('ANGELONE_API_KEY', 'API key')}
        {field('ANGELONE_CLIENT_ID', 'Client ID', false)}
      </div>
      <div className="row2">
        {field('ANGELONE_MPIN', 'MPIN')}
        {field('ANGELONE_TOTP_SECRET', 'TOTP secret')}
      </div>
      {field('GEMINI_API_KEY', 'Gemini API key — optional, powers the Assistant')}
      <p className="note">
        Stored server-side in .env, never in the browser. Reconnects to AngelOne only when a broker field
        changes.
      </p>
      {status && <p className={`note ${status.ok ? 'status-ok' : 'status-err'}`}>{status.text}</p>}
      <div>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save credentials'}
        </button>
      </div>
    </form>
  );
}
