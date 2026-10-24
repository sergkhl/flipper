import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { SourceDeferredError } from '../server/source-policy.ts';
import { assessWithRules } from '../server/hardware.ts';
import type { RefreshJob } from '../shared/types.ts';
import { raw } from './helpers.ts';

async function settled(service: FlipperService, id: string): Promise<RefreshJob> {
  const until = Date.now() + 3_000;
  while (service.activeJob() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(service.activeJob(), null); return service.getJob(id)!;
}
function configure(store: Store) { store.saveSettings({ ...store.getSettings(), aiEnabled: false, scanLimit: 100, benchmarkLimit: 60 }); }

test('a quota pause keeps collection progress across restart and resumes the unfinished page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-queue-'));
  let store = new Store(directory), now = new Date(), blocked = true;
  configure(store);
  const resumeAt = new Date(now.getTime() + 60_000).toISOString(), pages: number[] = [];
  const items = Array.from({ length: 25 }, (_, i) => raw(`queued-local-${i}`, 5_000_000));
  const source = { async search(input: { location: string; page?: number }) {
    if (input.location === 'nationwide') return { items: Array.from({ length: 5 }, (_, i) => raw(`queued-peer-${i}`, 6_000_000)), total: 5 };
    const page = input.page ?? 1; pages.push(page);
    if (page === 2 && blocked) throw new SourceDeferredError(resumeAt, 'request_budget');
    return { items: items.slice((page - 1) * 20, page * 20), total: 25 };
  }, async detail(item: ReturnType<typeof raw>) { return item; } };
  let service = new FlipperService(store, source, undefined, () => now);
  try {
    store.putListing(raw('previous-collection', 4_000_000), undefined, true); store.setCollection('gpu', '', ['previous-collection']);
    const first = service.refresh('gpu', '', 40);
    assert.equal((await settled(service, first.id)).status, 'waiting');
    assert.equal(store.scanRetries()[0].progress?.raws?.length, 20);
    assert.equal(service.listings('gpu', new URLSearchParams()).items[0].id, 'previous-collection');
    assert.equal(service.refresh('gpu', '').id, first.id, 'an overlapping request shares the pending work');
    assert.equal(store.scanRetries().length, 1);
    await service.shutdown(); store.close(); store = new Store(directory);
    now = new Date(resumeAt); blocked = false; service = new FlipperService(store, source, undefined, () => now);
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.deepEqual(pages, [1, 2, 2]); assert.equal(resumed.scanned, 25);
    assert.equal(service.listings('gpu', new URLSearchParams()).total, 25);
    assert.equal(store.scanRetries()[0].status, 'complete');
  } finally { await service.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('focused comparisons resume partially detailed national pools without rereading completed work', async () => {
  const store = new Store('', true); configure(store);
  let now = new Date(), blocked = true, searches = 0;
  const resumeAt = new Date(now.getTime() + 60_000).toISOString(), details: string[] = [];
  const candidate = raw('focused-queued', 4_000_000);
  store.putListing(candidate, assessWithRules(candidate), true);
  const peers = Array.from({ length: 10 }, (_, i) => raw(`focused-peer-${i}`, 6_000_000, { description: '' }));
  const service = new FlipperService(store, {
    async search() { searches++; return { items: peers, total: 10 }; },
    async detail(item) {
      details.push(item.id);
      if (item.id === peers[2]!.id && blocked) throw new SourceDeferredError(resumeAt, 'proxy');
      return { ...item, description: 'Card hoạt động tốt, chưa sửa' };
    },
  }, undefined, () => now);
  try {
    const first = service.analyze(candidate.id); assert.equal((await settled(service, first.id)).status, 'waiting');
    assert.equal(service.analyze(candidate.id).id, first.id);
    assert.equal(store.scanRetries()[0].listingId, candidate.id);
    assert.equal('progress' in service.scheduleStatus().retries[0]!, false, 'private HTTP status excludes raw checkpoints too');
    blocked = false; now = new Date(resumeAt);
    const resumed = service.tryStartDailyRefresh(now)!; assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.equal(searches, 1); assert.equal(details.filter(id => id === candidate.id).length, 1);
    assert.equal(details.filter(id => id === peers[0]!.id).length, 1);
    assert.equal(details.filter(id => id === peers[2]!.id).length, 2, 'only the failed detail is repeated');
    assert.equal(service.detail(candidate.id)?.valuation.reference?.sampleCount, 5);
  } finally { await service.shutdown(); store.close(); }
});

test('queued category work leaves focused manual analysis independently available', async () => {
  const store = new Store('', true); configure(store);
  const candidate = raw('manual-reserve-target', 4_000_000), resumeAt = new Date(Date.now() + 60_000).toISOString();
  store.putListing(candidate, assessWithRules(candidate), true);
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') throw new SourceDeferredError(resumeAt, 'request_budget');
      return { items: Array.from({ length: 5 }, (_, i) => raw(`manual-reserve-peer-${i}`, 6_000_000)), total: 5 };
    }, async detail(item) { return item; },
  });
  try {
    const full = service.refresh('gpu', ''); assert.equal((await settled(service, full.id)).status, 'waiting');
    const focused = service.analyze(candidate.id); assert.equal((await settled(service, focused.id)).status, 'complete');
    assert.equal(service.detail(candidate.id)?.valuation.reference?.sampleCount, 5);
    assert.equal(store.pendingScanRetry('gpu', '')?.status, 'waiting');
  } finally { await service.shutdown(); store.close(); }
});

