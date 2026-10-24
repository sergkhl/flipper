import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { SourceDeferredError } from '../server/source-policy.ts';
import { SourceCooldownError } from '../server/source-cooldown.ts';
import { appServer } from '../server/http.ts';
import { raw } from './helpers.ts';
import type { StoredRun } from '../server/runs.ts';
import type { RawListing } from '../shared/types.ts';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(condition(), 'expected progress before deadline');
}
async function settled(service: FlipperService) { await until(() => !service.activeJob()); }
const emptySource = { async search() { return { items: [], total: 0 }; }, async detail(item: RawListing) { return item; } };
const configure = (store: Store) => store.saveSettings({ ...store.getSettings(), aiEnabled: false });

test('failed manual runs survive restart and retry only unfinished pages with frozen parameters', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-runs-'));
  let store = new Store(directory), blocked = true;
  configure(store);
  const pages: number[] = [], workers: number[] = [];
  const items = Array.from({ length: 25 }, (_, i) => raw(`run-local-${i}`, 5_000_000));
  const source = {
    beginJob(context: { workers?: number }) { workers.push(context.workers!); },
    async search(input: { location: string; page?: number }) {
      if (input.location === 'nationwide') return { items: [], total: 0 };
      const page = input.page ?? 1; pages.push(page);
      if (page === 2 && blocked) throw new Error('Fixture source failure on page 2');
      return { items: items.slice((page - 1) * 20, page * 20), total: 25 };
    }, async detail(item: RawListing) { return item; },
  };
  let service = new FlipperService(store, source);
  try {
    const first = service.startRun('gpu', 'RTX 3060', { scanLimit: 40, minRamGb: 32, aiBudgetUsd: .2 });
    await settled(service);
    const failed = store.getRun(first.id)!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.progress.nextPage, 2);
    failed.job.aiCostUsd = .07; store.saveRun(failed); // Previously settled provider accounting.
    await service.shutdown(); store.close(); store = new Store(directory);
    store.saveSettings({ ...store.getSettings(), scanLimit: 100, minRamGb: 64, aiBudgetUsd: .9, marketplaceWorkers: 2, aiWorkers: 1 });
    service = new FlipperService(store, source); blocked = false;
    assert.equal(service.runs().runs[0]?.state, 'failed');
    const resumed = service.resumeRun(first.id); await settled(service);
    const run = store.getRun(resumed.id)!;
    assert.equal(run.state, 'complete'); assert.equal(run.rootId, first.id);
    assert.equal(run.parameters.scanLimit, 40); assert.equal(run.parameters.minRamGb, 32);
    assert.equal(run.parameters.aiBudgetUsd, .2); assert.equal(run.job.aiCostUsd, .07);
    assert.deepEqual(workers, [4, 2]); assert.equal(run.workers.aiWorkers, 1);
    assert.deepEqual(pages, [1, 2, 2]); assert.equal(service.runs().runs.length, 1);
    assert.equal(service.runDetail(first.id)?.attempts.length, 2);
    assert.throws(() => service.resumeRun(first.id), /newer attempt/);
    assert.equal('progress' in service.runs().runs[0]!, false);
    assert.equal('settings' in service.runDetail(first.id)!.attempts[0]!, false);
    const again = service.runAgain(resumed.id); await settled(service);
    assert.equal(store.getRun(again.id)?.rootId, again.id);
    assert.equal(again.aiCostUsd, 0); assert.equal(service.runs().runs.length, 2);
  } finally { await service.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cancelling an active run drains work and preserves a resumable checkpoint', async () => {
  const store = new Store('', true); configure(store);
  let blocked = true, waiting = false;
  const pages: number[] = [];
  const items = Array.from({ length: 20 }, (_, i) => raw(`cancel-${i}`, 5_000_000));
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'nationwide') return { items: [], total: 0 };
      const page = input.page ?? 1; pages.push(page);
      if (page === 2 && blocked) {
        waiting = true;
        await new Promise((_, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
      }
      return { items: page === 1 ? items : [], total: 21 };
    }, async detail(item) { return item; },
  });
  try {
    const first = service.refresh('gpu', '', 40); await until(() => waiting);
    assert.throws(() => service.startRun('laptop', '', {}), /already running/);
    service.cancelRun(first.id); await settled(service);
    assert.equal(store.getRun(first.id)?.state, 'cancelled');
    assert.equal(store.getRun(first.id)?.progress.raws?.length, 20);
    assert.equal(service.tryStartDailyRefresh(), null);
    blocked = false;
    const resumed = service.resumeRun(first.id);
    assert.throws(() => service.resumeRun(first.id), /active refresh/);
    await settled(service);
    assert.deepEqual(pages, [1, 2, 2]); assert.equal(store.getRun(resumed.id)?.state, 'complete');
  } finally { await service.shutdown(); store.close(); }
});

