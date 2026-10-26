import { freshDate, usableFx, validFx, type FxSnapshot } from '../shared/retail.ts';

export interface RuntimeCache {
  runtimeValue<T>(key: string): T | null;
  setRuntimeValue(key: string, value: unknown): void;
}
export type PriceFetch = typeof fetch;
export const FX_URL = 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=VND,EUR,GBP,JPY,CNY,HKD,SGD,AUD,CAD';

/** Bounded, credential-free requests. Redirects are checked before each hop. */
export async function readPublic(url: string, allowed: (url: URL) => boolean, fetcher: PriceFetch,
  signal?: AbortSignal, maxBytes = 4_000_000): Promise<{ body: string; url: string }> {
  const timeout = AbortSignal.timeout(12_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let hop = 0; hop < 4; hop++) {
    combined.throwIfAborted();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowed(parsed)) throw new Error('Price source URL is not allowed');
    const response = await fetcher(url, { signal: combined, redirect: 'manual', headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Flipper/1.0; +https://github.com/sergkhl/flipper)',
      Accept: 'application/json,text/html,application/xml;q=0.8',
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Price source redirect has no location');
      url = new URL(location, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Price source HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > maxBytes || !response.body) {
      await response.body?.cancel(); throw new Error('Price source body exceeds limit or is empty');
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        combined.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength; if (length > maxBytes) throw new Error('Price source body exceeds limit');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { body: Buffer.concat(chunks).toString('utf8'), url };
  }
  throw new Error('Too many price source redirects');
}

export class ExchangeRates {
  private pending: Promise<void> | null = null;
  private retryAfter = 0;
  constructor(private cache: RuntimeCache, private fetcher: PriceFetch = fetch, private now = () => Date.now()) {}
  snapshot(): FxSnapshot | null {
    const value = this.cache.runtimeValue<FxSnapshot>('prices:fx:v1');
    return usableFx(value, this.now()) ? value : null;
  }
  async warm(signal?: AbortSignal): Promise<void> {
    if (validFx(this.snapshot(), this.now()) || this.now() < this.retryAfter) return;
    if (!this.pending) this.pending = this.refresh(signal).finally(() => { this.pending = null; });
    await this.pending; signal?.throwIfAborted();
  }
  private async refresh(signal?: AbortSignal): Promise<void> {
    try {
      const { body } = await readPublic(FX_URL, url => url.hostname === 'api.frankfurter.dev', this.fetcher, signal, 100_000);
      const rows: unknown = JSON.parse(body);
      if (!Array.isArray(rows) || rows.length > 64) throw new Error('Invalid exchange-rate response');
      const rates: Record<string, number> = { USD: 1 }; const dates: string[] = [];
      for (const row of rows) {
        if (!row || row.base !== 'USD' || !/^[A-Z]{3}$/.test(row.quote) || row.quote === 'USD'
          || typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate <= 0
          || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !freshDate(row.date, this.now())) continue;
        if (rates[row.quote] !== undefined) throw new Error('Duplicate currency in exchange rates');
        rates[row.quote] = row.rate; dates.push(row.date);
      }
      const snapshot: FxSnapshot = { base: 'USD', fetchedAt: new Date(this.now()).toISOString(),
        date: dates.sort()[0] ?? '', rates, sourceUrl: 'https://frankfurter.dev/' };
      if (!validFx(snapshot, this.now())) throw new Error('Fresh USD/VND exchange rate is missing');
      this.cache.setRuntimeValue('prices:fx:v1', snapshot);
      this.cache.setRuntimeValue('prices:fx:last-error', null);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.cache.setRuntimeValue('prices:fx:last-error', { at:new Date(this.now()).toISOString(),
        error:error instanceof Error ? error.message : 'Exchange-rate lookup failed' });
      this.retryAfter = this.now() + 15 * 60_000;
    }
  }
}
