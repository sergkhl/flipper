import { createHash } from 'node:crypto';
import type { Assessment, HardwareProfile, RawListing } from '../shared/types.ts';
import { freshDate, type DepreciatedPart, type DepreciatedRetailEstimate, type RetailLookup, type RetailPartKind, type RetailPrice } from '../shared/retail.ts';
import { normalize, sourceUnavailable } from './hardware.ts';
import type { RuntimeCache } from './price-cache.ts';
import { PublicRetailSources, RETAIL_SHOPS, ssdCapacityClass } from './retail-sources.ts';
import { concurrent } from './concurrency.ts';

export const PARTS_RETAIL_POLICY = 1;
export const PARTS_RETAIL_RETENTION = 0.75;
interface PartRequest { kind: RetailPartKind; profile: HardwareProfile; quantity: number; label: string; }
export interface PartsRetailSource {
  lookup(profile: HardwareProfile, signal?: AbortSignal, kind?: RetailPartKind): Promise<RetailLookup>;
}
const key = (s: string | null | undefined) => normalize(s ?? '').replace(/[^a-z0-9]/g,'');
function storageInterface(p: HardwareProfile): string | null {
  return /nvme/i.test(p.storageType ?? '') ? 'NVME' : /sata/i.test(p.storageType ?? '') ? 'SATA' : null;
}
/** CPU/GPU identities are exact; RAM and SSD brands are deliberately not part of the comparison. */
export function partMatch(kind: RetailPartKind, a: HardwareProfile, b: HardwareProfile): 'exact' | 'partial' | 'different' {
  let partial = false;
  const same = (left: unknown, right: unknown, required = true) => {
    if (left == null || right == null) { if (required) partial = true; return true; }
    return left === right;
  };
  if (kind === 'cpu') return a.cpu && key(a.cpu) === key(b.cpu) ? 'exact' : 'different';
  if (kind === 'gpu') {
    if (!a.gpu || !a.vramGb || a.gpuClass !== 'desktop' || b.gpuClass !== 'desktop'
      || key(a.gpu) !== key(b.gpu) || a.vramGb !== b.vramGb
      || !same(a.gpuMemoryType,b.gpuMemoryType)) return 'different';
  } else if (kind === 'ram') {
    // Computer parsers may retain quantity=1 without a stated stick layout. Only a verified per-stick total establishes layout.
    const layout = (p: HardwareProfile) => p.perUnitGb && p.quantity && p.perUnitGb*p.quantity === p.ramGb
      ? {perUnit:p.perUnitGb,quantity:p.quantity} : null;
    const left = layout(a), right = layout(b);
    if (!a.ramGb || !a.ramType || a.ramGb !== b.ramGb || key(a.ramType) !== key(b.ramType)
      || !same(a.ramFormFactor,b.ramFormFactor) || !same(a.ramSpeedMhz,b.ramSpeedMhz)
      || !same(left?.perUnit,right?.perUnit) || !same(left?.quantity,right?.quantity)
      || !same(a.ramEcc,b.ramEcc, !!(a.ramEcc || b.ramEcc))) return 'different';
  } else {
    if (!a.storageGb || !/ssd/i.test(a.storageType ?? '') || !/ssd/i.test(b.storageType ?? '')
      || ssdCapacityClass(a.storageGb) !== ssdCapacityClass(b.storageGb)
      || !same(storageInterface(a),storageInterface(b))) return 'different';
  }
  return partial ? 'partial' : 'exact';
}

