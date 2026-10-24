import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustmentRequirements, buildReference, configurationsMatch, filterComparableOffers, valueListing } from '../server/pricing.ts';
import type { HardwareProfile, RawListing } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../server/config.ts';
import { EMPTY_STATE } from '../server/store.ts';
import { raw, assessment } from './helpers.ts';

test('five other independent exact offers produce the filtered arithmetic mean and inclusive 20% gate', () => {
  const candidate = raw('candidate', 4_800_000);
  const a = assessment();
  const peers = [5_800_000, 5_900_000, 6_000_000, 6_100_000, 6_200_000].map((price, i) => ({ raw: raw(`p${i}`, price), assessment: a }));
  const reference = buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference;
  assert.equal(reference?.average, 6_000_000);
  const valued = valueListing(candidate, a, reference, { ...DEFAULT_SETTINGS, discountPercent: 20 }, EMPTY_STATE);
  assert.equal(valued.discountPercent, 20); assert.equal(valued.opportunity, true);
  assert.equal(valued.profit, 400_000); assert.equal(valued.resaleOpportunity, false);
  assert.equal(valueListing(candidate, a, reference, { ...DEFAULT_SETTINGS, discountPercent: 21 }, EMPTY_STATE).opportunity, false);
});

test('the default 10% gate includes its boundary and excludes prices just above it', () => {
  assert.equal(DEFAULT_SETTINGS.discountPercent, 10);
  const candidate = raw('ten-percent', 5_400_000), a = assessment();
  const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`ten-peer-${i}`, 6_000_000), assessment: a }));
  const ref = buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference;
  const value = valueListing(candidate, a, ref, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(value.discountPercent, 10); assert.equal(value.opportunity, true); assert.equal(value.maxBuyPrice, 5_400_000);
  assert.equal(valueListing({ ...candidate, price: candidate.price + 1 }, a, ref, DEFAULT_SETTINGS, EMPTY_STATE).opportunity, false);
});

test('candidate, its seller, duplicate sellers, outliers, stale offers and variants cannot fabricate a discount', () => {
  const candidate = raw('candidate', 4_000_000);
  const a = assessment();
  const peers = [0,1,2,3,4].map((id) => ({ raw: raw(`good-${id}`, 6_000_000), assessment: a }));
  peers.push({ raw: candidate, assessment: a }, { raw: raw('own-store', 12_000_000, { sellerId: candidate.sellerId }), assessment: a },
    { raw: raw('duplicate', 14_000_000, { sellerId: 'seller-good-0', observedAt:new Date(Date.now()-1000).toISOString() }), assessment: a },
    { raw: raw('outlier', 50_000_000), assessment: a },
    { raw: raw('ti', 10_000_000), assessment: assessment({ gpu: 'RTX 3060 TI', vramGb: 8 }) },
    { raw: raw('stale', 9_000_000, { observedAt: '2020-01-01T00:00:00Z' }), assessment: a },
    { raw: raw('unidentified', 11_000_000, { sellerId: null }), assessment: a });
  const filtered = filterComparableOffers(candidate, a.profile, 'gpu', peers);
  assert.equal(filtered.accepted.length, 5); assert.equal(filtered.rejected.length, 7);
  assert.equal(buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference?.average, 6_000_000);
});

