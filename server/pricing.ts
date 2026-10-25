import type { AdjustedComparable, AppSettings, Assessment, Category, ComparableOffer, ComponentAdjustment, ComponentReference, HardwareKind, HardwareProfile, ListingState, RawListing, ReferencePrice, Valuation } from '../shared/types.ts';
import { normalize, sourceUnavailable } from './hardware.ts';
import { enrichComputerAssessment, expandPricedConfigurations } from './computer.ts';
import { freshDate, validFx } from '../shared/retail.ts';
import { LAPTOP_PRICE_POLICY } from './laptop-pricing.ts';

export interface AssessedListing { raw: RawListing; assessment: Assessment; }
export interface ReferenceResult { reference: ReferencePrice | null; reason: string; matched: number; }
export const REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Rebuild cohorts after separating MacBook screen sizes and Apple Silicon core bins.
export const REFERENCE_POLICY_VERSION = 5;
export const INDICATIVE_MIN_COMPARABLES = 3;

function same(a: string | number | null, b: string | number | null): boolean {
  return a != null && b != null && normalize(String(a)) === normalize(String(b));
}
function modelKey(model: string | null): string | null {
  return model ? normalize(model).replace(/^(?:dell|lenovo|hp|asus|acer|msi|apple)\s+/, '') : null;
}
function macFamily(profile: HardwareProfile): string | null {
  const match = normalize(profile.model ?? '').match(/\bmac\s*book(?:\s*(air|pro|neo))?\b/);
  return match ? `macbook${match[1] ? ` ${match[1]}` : ''}` : null;
}
function appleSilicon(profile: HardwareProfile): boolean {
  return /^(?:apple(?:\s+silicon)?\s+)?m\d+\b|^apple\s+a\d+\b/i.test(profile.cpu ?? '');
}
function nominalMacScreen(size: number): number {
  if ([13, 13.3, 13.6].includes(size)) return 13;
  if ([14, 14.2].includes(size)) return 14;
  if ([15, 15.3, 15.4].includes(size)) return 15;
  if ([16, 16.2].includes(size)) return 16;
  return size;
}
function macScreen(profile: HardwareProfile): number | null {
  const claimed = [...(profile.model ?? '').matchAll(/\b(1[2-7](?:[.,]\d)?)\b/g)]
    .map((match) => Number(match[1]!.replace(',', '.')));
  if (profile.screenInches != null) claimed.push(profile.screenInches);
  const sizes = [...new Set(claimed.filter((size) => Number.isFinite(size) && size >= 10 && size <= 20).map(nominalMacScreen))];
  return sizes.length === 1 ? sizes[0]! : null;
}
function macYears(profile: HardwareProfile): number[] {
  return [...new Set([...(profile.model ?? '').matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]))
    .concat(profile.modelYear != null ? [profile.modelYear] : []).filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100))];
}
function macGpuCores(profile: HardwareProfile): number | null {
  const cores = [...(profile.gpu ?? '').matchAll(/\b(\d{1,3})\s*[- ]?\s*cores?\b/gi)].map((match) => Number(match[1]));
  if (profile.gpuCores != null) cores.push(profile.gpuCores);
  const bins = [...new Set(cores.filter((count) => Number.isInteger(count) && count > 0))];
  return bins.length === 1 ? bins[0]! : null;
}
/** Mac family names alone identify several materially different laptop configurations. */
function laptopIdentityMismatch(a: HardwareProfile, b: HardwareProfile): string | null {
  const familyA = macFamily(a), familyB = macFamily(b);
  const macA = familyA != null || appleSilicon(a), macB = familyB != null || appleSilicon(b);
  if (!macA && !macB) return same(modelKey(a.model), modelKey(b.model)) ? null : 'Different or unspecified laptop model';
  if (!familyA || !familyB || familyA !== familyB) return 'Different or unspecified MacBook family';
  const sizeA = macScreen(a), sizeB = macScreen(b);
  if (sizeA == null || sizeB == null) return 'MacBook screen size is unknown or conflicting; an exact laptop comparison is required';
  if (sizeA !== sizeB) return 'Different MacBook screen sizes';
  const yearsA = macYears(a), yearsB = macYears(b);
  if (yearsA.length > 1 || yearsB.length > 1 || yearsA.length && yearsB.length && yearsA[0] !== yearsB[0]) return 'Different or conflicting MacBook model years';
  if (!cpuMatches(a, b)) return 'MacBook chip or Intel CPU model is different or unspecified';
  if (appleSilicon(a) || appleSilicon(b)) {
    const coresA = macGpuCores(a), coresB = macGpuCores(b);
    if (coresA == null || coresB == null) return 'Apple Silicon GPU core count is unknown or conflicting; an exact chip bin is required';
    if (coresA !== coresB) return 'Different Apple Silicon GPU core counts';
    if (a.gpuClass !== 'integrated' || b.gpuClass !== 'integrated') return 'Apple Silicon integrated GPU identity is unverified';
    if (a.cpuCores != null && b.cpuCores != null && a.cpuCores !== b.cpuCores) return 'Different Apple Silicon CPU core counts';
  }
  return null;
}
function gpuMemoryMatches(a: HardwareProfile, b: HardwareProfile): boolean {
  return /^(?:GT 730|GT 1030|GTX 1650)$/.test(a.gpu ?? '')
    ? same(a.gpuMemoryType, b.gpuMemoryType)
    : !(a.gpuMemoryType && b.gpuMemoryType) || same(a.gpuMemoryType, b.gpuMemoryType);
}

