import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TECHAPI_ATTRIBUTION, TECHAPI_LAPTOP_CACHE_FILE, TechAPICache } from '../server/techapi.ts';

const base = 'https://gettechapi.github.io/TechAPI/v1/laptops';
const url = (slug?: string) => `${base}/${slug ? `${slug}/` : ''}index.json`;
type Row = { slug: string; name: string };
const mac: Row = { slug: 'apple-macbook-pro-14-m2-pro-2023', name: 'Apple MacBook Pro 14-inch (M2 Pro, 2023)' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function transport() {
  const resources = new Map<string, unknown>(), calls: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const request = String(input); calls.push(request);
    assert.match(request, /^https:\/\/gettechapi\.github\.io\/TechAPI\/v1\/laptops\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?index\.json$/);
    assert.equal(options?.redirect, 'error');
    options?.signal?.throwIfAborted();
    const value = resources.get(request);
    if (value instanceof Error) throw value;
    return value instanceof Response ? value.clone() : value === undefined ? json({}, 404) : json(value);
  };
  const index = (rows: Row[]) => resources.set(url(), { count: rows.length, results: rows.map((row) => ({ ...row, url: 'https://attacker.invalid/' })) });
  const detail = (row: Row, extras: Record<string, unknown> = {}) => resources.set(url(row.slug), {
    ...row, cpu_name: 'Apple M2 Pro', gpu_name: 'Apple 16-Core GPU', release_date: '2023-01-24', display: { size_inch: 14.2 },
    ram_gb: 16, storage_gb: 512, msrp_usd: 1999, verified: true,
    source_urls: ['https://support.apple.com/specifications', 'javascript:alert(1)', 'https://user:secret@example.com/', 'https://support.apple.com/specifications'], ...extras,
  });
  return { resources, calls, fetcher, index, detail };
}
async function directory(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flipper-techapi-laptops-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function ageCache(dir: string) {
  const filename = path.join(dir, TECHAPI_LAPTOP_CACHE_FILE), data = JSON.parse(await readFile(filename, 'utf8'));
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
  if (data.index) data.index.fetchedAt = stale;
  for (const entry of Object.values(data.details) as any[]) { entry.fetchedAt = stale; if (entry.record) entry.record.fetchedAt = stale; }
  for (const key of Object.keys(data.misses)) data.misses[key] = stale;
  await writeFile(filename, JSON.stringify(data));
}

test('laptop cache exposes only unverified catalog specs, uses fixed endpoints, and survives offline reload', async (t) => {
  const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac, { ram_type: 'LPDDR5' });
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro' }), []); assert.equal(api.calls.length, 0);
  await cache.warmLaptops([{ model: 'MacBook Pro 14', cpu: 'M2 Pro', modelYear: 2023, ramGb: 16, storageGb: 512 }]);
  const records = cache.getLaptops({ model: 'MacBook Pro 14-inch 2023', cpu: 'Apple M2 Pro' });
  assert.equal(records.length, 1); assert.equal(records[0]?.screenInches, 14.2); assert.equal(records[0]?.ramType, 'LPDDR5');
  assert.equal(records[0]?.gpuCores, 16); assert.equal(records[0]?.cpuCores, null);
  assert.equal('msrp_usd' in records[0]!, false); assert.equal('verified' in records[0]!, false);
  assert.deepEqual(records[0]?.sourceUrls, ['https://support.apple.com/specifications']);
  records[0]!.sourceUrls.push('https://injected.invalid/');
  assert.equal(cache.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro' })[0]?.sourceUrls.length, 1);
  assert.deepEqual(api.calls, [url(), url(mac.slug)]); assert.deepEqual(await readdir(dir), [TECHAPI_LAPTOP_CACHE_FILE]);
  const stored = JSON.parse(await readFile(path.join(dir, TECHAPI_LAPTOP_CACHE_FILE), 'utf8'));
  assert.deepEqual(stored.attribution, TECHAPI_ATTRIBUTION); assert.equal(cache.status.laptopRecords, 1); assert.equal(cache.status.records, 0);
  const offline = new TechAPICache(dir, { fetch: async () => { throw new Error('Unexpected network'); } });
  await offline.warmLaptops([{ model: 'MacBook Pro 14', cpu: 'M2 Pro' }]);
  assert.equal(offline.status.laptopError, null); assert.equal(offline.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro' }).length, 1);
});

test('known Mac family, chip tier, size, year, cores, RAM and storage constrain candidates', async (t) => {
  const dir = await directory(t), api = transport();
  const plain: Row = { slug: 'apple-macbook-pro-14-m2-2023', name: 'Apple MacBook Pro 14-inch (M2, 2023)' };
  const max: Row = { slug: 'apple-macbook-pro-14-m2-max-2023', name: 'Apple MacBook Pro 14-inch (M2 Max, 2023)' };
  const air: Row = { slug: 'apple-macbook-air-2023', name: 'Apple MacBook Air 2023' };
  const generic: Row = { slug: 'apple-macbook-pro-variant', name: 'Apple MacBook Pro' };
  api.index([mac, plain, max, air, generic]); api.detail(mac, { cpu_cores: 10 });
  api.detail(plain, { cpu_name: 'Apple M2', cpu_cores: 8 }); api.detail(max, { cpu_name: 'Apple M2 Max', cpu_cores: 12 });
  api.detail(air, { cpu_name: 'Apple M2', cpu_cores: 8 }); api.detail(generic, { cpu_name: 'Apple M2 Pro', cpu_cores: 12, gpu_name: 'Apple 19-Core GPU', ram_gb: 32, storage_gb: 1024 });
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warmLaptops([{ model: 'MacBook Pro', cpu: 'M2 Pro' }]);
  assert.deepEqual(api.calls, [url(), url(mac.slug), url(generic.slug)], 'base/Max/Air models are not fetched for a Pro-chip request');
  assert.equal(cache.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro', modelYear: 2023 }).length, 2);
  assert.equal(cache.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro', cpuCores: 10, gpuCores: 16, ramGb: 16, storageGb: 512 }).length, 1);
  for (const patch of [{ cpu: 'M2' }, { cpu: 'M2 Max' }, { screenInches: 16 }, { modelYear: 2022 },
    { cpuCores: 9 }, { gpuCores: 18 }, { ramGb: 24 }, { storageGb: 256 }]) {
    assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro', cpu: 'M2 Pro', ...patch }), []);
  }
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Air', cpu: 'M2 Pro' }), []);
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14 M2 Pro 2023', cpu: 'M2 Max' }), []);
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14 M2 Pro 2023', cpu: 'Intel Core i5-1135G7' }), []);
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14 2023', modelYear: 2022 }), []);
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14', screenInches: 16 }), []);
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro', screenInches: 14.9 }), []);
});

test('unknown detail fields cannot satisfy known requirements, and Windows model keys are exact', async (t) => {
  const dir = await directory(t), api = transport();
  const windows = { slug: 'dell-latitude-5520', name: 'Dell Latitude 5520 (i5-1135G7 / 16GB / 512GB)' };
  const other = { slug: 'dell-latitude-5521', name: 'Dell Latitude 5521' };
  api.index([mac, windows, other]); api.detail(mac, { gpu_name: 'Apple M2 Pro GPU' });
  api.detail(windows, { cpu_name: 'Intel Core i5-1135G7', gpu_name: 'Intel Iris Xe', release_date: null, display: { size_inch: 15.6 } });
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await cache.warmLaptops([{ model: 'MacBook Pro 14', cpu: 'M2 Pro' }, { model: 'Dell Latitude 5520', cpu: 'i5-1135G7' }]);
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro', cpuCores: 10 }), []);
  assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro', gpuCores: 16 }), []);
  assert.equal(cache.getLaptops({ model: 'Dell Latitude 5520', cpu: 'i5-1135G7', ramGb: 16 }).length, 1);
  assert.deepEqual(cache.getLaptops({ model: 'Dell Latitude 552' }), []);
  assert.deepEqual(cache.getLaptops({ model: 'Dell Latitude 5521' }), []);
  assert.equal(api.calls.includes(url(other.slug)), false);
});

test('refreshed laptop indexes expose new configurations without restarting the cache', async (t) => {
  const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac);
  const cache = new TechAPICache(dir, { fetch: api.fetcher }), query = { model: 'MacBook Pro 14', cpu: 'M2 Pro' };
  await cache.warmLaptops([query]);
  assert.equal(cache.getLaptops(query).length, 1);

  const future = Date.now() + 31 * 24 * 60 * 60 * 1_000;
  t.mock.method(Date, 'now', () => future);
  const variant = { slug: 'apple-macbook-pro-14-m2-pro-2023-32gb', name: mac.name };
  api.index([mac, variant]); api.detail(variant, { ram_gb: 32 });
  await cache.warmLaptops([query]);
  const calls = api.calls.length;
  assert.deepEqual(cache.getLaptops(query).map((record) => record.ramGb), [16, 32]);
  assert.equal(cache.getLaptops({ ...query, ramGb: 32 }).length, 1);
  assert.equal(api.calls.length, calls, 'reads of new configurations remain offline');
});

test('stale last-good laptop data remains available through provider failures and temporary 404s', async (t) => {
  const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac);
  const first = new TechAPICache(dir, { fetch: api.fetcher }); await first.warmLaptops([{ model: 'MacBook Pro', cpu: 'M2 Pro' }]);
  await ageCache(dir);
  const offline = new TechAPICache(dir, { fetch: async () => { throw new Error('Provider offline'); } });
  await offline.warmLaptops([{ model: 'MacBook Pro', cpu: 'M2 Pro' }]);
  assert.equal(offline.getLaptops({ model: 'MacBook Pro', cpu: 'M2 Pro' }).length, 1);
  assert.equal(offline.status.laptopStaleRecords, 1); assert.match(offline.status.laptopError!, /Provider offline/);
  api.resources.delete(url(mac.slug));
  const missing = new TechAPICache(dir, { fetch: api.fetcher }); await missing.warmLaptops([{ model: 'MacBook Pro', cpu: 'M2 Pro' }]);
  assert.equal(missing.getLaptops({ model: 'MacBook Pro', cpu: 'M2 Pro' }).length, 1);
  const reload = new TechAPICache(dir, { fetch: api.fetcher }); assert.equal(reload.getLaptops({ model: 'MacBook Pro', cpu: 'M2 Pro' }).length, 1);
});

test('laptop warm deduplicates requests, caches misses, and applies failure cooldown without scheduling', async (t) => {
  const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac);
  const cache = new TechAPICache(dir, { fetch: api.fetcher });
  await Promise.all([cache.warmLaptops([{ model: 'MacBook Pro 14 M2 Pro' }, { model: 'MacBook Air M1' }]),
    cache.warmLaptops([{ model: 'MacBook Pro 14 M2 Pro' }, { model: 'MacBook Air M1' }])]);
  assert.equal(api.calls.length, 2); assert.equal(cache.status.laptopMisses, 1);
  const down = new TechAPICache(await directory(t), { fetch: async () => { api.calls.push('offline'); throw new Error('Unavailable'); } });
  await Promise.all([down.warmLaptops([{ model: 'MacBook Pro' }]), down.warmLaptops([{ model: 'MacBook Air' }])]);
  assert.equal(api.calls.filter((call) => call === 'offline').length, 1);
  assert.ok(down.status.laptopRetryAfter); const retryAt = Date.parse(down.status.laptopRetryAfter!);
  t.mock.method(Date, 'now', () => retryAt + 1);
  await down.warmLaptops([{ model: 'MacBook Pro' }]); assert.equal(api.calls.filter((call) => call === 'offline').length, 2);
});

test('corrupt caches and unsafe links are rejected, and cache extension fields never expose prices', async (t) => {
  const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac);
  const filename = path.join(dir, TECHAPI_LAPTOP_CACHE_FILE); await writeFile(filename, '{bad');
  const broken = new TechAPICache(dir, { fetch: api.fetcher }); assert.ok(broken.status.laptopError);
  await broken.warmLaptops([{ model: 'MacBook Pro' }]); assert.equal(broken.getLaptops({ model: 'MacBook Pro' }).length, 1);
  const original = JSON.parse(await readFile(filename, 'utf8'));
  original.details[mac.slug].record.msrp_usd = 100; original.details[mac.slug].record.verified = true;
  await writeFile(filename, JSON.stringify(original));
  const extras = new TechAPICache(dir, { fetch: api.fetcher });
  assert.equal('msrp_usd' in extras.getLaptops({ model: 'MacBook Pro' })[0]!, false);
  assert.equal('verified' in extras.getLaptops({ model: 'MacBook Pro' })[0]!, false);
  original.details[mac.slug].record.sourceUrls = ['javascript:alert(1)']; await writeFile(filename, JSON.stringify(original));
  const unsafe = new TechAPICache(dir, { fetch: api.fetcher }); assert.deepEqual(unsafe.getLaptops({ model: 'MacBook Pro' }), []);
  assert.match(unsafe.status.laptopError!, /record cache/);
});

