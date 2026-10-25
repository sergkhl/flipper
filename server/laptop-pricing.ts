import type { HardwareProfile, ReferencePrice } from '../shared/types.ts';
import { freshDate, toUsd, validFx, type FxSnapshot, type LaptopClass, type LaptopPriceEvidence, type RetailLookup, type RetailPrice } from '../shared/retail.ts';
import { cpuModels, normalize } from './hardware.ts';

export const LAPTOP_PRICE_POLICY = 1;
export const RETENTION: Record<LaptopClass, readonly number[]> = {
  apple_silicon: [.85, .70, .40, .25], business: [.80, .60, .30, .15], consumer: [.75, .55, .25, .10],
};
const YEARS = [0, 1, 3, 5];
const YEAR_MS = 365.25 * 86_400_000;
const key = (value: string | null | undefined) => normalize(value ?? '').replace(/^(?:apple|dell|lenovo|hp|asus|acer|msi|intel core)\s+/, '').replace(/[^a-z0-9]/g, '');
const silicon = (p: HardwareProfile) => /^(?:apple(?: silicon)? )?m\d+\b/i.test(p.cpu ?? '');

function cpuKey(value: string | null): string | null {
  const text = normalize(value ?? '');
  if (cpuModels(text).length > 1) return null;
  // Normalize only a complete stated Intel identifier and known redundant text.
  // A family/generation alone is never expanded into an assumed processor SKU.
  const intel = text.match(/^(?:intel(?: core)?\s+)?(i[3579])\s*[- ]?\s*(?:(\d{1,2})(?:st|nd|rd|th)(?:\s+gen(?:eration)?)?\s+)?(\d{4,5}(?:g[147]|[a-z]{0,3}))(?:\s+(tiger lake))?$/);
  if (!intel) return key(value);
  const [, family, statedGeneration, sku, architecture] = intel;
  const generation = /^(?:10|11|12|13|14)/.test(sku) ? sku.slice(0,2) : sku[0];
  if (statedGeneration && statedGeneration !== generation || architecture && generation !== '11') return null;
  return key(`${family}-${sku}`);
}

/** Unknown fields permit a displayed range, never an exact-configuration verdict. */
export function retailMatch(a: HardwareProfile, b: HardwareProfile): 'exact' | 'partial' | 'different' {
  const model = (p: HardwareProfile) => normalize(p.model ?? '').match(/mac\s*book\s*(air|pro|neo)/)?.[0].replace(/\s+/g,'')
    ?? key(p.model?.replace(/\+/g, ' plus ')).replace(/20\d{2}/g, '');
  if (!a.model || !b.model || model(a) !== model(b)) return 'different';
  let partial = false;
  const compare = (left: unknown, right: unknown, required = true) => {
    if (left == null || right == null || left === '' || right === '') { if (required) partial = true; return true; }
    return left === right;
  };
  const aCpu = cpuKey(a.cpu), bCpu = cpuKey(b.cpu);
  if (aCpu === null || bCpu === null) return 'different';
  if (!compare(aCpu, bCpu) || !compare(a.ramGb, b.ramGb) || !compare(a.storageGb, b.storageGb)
    || !compare(a.modelYear, b.modelYear, false) || !compare(a.gpuClass, b.gpuClass)) return 'different';
  const mac = /macbook/.test(model(a));
  if (mac) {
    const consistent = (p: HardwareProfile) => {
      const namedSize = normalize(p.model ?? '').match(/mac\s*book\s*(?:air|pro|neo)\s+(1[1-7](?:[.,]\d)?)/)?.[1];
      const years = [...(p.model ?? '').matchAll(/\b(20\d{2})\b/g)].map(m => Number(m[1]));
      const gpuCores = [...(p.gpu ?? '').matchAll(/\b(\d+)\s*[- ]?\s*cores?\b/gi)].map(m => Number(m[1]));
      return !(namedSize && p.screenInches && Math.floor(Number(namedSize.replace(',','.'))) !== Math.floor(p.screenInches))
        && new Set(years).size <= 1 && !(p.modelYear && years.some(year => year !== p.modelYear))
        && new Set(gpuCores).size <= 1 && !(p.gpuCores && gpuCores.some(count => count !== p.gpuCores));
    };
    if (!consistent(a) || !consistent(b)) return 'different';
    const size = (p: HardwareProfile) => p.screenInches ? Math.floor(p.screenInches) : Number(p.model?.match(/\b(1[2-7])\b/)?.[1]) || null;
    if (!compare(size(a), size(b))) return 'different';
    if (silicon(a)) {
      if (!compare(a.cpuCores, b.cpuCores) || !compare(a.gpuCores, b.gpuCores)) return 'different';
    } else if (!compare(a.modelYear, b.modelYear)) return 'different';
  }
  if (!silicon(a) && (!compare(key(a.gpu), key(b.gpu))
    || a.gpuClass !== 'integrated' && !compare(a.vramGb, b.vramGb))) return 'different';
  if (!compare(a.ramType, b.ramType, false) || !compare(a.screenInches, b.screenInches, false) && !mac) return 'different';
  return partial ? 'partial' : 'exact';
}