test('four surviving offers show an indicative average and range without economic scoring', () => {
  const a = assessment(); const candidate = raw('c', 3_000_000);
  const peers = [0,1,2,3,4].map((id) => ({ raw: raw(`p${id}`, id === 4 ? 60_000_000 : 6_000_000), assessment: a }));
  const result = buildReference(candidate, a, peers, DEFAULT_SETTINGS);
  assert.equal(result.matched, 4); assert.equal(result.reference?.average, 6_000_000);
  assert.equal(result.reference?.min, 6_000_000); assert.equal(result.reference?.max, 6_000_000);
  const value = valueListing(candidate, a, result.reference, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(value.status, 'indicative'); assert.equal(value.confidence, 'low');
  assert.equal(value.opportunity, false); assert.equal(value.resaleOpportunity, false);
  for (const field of ['discountPercent', 'profit', 'roiPercent', 'maxBuyPrice', 'expectedResale'] as const) assert.equal(value[field], null);
});

test('indicative evidence needs three independent offers and remains subject to freshness and review gates', () => {
  const a = assessment(), candidate = raw('c', 3_000_000);
  const peers = [5_500_000, 6_000_000, 6_500_000].map((price, i) => ({ raw: raw(`p${i}`, price), assessment: a }));
  assert.equal(buildReference(candidate, a, peers.slice(0, 2), DEFAULT_SETTINGS).reference, null);
  const reference = buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference!;
  assert.equal(reference.average, 6_000_000); assert.equal(reference.min, 5_500_000); assert.equal(reference.max, 6_500_000);
  assert.equal(valueListing(candidate, a, reference, DEFAULT_SETTINGS, EMPTY_STATE).status, 'indicative');
  const stale = { ...reference, offers: reference.offers.map((offer) => ({ ...offer, observedAt: '2020-01-01T00:00:00Z' })) };
  assert.equal(valueListing(candidate, a, stale, DEFAULT_SETTINGS, EMPTY_STATE).reference, null);
  assert.equal(valueListing(candidate, { ...a, eligibility: 'review' }, reference, DEFAULT_SETTINGS, EMPTY_STATE).reference, null);
  const five = buildReference(candidate, a, [...peers, ...[4,5].map((id) => ({raw:raw(`p${id}`, 6_000_000),assessment:a}))], DEFAULT_SETTINGS).reference;
  assert.equal(valueListing(candidate, a, five, { ...DEFAULT_SETTINGS, minComparables: 6 }, EMPTY_STATE).status, 'indicative');
});

test('an unidentified candidate seller cannot receive a reference or discount badge', () => {
  const a = assessment(), candidate = raw('anonymous', 3_000_000, {sellerId:null});
  const peers = Array.from({length:6}, (_, i) => ({raw:raw(`p${i}`, 6_000_000), assessment:a}));
  assert.equal(filterComparableOffers(candidate, a.profile, 'gpu', peers).accepted.length, 0);
  assert.equal(buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference, null);
  const knownReference = buildReference({...candidate,sellerId:'known'}, a, peers, DEFAULT_SETTINGS).reference;
  const result = valueListing(candidate, a, knownReference, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.opportunity, false);
});

test('deleted ads and implausibly small cash prices stay in review rather than becoming bargains', () => {
  const a = assessment(), candidate = raw('c', 3_000_000);
  const peers = Array.from({length:6}, (_, i) => ({raw:raw(`p${i}`, 6_000_000), assessment:a}));
  peers[0]!.raw.attributes.status = 'deleted';
  const ref = buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference;
  assert.equal(ref?.sampleCount, 5);
  assert.equal(valueListing({...candidate, attributes:{status:'deleted'}}, a, ref, DEFAULT_SETTINGS, EMPTY_STATE).opportunity, false);
  const placeholder = valueListing({...candidate, price:10_000}, a, ref, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(placeholder.status, 'needs_review');
  assert.equal(placeholder.resaleOpportunity, false);
});

test('a reference from an earlier comparison policy cannot survive as a current deal score', () => {
  const a = assessment(), candidate = raw('c', 3_000_000);
  const peers = Array.from({length:5}, (_, i) => ({raw:raw(`p${i}`, 6_000_000), assessment:a}));
  const reference = buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference!;
  assert.equal(valueListing(candidate, a, reference, DEFAULT_SETTINGS, EMPTY_STATE).opportunity, true);
  const old = valueListing(candidate, a, {...reference,policyVersion:undefined}, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(old.status, 'insufficient_evidence');
  assert.equal(old.opportunity, false);
});

test('unread seller descriptions and stale local asking prices cannot produce current deal badges', () => {
  const a = assessment(), candidate = raw('c', 3_000_000);
  const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`p${i}`, 6_000_000, { description: i === 4 ? '' : 'Used and working' }), assessment: a }));
  assert.equal(buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference?.sampleCount, 4);
  peers[4]!.raw.description = 'Used and working';
  const ref = buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference;
  assert.equal(valueListing({ ...candidate, description: '' }, a, ref, DEFAULT_SETTINGS, EMPTY_STATE).opportunity, false);
  assert.equal(valueListing({ ...candidate, observedAt: '2020-01-01T00:00:00Z' }, a, ref, DEFAULT_SETTINGS, EMPTY_STATE).opportunity, false);
});

test('a later excluded observation cannot resurrect an older eligible duplicate', () => {
  const candidate = raw('c', 4_000_000), a = assessment();
  const old = raw('peer', 6_000_000, { observedAt: new Date(Date.now()-1000).toISOString() });
  const latest = { ...old, observedAt: new Date().toISOString(), condition: 'repaired' as const };
  const result = filterComparableOffers(candidate, a.profile, 'gpu', [{ raw: old, assessment:a }, { raw:latest, assessment:{ ...a, eligibility:'excluded' } }]);
  assert.equal(result.accepted.length, 0);
});

test('materially different GPU memory generations never share a benchmark cohort', () => {
  const ddr3 = assessment({ gpu:'GT 730', vramGb:2, gpuMemoryType:'DDR3' }).profile;
  assert.equal(configurationsMatch('gpu', ddr3, { ...ddr3, gpuMemoryType:'GDDR5' }), false);
  assert.equal(configurationsMatch('gpu', ddr3, { ...ddr3, gpuMemoryType:null }), false);
  const desktop = { ...ddr3, cpu:'I5-12400F', ramGb:16, storageGb:512, storageType:'NVME' };
  assert.equal(configurationsMatch('desktop', desktop, { ...desktop, gpuMemoryType:'GDDR5' }), false);
});

