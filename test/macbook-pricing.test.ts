import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HardwareProfile, RawListing } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../server/config.ts';
import { EMPTY_STATE } from '../server/store.ts';
import { adjustmentRequirements, buildReference, configurationsMatch, REFERENCE_POLICY_VERSION, valueListing } from '../server/pricing.ts';
import { assessment, raw } from './helpers.ts';

function macProfile(updates: Partial<HardwareProfile> = {}): HardwareProfile {
  return assessment({ model: 'MACBOOK PRO 14', modelYear: 2023, screenInches: 14.2,
    cpu: 'APPLE M2 PRO', cpuCores: 10, gpu: 'APPLE M2 PRO 16-CORE INTEGRATED', gpuCores: 16,
    gpuClass: 'integrated', vramGb: null, gpuMemoryType: null, gpuInclusion: 'included',
    ramGb: 16, ramType: null, ramFormFactor: 'soldered', ramSpeedMhz: null,
    storageGb: 512, storageType: 'NVME SSD', quantity: 1, priceBasis: 'item', ...updates }).profile;
}
function laptop(id: string, price: number, profile = macProfile(), updates: Partial<RawListing> = {}) {
  const coreCount = profile.gpuCores ?? Number(profile.gpu?.match(/\b(\d+)-CORE\b/i)?.[1] ?? 0);
  const sourceIdentity = [profile.model, profile.cpu, profile.modelYear,
    profile.screenInches ? `${profile.screenInches}inch` : '',
    profile.cpuCores ? `${profile.cpuCores}CPU` : '', coreCount ? `${coreCount}GPU` : ''].filter(Boolean).join(' ');
  return { raw: raw(id, price, { category: 'laptop', title: sourceIdentity,
    description: `Used and working. RAM ${profile.ramGb}GB, SSD ${profile.storageGb}GB.`, ...updates }),
    assessment: assessment(profile, { kind: 'laptop', method: 'ai' }) };
}
function peers(profile = macProfile()) {
  return Array.from({ length: 5 }, (_, i) => laptop(`peer-${i}`, 25_000_000, profile));
}

