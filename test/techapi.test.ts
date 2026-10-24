import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TECHAPI_ATTRIBUTION, TECHAPI_CACHE_FILE, TechAPICache } from '../server/techapi.ts';

const base = 'https://gettechapi.github.io/TechAPI/v1';
const url = (kind: 'cpu' | 'gpu', slug?: string) => `${base}/${kind}s/${slug ? `${slug}/` : ''}index.json`;
type Row = { slug: string; name: string };
const cpu: Row = { slug: 'core-i5-12400', name: 'Intel Core i5-12400' };
const gpu: Row = { slug: 'geforce-rtx-3060-ti', name: 'GeForce RTX 3060 Ti' };
const gpuX: Row = { slug: 'geforce-rtx-3060-ti-gddr6x', name: 'GeForce RTX 3060 Ti GDDR6X' };
const gpuDie: Row = { slug: 'geforce-rtx-3060-ti-ga103', name: 'GeForce RTX 3060 Ti GA103' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function transport() {
  const resources = new Map<string, unknown>(), calls: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const request = String(input); calls.push(request);
    assert.match(request, /^https:\/\/gettechapi\.github\.io\/TechAPI\/v1\/(?:cpus|gpus)\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?index\.json$/);
    assert.equal(options?.redirect, 'error');
    const value = resources.get(request);
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value.clone();
    return value === undefined ? json({ error: 'Not found' }, 404) : json(value);
  };
  const index = (kind: 'cpu' | 'gpu', rows: Row[]) => resources.set(url(kind), { count: rows.length, results: rows.map((row) => ({ ...row, url: `/v1/${kind}s/${row.slug}` })) });
  const detail = (kind: 'cpu' | 'gpu', row: Row, data: Record<string, unknown> = {}) => resources.set(url(kind, row.slug), {
    ...row, ...(kind === 'cpu' ? { socket: 'LGA1700', memory_support: 'DDR5-4800 / DDR4-3200' } : { memory_type: 'GDDR6', memory_gb: 8 }),
    source_urls: ['https://www.intel.com/specifications', 'https://www.nvidia.com/specifications'], verified: true, ...data,
  });
  return { resources, calls, fetcher, index, detail };
}
async function directory(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flipper-techapi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function ageCache(dir: string) {
  const filename = path.join(dir, TECHAPI_CACHE_FILE), data = JSON.parse(await readFile(filename, 'utf8'));
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
  for (const entry of Object.values(data.indexes) as any[]) entry.fetchedAt = stale;
  for (const entry of Object.values(data.details) as any[]) { entry.fetchedAt = stale; if (entry.record) entry.record.fetchedAt = stale; }
  for (const key of Object.keys(data.misses)) data.misses[key] = stale;
  await writeFile(filename, JSON.stringify(data));
}

test('TechAPI parses cached CPU memory support, normalizes exact names, and never infers capacities or verification', async (t) => {
  const dir = await directory(t), api = transport();
  api.index('cpu', [cpu]); api.detail('cpu', cpu, { max_memory_gb: 128,
    source_urls: ['https://www.intel.com/specifications', 'https://www.intel.com/specifications', 'javascript:alert(1)', 'https://user:pass@example.com/'] });
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  assert.deepEqual(cache.get('cpu', 'i5-12400'), []); assert.equal(api.calls.length, 0);
  await cache.warm([{ kind: 'cpu', model: 'Core i5-12400' }]);
  const records = cache.get('cpu', 'Intel® Core™ i5 12400');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.types, ['DDR4', 'DDR5']); assert.equal(records[0]?.socket, 'LGA1700');
  assert.deepEqual(records[0]?.sourceUrls, ['https://www.intel.com/specifications']);
  assert.equal(records[0]?.url, url('cpu', cpu.slug));
  assert.equal('verified' in records[0]!, false); assert.equal('max_memory_gb' in records[0]!, false);
  assert.deepEqual(cache.get('cpu', 'i5-12400F'), []);
  assert.equal(api.calls.length, 2);
  records[0]!.types.push('DDR2');
  assert.deepEqual(cache.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5'], 'get must not expose mutable internal records');
  const stored = JSON.parse(await readFile(path.join(dir, TECHAPI_CACHE_FILE), 'utf8'));
  assert.deepEqual(stored.attribution, TECHAPI_ATTRIBUTION);
  assert.deepEqual(await readdir(dir), [TECHAPI_CACHE_FILE], 'atomic writes leave no temporary file');
  const offline = new TechAPICache(dir, { fetch: async () => { throw new Error('Unexpected network'); } });
  assert.deepEqual(offline.get('cpu', 'i5-12400'), cache.get('cpu', 'i5-12400'));
  await offline.warm([{ kind: 'cpu', model: 'i5-12400' }]); assert.equal(offline.status.lastError, null);
});

test('generic GPU lookup includes memory, capacity, and die variants while preserving Ti/SUPER/XT distinctions', async (t) => {
  const dir = await directory(t), api = transport();
  const capacity = { slug: 'geforce-rtx-3060-ti-12-gb', name: 'GeForce RTX 3060 Ti 12 GB' };
  const different = [{ slug: 'geforce-rtx-3060', name: 'GeForce RTX 3060' },
    { slug: 'geforce-rtx-3060-super', name: 'GeForce RTX 3060 Super' },
    { slug: 'radeon-rx-6600-xt', name: 'Radeon RX 6600 XT' }];
  api.index('gpu', [gpu, gpuX, gpuDie, capacity, ...different]);
  api.detail('gpu', gpu); api.detail('gpu', gpuX, { memory_type: 'GDDR6X' }); api.detail('gpu', gpuDie); api.detail('gpu', capacity);
  for (const row of different) api.detail('gpu', row, { memory_type: 'GDDR5' });
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'NVIDIA RTX3060Ti', gpuClass: 'desktop' }]);
  const records = cache.get('gpu', 'GeForce RTX 3060 Ti', 'desktop');
  assert.equal(records.length, 4); assert.deepEqual([...new Set(records.flatMap((record) => record.types))], ['GDDR6', 'GDDR6X']);
  assert.equal(api.calls.length, 5, 'unrelated models must not be fetched');
  assert.deepEqual(cache.get('gpu', 'RTX3060', 'desktop'), []);
  assert.deepEqual(cache.get('gpu', 'RX6600', 'desktop'), []);
  assert.ok(records.every((record) => !('memory_gb' in record)));
});

