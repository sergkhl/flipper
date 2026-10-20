import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TechAPILaptopCache, type LaptopSpecRequest, type TechLaptopRecord } from './techapi-laptops.ts';
export { TECHAPI_LAPTOP_CACHE_FILE } from './techapi-laptops.ts';
export type { LaptopSpecRequest, TechLaptopRecord } from './techapi-laptops.ts';

type PartKind = 'cpu' | 'gpu';
type GPUClass = 'desktop' | 'mobile' | 'integrated' | null;
export type MemoryPartRequest = { kind: PartKind; model: string; gpuClass?: GPUClass };
export type TechMemoryRecord = {
  kind: PartKind; name: string; types: string[]; socket: string | null;
  gpuClass: 'desktop' | 'mobile' | null; url: string; sourceUrls: string[]; fetchedAt: string;
};
export interface MemoryTypeLookup {
  get(kind: PartKind, model: string, gpuClass?: GPUClass): readonly TechMemoryRecord[];
  getLaptops?(request: LaptopSpecRequest): readonly TechLaptopRecord[];
}

export const TECHAPI_ATTRIBUTION = {
  name: 'TechAPI', url: 'https://gettechapi.github.io/TechAPI/',
  license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  dataLicenseUrl: 'https://github.com/GetTechAPI/TechAPI/blob/develop/data/LICENSE.md',
} as const;
export const TECHAPI_CACHE_FILE = 'memory-types-techapi-v1.json';
const BASE = 'https://gettechapi.github.io/TechAPI/v1';
const TTL = 30 * 24 * 60 * 60 * 1_000;
const TIMEOUT = 8_000;
const FAILURE_COOLDOWN = 45_000;
const MAX_INDEX_BYTES = 2 * 1_024 * 1_024;
const MAX_DETAIL_BYTES = 128 * 1_024;
const MAX_CACHE_BYTES = 8 * 1_024 * 1_024;
const MAX_ROWS = 20_000;
const MAX_DETAILS_PER_WARM = 240;
const validSlug = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const validDate = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 40 && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 60_000;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const fresh = (date: string) => Date.now() - Date.parse(date) < TTL;
const endpoint = (kind: PartKind, slug?: string) => `${BASE}/${kind}s/${slug ? `${slug}/` : ''}index.json`;
const normalize = (value: string) => value.replace(/\((?:r|tm)\)|[®™]/gi, '').normalize('NFKD')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const cpuKey = (value: string) => normalize(value).replace(/^(?:(?:intel|core|amd)\s+)+/, '').replace(/\s/g, '');
const gpuName = (value: string) => normalize(value).replace(/^(?:(?:nvidia|geforce|amd|radeon|intel)\s+)+/, '');

/** Only documented variant suffixes are removed. Ti/SUPER/XT/XTX and model-letter suffixes stay significant. */
function gpuKey(value: string): string {
  return gpuName(value)
    .replace(/\b(?:g?ddr\s*[1-7]x?|\d+\s*(?:gb|mb)|(?:ga|gb|gk|gm|gp|tu|ad)\d{3}(?:\s*\d{2})?|\d+sp)\b/g, ' ')
    .replace(/\b(?:mobile|mobility|laptop|notebook|gpu|max\s*q|max\s*p|oem|lhr)\b/g, ' ')
    .replace(/\b((?:rtx|gtx|gt|rx)\s*\d{3,4})m\b/g, '$1')
    .replace(/\b(arc\s*(?:pro\s*)?[ab]\d{3})m\b/g, '$1')
    .replace(/\s/g, '');
}
function gpuClassOf(value: string): 'desktop' | 'mobile' {
  const name = gpuName(value);
  return /\b(?:mobile|mobility|laptop|notebook|max\s*q|max\s*p)\b|\bmx\s*\d{3}\b|\b(?:rtx|gtx|gt|rx)\s*\d{3,4}m\b|\barc\s*(?:pro\s*)?[ab]\d{3}m\b/.test(name)
    ? 'mobile' : 'desktop';
}
function requestedClass(part: MemoryPartRequest): GPUClass {
  if (part.gpuClass === 'integrated') return 'integrated';
  // An explicit model qualifier must not silently become a desktop GPU if the caller supplies conflicting context.
  if (gpuClassOf(part.model) === 'mobile') return part.gpuClass === 'desktop' ? 'integrated' : 'mobile';
  return part.gpuClass ?? null;
}
const keyOf = (part: MemoryPartRequest) => `${part.kind}:${part.kind === 'cpu' ? cpuKey(part.model) : gpuKey(part.model)}:${part.kind === 'gpu' ? requestedClass(part) ?? 'unknown' : ''}`;
const allowedTypes = new Set([...Array.from({ length: 6 }, (_, i) => `DDR${i + 1}`), 'DDR3L', 'DDR4L',
  ...Array.from({ length: 6 }, (_, i) => `LPDDR${i + 1}`), 'LPDDR3L', 'LPDDR4X', 'LPDDR5X', 'LPDDR6X',
  ...Array.from({ length: 7 }, (_, i) => `GDDR${i + 1}`), 'GDDR5X', 'GDDR6X', 'GDDR7X']);