test('multi-card bundle prices cannot inflate the standalone card reference', () => {
  const candidate = raw('single', 4_000_000), a = assessment();
  const bundle = assessment({quantity:2,priceBasis:'bundle'});
  const peers = Array.from({length:6}, (_, i) => ({raw:raw(`kit${i}`, 12_000_000), assessment:bundle}));
  assert.equal(buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference, null);
  assert.equal(valueListing(candidate, bundle, null, DEFAULT_SETTINGS, EMPTY_STATE).status, 'needs_review');
});

test('laptops require matching complete models/configuration; standalone GPU prices never substitute', () => {
  const profile = assessment({ model: 'Dell Inspiron 3421', cpu: 'I5-3337U', gpu: 'GT 630M', gpuClass: 'mobile', vramGb: 2, ramGb: 8, storageGb: 128, storageType: 'SSD' }, { kind: 'laptop', method: 'ai' });
  assert.equal(configurationsMatch('laptop', profile.profile, { ...profile.profile, ramGb: 16 }), false);
  assert.equal(configurationsMatch('laptop', profile.profile, { ...profile.profile, model: null }), false);
  const peers = Array.from({ length: 6 }, (_, i) => ({ raw: raw(`gpu${i}`, 10_000_000), assessment: assessment({ gpu: 'GT 630M', vramGb: 2 }) }));
  assert.equal(buildReference(raw('laptop', 2_000_000, { category: 'laptop' }), profile, peers, DEFAULT_SETTINGS, { gpu: peers }).reference, null);
});

test('desktop supported GPU-only subtotal is explicitly partial and excludes missing components', () => {
  const candidate = raw('pc', 4_000_000, { category: 'desktop' });
  const a = assessment({ ramGb: 16, cpu: 'I5-12400F' }, { kind: 'desktop', method: 'ai' });
  const gpus = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`g${i}`, 6_000_000), assessment: assessment() }));
  const result = buildReference(candidate, a, [], DEFAULT_SETTINGS, { gpu: gpus });
  assert.equal(result.reference?.kind, 'component_floor'); assert.equal(result.reference?.average, 6_000_000);
  assert.deepEqual(result.reference?.components.map((c) => c.kind), ['gpu']);
  const value = valueListing(candidate, a, result.reference, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(value.opportunity, false); assert.equal(value.componentOpportunity, true);
  assert.equal(value.resaleOpportunity, false);
});

test('desktop monitor bundles cannot inflate a tower-only configuration average', () => {
  const profile = assessment({ cpu:'I5-12400F', ramGb:16, storageGb:512, storageType:'NVME' }, { kind:'desktop', method: 'ai' });
  const candidate = raw('tower', 4_000_000, { category:'desktop', title:'PC i5-12400F RTX 3060 12GB' });
  const peers = Array.from({ length:5 }, (_, i) => ({ raw:raw(`bundle-${i}`, 8_000_000, {
    category:'desktop', description:'PC hoạt động tốt. Kèm màn hình 24 inch, bàn phím và chuột.' }), assessment:profile }));
  assert.equal(buildReference(candidate, profile, peers, DEFAULT_SETTINGS).reference, null);
  assert.match(buildReference(candidate, profile, peers, DEFAULT_SETTINGS).reason, /Only 0 independent/);
  for (const peer of peers) peer.raw.description = 'PC hoạt động tốt. Không kèm màn hình 24 inch.';
  assert.equal(buildReference(candidate, profile, peers, DEFAULT_SETTINGS).reference?.kind, 'configuration');
  // Actual listing 134884791 explicitly excludes the separately advertised monitor.
  const monitorExcluded = { ...candidate, description: 'Giá: 4.000.000 VND (chưa kèm màn hình)\nlcd 24 , 27in new giá dưới 2m (BH 24T)' };
  assert.equal(buildReference(monitorExcluded, profile, peers, DEFAULT_SETTINGS).reference?.kind, 'configuration');
  const bundleCandidate = { ...candidate, description:'Kèm màn hình 24 inch' };
  assert.equal(buildReference(bundleCandidate, profile, peers, DEFAULT_SETTINGS).reference, null);
});