test('a refreshed catalog immediately exposes newly published memory variants', async (t) => {
  const dir = await directory(t), api = transport(); api.index('gpu', [gpu]); api.detail('gpu', gpu);
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  assert.deepEqual(cache.get('gpu', 'RTX3060Ti', 'desktop').flatMap((record) => record.types), ['GDDR6']);

  const future = Date.now() + 31 * 24 * 60 * 60 * 1_000;
  t.mock.method(Date, 'now', () => future);
  api.index('gpu', [gpu, gpuX]); api.detail('gpu', gpuX, { memory_type: 'GDDR6X' });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  const calls = api.calls.length;
  assert.deepEqual(cache.get('gpu', 'RTX3060Ti', 'desktop').flatMap((record) => record.types), ['GDDR6', 'GDDR6X']);
  assert.equal(api.calls.length, calls, 'reads of the refreshed index remain offline');
});

test('GPU mobile, desktop, and integrated contexts stay separate, including MX and Arc M names', async (t) => {
  const dir = await directory(t), api = transport();
  const mobile = { slug: 'geforce-rtx-3060-ti-mobile', name: 'GeForce RTX 3060 Ti Mobile' };
  const maxQ = { slug: 'geforce-rtx-3060-ti-max-q', name: 'GeForce RTX 3060 Ti Max-Q' };
  const mx = { slug: 'geforce-mx150', name: 'GeForce MX150' };
  const arc = { slug: 'arc-a770m', name: 'Arc A770M' };
  const arcDesktop = { slug: 'arc-a770', name: 'Arc A770' };
  api.index('gpu', [gpu, mobile, maxQ, mx, arc, arcDesktop]);
  for (const row of [gpu, mobile, maxQ, mx, arc, arcDesktop]) api.detail('gpu', row, { memory_type: row === mx ? 'GDDR5' : 'GDDR6' });
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' },
    { kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'mobile' }, { kind: 'gpu', model: 'MX150' }, { kind: 'gpu', model: 'Arc A770M' }]);
  assert.equal(cache.get('gpu', 'RTX3060Ti', 'desktop').length, 1);
  assert.equal(cache.get('gpu', 'RTX3060Ti', 'mobile').length, 2);
  assert.equal(cache.get('gpu', 'RTX3060Ti Mobile').length, 2);
  assert.equal(cache.get('gpu', 'RTX3060Ti').length, 3, 'unknown context retains distinct alternatives');
  assert.deepEqual(cache.get('gpu', 'RTX3060Ti Mobile', 'desktop'), []);
  assert.deepEqual(cache.get('gpu', 'RTX3060Ti', 'integrated'), []);
  assert.equal(cache.get('gpu', 'MX150')[0]?.gpuClass, 'mobile');
  assert.equal(cache.get('gpu', 'Arc A770M')[0]?.gpuClass, 'mobile');
  assert.deepEqual(cache.get('gpu', 'Arc A770', 'desktop'), []);
  const before = api.calls.length;
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'integrated' }]); assert.equal(api.calls.length, before);
});

