import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { DailyScanner, nextVietnamNoon, vietnamDay } from '../server/scheduler.ts';
import { LiteLLMClient, RefreshBudget } from '../server/litellm.ts';
import { appServer } from '../server/http.ts';
import type { ChototClient } from '../server/chotot.ts';
import type { RawListing } from '../shared/types.ts';
import { DECIDER_MODEL } from '../server/config.ts';
type SearchInput = Parameters<ChototClient['search']>[0];
import { raw, assessment } from './helpers.ts';

const before = new Date('2026-10-20T04:59:00Z'), noon = new Date('2026-10-20T05:00:00Z');
async function complete(service: FlipperService) {
  const deadline = Date.now() + 3_000;
  while (service.activeJob() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(service.activeJob(), null);
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-scheduler-')), store = new Store(directory);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false, scanLimit: 20 });
  const source: Pick<ChototClient, 'search' | 'detail'> = { async search(_input) { return { items: [], total: 0 }; }, async detail(item: ReturnType<typeof raw>) { return item; } };
  const service = new FlipperService(store, source), scanner = new DailyScanner(service);
  t.after(async () => { scanner.stop(); await service.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, scanner, source };
}

test('new installs stay disabled and first enable waits for the strictly next Vietnam noon', t => {
  const f = fixture(t);
  assert.equal(f.service.scheduleStatus(before).enabled, false); assert.equal(f.scanner.tick(noon), null);
  assert.equal(f.store.latestDailyScanDay(), null);
  assert.equal(nextVietnamNoon(before), '2026-10-20T05:00:00.000Z');
  assert.equal(nextVietnamNoon(noon), '2026-10-21T05:00:00.000Z');
  assert.equal(vietnamDay(new Date('2026-10-20T18:00:00Z')), '2026-10-21');
  f.service.configureDailyScans(true, noon);
  assert.equal(f.service.scheduleStatus(noon).nextRunAt, '2026-10-21T05:00:00.000Z');
  assert.equal(f.scanner.tick(new Date('2026-10-20T06:00:00Z')), null);
  f.service.configureDailyScans(true, new Date('2026-10-20T08:00:00Z'));
  assert.equal(f.store.dailyScanControl().firstDueAt, '2026-10-21T05:00:00.000Z', 'idempotent enable does not postpone the run');
});

test('noon runs all three full refreshes sequentially once, even with competing ticks', async t => {
  const f = fixture(t), calls: unknown[] = [];
  t.mock.method(f.source, 'search', async (input: SearchInput) => { calls.push(input); return { items: [], total: 0 }; });
  f.service.configureDailyScans(true, before);
  assert.equal(f.scanner.tick(before), null);
  for (const category of ['laptop', 'desktop', 'gpu']) {
    const job = f.scanner.tick(noon)!;
    assert.equal(job.category, category); assert.equal(job.query, ''); assert.equal(job.target, 20);
    assert.equal(f.scanner.tick(noon), null, 'overlapping tick cannot claim another category');
    assert.throws(() => f.service.refresh('gpu', ''), /already running/);
    await complete(f.service);
    if (category === 'laptop') assert.equal(f.service.scheduleStatus(noon).nextRunAt, noon.toISOString(), 'unstarted categories are due today');
  }
  assert.equal(f.scanner.tick(noon), null);
  assert.deepEqual(f.store.dailyScanAttempts('2026-10-20').map(a => [a.category, a.status, a.budgetUsd]),
    [['laptop', 'complete', .5], ['desktop', 'complete', .25], ['gpu', 'complete', .25]]);
  assert.equal(calls.length, 3);
  assert.equal(f.service.scheduleStatus(noon).nextRunAt, '2026-10-21T05:00:00.000Z');
});

test('maintenance, manual work, and an AI probe defer admission without consuming an attempt', async t => {
  const f = fixture(t); f.service.configureDailyScans(true, before);
  const marker = join(f.directory, '.deployment-maintenance'); writeFileSync(marker, 'test');
  assert.equal(f.scanner.tick(noon), null); assert.equal(f.service.scheduleStatus(noon).state, 'maintenance');
  rmSync(marker);
  let release!: () => void;
  t.mock.method(f.source, 'search', async () => await new Promise(resolve => { release = () => resolve({ items: [], total: 0 }); }));
  f.service.refresh('gpu', 'manual'); assert.equal(f.scanner.tick(noon), null);
  assert.equal(f.service.scheduleStatus(noon).state, 'busy'); assert.deepEqual(f.store.dailyScanAttempts('2026-10-20'), []);
  release(); await complete(f.service);
  t.mock.method(f.store, 'getKey', () => 'fixture-only-key');
  t.mock.method(LiteLLMClient.prototype, 'test', async () => await new Promise(resolve => { release = () => resolve([]); }));
  const probe = f.service.testAI(); assert.equal(f.scanner.tick(noon), null);
  assert.deepEqual(f.store.dailyScanAttempts('2026-10-20'), []); release(); await probe;
});

test('pause lets the active category finish and re-enabling waits until the next noon', async t => {
  const f = fixture(t); f.service.configureDailyScans(true, before);
  const job = f.scanner.tick(noon)!;
  f.service.configureDailyScans(false, noon);
  assert.equal(f.service.activeJob()?.id, job.id);
  await complete(f.service); assert.equal(f.scanner.tick(noon), null);
  f.service.configureDailyScans(true, new Date(noon.getTime() + 60_000));
  assert.equal(f.scanner.tick(new Date('2026-10-20T12:00:00Z')), null);
  assert.equal(f.store.dailyScanAttempts('2026-10-20').length, 1);
});

test('a failed category preserves retained evidence and does not prevent later categories', async t => {
  const f = fixture(t); f.service.configureDailyScans(true, before);
  const retained = raw('retained', 1_000_000, { category: 'laptop' });
  f.store.putListing(retained, assessment(), true); f.store.setState(retained.id, { saved: true });
  t.mock.method(f.source, 'search', async (input: SearchInput) => {
    if (input.kind === 'laptop') throw new Error('Fixture marketplace failure');
    return { items: [], total: 0 };
  });
  for (let i = 0; i < 3; i++) { assert.ok(f.scanner.tick(noon)); await complete(f.service); }
  assert.deepEqual(f.store.dailyScanAttempts('2026-10-20').map(a => a.status), ['failed', 'complete', 'complete']);
  assert.equal(f.store.getListing(retained.id)?.state.saved, true); assert.equal(f.scanner.tick(noon), null);
});

test('restart retains the full allowance for a claim with no completion and resumes only unstarted categories', async t => {
  const f = fixture(t); f.service.configureDailyScans(true, before);
  const claim = f.store.claimDailyScan(f.store.getSettings(), noon)!;
  assert.equal(claim.attempt.category, 'laptop'); assert.equal(claim.attempt.job, null);
  // Reopening real SQLite is the crash boundary; no provider receipt is required.
  const reopened = new Store(f.directory);
  try {
    reopened.interruptDailyScans(new Date('2026-10-20T06:00:00Z'));
    assert.equal(reopened.dailyScanControl().enabled, true);
    assert.equal(reopened.dailyScanAttempts('2026-10-20')[0].status, 'interrupted');
    assert.equal(reopened.dailyScanAttempts('2026-10-20')[0].budgetUsd, .5);
  } finally { reopened.close(); }
  assert.equal(f.scanner.tick(noon)?.category, 'desktop'); await complete(f.service);
  assert.equal(f.scanner.tick(noon)?.category, 'gpu'); await complete(f.service);
  assert.equal(f.scanner.tick(noon), null);
});

test('downtime catches up only the current Vietnam day and midnight never starts yesterday\'s remaining categories', async t => {
  const f = fixture(t); f.service.configureDailyScans(true, before);
  const late = new Date('2026-10-22T16:59:00Z');
  assert.equal(f.scanner.tick(late)?.category, 'laptop'); await complete(f.service);
  assert.deepEqual(f.store.dailyScanAttempts('2026-10-20'), []);
  assert.deepEqual(f.store.dailyScanAttempts('2026-10-21'), []);
  assert.equal(f.scanner.tick(new Date('2026-10-22T17:00:00Z')), null);
  assert.equal(f.store.dailyScanAttempts('2026-10-22').length, 1);
  assert.equal(f.scanner.tick(new Date('2026-10-23T05:00:00Z'))?.category, 'laptop'); await complete(f.service);
});

test('scheduled budgets cap larger defaults per category and overreported cost reduces later admission', async t => {
  const f = fixture(t); f.store.saveSettings({ ...f.store.getSettings(), aiBudgetUsd: 3 });
  f.service.configureDailyScans(true, before);
  const first = f.store.claimDailyScan(f.store.getSettings(), noon)!;
  assert.equal(first.attempt.category, 'laptop');
  assert.equal(first.settings.aiBudgetUsd, .5); assert.equal(f.store.getSettings().aiBudgetUsd, 3);
  const job = { id: 'fixture', category: 'laptop' as const, query: '', status: 'complete' as const,
    message: 'Fixture completion', scanned: 0, target: 20, assessed: 0, benchmarked: 0, totalAvailable: 0,
    requestCount: 0, aiCostUsd: .9, error: null, startedAt: noon.toISOString(), completedAt: noon.toISOString() };
  f.store.recordDailyScan('2026-10-20', job);
  const second = f.store.claimDailyScan(f.store.getSettings(), noon)!;
  assert.ok(Math.abs(second.settings.aiBudgetUsd - .1) < 1e-10);
  assert.equal(f.store.claimDailyScan(f.store.getSettings(), noon)!.settings.aiBudgetUsd, 0);
  assert.equal(f.store.claimDailyScan(f.store.getSettings(), noon), null);
});

test('without overruns the daily total covers each category ceiling', async t => {
  const f = fixture(t); f.store.saveSettings({ ...f.store.getSettings(), aiBudgetUsd: 3 });
  f.service.configureDailyScans(true, before);
  const budgets = Array.from({ length: 3 }, () => {
    const claim = f.store.claimDailyScan(f.store.getSettings(), noon)!;
    return [claim.attempt.category, claim.settings.aiBudgetUsd];
  });
  assert.deepEqual(budgets, [['laptop', .5], ['desktop', .25], ['gpu', .25]]);
  assert.deepEqual(f.service.scheduleStatus(noon).perCategoryBudgetUsd, { laptop: .5, desktop: .25, gpu: .25 });
});

test('the actual scheduled AI client gets the capped budget while manual assessment gets its configured budget', async t => {
  const f = fixture(t), limits: number[] = [];
  f.store.saveSettings({ ...f.store.getSettings(), aiEnabled: true, aiBudgetUsd: 2 });
  t.mock.method(f.store, 'getKey', () => 'fixture-only-key');
  t.mock.method(f.source, 'search', async (input: SearchInput) => ({ items: [raw('budget-item-' + input.kind, 4_000_000)], total: 1 }));
  t.mock.method(LiteLLMClient.prototype, 'assess', async (_raw: RawListing, budget: RefreshBudget) => {
    limits.push(budget.limit); throw new Error('Fixture provider failure');
  });
  f.service.configureDailyScans(true, before); f.scanner.tick(noon); await complete(f.service);
  assert.ok(limits.length > 0); assert.deepEqual([...new Set(limits)], [.5]);
  assert.match(f.store.dailyScanAttempts('2026-10-20')[0].aiIssue ?? '', /Fixture provider failure/);
  limits.length = 0; f.service.refresh('gpu', 'manual'); await complete(f.service);
  assert.ok(limits.length > 0); assert.deepEqual([...new Set(limits)], [2]);
});

test('schedule control and history are private, validated, and pause remains available during a job', async t => {
  const f = fixture(t), token = 'fixture-admin-token-12345678901234567890', origin = 'https://flipper.example.test';
  const server = appServer(f.service, undefined, { adminToken: token, publicOrigin: origin });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'content-type': 'application/json', 'x-flipper-admin-token': token, origin };
  assert.equal((await fetch(base + '/api/schedule')).status, 404);
  assert.equal((await fetch(base + '/admin/api/schedule')).status, 403);
  assert.equal((await fetch(base + '/api/schedule', { method: 'POST', headers, body: '{"enabled":true}' })).status, 403);
  assert.equal('schedule' in await (await fetch(base + '/api/bootstrap')).json(), false);
  const privateStatus = await fetch(base + '/admin/api/schedule', { headers }); assert.equal(privateStatus.status, 200);
  assert.equal((await privateStatus.json()).time, '12:00');
  for (const body of ['{"enabled":"true"}', '{"enabled":true,"time":"00:00"}']) {
    assert.equal((await fetch(base + '/admin/api/schedule', { method: 'POST', headers, body })).status, 400);
  }
  f.service.configureDailyScans(true, before); f.scanner.tick(noon);
  const paused = await fetch(base + '/admin/api/schedule', { method: 'POST', headers, body: '{"enabled":false}' });
  assert.equal(paused.status, 200); assert.equal((await paused.json()).enabled, false);
  await complete(f.service);
  writeFileSync(join(f.directory, '.deployment-maintenance'), 'test');
  assert.equal((await fetch(base + '/admin/api/schedule', { method: 'POST', headers, body: '{"enabled":true}' })).status, 503);
});

test('shutdown drains cancelled background work before SQLite closes and prevents new admission', async t => {
  const f = fixture(t); f.service.configureDailyScans(true, before);
  let settled = false;
  t.mock.method(f.source, 'search', async (input: SearchInput) => await new Promise((_resolve, reject) => {
    input.signal!.addEventListener('abort', () => setTimeout(() => { settled = true; reject(new Error('Fixture shutdown')); }, 10), { once: true });
  }));
  f.scanner.tick(noon); await f.service.shutdown();
  assert.equal(settled, true); assert.equal(f.service.activeJob(), null);
  assert.equal(f.store.dailyScanAttempts('2026-10-20')[0].status, 'cancelled');
  assert.equal(f.scanner.tick(noon), null); assert.throws(() => f.service.refresh('gpu', ''), /stopping/);
});

test('a reported overage is durable before completion, so crash recovery reduces the next category allowance', async t => {
  const f = fixture(t); f.store.saveSettings({ ...f.store.getSettings(), aiEnabled: true });
  t.mock.method(f.store, 'getKey', () => 'fixture-only-key');
  t.mock.method(f.source, 'search', async () => ({ items: [raw('overage-before-crash', 4_000_000)], total: 1 }));
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    id: 'fixture-overage', model: DECIDER_MODEL, usage: { input_tokens: 1, output_tokens: 0, cost: .9 },
  }), { headers: { 'content-type': 'application/json' } }));
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const service = new FlipperService(f.store, f.source, { get: () => [], async warm() {
    await new Promise<void>(resolve => { release = resolve; entered(); });
  } });
  try {
    service.configureDailyScans(true, before); service.tryStartDailyRefresh(noon);
    await waiting;
    const recorded = f.store.dailyScanAttempts('2026-10-20')[0];
    assert.equal(recorded.status, 'running'); assert.equal(recorded.job?.aiCostUsd, .9);
    const reopened = new Store(f.directory);
    try {
      reopened.interruptDailyScans(noon);
      const next = reopened.claimDailyScan(reopened.getSettings(), noon)!;
      assert.equal(next.attempt.category, 'desktop'); assert.ok(Math.abs(next.settings.aiBudgetUsd - .1) < 1e-10);
    } finally { reopened.close(); }
  } finally { release?.(); await service.shutdown(); }
});

test('shutdown aborts and drains an AI probe before releasing its busy flag', async t => {
  const f = fixture(t); let aborted = false;
  t.mock.method(f.store, 'getKey', () => 'fixture-only-key');
  t.mock.method(LiteLLMClient.prototype, 'test', async (_budget: RefreshBudget, signal?: AbortSignal) =>
    await new Promise(resolve => signal!.addEventListener('abort', () => setTimeout(() => { aborted = true; resolve([]); }, 10), { once: true })));
  const pending = f.service.testAI(); assert.equal(f.service.deploymentStatus().busy, true);
  await f.service.shutdown(); await pending;
  assert.equal(aborted, true); assert.equal(f.service.deploymentStatus().busy, false);
});