test('national pagination continues through duplicate sellers until independent offers pass the evidence minimum', async () => {
  const store = new Store('', true); configure(store);
  const candidate = raw('dedup-local', 4_000_000); store.putListing(candidate, assessWithRules(candidate), true);
  const peers = [...Array.from({ length: 20 }, (_, i) => raw(`duplicate-${i}`, 6_000_000, { sellerId: `business-${i % 4}` })),
    ...Array.from({ length: 5 }, (_, i) => raw(`independent-${i}`, 6_000_000))];
  const pages: number[] = [];
  const service = new FlipperService(store, {
    async search(input) { const page = input.page ?? 1; pages.push(page); return { items: peers.slice((page - 1) * 20, page * 20), total: 25 }; },
    async detail(item) { return item; },
  });
  try {
    const job = service.analyze(candidate.id); assert.equal((await settled(service, job.id)).status, 'complete');
    assert.deepEqual(pages, [1, 2]); assert.equal(service.detail(candidate.id)?.valuation.reference?.sampleCount, 9);
  } finally { await service.shutdown(); store.close(); }
});

test('a later configuration extends the shared national pool instead of repeating its first page', async () => {
  const store = new Store('', true); configure(store);
  const pc = (id: string, ram: number) => raw(id, 10_000_000, { category: 'desktop', title: `PC i5-12400 RAM${ram}GB DDR4 RTX3070 8GB SSD512GB NVMe` });
  const small = pc('pool-16', 16), large = pc('pool-32', 32);
  for (const item of [small, large]) store.putListing(item, assessWithRules(item), true);
  const peers = [...Array.from({ length: 20 }, (_, i) => pc(`pool-peer-16-${i}`, 16)), ...Array.from({ length: 5 }, (_, i) => pc(`pool-peer-32-${i}`, 32))];
  const pages: number[] = [];
  const service = new FlipperService(store, {
    async search(input) {
      assert.equal(input.kind, 'desktop'); const page = input.page ?? 1; pages.push(page);
      return { items: peers.slice((page - 1) * 20, page * 20), total: 25 };
    }, async detail(item) { return item; },
  });
  try {
    assert.equal((await settled(service, service.analyze(small.id).id)).status, 'complete');
    assert.deepEqual(pages, [1]);
    assert.equal((await settled(service, service.analyze(large.id).id)).status, 'complete');
    assert.deepEqual(pages, [1, 2]); assert.equal(service.detail(large.id)?.valuation.reference?.sampleCount, 5);
  } finally { await service.shutdown(); store.close(); }
});