test('cancel stops queued automatic recovery and resume respects persisted source cooldown', async () => {
  const store = new Store('', true); configure(store);
  let now = new Date(), blocked = true;
  const future = new Date(now.getTime() + 60_000).toISOString();
  const service = new FlipperService(store, { ...emptySource,
    async search() { if (blocked) throw new SourceDeferredError(future, 'proxy'); return { items: [], total: 0 }; },
  }, undefined, () => now);
  try {
    const first = service.refresh('gpu', ''); await settled(service);
    assert.equal(store.getRun(first.id)?.state, 'waiting');
    service.cancelRun(first.id); now = new Date(future);
    assert.equal(service.tryStartDailyRefresh(now), null);
    store.recordSourceCooldown({ status: 429, observedAt: now.toISOString(), until: new Date(now.getTime() + 60_000).toISOString() });
    assert.throws(() => service.resumeRun(first.id), SourceCooldownError);
    now = new Date(now.getTime() + 60_000); blocked = false;
    const resumed = service.resumeRun(first.id); await settled(service);
    assert.equal(store.getRun(resumed.id)?.state, 'complete');
  } finally { await service.shutdown(); store.close(); }
});

test('restart marks unfinished runs interrupted and retains uncertain AI allowance', async () => {
  const store = new Store('', true); configure(store);
  let service = new FlipperService(store, emptySource);
  try {
    const first = service.refresh('gpu', ''); await settled(service);
    const run = store.getRun(first.id)!;
    store.saveRun({ ...run, state: 'assessing', job: { ...run.job, status: 'assessing', completedAt: null, aiCostUsd: .01 } });
    await service.shutdown(); service = new FlipperService(store, emptySource);
    assert.equal(store.getRun(first.id)?.state, 'interrupted');
    assert.equal(store.getRun(first.id)?.job.aiCostUsd, .25);
    assert.equal(service.tryStartDailyRefresh(), null);
    const resumed = service.resumeRun(first.id); await settled(service);
    assert.equal(resumed.aiCostUsd, .25);
    assert.equal(store.getRun(resumed.id)?.parameters.aiBudgetUsd, .25);
  } finally { await service.shutdown(); store.close(); }
});

test('request limit edits apply without resetting charges, including automatic and per-category limits', () => {
  const store = new Store('', true); const now = new Date();
  try {
    for (let i = 0; i < 5; i++) store.reserveSourceRequest('gpu', false, now, 0);
    store.saveSettings({ ...store.getSettings(), requestLimit: 3, automaticRequestLimit: 2, automaticCategoryRequestLimit: 1 });
    assert.equal(store.sourceBudgetStatus(now).used, 5);
    assert.throws(() => store.reserveSourceRequest('gpu', false, now, 0), SourceDeferredError);
    store.saveSettings({ ...store.getSettings(), requestLimit: 10 });
    store.reserveSourceRequest('gpu', true, now, 0);
    assert.throws(() => store.reserveSourceRequest('gpu', true, now, 0), SourceDeferredError);
    store.reserveSourceRequest('laptop', true, now, 0);
    assert.throws(() => store.reserveSourceRequest('desktop', true, now, 0), SourceDeferredError);
    store.reserveSourceRequest('desktop', false, now, 0);
    assert.equal(store.sourceBudgetStatus(now).used, 8);
    assert.throws(() => store.saveSettings({ ...store.getSettings(), automaticRequestLimit: 11 }), /allowance/);
    assert.throws(() => store.saveSettings({ ...store.getSettings(), aiWorkers: 9 }), /1 to 8/);
  } finally { store.close(); }
});

test('startup reconciles durable queue transitions before marking runs interrupted', async () => {
  const store = new Store('', true); configure(store);
  const now = new Date(), future = new Date(now.getTime() + 60_000).toISOString();
  const source = { ...emptySource, async search() { throw new SourceDeferredError(future, 'proxy'); } };
  let service = new FlipperService(store, source, undefined, () => now);
  try {
    const first = service.refresh('gpu', ''); await settled(service);
    const run = store.getRun(first.id)!;
    // The queue was persisted, but the process died before its final journal write.
    store.saveRun({ ...run, state: 'comparing', retryId: undefined, job: { ...run.job, status: 'comparing' } });
    await service.shutdown(); service = new FlipperService(store, source, undefined, () => now);
    assert.equal(store.getRun(first.id)?.state, 'waiting');
    assert.ok(store.getRun(first.id)?.retryId);
    store.claimScanRetry(new Date(future)); // Crash after claim, before launching its new attempt.
    await service.shutdown(); service = new FlipperService(store, source, undefined, () => new Date(future));
    assert.equal(store.getRun(first.id)?.state, 'interrupted');
    assert.equal(store.getRun(first.id)?.job.aiCostUsd, .25);
  } finally { await service.shutdown(); store.close(); }
});

