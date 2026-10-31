import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { ProxyPool, PROXY_SOURCES, proxyUri } from '../server/proxies.ts';
import { ChototClient } from '../server/chotot.ts';
import { SourceDeferredError } from '../server/source-policy.ts';
import { SourceCooldownError } from '../server/source-cooldown.ts';

const proxies = ['http://8.8.8.8:8080', 'socks5://1.1.1.1:1080', 'http://9.9.9.9:3128'];
const page = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"initialState":{"adlisting":{"data":{"ads":[],"total":0}}}}}}</script>';
const input = { kind: 'gpu' as const, location: 'danang' as const };
function catalog(): typeof fetch {
  return async url => new Response(String(url) === PROXY_SOURCES[0] ? `${proxies[0]}\n${proxies[2]}` : proxies[1]);
}

test('proxy endpoints accept public credential-free supported protocols and reject unsafe list input', () => {
  assert.equal(proxyUri('http://8.8.8.8:80'), 'http://8.8.8.8:80');
  assert.equal(proxyUri('https://1.1.1.1:443/'), 'https://1.1.1.1:443');
  assert.equal(proxyUri(proxies[1]!), proxies[1]);
  for (const uri of ['http://localhost:80', 'http://127.0.0.1:80', 'http://10.0.0.1:80',
    'http://169.254.169.254:80', 'http://172.16.1.1:80', 'http://192.168.1.1:80', 'http://100.64.0.1:80',
    'http://[::1]:80', 'http://user:secret@8.8.8.8:80', 'socks4://8.8.8.8:1080',
    'http://8.8.8.8', 'http://8.8.8.8:0', 'http://8.8.8.8:80/path', 'http://8.8.8.8:80?token=x']) {
    assert.equal(proxyUri(uri), null, uri);
  }
});

test('both catalogs contribute verified routes, reuse successful checks, and retain health across restart', async () => {
  const store = new Store('', true); let downloads = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: async (...args) => { downloads++; return catalog()(...args); } });
  try {
    assert.deepEqual(await pool.routes(3), proxies);
    assert.deepEqual(await pool.routes(3), proxies);
    pool.failed(proxies[1]!); assert.deepEqual(await pool.routes(3), [proxies[0],proxies[2]]);
    assert.equal(downloads, 2); assert.equal(pool.status().cached, 3); assert.equal(pool.status().available, 2);
    assert.doesNotMatch(JSON.stringify(pool.status()), /8\.8\.8\.8|1\.1\.1\.1|9\.9\.9\.9/);
    const reopened = new ProxyPool(store, { download: async () => { throw new Error('must use cached list'); } });
    assert.deepEqual(await reopened.routes(2), [proxies[0],proxies[2]]); await reopened.close();
  } finally { await pool.close(); store.close(); }
});

test('catalog outages retain last-good entries without repeating downloads on each job', async () => {
  const store = new Store('', true); let now = new Date('2026-10-24T07:00:00Z'), downloads = 0, broken = false;
  const pool = new ProxyPool(store, { probe: async () => true, now: () => now, download: async (...args) => {
    downloads++; if (broken) throw new Error('catalog outage'); return catalog()(...args);
  } });
  try {
    await pool.routes(); const fetchedAt = pool.status().fetchedAt;
    now = new Date(now.getTime() + 31 * 60_000); broken = true;
    await pool.routes(); await pool.routes();
    assert.equal(downloads, 4); assert.equal(pool.status().fetchedAt, fetchedAt);
  } finally { await pool.close(); store.close(); }
});

for (const failure of ['connection', 'http', 'deadline'] as const) test(`a ${failure} failure at one check website does not reject a working proxy`, async t => {
  if (failure === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store('', true), targets: string[] = [];
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const pool = new ProxyPool(store, { download: async () => new Response(proxies[0]), send: async (_uri, url, init) => {
    targets.push(url);
    if (new URL(url).hostname === 'example.com') {
      if (failure === 'connection') throw new TypeError('Website unavailable');
      if (failure === 'http') return new Response('', { status: 503 });
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); started();
      });
    }
    return new Response(null, { status: 204 });
  } });
  try {
    const routes = pool.routes(1);
    if (failure === 'deadline') { await waiting; t.mock.timers.tick(4_000); }
    assert.deepEqual(await routes, [proxies[0]]);
    assert.equal(new Set(targets.map(url => new URL(url).hostname)).size, 2);
    assert.equal(pool.status().verified, 1); assert.equal(pool.status().available, 1);
    assert.equal(store.sourceBudgetStatus().used, 0);
  } finally { await pool.close(); store.close(); }
});