test('per-item reserves and resale price affect profit/ROI without changing the price discount', () => {
  const candidate = raw('pc', 4_000_000), a = assessment();
  const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`g${i}`, 6_000_000), assessment: a }));
  const ref = buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference;
  const result = valueListing(candidate, a, ref, DEFAULT_SETTINGS, { ...EMPTY_STATE, costReserve: 1_000_000, expectedResale: 6_000_000 });
  assert.equal(result.profit, 1_000_000); assert.equal(result.roiPercent, 20); assert.equal(result.resaleOpportunity, true);
  const reviewed = valueListing(candidate, { ...a, eligibility: 'review', unknowns: ['VRAM unverified'] }, ref, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(reviewed.status, 'needs_review'); assert.equal(reviewed.opportunity, false);
});

function computer(id: string, price: number, profile: Partial<HardwareProfile> = {}, rawUpdates: Partial<RawListing> = {}, kind: 'desktop' | 'laptop' = 'desktop') {
  const a = assessment({ cpu: 'I5-12400', gpu: 'RTX 3070', gpuClass: 'desktop', vramGb: 8,
    ramGb: 32, ramType: 'DDR4', ramFormFactor: 'DIMM', ramSpeedMhz: 3200, ramEcc: 'non-ecc',
    quantity: 2, perUnitGb: 16, storageGb: 512, storageType: 'NVME SSD', ...profile }, { kind, method: 'ai' });
  const absent = a.profile.gpuInclusion === 'absent';
  return { raw: raw(id, price, { category: kind, title: `${kind === 'desktop' ? 'PC tower' : 'Laptop'} ${a.profile.cpu}`,
    description: `Used and working. RAM ${a.profile.ramType ?? ''} non-ECC. ${absent ? 'Without discrete GPU.' : ''}`, ...rawUpdates }), assessment: a };
}
function cards(model = 'RTX 3070', count = 5, price = 5_000_000) {
  return Array.from({ length: count }, (_, i) => ({ raw: raw(`${model}-${i}`, price, { title: `${model} 8GB` }),
    assessment: assessment({ gpu: model, vramGb: 8 }) }));
}
function gpuFreePeers(count = 5, price = 8_000_000) {
  return Array.from({ length: count }, (_, i) => computer(`base-${i}`, price, { gpu: null, gpuClass: null, vramGb: null, gpuInclusion: 'absent' }));
}
function sticks(count = 5, price = 500_000, spec: Partial<HardwareProfile> = {}) {
  return Array.from({ length: count }, (_, i) => ({ raw: raw(`ram-${spec.perUnitGb ?? 16}-${i}`, price, { category: 'ram', title: 'DDR4 RAM non-ECC DIMM', description: 'Used and working, non-ECC memory.' }),
    assessment: assessment({ gpu: null, gpuClass: null, vramGb: null, ramGb: 16, perUnitGb: 16, quantity: 1,
      ramType: 'DDR4', ramFormFactor: 'DIMM', ramSpeedMhz: 3200, ramEcc: 'non-ecc', ...spec }, { kind: 'ram', method: 'ai' }) }));
}

test('GPU-free PCs plus independent card prices produce a scored average despite unspecified base hardware', () => {
  const candidate = computer('candidate', 9_000_000), peers = gpuFreePeers(), gpus = cards();
  assert.deepEqual(adjustmentRequirements(candidate.raw, candidate.assessment, peers[0]!.raw, peers[0]!.assessment).map((part) => part.kind), ['gpu']);
  const result = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { gpu: gpus });
  assert.equal(result.reference?.kind, 'adjusted_configuration');
  assert.equal(result.reference?.average, 13_000_000); assert.equal(result.reference?.sampleCount, 5);
  assert.equal(result.reference?.baseSampleCount, 5); assert.equal(result.reference?.offers.length, 5);
  assert.equal(result.reference?.adjustedOffers?.[0]?.askingPrice, 8_000_000);
  assert.deepEqual(result.reference?.adjustedOffers?.[0]?.adjustments.map((term) => [term.operation, term.total]), [['add', 5_000_000]]);
  const value = valueListing(candidate.raw, candidate.assessment, result.reference, DEFAULT_SETTINGS, EMPTY_STATE, result.reason);
  assert.equal(value.status, 'valued'); assert.equal(value.opportunity, true); assert.equal(value.confidence, 'low');
  assert.ok(value.missingDetails?.includes('Power supply')); assert.match(value.reason, /Missing details/);
});

test('a different included GPU is subtracted before the target card is added', () => {
  const candidate = computer('candidate', 9_000_000);
  const peers = Array.from({ length: 5 }, (_, i) => computer(`peer-${i}`, 11_000_000, { gpu: 'RTX 2060', vramGb: 8 }));
  const result = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS,
    { gpu: [...cards('RTX 2060', 5, 3_000_000), ...cards()] });
  assert.equal(result.reference?.average, 13_000_000);
  assert.deepEqual(result.reference?.adjustedOffers?.[0]?.adjustments.map((term) => [term.operation, term.total]), [['remove', 3_000_000], ['add', 5_000_000]]);
  const unknownGpu = peers.map((peer) => ({ ...peer, assessment: { ...peer.assessment, profile: { ...peer.assessment.profile, gpu: null, gpuClass: null, vramGb: null } } }));
  assert.equal(buildReference(candidate.raw, candidate.assessment, unknownGpu, DEFAULT_SETTINGS, { gpu: cards() }).reference?.kind, 'component_floor');
});