test('a waiting automatic scan merges the latest settings with daily work while preserving prior AI spending', async () => {
  const store = new Store('', true); configure(store);
  let now = new Date('2026-10-24T05:00:00Z'), blocked = true;
  const resumeAt = '2026-10-25T05:00:00.000Z', calls: string[] = [];
  store.configureDailyScans(true, new Date('2026-10-24T04:00:00Z'));
  const service = new FlipperService(store, {
    async search(input) { calls.push(`${input.kind}:${input.page ?? 1}`); if (blocked) throw new SourceDeferredError(resumeAt, 'request_budget'); return { items: [], total: 0 }; },
    async detail(item) { return item; },
  }, undefined, () => now);
  try {
    const first = service.tryStartDailyRefresh(now)!; assert.equal(first.category, 'laptop');
    assert.equal((await settled(service, first.id)).status, 'waiting');
    // A later daily start must not create another pending job for this category.
    now = new Date('2026-10-25T04:59:00Z');
    assert.equal(store.claimDailyScan(store.getSettings(), new Date('2026-10-24T05:00:00Z'))?.attempt.category, 'desktop');
    const waiting = store.scanRetries()[0]!;
    store.deferScanRetry({ ...waiting.job, aiCostUsd: .04 }, store.getSettings(), { until: resumeAt }, waiting.dailyDay, waiting.id,
      { automatic: true, progress: waiting.progress });
    store.saveSettings({ ...store.getSettings(), scanLimit: 80, minRamGb: 32, aiBudgetUsd: .1 });
    now = new Date(resumeAt); blocked = false;
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal(resumed.target, 80); assert.equal(resumed.aiCostUsd, .04);
    assert.equal((await settled(service, resumed.id)).status, 'complete');
    const latest = store.dailyScanAttempts('2026-10-25')[0]!;
    assert.equal(latest.category, 'laptop'); assert.equal(latest.job?.id, resumed.id);
    assert.equal(store.scanRetries().filter(item => item.category === 'laptop').length, 1);
    assert.equal(store.scanRetries()[0]!.spentUsd, .04);
    assert.equal(calls.filter(value => value.startsWith('laptop:')).length, 2);
  } finally { await service.shutdown(); store.close(); }
});

test('automatic desktop work avoids partial component baseline searches while manual analysis can request them', async () => {
  const store = new Store('', true); configure(store);
  const candidate = raw('automatic-desktop', 8_000_000, { category: 'desktop', title: 'PC i5-12400 RAM32GB DDR4 RTX3070 8GB SSD512GB NVMe' });
  const kinds: string[] = [];
  store.configureDailyScans(true, new Date('2026-10-24T04:00:00Z'));
  store.claimDailyScan(store.getSettings(), new Date('2026-10-24T05:00:00Z')); // laptop
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') return { items: [candidate], total: 1 };
      kinds.push(input.kind); return { items: [], total: 0 };
    }, async detail(item) { return item; },
  });
  try {
    const automatic = service.tryStartDailyRefresh(new Date('2026-10-24T05:00:00Z'))!;
    assert.equal(automatic.category, 'desktop'); assert.equal((await settled(service, automatic.id)).status, 'complete');
    assert.deepEqual(kinds, ['desktop']);
    assert.equal((await settled(service, service.analyze(candidate.id).id)).status, 'complete');
    assert.ok(kinds.includes('gpu')); assert.ok(kinds.includes('cpu'));
  } finally { await service.shutdown(); store.close(); }
});

test('automatic desktop adjustments stop at two reusable part queries per configuration', async () => {
  const store = new Store('', true); configure(store);
  const pc = (id: string, gpu: string, ssd: number) => raw(id, 8_000_000, { category: 'desktop',
    title: `PC i5-12400 RAM32GB DDR4 ${gpu} SSD${ssd}GB NVMe` });
  const candidate = pc('two-parts-local', 'RTX3070 8GB', 512);
  const peers = Array.from({ length: 5 }, (_, i) => pc(`two-parts-peer-${i}`, 'RTX3060 12GB', 256));
  const parts: string[] = [];
  store.configureDailyScans(true, new Date('2026-10-24T04:00:00Z'));
  store.claimDailyScan(store.getSettings(), new Date('2026-10-24T05:00:00Z'));
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') return { items: [candidate], total: 1 };
      if (input.kind === 'desktop') return { items: peers, total: peers.length };
      parts.push(`${input.kind}:${input.query}`); return { items: [], total: 0 };
    }, async detail(item) { return item; },
  });
  try {
    const automatic = service.tryStartDailyRefresh(new Date('2026-10-24T05:00:00Z'))!;
    assert.equal((await settled(service, automatic.id)).status, 'complete');
    assert.equal(parts.length, 2); assert.ok(parts.every(query => query.startsWith('gpu:')));
    assert.equal((await settled(service, service.analyze(candidate.id).id)).status, 'complete');
    assert.ok(parts.some(query => query.startsWith('ssd:')), 'manual analysis can retrieve the remaining required adjustments');
  } finally { await service.shutdown(); store.close(); }
});

