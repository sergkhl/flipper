import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LaptopPriceBook } from '../server/laptop-price-book.ts';
import type { RuntimeCache } from '../server/price-cache.ts';
import type { FxSnapshot } from '../shared/retail.ts';
import { retailMatch } from '../server/laptop-pricing.ts';
import { LAPTOP_LAUNCH_PRICES } from '../server/laptop-launch-prices.ts';
import type { HardwareProfile } from '../shared/types.ts';

// Deliberately offline unless --live is supplied. No marketplace, AI, credentials,
// production database writes or additional price providers are used by this tool.
const { values } = parseArgs({ options: {
  cache: { type: 'string' }, output: { type: 'string' }, at: { type: 'string' }, live: { type: 'boolean', default: false },
} });
if (!values.cache) throw new Error('Supply --cache PATH to an isolated public-price cache JSON file. See docs/laptop-price-benchmark.md.');
if (values.live && values.at) throw new Error('--at replays a frozen snapshot; it cannot be combined with --live.');
if (values.at && !Number.isFinite(Date.parse(values.at))) throw new Error('--at must be an ISO evaluation date.');
if (!values.live && !existsSync(values.cache)) throw new Error('Offline replay requires an existing cache file.');
const data: Record<string, unknown> = existsSync(values.cache) ? JSON.parse(readFileSync(values.cache, 'utf8')) : {};
if (Object.keys(data).some(key => !key.startsWith('prices:'))) throw new Error('Cache must contain only public prices: entries.');
const cache: RuntimeCache = {
  runtimeValue: <T>(key: string) => structuredClone(data[key] ?? null) as T | null,
  setRuntimeValue: (key, value) => { data[key] = structuredClone(value); },
};
const cases = JSON.parse(readFileSync(new URL('./fixtures/laptop-price-benchmark.json', import.meta.url), 'utf8')) as Array<{
  id: string; eligibility: string; profile: HardwareProfile;
}>;
let networkRequests = 0;
if (values.live) {
  // The production adapters retain their seven-day caches and shared three-slot
  // HTTP bound. Count requests without changing the fetch/redirect behavior.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { networkRequests++; return originalFetch(...args); };
  const liveBook = new LaptopPriceBook(cache);
  const signal = AbortSignal.timeout(5 * 60_000);
  try {
    for (const item of cases) {
      await liveBook.warm(item.profile, signal);
      console.error(`${item.id}: ${liveBook.lookup(item.profile)?.status ?? 'not_checked'}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    writeFileSync(values.cache, JSON.stringify(data) + '\n', { mode: 0o600 });
  }
}
const evaluationTime = values.at ? Date.parse(values.at) : Date.now(), now = () => evaluationTime;
const book = new LaptopPriceBook(cache, undefined, now);
const evaluatedAt = new Date(evaluationTime).toISOString(), fx = cache.runtimeValue<FxSnapshot>('prices:fx:v1');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = cases.map(item => {
  const lookup = book.lookup(item.profile), { reference, reason } = book.reference(item.profile), evidence = reference?.retail;
  const outcome = !evidence ? 'unpriced' : `${evidence.basis === 'current_new' ? 'current' : 'historical'}_${evidence.indicative ? 'indicative' : 'firm'}`;
  return { id: item.id, profile: item.profile, eligibility: item.eligibility,
    lookupStatus: lookup?.status ?? 'not_checked', checkedAt: lookup?.checkedAt ?? null,
    lookupErrors: lookup?.errors ?? [], checkedUrls: lookup?.checkedUrls ?? [],
    outcome, exactReference: !!evidence && evidence.sources.every(source => retailMatch(item.profile, source.profile) === 'exact'),
    firmReference: !!evidence && !evidence.indicative, reason,
    rangeVnd: evidence?.rangeVnd ?? null, fxStale: evidence?.fxStale ?? false,
    sources: evidence?.sources.map(({ id, url, basis, amount, currency }) => ({ id, url, basis, amount, currency })) ?? [],
  };
});
const report = { evaluatedAt, mode: values.live ? 'live' : 'offline', networkRequests,
  caseDigest: digest(cases), inputDigest: digest({ cases, fx, lookups: cases.map(item => book.lookup(item.profile)) }),
  historyDigest: digest(LAPTOP_LAUNCH_PRICES), historicalRecords: LAPTOP_LAUNCH_PRICES.length, fx,
  totals: {
    cases: rows.length, completeLookups: rows.filter(row => row.lookupStatus === 'complete').length,
    failedLookups: rows.filter(row => row.lookupStatus === 'failed').length,
    notChecked: rows.filter(row => row.lookupStatus === 'not_checked').length,
    currentFirm: rows.filter(row => row.outcome === 'current_firm').length,
    currentIndicative: rows.filter(row => row.outcome === 'current_indicative').length,
    historicalFirm: rows.filter(row => row.outcome === 'historical_firm').length,
    historicalIndicative: rows.filter(row => row.outcome === 'historical_indicative').length,
    unpriced: rows.filter(row => row.outcome === 'unpriced').length,
  }, rows,
};
const output = JSON.stringify(report, null, 2) + '\n';
if (values.output) { writeFileSync(values.output, output, { mode: 0o600 }); console.log(JSON.stringify(report.totals)); }
else process.stdout.write(output);