test('RAM additions price only the verified extra sticks, normalize bundle prices and never guess layout', () => {
  const candidate = computer('candidate', 7_000_000);
  const peers = Array.from({ length: 5 }, (_, i) => computer(`peer-${i}`, 9_000_000, { ramGb: 16, quantity: 1 }));
  const ram = sticks(5, 1_000_000, { quantity: 2, ramGb: 32, priceBasis: 'bundle' });
  const result = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { ram });
  assert.equal(result.reference?.kind, 'adjusted_configuration'); assert.equal(result.reference?.average, 9_500_000);
  assert.deepEqual(result.reference?.adjustedOffers?.[0]?.adjustments.map((term) => [term.operation, term.quantity, term.average]), [['add', 1, 500_000]]);
  const unverified = peers.map((peer) => ({ ...peer, assessment: { ...peer.assessment, profile: { ...peer.assessment.profile, perUnitGb: null } } }));
  assert.equal(buildReference(candidate.raw, candidate.assessment, unverified, DEFAULT_SETTINGS, { ram }).reference?.kind, 'component_floor');
  const eccPool = ram.map((row) => ({ ...row, assessment: { ...row.assessment, profile: { ...row.assessment.profile, ramEcc: 'registered' as const } } }));
  assert.equal(buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { ram: eccPool }).reference, null);
  assert.equal(configurationsMatch('ram', ram[0]!.assessment.profile, { ...ram[0]!.assessment.profile, ramEcc: null }), false);
});

test('the weakest computer or component pool determines the evidence threshold, without multiplying combinations', () => {
  const candidate = computer('candidate', 9_000_000);
  for (const [pcCount, cardCount, expected] of [[3, 10, 3], [8, 3, 3], [4, 4, 4], [5, 5, 5]]) {
    const reference = buildReference(candidate.raw, candidate.assessment, gpuFreePeers(pcCount), DEFAULT_SETTINGS, { gpu: cards('RTX 3070', cardCount) }).reference!;
    assert.equal(reference.kind, 'adjusted_configuration'); assert.equal(reference.sampleCount, expected);
    assert.equal(reference.baseSampleCount, pcCount);
    assert.equal(valueListing(candidate.raw, candidate.assessment, reference, DEFAULT_SETTINGS, EMPTY_STATE).status, expected! < 5 ? 'indicative' : 'valued');
    assert.equal(valueListing(candidate.raw, candidate.assessment, reference, { ...DEFAULT_SETTINGS, minComparables: 6 }, EMPTY_STATE).status, 'indicative');
  }
  assert.notEqual(buildReference(candidate.raw, candidate.assessment, gpuFreePeers(2), DEFAULT_SETTINGS, { gpu: cards('RTX 3070', 10) }).reference?.kind, 'adjusted_configuration');
});

test('component evidence excludes candidate and base sellers and expires independently of PC observations', () => {
  const candidate = computer('candidate', 9_000_000), peers = gpuFreePeers(), gpus = cards('RTX 3070', 6);
  gpus.push({ raw: raw('own-gpu', 50_000_000, { sellerId: candidate.raw.sellerId }), assessment: assessment({ gpu: 'RTX 3070', vramGb: 8 }) });
  gpus[0]!.raw.sellerId = peers[0]!.raw.sellerId;
  const ref = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { gpu: gpus }).reference!;
  assert.equal(ref.average, 13_000_000); assert.equal(ref.sampleCount, 5);
  for (const peer of ref.adjustedOffers!) for (const term of peer.adjustments) {
    assert.ok(term.offers.every((offer) => offer.sellerId !== candidate.raw.sellerId && offer.sellerId !== peer.sellerId));
  }
  const stale = structuredClone(ref); stale.adjustedOffers![0]!.adjustments[0]!.offers[0]!.observedAt = '2020-01-01T00:00:00Z';
  assert.equal(valueListing(candidate.raw, candidate.assessment, stale, DEFAULT_SETTINGS, EMPTY_STATE).status, 'insufficient_evidence');
  const sparse = cards('RTX 3070', 3); sparse[0]!.raw.observedAt = '2020-01-01T00:00:00Z';
  assert.equal(buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { gpu: sparse }).reference, null);
});