test('wrong detail identities and inconsistent chip/year fields are rejected', async (t) => {
  for (const extras of [{ slug: 'wrong-model' }, { name: 'Apple MacBook Air' }, { cpu_name: 'Apple M2 Max' }, { release_date: '2022-01-01' }]) {
    const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac, extras);
    const cache = new TechAPICache(dir, { fetch: api.fetcher }); await cache.warmLaptops([{ model: 'MacBook Pro 14', cpu: 'M2 Pro' }]);
    assert.deepEqual(cache.getLaptops({ model: 'MacBook Pro 14', cpu: 'M2 Pro' }), []); assert.match(cache.status.laptopError!, /identity/);
  }
});

test('malformed indexes, non-JSON, oversized and redirect responses cannot populate laptop cache', async (t) => {
  for (const response of [json({ count: 2, results: [mac] }), json({ count: 1, results: [{ ...mac, slug: '../escape' }] }),
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '9000000' } }),
    Response.redirect('https://attacker.invalid/'), new Response('{bad', { headers: { 'content-type': 'application/json' } })]) {
    const dir = await directory(t), api = transport(); api.resources.set(url(), response);
    const cache = new TechAPICache(dir, { fetch: api.fetcher }); await cache.warmLaptops([{ model: 'MacBook Pro' }]);
    assert.equal(cache.status.laptopRecords, 0); assert.ok(cache.status.laptopError); assert.equal(api.calls.length, 1);
  }
});

