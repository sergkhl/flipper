import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { SourceDeferredError } from '../server/source-policy.ts';
import { SourceCooldownError } from '../server/source-cooldown.ts';
import { PartsPriceBook } from '../server/parts-retail.ts';
import { LaptopPriceBook } from '../server/laptop-price-book.ts';
import { ExchangeRates } from '../server/price-cache.ts';
import { LiteLLMClient, type RefreshBudget } from '../server/litellm.ts';
import { assessWithRules, normalize } from '../server/hardware.ts';
import { raw } from './helpers.ts';
import type { RawListing } from '../shared/types.ts';

async function settled(service: FlipperService, id: string) {
  const deadline = Date.now() + 3_000;
  while (service.activeJob() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(service.activeJob(), null);
  return service.getJob(id)!;
}
function configure(store: Store) {
  store.saveSettings({ ...store.getSettings(), aiEnabled: false, marketplaceWorkers: 1, aiWorkers: 1 });
}

for (const reason of ['proxy', 'request_budget', 'cooldown'] as const) test(`${reason} pauses only marketplace work while collected listings and retailers finish, then resumes after restart`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-source-outage-'));
  let store = new Store(directory), now = new Date(), blocked = true, lookups = 0, national = 0;
  configure(store);
  const until = new Date(now.getTime() + 60_000).toISOString(), pages: number[] = [], details: string[] = [];
  const items = Array.from({ length: 25 }, (_, i) => raw(`outage-local-${i}`, 4_000_000 + i));
  const source = { async search(input: { location: string; page?: number }) {
    if (input.location === 'nationwide') { national++; return { items: Array.from({ length: 5 }, (_, i) => raw(`outage-peer-${i}`, 6_000_000)), total: 5 }; }
    const page = input.page ?? 1; pages.push(page);
    if (page === 2 && blocked) throw reason === 'cooldown'
      ? new SourceCooldownError({ until, observedAt: now.toISOString(), status: 429 }) : new SourceDeferredError(until, reason);
    return { items: items.slice((page - 1) * 20, page * 20), total: 25 };
  }, async detail(item: RawListing) { details.push(item.id); return item; } };
  const book = () => new PartsPriceBook(store, { async lookup() {
    lookups++; return { status: 'complete', checkedAt: now.toISOString(), offers: [], errors: [] };
  } }, () => now.getTime());
  let service = new FlipperService(store, source, undefined, () => now, undefined, book());
  try {
    const previous = raw('outage-previous', 3_000_000);
    store.putListing(previous, assessWithRules(previous), true); store.setCollection('gpu', '', [previous.id]);
    const first = await settled(service, service.refresh('gpu', '', 40).id);
    assert.equal(first.status, 'waiting'); assert.equal(first.scanned, 20); assert.equal(first.assessed, 20);
    assert.equal(first.requestCount, 2); assert.equal(lookups, 1); assert.equal(national, 0); assert.deepEqual(details, []);
    assert.ok(items.slice(0, 20).every(item => store.getListing(item.id)?.assessment));
    const saved = store.getRun(first.id)!;
    assert.equal(saved.stage, 'collecting'); assert.equal(saved.progress.collected, false);
    assert.equal(saved.progress.nextPage, 2); assert.equal(saved.progress.initialDetails, 10);
    assert.equal(saved.progress.pendingDetailIds?.length, 10);
    assert.deepEqual(service.publicListings('gpu', new URLSearchParams()).items.map(item => item.id), [previous.id]);
    assert.equal('progress' in service.runDetail(first.id)!.run, false);
    const allowance = store.scanRetries()[0]!.budgetUsd;
    await service.shutdown(); store.close(); store = new Store(directory);
    blocked = false; now = new Date(until);
    service = new FlipperService(store, source, undefined, () => now, undefined, book());
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.deepEqual(pages, [1, 2, 2]); assert.equal(resumed.scanned, 25); assert.equal(resumed.assessed, 25);
    assert.equal(details.length, 10); assert.equal(new Set(details).size, 10); assert.equal(national, 1);
    assert.equal(lookups, 1, 'retailer observations are reused through restart');
    assert.equal(store.getRun(resumed.id)!.progress.pendingDetailIds?.length, 0);
    assert.equal(store.scanRetries()[0]!.budgetUsd, allowance); assert.equal(store.scanRetries()[0]!.status, 'complete');
    assert.equal(service.publicListings('gpu', new URLSearchParams()).total, 25);
  } finally { await service.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a detail pause preserves the selected ten reads and assessments without spending again on unchanged AI evidence', async t => {
  const store = new Store('', true); configure(store);
  store.saveSettings({ ...store.getSettings(), aiEnabled: true, aiBudgetUsd: .05 });
  t.mock.method(store, 'getKey', () => 'fixture-no-network');
  let aiCalls = 0, blocked = true, now = new Date();
  t.mock.method(LiteLLMClient.prototype, 'assess', async (item: RawListing, budget: RefreshBudget) => {
    budget.reserve(.001).settle(.001); aiCalls++;
    return { ...assessWithRules(item), method: 'ai' as const };
  });
  const until = new Date(now.getTime() + 60_000).toISOString(), details: string[] = [];
  const items = Array.from({ length: 12 }, (_, i) => raw(`detail-pause-${i}`, 4_000_000 + i));
  const service = new FlipperService(store, {
    async search(input) { return input.location === 'danang' ? { items, total: 12 }
      : { items: Array.from({ length: 5 }, (_, i) => raw(`detail-peer-${i}`, 6_000_000)), total: 5 }; },
    async detail(item) { details.push(item.id); if (blocked) throw new SourceDeferredError(until, 'proxy'); return item; },
  }, undefined, () => now);
  try {
    const first = await settled(service, service.refresh('gpu', '', 20).id);
    assert.equal(first.status, 'waiting'); assert.equal(first.assessed, 12); assert.equal(aiCalls, 12);
    assert.deepEqual(details, [items[0]!.id]);
    assert.equal(store.getRun(first.id)!.progress.pendingDetailIds?.length, 10);
    assert.ok(Math.abs(first.aiCostUsd - .012) < 1e-12);
    blocked = false; now = new Date(until);
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.equal(details.length, 11); assert.equal(new Set(details).size, 10);
    assert.equal(details.filter(id => id === items[0]!.id).length, 2);
    assert.equal(aiCalls, 13, 'the new national offers share one assessment; local assessments are reused');
    assert.ok(Math.abs(resumed.aiCostUsd - .013) < 1e-12);
    assert.equal(store.scanRetries()[0]!.budgetUsd, .05);
  } finally { await service.shutdown(); store.close(); }
});

test('one missing national pool does not stop later cached comparisons or repeat them on recovery', async () => {
  const store = new Store('', true); configure(store);
  let blocked = true, now = new Date(), lookups = 0;
  const until = new Date(now.getTime() + 60_000).toISOString(), queries: string[] = [];
  const items = [raw('pool-missing', 4_000_000), raw('pool-cached', 4_000_001, { title: 'RTX 3070 8GB' })];
  const cached = Array.from({ length: 5 }, (_, i) => raw(`healthy-cached-${i}`, 6_000_000, { title: items[1]!.title }));
  const p = assessWithRules(items[1]!).profile;
  store.putPool(`incremental-v3:gpu:${normalize(`${p.gpu} ${p.vramGb}gb`)}:60`, cached);
  const prices = new PartsPriceBook(store, { async lookup() {
    lookups++; if (lookups === 1) throw new Error('One retailer unavailable');
    return { status: 'complete', checkedAt: now.toISOString(), offers: [], errors: [] };
  } });
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') return { items, total: 2 };
      queries.push(input.query!); if (blocked) throw new SourceDeferredError(until, 'proxy');
      return { items: Array.from({ length: 5 }, (_, i) => raw(`recovered-peer-${i}`, 6_000_000)), total: 5 };
    }, async detail(item) { return item; },
  }, undefined, () => now, undefined, prices);
  try {
    const first = await settled(service, service.refresh('gpu', '', 20).id);
    assert.equal(first.status, 'waiting'); assert.equal(first.configurationsCompleted, 1); assert.equal(lookups, 2);
    assert.deepEqual(store.getRun(first.id)!.progress.comparedIds, [items[1]!.id]);
    assert.equal(service.detail(items[1]!.id)?.valuation.reference?.sampleCount, 5);
    assert.equal(service.publicListings('gpu', new URLSearchParams()).total, 0);
    blocked = false; now = new Date(until);
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.equal(resumed.configurationsCompleted, 2); assert.equal(resumed.benchmarked, 2);
    assert.equal(queries.length, 2); assert.ok(queries.every(query => query.includes('3060')));
    assert.equal(service.publicListings('gpu', new URLSearchParams()).total, 2);
  } finally { await service.shutdown(); store.close(); }
});