test('expired local checkpoints trigger a new source observation instead of renewing stored timestamps', async () => {
  const store = new Store('', true); configure(store);
  const stale = raw('expired-checkpoint', 5_000_000, { observedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
  store.putListing(stale, assessWithRules(stale), true);
  const now = new Date(), job: RefreshJob = { id: 'expired-job', category: 'gpu', query: '', status: 'waiting', message: 'Queued',
    scanned: 1, target: 20, assessed: 1, benchmarked: 0, totalAvailable: 1, requestCount: 1,
    aiCostUsd: .02, error: null, startedAt: stale.observedAt, completedAt: stale.observedAt };
  store.deferScanRetry(job, store.getSettings(), { until: now.toISOString() }, null, undefined, {
    automatic: false, progress: { ids: [stale.id], raws: [stale], nextPage: 2, collected: true,
      assessedIds: [stale.id], comparedIds: [], initialDetails: 1 },
  });
  const pages: number[] = [];
  const service = new FlipperService(store, {
    async search(input) { assert.equal(input.location, 'danang'); pages.push(input.page ?? 1); return { items: [], total: 0 }; },
    async detail() { throw new Error('an expired absent listing cannot supply comparison evidence'); },
  }, undefined, () => now);
  try {
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal((await settled(service, resumed.id)).status, 'complete'); assert.deepEqual(pages, [1]);
    assert.equal(resumed.aiCostUsd, .02); assert.equal(store.getListing(stale.id)?.raw.observedAt, stale.observedAt);
    assert.equal(service.listings('gpu', new URLSearchParams()).total, 0);
  } finally { await service.shutdown(); store.close(); }
});

test('resuming a scan retains its twelve-configuration comparison bound', async () => {
  const store = new Store('', true); configure(store);
  let now = new Date(), blocked = true;
  const until = new Date(now.getTime() + 60_000).toISOString(), successful: string[] = [];
  const models = ['GTX1060 6GB', 'GTX1070 8GB', 'GTX1080 8GB', 'RTX2060 6GB', 'RTX2070 8GB', 'RTX2080 8GB',
    'RTX3060 12GB', 'RTX3070 8GB', 'RTX3080 10GB', 'RTX3090 24GB', 'RTX4060 8GB', 'RTX4070 12GB', 'RTX4080 16GB'];
  const items = models.map((title, i) => raw(`bounded-config-${i}`, 5_000_000 + i * 100_000, { title }));
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') return { items, total: items.length };
      if (successful.length === 4 && blocked) throw new SourceDeferredError(until, 'request_budget');
      successful.push(input.query ?? ''); return { items: [], total: 0 };
    }, async detail(item) { return item; },
  }, undefined, () => now);
  try {
    const first = service.refresh('gpu', '', 20); assert.equal((await settled(service, first.id)).status, 'waiting');
    assert.equal(successful.length, 4);
    now = new Date(until); blocked = false;
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.equal(successful.length, 12); assert.equal(new Set(successful).size, 12);
    assert.equal(resumed.benchmarked, 12);
  } finally { await service.shutdown(); store.close(); }
});

test('raising the automatic collection size extends fresh queued work with the latest setting', async () => {
  const store = new Store('', true); configure(store); store.saveSettings({ ...store.getSettings(), scanLimit: 20 });
  let now = new Date('2026-10-24T05:00:00Z'), blocked = true;
  const until = '2026-10-24T06:00:00.000Z', pages: number[] = [];
  const items = Array.from({ length: 25 }, (_, i) => raw(`expanded-automatic-${i}`, 5_000_000));
  store.configureDailyScans(true, new Date('2026-10-24T04:00:00Z'));
  // Move the daily category to GPU; those unrelated claims make no source requests.
  store.claimDailyScan(store.getSettings(), now); store.claimDailyScan(store.getSettings(), now);
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'nationwide') {
        if (blocked) throw new SourceDeferredError(until, 'request_budget');
        return { items: Array.from({ length: 5 }, (_, i) => raw(`expanded-peer-${i}`, 6_000_000)), total: 5 };
      }
      const page = input.page ?? 1; pages.push(page); return { items: items.slice((page - 1) * 20, page * 20), total: 25 };
    }, async detail(item) { return item; },
  }, undefined, () => now);
  try {
    const first = service.tryStartDailyRefresh(now)!; assert.equal(first.category, 'gpu');
    assert.equal((await settled(service, first.id)).status, 'waiting');
    store.saveSettings({ ...store.getSettings(), scanLimit: 40 }); now = new Date(until); blocked = false;
    const resumed = service.tryStartDailyRefresh(now)!;
    assert.equal(resumed.target, 40); assert.equal((await settled(service, resumed.id)).status, 'complete');
    assert.equal(resumed.scanned, 25); assert.deepEqual(pages, [1, 2]);
  } finally { await service.shutdown(); store.close(); }
});