test('retained exact used MacBook comparisons cannot supply a retail verdict after the policy cutover', () => {
  const candidate = laptop('candidate', 20_000_000);
  const result = buildReference(candidate.raw, candidate.assessment, peers(), DEFAULT_SETTINGS);
  assert.equal(result.reference?.kind, 'model');
  assert.equal(result.reference?.average, 25_000_000);
  assert.equal(result.reference?.sampleCount, 5);
  assert.equal(result.reference?.policyVersion, 5);
  const value = valueListing(candidate.raw, candidate.assessment, result.reference, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(value.opportunity, false);
  assert.equal(value.discountPercent, null);
  assert.equal(value.evidenceIssue, 'retail_price');
});

test('MacBook nominal screens match their known actual diagonal and structured fields support legacy names', () => {
  for (const [family, nominal, actual] of [['AIR', 13, 13.3], ['AIR', 13, 13.6], ['PRO', 14, 14.2], ['AIR', 15, 15.3], ['PRO', 15, 15.4], ['PRO', 16, 16.2]] as const) {
    const a = macProfile({ model: `MACBOOK ${family} ${nominal}`, screenInches: nominal });
    const b = macProfile({ model: `MACBOOK ${family} M2`, screenInches: actual });
    assert.equal(configurationsMatch('laptop', a, b), true, `${nominal} should match ${actual}`);
    assert.equal(configurationsMatch('laptop', b, a), true);
  }
  const fromLegacyName = macProfile({ model: 'MACBOOK PRO 14', screenInches: undefined });
  assert.equal(configurationsMatch('laptop', fromLegacyName, macProfile()), true);
});

test('legacy Apple chip labels with extra core text still require a known GPU bin', () => {
  for (const cpu of ['APPLE M2 PRO 10-CORE', 'M2 PRO', 'Apple Silicon M2 Pro']) {
    const generic = macProfile({ cpu, gpu: 'APPLE M2 PRO INTEGRATED', gpuCores: null });
    assert.equal(configurationsMatch('laptop', generic, generic), false);
  }
});

test('unknown Apple GPU bins remain browsable but cannot establish a price reference even among identical generic strings', () => {
  const generic = macProfile({ gpu: 'APPLE M2 PRO INTEGRATED', gpuCores: undefined });
  assert.equal(configurationsMatch('laptop', generic, generic), false);
  assert.equal(configurationsMatch('laptop', generic, macProfile()), false);
  assert.equal(configurationsMatch('laptop', macProfile(), generic), false);
  const candidate = laptop('candidate', 15_000_000, generic);
  assert.equal(candidate.assessment.eligibility, 'eligible');
  const result = buildReference(candidate.raw, candidate.assessment, peers(generic), DEFAULT_SETTINGS);
  assert.equal(result.reference, null);
  assert.equal(valueListing(candidate.raw, candidate.assessment, null, DEFAULT_SETTINGS, EMPTY_STATE).opportunity, false);
});

test('legacy Apple profiles without a known screen cannot inherit a reference from generic model text', () => {
  const unknownScreen = macProfile({ model: 'MACBOOK PRO', screenInches: undefined });
  assert.equal(configurationsMatch('laptop', unknownScreen, unknownScreen), false);
  const candidate = laptop('candidate', 15_000_000, unknownScreen);
  assert.equal(buildReference(candidate.raw, candidate.assessment, peers(unknownScreen), DEFAULT_SETTINGS).reference, null);
  const knownCandidate = laptop('known', 20_000_000);
  const reference = buildReference(knownCandidate.raw, knownCandidate.assessment, peers(), DEFAULT_SETTINGS).reference!;
  const value = valueListing(candidate.raw, candidate.assessment, reference, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(value.opportunity, false);
  assert.equal(value.evidenceIssue, 'retail_price');
});

test('MacBook family, screen, chip tier, GPU bin, known CPU core count and known model year never cross', () => {
  const a = macProfile();
  for (const changed of [
    { model: 'MACBOOK AIR 14' },
    { model: 'MACBOOK PRO 16', screenInches: 16.2 },
    { cpu: 'APPLE M2', gpu: 'APPLE M2 16-CORE INTEGRATED' },
    { cpu: 'APPLE M2 MAX', gpu: 'APPLE M2 MAX 16-CORE INTEGRATED' },
    { gpuCores: 19, gpu: 'APPLE M2 PRO 19-CORE INTEGRATED' },
    { cpuCores: 12 },
    { modelYear: 2024 },
  ] satisfies Partial<HardwareProfile>[]) {
    const b = macProfile(changed);
    assert.equal(configurationsMatch('laptop', a, b), false, JSON.stringify(changed));
    assert.equal(configurationsMatch('laptop', b, a), false, JSON.stringify(changed));
  }
  assert.equal(configurationsMatch('laptop', a, macProfile({ cpuCores: null, modelYear: null })), true);
});

test('contradictory structured fields and legacy model or GPU labels cannot look uniquely identified', () => {
  for (const profile of [
    macProfile({ model: 'MACBOOK PRO 16', screenInches: 14.2 }),
    macProfile({ model: 'MACBOOK PRO 14 2021', modelYear: 2023 }),
    macProfile({ gpuCores: 19 }),
    macProfile({ model: null }),
  ]) assert.equal(configurationsMatch('laptop', profile, profile), false);
  const legacyGpu = macProfile({ gpuCores: undefined });
  assert.equal(configurationsMatch('laptop', legacyGpu, macProfile()), true);
});

test('Intel MacBooks keep exact CPU identity and family, screen and known model-year boundaries', () => {
  const intel = macProfile({ model: 'MACBOOK PRO 13 2020', modelYear: 2020, screenInches: 13.3,
    cpu: 'I5-1038NG7', cpuCores: null, gpu: 'IRIS PLUS', gpuCores: null });
  assert.equal(configurationsMatch('laptop', intel, { ...intel, model: 'MACBOOK PRO 13' }), true);
  for (const changed of [
    { cpu: 'I5-8257U' }, { model: 'MACBOOK AIR 13 2020' },
    { model: 'MACBOOK PRO 16 2020', screenInches: 16.2 },
    { model: 'MACBOOK PRO 13 2019', modelYear: 2019 },
    { model: 'MACBOOK PRO', screenInches: null },
  ] satisfies Partial<HardwareProfile>[]) assert.equal(configurationsMatch('laptop', intel, { ...intel, ...changed }), false);
});

test('component adjustment cannot bypass Mac screen, year, chip or core-bin identity gates', () => {
  // Keep a complete retained AI profile here: the MacBook seller parser deliberately
  // leaves SSD interfaces unspecified, which would independently block adjustment.
  const candidate = laptop('candidate', 20_000_000, macProfile({ storageGb: 1024 }),
    { title: 'Apple notebook', description: 'Used and working. RAM 16GB. SSD 1024GB NVME replaceable.' });
  const ssd = [512, 1024].flatMap((capacity) => Array.from({ length: 5 }, (_, i) => ({
    raw: raw(`ssd-${capacity}-${i}`, capacity === 512 ? 500_000 : 900_000, { category: 'ssd', title: 'NVME SSD' }),
    assessment: assessment({ storageGb: capacity, storageType: 'NVME SSD', quantity: 1 }, { kind: 'ssd' }),
  })));
  const validPeers = peers().map((peer) => ({ ...peer, raw: { ...peer.raw, title: 'Apple notebook', description: 'Used and working. RAM 16GB. SSD 512GB NVME replaceable.' } }));
  assert.deepEqual(adjustmentRequirements(candidate.raw, candidate.assessment, validPeers[0]!.raw, validPeers[0]!.assessment).map((term) => term.kind), ['ssd', 'ssd']);
  assert.equal(buildReference(candidate.raw, candidate.assessment, validPeers, DEFAULT_SETTINGS, { ssd }).reference?.kind, 'adjusted_configuration');
  for (const changed of [
    { model: 'MACBOOK PRO', screenInches: undefined },
    { model: 'MACBOOK PRO 16', screenInches: 16.2 },
    { gpu: 'APPLE M2 PRO INTEGRATED', gpuCores: undefined },
    { gpu: 'APPLE M2 PRO 19-CORE INTEGRATED', gpuCores: 19 },
    { cpuCores: 12 }, { modelYear: 2024 },
    { cpu: 'APPLE M2 MAX', gpu: 'APPLE M2 MAX 16-CORE INTEGRATED' },
  ] satisfies Partial<HardwareProfile>[]) {
    const changedPeers = validPeers.map((peer) => laptop(peer.raw.id, peer.raw.price,
      { ...peer.assessment.profile, ...changed }, { title: peer.raw.title, description: peer.raw.description }));
    assert.deepEqual(adjustmentRequirements(candidate.raw, candidate.assessment, changedPeers[0]!.raw, changedPeers[0]!.assessment), []);
    assert.equal(buildReference(candidate.raw, candidate.assessment, changedPeers, DEFAULT_SETTINGS, { ssd }).reference, null, JSON.stringify(changed));
  }
});

test('Mac laptop references never fall back to standalone desktop component totals', () => {
  const candidate = laptop('candidate', 10_000_000);
  const cpus = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`cpu-${i}`, 20_000_000, { category: 'cpu', title: 'Apple M2 Pro' }),
    assessment: assessment({ cpu: 'APPLE M2 PRO' }, { kind: 'cpu' }) }));
  assert.equal(buildReference(candidate.raw, candidate.assessment, [], DEFAULT_SETTINGS, { cpu: cpus }).reference, null);
});