function cpuMatches(a: HardwareProfile, b: HardwareProfile): boolean {
  const key = (cpu: string | null) => cpu ? normalize(cpu).replace(/\bryzen\s*([3579])\b/, 'ryzen $1') : null;
  return same(key(a.cpu), key(b.cpu));
}
function noDiscreteGpu(profile: HardwareProfile): boolean {
  return profile.gpuInclusion === 'absent' || profile.gpuClass === 'integrated';
}
function computerGpuMatches(kind: HardwareKind, a: HardwareProfile, b: HardwareProfile): boolean {
  if (kind === 'desktop' && noDiscreteGpu(a) && noDiscreteGpu(b)) return true;
  return same(a.gpu, b.gpu) && same(a.gpuClass, b.gpuClass)
    && (a.gpuClass === 'integrated' || same(a.vramGb, b.vramGb)) && gpuMemoryMatches(a, b);
}

export function configurationsMatch(kind: HardwareKind, a: HardwareProfile, b: HardwareProfile): boolean {
  if (kind === 'gpu') {
    return same(a.gpu, b.gpu) && same(a.vramGb, b.vramGb) && b.gpuClass !== 'mobile'
      && gpuMemoryMatches(a, b);
  }
  if (kind === 'cpu') return cpuMatches(a, b);
  if (kind === 'ram') return same(a.perUnitGb, b.perUnitGb) && same(a.ramType, b.ramType)
    && same(a.ramFormFactor, b.ramFormFactor) && same(a.ramSpeedMhz, b.ramSpeedMhz)
    && (!(a.ramEcc || b.ramEcc) || same(a.ramEcc ?? null, b.ramEcc ?? null));
  if (kind === 'ssd') return same(a.storageGb, b.storageGb) && same(a.storageType, b.storageType) && a.storageType !== 'SSD';
  if (kind === 'laptop' && laptopIdentityMismatch(a, b)) return false;
  if (kind === 'desktop' && a.model && !same(modelKey(a.model), modelKey(b.model))) return false;
  if (!cpuMatches(a, b) || !computerGpuMatches(kind, a, b)
      || !same(a.ramGb, b.ramGb) || !same(a.storageGb, b.storageGb) || !same(a.storageType, b.storageType)) return false;
  if (a.ramType && !same(a.ramType, b.ramType)) return false;
  if (a.ramSpeedMhz && b.ramSpeedMhz && a.ramSpeedMhz !== b.ramSpeedMhz) return false;
  if (a.perUnitGb && b.perUnitGb && a.perUnitGb !== b.perUnitGb) return false;
  if (a.ramFormFactor && b.ramFormFactor && a.ramFormFactor !== b.ramFormFactor) return false;
  if (a.ramEcc && b.ramEcc && a.ramEcc !== b.ramEcc) return false;
  return true;
}