function requests(a: Assessment): PartRequest[] {
  const p = a.profile, result: PartRequest[] = [];
  if (a.kind === 'desktop' && p.cpu) result.push({kind:'cpu',profile:p,quantity:a.computer?.cpuCount ?? 1,label:p.cpu});
  if (p.gpu && p.vramGb && p.gpuClass === 'desktop' && p.gpuInclusion !== 'absent') {
    result.push({kind:'gpu',profile:p,quantity:1,label:`${p.gpu} · ${p.vramGb} GB${p.gpuMemoryType ? ` ${p.gpuMemoryType}` : ''}`});
  }
  if (a.kind === 'desktop' && p.ramGb && p.ramType) result.push({kind:'ram',profile:p,quantity:1,label:`${p.ramGb} GB ${p.ramType} RAM`});
  if (a.kind === 'desktop' && p.storageGb && /ssd/i.test(p.storageType ?? '')) result.push({kind:'ssd',profile:p,quantity:1,label:`${p.storageGb} GB ${p.storageType}`});
  return result;
}
function cacheKey(r: PartRequest): string {
  const p = r.profile;
  const identity = r.kind === 'cpu' ? [p.cpu] : r.kind === 'gpu' ? [p.gpu,p.vramGb,p.gpuMemoryType,p.gpuClass]
    : r.kind === 'ram' ? [p.ramGb,p.ramType,p.ramFormFactor,p.ramSpeedMhz,p.ramEcc,p.perUnitGb,p.quantity]
    : [ssdCapacityClass(p.storageGb),storageInterface(p)];
  return `prices:parts:v1:${r.kind}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
function validOffer(o: RetailPrice, now: number): boolean {
  let trusted = false;
  try { const url = new URL(o.url); trusted = url.protocol === 'https:' && url.hostname in RETAIL_SHOPS && url.hostname === o.source; } catch { /* Invalid stored source is not evidence. */ }
  return trusted && o.basis === 'current_new' && o.market === 'VN' && o.currency === 'VND' && o.available
    && o.totalCostKnown && o.shipsToVietnam && Number.isFinite(o.amount) && o.amount >= 50_000 && freshDate(o.observedAt,now);
}

/** Durable, bounded retail lookups. estimate() and checkedAt() are strictly offline. */
export class PartsPriceBook {
  private pending = new Map<string,Promise<void>>();
  constructor(private cache: RuntimeCache, private source: PartsRetailSource = new PublicRetailSources(cache), private now = () => Date.now()) {}
  canLookup(a: Assessment): boolean { return ['desktop','gpu'].includes(a.kind) && requests(a).length > 0; }
  checkedAt(a: Assessment): string { return requests(a).map(r => this.cache.runtimeValue<RetailLookup>(cacheKey(r))?.checkedAt ?? '').sort()[0] ?? ''; }
  async warm(a: Assessment, signal?: AbortSignal): Promise<void> {
    if (!['desktop','gpu'].includes(a.kind) || a.eligibility === 'excluded') return;
    await concurrent(requests(a),2,async r => {
      signal?.throwIfAborted();
      const cacheId = cacheKey(r), saved = this.cache.runtimeValue<RetailLookup>(cacheId);
      if (saved && freshDate(saved.checkedAt,this.now(),saved.status === 'failed' ? 15*60_000 : undefined)
        && (saved.status === 'failed' || saved.offers.every(o => freshDate(o.observedAt,this.now())))) return;
      if (!this.pending.has(cacheId)) this.pending.set(cacheId,this.refresh(cacheId,r,saved,signal).finally(() => this.pending.delete(cacheId)));
      await this.pending.get(cacheId);
    });
    signal?.throwIfAborted();
  }
  private async refresh(cacheId: string, r: PartRequest, saved: RetailLookup | null, signal?: AbortSignal): Promise<void> {
    let result: RetailLookup;
    try { result = await this.source.lookup(r.profile,signal,r.kind); }
    catch (error) {
      signal?.throwIfAborted();
      result = {checkedAt:new Date(this.now()).toISOString(),status:'failed',offers:[],errors:[error instanceof Error ? error.message : 'Retail source unavailable']};
    }
    signal?.throwIfAborted();
    if (result.status === 'failed' && saved) {
      const ids = new Set(result.offers.map(o => o.id));
      result = {...result,offers:[...result.offers,...saved.offers.filter(o => !ids.has(o.id) && !result.checkedUrls?.includes(o.url) && freshDate(o.observedAt,this.now()))]};
    }
    this.cache.setRuntimeValue(cacheId,result);
  }
  estimate(raw: RawListing, a: Assessment): DepreciatedRetailEstimate {
    const now = this.now(), parts = requests(a), components: DepreciatedPart[] = [], omitted: string[] = [];
    if (a.kind === 'desktop') {
      omitted.push('Motherboard, PSU, case, cooling, peripherals and assembly are unpriced');
      if (!a.profile.cpu) omitted.push('CPU: model unknown');
      if (!a.profile.ramGb || !a.profile.ramType) omitted.push('RAM: capacity or generation unknown');
      if (!a.profile.storageGb || !/ssd/i.test(a.profile.storageType ?? '')) omitted.push('SSD: capacity or SSD identity unknown; HDDs are unpriced');
    }
    if (!parts.some(r => r.kind === 'gpu') && a.profile.gpuInclusion !== 'absent' && a.profile.gpuClass !== 'integrated') omitted.push('GPU: included desktop model and VRAM are unverified');
    for (const r of parts) {
      const lookup = this.cache.runtimeValue<RetailLookup>(cacheKey(r));
      const matches = (lookup?.offers ?? []).filter(o => validOffer(o,now) && partMatch(r.kind,r.profile,o.profile) !== 'different');
      const exact = matches.filter(o => partMatch(r.kind,r.profile,o.profile) === 'exact');
      const sources = (exact.length ? exact : matches).sort((a,b) => a.amount-b.amount);
      if (!sources.length) {
        omitted.push(`${r.label}: ${lookup?.status === 'failed' ? 'retail lookup incomplete; no verified current offer' : lookup ? 'no verified current offer in checked sources' : 'retail prices not checked yet'}`);
        continue;
      }
      const indicative = !exact.length, newPriceVnd = sources[0]!.amount*r.quantity;
      const estimateVnd = newPriceVnd*PARTS_RETAIL_RETENTION;
      components.push({kind:r.kind,label:r.label,quantity:r.quantity,newPriceVnd,estimateVnd,
        rangeVnd:[estimateVnd, indicative ? sources.at(-1)!.amount*r.quantity*PARTS_RETAIL_RETENTION : estimateVnd],
        indicative,reasons:indicative ? ['Matching specifications are incomplete; the range covers possible variants.'] : [],sources});
    }
    const newTotalVnd = components.length ? components.reduce((sum,c) => sum+c.newPriceVnd,0) : null;
    const estimateVnd = newTotalVnd === null ? null : newTotalVnd*PARTS_RETAIL_RETENTION;
    let reason = 'Lowest verified current factory-new cash prices × 75% retained value. The 25% reduction is a policy assumption, not observed used-market depreciation.';
    const blocked = a.eligibility !== 'eligible' || a.conflicts.length > 0 || sourceUnavailable(raw) || raw.condition !== 'used' || !raw.sellerId
      || !raw.description.trim() || !!raw.attributes._detailError || raw.attributes.price_available === false || raw.attributes.is_price_not_valid === true
      || !Number.isFinite(raw.price) || raw.price <= 0 || !freshDate(raw.observedAt,now,86_400_000)
      || ['deposit','unknown','bundle'].includes(a.profile.priceBasis)
      || a.kind === 'gpu' && a.profile.quantity !== 1;
    const suspicious = estimateVnd !== null && raw.price < estimateVnd*0.1;
    const indicative = blocked || suspicious || components.some(c => c.indicative);
    if (blocked) reason += ' Verify configuration, condition, seller description, single-item cash price and a listing observation within 24 hours before using a badge.';
    if (suspicious) reason += ' Verify the full cash price: it is below 10% of this estimate.';
    if (a.kind === 'desktop') reason += ' This is a partial component estimate, not a whole-PC market value.';
    return {policyVersion:PARTS_RETAIL_POLICY,status:!components.length ? 'unavailable' : indicative ? 'indicative' : 'valued',
      label:a.kind === 'gpu' ? 'Depreciated retail estimate' : 'Depreciated component estimate',retention:PARTS_RETAIL_RETENTION,
      newTotalVnd,estimateVnd,rangeVnd:components.length ? [components.reduce((s,c) => s+c.rangeVnd[0],0),components.reduce((s,c) => s+c.rangeVnd[1],0)] : null,
      discountPercent:estimateVnd && Number.isFinite(raw.price) && raw.price > 0 ? (estimateVnd-raw.price)/estimateVnd*100 : null,
      opportunity:!!components.length && !indicative && estimateVnd !== null && raw.price < estimateVnd,
      components,omitted,reason:components.length ? reason : 'No verified current retail estimate is available. Used-market evidence remains separate.'};
  }
}
