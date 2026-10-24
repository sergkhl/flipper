import { test } from 'node:test';
import assert from 'node:assert/strict';

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname: '/' } } });
const { ApiError, post, request } = await import('../client/api.ts');
if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
else Reflect.deleteProperty(globalThis, 'window');

function untilAborted<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('stalled market reads time out after ten seconds and a new request can recover', async (t) => {
  const timeout = new AbortController();
  const deadline = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 10_000); return timeout.signal;
  });
  const fetcher = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/bootstrap'); assert.equal(options.credentials, 'same-origin');
    return untilAborted<Response>(options.signal!);
  });
  const failed = assert.rejects(request('/bootstrap'), /Loading took too long.*try again/);
  timeout.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
  await failed;

  deadline.mock.mockImplementation(() => new AbortController().signal);
  fetcher.mock.mockImplementation(async () => Response.json({ access: 'read-only' }));
  assert.deepEqual(await request('/bootstrap'), { access: 'read-only' });
});

test('the read deadline also covers a response body that never finishes', async (t) => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 2_000); return timeout.signal; });
  let bodyStarted!: () => void;
  const bodyReady = new Promise<void>((resolve) => { bodyStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => ({
    ok: true, status: 200,
    text() { bodyStarted(); return untilAborted<string>(options.signal!); },
  } as Response));
  const failed = assert.rejects(request('/listings', { timeoutMs: 2_000 }), /Loading took too long/);
  await bodyReady;
  timeout.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
  await failed;
});

test('changing filters preserves caller cancellation rather than reporting a timeout', async (t) => {
  const controller = new AbortController(), reason = new DOMException('Filter changed', 'AbortError');
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => untilAborted<Response>(options.signal!));
  const failed = assert.rejects(request('/listings', { signal: controller.signal }), (error) => error === reason);
  controller.abort(reason);
  await failed;
});

test('read timeouts do not shorten administrator actions or hide API errors', async (t) => {
  t.mock.method(AbortSignal, 'timeout', () => { throw new Error('A write must not get a read timeout'); });
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
    return Response.json({ error: 'Wait for the active refresh' }, { status: 409 });
  });
  await assert.rejects(post('/ai/test'), (error) => error instanceof ApiError && error.status === 409
    && error.message === 'Wait for the active refresh');
});
