import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type LaptopSpecRequest = {
  model: string; cpu?: string | null; modelYear?: number | null; screenInches?: number | null;
  cpuCores?: number | null; gpuCores?: number | null; ramGb?: number | null; storageGb?: number | null;
};
export type TechLaptopRecord = {
  name: string; cpu: string | null; gpu: string | null; modelYear: number | null; screenInches: number | null;
  cpuCores: number | null; gpuCores: number | null; ramGb: number | null; storageGb: number | null;
  ramType: string | null; url: string; sourceUrls: string[]; fetchedAt: string;
};
export const TECHAPI_LAPTOP_CACHE_FILE = 'laptop-specs-techapi-v1.json';
const BASE = 'https://gettechapi.github.io/TechAPI/v1/laptops';
const TTL = 30 * 24 * 60 * 60 * 1_000, TIMEOUT = 8_000, COOLDOWN = 45_000;
const MAX_ROWS = 20_000, MAX_CACHE_BYTES = 8 * 1_024 * 1_024, MAX_DETAILS = 160;
type Row = { slug: string; name: string };
type Index = { fetchedAt: string; results: Row[] };
type Entry = { fetchedAt: string; record: TechLaptopRecord | null };
type Cache = { version: 1; attribution: Record<string, string>; index: Index | null; details: Record<string, Entry>; misses: Record<string, string> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const slug = (value: unknown): value is string => string(value, 160) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const date = (value: unknown): value is string => string(value, 40) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 60_000;
const fresh = (value: string) => Date.now() - Date.parse(value) < TTL;
const endpoint = (value?: string) => `${BASE}/${value ? `${value}/` : ''}index.json`;
const normalized = (value: string) => value.normalize('NFKD').replace(/\((?:r|tm)\)|[®™]/gi, '').toLowerCase()
  .replace(/mac\s+book/g, 'macbook').replace(/[^a-z0-9.]+/g, ' ').trim().replace(/\s+/g, ' ');
const modelKey = (value: string) => normalized(value.split('(')[0]!).replace(/^laptop\s+/, '').replace(/[^a-z0-9]/g, '');
const macFamily = (value: string): string | null => {
  const match = /\bmacbook(?:\s+(air|pro|neo))?\b/.exec(normalized(value));
  return match ? match[1] ?? 'base' : null;
};
const appleChip = (value: string): string | null => {
  const match = /\b(m\s*\d+|a\s*\d+)\s*(pro(?:pro)?|max(?:max)?|ultra)?\b/.exec(normalized(value));
  return match ? `${match[1]!.replace(/\s/g, '')}${(match[2] ?? '').replace(/^(pro)pro$/, '$1').replace(/^(max)max$/, '$1')}` : null;
};
const cpuKey = (value: string) => appleChip(value) ?? normalized(value).replace(/^(?:(?:intel|core|amd)\s+)+/, '').replace(/[^a-z0-9]/g, '');
const namedYear = (value: string) => Number(/\b(20\d{2})\b/.exec(value)?.[1]) || null;
const namedScreen = (value: string) => Number(/\bmacbook(?:\s+(?:air|pro|neo))?\s+(1[2-6](?:\.\d)?)\b/.exec(normalized(value))?.[1]) || null;
const positive = (value: unknown, maximum: number, integer = true): number | null => typeof value === 'number'
  && Number.isFinite(value) && value > 0 && value <= maximum && (!integer || Number.isInteger(value)) ? value : null;
const year = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 2000 && value <= new Date().getUTCFullYear() + 1 ? value : null;
const nominalMacScreens: Record<number, number[]> = { 12: [12], 13: [13, 13.3, 13.6], 14: [14, 14.2], 15: [15, 15.3, 15.4], 16: [16, 16.2] };
const screenMatches = (left: number, right: number, mac: boolean) => Math.abs(left - right) < 0.15
  || mac && ((nominalMacScreens[left] ?? []).some((screen) => Math.abs(screen - right) < 0.06)
    || (nominalMacScreens[right] ?? []).some((screen) => Math.abs(screen - left) < 0.06));
function link(value: unknown): value is string {
  if (!string(value, 2_000)) return false;
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}
function request(value: LaptopSpecRequest): LaptopSpecRequest | null {
  if (!value || !string(value.model)) return null;
  for (const key of ['modelYear', 'screenInches', 'cpuCores', 'gpuCores', 'ramGb', 'storageGb'] as const) {
    if (value[key] !== undefined && value[key] !== null && (key === 'modelYear' ? year(value[key]) === null
      : positive(value[key], key === 'storageGb' ? 100_000 : key === 'screenInches' ? 30 : 4_096, key !== 'screenInches') === null)) return null;
  }
  if (value.cpu !== undefined && value.cpu !== null && !string(value.cpu)) return null;
  const modelYear = value.modelYear ?? namedYear(value.model), screenInches = value.screenInches ?? namedScreen(value.model);
  // Disagreement inside the requested identity must not select an arbitrary alternative.
  if (value.modelYear && namedYear(value.model) && value.modelYear !== namedYear(value.model)
    || value.screenInches && namedScreen(value.model) && !screenMatches(value.screenInches, namedScreen(value.model)!, !!macFamily(value.model))
    || value.cpu && appleChip(value.model) && cpuKey(value.cpu) !== appleChip(value.model)) return null;
  return { ...value, modelYear, screenInches, cpu: value.cpu ?? (appleChip(value.model) ? appleChip(value.model) : null) };
}
const requestKey = (value: LaptopSpecRequest) => JSON.stringify([modelKey(value.model), value.cpu ? cpuKey(value.cpu) : null,
  value.modelYear ?? null, value.screenInches ?? null, value.cpuCores ?? null, value.gpuCores ?? null, value.ramGb ?? null, value.storageGb ?? null]);
type Candidate = { row: Row; chip: string | null; screen: number | null; released: number | null };
const modelIndexes = new WeakMap<Index, Map<string, Candidate[]>>();
function candidates(index: Index | null, query: LaptopSpecRequest): Row[] {
  if (!index) return [];
  let models = modelIndexes.get(index);
  if (!models) {
    models = new Map();
    for (const row of index.results) {
      const family = macFamily(row.name), key = family ? `mac:${family}` : `model:${modelKey(row.name)}`;
      const rows = models.get(key) ?? [];
      rows.push({ row, chip: family ? appleChip(row.name) : null, screen: family ? namedScreen(row.name) : null,
        released: family ? namedYear(row.name) : null });
      models.set(key, rows);
    }
    modelIndexes.set(index, models);
  }
  const family = macFamily(query.model);
  const rows = models.get(family ? `mac:${family}` : `model:${modelKey(query.model)}`) ?? [];
  const cpu = query.cpu ? cpuKey(query.cpu) : null;
  return rows.filter(({ chip, screen, released }) => !family || !(chip && cpu && cpu !== chip
    || screen && query.screenInches && !screenMatches(screen, query.screenInches, true)
    || released && query.modelYear && released !== query.modelYear)).map(({ row }) => row);
}
function matches(record: TechLaptopRecord, query: LaptopSpecRequest): boolean {
  if (macFamily(record.name) !== macFamily(query.model) || !macFamily(query.model) && modelKey(record.name) !== modelKey(query.model)) return false;
  if (query.cpu && (!record.cpu || cpuKey(record.cpu) !== cpuKey(query.cpu))) return false;
  if (query.screenInches && (!record.screenInches || !screenMatches(record.screenInches, query.screenInches, !!macFamily(query.model)))) return false;
  for (const key of ['modelYear', 'cpuCores', 'gpuCores', 'ramGb', 'storageGb'] as const) if (query[key] && record[key] !== query[key]) return false;
  return true;
}
function parseIndex(value: unknown): Row[] {
  if (!object(value) || !Array.isArray(value.results) || value.results.length > MAX_ROWS
    || value.count !== undefined && (!Number.isInteger(value.count) || value.count !== value.results.length)) throw new Error('Invalid TechAPI laptop index');
  const rows = new Map<string, Row>();
  for (const row of value.results) {
    if (!object(row) || !slug(row.slug) || !string(row.name)) throw new Error('Invalid TechAPI laptop index entries');
    rows.set(row.slug, { slug: row.slug, name: row.name });
  }
  return [...rows.values()];
}
function parseDetail(value: unknown, row: Row, fetchedAt: string): TechLaptopRecord {
  if (!object(value) || value.slug !== row.slug || !string(value.name) || normalized(value.name) !== normalized(row.name)) throw new Error('Invalid TechAPI laptop identity');
  const cpu = string(value.cpu_name) ? value.cpu_name : null, gpu = string(value.gpu_name) ? value.gpu_name : null;
  const display = object(value.display) ? value.display : {};
  const ramType = typeof value.ram_type === 'string' ? value.ram_type : typeof value.memory_type === 'string' ? value.memory_type : '';
  const type = ramType.toUpperCase().replace(/\s/g, '');
  const namedCpu = appleChip(value.name), releaseYear = year(namedYear(String(value.release_date ?? ''))), nameYear = year(namedYear(value.name));
  if (namedCpu && cpu && namedCpu !== appleChip(cpu)) throw new Error('Conflicting TechAPI laptop chip identity');
  if (nameYear && releaseYear && nameYear !== releaseYear) throw new Error('Conflicting TechAPI laptop year identity');
  return { name: value.name, cpu, gpu, modelYear: year(value.model_year) ?? releaseYear ?? nameYear,
    screenInches: positive(display.size_inch, 30, false) ?? namedScreen(value.name),
    cpuCores: positive(value.cpu_cores, 512) ?? positive(value.cpu_core_count, 512)
      ?? (cpu ? positive(Number(/\b(\d+)\s*-?\s*core\b/i.exec(cpu)?.[1]), 512) : null),
    gpuCores: positive(value.gpu_cores, 512) ?? positive(value.gpu_core_count, 512)
      ?? (gpu ? positive(Number(/\b(\d+)\s*-?\s*core\b/i.exec(gpu)?.[1]), 512) : null),
    ramGb: positive(value.ram_gb, 4_096), storageGb: positive(value.storage_gb, 100_000),
    ramType: /^(?:LPDDR[1-6]X?|DDR[1-6]L?)$/.test(type) ? type : null, url: endpoint(row.slug),
    sourceUrls: Array.isArray(value.source_urls) ? [...new Set(value.source_urls.filter(link))].slice(0, 32) : [], fetchedAt };
}
function parseCache(value: unknown, attribution: Record<string, string>): Cache {
  if (!object(value) || value.version !== 1 || !object(value.details) || !object(value.misses)
    || Object.keys(value.details).length > MAX_ROWS || Object.keys(value.misses).length > MAX_ROWS) throw new Error('Invalid TechAPI laptop cache');
  let index: Index | null = null;
  if (value.index !== null) {
    if (!object(value.index) || !date(value.index.fetchedAt)) throw new Error('Invalid TechAPI laptop index cache');
    index = { fetchedAt: value.index.fetchedAt, results: parseIndex(value.index) };
  }
  const details: Cache['details'] = Object.create(null), misses: Cache['misses'] = Object.create(null);
  for (const [key, entry] of Object.entries(value.details)) {
    if (!slug(key) || !object(entry) || !date(entry.fetchedAt)) throw new Error('Invalid TechAPI laptop detail cache');
    const record = entry.record;
    if (record !== null) {
      if (!object(record) || !string(record.name) || record.url !== endpoint(key) || record.fetchedAt !== entry.fetchedAt
        || !(record.cpu === null || string(record.cpu)) || !(record.gpu === null || string(record.gpu))
        || !(record.modelYear === null || year(record.modelYear) !== null)
        || !(record.screenInches === null || positive(record.screenInches, 30, false) !== null)
        || !(record.ramType === null || typeof record.ramType === 'string' && /^(?:LPDDR[1-6]X?|DDR[1-6]L?)$/.test(record.ramType))
        || !Array.isArray(record.sourceUrls) || record.sourceUrls.length > 32 || !record.sourceUrls.every(link)
        || ['cpuCores', 'gpuCores', 'ramGb', 'storageGb'].some((field) => record[field] !== null && positive(record[field], field === 'storageGb' ? 100_000 : 4_096) === null)) throw new Error('Invalid TechAPI laptop record cache');
      const indexed = index?.results.find((row) => row.slug === key);
      if (indexed && normalized(indexed.name) !== normalized(record.name)) throw new Error('Invalid TechAPI cached laptop identity');
    }
    // Reconstruct the public shape: imported cache additions must not expose prices or provider trust flags.
    const sanitized = record === null ? null : Object.fromEntries(['name', 'cpu', 'gpu', 'modelYear', 'screenInches',
      'cpuCores', 'gpuCores', 'ramGb', 'storageGb', 'ramType', 'url', 'sourceUrls', 'fetchedAt'].map((field) => [field, (record as Record<string, unknown>)[field]])) as TechLaptopRecord;
    details[key] = { fetchedAt: entry.fetchedAt, record: sanitized };
  }
  for (const [key, fetchedAt] of Object.entries(value.misses)) {
    if (key.length > 1_000 || !date(fetchedAt)) throw new Error('Invalid TechAPI laptop miss cache');
    misses[key] = fetchedAt;
  }
  return { version: 1, attribution, index, details, misses };
}
async function pool<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => { while (next < items.length) await run(items[next++]!); }));
}

