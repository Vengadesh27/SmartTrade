import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { getChartSnapshot } from '../lib/chartContext';
import { Markdown } from '../lib/markdown';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: string;
};

type HistoryResponse = { messages: ChatMessage[]; configured: boolean };

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['chat'],
    queryFn: () => api.get<HistoryResponse>('/chat/history'),
  });

  const send = useMutation({
    // The live chart snapshot rides along so the assistant analyses what the
    // user is actually looking at.
    mutationFn: (message: string) =>
      api.post<HistoryResponse>('/chat', { message, context: getChartSnapshot() }),
    onMutate: () => setError(''),
    onSuccess: (res) => qc.setQueryData(['chat'], { messages: res.messages, configured: true }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to send.'),
  });

  const clear = useMutation({
    mutationFn: () => api.post('/chat/clear'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat'] }),
  });

  const messages = data?.messages ?? [];

  // Follow the conversation as it grows, including while a reply is pending.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, send.isPending]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    send.mutate(text);
  }

  return (
    <aside className="chat-panel">
      <div className="panel-head">
        <h2>Assistant</h2>
        <div className="chat-head-actions">
          <button className="tv-btn" onClick={() => clear.mutate()} disabled={!messages.length}>
            Clear
          </button>
          <button className="tv-btn" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {data && !data.configured && (
        <p className="chat-warning">
          No Gemini API key yet — add <b>GEMINI_API_KEY</b> in Settings to start chatting.
        </p>
      )}

      <div className="chat-log">
        {!messages.length && <div className="empty">Ask about indicators, SMC, the market, or this app.</div>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {/* Assistant replies are Markdown; the user's own text stays literal. */}
            <div className="chat-bubble">
              {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
            </div>
            <span className="chat-ts">{m.ts.slice(11, 16)}</span>
          </div>
        ))}
        {send.isPending && (
          <div className="chat-msg assistant">
            <div className="chat-bubble chat-typing">thinking…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="chat-error">{error}</p>}

      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter starts a new line.
            if (e.key === 'Enter' && !e.shiftKey) submit(e);
          }}
          placeholder="Ask something…"
          rows={2}
        />
        <button type="submit" className="primary" disabled={send.isPending || !draft.trim()}>
          {send.isPending ? '…' : 'Send'}
        </button>
      </form>
    </aside>
  );
}