test('caller cancellation stops fallback checks without retiring candidates', async () => {
  const store = new Store('', true), abort = new AbortController(); let sent = 0;
  const pool = new ProxyPool(store, { download: async () => new Response(proxies[0]), send: async () => {
    sent++; abort.abort(); throw abort.signal.reason;
  } });
  try {
    await assert.rejects(pool.routes(1, [], abort.signal), { name: 'AbortError' });
    assert.equal(sent, 1); assert.equal(pool.status().available, 1); assert.equal(pool.status().verified, 0);
  } finally { await pool.close(); store.close(); }
});

test('outages of all check websites retain the twelve-candidate job bound and cool down only tested candidates', async () => {
  const store = new Store('', true), checked = new Set<string>(); let sent = 0;
  const candidates = Array.from({ length: 40 }, (_, i) => `http://8.8.1.${i + 1}:8080`);
  const pool = new ProxyPool(store, { download: async () => new Response(candidates.join('\n')), send: async (uri) => {
    checked.add(uri); sent++; return new Response('', { status: 503 });
  } });
  try {
    assert.deepEqual(await pool.routes(4), []);
    assert.equal(checked.size, 12); assert.equal(sent, 24);
    assert.equal(pool.status().available, 28); assert.equal(pool.status().verified, 0);
    assert.deepEqual(await pool.routes(4), []); assert.equal(sent, 24);
    assert.equal(store.sourceBudgetStatus().used, 0);
  } finally { await pool.close(); store.close(); }
});

test('a successful first check avoids another website request', async () => {
  const store = new Store('', true); let sent = 0;
  const pool = new ProxyPool(store, { download: async () => new Response(proxies[0]), send: async () => {
    sent++; return new Response(null, { status: 204 });
  } });
  try {
    assert.deepEqual(await pool.routes(1), [proxies[0]]); assert.equal(sent, 1);
    assert.equal(store.sourceBudgetStatus().used, 0);
  } finally { await pool.close(); store.close(); }
});

test('two stalled check websites share an eight-second candidate bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store('', true); let sent = 0;
  const starts: Array<() => void> = [];
  const ready = [0, 1].map(() => new Promise<void>(resolve => { starts.push(resolve); }));
  const pool = new ProxyPool(store, { download: async () => new Response(proxies[0]), send: async (_uri, _url, init) => {
    const index = sent++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); starts[index]!();
    });
  } });
  try {
    const routes = pool.routes(1);
    for (const start of ready) { await start; t.mock.timers.tick(4_000); }
    assert.deepEqual(await routes, []); assert.equal(sent, 2); assert.equal(pool.status().available, 0);
    assert.equal(store.sourceBudgetStatus().used, 0);
  } finally { await pool.close(); store.close(); }
});

test('one unavailable catalog does not prevent collection through the other provider', async () => {
  const store = new Store('', true); let sent = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: async url => {
    if (String(url) === PROXY_SOURCES[0]) throw new Error('Catalog unavailable');
    return new Response(proxies[0]);
  }, send: async () => { sent++; return new Response(page); } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, proxies: pool });
  client.beginJob({ id: 'one-catalog', category: 'gpu', automatic: false, onRequest() {} });
  try {
    assert.deepEqual(await client.search(input), { items: [], total: 0 });
    assert.equal(sent, 1); assert.equal(store.sourceBudgetStatus().used, 1);
  } finally { await client.close(); store.close(); }
});