/** Supplemental catalog variants only. Public reads are offline and never establish installed specifications. */
export class TechAPILaptopCache {
  private cache: Cache;
  private readonly fetcher: typeof fetch;
  private queue = Promise.resolve();
  private lastError: string | null = null;
  private lastWarmedAt: string | null = null;
  private retryAfter = 0;
  constructor(private readonly directory: string, private readonly options: { fetch?: typeof fetch; attribution: Record<string, string> }) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.cache = { version: 1, attribution: options.attribution, index: null, details: Object.create(null), misses: Object.create(null) };
    try {
      const filename = path.join(directory, TECHAPI_LAPTOP_CACHE_FILE);
      if (statSync(filename).size > MAX_CACHE_BYTES) throw new Error('TechAPI laptop cache exceeds size limit');
      this.cache = parseCache(JSON.parse(readFileSync(filename, 'utf8')), options.attribution);
    } catch (error) { if (!(object(error) && error.code === 'ENOENT')) this.lastError = error instanceof Error ? error.message : 'Unable to read TechAPI laptop cache'; }
  }
  get status() {
    return { laptopRecords: Object.values(this.cache.details).filter((entry) => entry.record).length,
      laptopIndexes: this.cache.index ? 1 : 0, laptopMisses: Object.keys(this.cache.misses).length,
      laptopStaleRecords: Object.values(this.cache.details).filter((entry) => entry.record && !fresh(entry.fetchedAt)).length,
      laptopError: this.lastError, laptopLastWarmedAt: this.lastWarmedAt,
      laptopRetryAfter: this.retryAfter > Date.now() ? new Date(this.retryAfter).toISOString() : null };
  }
  getLaptops(input: LaptopSpecRequest): readonly TechLaptopRecord[] {
    const query = request(input);
    if (!query) return [];
    return candidates(this.cache.index, query).flatMap((row) => {
      const record = this.cache.details[row.slug]?.record;
      return record && normalized(record.name) === normalized(row.name) && matches(record, query) ? [{ ...record, sourceUrls: [...record.sourceUrls] }] : [];
    });
  }
  warmLaptops(inputs: LaptopSpecRequest[], signal?: AbortSignal): Promise<void> {
    const queries = new Map<string, LaptopSpecRequest>();
    for (const input of inputs) { const query = request(input); if (query) queries.set(requestKey(query), query); }
    const run = this.queue.then(() => this.warmNow([...queries.values()], signal));
    this.queue = run.catch(() => {});
    return run;
  }
  private async warmNow(queries: LaptopSpecRequest[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!queries.length || this.retryAfter > Date.now()) return;
    this.lastError = null; this.retryAfter = 0;
    let dirty = false;
    const failure = (error: unknown, provider = true) => {
      if (signal?.aborted) return;
      this.lastError = error instanceof Error ? error.message : 'TechAPI laptop request failed';
      if (provider) this.retryAfter = Date.now() + COOLDOWN;
    };
    if (!this.cache.index || !fresh(this.cache.index.fetchedAt)) {
      try {
        const results = parseIndex(await this.json(endpoint(), 2 * 1_024 * 1_024, signal));
        this.cache.index = { results, fetchedAt: new Date().toISOString() };
        this.cache.misses = Object.create(null); dirty = true;
      } catch (error) { failure(error); }
    }
    const rows = new Map<string, Row>();
    for (const query of queries) {
      const key = requestKey(query), missedAt = this.cache.misses[key];
      if (missedAt && fresh(missedAt)) continue;
      const found = candidates(this.cache.index, query);
      if (!found.length && this.cache.index && fresh(this.cache.index.fetchedAt)) { this.cache.misses[key] = new Date().toISOString(); dirty = true; }
      for (const row of found) {
        const existing = this.cache.details[row.slug];
        if (!existing || !fresh(existing.fetchedAt) || existing.record && normalized(existing.record.name) !== normalized(row.name)) rows.set(row.slug, row);
      }
    }
    await pool([...rows.values()].slice(0, MAX_DETAILS), async (row) => {
      if (this.retryAfter > Date.now() || signal?.aborted) return;
      try {
        const value = await this.json(endpoint(row.slug), 128 * 1_024, signal, true), fetchedAt = new Date().toISOString();
        if (value !== null || !this.cache.details[row.slug]?.record) {
          this.cache.details[row.slug] = { fetchedAt, record: value === null ? null : parseDetail(value, row, fetchedAt) }; dirty = true;
        }
      } catch (error) { failure(error); }
    });
    if (dirty) { try { await this.save(); } catch (error) { failure(error, false); } }
    this.lastWarmedAt = new Date().toISOString();
    signal?.throwIfAborted();
  }
  private async json(url: string, maximum: number, signal?: AbortSignal, missing = false): Promise<unknown> {
    signal?.throwIfAborted();
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
    const response = await this.fetcher(url, { signal: requestSignal, redirect: 'error', headers: { Accept: 'application/json' } });
    const discard = () => { void response.body?.cancel().catch(() => {}); };
    if (missing && response.status === 404) { discard(); return null; }
    if (!response.ok || response.url && response.url !== url) { discard(); throw new Error(`TechAPI laptop response rejected (${response.status})`); }
    if (Number(response.headers.get('content-length')) > maximum) { discard(); throw new Error('TechAPI laptop response exceeds size limit'); }
    if (response.headers.get('content-type') && !response.headers.get('content-type')!.includes('application/json')) { discard(); throw new Error('TechAPI laptop response is not JSON'); }
    if (!response.body) throw new Error('Empty TechAPI laptop response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        requestSignal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
        length += next.value.length; if (length > maximum) throw new Error('TechAPI laptop response exceeds size limit'); chunks.push(next.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private async save() {
    const data = JSON.stringify(this.cache);
    if (Buffer.byteLength(data) > MAX_CACHE_BYTES) throw new Error('TechAPI laptop cache exceeds size limit');
    await mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, TECHAPI_LAPTOP_CACHE_FILE), temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