test('legacy schedule and retry snapshots import once with the durable waiting state', async () => {
  const store = new Store('', true); configure(store);
  const now = new Date('2026-10-24T05:00:00Z');
  store.configureDailyScans(true, new Date('2026-10-24T04:00:00Z'));
  const claim = store.claimDailyScan(store.getSettings(), now)!;
  const job = { id: 'legacy-job', category: claim.attempt.category, query: '', status: 'failed' as const,
    message: 'Source cooldown', scanned: 0, target: 100, assessed: 0, benchmarked: 0, totalAvailable: null,
    requestCount: 1, aiCostUsd: .04, error: 'Source cooldown', startedAt: now.toISOString(), completedAt: now.toISOString() };
  store.recordDailyScan(claim.attempt.day, job);
  store.deferScanRetry(job, claim.settings, { until: new Date(now.getTime() + 60_000).toISOString() }, claim.attempt.day);
  const service = new FlipperService(store, emptySource, undefined, () => now);
  try {
    assert.equal(service.runs().runs.length, 1); assert.equal(service.runs().runs[0]?.state, 'waiting');
    assert.equal(service.runs().runs[0]?.job.aiCostUsd, .04);
    assert.ok(store.getRun(job.id)?.retryId);
    service.cancelRun(job.id);
    store.pruneRuns(new Date(now.getTime() + 91 * 86_400_000));
    assert.equal(service.runs().runs.length, 0);
    store.importRunHistory(new Date(now.getTime() + 91 * 86_400_000));
    assert.equal(service.runs().runs.length, 0, 'old schedule failures must not resurrect a resolved family');
  } finally { await service.shutdown(); store.close(); }
});

test('90-day retention removes resolved run families but preserves unresolved history', async () => {
  const store = new Store('', true); configure(store);
  const service = new FlipperService(store, emptySource);
  try {
    const first = service.refresh('gpu', ''); await settled(service);
    const template = store.getRun(first.id)!;
    const old = new Date(Date.now() - 91 * 86_400_000);
    const put = (id: string, state: StoredRun['state'], rootId = id, date = old) => store.saveRun({ ...template, id, rootId, state }, date);
    put('resolved', 'failed'); put('resolved-2', 'complete', 'resolved');
    put('cancelled', 'cancelled'); put('failure', 'failed'); put('waiting', 'waiting'); put('interrupted', 'interrupted');
    put('recent', 'complete', 'recent', new Date());
    store.pruneRuns();
    assert.equal(store.getRun('resolved'), null); assert.equal(store.getRun('resolved-2'), null); assert.equal(store.getRun('cancelled'), null);
    for (const id of ['failure', 'waiting', 'interrupted', 'recent']) assert.ok(store.getRun(id));
  } finally { await service.shutdown(); store.close(); }
});

test('Runs API enforces private access, validation, maintenance, and live limit edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-runs-http-'));
  const store = new Store(directory); configure(store);
  let waiting = false;
  const service = new FlipperService(store, { ...emptySource,
    async search(input) {
      waiting = true;
      await new Promise((_, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
      return { items: [], total: 0 };
    },
  });
  const token = 'fixture-runs-administrator-token-1234567890', origin = 'https://flipper.example.test';
  const server = appServer(service, directory, { adminToken: token, publicOrigin: origin });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'x-flipper-admin-token': token, 'content-type': 'application/json', origin };
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/api/runs', { headers })).status, 404);
    assert.equal((await post('/api/runs', {})).status, 403);
    assert.equal((await fetch(base + '/admin/api/runs')).status, 403);
    assert.equal((await post('/admin/api/runs', { category: 'phone' })).status, 400);
    assert.equal((await post('/admin/api/runs', { category: 'gpu', parameters: { scanLimit: 1001 } })).status, 400);
    const started = await post('/admin/api/runs', { category: 'gpu', parameters: { scanLimit: 20 } });
    assert.equal(started.status, 202); const { job } = await started.json(); await until(() => waiting);
    assert.equal((await post('/admin/api/runs', { category: 'laptop' })).status, 409);
    const limits = service.runs().limits;
    assert.equal((await post('/admin/api/runs/limits', { ...limits, marketplaceWorkers: 0 })).status, 400);
    assert.equal((await post('/admin/api/runs/limits', { ...limits, requestLimit: 400 })).status, 400);
    assert.equal((await post('/admin/api/runs/limits', { ...limits, marketplaceWorkers: 2, requestLimit: 800 })).status, 200);
    assert.equal(service.runs().limits.marketplaceWorkers, 2);
    assert.equal(service.runDetail(job.id)?.run.workers.marketplaceWorkers, 4);
    const publicBootstrap = await (await fetch(base + '/api/bootstrap')).json();
    assert.equal('marketplaceWorkers' in publicBootstrap.settings, false);
    const detail = await (await fetch(base + `/admin/api/runs/${job.id}`, { headers })).json();
    assert.equal('progress' in detail.run, false); assert.equal('settings' in detail.run, false);
    writeFileSync(join(directory, '.deployment-maintenance'), 'fixture');
    assert.equal((await post('/admin/api/runs/limits', limits)).status, 503);
    assert.equal((await post(`/admin/api/runs/${job.id}/cancel`, {})).status, 202);
    await settled(service); assert.equal(store.getRun(job.id)?.state, 'cancelled');
    assert.equal((await fetch(base + '/admin/api/runs?offset=-1', { headers })).status, 400);
    const foreign = await fetch(base + `/admin/api/runs/${job.id}/resume`, { method: 'POST', headers: { ...headers, origin: 'https://foreign.test' }, body: '{}' });
    assert.equal(foreign.status, 403);
  } finally {
    await service.shutdown(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