test('laptop detail work is capped, at most three requests run concurrently, and pre-aborted calls do no work', async (t) => {
  const dir = await directory(t), api = transport();
  const rows = Array.from({ length: 163 }, (_, i) => ({ slug: `apple-macbook-pro-${i}`, name: 'Apple MacBook Pro' }));
  api.index(rows); for (const row of rows) api.detail(row);
  let active = 0, maximum = 0;
  const fetcher: typeof fetch = async (input, options) => {
    if (String(input) === url()) return api.fetcher(input, options);
    active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 1));
    try { return await api.fetcher(input, options); } finally { active--; }
  };
  const cache = new TechAPICache(dir, { fetch: fetcher }); const controller = new AbortController(); controller.abort();
  await assert.rejects(cache.warmLaptops([{ model: 'MacBook Pro' }], controller.signal), { name: 'AbortError' }); assert.equal(api.calls.length, 0);
  await cache.warmLaptops([{ model: 'MacBook Pro' }]); assert.equal(api.calls.length, 161); assert.equal(maximum, 3);
  assert.equal(cache.getLaptops({ model: 'MacBook Pro' }).length, 160);
  await cache.warmLaptops([{ model: 'MacBook Pro' }]); assert.equal(cache.getLaptops({ model: 'MacBook Pro' }).length, 163);
});