test('known form factor, CPU count and ECC platform differences cannot be normalized away', () => {
  const candidate = computer('candidate', 9_000_000, {}, { description: 'Used and working. Single CPU. RAM non-ECC.' });
  for (const description of ['Used and working. SFF desktop. Single CPU. RAM non-ECC.', 'Used and working. Dual CPU. RAM non-ECC.', 'Used and working. Single CPU. RAM ECC registered.']) {
    const peers = gpuFreePeers().map((peer) => ({ ...peer, raw: { ...peer.raw, title: 'PC i5-12400', description: `${description} Without discrete GPU.` } }));
    assert.notEqual(buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { gpu: cards() }).reference?.kind, 'adjusted_configuration');
  }
});

test('laptop RAM and storage adjustments require verified replaceability and keep mobile GPU fixed', () => {
  const profile: Partial<HardwareProfile> = { model: 'Lenovo ThinkPad T480', cpu: 'I5-8350U', gpu: 'UHD 620', gpuClass: 'integrated', vramGb: null,
    ramFormFactor: 'SODIMM', ramSpeedMhz: 2400 };
  const details = { description: 'Used and working. RAM DDR4 non-ECC, replaceable. SSD replaceable.' };
  const candidate = computer('candidate', 6_000_000, { ...profile, storageGb: 1024 }, details, 'laptop');
  const peers = Array.from({ length: 5 }, (_, i) => computer(`laptop-${i}`, 7_000_000, { ...profile, ramGb: 16, quantity: 1 }, details, 'laptop'));
  const ram = sticks(5, 500_000, { ramFormFactor: 'SODIMM', ramSpeedMhz: 2400 });
  const ssd = [512, 1024].flatMap((capacity) => Array.from({ length: 5 }, (_, i) => ({ raw: raw(`ssd-${capacity}-${i}`, capacity === 512 ? 500_000 : 900_000, { category: 'ssd', title: `${capacity}GB NVME SSD` }),
    assessment: assessment({ quantity: 1, storageGb: capacity, storageType: 'NVME SSD' }, { kind: 'ssd' }) })));
  const ref = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { ram, ssd }).reference;
  assert.equal(ref?.kind, 'adjusted_configuration'); assert.equal(ref?.average, 7_900_000);
  const soldered = { ...candidate.raw, description: 'Used and working. RAM DDR4 non-ECC soldered. SSD replaceable.' };
  assert.equal(buildReference(soldered, candidate.assessment, peers, DEFAULT_SETTINGS, { ram, ssd }).reference, null);
  const unknown = { ...candidate.raw, description: 'Used and working. RAM DDR4 non-ECC.' };
  assert.equal(buildReference(unknown, candidate.assessment, peers, DEFAULT_SETTINGS, { ram, ssd }).reference, null);
  const mobileCandidate = { ...candidate.assessment, profile: { ...candidate.assessment.profile, gpu: 'MX150', gpuClass: 'mobile' as const, vramGb: 2 } };
  assert.equal(buildReference(candidate.raw, mobileCandidate, peers, DEFAULT_SETTINGS, { ram, ssd, gpu: cards() }).reference, null);
});

test('priced configurations remain one PC observation and select the correctly priced included GPU', () => {
  const candidate = computer('candidate', 9_000_000);
  const peers = Array.from({ length: 5 }, (_, i) => computer(`variant-${i}`, 8_000_000, {}, {
    title: 'PC i5-12400 RTX 3070 8GB', description: 'Used and working. RAM DDR4 non-ECC.\nGiá bán cả bộ: 13 triệu\nGiá bán không kèm card đồ họa: 8 triệu.' }));
  const ref = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { gpu: cards() }).reference!;
  assert.equal(ref.kind, 'configuration'); assert.equal(ref.average, 13_000_000); assert.equal(ref.sampleCount, 5);
  assert.ok(ref.offers.every((offer) => offer.price === 13_000_000));
  const swappable = peers.slice(0, 3).map((peer) => ({ ...peer, assessment: { ...peer.assessment, profile: { ...peer.assessment.profile, gpu: 'RTX 2060' } },
    raw: { ...peer.raw, title: 'PC i5-12400 RTX 2060 8GB', description: peer.raw.description.replace('13 triệu', '11 triệu') } }));
  const adjusted = buildReference(candidate.raw, candidate.assessment, swappable, DEFAULT_SETTINGS, { gpu: [...cards(), ...cards('RTX 2060', 5, 3_000_000)] }).reference!;
  assert.equal(adjusted.kind, 'adjusted_configuration'); assert.equal(adjusted.average, 13_000_000); assert.equal(adjusted.baseSampleCount, 3);
  assert.equal(adjusted.sampleCount, 3); assert.equal(adjusted.offers.length, 3);
});