test('empty catalogs pause without making any marketplace request or falling back directly', async () => {
  const store = new Store('', true); let direct = 0, sent = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: async () => new Response('http://127.0.0.1:80'), send: async () => { sent++; return new Response(page); } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, proxies: pool, fetch: async () => { direct++; return new Response(page); } });
  client.beginJob({ id: 'empty', category: 'gpu', automatic: false, onRequest() {} });
  try {
    await assert.rejects(client.search(input), SourceDeferredError);
    assert.equal(sent, 0); assert.equal(direct, 0); assert.equal(store.sourceBudgetStatus().used, 0);
  } finally { await client.close(); store.close(); }
});

test('network failover counts every attempt and preserves the replacement route for the job', async () => {
  const store = new Store('', true), routes: string[] = []; let counted = 0, direct = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: catalog(), send: async (uri, _url, init) => {
    routes.push(uri); assert.equal(new Headers(init.headers).has('authorization'), false);
    if (routes.length === 1) throw new TypeError('proxy connection failed');
    return new Response(page);
  } });
  const client = new ChototClient({ workers: 1, pauseMs: 0, requestStore: store, proxies: pool, fetch: async () => { direct++; return new Response(page); } });
  client.beginJob({ id: 'failover', category: 'gpu', automatic: true, onRequest() { counted++; } });
  try {
    await client.search(input); await client.search(input);
    assert.equal(routes.length, 3); assert.notEqual(routes[0], routes[1]); assert.equal(routes[1], routes[2]);
    assert.equal(counted, 3); assert.equal(store.sourceBudgetStatus().automaticUsed, 3); assert.equal(direct, 0);
  } finally { await client.close(); store.close(); }
});

for (const stage of ['headers', 'body'] as const) test(`a proxy timeout during ${stage} switches routes and retains request accounting`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store('', true), routes: string[] = [];
  let started!: () => void, direct = 0;
  const stalled = new Promise<void>(resolve => { started = resolve; });
  const pool = new ProxyPool(store, { probe: async () => true, download: catalog(), send: async (uri, _url, init) => {
    routes.push(uri);
    if (routes.length > 1) return new Response(page);
    if (stage === 'headers') return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); started();
    });
    return new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); started();
    } }));
  } });
  const client = new ChototClient({ workers: 1, pauseMs: 0, requestStore: store, proxies: pool,
    fetch: async () => { direct++; return new Response(page); } });
  client.beginJob({ id: `timeout-${stage}`, category: 'laptop', automatic: false, onRequest() {} });
  try {
    const request = client.search({ kind: 'laptop', location: 'danang' });
    await stalled; t.mock.timers.tick(15_000); await request;
    await client.search(input);
    assert.equal(routes.length, 3); assert.notEqual(routes[0], routes[1]); assert.equal(routes[1], routes[2]);
    assert.equal(pool.status().available, 2); assert.equal(store.sourceBudgetStatus().used, 3); assert.equal(direct, 0);
  } finally { await client.close(); store.close(); }
});

test('exhausted timeout routes pause through the existing recovery queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store('', true); let sent = 0;
  const starts: Array<() => void> = [];
  const ready = proxies.map(() => new Promise<void>(resolve => { starts.push(resolve); }));
  const pool = new ProxyPool(store, { probe: async () => true, download: catalog(), send: async (_uri, _url, init) => {
    const index = sent++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); starts[index]!();
    });
  } });
  const client = new ChototClient({ workers: 1, pauseMs: 0, requestStore: store, proxies: pool });
  client.beginJob({ id: 'all-timeouts', category: 'laptop', automatic: false, onRequest() {} });
  try {
    const rejected = assert.rejects(client.search({ kind: 'laptop', location: 'danang' }), SourceDeferredError);
    for (const start of ready) { await start; t.mock.timers.tick(15_000); }
    await rejected;
    assert.equal(sent, 3); assert.equal(store.sourceBudgetStatus().used, 3); assert.ok(pool.status().retryAt);
    await assert.rejects(client.search(input), SourceDeferredError); assert.equal(sent, 3);
  } finally { await client.close(); store.close(); }
});