test('repeated and concurrent warm calls deduplicate requests and persist unknown-model misses', async (t) => {
  const dir = await directory(t), api = transport(); api.index('cpu', [cpu]); api.detail('cpu', cpu);
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await Promise.all([cache.warm([{ kind: 'cpu', model: 'i5-12400' }, { kind: 'cpu', model: 'Intel Core i5-12400' },
    { kind: 'cpu', model: 'i5-12400F' }]), cache.warm([{ kind: 'cpu', model: 'i5 12400' }, { kind: 'cpu', model: 'i5-12400F' }])]);
  assert.equal(api.calls.length, 2); assert.equal(cache.status.misses, 1);
  const offline = new TechAPICache(dir, { fetch: api.fetcher });
  await offline.warm([{ kind: 'cpu', model: 'i5-12400F' }]); assert.equal(api.calls.length, 2); assert.equal(offline.status.misses, 1);
});

test('stale last-good cache remains available when refresh is offline, corrupt, or temporarily missing', async (t) => {
  const dir = await directory(t), api = transport(); api.index('cpu', [cpu]); api.detail('cpu', cpu);
  const first = new TechAPICache(dir, { fetch: api.fetcher }); await first.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  await ageCache(dir);
  const offline = new TechAPICache(dir, { fetch: async () => { throw new Error('Network unavailable'); } });
  await offline.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.deepEqual(offline.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']); assert.equal(offline.status.staleRecords, 1);
  assert.match(offline.status.lastError!, /Network unavailable/);
  api.resources.set(url('cpu'), { count: 1, results: [{ name: 'Invalid', slug: '../escape' }] });
  api.resources.set(url('cpu', cpu.slug), { ...cpu, slug: 'different-processor', memory_support: 'DDR3' });
  const corruptRemote = new TechAPICache(dir, { fetch: api.fetcher });
  await corruptRemote.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.deepEqual(corruptRemote.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
  assert.match(corruptRemote.status.lastError!, /index/);
  api.index('cpu', [cpu]); api.resources.delete(url('cpu', cpu.slug));
  const missing = new TechAPICache(dir, { fetch: api.fetcher }); await missing.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.deepEqual(missing.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
  const reloaded = new TechAPICache(dir, { fetch: api.fetcher }); assert.deepEqual(reloaded.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
});

test('failed or absent GPU variant data cannot silently turn a generic model into a single-type inference', async (t) => {
  const dir = await directory(t), api = transport(); api.index('gpu', [gpu, gpuX]); api.detail('gpu', gpu);
  const cache = new TechAPICache(dir, { fetch: api.fetcher }); await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  assert.deepEqual(cache.get('gpu', 'RTX3060Ti', 'desktop'), []);
  const count = api.calls.length;
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]); assert.equal(api.calls.length, count, '404 detail is cached');
  const reload = new TechAPICache(dir, { fetch: api.fetcher });
  await reload.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]); assert.equal(api.calls.length, count);
  await ageCache(dir); api.detail('gpu', gpuX, { memory_type: null });
  const incomplete = new TechAPICache(dir, { fetch: api.fetcher }); await incomplete.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  assert.deepEqual(incomplete.get('gpu', 'RTX3060Ti', 'desktop').map((record) => record.types), [['GDDR6'], []], 'an unsupported field stays visibly incomplete');
});

