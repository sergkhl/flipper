import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChototClient } from '../server/chotot.ts';
import { appServer } from '../server/http.ts';
import { LiteLLMClient } from '../server/litellm.ts';
import { FlipperService } from '../server/service.ts';
import { Store } from '../server/store.ts';
import { assessment, raw } from './helpers.ts';

const origin = 'https://flipper.example.test', token = 'fixture-deployment-administration-token-123456789';
const headers = { 'x-flipper-admin-token': token, origin, 'content-type': 'application/json' };
const maintenanceMessage = 'Deployment is in progress; try again shortly';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-deployment-')), marker = join(directory, '.deployment-maintenance');
  const store = new Store(directory, true), servers: Server[] = [];
  store.saveSettings({ ...store.getSettings(), aiEnabled: false });
  const source: Pick<ChototClient, 'search' | 'detail'> = {
    async search() { return { items: [], total: 0 }; },
    async detail(item) { return item; },
  };
  const sourceSearch = t.mock.method(source, 'search'), sourceDetail = t.mock.method(source, 'detail');
  const service = new FlipperService(store, source), candidate = raw('retained-candidate', 4_000_000);
  store.putListing(candidate, assessment(), true);
  store.setCollection('gpu', '', [candidate.id]);
  t.after(async () => {
    const active = service.activeJob(); if (active) service.cancelJob(active.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const startHTTP = async () => {
    const server = appServer(service, undefined, { publicOrigin: origin, adminToken: token }); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  return { store, service, source, sourceSearch, sourceDetail, candidate, marker, startHTTP };
}

test('deployment marker synchronously blocks new collection, analysis and AI probes before any source or provider request', async (t) => {
  const f = fixture(t), probe = t.mock.method(LiteLLMClient.prototype, 'test', async () => []);
  t.mock.method(f.store, 'getKey', () => 'fixture-only-key');
  assert.equal(f.store.deploymentMaintenanceActive(), false);
  writeFileSync(f.marker, 'deployment test');
  assert.equal(f.store.deploymentMaintenanceActive(), true);
  assert.throws(() => f.service.refresh('gpu', ''), { message: maintenanceMessage });
  assert.throws(() => f.service.analyze(f.candidate.id), { message: maintenanceMessage });
  assert.throws(() => f.service.analyze('nonexistent'), { message: maintenanceMessage });
  await assert.rejects(f.service.testAI(), { message: maintenanceMessage });
  assert.equal(f.sourceSearch.mock.callCount(), 0); assert.equal(f.sourceDetail.mock.callCount(), 0);
  assert.equal(probe.mock.callCount(), 0); assert.deepEqual(f.service.deploymentStatus(), { busy: false });
  assert.equal(f.service.publicBootstrap().counts.gpu, 1, 'reads remain available during activation');
});

test('deployment status includes existing jobs and marker creation leaves the current job running', async (t) => {
  const f = fixture(t); let release!: () => void;
  t.mock.method(f.source, 'search', async () => await new Promise((resolve) => { release = () => resolve({ items: [], total: 0 }); }));
  const job = f.service.refresh('gpu', 'private collection');
  assert.deepEqual(f.service.deploymentStatus(), { busy: true });
  await assert.rejects(f.service.testAI(), /active refresh/);
  writeFileSync(f.marker, 'deployment test');
  assert.deepEqual(f.service.deploymentStatus(), { busy: true });
  assert.equal(f.service.activeJob()?.id, job.id);
  assert.throws(() => f.service.refresh('gpu', ''), { message: maintenanceMessage });
  release(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.service.getJob(job.id)?.status, 'complete');
  assert.deepEqual(f.service.deploymentStatus(), { busy: false });
  assert.throws(() => f.service.refresh('gpu', ''), { message: maintenanceMessage });
});

test('AI probes reserve the busy state, exclude other work and always release their flag on success or failure', async (t) => {
  const f = fixture(t); let release!: () => void, key = 'fixture-only-key', mode: 'pending' | 'failure' | 'success' = 'pending';
  t.mock.method(f.store, 'getKey', () => key);
  const probe = t.mock.method(LiteLLMClient.prototype, 'test', async () => {
    if (mode === 'failure') throw new Error('Fixture provider failure');
    if (mode === 'success') return [];
    return await new Promise<Array<{ model: string; ok: boolean }>>((resolve) => { release = () => resolve([]); });
  });
  const pending = f.service.testAI();
  assert.deepEqual(f.service.deploymentStatus(), { busy: true });
  await assert.rejects(f.service.testAI(), /probe is already running/);
  assert.throws(() => f.service.refresh('gpu', ''), /active AI probe/);
  assert.throws(() => f.service.analyze(f.candidate.id), /active AI probe/);
  assert.equal(f.sourceSearch.mock.callCount(), 0); assert.equal(f.sourceDetail.mock.callCount(), 0);
  assert.equal(probe.mock.callCount(), 1);
  writeFileSync(f.marker, 'deployment test');
  assert.deepEqual(f.service.deploymentStatus(), { busy: true }, 'an existing probe keeps the deployment busy');
  await assert.rejects(f.service.testAI(), { message: maintenanceMessage });
  release(); await pending;
  assert.deepEqual(f.service.deploymentStatus(), { busy: false });
  rmSync(f.marker); mode = 'failure';
  await assert.rejects(f.service.testAI(), /Fixture provider failure/);
  assert.deepEqual(f.service.deploymentStatus(), { busy: false });
  key = ''; await assert.rejects(f.service.testAI(), /LITELLM_API_KEY/);
  assert.deepEqual(f.service.deploymentStatus(), { busy: false });
  key = 'fixture-only-key'; mode = 'success';
  assert.deepEqual(await f.service.testAI(), []);
  assert.deepEqual(f.service.deploymentStatus(), { busy: false });
});

test('the private deployment API exposes only busy status, freezes all mutations and permits cancellation during maintenance', async (t) => {
  const f = fixture(t), base = await f.startHTTP();
  const publicProbe = await fetch(base + '/api/deployment', { headers }); assert.equal(publicProbe.status, 404);
  assert.equal((await fetch(base + '/admin/api/deployment')).status, 403);
  assert.deepEqual(await (await fetch(base + '/admin/api/deployment', { headers })).json(), { busy: false });
  t.mock.method(f.source, 'search', async (input: Parameters<ChototClient['search']>[0]) => await new Promise((_resolve, reject) => {
    input.signal!.addEventListener('abort', () => reject(new Error('Fixture cancellation')), { once: true });
  }));
  const job = f.service.refresh('gpu', 'private collection');
  writeFileSync(f.marker, 'deployment test');
  assert.deepEqual(await (await fetch(base + '/admin/api/deployment', { headers })).json(), { busy: true });
  for (const [path, method, body] of [
    ['/api/refresh', 'POST', '{"category":"gpu"}'], ['/api/listings/' + f.candidate.id + '/analyze', 'POST', '{}'],
    ['/api/ai/test', 'POST', '{}'], ['/api/settings', 'POST', '{"minComparables":27}'],
    ['/api/listings/' + f.candidate.id + '/state', 'POST', '{"saved":true}'],
    ['/api/searches', 'POST', '{"name":"Private","category":"gpu","query":""}'],
    ['/api/searches/anything', 'DELETE', '{}'],
  ]) {
    const response = await fetch(base + '/admin' + path, { method, headers, body });
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: maintenanceMessage });
  }
  assert.equal((await fetch(base + '/admin/api/bootstrap', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/listings?category=gpu')).status, 200);
  assert.equal(f.store.getSettings().minComparables, 5); assert.equal(f.store.getListing(f.candidate.id)?.state.saved, false);
  assert.deepEqual(f.store.searches(), []);
  const cancellation = await fetch(base + '/admin/api/jobs/' + job.id + '/cancel', { method: 'POST', headers });
  assert.equal(cancellation.status, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await (await fetch(base + '/admin/api/deployment', { headers })).json(), { busy: false });
  rmSync(f.marker);
  const resumed = await fetch(base + '/admin/api/settings', { method: 'POST', headers, body: '{"minComparables":27}' });
  assert.equal(resumed.status, 200); assert.equal(f.store.getSettings().minComparables, 27);
});

test('a mutation whose body finishes after the maintenance marker appears is rejected before it writes', async (t) => {
  const f = fixture(t), base = await f.startHTTP(), payload = '{"minComparables":29}';
  let req!: ReturnType<typeof request>, ready!: Promise<void>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = request(base + '/admin/api/settings', { method: 'POST', headers: { ...headers,
      expect: '100-continue', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    ready = new Promise<void>((done) => req.once('continue', done));
    req.flushHeaders();
  });
  await ready; writeFileSync(f.marker, 'deployment test'); req.end(payload);
  const result = await response;
  assert.equal(result.status, 503); assert.deepEqual(JSON.parse(result.body), { error: maintenanceMessage });
  assert.equal(f.store.getSettings().minComparables, 5);
});