test('caller cancellation is propagated without entering provider cooldown, preserving earlier data', async (t) => {
  const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac);
  const cache = new TechAPICache(dir, { fetch: api.fetcher }); await cache.warmLaptops([{ model: 'MacBook Pro' }]); await ageCache(dir);
  const controller = new AbortController();
  const cancelFetch: typeof fetch = async (input, options) => {
    if (String(input) === url()) return api.fetcher(input, options);
    controller.abort(); options?.signal?.throwIfAborted(); return api.fetcher(input, options);
  };
  const aborted = new TechAPICache(dir, { fetch: cancelFetch });
  await assert.rejects(aborted.warmLaptops([{ model: 'MacBook Pro' }], controller.signal), { name: 'AbortError' });
  assert.equal(aborted.status.laptopRetryAfter, null); assert.equal(aborted.getLaptops({ model: 'MacBook Pro' }).length, 1);
});

test('simultaneous CPU and laptop warm calls share one provider concurrency budget', async (t) => {
  const dir = await directory(t), api = transport(); api.index([mac]); api.detail(mac);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const destination = String(input); calls.push(destination);
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (destination.endsWith('/cpus/index.json')) return json({ count: 1, results: [{ slug: 'intel-core-i5-12400', name: 'Intel Core i5-12400' }] });
    if (destination.includes('/cpus/')) return json({ slug: 'intel-core-i5-12400', name: 'Intel Core i5-12400', memory_support: 'DDR4 / DDR5' });
    return api.fetcher(input, options);
  };
  const cache = new TechAPICache(dir, { fetch: fetcher });
  await Promise.all([cache.warmLaptops([{ model: 'MacBook Pro' }]), cache.warm([{ kind: 'cpu', model: 'i5-12400' }])]);
  assert.deepEqual(calls.map((call) => call.includes('/laptops/') ? 'laptop' : 'cpu'), ['laptop', 'laptop', 'cpu', 'cpu']);
  assert.equal(cache.status.records, 1); assert.equal(cache.status.laptopRecords, 1);
});
