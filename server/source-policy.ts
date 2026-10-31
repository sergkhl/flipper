import type { Category, SourceBudgetStatus } from '../shared/types.ts';
export type { SourceBudgetStatus } from '../shared/types.ts';

export const SOURCE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SOURCE_REQUEST_LIMIT = 700;
export const SOURCE_CATEGORY_LIMIT = 150;
export const SOURCE_AUTOMATIC_LIMIT = 450;
export const SOURCE_INTERVAL_MS = 3_000;
export const SOURCE_WORKERS = 4;
export const AI_CONCURRENCY = 4;
export const LOCAL_DETAIL_LIMIT = 10;
export const NATIONAL_OFFER_LIMIT = 60;
export const AUTOMATIC_PART_SEARCHES = 2;

export interface SourceRequestContext {
  onActivity?: () => void;
  workers?: number;
  id: string;
  category: Category;
  automatic: boolean;
  onRequest(): void;
}
export class SourceDeferredError extends Error {
  constructor(readonly until: string, readonly reason: 'request_budget' | 'proxy') {
    super(reason === 'request_budget'
      ? `Marketplace request allowance is exhausted. Queued work can resume after ${until}.`
      : `No verified proxy route is available for this attempt. Queued work can retry after ${until}.`);
    this.name = 'SourceDeferredError';
  }
}
export interface SourceRequestStore {
  reserveSourceRequest(category: Category, automatic: boolean, now: Date, intervalMs?: number,
    pacing?: { worker: string; proxy: string }): string | null;
  sourceBudgetStatus(now?: Date): SourceBudgetStatus;
  runtimeValue<T>(key: string): T | null;
  setRuntimeValue(key: string, value: unknown): void;
}
