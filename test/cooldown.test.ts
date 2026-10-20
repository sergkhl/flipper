import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ChototClient } from '../server/chotot.ts';
import { SourceCooldownError, retryAfterMs } from '../server/source-cooldown.ts';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { DailyScanner } from '../server/scheduler.ts';
import { LiteLLMClient, RefreshBudget, BudgetExceededError } from '../server/litellm.ts';
import { appServer } from '../server/http.ts';
import type { Category, RawListing, RefreshJob, SourceCooldown } from '../shared/types.ts';
import { raw, assessment } from './helpers.ts';

const observed = new Date('2026-10-20T06:22:49.481Z');
const due = new Date('2026-10-21T06:21:51.000Z');
const cooldown: SourceCooldown = { observedAt: observed.toISOString(), until: due.toISOString(), status: 429 };
type SearchInput = Parameters<ChototClient['search']>[0];
function failed(category: Category, spentUsd = 0): RefreshJob {
  return { id: `failed-${category}`, category, query: '', status: 'failed', message: 'Source cooldown',
    scanned: category === 'gpu' ? 0 : 200, target: 200, assessed: category === 'gpu' ? 0 : 200,
    benchmarked: 0, totalAvailable: null, requestCount: 1, aiCostUsd: spentUsd, error: 'Source rate limited',
    startedAt: '2026-10-20T05:56:00.000Z', completedAt: '2026-10-20T06:22:00.000Z' };
}
async function complete(service: FlipperService) {
  const deadline = Date.now() + 3000;
  while (service.activeJob() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(service.activeJob(), null);
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-cooldown-')), store = new Store(directory);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false, scanLimit: 200, benchmarkLimit: 200 });
  const source: Pick<ChototClient, 'search' | 'detail'> = {
    async search() { return { items: [], total: 0 }; }, async detail(item) { return item; },
  };
  const service = new FlipperService(store, source, undefined, () => observed), scanner = new DailyScanner(service);
  t.after(async () => { scanner.stop(); await service.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, source, service, scanner };
}

test('Retry-After supports seconds, dates and clock skew without shortening the wait', () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '86341' }), observed), 86_341_000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '0' }), observed), 0);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Tue, 20 Oct 2026 06:24:49 GMT', date: 'Tue, 20 Oct 2026 06:22:49 GMT' }), new Date('2026-10-20T06:23:49Z')), 120_000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'invalid' }), observed), null);
  assert.equal(retryAfterMs(new Headers(), observed), null);
});

test('a persisted cooldown blocks all source requests across client and SQLite restarts', async t => {
  const f = fixture(t); let calls = 0, now = observed;
  const first = new ChototClient({ pauseMs: 0, cooldownStore: f.store, now: () => now, fetch: async () => {
    calls++; return new Response('', { status: 429, headers: { 'retry-after': '86341' } });
  } });
  await assert.rejects(first.search({ kind: 'desktop', location: 'nationwide' }), SourceCooldownError);
  const until = '2026-10-21T06:21:50.481Z';
  assert.equal(f.store.sourceCooldown()?.until, until);
  f.store.recordSourceCooldown({ ...cooldown, until: '2026-10-20T06:30:00.000Z' });
  assert.equal(f.store.sourceCooldown()?.until, until, 'a later shorter response cannot shorten the block');
  const reopened = new Store(f.directory);
  try {
    const client = new ChototClient({ pauseMs: 0, cooldownStore: reopened, now: () => now, fetch: async () => { calls++; return new Response('not parsed'); } });
    await assert.rejects(client.search({ kind: 'gpu', location: 'danang' }), SourceCooldownError);
    await assert.rejects(client.detail(raw('123', 1_000_000, { url: 'https://www.chotot.com/mua-ban-laptop/123.htm' })), SourceCooldownError);
    assert.equal(calls, 1);
    now = new Date(Date.parse(until) + 1);
    await assert.rejects(client.search({ kind: 'gpu', location: 'danang' }), /listing data/);
    assert.equal(calls, 2, 'requests resume only after the recorded deadline');
  } finally { reopened.close(); }
});

test('429 without a usable Retry-After creates a durable one minute cooldown', async t => {
  const f = fixture(t); let calls = 0;
  const client = new ChototClient({ pauseMs: 0, cooldownStore: f.store, now: () => observed, fetch: async () => { calls++; return new Response('', { status: 429 }); } });
  await assert.rejects(client.search({ kind: 'gpu', location: 'danang' }), SourceCooldownError);
  assert.equal(f.store.sourceCooldown()?.until, new Date(observed.getTime() + 60_000).toISOString());
  await assert.rejects(client.search({ kind: 'ram', location: 'nationwide' }), SourceCooldownError);
  assert.equal(calls, 1);
});

