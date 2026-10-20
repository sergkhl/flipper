import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { BootstrapResponse, ListingDetail, ListingsResponse } from '../shared/types.ts';
import { serverHost, serverOptions, validateServerAccess } from '../server/access.ts';
import { DEFAULT_SETTINGS } from '../server/config.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { assessWithRules } from '../server/hardware.ts';
import { appServer } from '../server/http.ts';
import { buildReference } from '../server/pricing.ts';
import { FlipperService } from '../server/service.ts';
import { EMPTY_STATE, Store } from '../server/store.ts';
import { assessment, raw } from './helpers.ts';

const origin = 'https://flipper.example.test', token = 'fixture-private-administration-token-123456789';
const hostedOptions = { publicOrigin: origin, adminToken: token, revision: 'test-revision-123' };
const adminHeaders = { 'x-flipper-admin-token': token };

function fixture() {
  const store = new Store('', true);
  const service = new FlipperService(store, {
    async search() { throw new Error('A read-only request must never collect marketplace data'); },
    async detail() { throw new Error('A read-only request must never retrieve marketplace details'); },
  });
  const candidate = raw('retained-gpu', 4_000_000, { district: 'Market district' });
  const interpreted = enrichComputerAssessment(candidate, assessWithRules(candidate));
  store.putListing(candidate, interpreted, true);
  const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`reference-${i}`, 6_000_000), assessment: interpreted }));
  const reference = buildReference(candidate, interpreted, peers, store.getSettings()).reference;
  assert.ok(reference);
  store.setReference(candidate.id, reference, 'Five independent market comparisons');
  store.setCollection('gpu', '', [candidate.id]);
  return { store, service, candidate };
}