test('focused laptop analysis still reads reachable retailers after its marketplace detail pauses', async () => {
  const store = new Store('', true); configure(store);
  let now = new Date(), blocked = true, lookups = 0, details = 0, national = 0;
  const until = new Date(now.getTime() + 60_000).toISOString();
  const item = raw('focused-laptop-pause', 10_000_000, { category: 'laptop',
    title: 'Acer Nitro V 15 ANV15-51-55CA i5-13420H RTX4050 6GB RAM16GB DDR5 SSD512GB NVMe',
    description: 'Máy cũ hoạt động tốt, chưa sửa. i5-13420H RTX4050 6GB RAM16GB DDR5 SSD512GB NVMe.' });
  store.putListing(item, assessWithRules(item), true);
  const rates = new ExchangeRates(store, async () => { throw new Error('No foreign evidence'); });
  const prices = new LaptopPriceBook(store, { async lookup() {
    lookups++; return { status: 'complete', checkedAt: now.toISOString(), offers: [], errors: [] };
  } }, () => now.getTime(), [], rates);
  const service = new FlipperService(store, {
    async search() { national++; return { items: Array.from({ length: 5 }, (_, i) => ({ ...item, id: `laptop-peer-${i}`, sellerId: `laptop-seller-${i}`, price: 15_000_000 })), total: 5 }; },
    async detail(raw) { details++; if (blocked) throw new SourceDeferredError(until, 'proxy'); return raw; },
  }, undefined, () => now, prices);
  try {
    const first = await settled(service, service.analyze(item.id).id);
    assert.equal(first.status, 'waiting'); assert.equal(first.assessed, 1); assert.equal(lookups, 1); assert.equal(national, 0);
    assert.deepEqual(store.scanRetries()[0]!.progress?.pendingDetailIds, [item.id]);
    assert.equal(store.scanRetries()[0]!.listingId, item.id);
    blocked = false; now = new Date(until);
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.equal(details, 2); assert.equal(national, 1); assert.equal(lookups, 1);
  } finally { await service.shutdown(); store.close(); }
});

