import type { ServerResponse } from 'node:http';
import type { FlipperService } from './service.ts';

/** Full snapshots make missed events and process restarts recoverable without a replay log. */
export function streamRunActivity(service: FlipperService, response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  response.flushHeaders();
  response.write('retry: 1000\n\n');
  let last = '', blocked = false, closed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    if (closed || blocked) return;
    try {
      const data = JSON.stringify(service.runActivity());
      if (data === last) return;
      last = data;
      blocked = !response.write(`event: activity\ndata: ${data}\n\n`);
    } catch { response.destroy(); }
  };
  const unsubscribe = service.store.subscribeActivity(() => {
    // Publish after transactions finish and coalesce concurrent worker changes.
    if (!pending) pending = setTimeout(() => { pending = undefined; publish(); }, 100);
  });
  const heartbeat = setInterval(() => {
    // Clock-dependent quotas, cooldowns and external maintenance flags can
    // change without a journal write. Reconcile them on the keepalive too.
    publish();
    if (!closed && !blocked) blocked = !response.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();
  response.on('drain', () => { blocked = false; publish(); });
  const close = () => {
    if (closed) return;
    closed = true; unsubscribe(); clearInterval(heartbeat); clearTimeout(pending);
    serviceClosed();
  };
  const serviceClosed = service.onShutdown(() => response.end());
  response.once('close', close);
  publish();
}
