import { useEffect, useState } from 'react';
import type { RunActivity } from '../shared/types';
import { apiBase } from './api';

export interface RunActivityState {
  snapshot: RunActivity | null;
  connection: 'connecting' | 'live' | 'reconnecting';
}

/** App owns one connection; Runs, the job banner and Settings share its snapshot. */
export function useRunActivity(enabled: boolean): RunActivityState {
  const [state, setState] = useState<RunActivityState>({ snapshot: null, connection: 'connecting' });
  useEffect(() => {
    if (!enabled) { setState({ snapshot: null, connection: 'connecting' }); return; }
    let events: EventSource | null = null;
    const reconnecting = () => setState(current => ({ ...current, connection: 'reconnecting' }));
    const offline = () => { events?.close(); reconnecting(); };
    const connect = () => {
      events?.close();
      if (!navigator.onLine) { reconnecting(); return; }
      events = new EventSource(`${apiBase}/runs/events`);
      events.addEventListener('activity', event => {
        try {
          const snapshot = JSON.parse((event as MessageEvent<string>).data) as RunActivity;
          if (!snapshot.runs || !snapshot.schedule) throw new Error('Invalid activity snapshot');
          setState({ snapshot, connection: 'live' });
        } catch { reconnecting(); }
      });
      events.onerror = reconnecting;
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', connect);
    connect();
    return () => {
      events?.close(); window.removeEventListener('offline', offline); window.removeEventListener('online', connect);
    };
  }, [enabled]);
  return state;
}