test('outlier filtering runs on normalized prices and a latest excluded PC cannot resurrect an older variant', () => {
  const candidate = computer('candidate', 9_000_000), peers = gpuFreePeers(6);
  peers[5]!.raw.price = 80_000_000;
  const older = { ...peers[0]!, raw: { ...peers[0]!.raw, observedAt: new Date(Date.now() - 1_000).toISOString() } };
  const latest = { ...peers[0]!, raw: { ...peers[0]!.raw, attributes: { status: 'deleted' } } };
  const ref = buildReference(candidate.raw, candidate.assessment, [...peers.slice(1), older, latest], DEFAULT_SETTINGS, { gpu: cards() }).reference!;
  assert.equal(ref.kind, 'adjusted_configuration'); assert.equal(ref.average, 13_000_000); assert.equal(ref.baseSampleCount, 4);
  assert.ok(ref.rejected.some((offer) => offer.rejectedReason?.includes('outlier')));
  assert.ok(ref.offers.every((offer) => offer.id !== peers[0]!.raw.id));
});

test('sufficient direct evidence is preferred and sparse direct evidence can join normalized peers', () => {
  const candidate = computer('candidate', 9_000_000);
  const direct = Array.from({ length: 5 }, (_, i) => computer(`exact-${i}`, 12_000_000));
  assert.equal(buildReference(candidate.raw, candidate.assessment, [...direct, ...gpuFreePeers()], DEFAULT_SETTINGS, { gpu: cards() }).reference?.kind, 'configuration');
  const ref = buildReference(candidate.raw, candidate.assessment, [...direct.slice(0, 2), ...gpuFreePeers(3)], DEFAULT_SETTINGS, { gpu: cards() }).reference!;
  assert.equal(ref.kind, 'adjusted_configuration'); assert.equal(ref.sampleCount, 5); assert.equal(ref.average, 12_600_000);
  assert.equal(ref.adjustedOffers?.filter((offer) => !offer.adjustments.length).length, 2);
});

test('different shop accounts sharing explicit numbered street addresses count as one seller observation', () => {
  const candidate = raw('candidate', 4_000_000), a = assessment();
  const descriptionA = 'Used and working.\nĐịa chỉ:\n23 Đường số 1, Linh Tây, Thủ Đức\n47/86B Bùi Đình Túy, Bình Thạnh';
  const descriptionB = 'Used and working.\nCS1: 23 Đường Số 1, Phường Linh Tây, Thủ Đức\nCS2: 47/86b Bùi Đình Túy, Phường 14, Bình Thạnh';
  const peers = [descriptionA, descriptionB, 'Used and working.\nĐịa chỉ: 99 Nguyễn Trãi, Quận 1'].map((description, i) => ({
    raw: raw(`shop-${i}`, 6_000_000, { sellerType: 'business', region: 'Tp Hồ Chí Minh', description }), assessment: a,
  }));
  const filtered = filterComparableOffers(candidate, a.profile, 'gpu', peers);
  assert.equal(filtered.accepted.length, 2);
  assert.ok(filtered.rejected.some((offer) => offer.rejectedReason?.includes('linked business')));
  assert.equal(buildReference(candidate, a, peers, DEFAULT_SETTINGS).reference, null);
});

test('city names, masked phone numbers, unnumbered streets and private shared addresses do not merge sellers', () => {
  const candidate = raw('candidate', 4_000_000), a = assessment();
  const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`area-${i}`, 6_000_000, {
    sellerType: i < 3 ? 'business' : 'private', region: 'Tp Hồ Chí Minh', description: i < 3
      ? 'Used and working.\nĐịa chỉ: Bình Thạnh, Tp Hồ Chí Minh\nĐịa chỉ: Bùi Đình Túy, Bình Thạnh\nZalo: ***'
      : 'Used and working.\n47/86B Bùi Đình Túy, Bình Thạnh',
  }), assessment: a }));
  assert.equal(filterComparableOffers(candidate, a.profile, 'gpu', peers).accepted.length, 5);
  const differentWards = ['Linh Tây', 'Linh Trung'].map((ward, i) => ({ raw: raw(`ward-${i}`, 6_000_000, { sellerType: 'business',
    description: `Used and working.\n23 Đường Số 1, Phường ${ward}, Thủ Đức` }), assessment: a }));
  assert.equal(filterComparableOffers(candidate, a.profile, 'gpu', differentWards).accepted.length, 2);
});