test('cache validation rejects corruption and unsafe stored record links before a successful repair', async (t) => {
  const dir = await directory(t), api = transport(); api.index('cpu', [cpu]); api.detail('cpu', cpu);
  const filename = path.join(dir, TECHAPI_CACHE_FILE);
  await writeFile(filename, '{broken json');
  const broken = new TechAPICache(dir, { fetch: api.fetcher }); assert.deepEqual(broken.get('cpu', 'i5-12400'), []);
  assert.ok(broken.status.lastError); await broken.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.deepEqual(broken.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
  const stored = JSON.parse(await readFile(filename, 'utf8'));
  stored.details[`cpu/${cpu.slug}`].record.url = 'https://attacker.invalid/data';
  await writeFile(filename, JSON.stringify(stored));
  const unsafe = new TechAPICache(dir, { fetch: api.fetcher }); assert.deepEqual(unsafe.get('cpu', 'i5-12400'), []);
  assert.match(unsafe.status.lastError!, /record cache/);
  await unsafe.warm([{ kind: 'cpu', model: 'i5-12400' }]); assert.equal(unsafe.get('cpu', 'i5-12400').length, 1);
});

test('oversized, non-JSON, redirected, and malformed responses do not populate cache', async (t) => {
  const dir = await directory(t), api = transport(); api.index('gpu', [gpu]);
  api.resources.set(url('gpu', gpu.slug), new Response('large', { headers: { 'content-length': '200000', 'content-type': 'application/json' } }));
  let cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]); assert.match(cache.status.lastError!, /size limit/);
  assert.deepEqual(cache.get('gpu', 'RTX3060Ti', 'desktop'), []);
  api.resources.set(url('gpu', gpu.slug), new Response('<html>offline</html>', { headers: { 'content-type': 'text/html' } }));
  cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]); assert.match(cache.status.lastError!, /not JSON/);
  api.resources.set(url('gpu', gpu.slug), new Response('{invalid', { headers: { 'content-type': 'application/json' } }));
  cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]); assert.ok(cache.status.lastError);
  api.resources.set(url('gpu', gpu.slug), Response.redirect('https://attacker.invalid/data'));
  cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]); assert.match(cache.status.lastError!, /rejected/);
  assert.equal(cache.status.records, 0);
});

test('stream size limits and incomplete indexes prevent partial data from becoming type evidence', async (t) => {
  const dir = await directory(t), api = transport();
  api.resources.set(url('gpu'), { count: 2, results: [gpu] });
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  assert.match(cache.status.lastError!, /Incomplete/); assert.equal(api.calls.length, 1);
  api.index('gpu', [gpu]);
  api.resources.set(url('gpu', gpu.slug), new Response(new Uint8Array(130 * 1_024), { headers: { 'content-type': 'application/json' } }));
  const streamed = new TechAPICache(dir, { fetch: api.fetcher });
  await streamed.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  assert.match(streamed.status.lastError!, /size limit/); assert.deepEqual(streamed.get('gpu', 'RTX3060Ti', 'desktop'), []);
});

test('untrusted index URLs never control destinations and cancellation aborts without discarding earlier cache', async (t) => {
  const dir = await directory(t), api = transport();
  api.resources.set(url('cpu'), { count: 1, results: [{ ...cpu, url: 'http://127.0.0.1/private' }] }); api.detail('cpu', cpu);
  const cache = new TechAPICache(dir, { fetch: api.fetcher }); await cache.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.deepEqual(api.calls, [url('cpu'), url('cpu', cpu.slug)]);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }], abort.signal), { name: 'AbortError' });
  assert.deepEqual(cache.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
  assert.equal(api.calls.length, 2);
});

