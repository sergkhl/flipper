import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { appServer } from '../server/http.ts';
import type { RunActivity } from '../shared/types.ts';

const origin = 'https://flipper.example.test', token = 'fixture-events-administrator-token-1234567890';
const headers = { 'x-flipper-admin-token': token, origin, 'content-type': 'application/json' };

async function activityReader(base: string) {
  const response = await fetch(base + '/admin/api/runs/events', { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  return {
    cancel: () => reader.cancel(),
    async next(matches: (value: RunActivity) => boolean = () => true): Promise<RunActivity> {
      while (true) {
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const line = event.split('\n').find(line => line.startsWith('data: '));
          if (line) { const value = JSON.parse(line.slice(6)) as RunActivity; if (matches(value)) return value; }
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'the activity stream must remain open');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

test('private event snapshots push launches, live limits, scheduling and cancellation; reconnect resynchronizes', async t => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false });
  store.setRuntimeValue('private-diagnostic-fixture', { proxy: 'hidden-proxy-endpoint', credential: 'hidden-credential' });
  let subscriptions = 0;
  const subscribe = store.subscribeActivity.bind(store);
  t.mock.method(store, 'subscribeActivity', (listener: () => void) => {
    subscriptions++;
    const dispose = subscribe(listener);
    return () => { subscriptions--; dispose(); };
  });
  const service = new FlipperService(store, {
    search: async input => {
      await new Promise<void>((resolve, reject) => {
        input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
      });
      return { items: [], total: 0 };
    }, detail: async item => item,
  });
  const server = appServer(service, undefined, { publicOrigin: origin, adminToken: token });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, value: unknown) => fetch(base + '/admin/api' + path, { method: 'POST', headers, body: JSON.stringify(value) });
  let stream: Awaited<ReturnType<typeof activityReader>> | undefined;
  try {
    assert.equal((await fetch(base + '/api/runs/events', { headers })).status, 404);
    assert.equal((await fetch(base + '/admin/api/runs/events')).status, 403);
    assert.equal((await fetch(base + '/admin/api/runs/events', { headers: { ...headers, origin: 'https://outside.example' } })).status, 403);
    assert.equal((await fetch(base + '/admin/api/runs/events', { method: 'HEAD', headers })).status, 200);
    assert.equal(subscriptions, 0, 'HEAD must not create an event subscription');
    stream = await activityReader(base);
    const initial = await stream.next(); assert.equal(initial.runs.busy, false); assert.equal(subscriptions, 1);
    const started = await post('/runs', { category: 'gpu', parameters: { scanLimit: 20 } });
    assert.equal(started.status, 202); const { job } = await started.json();
    const active = await stream.next(value => value.runs.activeId === job.id);
    assert.equal(active.job?.status, 'collecting'); assert.equal(active.runs.busy, true);
    const encoded = JSON.stringify(active);
    for (const secret of ['progress', 'settings', 'hidden-proxy-endpoint', 'hidden-credential']) assert.ok(!encoded.includes(`"${secret}"`), secret);
    const limits = { ...initial.runs.limits, marketplaceWorkers: 2, requestLimit: 800 };
    assert.equal((await post('/runs/limits', limits)).status, 200);
    assert.equal((await stream.next(value => value.runs.limits.requestLimit === 800)).runs.limits.marketplaceWorkers, 2);
    assert.equal((await post('/schedule', { enabled: true })).status, 200);
    assert.equal((await stream.next(value => value.schedule.enabled)).schedule.enabled, true);
    assert.equal((await post(`/runs/${job.id}/cancel`, {})).status, 202);
    const cancelled = await stream.next(value => value.runs.runs[0]?.state === 'cancelled');
    assert.equal(cancelled.runs.busy, false); assert.equal(cancelled.runs.activeId, null);
    await stream.cancel(); stream = undefined;
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(subscriptions, 0);
    store.saveSettings({ ...store.getSettings(), aiWorkers: 2 });
    stream = await activityReader(base);
    const fresh = await stream.next();
    assert.equal(fresh.runs.limits.aiWorkers, 2); assert.equal(fresh.runs.runs[0]?.state, 'cancelled');
    await service.shutdown();
  } finally {
    await stream?.cancel(); await service.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
  assert.equal(subscriptions, 0, 'shutdown disposes every live subscription');
});
