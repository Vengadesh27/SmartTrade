import { useEffect, useRef } from 'react';
import { API_BASE } from './api';

export type Tick = {
  type: 'tick' | 'snapshot' | 'feed' | 'socket' | 'bot_log' | 'bot_status';
  token?: number;
  [key: string]: unknown;
};

/** Live tick/bot-event stream. Auto-reconnects on drop, same pattern as the
 * old Electron main process's scheduleFeedRetry. */
export function useLiveFeed(
  onMessage: (msg: Tick) => void,
  enabled: boolean,
  onOpen?: (send: (msg: unknown) => void) => void
) {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';

    function connect() {
      if (stopped) return;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        handlerRef.current({ type: 'socket', status: 'open' } as Tick);
        onOpenRef.current?.((msg) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg)));
      };
      socket.onmessage = (evt) => {
        try {
          handlerRef.current(JSON.parse(evt.data));
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        handlerRef.current({ type: 'socket', status: 'closed' } as Tick);
        if (!stopped) retryTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    }

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [enabled]);
}
