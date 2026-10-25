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
  sources: RetailPrice[];
  checkedAt: string | null;
  lookupStatus: 'complete' | 'failed' | 'not_checked';
  laptopClass: LaptopClass | null;
  ageYears: number | null;
  ageRange: [number, number] | null;
  retention: number | null;
  originalUsd: number | null;
  referenceUsd: number;
  rangeUsd: [number, number];
  fx: FxSnapshot;
}
export interface RetailLookup {
  checkedAt: string; status: 'complete' | 'failed'; offers: RetailPrice[]; errors: string[];
  checkedUrls?: string[];
}

export function freshDate(value: string, now = Date.now(), ttl = PRICE_CACHE_MS): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now + 60_000 && now - timestamp < ttl;
}
export function validFx(value: FxSnapshot | null | undefined, now = Date.now()): value is FxSnapshot {
  return !!value && value.base === 'USD' && value.rates?.USD === 1
    && Number.isFinite(value.rates.VND) && value.rates.VND > 0
    && freshDate(value.fetchedAt, now) && freshDate(value.date, Date.parse(value.fetchedAt));
}
export function toUsd(amount: number, currency: string, fx: FxSnapshot): number | null {
  const rate = fx.rates[currency];
  return Number.isFinite(amount) && Number.isFinite(rate) && rate > 0 ? amount / rate : null;
}