async function httpFixture(t: TestContext) {
  const f = fixture(), dist = mkdtempSync(join(tmpdir(), 'flipper-hosted-access-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Flipper test shell</title>');
  const server = appServer(f.service, dist, hostedOptions);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.store.close(); rmSync(dist, { recursive: true, force: true });
  });
  return { ...f, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('hosted startup fails closed for incomplete, weak, or ambiguous access configuration', () => {
  assert.equal(validateServerAccess({}).hosted, false);
  assert.deepEqual(serverOptions({ FLIPPER_PUBLIC_ORIGIN: origin, FLIPPER_ADMIN_TOKEN: token, FLIPPER_REVISION: 'abc123' }),
    { publicOrigin: origin, adminToken: token, revision: 'abc123' });
  for (const options of [
    { publicOrigin: origin }, { adminToken: token }, { publicOrigin: '', adminToken: token },
    { publicOrigin: origin, adminToken: '' }, { publicOrigin: origin, adminToken: 'short' },
    { publicOrigin: origin, adminToken: ' '.repeat(40) }, { publicOrigin: origin, adminToken: 'x'.repeat(32) + '\n' },
    ...['http://flipper.example.test', origin + '/', origin + '/admin', origin + '?x=1', origin + '#fragment',
      'https://user:password@flipper.example.test', 'https://FLIPPER.example.test', 'https://flipper.example.test:443', 'not a URL']
      .map((publicOrigin) => ({ publicOrigin, adminToken: token })),
  ]) assert.throws(() => validateServerAccess(options), /FLIPPER_/);
  const access = validateServerAccess(hostedOptions);
  assert.equal(access.hosted, true);
  assert.equal(serverHost(access, { FLIPPER_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(serverHost(validateServerAccess({}), {}), '127.0.0.1');
  assert.throws(() => serverHost(validateServerAccess({}), { FLIPPER_HOST: '0.0.0.0' }), /hosted access/);
  assert.throws(() => validateServerAccess({ ...hostedOptions, revision: 'secret\nvalue' }), /REVISION/);
});

test('public service responses ignore private state and economics before filtering or scoring', () => {
  const { store, service, candidate } = fixture();
  try {
    const publicBefore = service.publicListings('gpu', new URLSearchParams());
    assert.equal(publicBefore.items[0]?.valuation.opportunity, true);
    assert.ok(publicBefore.items[0]?.valuation.reference?.offers.length);
    store.setState(candidate.id, { saved: true, dismissed: true, costReserve: 987654321, expectedResale: 123456789 });
    store.saveSettings({ ...store.getSettings(), costReserves: { laptop: 945678, desktop: 856789, gpu: 765432 },
      minProfit: 87654321, minRoiPercent: 321, resaleFactor: 1.234, aiBudgetUsd: 7.89, scanLimit: 789, benchmarkLimit: 199 });
    store.saveSearch({ name: 'Private saved search', category: 'gpu', query: 'private query', district: '', mode: 'buy' });
    store.addReceipt({ id: 'private-receipt', model: 'private-provider-model', provider: 'private-provider',
      inputTokens: 123, outputTokens: 456, costUsd: 12.3456, at: new Date().toISOString() });
    assert.deepEqual(service.publicListings('gpu', new URLSearchParams()), publicBefore,
      'personal state, spending and private economic preferences cannot alter a public response');
    const publicDetail = service.publicDetail(candidate.id)!;
    assert.deepEqual(publicDetail.state, EMPTY_STATE);
    assert.equal(publicDetail.valuation.costReserve, 0);
    assert.equal(publicDetail.valuation.expectedResale, null);
    assert.equal(publicDetail.valuation.profit, null);
    assert.equal(publicDetail.valuation.roiPercent, null);
    assert.equal(publicDetail.valuation.resaleOpportunity, false);
    assert.equal(publicDetail.history[0]?.price, candidate.price);
    assert.deepEqual(service.publicListings('gpu', new URLSearchParams('view=review')).items, [], 'dismissal is not public ambiguity');
    assert.throws(() => service.publicListings('gpu', new URLSearchParams('view=saved')), /administrator/);
    const bootstrap = service.publicBootstrap();
    assert.deepEqual(Object.keys(bootstrap.settings).sort(), ['discountPercent', 'includeUnknownMemory', 'minComparables', 'minRamGb', 'minVramGb']);
    assert.equal(bootstrap.access, 'read-only'); assert.equal(bootstrap.ai, null); assert.deepEqual(bootstrap.searches, []);
    const privateDetail = service.detail(candidate.id)!;
    assert.equal(privateDetail.state.dismissed, true);
    assert.equal(privateDetail.valuation.costReserve, 987654321);
    assert.equal(privateDetail.valuation.expectedResale, 123456789);
    assert.equal(service.bootstrap().settings.aiBudgetUsd, 7.89);
    assert.equal(service.bootstrap().ai.totalCostUsd, 12.3456);
    assert.equal(service.bootstrap().searches[0]?.name, 'Private saved search');
    assert.equal(service.bootstrap().access, 'admin');
  } finally { store.close(); }
});

test('anonymous searches filter all retained local data offline rather than requiring a saved collection query', () => {
  const { store, service, candidate } = fixture();
  try {
    const older = raw('older-retained', 5_000_000, { title: 'Retained Radeon card', description: 'Đồ họa đã qua sử dụng' });
    store.putListing(older, assessment(), true);
    store.putListing(raw('national-only', 3_000_000, { title: 'Retained Radeon national comparison' }), assessment(), false);
    store.setCollection('gpu', 'private collection query', [older.id]);
    assert.equal(service.listings('gpu', new URLSearchParams()).total, 1, 'admin collection semantics remain intact');
    assert.equal(service.publicListings('gpu', new URLSearchParams()).total, 2);
    assert.deepEqual(service.publicListings('gpu', new URLSearchParams('q=radeon')).items.map((i) => i.id), [older.id]);
    assert.deepEqual(service.publicListings('gpu', new URLSearchParams('q=do+hoa')).items.map((i) => i.id), [older.id]);
    assert.deepEqual(service.publicListings('gpu', new URLSearchParams('q=3060')).items.map((i) => i.id), [candidate.id]);
    assert.equal(service.publicListings('gpu', new URLSearchParams('q=empty-result')).total, 0);
  } finally { store.close(); }
});

test('public nested attributes, assessment status and coverage exclude retained operational diagnostics', () => {
  const { store, service, candidate } = fixture();
  try {
    const item = store.getListing(candidate.id)!;
    store.putListing({ ...candidate, attributes: { market_field: 'Market fact', _detailError: 'private-network-error-secret',
      _sourceUnavailable: false, _detailedAt: 'internal-timestamp' } },
    { ...item.assessment, status: 'AI refresh budget exhausted private operational status' }, true);
    store.saveCoverage({ category: 'gpu', query: '', scanned: 1, totalAvailable: 5, limit: 20,
      completedAt: candidate.observedAt, error: 'private-network-error-secret', requestCount: 987654 });
    const detail = service.publicDetail(candidate.id)!;
    assert.deepEqual(detail.attributes, { market_field: 'Market fact' });
    assert.equal(detail.assessment.status, 'Retained seller evidence; eligible.');
    const feed = service.publicListings('gpu', new URLSearchParams('view=review'));
    assert.equal(feed.coverage?.error, null); assert.equal(feed.coverage?.requestCount, 0);
    assert.ok(!JSON.stringify(feed).includes('private-network-error-secret'));
    assert.equal(service.detail(candidate.id)?.attributes._detailError, 'private-network-error-secret');
    assert.equal(service.listings('gpu', new URLSearchParams('view=review')).coverage?.requestCount, 987654);
  } finally { store.close(); }
});

test('public coverage depends only on matching retained market data and cannot probe private collection records', (t) => {
  const { store, service, candidate } = fixture();
  try {
    store.putListing(raw('other-card', 5_000_000, { title: 'Radeon card', description: 'Different retained evidence',
      observedAt: '2099-01-01T00:00:00.000Z' }), assessment(), true);
    const queries = ['', '3060', 'radeon', 'private historical query', 'never collected'];
    const before = queries.map((q) => service.publicListings('gpu', new URLSearchParams({ q })));
    for (const q of queries) store.saveCoverage({ category: 'gpu', query: q, scanned: 321, totalAvailable: 654,
      limit: 987, completedAt: '1999-01-01T00:00:00.000Z', error: 'Private collection diagnostics', requestCount: 456 });
    store.saveCoverage({ category: 'laptop', query: '', scanned: 999, totalAvailable: 999,
      limit: 999, completedAt: '1998-01-01T00:00:00.000Z', error: 'Private laptop collection', requestCount: 999 });
    t.mock.method(store, 'coverage', () => { throw new Error('Public reads must not inspect private coverage records'); });
    assert.deepEqual(queries.map((q) => service.publicListings('gpu', new URLSearchParams({ q }))), before);
    assert.deepEqual(before[1]!.coverage, { category: 'gpu', query: '3060', scanned: 1, limit: 1,
      totalAvailable: null, completedAt: candidate.observedAt, error: null, requestCount: 0 });
    assert.equal(before[0]!.coverage?.scanned, 2);
    assert.equal(before[0]!.coverage?.completedAt, '2099-01-01T00:00:00.000Z');
    assert.equal(before[3]!.coverage, null); assert.equal(before[4]!.coverage, null);
    assert.equal(service.publicListings('laptop', new URLSearchParams()).coverage, null);
  } finally { store.close(); }
});

test('hosted HTTP exposes anonymous market reads while every private route and write is protected', async (t) => {
  const { base, store, candidate } = await httpFixture(t);
  store.setState(candidate.id, { saved: true, costReserve: 123456 });
  for (const headers of [{}, adminHeaders, { 'x-flipper-admin-token': 'forged-header' }]) {
    const response = await fetch(base + '/api/bootstrap', { headers });
    assert.equal(response.status, 200);
    const bootstrap = await response.json() as BootstrapResponse;
    assert.equal(bootstrap.access, 'read-only'); assert.equal(bootstrap.ai, null);
  }
  const listingResponse = await fetch(base + '/api/listings?category=gpu');
  const listings = await listingResponse.json() as ListingsResponse;
  assert.equal(listings.ai, null); assert.equal(listings.job, null); assert.equal(listings.stats.saved, 0);
  assert.deepEqual(listings.items[0]?.state, EMPTY_STATE);
  assert.deepEqual((await (await fetch(base + '/api/listings/' + candidate.id)).json() as ListingDetail).state, EMPTY_STATE);
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok', revision: hostedOptions.revision });
  for (const path of ['/api/bootstrap', '/api/listings?category=gpu', '/api/listings/' + candidate.id, '/healthz']) {
    const head = await fetch(base + path, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
  for (const path of ['/api/jobs/active', '/api/jobs/anything', '/api/deployment', '/api/settings', '/api/searches', '/api/ai/test',
    '/api/listings/retained-gpu/state', '/api/listings/retained-gpu/analyze']) {
    assert.equal((await fetch(base + path, { headers: adminHeaders })).status, 404, path);
  }
  assert.equal((await fetch(base + '/api/listings?category=gpu&view=saved', { headers: adminHeaders })).status, 403);
  for (const path of ['/api/refresh', '/api/settings', '/api/listings/' + candidate.id + '/state',
    '/api/listings/' + candidate.id + '/analyze', '/api/searches', '/api/searches/anything', '/api/jobs/anything/cancel', '/api/ai/test']) {
    for (const headers of [{}, adminHeaders]) {
      const response = await fetch(base + path, { method: path.includes('/searches/anything') ? 'DELETE' : 'POST',
        headers: { ...headers, origin, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 403, path);
    }
  }
  for (const path of ['/admin', '/admin/', '/admin/api/bootstrap', '/admin/api/listings?category=gpu', '/admin/healthz']) {
    assert.equal((await fetch(base + path)).status, 403, path);
    assert.equal((await fetch(base + path, { headers: { 'x-flipper-admin-token': 'incorrect' } })).status, 403, path);
  }
  const admin = await fetch(base + '/admin/api/bootstrap', { headers: adminHeaders });
  assert.equal(admin.status, 200); assert.equal((await admin.json() as BootstrapResponse).access, 'admin');
  const privateFeed = await (await fetch(base + '/admin/api/listings?category=gpu&view=saved', { headers: adminHeaders })).json() as ListingsResponse;
  assert.equal(privateFeed.items[0]?.state.saved, true); assert.ok(privateFeed.ai);
  assert.match(await (await fetch(base + '/admin/', { headers: adminHeaders })).text(), /Flipper test shell/);
  assert.equal(store.getSettings().aiBudgetUsd, DEFAULT_SETTINGS.aiBudgetUsd);
});

test('hosted administrative writes require exact origin and reject cross-site metadata while token-authenticated CLI writes work', async (t) => {
  const { base, store } = await httpFixture(t);
  const write = (headers: Record<string, string>) => fetch(base + '/admin/api/settings', {
    method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json', ...headers }, body: '{"discountPercent":21}',
  });
  for (const external of ['http://flipper.example.test', origin + '/', origin + ':443', 'https://flipper.example.test.evil.test',
    'https://elsewhere.test', 'null', 'not an origin']) {
    assert.equal((await write({ origin: external })).status, 403, external);
  }
  assert.equal((await write({ origin, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await write({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(store.getSettings().discountPercent, 20, 'rejected writes leave settings unchanged');
  assert.equal((await write({ origin, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await write({})).status, 200, 'trusted proxy token supports explicit command-line administration');
  assert.equal(store.getSettings().discountPercent, 21);
});

test('ambiguous URL encodings, traversal, prefix confusion and token spoofing cannot reach administrator APIs', async (t) => {
  const { base, store } = await httpFixture(t);
  const paths = ['/admin/../api/settings', '/admin/%2e%2e/api/settings', '/%61dmin/api/settings',
    '/admin%2fapi/settings', '/admin%5capi/settings', '/admin//api/settings', '/administer/api/settings',
    '//admin/api/settings', '/admin\\api/settings', '/api/listings/%ZZ/state'];
  for (const path of paths) {
    for (const withToken of [false, true]) {
      const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request(base, { path, method: 'POST', headers: { 'content-type': 'application/json', origin,
          ...(withToken ? adminHeaders : {}) } }, (res) => {
          let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode!, text }));
        });
        req.on('error', reject); req.end('{"discountPercent":33}');
      });
      assert.ok([400, 403, 404, 405].includes(result.status), `${path} with token=${withToken}: ${result.status}`);
    }
  }
  assert.equal(store.getSettings().discountPercent, 20);
});

test('unexpected public errors hide provider diagnostics, and local unrestricted loopback behavior remains compatible', async (t) => {
  const { base, service } = await httpFixture(t);
  service.publicBootstrap = () => { throw new Error('private provider error with hidden network endpoint'); };
  const failed = await fetch(base + '/api/bootstrap');
  assert.equal(failed.status, 500); assert.deepEqual(await failed.json(), { error: 'The request could not be completed' });
  const local = appServer(service, undefined, {});
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>((resolve) => local.close(() => resolve())); });
  const localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  assert.equal((await (await fetch(localBase + '/api/bootstrap')).json() as BootstrapResponse).access, 'admin');
  const update = (headers: Record<string, string>) => fetch(localBase + '/api/settings', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: '{"discountPercent":22}' });
  assert.equal((await update({ origin: 'http://localhost:5173' })).status, 200);
  assert.equal((await update({ origin: 'https://outside.example.test' })).status, 403);
  assert.equal((await update({ 'sec-fetch-site': 'cross-site' })).status, 403);
});