test('retry budgets retain prior spend, uncertain charges and an overreported cost', () => {
  const budget = new RefreshBudget(.25, .0185129144);
  assert.ok(Math.abs(budget.remaining - .2314870856) < 1e-12);
  assert.throws(() => budget.reserve(.24), BudgetExceededError);
  budget.reserve(.02).settle();
  assert.ok(Math.abs(budget.spent - .0385129144) < 1e-12);
  const overage = new RefreshBudget(.25, .6);
  assert.equal(overage.spent, .6); assert.equal(overage.remaining, 0);
  assert.throws(() => overage.reserve(.00001), BudgetExceededError);
  assert.throws(() => new RefreshBudget(.25, -1));
  assert.throws(() => new RefreshBudget(.25, NaN));
});

test('desktop and GPU recoveries survive restart, defer noon and share the due daily work once', async t => {
  const f = fixture(t), calls: Category[] = [], originalSettings = f.store.getSettings();
  t.mock.method(f.source, 'search', async (input: SearchInput) => { calls.push(input.kind as Category); return { items: [], total: 0 }; });
  f.service.configureDailyScans(true, new Date('2026-10-20T05:00:00Z'));
  const desktop = f.service.recoverScanRetry(failed('desktop', .0185129144), .25, cooldown);
  f.service.recoverScanRetry(failed('gpu'), .25, cooldown);
  assert.equal(f.service.recoverScanRetry(failed('desktop', .0185129144), .25, cooldown).id, desktop.id);
  assert.equal(f.store.scanRetries().length, 2);
  assert.throws(() => f.service.refresh('gpu', ''), SourceCooldownError);
  const reopened = new Store(f.directory), service = new FlipperService(reopened, f.source, undefined, () => due), scanner = new DailyScanner(service);
  try {
    reopened.interruptDailyScans(observed); reopened.interruptScanRetries(observed);
    assert.equal(scanner.tick(new Date('2026-10-21T05:00:00Z')), null);
    assert.deepEqual(reopened.dailyScanAttempts('2026-10-21'), []);
    assert.equal(service.scheduleStatus(new Date('2026-10-21T05:00:00Z')).state, 'cooldown');
    assert.equal(service.scheduleStatus(observed).nextRunAt, '2026-10-21T05:00:00.000Z');
    assert.equal(scanner.tick(new Date(due.getTime() - 1)), null); assert.deepEqual(calls, []);
    for (const category of ['desktop', 'gpu', 'laptop']) {
      const job = scanner.tick(due)!;
      assert.equal(job.category, category); assert.equal(job.target, 200);
      assert.equal(scanner.tick(due), null, 'a competing tick cannot duplicate an admitted job');
      if (category === 'desktop') assert.equal(job.aiCostUsd, .0185129144);
      await complete(service);
    }
    assert.equal(scanner.tick(due), null);
    assert.deepEqual(calls, ['desktop', 'gpu', 'laptop']);
    assert.deepEqual(reopened.dailyScanAttempts('2026-10-21').map(a => a.status), ['complete', 'complete', 'complete']);
    assert.ok(reopened.dailyScanAttempts('2026-10-21').every(a => a.budgetUsd <= .25));
    assert.equal(reopened.scanRetries().filter(r => r.status === 'complete').length, 2);
    assert.deepEqual(reopened.getSettings(), originalSettings);
  } finally { scanner.stop(); await service.shutdown(); reopened.close(); }
});

test('a repeated cooldown carries costs forward and cannot mint another AI allowance', async t => {
  const f = fixture(t); f.store.saveSettings({ ...f.store.getSettings(), aiEnabled: true });
  t.mock.method(f.store, 'getKey', () => 'fixture-key');
  let phase = 0; const balances: number[] = [];
  t.mock.method(LiteLLMClient.prototype, 'assess', async (_item: RawListing, budget: RefreshBudget) => {
    balances.push(budget.remaining); budget.reserve(.04).settle(.04); return assessment();
  });
  const later = { ...cooldown, until: new Date(due.getTime() + 120_000).toISOString() };
  t.mock.method(f.source, 'search', async (input: SearchInput) => {
    if (input.location === 'nationwide') {
      if (phase === 0) throw new SourceCooldownError(later);
      return { items: [], total: 0 };
    }
    return { items: [raw('retry-budget', 4_000_000 + phase)], total: 1 };
  });
  const seed = f.service.recoverScanRetry(failed('gpu', .18), .25, cooldown);
  f.scanner.tick(due); await complete(f.service);
  const waiting = f.store.scanRetries()[0];
  assert.equal(waiting.id, seed.id); assert.equal(waiting.status, 'waiting');
  assert.ok(Math.abs(waiting.spentUsd - .22) < 1e-12); assert.equal(waiting.dueAt, later.until);
  assert.equal(f.scanner.tick(new Date(due.getTime() + 60_000)), null);
  phase = 1; f.scanner.tick(new Date(later.until)); await complete(f.service);
  const done = f.store.scanRetries()[0];
  assert.equal(done.status, 'complete'); assert.equal(done.attempts, 2);
  assert.ok(Math.abs(done.spentUsd - .22) < 1e-12);
  assert.ok(Math.abs(balances[0] - .07) < 1e-12); assert.ok(Math.abs(balances[1] - .03) < 1e-12);
  assert.equal(f.service.aiStatus().status, 'budget_limited');
});

