import type { HardwareProfile } from './types.ts';

export const PRICE_CACHE_MS = 7 * 86_400_000;
export type LaptopClass = 'apple_silicon' | 'business' | 'consumer';
export interface FxSnapshot {
  base: 'USD'; fetchedAt: string; date: string; rates: Record<string, number>; sourceUrl: string;
}
export interface RetailPrice {
  id: string; title: string; url: string; source: string;
  profile: HardwareProfile;
  amount: number; currency: string; observedAt: string;
  basis: 'current_new' | 'launch_retail' | 'launch_msrp';
  priceDate: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  releaseSourceUrl: string | null;
  configurationSourceUrl?: string;
  market: string;
  available: boolean;
  totalCostKnown: boolean;
  shipsToVietnam: boolean;
}
export interface LaptopPriceEvidence {
  policyVersion: number;
  basis: 'current_new' | 'historical_depreciation';
  indicative: boolean;
  reasons: string[];
  sources: Array<RetailPrice & { amountVnd: number }>;
  checkedAt: string | null;
  lookupStatus: 'complete' | 'failed' | 'not_checked';
  laptopClass: LaptopClass | null;
  ageYears: number | null;
  ageRange: [number, number] | null;
  retention: number | null;
  originalVnd: number | null;
  referenceVnd: number;
  rangeVnd: [number, number];
  fx: FxSnapshot | null;
  fxStale: boolean;
}
export interface RetailLookup {
  checkedAt: string; status: 'complete' | 'failed'; offers: RetailPrice[]; errors: string[];
  checkedUrls?: string[];
}

export function freshDate(value: string, now = Date.now(), ttl = PRICE_CACHE_MS): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now + 60_000 && now - timestamp < ttl;
}
/** A previously verified snapshot remains usable for explicitly stale estimates. */
export function usableFx(value: FxSnapshot | null | undefined, now = Date.now()): value is FxSnapshot {
  return !!value && value.base === 'USD' && value.rates?.USD === 1
    && Number.isFinite(value.rates.VND) && value.rates.VND > 0
    && Number.isFinite(Date.parse(value.fetchedAt)) && Date.parse(value.fetchedAt) <= now + 60_000
    && freshDate(value.date, Date.parse(value.fetchedAt));
}
export function validFx(value: FxSnapshot | null | undefined, now = Date.now()): value is FxSnapshot {
  return usableFx(value, now) && freshDate(value.fetchedAt, now);
}
export function toVnd(amount: number, currency: string, fx: FxSnapshot | null, now = Date.now()): number | null {
  if (!Number.isFinite(amount)) return null;
  if (currency === 'VND') return amount;
  if (!usableFx(fx, now)) return null;
  const rate = fx.rates[currency];
  const converted = amount / rate * fx.rates.VND;
  return Number.isFinite(rate) && rate > 0 && Number.isFinite(converted) ? converted : null;
}