export function laptopClass(p: HardwareProfile): LaptopClass | null {
  if (silicon(p)) return 'apple_silicon';
  const model = normalize(p.model ?? '');
  if (/thinkpad|latitude|precision|elitebook|zbook|probook|xps|spectre|surface|zenbook|expertbook/.test(model)) return 'business';
  if (/macbook|inspiron|vostro|ideapad|thinkbook|yoga|legion|loq|vivobook|tuf|rog|aspire|nitro|predator|pavilion|victus|omen|katana|modern|swift/.test(model)) return 'consumer';
  return null;
}
export function retainedFraction(kind: LaptopClass, age: number): number {
  const values = RETENTION[kind]; age = Math.max(0, age);
  for (let i = 1; i < YEARS.length; i++) if (age <= YEARS[i]) {
    return values[i-1] + (values[i] - values[i-1]) * (age - YEARS[i-1]) / (YEARS[i] - YEARS[i-1]);
  }
  return values[3] * .8 ** (age - 5);
}
function releaseRange(offer: RetailPrice, profile: HardwareProfile, now: number): [number, number] | null {
  if (offer.releaseDate && offer.releaseSourceUrl) {
    const stamp = Date.parse(offer.releaseDate);
    if (Number.isFinite(stamp) && stamp <= now) return [(now-stamp)/YEAR_MS, (now-stamp)/YEAR_MS];
  }
  const year = offer.releaseYear ?? profile.modelYear;
  if (!year || year < 1990 || year > new Date(now).getUTCFullYear()) return null;
  return [Math.max(0, (now-Date.UTC(year+1,0,1))/YEAR_MS), (now-Date.UTC(year,0,1))/YEAR_MS];
}
function launchEvidence(offer: RetailPrice): boolean {
  if (offer.basis === 'current_new' || !offer.priceDate || !offer.releaseSourceUrl) return false;
  if (!offer.releaseDate) return !!offer.releaseYear && new Date(offer.priceDate).getUTCFullYear() === offer.releaseYear;
  const gap = Date.parse(offer.priceDate) - Date.parse(offer.releaseDate);
  return Number.isFinite(gap) && gap >= 0 && gap <= 90 * 86_400_000;
}