test('detail downloads are bounded to three concurrent requests', async (t) => {
  const dir = await directory(t), api = transport();
  const rows = Array.from({ length: 7 }, (_, i) => ({ slug: `geforce-rtx-3060-ti-ga10${i}`, name: `GeForce RTX 3060 Ti GA10${i}` }));
  api.index('gpu', rows); for (const row of rows) api.detail('gpu', row);
  let active = 0, maximum = 0;
  const fetcher: typeof fetch = async (input, options) => {
    if (String(input) === url('gpu')) return api.fetcher(input, options);
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try { return await api.fetcher(input, options); } finally { active--; }
  };
  const cache = new TechAPICache(dir, { fetch: fetcher }); await cache.warm([{ kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  assert.equal(maximum, 3); assert.equal(cache.get('gpu', 'RTX3060Ti', 'desktop').length, 7);
});

test('a failed index enters a brief cooldown across repeated and queued warm calls, then recovers', async (t) => {
  const dir = await directory(t), api = transport();
  api.resources.set(url('cpu'), new Error('Provider unavailable'));
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await Promise.all([cache.warm([{ kind: 'cpu', model: 'i5-12400' }]), cache.warm([{ kind: 'cpu', model: 'i7-12700H' }])]);
  assert.equal(api.calls.length, 1, 'another pool in the same refresh must not repeat a failing provider call');
  assert.match(cache.status.lastError!, /Provider unavailable/);
  assert.ok(cache.status.cooldownRemainingMs > 0 && cache.status.cooldownRemainingMs <= 45_000);
  const retryAt = Date.parse(cache.status.retryAfter!);
  api.index('cpu', [cpu]); api.detail('cpu', cpu);
  await cache.warm([{ kind: 'cpu', model: 'i5-12400' }]); assert.equal(api.calls.length, 1);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(cache.warm([{ kind: 'cpu', model: 'i5-12400' }], aborted.signal), { name: 'AbortError' });
  assert.equal(Date.parse(cache.status.retryAfter!), retryAt, 'caller cancellation must not extend provider cooldown');
  t.mock.method(Date, 'now', () => retryAt + 1);
  await cache.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.equal(api.calls.length, 3); assert.equal(cache.status.retryAfter, null); assert.equal(cache.status.cooldownRemainingMs, 0);
  assert.equal(cache.status.lastError, null); assert.deepEqual(cache.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
});

test('a failed detail cools down new lookups while last-good offline reads remain available', async (t) => {
  const dir = await directory(t), api = transport(); api.index('cpu', [cpu]); api.detail('cpu', cpu);
  const first = new TechAPICache(dir, { fetch: api.fetcher }); await first.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  await ageCache(dir);
  api.resources.set(url('cpu', cpu.slug), new Error('Detail lookup failed'));
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  const count = api.calls.length, retryAt = Date.parse(cache.status.retryAfter!);
  assert.deepEqual(cache.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
  await cache.warm([{ kind: 'cpu', model: 'i5-12400' }, { kind: 'gpu', model: 'RTX3060Ti', gpuClass: 'desktop' }]);
  assert.equal(api.calls.length, count, 'detail failure also suppresses subsequent optional index requests');
  api.detail('cpu', cpu);
  t.mock.method(Date, 'now', () => retryAt + 1);
  await cache.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.equal(api.calls.length, count + 1); assert.equal(cache.status.retryAfter, null); assert.equal(cache.status.lastError, null);
  assert.deepEqual(cache.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
});

test('mid-request caller cancellation does not trigger provider cooldown or prevent immediate retry', async (t) => {
  const dir = await directory(t), api = transport(); api.index('cpu', [cpu]); api.detail('cpu', cpu);
  let cancelDetail = true, started!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const fetcher: typeof fetch = async (input, options) => {
    if (String(input) === url('cpu', cpu.slug) && cancelDetail) {
      started();
      return new Promise<Response>((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      });
    }
    return api.fetcher(input, options);
  };
  const cache = new TechAPICache(dir, { fetch: fetcher }), controller = new AbortController();
  const warming = cache.warm([{ kind: 'cpu', model: 'i5-12400' }], controller.signal);
  await pending; controller.abort();
  await assert.rejects(warming, { name: 'AbortError' });
  assert.equal(cache.status.retryAfter, null); assert.equal(cache.status.lastError, null);
  cancelDetail = false;
  await cache.warm([{ kind: 'cpu', model: 'i5-12400' }]);
  assert.deepEqual(cache.get('cpu', 'i5-12400')[0]?.types, ['DDR4', 'DDR5']);
});