test('cooldown during a detail fetch stops further requests and captures the manual filters', async t => {
  const f = fixture(t); let details = 0;
  t.mock.method(f.source, 'search', async () => ({ items: [raw('detail-cooldown', 4_000_000)], total: 1 }));
  t.mock.method(f.source, 'detail', async () => { details++; throw new SourceCooldownError(cooldown); });
  f.service.refresh('gpu', '', 20, 0, 0, false); await complete(f.service);
  assert.equal(details, 1); assert.equal(f.store.scanRetries()[0].status, 'waiting');
  const claimed = f.store.claimScanRetry(due)!;
  assert.equal(claimed.settings.minRamGb, 0); assert.equal(claimed.settings.minVramGb, 0); assert.equal(claimed.settings.includeUnknownMemory, false);
  assert.equal(claimed.retry.job.target, 20);
});

test('busy/maintenance gates do not claim retries; interrupted claims retain the remaining allowance', async t => {
  const f = fixture(t); f.service.recoverScanRetry(failed('gpu', .01), .25, cooldown);
  const marker = join(f.directory, '.deployment-maintenance'); writeFileSync(marker, 'fixture');
  assert.equal(f.scanner.tick(due), null); assert.equal(f.store.scanRetries()[0].attempts, 0); rmSync(marker);
  const claim = f.store.claimScanRetry(due)!;
  assert.equal(claim.retry.status, 'running');
  const reopened = new Store(f.directory);
  try {
    reopened.interruptScanRetries(due);
    assert.equal(reopened.scanRetries()[0].status, 'interrupted');
    assert.equal(reopened.scanRetries()[0].spentUsd, .25);
    assert.equal(reopened.claimScanRetry(due), null);
  } finally { reopened.close(); }
});

test('recovery controls are private, blocked manual requests return Retry-After, and cancellation is durable', async t => {
  const f = fixture(t), token = 'fixture-admin-token-12345678901234567890', origin = 'https://flipper.example.test';
  const server = appServer(f.service, undefined, { adminToken: token, publicOrigin: origin });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'content-type': 'application/json', 'x-flipper-admin-token': token, origin };
  const httpCooldown = { ...cooldown, observedAt: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString() };
  const body = JSON.stringify({ job: failed('desktop', .0185129144), budgetUsd: .25, cooldown: httpCooldown });
  assert.equal((await fetch(base + '/api/scan-retries', { method: 'POST', headers, body })).status, 403);
  assert.equal((await fetch(base + '/admin/api/scan-retries', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(base + '/admin/api/scan-retries', { method: 'POST', headers, body: JSON.stringify({ job: failed('desktop'), budgetUsd: .5, cooldown: httpCooldown }) })).status, 400);
  assert.equal(f.store.sourceCooldown(), null); assert.deepEqual(f.store.scanRetries(), []);
  assert.equal((await fetch(base + '/admin/api/scan-retries', { method: 'POST', headers, body: JSON.stringify({ job: failed('desktop'), budgetUsd: .25, cooldown: { ...httpCooldown, until: 'invalid' } }) })).status, 400);
  const response = await fetch(base + '/admin/api/scan-retries', { method: 'POST', headers, body });
  assert.equal(response.status, 201); const { retry } = await response.json();
  const publicBootstrap = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(JSON.stringify(publicBootstrap).includes('failed-desktop'), false); assert.equal('schedule' in publicBootstrap, false);
  const blocked = await fetch(base + '/admin/api/refresh', { method: 'POST', headers, body: '{"category":"gpu"}' });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await blocked.json()).retryAt, httpCooldown.until);
  assert.equal((await fetch(base + `/admin/api/scan-retries/${retry.id}/cancel`, { method: 'POST', headers, body: '{}' })).status, 200);
  await fetch(base + '/admin/api/scan-retries', { method: 'POST', headers, body });
  assert.equal(f.store.scanRetries()[0].status, 'cancelled', 're-import cannot rearm a cancelled request');
});