export function laptopReference(profile: HardwareProfile, lookup: RetailLookup | null, history: RetailPrice[],
  fx: FxSnapshot | null, now = Date.now()): { reference: ReferencePrice | null; reason: string } {
  if (!validFx(fx, now)) return { reference: null, reason: 'A current USD exchange-rate snapshot is unavailable. Refresh before comparing prices.' };
  const matches = (offers: RetailPrice[]) => offers.filter(o => o.amount > 0 && Number.isFinite(o.amount)
    && toUsd(o.amount, o.currency, fx) != null && retailMatch(profile, o.profile) !== 'different');
  const current = matches(lookup?.offers ?? []).filter(o => o.basis === 'current_new' && o.available && freshDate(o.observedAt, now));
  const credible = current.filter(o => o.totalCostKnown && o.shipsToVietnam && retailMatch(profile,o.profile) === 'exact');
  const historical = matches(history).filter(launchEvidence);
  const domesticHistory = historical.filter(o => o.market === 'VN');
  const reasons: string[] = [];
  let sources: RetailPrice[], basis: LaptopPriceEvidence['basis'];
  if (credible.length) { sources = credible; basis = 'current_new'; }
  else if (domesticHistory.length || historical.length) {
    sources = domesticHistory.length ? domesticHistory : historical; basis = 'historical_depreciation';
    // A direct launch retail observation takes precedence over launch MSRP.
    if (sources.some(o => o.basis === 'launch_retail')) sources = sources.filter(o => o.basis === 'launch_retail');
    const exact = sources.filter(o => retailMatch(profile,o.profile) === 'exact');
    if (exact.length) sources = exact;
  } else if (current.length) { sources = current; basis = 'current_new'; }
  else return { reference: null, reason: lookup?.status === 'failed'
    ? `Current retail lookup failed; no supported historical price is available. ${lookup.errors.join('; ')}`
    : 'No verified new or original launch price is available for this configuration. Analyze to check retail sources.' };
  sources = [...sources].sort((a,b) => toUsd(a.amount,a.currency,fx)! - toUsd(b.amount,b.currency,fx)!);
  const exact = sources.every(o => retailMatch(profile,o.profile) === 'exact');
  if (!exact) reasons.push('The exact configuration is incomplete; displayed prices cover possible variants.');
  const kind = laptopClass(profile);
  let ageRange: [number,number] | null = null, retention: number | null = null;
  let values: number[] = [], originalUsd: number | null = null;
  if (basis === 'current_new') {
    if (!credible.length) reasons.push('Vietnam delivery or the complete unconditional purchase cost is unverified.');
    values = sources.map(o => toUsd(o.amount,o.currency,fx)!);
  } else {
    if (!lookup || lookup.status !== 'complete' || !freshDate(lookup.checkedAt, now)
      || lookup.offers.some(o => !freshDate(o.observedAt,now))) {
      reasons.push('A successful current retail lookup is needed before historical depreciation can give a verdict.');
      if (lookup?.errors.length) reasons.push(...lookup.errors);
    }
    if (current.some(o => o.market === 'VN' && retailMatch(profile,o.profile) !== 'exact')) reasons.push('A possible new offer has incomplete configuration evidence.');
    if (lookup?.offers.some(o => o.available && o.totalCostKnown && o.shipsToVietnam && freshDate(o.observedAt,now)
      && retailMatch(profile,o.profile) !== 'different' && toUsd(o.amount,o.currency,fx) === null)) reasons.push('A matching new offer uses an unavailable exchange rate.');
    if (sources.some(o => o.market !== 'VN')) reasons.push('Foreign launch price converted at current FX; Vietnam import costs are unknown.');
    if (!kind) reasons.push('Laptop depreciation class is uncertain.');
    const ages = sources.map(o => releaseRange(o,profile,now));
    if (ages.some(age => !age)) return { reference: null, reason: 'The model release date or year is unknown; historical depreciation cannot be calculated.' };
    ageRange = [Math.min(...ages.map(age => age![0])), Math.max(...ages.map(age => age![1]))];
    if (ageRange[0] !== ageRange[1] || sources.some(o => !o.releaseDate)) reasons.push('Release timing and the first-90-day launch window are uncertain; the estimate shows an age range.');
    if (ageRange[1] > 8) reasons.push('Models over eight years old receive indicative estimates only.');
    const classes = kind ? [kind] : Object.keys(RETENTION) as LaptopClass[];
    values = sources.flatMap((o,i) => classes.flatMap(c => ages[i]!.map(age => toUsd(o.amount,o.currency,fx)! * retainedFraction(c,age))));
    originalUsd = toUsd(sources[0].amount,sources[0].currency,fx)!;
    if (new Set(sources.map(o => toUsd(o.amount,o.currency,fx))).size > 1) reasons.push('Original prices differ across sources or possible configurations; the estimate is a range.');
    if (kind && ageRange[0] === ageRange[1]) retention = retainedFraction(kind,ageRange[0]);
  }
  const range: [number,number] = [Math.min(...values),Math.max(...values)], referenceUsd = range[0];
  const evidence: LaptopPriceEvidence = { policyVersion: LAPTOP_PRICE_POLICY, basis, indicative: reasons.length > 0,
    reasons, sources, checkedAt: lookup?.checkedAt ?? null, lookupStatus: lookup?.status ?? 'not_checked', laptopClass: kind,
    ageYears: ageRange && ageRange[0] === ageRange[1] ? ageRange[0] : null, ageRange, retention, originalUsd,
    referenceUsd, rangeUsd: range, fx };
  const label = basis === 'current_new' ? 'Lowest verified new retail price' : 'Depreciation estimate';
  const methodology = basis === 'current_new'
    ? 'Lowest matching factory-new cash price, including known tax and mandatory delivery to Vietnam. The used asking price is compared directly with this current new price.'
    : 'Original launch retail price (or explicitly labeled launch MSRP) × retained value for age since model release. Policy estimates, not observed resale prices.';
  return { reference: { kind: basis === 'current_new' ? 'retail_new' : 'historical_depreciation', retail: evidence,
    label, average: referenceUsd*fx.rates.VND, min: range[0]*fx.rates.VND, max: range[1]*fx.rates.VND,
    sampleCount: new Set(sources.map(source => source.url)).size, offers: [], components: [], rejected: [], observedAt: sources[0].observedAt, methodology },
    reason: reasons.length ? reasons.join(' ') : `${label}. Working-used condition assumed; battery health and wear are unverified.` };
}