test('caller cancellation during a stalled proxy request does not rotate routes', async () => {
  const store = new Store('', true), controller = new AbortController(); let sent = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: catalog(), send: async (_uri, _url, init) => {
    sent++; controller.abort(); init.signal!.throwIfAborted(); return new Response(page);
  } });
  const client = new ChototClient({ workers: 1, pauseMs: 0, requestStore: store, proxies: pool });
  client.beginJob({ id: 'cancel-timeout', category: 'laptop', automatic: false, onRequest() {} });
  try {
    await assert.rejects(client.search({ kind: 'laptop', location: 'danang', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(sent, 1); assert.equal(pool.status().available, 3); assert.equal(store.sourceBudgetStatus().used, 1);
  } finally { await client.close(); store.close(); }
});

test('three failed proxy attempts pause the job and sanitize connection errors', async () => {
  const store = new Store('', true); let sent = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: catalog(), send: async () => { sent++; throw new Error('raw upstream secret fixture'); } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, proxies: pool });
  client.beginJob({ id: 'broken', category: 'desktop', automatic: false, onRequest() {} });
  try {
    await assert.rejects(client.search(input), error => error instanceof SourceDeferredError && !error.message.includes('secret'));
    await assert.rejects(client.search(input), SourceDeferredError);
    assert.equal(sent, 3); assert.equal(store.sourceBudgetStatus().used, 3);
  } finally { await client.close(); store.close(); }
});

test('429 pauses all routes across restart and does not trigger a proxy switch', async () => {
  const store = new Store('', true); let sent = 0, downloads = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: async (...args) => { downloads++; return catalog()(...args); },
    send: async () => { sent++; return new Response('', { status: 429, headers: { 'retry-after': '3600' } }); } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, cooldownStore: store, proxies: pool });
  client.beginJob({ id: 'rate-limited', category: 'gpu', automatic: false, onRequest() {} });
  try {
    await assert.rejects(client.search(input), SourceCooldownError);
    await assert.rejects(client.search(input), SourceCooldownError);
    const reopened = new ChototClient({ pauseMs: 0, cooldownStore: store, proxies: new ProxyPool(store, {
      download: async () => { throw new Error('cooldown must prevent catalog access too'); },
    }) });
    await assert.rejects(reopened.search(input), SourceCooldownError); await reopened.close();
    assert.equal(sent, 1); assert.equal(downloads, 2); assert.equal(pool.status().available, 3);
    assert.equal(store.sourceBudgetStatus().used, 1);
  } finally { await client.close(); store.close(); }
});

test('redirects consume their own allowance and cannot send requests outside the marketplace', async () => {
  const store = new Store('', true); let sent = 0, external = false;
  const pool = new ProxyPool(store, { probe: async () => true, download: catalog(), send: async () => {
    sent++;
    if (external || sent === 1) return new Response('', { status: 302, headers: { location: external ? 'https://example.com' : '/marketplace-redirect' } });
    return new Response(page);
  } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, proxies: pool });
  client.beginJob({ id: 'redirect', category: 'gpu', automatic: false, onRequest() {} });
  try {
    await client.search(input); assert.equal(sent, 2); assert.equal(store.sourceBudgetStatus().used, 2);
    external = true; await assert.rejects(client.search(input), /outside the marketplace/);
    assert.equal(sent, 3, 'the external redirect is rejected before dispatch'); assert.equal(pool.status().available, 3);
  } finally { await client.close(); store.close(); }
});

test('each worker remains occupied until the response body finishes', async () => {
  const store = new Store('', true); let active = 0, maximum = 0;
  const pool = new ProxyPool(store, { probe: async () => true, download: catalog(), send: async () => {
    active++; maximum = Math.max(maximum, active);
    return new Response(new ReadableStream({ start(controller) {
      setTimeout(() => { controller.enqueue(new TextEncoder().encode(page)); active--; controller.close(); }, 15);
    } }));
  } });
  const client = new ChototClient({ workers: 1, pauseMs: 0, requestStore: store, proxies: pool });
  client.beginJob({ id: 'serial', category: 'gpu', automatic: false, onRequest() {} });
  try {
    await Promise.all([client.search(input), client.search(input)]); assert.equal(maximum, 1);
  } finally { await client.close(); store.close(); }
});
