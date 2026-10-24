import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlipperService } from '../server/service.ts';
import { Store } from '../server/store.ts';
import { LiteLLMClient, type RefreshBudget } from '../server/litellm.ts';
import type { RawListing } from '../shared/types.ts';
import { assessWithRules } from '../server/hardware.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { buildReference } from '../server/pricing.ts';
import { assessment, raw } from './helpers.ts';

async function completed(service: FlipperService, id: string) {
  const deadline = Date.now() + 2_000;
  while (service.activeJob() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.activeJob(), null);
  return service.getJob(id)!;
}

for (const persistent of [false, true]) test(`AI ${persistent ? 'stops after three consecutive failures' : 'continues after isolated failures and resets the failure count'}`, async t => {
  const store = new Store('', true);
  t.after(() => store.close());
  t.mock.method(store, 'getKey', () => 'fixture-key-no-network');
  const locals = Array.from({ length: 6 }, (_, i) => raw(`local-${i}`, 4_000_000 + i * 10_000));
  const peers = Array.from({ length: 5 }, (_, i) => raw(`national-${i}`, 6_000_000));
  const attempted: string[] = [];
  t.mock.method(LiteLLMClient.prototype, 'assess', async (item: RawListing, budget: RefreshBudget) => {
    attempted.push(item.id); budget.reserve(0.001).settle(0.001);
    if (persistent || ['local-0', 'local-2', 'local-4'].includes(item.id)) throw new Error('MiMo returned invalid hardware JSON.');
    return { ...assessWithRules(item), method: 'ai' as const, profile: { ...assessWithRules(item).profile, quantity: null } };
  });
  const service = new FlipperService(store, {
    async search(input) { return { items: input.location === 'danang' ? locals : peers, total: input.location === 'danang' ? locals.length : peers.length }; },
    async detail(item) { return item; },
  });
  const job = await completed(service, service.refresh('gpu', '', 20).id);
  assert.equal(job.status, 'complete'); assert.equal(job.assessed, 6);
  assert.equal(attempted.filter(id => id.startsWith('local-')).length, persistent ? 3 : 6);
  if (persistent) assert.equal(attempted.length, 3);
  else assert.equal(store.getListing('local-5')?.assessment.method, 'ai');
  assert.ok(job.aiCostUsd > 0 && job.aiCostUsd < store.getSettings().aiBudgetUsd);
  assert.equal(service.publicListings('gpu', new URLSearchParams()).stats.opportunities, 6);
});

test('an exhausted AI allowance stops before any provider request while collection and rule-based pricing continue', async t => {
  const store = new Store('', true); t.after(() => store.close());
  store.saveSettings({ ...store.getSettings(), aiBudgetUsd: 0 });
  t.mock.method(store, 'getKey', () => 'fixture-key-no-network');
  const provider = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No provider request is permitted'); });
  const local = raw('budget-local', 4_000_000), peers = Array.from({ length: 5 }, (_, i) => raw(`budget-peer-${i}`, 6_000_000));
  const service = new FlipperService(store, {
    async search(input) { return { items: input.location === 'danang' ? [local] : peers, total: input.location === 'danang' ? 1 : 5 }; },
    async detail(item) { return item; },
  });
  const job = await completed(service, service.refresh('gpu', '', 20).id);
  assert.equal(job.status, 'complete'); assert.equal(job.aiCostUsd, 0);
  assert.equal(provider.mock.callCount(), 0);
  assert.equal(service.aiStatus().status, 'budget_limited');
  assert.equal(service.publicListings('gpu', new URLSearchParams()).stats.opportunities, 1);
});

test('unavailable advertisements retain their observations without consuming detail, AI or comparison capacity', async t => {
  const store = new Store('', true); t.after(() => store.close());
  t.mock.method(store, 'getKey', () => 'fixture-key-no-network');
  const local = raw('available', 4_000_000);
  const deleted = Array.from({ length: 13 }, (_, i) => raw(`deleted-${i}`, i + 1, { attributes: { status: 'deleted' } }));
  const peers = Array.from({ length: 5 }, (_, i) => raw(`available-peer-${i}`, 6_000_000));
  const assessed: string[] = [], detailed: string[] = [];
  t.mock.method(LiteLLMClient.prototype, 'assess', async (item: RawListing) => {
    assessed.push(item.id); return { ...assessWithRules(item), method: 'ai' as const };
  });
  const service = new FlipperService(store, {
    async search(input) { return { items: input.location === 'danang' ? [...deleted, local] : peers,
      total: input.location === 'danang' ? deleted.length + 1 : peers.length }; },
    async detail(item) { detailed.push(item.id); return item; },
  });
  const job = await completed(service, service.refresh('gpu', '', 20).id);
  assert.equal(job.status, 'complete'); assert.equal(job.scanned, 14); assert.equal(job.benchmarked, 1);
  assert.ok(![...assessed, ...detailed].some(id => id.startsWith('deleted-')));
  assert.equal(store.localListings('gpu').length, 14);
  assert.equal(service.publicListings('gpu', new URLSearchParams()).stats.opportunities, 1);
});