test('cancelling independent retailer work after a marketplace pause drains it without creating automatic recovery', async () => {
  const store = new Store('', true); configure(store);
  const until = new Date(Date.now() + 60_000).toISOString(); let entered!: () => void, finished = false;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const prices = new PartsPriceBook(store, { async lookup(_profile, signal) {
    entered();
    try { return await new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); }
    finally { finished = true; }
  } });
  const service = new FlipperService(store, {
    async search() { return { items: [raw('cancel-independent', 4_000_000)], total: 1 }; },
    async detail() { throw new SourceDeferredError(until, 'proxy'); },
  }, undefined, undefined, undefined, prices);
  try {
    const job = service.refresh('gpu', '', 20); await ready;
    service.cancelJob(job.id);
    assert.equal((await settled(service, job.id)).status, 'cancelled');
    assert.equal(finished, true); assert.equal(store.scanRetries().length, 0);
    assert.equal(store.getRun(job.id)!.progress.assessedIds.length, 1);
  } finally { await service.shutdown(); store.close(); }
});

test('in-flight source cooldowns keep precedence over proxy failure and retain the longest deadline', async () => {
  const store = new Store('', true); configure(store);
  store.saveSettings({ ...store.getSettings(), marketplaceWorkers: 3 });
  const now = new Date(), until = new Date(now.getTime() + 180_000).toISOString();
  const items = ['RTX 3060 12GB', 'RTX 3070 8GB', 'RTX 3080 10GB'].map((title, i) => raw(`priority-${i}`, 4_000_000 + i, { title }));
  let sent = 0, release!: () => void;
  const started = new Promise<void>(resolve => { release = resolve; });
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') return { items, total: 3 };
      if (++sent === 3) release(); await started;
      if (input.query!.includes('3060')) throw new SourceDeferredError(new Date(now.getTime() + 60_000).toISOString(), 'proxy');
      await new Promise(resolve => setImmediate(resolve));
      throw new SourceCooldownError({ status: 429, observedAt: now.toISOString(),
        until: input.query!.includes('3070') ? new Date(now.getTime() + 120_000).toISOString() : until });
    }, async detail(item) { return item; },
  }, undefined, () => now);
  try {
    const job = await settled(service, service.refresh('gpu', '', 20).id);
    assert.equal(job.status, 'waiting'); assert.equal(sent, 3);
    const retry = store.scanRetries()[0]!;
    assert.equal(retry.reason, 'cooldown'); assert.equal(retry.dueAt, until); assert.equal(store.sourceCooldown()?.until, until);
    assert.equal(store.getRun(job.id)!.stage, 'comparing');
  } finally { await service.shutdown(); store.close(); }
});