function offerFrom(raw: RawListing, reason?: string, price = raw.price): ComparableOffer {
  return { id: raw.id, sellerId: raw.sellerId, title: raw.title, price, url: raw.url,
    region: raw.region, observedAt: raw.observedAt, ...(reason ? { rejectedReason: reason } : {}) };
}
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function hasUnpricedDesktopExtras(raw: RawListing): boolean {
  return normalize(`${raw.title}\n${raw.description}`).split(/[\n;.!?]/).some((line) => {
    if (/\b(?:khong kem|khong co|chua kem|chua gom|chua bao gom|khong bao gom|without)\b/.test(line)) return false;
    return /\b(?:man hinh|monitor|lcd)\s*:?\s*\d{2}(?:[.,]\d)?\s*(?:inch|inches|in\b|")/.test(line)
      || /\b(?:kem|tang|bao gom|includes?)\b[^\n]{0,35}\b(?:man hinh|monitor|ban phim|chuot|keyboard|mouse)\b/.test(line);
  });
}

interface SellerIdentities { key(raw: RawListing): string; }
function contactKeys(raw: RawListing): string[] {
  const keys: string[] = [];
  const lines = raw.description.split('\n').map(normalize);
  for (const line of lines) {
    if (!/\b(?:sdt|so dien thoai|dien thoai|phone|tel|call|hotline|zalo|lien he|lh)\b|[☎📞]/u.test(line)) continue;
    if (/\b(?:bao hanh|warranty|support)\b/.test(line)) continue;
    for (const match of line.matchAll(/(?<!\d)(?:\+?84|0)(?:[ .()-]*\d){8,10}(?!\d)/g)) {
      let phone = match[0].replace(/\D/g, '');
      if (phone.startsWith('84')) phone = `0${phone.slice(2)}`;
      if (/^0[35789]\d{8}$|^02\d{9}$/.test(phone)) keys.push(`phone:${phone}`);
    }
  }
  const business = raw.sellerType === 'business' || lines.some((line) => /^(?:cua hang|shop|chi nhanh)\b|^cs\s*\d+\s*:/.test(line));
  if (!business) return keys;
  const locality = (value: string) => normalize(value).replace(/\b(?:tphcm|hcm|sai gon)\b/g, 'ho chi minh')
    .replace(/^(?:tp\.?|thanh pho|tinh|quan|q\.?|huyen|thi xa|phuong|p\.?|xa|ward)(?:\s+|(?=\d))/g, '').replace(/[.]/g, '').trim();
  const region = locality(raw.region);
  for (const line of lines) {
    const address = line.replace(/^[^a-z0-9]+/, '').replace(/^(?:(?:dia chi|dc|address|shop address|cua hang|chi nhanh|co so)(?:\s*\d+)?|cs\s*\d+)\s*[:.-]\s*/, '');
    const parts = address.split(',').map((part) => part.trim()).filter(Boolean);
    const street = parts[0] ?? '';
    // Require a complete house/street identity and an explicit locality. City-only
    // text, hardware specifications and unnumbered streets are never identity keys.
    if (!/^\d{1,4}[a-z]?(?:\/\d{1,4}[a-z]?)*(?:-\d{1,4}[a-z]?)?\s+[a-z][a-z0-9 .'-]{2,80}$/.test(street) || parts.length < 2) continue;
    const areas = parts.slice(1).map(locality).filter((part) => part && part !== region);
    if (!region || !areas.length || /\b(?:duong\s+)?so\s*\d+\b/.test(street) && areas.length < 2) continue;
    keys.push(`shop-address:${region}:${street.replace(/\b(?:duong|street)\s+/g, '').replace(/\s+/g, ' ')}:${areas.join(',')}`);
  }
  return keys;
}

/** Merge only explicit source identity evidence, including links across several accounts. */
function sellerIdentities(raws: RawListing[], now: number): SellerIdentities {
  const parents = new Map<string, string>();
  const find = (key: string): string => {
    const parent = parents.get(key);
    if (!parent) { parents.set(key, key); return key; }
    if (parent === key) return key;
    const root = find(parent); parents.set(key, root); return root;
  };
  const seen = new Set<string>();
  for (const raw of [...raws].sort((a, b) => b.observedAt.localeCompare(a.observedAt))) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    if (!raw.sellerId || freshnessInvalid(raw.observedAt, now)) continue;
    const account = find(`account:${raw.sellerId}`);
    for (const token of contactKeys(raw)) parents.set(find(token), find(account));
  }
  return { key: (raw) => find(raw.sellerId ? `account:${raw.sellerId}` : `listing:${raw.id}`) };
}

type AdjustableKind = 'gpu' | 'ram' | 'ssd';
interface AdjustmentTerm { kind: AdjustableKind; profile: HardwareProfile; operation: 'add' | 'remove'; quantity: number; }
interface AdjustmentPlan { terms: AdjustmentTerm[]; reason: string | null; missingDetails: string[]; }

function isComputer(kind: HardwareKind): boolean { return kind === 'desktop' || kind === 'laptop'; }
function platformMismatch(candidate: Assessment, peer: Assessment): string | null {
  if (candidate.kind !== peer.kind || !isComputer(candidate.kind)) return 'Different computer category';
  if (!cpuMatches(candidate.profile, peer.profile)) return 'CPU model is different or unspecified';
  if (candidate.kind === 'laptop') {
    const mismatch = laptopIdentityMismatch(candidate.profile, peer.profile);
    if (mismatch) return mismatch;
  }
  if (candidate.kind === 'desktop' && candidate.profile.model && peer.profile.model
    && !same(modelKey(candidate.profile.model), modelKey(peer.profile.model))) return 'Different desktop model/platform';
  const a = candidate.computer, b = peer.computer;
  if (a?.formFactor && b?.formFactor && a.formFactor !== b.formFactor) return 'Different computer form factor';
  if (a?.cpuCount && b?.cpuCount && a.cpuCount !== b.cpuCount) return 'Different processor count';
  if (a?.ramEcc && b?.ramEcc && a.ramEcc !== b.ramEcc) return 'Different ECC/registered-memory platform';
  if (candidate.profile.ramType && peer.profile.ramType && !same(candidate.profile.ramType, peer.profile.ramType)) return 'Different RAM-generation platform';
  return null;
}
function missingDetails(candidate: Assessment, peer?: Assessment): string[] {
  return [...new Set([...(candidate.computer?.missing ?? []), ...(peer?.computer?.missing ?? [])])];
}
function completeGpu(profile: HardwareProfile): boolean {
  return !!profile.gpu && profile.gpuClass === 'desktop' && !!profile.vramGb
    && (!/^(?:GT 730|GT 1030|GTX 1650)$/.test(profile.gpu) || !!profile.gpuMemoryType);
}
function completeRam(profile: HardwareProfile): boolean {
  return !!profile.ramGb && !!profile.perUnitGb && !!profile.quantity && Number.isInteger(profile.quantity)
    && profile.quantity * profile.perUnitGb === profile.ramGb && !!profile.ramType
    && (profile.ramFormFactor === 'DIMM' || profile.ramFormFactor === 'SODIMM') && !!profile.ramSpeedMhz && !!profile.ramEcc;
}
function completeStorage(profile: HardwareProfile): boolean {
  return !!profile.storageGb && !!profile.storageType && profile.storageType !== 'SSD' && profile.storageType !== 'HDD';
}
function planAdjustment(candidate: Assessment, peer: Assessment): AdjustmentPlan {
  const terms: AdjustmentTerm[] = [];
  const missing = missingDetails(candidate, peer);
  const blocked = (reason: string): AdjustmentPlan => ({ terms: [], reason, missingDetails: missing });
  const mismatch = platformMismatch(candidate, peer);
  if (mismatch) return blocked(mismatch);
  const a = candidate.profile, b = peer.profile;
  if (!computerGpuMatches(candidate.kind, a, b)) {
    if (candidate.kind === 'laptop') return blocked('Laptop CPU and mobile GPU must match; desktop GPU prices cannot substitute');
    if (!noDiscreteGpu(a) && !completeGpu(a) || !noDiscreteGpu(b) && !completeGpu(b)) return blocked('Included GPU or explicit GPU absence is unverified');
    if (!noDiscreteGpu(b)) terms.push({ kind: 'gpu', operation: 'remove', quantity: 1, profile: b });
    if (!noDiscreteGpu(a)) terms.push({ kind: 'gpu', operation: 'add', quantity: 1, profile: a });
  }
  if (!a.ramGb || !b.ramGb) return blocked('RAM capacity is unspecified');
  const ramDiffers = a.ramGb !== b.ramGb
    || !!(a.ramSpeedMhz && b.ramSpeedMhz && a.ramSpeedMhz !== b.ramSpeedMhz)
    || !!(a.perUnitGb && b.perUnitGb && a.perUnitGb !== b.perUnitGb);
  if (ramDiffers) {
    if (candidate.kind === 'laptop' && (candidate.computer?.ramReplaceable !== true || peer.computer?.ramReplaceable !== true)) return blocked('Laptop RAM replaceability is not verified for both configurations');
    if (!completeRam(a) || !completeRam(b)) return blocked('RAM adjustment needs verified stick count, size, generation, form factor, speed and ECC type');
    if (a.ramFormFactor !== b.ramFormFactor) return blocked('Different memory form factor');
    if (configurationsMatch('ram', a, b)) {
      const delta = a.quantity! - b.quantity!;
      if (delta) terms.push({ kind: 'ram', operation: delta > 0 ? 'add' : 'remove', quantity: Math.abs(delta), profile: delta > 0 ? a : b });
    } else {
      terms.push({ kind: 'ram', operation: 'remove', quantity: b.quantity!, profile: b },
        { kind: 'ram', operation: 'add', quantity: a.quantity!, profile: a });
    }
  }
  if (!a.storageGb || !b.storageGb || !a.storageType || !b.storageType) return blocked('Storage capacity or interface is unspecified');
  if (!same(a.storageGb, b.storageGb) || !same(a.storageType, b.storageType)) {
    if (candidate.kind === 'laptop' && (candidate.computer?.storageReplaceable !== true || peer.computer?.storageReplaceable !== true)) return blocked('Laptop storage replaceability is not verified for both configurations');
    if (!completeStorage(a) || !completeStorage(b)) return blocked('Storage adjustment needs verified SSD capacity and interface');
    terms.push({ kind: 'ssd', operation: 'remove', quantity: 1, profile: b },
      { kind: 'ssd', operation: 'add', quantity: 1, profile: a });
  }
  return { terms, reason: null, missingDetails: missing };
}

/** Component searches for a supported candidate/peer substitution. Expand priced peer variants first. */
export function adjustmentRequirements(candidateRaw: RawListing, candidateAssessment: Assessment,
  peerRaw: RawListing, peerAssessment: Assessment): Array<{ kind: AdjustableKind; profile: HardwareProfile }> {
  const plan = planAdjustment(enrichComputerAssessment(candidateRaw, candidateAssessment), enrichComputerAssessment(peerRaw, peerAssessment));
  if (plan.reason) return [];
  return plan.terms.filter((term, index) => plan.terms.findIndex((other) => other.kind === term.kind
    && configurationsMatch(term.kind, term.profile, other.profile)) === index).map(({ kind, profile }) => ({ kind, profile }));
}

function freshnessInvalid(observedAt: string, now: number): boolean {
  const observed = Date.parse(observedAt);
  return !Number.isFinite(observed) || now - observed > REFERENCE_MAX_AGE_MS;
}
function removeOutliers<T extends ComparableOffer>(selected: T[], rejected: ComparableOffer[]): T[] {
  if (selected.length < 4) return selected;
  const values = selected.map((offer) => offer.price).sort((a, b) => a - b);
  const median = quantile(values, 0.5), q1 = quantile(values, 0.25), q3 = quantile(values, 0.75);
  const spread = Math.max(q3 - q1, median * 0.1);
  const min = Math.max(0, q1 - 1.5 * spread), max = q3 + 1.5 * spread;
  return selected.filter((offer) => {
    if (offer.price < min || offer.price > max) {
      rejected.push({ ...offer, rejectedReason: 'Numeric outlier outside the robust price range' }); return false;
    }
    return true;
  });
}

export function filterComparableOffers(candidate: RawListing, profile: HardwareProfile, kind: HardwareKind,
  peers: AssessedListing[], now = Date.now(), identities = sellerIdentities([candidate, ...peers.map((peer) => peer.raw)], now)): { accepted: ComparableOffer[]; rejected: ComparableOffer[] } {
  if (!candidate.sellerId) return { accepted:[], rejected:peers.map(({raw}) => offerFrom(raw, 'Candidate seller is unknown; own-seller offers cannot be excluded')) };
  const selected: ComparableOffer[] = [];
  const rejected: ComparableOffer[] = [];
  const sellers = new Set<string>();
  const ids = new Set<string>();
  // Select the latest observation for each advertisement before grouping independent sellers.
  for (const { raw, assessment } of [...peers].sort((a, b) => b.raw.observedAt.localeCompare(a.raw.observedAt))) {
    let reason = '';
    if (raw.id === candidate.id || identities.key(raw) === identities.key(candidate)) reason = 'Candidate or the same seller/account-linked business';
    else if (ids.has(raw.id)) reason = 'Duplicate advertisement';
    else if (!raw.sellerId) reason = 'Independent seller cannot be verified';
    else if (sellers.has(identities.key(raw))) reason = 'Duplicate seller/account-linked business';
    else if (raw.condition !== 'used' || assessment.eligibility !== 'eligible' || assessment.conflicts.length) reason = 'Condition or eligibility is not verified';
    else if (sourceUnavailable(raw)) reason = 'The source marks this listing as unavailable';
    else if (!raw.description.trim() || raw.attributes._detailError) reason = 'Complete seller description could not be verified';
    else if (assessment.kind !== kind || !configurationsMatch(kind, profile, assessment.profile)) reason = 'Different or incomplete configuration';
    else if (kind === 'desktop' && (hasUnpricedDesktopExtras(candidate) || hasUnpricedDesktopExtras(raw))) reason = 'Monitor or peripheral bundle is not independently valued';
    else if (['gpu','cpu','ssd'].includes(kind) && (assessment.profile.quantity !== 1 || assessment.profile.priceBasis === 'bundle')) reason = 'Single-component cash price is not verified';
    else if (kind === 'ram' && assessment.profile.priceBasis === 'bundle' && (!assessment.profile.quantity || assessment.profile.quantity < 1 || !Number.isInteger(assessment.profile.quantity))) reason = 'RAM bundle stick count is unverified';
    else if (kind === 'ram' && assessment.profile.priceBasis === 'item' && (assessment.profile.quantity ?? 1) > 1) reason = 'The asking price is not identified as per-stick or a complete RAM bundle';
    else if (!Number.isFinite(raw.price) || raw.price <= 0 || ['deposit', 'unknown'].includes(assessment.profile.priceBasis)) reason = 'Unusable cash price';
    else if (freshnessInvalid(raw.observedAt, now)) reason = 'Observation older than 24 hours or invalid timestamp';
    ids.add(raw.id);
    if (reason) { rejected.push(offerFrom(raw, reason)); continue; }
    let price = raw.price;
    if (kind === 'ram' && assessment.profile.priceBasis === 'bundle') price /= assessment.profile.quantity ?? 1;
    sellers.add(identities.key(raw));
    selected.push(offerFrom(raw, undefined, price));
  }
  return { accepted: removeOutliers(selected, rejected), rejected };
}

function average(offers: ComparableOffer[]): number { return offers.reduce((sum, offer) => sum + offer.price, 0) / offers.length; }
function labelFor(kind: HardwareKind, profile: HardwareProfile): string {
  if (kind === 'gpu') return `${profile.gpu} · ${profile.vramGb} GB${profile.gpuMemoryType ? ` ${profile.gpuMemoryType}` : ''}`;
  if (kind === 'cpu') return profile.cpu ?? 'Processor';
  if (kind === 'ssd') return `${profile.storageGb} GB ${profile.storageType}`;
  if (kind === 'ram') return `${profile.perUnitGb} GB ${profile.ramType} ${profile.ramFormFactor} ${profile.ramSpeedMhz} MHz${profile.ramEcc ? ` ${profile.ramEcc}` : ''} per stick`;
  return [profile.model, profile.cpu, profile.gpu ?? (noDiscreteGpu(profile) ? 'No discrete GPU' : null), `${profile.ramGb ?? '?'} GB RAM`, `${profile.storageGb ?? '?'} GB ${profile.storageType ?? 'storage'}`].filter(Boolean).join(' · ');
}

function latestComputerOptions(peers: AssessedListing[]): AssessedListing[][] {
  const ids = new Set<string>();
  return [...peers].sort((a, b) => b.raw.observedAt.localeCompare(a.raw.observedAt)).flatMap(({ raw, assessment }) => {
    if (ids.has(raw.id)) return [];
    ids.add(raw.id);
    return [expandPricedConfigurations(raw, enrichComputerAssessment(raw, assessment))];
  });
}

function adjustedReference(candidate: RawListing, assessment: Assessment, options: AssessedListing[][],
  componentPools: Partial<Record<'gpu' | 'ram' | 'cpu' | 'ssd', AssessedListing[]>>, now: number,
  methodology: string, identities: SellerIdentities, required: number): { reference: ReferencePrice | null; rejected: ComparableOffer[] } {
  const selected: AdjustedComparable[] = [], rejected: ComparableOffer[] = [];
  const sellers = new Set<string>();
  const supportCount = (offer: AdjustedComparable) => Math.min(Infinity, ...offer.adjustments.map((term) => term.offers.length));
  for (const variants of options) {
    const first = variants[0];
    if (!first) continue;
    const raw = first.raw;
    let reason = '';
    if (raw.id === candidate.id || identities.key(raw) === identities.key(candidate)) reason = 'Candidate or the same seller/account-linked business';
    else if (!raw.sellerId) reason = 'Independent seller cannot be verified';
    else if (sellers.has(identities.key(raw))) reason = 'Duplicate seller/account-linked business';
    else if (raw.condition !== 'used') reason = 'Condition or eligibility is not verified';
    else if (sourceUnavailable(raw)) reason = 'The source marks this listing as unavailable';
    else if (!raw.description.trim() || raw.attributes._detailError) reason = 'Complete seller description could not be verified';
    else if (freshnessInvalid(raw.observedAt, now)) reason = 'Observation older than 24 hours or invalid timestamp';
    else if (assessment.kind === 'desktop' && (hasUnpricedDesktopExtras(candidate) || hasUnpricedDesktopExtras(raw))) reason = 'Monitor or peripheral bundle is not independently valued';
    if (reason) { rejected.push(offerFrom(raw, reason)); continue; }
    const supported: AdjustedComparable[] = [];
    for (const variant of variants) {
      const peer = variant.assessment, peerRaw = variant.raw;
      if (peer.eligibility !== 'eligible' || peer.conflicts.length) { reason = 'Condition or eligibility is not verified'; continue; }
      if (!Number.isFinite(peerRaw.price) || peerRaw.price <= 0 || ['deposit', 'unknown'].includes(peer.profile.priceBasis)) { reason = 'Unusable cash price'; continue; }
      const plan = planAdjustment(assessment, peer);
      if (plan.reason) { reason = plan.reason; continue; }
      const adjustments: ComponentAdjustment[] = [];
      let unsupported = false;
      for (const term of plan.terms) {
        // A PC seller's component advertisements cannot support the adjustment to that same PC.
        const pool = (componentPools[term.kind] ?? []).filter(({ raw: component }) => {
          if (component.id === raw.id || identities.key(component) === identities.key(raw)) {
            rejected.push(offerFrom(component, 'Component evidence belongs to the base PC seller or linked business')); return false;
          }
          return true;
        });
        const filtered = filterComparableOffers(candidate, term.profile, term.kind, pool, now, identities);
        rejected.push(...filtered.rejected);
        if (filtered.accepted.length < INDICATIVE_MIN_COMPARABLES) {
          reason = `Only ${filtered.accepted.length} independent offers support ${term.operation === 'add' ? 'adding' : 'removing'} ${labelFor(term.kind, term.profile)}; at least ${INDICATIVE_MIN_COMPARABLES} are required`;
          unsupported = true; break;
        }
        const mean = average(filtered.accepted);
        adjustments.push({ kind: term.kind, operation: term.operation, label: labelFor(term.kind, term.profile),
          quantity: term.quantity, average: mean, total: mean * term.quantity, offers: filtered.accepted });
      }
      if (unsupported) continue;
      const price = peerRaw.price + adjustments.reduce((sum, term) => sum + (term.operation === 'add' ? term.total : -term.total), 0);
      if (!Number.isFinite(price) || price <= 0) { reason = 'Component subtraction leaves no positive supported system value'; continue; }
      supported.push({ ...offerFrom(peerRaw, undefined, price), askingPrice: peerRaw.price,
        configurationLabel: labelFor(peer.kind, peer.profile), adjustments, missingDetails: plan.missingDetails });
    }
    // Multiple advertised configurations from one PC never create multiple independent observations.
    supported.sort((a, b) => Number(supportCount(b) >= required) - Number(supportCount(a) >= required)
      || a.adjustments.length - b.adjustments.length || supportCount(b) - supportCount(a));
    if (supported[0]) { selected.push(supported[0]); sellers.add(identities.key(raw)); }
    else rejected.push(offerFrom(raw, reason || 'No supported comparable configuration'));
  }
  // Adding a weakly supported optional comparison must not downgrade an already
  // sufficient group. Select on evidence strength, never on the resulting discount.
  const scoringOutliers: ComparableOffer[] = [];
  const scoringSubset = removeOutliers(selected.filter((offer) => supportCount(offer) >= required), scoringOutliers);
  const accepted = scoringSubset.length >= required ? scoringSubset : removeOutliers(selected, rejected);
  if (scoringSubset.length >= required) {
    rejected.push(...scoringOutliers, ...selected.filter((offer) => supportCount(offer) < required).map((offer) => ({
      ...offer, rejectedReason: `A sufficient scoring group is available; this optional comparison has fewer than ${required} sellers in a required component pool`,
    })));
  }
  if (accepted.length < INDICATIVE_MIN_COMPARABLES || !accepted.some((offer) => offer.adjustments.length)) return { reference: null, rejected };
  const sampleCount = Math.min(accepted.length, ...accepted.flatMap((offer) => offer.adjustments.map((term) => term.offers.length)));
  return { reference: { policyVersion: REFERENCE_POLICY_VERSION, kind: 'adjusted_configuration',
    label: `Component-adjusted ${labelFor(assessment.kind, assessment.profile)}`, average: average(accepted),
    offers: accepted, adjustedOffers: accepted, rejected, components: [], sampleCount, baseSampleCount: accepted.length,
    observedAt: new Date(now).toISOString(), min: Math.min(...accepted.map((offer) => offer.price)), max: Math.max(...accepted.map((offer) => offer.price)),
    missingDetails: [...new Set(accepted.flatMap((offer) => offer.missingDetails))],
    methodology: `${methodology} Each computer asking price is normalized by subtracting independently supported removed-part averages and adding added-part averages. CPU/platform stays comparable; laptop changes require verified replaceability. One computer configuration per advertisement and seller contributes to the average. A sufficient group in which every component pool meets the scoring minimum takes precedence over optional weaker comparisons. Otherwise all supported indicative comparisons are considered. The evidence count is the smaller of the independent computer count and every required component-pool count; PC/component combinations do not multiply the sample. The range covers normalized computer prices. Unspecified base-system details remain visible and reduce confidence without blocking scoring.` }, rejected };
}

export function buildReference(candidate: RawListing, assessment: Assessment, peers: AssessedListing[], settings: AppSettings,
  componentPools: Partial<Record<'gpu' | 'ram' | 'cpu' | 'ssd', AssessedListing[]>> = {}, now = Date.now()): ReferenceResult {
  if (!candidate.sellerId) return { reference:null, matched:0, reason:'The candidate seller cannot be identified, so own-seller offers cannot be excluded from a reference' };
  assessment = enrichComputerAssessment(candidate, assessment);
  const kind = assessment.kind;
  const identities = sellerIdentities([candidate, ...peers.map((peer) => peer.raw),
    ...Object.values(componentPools).flatMap((pool) => pool.map((peer) => peer.raw))], now);
  const options = isComputer(kind) ? latestComputerOptions(peers) : [];
  const directPeers = isComputer(kind) ? options.map((variants) => variants.find((peer) => !platformMismatch(assessment, peer.assessment)
    && configurationsMatch(kind, assessment.profile, peer.assessment.profile)) ?? variants[0]!).filter(Boolean) : peers;
  const platformRejected = directPeers.filter((peer) => isComputer(kind) && platformMismatch(assessment, peer.assessment));
  const full = filterComparableOffers(candidate, assessment.profile, kind, directPeers.filter((peer) => !platformRejected.includes(peer)), now, identities);
  full.rejected.push(...platformRejected.map((peer) => offerFrom(peer.raw, platformMismatch(assessment, peer.assessment)!)));
  const required = Math.max(5, settings.minComparables);
  const methodology = 'Arithmetic mean of matching nationwide used Chợ Tốt asking prices, one offer per seller account after merging accounts linked by an exact explicit contact phone or numbered shop street address and locality. This listing, its seller and linked accounts are excluded. Distinct unlinked accounts are treated as separate seller observations; account IDs do not establish independent businesses. Outliers use Q1/Q3 ± 1.5 × max(IQR, 10% of median). Observations expire after 24 hours. Asking prices are not completed-sale prices.';
  const direct: ReferenceResult | null = full.accepted.length >= INDICATIVE_MIN_COMPARABLES
    ? { reference: { policyVersion:REFERENCE_POLICY_VERSION, kind: kind === 'desktop' ? 'configuration' : 'model', label: labelFor(kind, assessment.profile),
      average: average(full.accepted), offers: full.accepted, rejected: full.rejected, components: [], sampleCount: full.accepted.length,
      observedAt: new Date(now).toISOString(), min: Math.min(...full.accepted.map((o) => o.price)), max: Math.max(...full.accepted.map((o) => o.price)), methodology,
      ...(isComputer(kind) ? { missingDetails: [...new Set([...missingDetails(assessment), ...directPeers.filter((peer) => full.accepted.some((offer) => offer.id === peer.raw.id)).flatMap((peer) => missingDetails(peer.assessment))])] } : {}) },
      matched: full.accepted.length, reason: `${full.accepted.length} independent matching nationwide offers${full.accepted.length < required ? `; indicative only until ${required} offers are available` : ''}` }
    : null;
  if (direct && full.accepted.length >= required) return direct;
  let adjustedRejected: ComparableOffer[] = [];
  if (isComputer(kind)) {
    const adjusted = adjustedReference(candidate, assessment, options, componentPools, now, methodology, identities, required);
    adjustedRejected = adjusted.rejected;
    if (adjusted.reference && adjusted.reference.sampleCount > (direct?.reference?.sampleCount ?? 0)) {
      const ref = adjusted.reference;
      return { reference: ref, matched: ref.baseSampleCount!, reason: `${ref.baseSampleCount} independent computer offers normalized with component prices; weakest evidence pool has ${ref.sampleCount} independent offers${ref.sampleCount < required ? `, indicative only until every pool reaches ${required}` : ''}` };
    }
  }
  if (direct) return direct;
  if (kind === 'desktop') {
    const components: ComponentReference[] = [];
    const rejected = [...full.rejected, ...adjustedRejected];
    for (const componentKind of ['gpu', 'ram', 'cpu', 'ssd'] as const) {
      const profile = assessment.profile;
      if (componentKind === 'gpu' && (!profile.gpu || !profile.vramGb || profile.gpuClass !== 'desktop')) continue;
      if (componentKind === 'cpu' && !profile.cpu) continue;
      if (componentKind === 'ram' && (!profile.perUnitGb || !profile.quantity || !profile.ramType || profile.ramFormFactor !== 'DIMM' || !profile.ramSpeedMhz)) continue;
      if (componentKind === 'ssd' && (!profile.storageGb || !profile.storageType || profile.storageType === 'SSD')) continue;
      const pool = filterComparableOffers(candidate, profile, componentKind, componentPools[componentKind] ?? [], now, identities);
      rejected.push(...pool.rejected);
      if (pool.accepted.length >= required) components.push({ kind: componentKind, label: labelFor(componentKind, profile),
        quantity: componentKind === 'ram' ? profile.quantity! : 1, average: average(pool.accepted), offers: pool.accepted });
    }
    if (components.length) {
      const offers = components.flatMap((component) => component.offers);
      const floor = components.reduce((sum, component) => sum + component.average * component.quantity, 0);
      return { reference: { policyVersion:REFERENCE_POLICY_VERSION, kind: 'component_floor', label: `Partial component baseline: ${components.map((c) => c.kind.toUpperCase()).join(' + ')}`,
        average: floor, offers, rejected, components, sampleCount: Math.min(...components.map((c) => c.offers.length)), observedAt: new Date(now).toISOString(),
        min: components.reduce((sum, c) => sum + Math.min(...c.offers.map((o) => o.price)) * c.quantity, 0),
        max: components.reduce((sum, c) => sum + Math.max(...c.offers.map((o) => o.price)) * c.quantity, 0), missingDetails: missingDetails(assessment),
        methodology: `${methodology} This sum values only the displayed components. Other parts, peripherals and assembly are unpriced; this is not a complete-system average.` },
      matched: offers.length, reason: 'Independently supported component values; the complete system has too few matching offers' };
    }
  }
  return { reference: null, matched: full.accepted.length,
    reason: `Only ${full.accepted.length} independent matching offers after filtering; at least ${INDICATIVE_MIN_COMPARABLES} are required for an indicative average and ${required} for scoring. ${adjustedRejected.some((offer) => offer.rejectedReason?.includes('independent offers support')) ? 'Component-adjusted comparisons lack independently supported prices for one or more required parts. ' : ''}Expand or refine the nationwide search.` };
}

export function valueListing(raw: RawListing, assessment: Assessment, reference: ReferencePrice | null, settings: AppSettings,
  state: ListingState, reason = 'No nationwide comparison has been collected'): Valuation {
  assessment = enrichComputerAssessment(raw, assessment);
  const category: Category = ['laptop', 'desktop', 'gpu'].includes(raw.category) ? raw.category as Category : 'desktop';
  const costReserve = state.costReserve ?? settings.costReserves[category];
  const missing = [...new Set([...missingDetails(assessment), ...(reference?.missingDetails ?? [])])];
  const empty: Valuation = { status: 'insufficient_evidence', reference: null, discountPercent: null, profit: null, roiPercent: null,
    opportunity: false, componentOpportunity: false, resaleOpportunity: false, confidence: 'low', reason, costReserve, expectedResale: null, maxBuyPrice: null,
    evidenceIssue: /^Only \d+ independent/.test(reason) ? 'insufficient_offers'
      : /Hardware interpretation changed/.test(reason) ? 'outdated_policy'
      : /No reliable model/.test(reason) ? 'configuration' : 'not_compared',
    ...(missing.length ? { missingDetails: missing } : {}) };
  if (sourceUnavailable(raw)) return { ...empty, status: 'needs_review', evidenceIssue: 'unavailable', reason: 'The original listing is no longer available; its last observed price is retained in history' };
  if (assessment.eligibility === 'excluded') return { ...empty, status: 'excluded', reason: assessment.risks.join('; ') || 'Excluded from working used items' };
  if (!raw.sellerId) return { ...empty, status:'needs_review', evidenceIssue:'configuration', reason:'Seller identity is missing; verify this listing before using a price verdict.' };
  if (assessment.kind === 'laptop') {
    const retail = reference?.retail;
    if (!retail || retail.policyVersion !== LAPTOP_PRICE_POLICY) return { ...empty, evidenceIssue: 'retail_price',
      reason: reference ? 'Analyze this laptop to replace its old used-market comparison with retail price evidence.' : reason };
    if (!validFx(retail.fx)) return { ...empty, evidenceIssue:'exchange_rate', reason:'The USD exchange-rate snapshot has expired; refresh before comparing prices.' };
    const askingUsd = raw.price/retail.fx.rates.VND;
    const discountPercent = (retail.referenceUsd-askingUsd)/retail.referenceUsd*100;
    const indicative = (reason: string, evidenceIssue?: Valuation['evidenceIssue']): Valuation => ({ ...empty, status:'indicative', reference,
      reason, evidenceIssue, discountPercent:Number.isFinite(raw.price) && raw.price > 0 ? discountPercent : null });
    if (retail.indicative || assessment.eligibility !== 'eligible' || assessment.conflicts.length || !Number.isFinite(raw.price) || raw.price <= 0) {
      return indicative([...retail.reasons,...assessment.conflicts,...assessment.unknowns].join(' ') || 'Configuration needs review','configuration');
    }
    if (!raw.description.trim() || raw.attributes._detailError) return indicative('Retrieve the full seller description before using a price verdict.','missing_description');
    if (freshnessInvalid(raw.observedAt,Date.now())) return indicative('The asking price is older than 24 hours; refresh it before using a verdict.','stale_listing');
    if (retail.basis === 'current_new' && retail.sources.some(source => !freshDate(source.observedAt))
      || retail.basis === 'historical_depreciation' && (!retail.checkedAt || !freshDate(retail.checkedAt) || retail.lookupStatus !== 'complete')) {
      return indicative('Refresh the seven-day retail evidence before using a verdict.','stale_reference');
    }
    if (raw.price < reference.average*.1) return indicative('Verify the full cash asking price; it is below 10% of the supported reference.','unverified_price');
    return { ...empty, status:'valued', reference, discountPercent, opportunity:askingUsd < retail.referenceUsd,
      confidence:'medium', evidenceIssue:undefined, maxBuyPrice:reference.average,
      reason:`${retail.basis === 'current_new' ? 'Compared with new retail' : 'Compared with a depreciation estimate'}. Working-used condition assumed; battery health and wear are unverified.` };
  }
  if (assessment.eligibility === 'review' || assessment.conflicts.length || !Number.isFinite(raw.price) || raw.price <= 0) return { ...empty, status: 'needs_review', evidenceIssue: 'configuration', reason: [...assessment.conflicts, ...assessment.unknowns, ...assessment.risks].join('; ') || 'Configuration needs review' };
  if (assessment.kind === 'gpu' && (assessment.profile.quantity !== 1 || assessment.profile.priceBasis === 'bundle')) return { ...empty, status:'needs_review', evidenceIssue: 'unverified_price', reason:'The asking price for one graphics card must be verified before comparing prices' };
  if (/^(?:GT 730|GT 1030|GTX 1650)$/.test(assessment.profile.gpu ?? '') && !assessment.profile.gpuMemoryType) return { ...empty, status:'needs_review', evidenceIssue: 'configuration', reason:'The GPU memory-generation variant must be verified before comparing prices' };
  if (!reference) return empty;
  if (reference.policyVersion !== REFERENCE_POLICY_VERSION) return { ...empty, evidenceIssue: 'outdated_policy', reason:'Refresh this evidence to apply the current memory-type and configuration checks.' };
  if (!raw.description.trim() || raw.attributes._detailError) return { ...empty, status: 'needs_review', evidenceIssue: 'missing_description', reason: 'Retrieve the complete seller description before using a price score. Choose Analyze to check condition and cash-price details.' };
  if (freshnessInvalid(raw.observedAt, Date.now())) return { ...empty, evidenceIssue: 'stale_listing', reason: 'The local asking price is older than 24 hours or has an invalid observation time. Refresh it before using this valuation.' };
  const allEvidence = [...reference.offers, ...reference.components.flatMap((component) => component.offers),
    ...(reference.adjustedOffers ?? []).flatMap((offer) => offer.adjustments.flatMap((term) => term.offers))];
  const expired = allEvidence.some((offer) => freshnessInvalid(offer.observedAt, Date.now()));
  const required = Math.max(5, settings.minComparables);
  if (expired || reference.sampleCount < INDICATIVE_MIN_COMPARABLES || reference.average <= 0) return { ...empty,
    evidenceIssue: expired ? 'stale_reference' : 'insufficient_offers',
    reason: expired ? 'Nationwide price evidence is older than 24 hours. Refresh before using this valuation.' : `At least ${INDICATIVE_MIN_COMPARABLES} comparable offers are required for an indicative average` };
  if (raw.price < reference.average * .1) return { ...empty, status:'needs_review', evidenceIssue: 'unverified_price', reason:'The advertised price is less than 10% of the supported reference. Verify that it is the full cash price for this item before treating it as a bargain.' };
  if (reference.sampleCount < required) return { ...empty, status: 'indicative', reference, evidenceIssue: undefined,
    reason: `Indicative average and observed range from ${reference.sampleCount} independent offers; at least ${required} are required for deal scoring.` };
  const expectedResale = state.expectedResale ?? Math.round(reference.average * settings.resaleFactor);
  const discountPercent = (reference.average - raw.price) / reference.average * 100;
  const profit = expectedResale - raw.price - costReserve;
  const roiPercent = profit / (raw.price + costReserve) * 100;
  const meetsThreshold = raw.price < reference.average;
  const componentOpportunity = reference.kind === 'component_floor' && meetsThreshold;
  const opportunity = reference.kind !== 'component_floor' && meetsThreshold;
  const resaleOpportunity = opportunity && profit >= settings.minProfit && roiPercent + 1e-9 >= settings.minRoiPercent;
  return { status: 'valued', reference, discountPercent, profit, roiPercent, opportunity, componentOpportunity, resaleOpportunity,
    confidence: reference.kind === 'component_floor' || missing.length ? 'low'
      : reference.kind !== 'adjusted_configuration' && reference.sampleCount >= 10 && assessment.confidence >= 0.8 ? 'high' : 'medium',
    reason: reference.kind === 'component_floor' ? 'Discount against a partial component baseline; inspect omitted parts and condition'
      : `${reason}${missing.length ? ` Missing details: ${missing.join(', ')}. Scoring is allowed with reduced confidence.` : ''}`,
    costReserve, expectedResale, maxBuyPrice: reference.average,
    ...(missing.length ? { missingDetails: missing } : {}) };
}