test('a comparison failure preserves current membership; a successful refresh moves old observations into dated history', async t => {
  const store = new Store('', true); t.after(() => store.close());
  store.saveSettings({ ...store.getSettings(), aiEnabled: false });
  const previous = raw('previous', 4_000_000), next = raw('next', 4_500_000);
  store.putListing(previous, assessWithRules(previous), true); store.setCollection('gpu', '', [previous.id]);
  store.setState(previous.id, { saved: true });
  let fail = true, empty = false;
  const peers = Array.from({ length: 5 }, (_, i) => raw(`peer-${i}`, 6_000_000));
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') return { items: empty ? [] : [next], total: empty ? 0 : 1 };
      if (fail) throw new Error('Comparison source unavailable');
      return { items: peers, total: peers.length };
    },
    async detail(item) { return item; },
  });
  assert.equal((await completed(service, service.refresh('gpu', '', 20).id)).status, 'failed');
  assert.deepEqual(service.publicListings('gpu', new URLSearchParams()).items.map(i => i.id), [previous.id]);
  fail = false;
  assert.equal((await completed(service, service.refresh('gpu', '', 20).id)).status, 'complete');
  assert.deepEqual(service.publicListings('gpu', new URLSearchParams()).items.map(i => i.id), [next.id]);
  const history = service.publicListings('gpu', new URLSearchParams('view=history'));
  assert.deepEqual(history.items.map(i => i.id), [previous.id]);
  assert.equal(history.items[0]?.observedAt, previous.observedAt);
  assert.equal(service.listings('gpu', new URLSearchParams('view=saved')).items[0]?.id, previous.id);
  empty = true;
  assert.equal((await completed(service, service.refresh('gpu', '', 20).id)).status, 'complete');
  assert.equal(service.publicListings('gpu', new URLSearchParams()).total, 0);
  assert.equal(service.publicBootstrap().counts.gpu, 0);
  assert.equal(service.publicListings('gpu', new URLSearchParams('view=history')).total, 2);
});

test('indicative comparisons and partial component finds have separate views and never inflate market finds', t => {
  const store = new Store('', true); t.after(() => store.close());
  const service = new FlipperService(store);
  const item = raw('indicative', 4_000_000), a = enrichComputerAssessment(item, assessWithRules(item));
  store.putListing(item, a, true); store.setCollection('gpu', '', [item.id]);
  const peers = Array.from({ length: 3 }, (_, i) => ({ raw: raw(`indicative-peer-${i}`, 6_000_000), assessment: a }));
  store.setReference(item.id, buildReference(item, a, peers, store.getSettings()).reference, 'Three independent offers');
  const indicative = service.publicListings('gpu', new URLSearchParams('view=indicative'));
  assert.equal(indicative.total, 1); assert.equal(indicative.stats.indicative, 1);
  assert.equal(indicative.stats.opportunities, 0); assert.equal(indicative.items[0]?.valuation.discountPercent, null);
  const pc = raw('partial', 4_000_000, { category: 'desktop', title: 'PC i5-12400F RTX 3060 12GB RAM 16GB SSD 512GB NVMe' });
  const computer = enrichComputerAssessment(pc, assessWithRules(pc));
  store.putListing(pc, computer, true); store.setCollection('desktop', '', [pc.id]);
  const gpus = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`part-${i}`, 6_000_000), assessment: assessment() }));
  const reference = buildReference(pc, computer, [], store.getSettings(), { gpu: gpus }).reference;
  assert.equal(reference?.kind, 'component_floor'); store.setReference(pc.id, reference, 'Supported GPU subtotal');
  const components = service.publicListings('desktop', new URLSearchParams('view=components'));
  assert.equal(components.total, 1); assert.equal(components.stats.componentOpportunities, 1);
  assert.equal(components.stats.opportunities, 0); assert.equal(components.items[0]?.valuation.componentOpportunity, true);
  assert.equal(service.publicListings('desktop', new URLSearchParams('opportunities=true')).total, 0);
});