test('explicit phones link seller accounts transitively and exclude the candidate business', () => {
  const a = assessment(), candidate = raw('candidate', 4_000_000, { description: 'Used and working.\nHotline: 0901.234.567' });
  const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`peer-${i}`, 6_000_000), assessment: a }));
  peers.push({ raw: raw('own-phone-alias', 6_000_000, { sellerType: 'business', description: 'Used and working.\nZalo: +84 901 234 567\n23 Đường Số 1, Linh Tây, Thủ Đức' }), assessment: a });
  peers.push({ raw: raw('own-address-alias', 6_000_000, { sellerType: 'business', description: 'Used and working.\nCS1: 23 Đường Số 1, Phường Linh Tây, Thủ Đức\nCall: 0988 123 456' }), assessment: a });
  peers.push({ raw: raw('own-transitive-alias', 6_000_000, { description: 'Used and working.\nĐiện thoại: 0988.123.456' }), assessment: a });
  const result = filterComparableOffers(candidate, a.profile, 'gpu', peers);
  assert.equal(result.accepted.length, 5);
  assert.ok(result.rejected.every((offer) => offer.rejectedReason?.startsWith('Candidate')));
});

test('linked shop accounts are deduplicated consistently for complete PCs and adjusted component pools', () => {
  const candidate = computer('candidate', 9_000_000);
  const direct = Array.from({ length: 5 }, (_, i) => computer(`exact-${i}`, 13_000_000));
  for (const peer of direct.slice(0, 2)) peer.raw.description += '\nHotline: 0901 234 567';
  const directRef = buildReference(candidate.raw, candidate.assessment, direct, DEFAULT_SETTINGS).reference!;
  assert.equal(directRef.kind, 'configuration'); assert.equal(directRef.sampleCount, 4);
  assert.equal(valueListing(candidate.raw, candidate.assessment, directRef, DEFAULT_SETTINGS, EMPTY_STATE).status, 'indicative');
  const peers = gpuFreePeers(), gpus = cards();
  for (const peer of peers.slice(0, 2)) peer.raw.description += '\nZalo: 0901.234.567';
  for (const gpu of gpus.slice(0, 2)) gpu.raw.description += '\nPhone: +84 988 123 456';
  const ref = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { gpu: gpus }).reference!;
  assert.equal(ref.kind, 'adjusted_configuration'); assert.equal(ref.baseSampleCount, 4); assert.equal(ref.sampleCount, 4);
  assert.ok(ref.adjustedOffers!.every((offer) => offer.adjustments[0]!.offers.length === 4));
  assert.match(ref.methodology, /account IDs do not establish independent businesses/);
});

test('a component advertisement from another account of the base PC business cannot support its adjustment', () => {
  const candidate = computer('candidate', 9_000_000), peers = gpuFreePeers(), gpus = cards('RTX 3070', 6);
  peers[0]!.raw.sellerType = 'business'; peers[0]!.raw.description += '\n23 Đường số 1, Linh Tây, Thủ Đức';
  gpus[0]!.raw.sellerType = 'business'; gpus[0]!.raw.description += '\nCS1: 23 Đường Số 1, Phường Linh Tây, Thủ Đức';
  const ref = buildReference(candidate.raw, candidate.assessment, peers, DEFAULT_SETTINGS, { gpu: gpus }).reference!;
  assert.equal(ref.kind, 'adjusted_configuration'); assert.equal(ref.sampleCount, 5);
  const base = ref.adjustedOffers!.find((offer) => offer.id === peers[0]!.raw.id)!;
  assert.equal(base.adjustments[0]!.offers.length, 5);
  assert.ok(base.adjustments[0]!.offers.every((offer) => offer.id !== gpus[0]!.raw.id));
  assert.ok(ref.rejected.some((offer) => offer.id === gpus[0]!.raw.id && offer.rejectedReason?.includes('base PC seller or linked business')));
});

test('an optional peer with weaker component evidence cannot downgrade a sufficient scoring group', () => {
  const candidate = computer('candidate', 9_000_000), strong = gpuFreePeers();
  const weak = computer('rare-gpu-peer', 12_000_000, { gpu: 'RTX 2060', vramGb: 8 });
  const gpu = [...cards(), ...cards('RTX 2060', 3, 3_000_000)];
  const reference = buildReference(candidate.raw, candidate.assessment, [...strong, weak], DEFAULT_SETTINGS, { gpu }).reference!;
  assert.equal(reference.kind, 'adjusted_configuration'); assert.equal(reference.average, 13_000_000);
  assert.equal(reference.baseSampleCount, 5); assert.equal(reference.sampleCount, 5);
  assert.equal(valueListing(candidate.raw, candidate.assessment, reference, DEFAULT_SETTINGS, EMPTY_STATE).status, 'valued');
  assert.ok(reference.rejected.some((offer) => offer.id === weak.raw.id && offer.rejectedReason?.includes('sufficient scoring group')));
  const indicative = buildReference(candidate.raw, candidate.assessment, [...strong.slice(0, 4), weak], DEFAULT_SETTINGS, { gpu }).reference!;
  assert.equal(indicative.baseSampleCount, 5); assert.equal(indicative.sampleCount, 3);
  assert.equal(valueListing(candidate.raw, candidate.assessment, indicative, DEFAULT_SETTINGS, EMPTY_STATE).status, 'indicative');
});
