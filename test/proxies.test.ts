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

test('both catalogs contribute, a job keeps its route, and failures choose another cached route', async () => {
  const store = new Store('', true); let downloads = 0;
  const pool = new ProxyPool(store, { download: async (...args) => { downloads++; return catalog()(...args); } });
  try {
    assert.equal(await pool.uriForJob('one'), proxies[0]);
    assert.equal(await pool.uriForJob('one'), proxies[0]);
    pool.endJob('one'); assert.equal(await pool.uriForJob('two'), proxies[1]);
    pool.failed(proxies[1]!); assert.notEqual(await pool.uriForJob('two'), proxies[1]);
    assert.equal(downloads, 2); assert.equal(pool.status().cached, 3); assert.equal(pool.status().available, 2);
    assert.doesNotMatch(JSON.stringify(pool.status()), /8\.8\.8\.8|1\.1\.1\.1|9\.9\.9\.9/);
    const reopened = new ProxyPool(store, { download: async () => { throw new Error('must use cached list'); } });
    assert.ok(await reopened.uriForJob('after restart')); await reopened.close();
  } finally { await pool.close(); store.close(); }
});

test('catalog outages retain last-good entries without repeating downloads on each job', async () => {
  const store = new Store('', true); let now = new Date('2026-10-24T07:00:00Z'), downloads = 0, broken = false;
  const pool = new ProxyPool(store, { now: () => now, download: async (...args) => {
    downloads++; if (broken) throw new Error('catalog outage'); return catalog()(...args);
  } });
  try {
    await pool.uriForJob('one'); pool.endJob('one'); const fetchedAt = pool.status().fetchedAt;
    now = new Date(now.getTime() + 31 * 60_000); broken = true;
    await pool.uriForJob('two'); pool.endJob('two'); await pool.uriForJob('three');
    assert.equal(downloads, 4); assert.equal(pool.status().fetchedAt, fetchedAt);
  } finally { await pool.close(); store.close(); }
});

test('empty catalogs pause without making any marketplace request or falling back directly', async () => {
  const store = new Store('', true); let direct = 0, sent = 0;
  const pool = new ProxyPool(store, { download: async () => new Response('http://127.0.0.1:80'), send: async () => { sent++; return new Response(page); } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, proxies: pool, fetch: async () => { direct++; return new Response(page); } });
  client.beginJob({ id: 'empty', category: 'gpu', automatic: false, onRequest() {} });
  try {
    await assert.rejects(client.search(input), SourceDeferredError);
    assert.equal(sent, 0); assert.equal(direct, 0); assert.equal(store.sourceBudgetStatus().used, 0);
  } finally { await client.close(); store.close(); }
});

test('network failover counts every attempt and preserves the replacement route for the job', async () => {
  const store = new Store('', true), routes: string[] = []; let counted = 0, direct = 0;
  const pool = new ProxyPool(store, { download: catalog(), send: async (uri, _url, init) => {
    routes.push(uri); assert.equal(new Headers(init.headers).has('authorization'), false);
    if (routes.length === 1) throw new TypeError('proxy connection failed');
    return new Response(page);
  } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, proxies: pool, fetch: async () => { direct++; return new Response(page); } });
  client.beginJob({ id: 'failover', category: 'gpu', automatic: true, onRequest() { counted++; } });
  try {
    await client.search(input); await client.search(input);
    assert.equal(routes.length, 3); assert.notEqual(routes[0], routes[1]); assert.equal(routes[1], routes[2]);
    assert.equal(counted, 3); assert.equal(store.sourceBudgetStatus().automaticUsed, 3); assert.equal(direct, 0);
  } finally { await client.close(); store.close(); }
});

test('three failed proxy attempts pause the job and sanitize connection errors', async () => {
  const store = new Store('', true); let sent = 0;
  const pool = new ProxyPool(store, { download: catalog(), send: async () => { sent++; throw new Error('raw upstream secret fixture'); } });
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
  const pool = new ProxyPool(store, { download: async (...args) => { downloads++; return catalog()(...args); },
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
  const pool = new ProxyPool(store, { download: catalog(), send: async () => {
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

test('the one-request gate remains held until the response body finishes', async () => {
  const store = new Store('', true); let active = 0, maximum = 0;
  const pool = new ProxyPool(store, { download: catalog(), send: async () => {
    active++; maximum = Math.max(maximum, active);
    return new Response(new ReadableStream({ start(controller) {
      setTimeout(() => { controller.enqueue(new TextEncoder().encode(page)); active--; controller.close(); }, 15);
    } }));
  } });
  const client = new ChototClient({ pauseMs: 0, requestStore: store, proxies: pool });
  client.beginJob({ id: 'serial', category: 'gpu', automatic: false, onRequest() {} });
  try {
    await Promise.all([client.search(input), client.search(input)]); assert.equal(maximum, 1);
  } finally { await client.close(); store.close(); }
});