function memoryTypes(value: unknown, kind: PartKind): string[] {
  const text = typeof value === 'string' ? value : Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.join(' / ') : '';
  const tokens = text.toUpperCase().match(/\b(?:LP\s*DDR\s*[1-6][XLT]?|G\s*DDR\s*[1-7]X?|DDR\s*[1-6][XL]?)\b/g) ?? [];
  return [...new Set(tokens.map((token) => token.replace(/\s/g, ''))
    .filter((token) => allowedTypes.has(token) && (kind === 'cpu' ? !token.startsWith('GDDR') : !token.startsWith('LPDDR'))))].sort();
}
function validLink(value: unknown): value is string {
  if (!string(value, 2_000)) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

type IndexRow = { slug: string; name: string };
type IndexEntry = { fetchedAt: string; results: IndexRow[] };
type DetailEntry = { fetchedAt: string; record: TechMemoryRecord | null };
type CacheFile = { version: 1; attribution: typeof TECHAPI_ATTRIBUTION; indexes: Partial<Record<PartKind, IndexEntry>>;
  details: Record<string, DetailEntry>; misses: Record<string, string> };

function parseIndex(value: unknown): IndexRow[] {
  if (!isObject(value) || !Array.isArray(value.results) || value.results.length > MAX_ROWS) throw new Error('Invalid TechAPI index');
  if (value.count !== undefined && (!Number.isInteger(value.count) || value.count !== value.results.length)) throw new Error('Incomplete TechAPI index');
  const results = new Map<string, IndexRow>();
  for (const row of value.results) {
    if (!isObject(row) || !validSlug(row.slug) || !string(row.name)) throw new Error('Invalid TechAPI index entries');
    results.set(row.slug, { slug: row.slug, name: row.name });
  }
  if (value.results.length && !results.size) throw new Error('Invalid TechAPI index entries');
  return [...results.values()];
}
function matchingRows(index: IndexEntry | undefined, part: MemoryPartRequest): IndexRow[] {
  if (!index) return [];
  const key = part.kind === 'cpu' ? cpuKey(part.model) : gpuKey(part.model), gpuClass = requestedClass(part);
  if (!key || part.kind === 'gpu' && gpuClass === 'integrated') return [];
  return index.results.filter((row) => part.kind === 'cpu' ? cpuKey(row.name) === key
    : gpuKey(row.name) === key && (!gpuClass || gpuClassOf(row.name) === gpuClass));
}
function samePart(kind: PartKind, name: string, row: IndexRow): boolean {
  return kind === 'cpu' ? cpuKey(name) === cpuKey(row.name) : gpuName(name) === gpuName(row.name);
}
function parseDetail(value: unknown, kind: PartKind, row: IndexRow, fetchedAt: string): TechMemoryRecord {
  if (!isObject(value) || !string(value.name) || value.slug !== row.slug
    || !samePart(kind, value.name, row)) {
    throw new Error('Invalid TechAPI part identity');
  }
  return { kind, name: value.name, types: memoryTypes(kind === 'cpu' ? value.memory_support : value.memory_type, kind),
    socket: kind === 'cpu' && string(value.socket, 80) ? value.socket : null,
    gpuClass: kind === 'gpu' ? gpuClassOf(value.name) : null, url: endpoint(kind, row.slug),
    sourceUrls: Array.isArray(value.source_urls) ? [...new Set(value.source_urls.filter(validLink))].slice(0, 32) : [], fetchedAt };
}
function parseCache(value: unknown): CacheFile {
  if (!isObject(value) || value.version !== 1 || !isObject(value.indexes) || !isObject(value.details) || !isObject(value.misses)
    || Object.keys(value.details).length > MAX_ROWS || Object.keys(value.misses).length > MAX_ROWS) throw new Error('Invalid TechAPI cache');
  const indexes: CacheFile['indexes'] = {};
  for (const kind of ['cpu', 'gpu'] as const) {
    const entry = value.indexes[kind];
    if (entry === undefined) continue;
    if (!isObject(entry) || !validDate(entry.fetchedAt)) throw new Error('Invalid TechAPI index cache');
    indexes[kind] = { fetchedAt: entry.fetchedAt, results: parseIndex(entry) };
  }
  const details: CacheFile['details'] = Object.create(null), misses: CacheFile['misses'] = Object.create(null);
  for (const [key, entry] of Object.entries(value.details)) {
    const match = /^(cpu|gpu)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(key);
    if (!match || !validSlug(match[2]) || !isObject(entry) || !validDate(entry.fetchedAt)) throw new Error('Invalid TechAPI detail cache');
    const kind = match[1] as PartKind, record = entry.record;
    if (record !== null && (!isObject(record) || record.kind !== kind || !string(record.name)
      || record.url !== endpoint(kind, match[2]) || record.fetchedAt !== entry.fetchedAt
      || !Array.isArray(record.types) || record.types.length > 32 || !record.types.every((type) => typeof type === 'string' && allowedTypes.has(type)
        && (kind === 'cpu' ? !type.startsWith('GDDR') : !type.startsWith('LPDDR')))
      || !(record.socket === null || kind === 'cpu' && string(record.socket, 80))
      || !(record.gpuClass === null && kind === 'cpu' || kind === 'gpu' && ['desktop', 'mobile'].includes(String(record.gpuClass)))
      || !Array.isArray(record.sourceUrls) || record.sourceUrls.length > 32 || !record.sourceUrls.every(validLink))) throw new Error('Invalid TechAPI record cache');
    if (record && (kind === 'gpu' && record.gpuClass !== gpuClassOf(record.name as string))) throw new Error('Invalid TechAPI GPU class cache');
    const indexed = indexes[kind]?.results.find((row) => row.slug === match[2]);
    if (record && indexed && !samePart(kind, record.name as string, indexed)) throw new Error('Invalid TechAPI cached part identity');
    details[key] = { fetchedAt: entry.fetchedAt, record: record as TechMemoryRecord | null };
  }
  for (const [key, date] of Object.entries(value.misses)) {
    if (key.length > 400 || !/^(?:cpu|gpu):[a-z0-9]+:(?:desktop|mobile|unknown|integrated)?$/.test(key) || !validDate(date)) throw new Error('Invalid TechAPI miss cache');
    misses[key] = date;
  }
  return { version: 1, attribution: TECHAPI_ATTRIBUTION, indexes, details, misses };
}

async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

/** External data remains unverified supplemental evidence. Reads never perform network or establish capacity. */
export class TechAPICache implements MemoryTypeLookup {
  private readonly fetcher: typeof fetch;
  private readonly laptops: TechAPILaptopCache;
  private cache: CacheFile = { version: 1, attribution: TECHAPI_ATTRIBUTION, indexes: {}, details: Object.create(null), misses: Object.create(null) };
  private queue: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private lastWarmedAt: string | null = null;
  private retryAfter = 0;
  constructor(private readonly directory: string, options: { fetch?: typeof fetch } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.laptops = new TechAPILaptopCache(directory, { ...options, attribution: TECHAPI_ATTRIBUTION });
    try {
      const filename = path.join(directory, TECHAPI_CACHE_FILE);
      if (statSync(filename).size > MAX_CACHE_BYTES) throw new Error('TechAPI cache exceeds size limit');
      this.cache = parseCache(JSON.parse(readFileSync(filename, 'utf8')));
    } catch (error) {
      if (!(isObject(error) && error.code === 'ENOENT')) this.lastError = error instanceof Error ? error.message : 'Unable to read TechAPI cache';
    }
  }
  get status() {
    return { records: Object.values(this.cache.details).filter((entry) => entry.record !== null).length,
      indexes: Object.keys(this.cache.indexes).length, misses: Object.keys(this.cache.misses).length,
      staleRecords: Object.values(this.cache.details).filter((entry) => entry.record !== null && !fresh(entry.fetchedAt)).length,
      lastError: this.lastError, lastWarmedAt: this.lastWarmedAt,
      retryAfter: this.retryAfter > Date.now() ? new Date(this.retryAfter).toISOString() : null,
      cooldownRemainingMs: Math.max(0, this.retryAfter - Date.now()), ...this.laptops.status };
  }
  getLaptops(request: LaptopSpecRequest): readonly TechLaptopRecord[] { return this.laptops.getLaptops(request); }
  warmLaptops(requests: LaptopSpecRequest[], signal?: AbortSignal): Promise<void> {
    // Share the public queue so simultaneous memory and laptop batches cannot exceed the provider concurrency bound.
    const run = this.queue.then(() => this.laptops.warmLaptops(requests, signal));
    this.queue = run.catch(() => {});
    return run;
  }
  get(kind: PartKind, model: string, gpuClass?: GPUClass): readonly TechMemoryRecord[] {
    if (!string(model) || !['cpu', 'gpu'].includes(kind)) return [];
    const rows = matchingRows(this.cache.indexes[kind], { kind, model, gpuClass });
    // A missing variant is not evidence that the remaining cached variant is the only possible type.
    if (rows.some((row) => {
      const record = this.cache.details[`${kind}/${row.slug}`]?.record;
      return !record || !samePart(kind, record.name, row);
    })) return [];
    return rows.map((row) => {
      const record = this.cache.details[`${kind}/${row.slug}`]!.record!;
      return { ...record, types: [...record.types], sourceUrls: [...record.sourceUrls] };
    });
  }
  warm(parts: MemoryPartRequest[], signal?: AbortSignal): Promise<void> {
    const requested = new Map<string, MemoryPartRequest>();
    for (const part of parts) if (part && ['cpu', 'gpu'].includes(part.kind) && string(part.model)
      && !(part.kind === 'gpu' && requestedClass(part) === 'integrated')) requested.set(keyOf(part), { ...part });
    const run = this.queue.then(() => this.warmNow([...requested.values()], signal));
    this.queue = run.catch(() => {});
    return run;
  }
  private async warmNow(parts: MemoryPartRequest[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!parts.length || this.retryAfter > Date.now()) return;
    this.lastError = null;
    this.retryAfter = 0;
    let dirty = false;
    const handleFailure = (error: unknown, provider = true) => {
      // Caller cancellation is control flow, and must not suppress a later manual lookup.
      if (signal?.aborted) return;
      this.lastError = error instanceof Error ? error.message : 'TechAPI request failed';
      if (provider) this.retryAfter = Date.now() + FAILURE_COOLDOWN;
    };
    await pool([...new Set(parts.map((part) => part.kind))], 2, async (kind) => {
      if (this.retryAfter > Date.now() || this.cache.indexes[kind] && fresh(this.cache.indexes[kind]!.fetchedAt)) return;
      try {
        const value = await this.json(endpoint(kind), MAX_INDEX_BYTES, signal);
        this.cache.indexes[kind] = { fetchedAt: new Date().toISOString(), results: parseIndex(value) };
        // A newly published variant or model must not be hidden by a negative result from the old index.
        for (const key of Object.keys(this.cache.misses)) if (key.startsWith(`${kind}:`)) delete this.cache.misses[key];
        dirty = true;
      } catch (error) { handleFailure(error); }
    });
    signal?.throwIfAborted();
    const details = new Map<string, { kind: PartKind; row: IndexRow }>();
    for (const part of parts) {
      const key = keyOf(part), missedAt = this.cache.misses[key];
      if (missedAt && fresh(missedAt)) continue;
      const index = this.cache.indexes[part.kind], rows = matchingRows(index, part);
      if (index && !rows.length && fresh(index.fetchedAt)) {
        this.cache.misses[key] = new Date().toISOString(); dirty = true;
      }
      for (const row of rows) {
        const detailKey = `${part.kind}/${row.slug}`, existing = this.cache.details[detailKey];
        if (!existing || !fresh(existing.fetchedAt) || existing.record && !samePart(part.kind, existing.record.name, row)) details.set(detailKey, { kind: part.kind, row });
      }
    }
    await pool([...details].slice(0, MAX_DETAILS_PER_WARM), 3, async ([key, { kind, row }]) => {
      if (this.retryAfter > Date.now()) return;
      try {
        const value = await this.json(endpoint(kind, row.slug), MAX_DETAIL_BYTES, signal, true), fetchedAt = new Date().toISOString();
        // A transient 404 must not replace a last-good record.
        if (value !== null || !this.cache.details[key]?.record) {
          this.cache.details[key] = { fetchedAt, record: value === null ? null : parseDetail(value, kind, row, fetchedAt) }; dirty = true;
        }
      } catch (error) { handleFailure(error); }
    });
    // Persist completed work even when a caller cancelled the remaining lookups.
    if (dirty) {
      try { await this.save(); } catch (error) { handleFailure(error, false); }
    }
    this.lastWarmedAt = new Date().toISOString();
    signal?.throwIfAborted();
  }
  private async json(url: string, maximum: number, signal?: AbortSignal, allowMissing = false): Promise<unknown> {
    signal?.throwIfAborted();
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
    const response = await this.fetcher(url, { signal: requestSignal, redirect: 'error', headers: { Accept: 'application/json' } });
    const discard = () => { void response.body?.cancel().catch(() => {}); };
    if (allowMissing && response.status === 404) { discard(); return null; }
    if (!response.ok || response.url && response.url !== url) { discard(); throw new Error(`TechAPI response rejected (${response.status})`); }
    if (Number(response.headers.get('content-length')) > maximum) { discard(); throw new Error('TechAPI response exceeds size limit'); }
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('application/json')) { discard(); throw new Error('TechAPI response is not JSON'); }
    if (!response.body) throw new Error('Empty TechAPI response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        requestSignal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > maximum) throw new Error('TechAPI response exceeds size limit');
        chunks.push(next.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private async save() {
    const data = JSON.stringify(this.cache);
    if (Buffer.byteLength(data) > MAX_CACHE_BYTES) throw new Error('TechAPI cache exceeds size limit');
    await mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, TECHAPI_CACHE_FILE), temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