test('Windows laptop exact matching remains independent of optional Mac identity fields', () => {
  const windows = macProfile({ model: 'LENOVO THINKPAD T480', cpu: 'I5-8350U', gpu: 'UHD 620',
    cpuCores: undefined, gpuCores: undefined, modelYear: undefined, screenInches: undefined });
  assert.equal(configurationsMatch('laptop', windows, windows), true);
  assert.equal(configurationsMatch('laptop', windows, { ...windows, screenInches: 15, modelYear: 2021, gpuCores: 16, cpuCores: 8 }), true);
  assert.equal(configurationsMatch('laptop', windows, { ...windows, model: 'LENOVO THINKPAD T490' }), false);
  const intelCoreM = { ...windows, model: 'LENOVO YOGA 700', cpu: 'CORE M3-6Y30' };
  assert.equal(configurationsMatch('laptop', intelCoreM, intelCoreM), true);
});

test('policy four evidence cannot retain a deal score after the Mac identity policy changes', () => {
  assert.equal(REFERENCE_POLICY_VERSION, 5);
  const candidate = laptop('candidate', 20_000_000);
  const reference = buildReference(candidate.raw, candidate.assessment, peers(), DEFAULT_SETTINGS).reference!;
  const value = valueListing(candidate.raw, candidate.assessment, { ...reference, policyVersion: 4 }, DEFAULT_SETTINGS, EMPTY_STATE);
  assert.equal(value.status, 'insufficient_evidence');
  assert.equal(value.reference, null);
  assert.equal(value.opportunity, false);
});
