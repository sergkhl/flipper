import { createHash } from 'node:crypto';
import type { HardwareProfile } from '../shared/types.ts';
import { freshDate, type RetailLookup, type RetailPrice } from '../shared/retail.ts';
import { ExchangeRates, type RuntimeCache } from './price-cache.ts';
import { PublicRetailSources } from './retail-sources.ts';
import { laptopReference, retailMatch } from './laptop-pricing.ts';
import { LAPTOP_LAUNCH_PRICES } from './laptop-launch-prices.ts';

export interface RetailSource { lookup(profile: HardwareProfile, signal?: AbortSignal): Promise<RetailLookup>; }
const cacheKey = (p: HardwareProfile) => `prices:laptop:v1:${createHash('sha256').update(JSON.stringify([
  p.model,p.modelYear,p.screenInches,p.cpu,p.cpuCores,p.gpu,p.gpuCores,p.gpuClass,p.vramGb,p.ramGb,p.ramType,p.storageGb,
])).digest('hex')}`;
export class LaptopPriceBook {
  private pending = new Map<string,Promise<void>>();
  private source: RetailSource;
  private rates: ExchangeRates;
  constructor(private cache: RuntimeCache, source?: RetailSource, private now = () => Date.now(),
    private history: RetailPrice[] = LAPTOP_LAUNCH_PRICES, rates?: ExchangeRates) {
    this.source = source ?? new PublicRetailSources(cache,fetch,now);
    this.rates = rates ?? new ExchangeRates(cache,fetch,now);
  }
  lookup(profile: HardwareProfile): RetailLookup | null { return this.cache.runtimeValue<RetailLookup>(cacheKey(profile)); }
  reference(profile: HardwareProfile) { return laptopReference(profile,this.lookup(profile),this.history,this.rates.snapshot(),this.now()); }
  async warm(profile: HardwareProfile, signal?: AbortSignal): Promise<void> {
    const key = cacheKey(profile), saved = this.lookup(profile);
    if (!(saved && freshDate(saved.checkedAt,this.now(),saved.status === 'complete' ? undefined : 15*60_000)
      && (saved.status === 'failed' || saved.offers.every(o => freshDate(o.observedAt,this.now()))))) {
      if (!this.pending.has(key)) this.pending.set(key,this.refresh(key,profile,saved,signal).finally(() => this.pending.delete(key)));
      await this.pending.get(key);
    }
    signal?.throwIfAborted();
    if ([...(this.lookup(profile)?.offers ?? []),...this.history].some(offer =>
      offer.currency !== 'VND' && retailMatch(profile,offer.profile) !== 'different')) await this.rates.warm(signal);
  }
  private async refresh(key: string, profile: HardwareProfile, saved: RetailLookup | null, signal?: AbortSignal) {
    let result: RetailLookup;
    try { result = await this.source.lookup(profile,signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      result = {checkedAt:new Date(this.now()).toISOString(),status:'failed',offers:[],errors:[error instanceof Error ? error.message : 'Retail lookup failed']};
    }
    signal?.throwIfAborted();
    if (result.status === 'failed' && saved) {
      const ids = new Set(result.offers.map(o => o.id));
      result.offers.push(...saved.offers.filter(o => !ids.has(o.id) && !result.checkedUrls?.includes(o.url) && freshDate(o.observedAt,this.now())));
    }
    this.cache.setRuntimeValue(key,result);
  }
}
