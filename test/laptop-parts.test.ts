import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Assessment, HardwareProfile, RawListing, ReferencePrice } from '../shared/types.ts';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../server/config.ts';
import { laptopCpu, laptopPartsKey, PART_VALUES } from '../server/laptop-parts.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { assessWithRules } from '../server/hardware.ts';
import { buildPartsReference, valueListing } from '../server/pricing.ts';
import { laptopReference } from '../server/laptop-pricing.ts';
import { LAPTOP_LAUNCH_PRICES } from '../server/laptop-launch-prices.ts';
import { EMPTY_STATE, Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import type { ChototClient } from '../server/chotot.ts';
import { raw } from './helpers.ts';

type SearchInput = Parameters<ChototClient['search']>[0];
const working = 'Máy hoạt động tốt, chưa sửa chữa.';
const laptop = (id: string, price: number, text: string, updates: Partial<RawListing> = {}) => raw(id, price, {
  category: 'laptop', title: text, description: `${working} ${text}`, sellerId: `seller-${id}`, ...updates });
const settings = { ...DEFAULT_SETTINGS, minComparables: 5 };
function ai(item: RawListing, profile: Partial<HardwareProfile>, updates: Partial<Assessment> = {}): Assessment {
  return { kind: 'laptop', profile: { ...EMPTY_PROFILE, priceBasis: 'item', ...profile }, eligibility: 'eligible', risks: [], unknowns: [],
    conflicts: [], evidence: [], confidence: .9, method: 'ai', status: `fixture ${item.id}`, ...updates };
}
const peers = (items: RawListing[]) => items.map(item => ({ raw: item, assessment: assessWithRules(item) }));

test('one exact processor model is required; families and generations are not models', () => {
  assert.equal(laptopCpu('I5-1135G7'), 'I5-1135G7');
  assert.equal(laptopCpu('Intel Core i5 11th 1135G7 Tiger Lake'), 'I5-1135G7');
  assert.equal(laptopCpu('Intel Core i5'), null);
  assert.equal(laptopCpu('i5-1135G7 / i7-1165G7'), null);
  assert.equal(laptopCpu('Ryzen 7 7435HS'), 'RYZEN 7 7435HS');
});

test('same parts means processor and graphics; low-power processors without a named card are assumed integrated', () => {
  const integrated = laptop('igpu', 9_000_000, 'Dell Latitude 5420 i5-1145G7 Intel Iris Xe RAM 16GB SSD 256GB');
  assert.equal(laptopPartsKey(integrated, assessWithRules(integrated)).key?.gpu, 'integrated');
  const assumed = laptop('assumed', 9_000_000, 'Thinkpad T14 i5-1135G7 RAM 16GB SSD 512GB');
  const key = laptopPartsKey(assumed, assessWithRules(assumed)).key!;
  assert.deepEqual([key.gpu, key.gpuAssumed], ['integrated', true]);
  const gaming = laptop('gaming', 20_000_000, 'Laptop gaming i5-13420H RAM 16GB SSD 512GB');
  assert.equal(laptopPartsKey(gaming, assessWithRules(gaming)).key, null, 'H-series processors often have a discrete GPU');
  const noVram = laptop('vram', 20_000_000, 'Laptop i5-13420H RTX 4050 RAM 16GB SSD 512GB');
  assert.equal(laptopPartsKey(noVram, assessWithRules(noVram)).key, null, 'a discrete GPU needs its video memory');
  const card = laptop('card', 20_000_000, 'Acer Nitro V i5-13420H RTX 4050 6GB RAM 16GB SSD 512GB');
  assert.equal(laptopPartsKey(card, assessWithRules(card)).key?.gpu, 'RTX 4050 6GB');
  const mac = laptop('mac', 15_000_000, 'MacBook Air M1 8GB 256GB', { title: 'MacBook Air M1 8GB/256GB' });
  assert.equal(laptopPartsKey(mac, assessWithRules(mac)).key, null);
});

test('with the parts known, missing model, graphics and SSD-type notes lower confidence instead of blocking', () => {
  const item = laptop('details', 9_000_000, 'Laptop i5-1135G7 RAM 16GB SSD 512GB');
  const reviewed = ai(item, { cpu: 'I5-1135G7', ramGb: 16, storageGb: 512, storageType: 'SSD' }, { eligibility: 'review',
    unknowns: ['gpu is not stated reliably.', 'gpuClass is not stated reliably.', 'model is not stated reliably.', 'Storage type (SSD/NVMe) not explicitly stated, only 512GB capacity.'] });
  const relaxed = enrichComputerAssessment(item, reviewed);
  assert.equal(relaxed.eligibility, 'eligible'); assert.deepEqual(relaxed.unknowns, []);
  assert.ok(relaxed.computer?.missing.includes('Model name'));
  assert.ok(relaxed.computer?.missing.some(detail => detail.startsWith('Graphics assumed integrated')));
  assert.equal(relaxed.computer?.missing.includes('RAM replaceability'), false, 'replaceability does not change a laptop comparison');
  const doubtful = enrichComputerAssessment(item, { ...reviewed, unknowns: [...reviewed.unknowns, 'Working used condition is not established confidently.'] });
  assert.equal(doubtful.eligibility, 'review'); assert.deepEqual(doubtful.unknowns, ['Working used condition is not established confidently.']);
});

const nitro = (id: string, price: number, ram = 16, ssd = 512, extra = '') =>
  laptop(id, price, `Acer Nitro V 15 ANV15-51 i5-13420H RTX 4050 6GB RAM ${ram}GB SSD ${ssd}GB ${extra}`.trim());
const candidate = nitro('candidate', 18_000_000);

test('five same-configuration sellers decide alone; otherwise RAM and SSD differences are adjusted within 25%', () => {
  const exact = [20, 21, 22, 23, 24].map((million, i) => nitro(`exact-${i}`, million * 1_000_000));
  const different = nitro('bigger', 23_000_000, 32, 1024, 'MSI Thin');
  const enough = buildPartsReference(candidate, assessWithRules(candidate), peers([...exact, different]), settings).reference!;
  assert.equal(enough.kind, 'parts_market'); assert.equal(enough.sampleCount, 5); assert.equal(enough.average, 22_000_000);
  assert.match(enough.rejected.find(offer => offer.id === 'bigger')!.rejectedReason!, /same RAM and storage/);

  const adjusted = buildPartsReference(candidate, assessWithRules(candidate), peers([...exact.slice(0, 2), different,
    nitro('ram8', 20_000_000, 8, 512), nitro('sata', 21_000_000, 16, 256, 'Lenovo LOQ')]), settings).reference!;
  assert.equal(adjusted.sampleCount, 5, 'brands differ; parts match');
  const byId = new Map(adjusted.adjustedOffers!.map(offer => [offer.id, offer]));
  assert.equal(byId.get('ram8')!.price, 20_000_000 + 8 * PART_VALUES.ramPerGb);
  assert.equal(byId.get('sata')!.price, 21_000_000 + 256 * PART_VALUES.nvmePerGb);
  assert.equal(byId.get('bigger')!.price, 23_000_000 - 16 * PART_VALUES.ramPerGb - 512 * PART_VALUES.nvmePerGb);
  assert.equal(byId.get('ram8')!.adjustments[0]!.ratePerGb, PART_VALUES.ramPerGb);

  const stretched = laptop('stretched', 9_000_000, 'Acer Nitro V i5-13420H RTX 4050 6GB RAM 64GB SSD 2TB');
  const capped = buildPartsReference(candidate, assessWithRules(candidate), peers([...exact.slice(0, 3), stretched]), settings).reference!;
  assert.match(capped.rejected.find(offer => offer.id === 'stretched')!.rejectedReason!, /exceed 25%/);
});

test('other processors, graphics, MacBooks, duplicate sellers and stale observations never count', () => {
  const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const offers = [nitro('a', 20_000_000), nitro('b', 21_000_000),
    laptop('cpu', 20_000_000, 'Acer Nitro V i7-13620H RTX 4050 6GB RAM 16GB SSD 512GB'),
    laptop('gpu', 20_000_000, 'Acer Nitro V i5-13420H RTX 3050 6GB RAM 16GB SSD 512GB'),
    nitro('same-seller', 19_000_000, 16, 512, 'second ad'), nitro('stale', 20_000_000, 16, 512, 'old ad')];
  offers[4]!.sellerId = 'seller-a'; offers[5]!.observedAt = old;
  const result = buildPartsReference(candidate, assessWithRules(candidate), peers(offers), settings);
  assert.equal(result.reference, null); assert.match(result.reason, /Only 2 independent sellers/);
  const reasons = Object.fromEntries(peers(offers).map(({ raw }) => [raw.id, '']));
  const rejected = buildPartsReference(candidate, assessWithRules(candidate), peers([...offers, nitro('c', 22_000_000)]), settings).reference!.rejected;
  for (const offer of rejected) reasons[offer.id] = offer.rejectedReason!;
  assert.match(reasons.cpu!, /processor/); assert.match(reasons.gpu!, /graphics/);
  assert.match(reasons['same-seller']!, /Duplicate seller/); assert.match(reasons.stale!, /24 hours/);
});

function partsReference(sellers: number, average = 20_000_000): ReferencePrice {
  const offers = Array.from({ length: sellers }, (_, i) => nitro(`peer-${i}`, average));
  return buildPartsReference(candidate, assessWithRules(candidate), peers(offers), settings).reference!;
}
const value = (price: number, reference: ReferencePrice | null, retail: ReferencePrice | null = null) =>
  valueListing({ ...candidate, price }, assessWithRules(candidate), reference, settings, EMPTY_STATE, 'not compared', { reference: retail, reason: 'retail' });
function retail(amount: number, basis: 'current_new' | 'launch' = 'current_new'): ReferencePrice {
  const row = LAPTOP_LAUNCH_PRICES.find(item => item.id === 'hacom-nitro-v-anv15-51-55ca')!;
  const now = Date.now(), at = new Date(now).toISOString();
  const offer = { ...row, basis: 'current_new' as const, available: true, totalCostKnown: true, shipsToVietnam: true, amount, observedAt: at };
  return basis === 'current_new'
    ? laptopReference(row.profile, { checkedAt: at, status: 'complete', offers: [offer], errors: [] }, [], null, now).reference!
    : laptopReference(row.profile, { checkedAt: at, status: 'complete', offers: [], errors: [] }, [{ ...row, amount }], null, now).reference!;
}

test('same-parts sellers decide; a lower new retail price caps them; depreciation estimates are context only', () => {
  const decided = value(19_000_000, partsReference(5));
  assert.equal(decided.status, 'valued'); assert.equal(decided.opportunity, true); assert.equal(decided.reference?.kind, 'parts_market');
  assert.match(decided.reason, /same parts/);
  assert.equal(value(20_000_000, partsReference(5)).opportunity, false, 'equality is not a good price');
  const capped = value(19_000_000, partsReference(5), retail(18_500_000));
  assert.equal(capped.reference?.kind, 'retail_new'); assert.equal(capped.opportunity, false);
  assert.equal(capped.alternatives?.[0]?.kind, 'parts_market');
  const depreciation = retail(26_999_000, 'launch');
  assert.equal(depreciation.kind, 'historical_depreciation'); assert.ok(depreciation.average < 19_000_000);
  const context = value(19_000_000, partsReference(5), depreciation);
  assert.equal(context.reference?.kind, 'parts_market'); assert.equal(context.opportunity, true);
  assert.equal(context.alternatives?.[0]?.kind, 'historical_depreciation');
  const sparse = value(19_000_000, partsReference(3));
  assert.equal(sparse.status, 'indicative'); assert.equal(sparse.opportunity, false); assert.equal(sparse.evidenceIssue, 'insufficient_offers');
  const retailOnly = value(19_000_000, null, depreciation);
  assert.equal(retailOnly.status, 'indicative'); assert.equal(retailOnly.reference?.kind, 'historical_depreciation');
  const storedRetail = value(19_000_000, retail(18_500_000), null);
  assert.equal(storedRetail.reference, null, 'a stored retail reference is not a same-parts comparison');
  assert.match(storedRetail.reason, /Analyze this laptop/);
});

test('a laptop refresh searches each collected processor once, nationwide, and stores same-parts references', async () => {
  const store = new Store('', true), searches: string[] = [];
  store.saveSettings({ ...store.getSettings(), aiEnabled: false, minRamGb: 0, minVramGb: 0 });
  const local = [nitro('local-1', 18_000_000), nitro('local-2', 25_000_000, 32, 1024),
    laptop('local-3', 9_000_000, 'Dell Latitude 5420 i5-1145G7 Intel Iris Xe RAM 16GB SSD 256GB')];
  const national = [20, 21, 22, 23, 24].map((million, i) => nitro(`national-${i}`, million * 1_000_000));
  const service = new FlipperService(store, { search: async (input: SearchInput) => {
    searches.push(`${input.location}:${input.kind}:${input.query}`);
    const items = input.location !== 'nationwide' ? local : /13420h/i.test(input.query ?? '') ? national : [];
    return { items, total: items.length };
  }, detail: async (item: RawListing) => item });
  try {
    service.refresh('laptop', '', local.length);
    for (let i = 0; i < 400 && service.activeJob(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(searches.filter(search => search.startsWith('nationwide')).sort(),
      ['nationwide:laptop:I5-1145G7', 'nationwide:laptop:I5-13420H']);
    const first = service.detail('local-1')!.valuation;
    assert.equal(first.reference?.kind, 'parts_market'); assert.equal(first.status, 'valued'); assert.equal(first.opportunity, true);
    assert.equal(service.detail('local-2')!.valuation.reference?.kind, 'parts_market', 'one search serves every listing with that processor');
    assert.equal(service.detail('local-3')!.valuation.reference, null);
    assert.match(service.detail('local-3')!.valuation.reason, /Only 0 independent sellers/);
  } finally { await service.shutdown(); store.close(); }
});

test('a laptop refresh searches every collected processor, beyond the GPU and desktop configuration cap', async () => {
  const store = new Store('', true), searched = new Set<string>();
  store.saveSettings({ ...store.getSettings(), aiEnabled: false, minRamGb: 0, minVramGb: 0 });
  const cpus = ['i5-1135G7', 'i5-1145G7', 'i5-8250U', 'i5-8350U', 'i5-10210U', 'i5-1235U', 'i5-1245U',
    'i7-1165G7', 'i7-1185G7', 'i7-8550U', 'i7-8650U', 'i5-7200U', 'i5-7300U', 'i7-1255U'];
  const local = cpus.map((cpu, i) => laptop(`many-${i}`, 8_000_000, `Laptop văn phòng ${cpu} RAM 8GB SSD 256GB`));
  const service = new FlipperService(store, { search: async (input: SearchInput) => {
    if (input.location === 'nationwide') { searched.add(input.query ?? ''); return { items: [], total: 0 }; }
    return { items: local, total: local.length };
  }, detail: async (item: RawListing) => item });
  try {
    service.refresh('laptop', '', local.length);
    for (let i = 0; i < 400 && service.activeJob(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(searched.size, cpus.length);
  } finally { await service.shutdown(); store.close(); }
});
