import type { Condition, HardwareKind, RawListing } from '../shared/types.ts';

type ObjectValue = Record<string, unknown>;
type SearchInput = {
  kind: HardwareKind;
  location: 'danang' | 'nationwide';
  query?: string;
  page?: number;
  signal?: AbortSignal;
};

const ORIGIN = 'https://www.chotot.com';
const TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 12;
// Verified public component labels: RAM, VGA, CPU, and SSD respectively.
const COMPONENT_TYPES = { ram: 1, gpu: 2, cpu: 13, ssd: 16 } as const;
const PRODUCT_FIELDS = new Set([
  'pc_brand', 'pc_model', 'pc_cpu', 'pc_vga', 'pc_ram', 'pc_drive_capacity',
  'pc_drive_type', 'pc_screen_size', 'component_class', 'component_type',
  'elt_condition', 'elt_warranty', 'elt_origin', 'usage_information',
]);
const ATTRIBUTE_FIELDS = new Set([
  ...PRODUCT_FIELDS, 'ad_id', 'category', 'type', 'status', 'giveaway',
  'is_price_not_valid',
]);

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue : {};
}

function publicText(value: unknown, limit = 1_000): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/(?<![\w])(?:\+?84|0)[\s().•·-]*[35789](?:[\s().•·-]*\d){8}(?!\d)/g, '[phone removed]')
    .replace(/(?<![\w])(?:\+?84|0)[\s().•·-]*2(?:[\s().•·-]*\d){9}(?!\d)/g, '[phone removed]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
    .replace(/https?:\/\/(?:www\.)?zalo\.me\/[^\s<>]+/gi, '[contact removed]')
    .replace(/\u0000/g, '').trim().slice(0, limit);
}

function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const names: Record<string, string> = {
      '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>',
    };
    const named = names[entity.toLowerCase()];
    if (named !== undefined) return named;
    const code = entity.toLowerCase().startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeAttribute(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function listingUrl(value: unknown, expectedId?: string): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(decodeAttribute(value), ORIGIN);
    const id = /\/(\d+)\.htm$/.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || !['www.chotot.com', 'chotot.com'].includes(url.hostname)
      || url.username || url.password || !id || (expectedId && id !== expectedId)) return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value, ORIGIN);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'chotot.com' || url.hostname.endsWith('.chotot.com')) ? url.href : null;
  } catch { return null; }
}

function linksFromHtml(html: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const url = listingUrl(attribute(match[0], 'href'));
    if (url) links.set(/\/(\d+)\.htm$/.exec(new URL(url).pathname)![1], url);
  }
  return links;
}

function canonicalFromHtml(html: string, id: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    if (attribute(match[0], 'rel')?.toLowerCase().split(/\s+/).includes('canonical')) {
      const url = listingUrl(attribute(match[0], 'href'), id);
      if (url) return url;
    }
  }
  return null;
}

function nextData(html: string): ObjectValue {
  const match = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .find(script => attribute(script[1], 'id') === '__NEXT_DATA__');
  if (!match) throw new Error('Chợ Tốt did not provide listing data. The page may have changed or served an access challenge.');
  try { return object(JSON.parse(match[2].replace(/^\uFEFF/, ''))); }
  catch { throw new Error('Chợ Tốt returned invalid embedded listing data.'); }
}

function states(data: ObjectValue): ObjectValue[] {
  const props = object(data.props);
  return [object(object(props.pageProps).initialState), object(props.initialState)];
}

function parameters(...sources: unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    const entries = Array.isArray(source) ? source.map(v => ['', v] as const) : Object.entries(object(source));
    for (const [key, value] of entries) {
      const item = object(value);
      const id = typeof item.id === 'string' ? item.id : key;
      if (!PRODUCT_FIELDS.has(id)) continue;
      const text = publicText(item.value ?? (typeof value === 'string' ? value : ''), 500);
      if (text) result[id] = text;
    }
  }
  return result;
}

function condition(raw: ObjectValue, params: Record<string, string>, previous?: Condition): Condition {
  const code = Number(raw.elt_condition);
  if (code === 1) return 'new';
  if (code === 2) return 'used';
  if (code === 3) return 'repaired';
  const label = (params.elt_condition ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (label.includes('chua sua chua')) return 'used';
  if (label.includes('qua sua chua')) return 'repaired';
  if (label.includes('moi')) return 'new';
  if (label.includes('su dung')) return 'used';
  return previous ?? 'unknown';
}

function kind(raw: ObjectValue, fallback: HardwareKind): HardwareKind {
  if (raw.type === 'b') return 'wanted';
  if (Number(raw.category) === 5030) return 'laptop';
  if (Number(raw.category) === 5070) return 'desktop';
  if (Number(raw.category) === 5080 || raw.component_type !== undefined) {
    if (Number(raw.component_class) !== 1) return 'other';
    const type = Number(raw.component_type);
    for (const [name, code] of Object.entries(COMPONENT_TYPES)) {
      if (type === code) return name as keyof typeof COMPONENT_TYPES;
    }
    return 'other';
  }
  return raw.category === undefined ? fallback : 'other';
}

function normalize(
  raw: ObjectValue, fallbackKind: HardwareKind, url: string, observedAt: string,
  detailParams: Record<string, string> = {}, previous?: RawListing,
): RawListing | null {
  const id = typeof raw.list_id === 'number' || typeof raw.list_id === 'string' ? String(raw.list_id) : '';
  const title = publicText(raw.subject ?? previous?.title, 400);
  if (!/^\d+$/.test(id) || !title || !listingUrl(url, id)) return null;
  const params = { ...previous?.params, ...parameters(raw.params), ...detailParams };
  const attributes = { ...previous?.attributes } as RawListing['attributes'];
  for (const key of ATTRIBUTE_FIELDS) {
    const value = raw[key];
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      attributes[key] = value;
    } else if (typeof value === 'string') attributes[key] = publicText(value, 500);
  }
  if (/^(?:deleted|sold|expired|inactive|removed|hidden|rejected|refused)$/.test(String(attributes.status ?? '').toLowerCase())) attributes._sourceUnavailable = true;
  else if (attributes.status === 'active') delete attributes._sourceUnavailable;
  const candidates = [
    ...(Array.isArray(raw.images) ? raw.images : []),
    ...(Array.isArray(raw.image_thumbnails) ? raw.image_thumbnails.map(v => object(v).image) : []),
    raw.image, raw.thumbnail_image, raw.webp_image,
  ];
  const images = [...new Set(candidates.map(imageUrl).filter((v): v is string => v !== null))].slice(0, MAX_IMAGES);
  const numericPrice = typeof raw.price === 'number' ? raw.price
    : typeof raw.price === 'string' && /^\d+(?:\.\d+)?$/.test(raw.price) ? Number(raw.price) : NaN;
  const price = Number.isFinite(numericPrice) && numericPrice >= 0 ? numericPrice : previous?.price ?? 0;
  attributes.price_available = Number.isFinite(numericPrice) && numericPrice >= 0;
  const seller = raw.account_id ?? raw.account_oid ?? previous?.sellerId;
  const sellerId = (typeof seller === 'string' || typeof seller === 'number') && /^[\w-]{1,128}$/.test(String(seller))
    ? String(seller) : null;
  return {
    id, category: kind(raw, fallbackKind), title,
    description: publicText(raw.body ?? previous?.description, 12_000), price, url,
    images: images.length ? images : previous?.images ?? [], sellerId,
    sellerType: raw.company_ad === true ? 'business' : raw.company_ad === false ? 'private' : previous?.sellerType ?? 'unknown',
    region: publicText(raw.region_name ?? raw.region_name_v3 ?? previous?.region, 150),
    district: publicText(raw.area_name ?? previous?.district, 150),
    ward: publicText(raw.ward_name ?? raw.ward_name_v3 ?? previous?.ward, 150),
    condition: condition(raw, params, previous?.condition), params, attributes, observedAt,
    displayAge: publicText(raw.date ?? previous?.displayAge, 100),
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES) {
    await response.body?.cancel();
    throw new Error('Chợ Tốt returned an unexpectedly large page.');
  }
  if (!response.body) throw new Error('Chợ Tốt returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error('Chợ Tốt returned an unexpectedly large page.');
      }
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Public HTML adapter. It never imports browser sessions or stores the source payload. */
export class ChototClient {
  private readonly fetcher: typeof fetch;
  private readonly pauseMs: number;
  private nextRequestAt = 0;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor({ fetch: fetcher = globalThis.fetch, pauseMs = 350 }: { fetch?: typeof fetch; pauseMs?: number } = {}) {
    this.fetcher = fetcher;
    this.pauseMs = Math.max(0, Number.isFinite(pauseMs) ? pauseMs : 350);
  }

  async search({ kind: requestedKind, location, query = '', page = 1, signal }: SearchInput): Promise<{ items: RawListing[]; total: number | null }> {
    if (!['laptop', 'desktop', 'gpu', 'ram', 'cpu', 'ssd'].includes(requestedKind)) {
      throw new Error(`Chợ Tốt search does not support hardware kind ${requestedKind}.`);
    }
    if (!['danang', 'nationwide'].includes(location)) throw new Error('Unsupported Chợ Tốt search location.');
    if (!Number.isInteger(page) || page < 1 || page > 1_000) throw new Error('Chợ Tốt page must be an integer between 1 and 1000.');
    if (query.length > 200) throw new Error('Chợ Tốt query must be no longer than 200 characters.');
    const route = requestedKind === 'laptop' ? 'laptop' : requestedKind === 'desktop' ? 'may-tinh-de-ban' : 'linh-kien';
    const url = new URL(`/mua-ban-${route}${location === 'danang' ? '-da-nang' : ''}`, ORIGIN);
    if (requestedKind in COMPONENT_TYPES) {
      url.searchParams.set('component_class', '1');
      url.searchParams.set('component_type', String(COMPONENT_TYPES[requestedKind as keyof typeof COMPONENT_TYPES]));
    }
    if (query.trim()) url.searchParams.set('q', query.trim());
    if (page > 1) url.searchParams.set('page', String(page));
    const { html } = await this.html(url.href, signal);
    const data = nextData(html);
    const state = states(data).find(s => Array.isArray(object(object(s.adlisting).data).ads));
    if (!state) throw new Error('Chợ Tốt listing data has an unsupported structure.');
    const listingData = object(object(state.adlisting).data);
    const ads = listingData.ads as unknown[];
    const links = linksFromHtml(html);
    const observedAt = new Date().toISOString();
    const items: RawListing[] = [];
    const seen = new Set<string>();
    for (const entry of ads) {
      const raw = object(entry);
      const id = String(raw.list_id ?? '');
      const itemUrl = links.get(id) ?? listingUrl(raw.url ?? raw.ad_url, id);
      if (!itemUrl || seen.has(id)) continue;
      const listing = normalize(raw, requestedKind, itemUrl, observedAt);
      if (listing) { items.push(listing); seen.add(id); }
    }
    if (ads.length && !items.length) throw new Error('Chợ Tốt did not provide usable listing links or records.');
    const total = typeof listingData.total === 'number' && Number.isFinite(listingData.total) && listingData.total >= 0
      ? listingData.total : null;
    return { items, total };
  }

  async detail(listing: RawListing, signal?: AbortSignal): Promise<RawListing> {
    const url = listingUrl(listing.url, listing.id);
    if (!url) throw new Error('The listing does not have a valid public Chợ Tốt URL.');
    const result = await this.html(url, signal);
    const data = nextData(result.html);
    const info = states(data).map(s => object(object(s.adView).adInfo)).find(i => object(i.ad).list_id !== undefined);
    if (!info) throw new Error('Chợ Tốt detail data has an unsupported structure.');
    const raw = object(info.ad);
    if (String(raw.list_id) !== listing.id) throw new Error('Chợ Tốt returned a different item for this listing.');
    const detailUrl = canonicalFromHtml(result.html, listing.id) ?? listingUrl(result.url, listing.id) ?? url;
    const params = parameters(info.params, info.parameters, info.ad_params);
    const item = normalize(raw, listing.category, detailUrl, new Date().toISOString(), params, listing);
    if (!item) throw new Error('Chợ Tốt returned an invalid detail record.');
    // A successful full-description read supersedes a previous transient detail failure.
    delete item.attributes._detailError;
    return item;
  }

  private async requestTurn(signal?: AbortSignal): Promise<() => void> {
    const previous = this.requestQueue;
    let release!: () => void;
    this.requestQueue = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      signal?.throwIfAborted();
      // Recheck against actual dispatch time after delayed or early timer wakeups.
      while (this.nextRequestAt > performance.now()) await wait(this.nextRequestAt - performance.now(), signal);
      signal?.throwIfAborted();
      return release;
    } catch (error) { release(); throw error; }
  }

  private async html(url: string, signal?: AbortSignal): Promise<{ html: string; url: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const release = await this.requestTurn(signal);
      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new DOMException('Chợ Tốt request timed out.', 'TimeoutError')), TIMEOUT_MS);
      let retryDelay = 0;
      try {
        let pendingResponse: Promise<Response>;
        try {
          signal?.throwIfAborted();
          this.nextRequestAt = performance.now() + this.pauseMs;
          pendingResponse = this.fetcher(url, {
          signal: requestSignal, redirect: 'follow',
          headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Flipper/0.1; local public-listing reader)' },
          });
        } finally { release(); }
        const response = await pendingResponse;
        const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
        if (retryable) {
          await response.body?.cancel();
          if (attempt === 2) throw new Error(`Chợ Tốt is temporarily unavailable (HTTP ${response.status}). Try refreshing later.`);
          const retryAfter = response.headers.get('retry-after');
          const parsed = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(parsed) && parsed > 5_000) {
            throw new Error('Chợ Tốt requested a longer rate-limit wait. Try refreshing later.');
          }
          retryDelay = Number.isFinite(parsed) ? Math.max(0, parsed) : 500 * 2 ** attempt;
        } else {
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(response.status === 404 || response.status === 410
              ? `This Chợ Tốt page is no longer available (HTTP ${response.status}).`
              : `Chợ Tốt refused the request (HTTP ${response.status}).`);
          }
          if (response.url && !['www.chotot.com', 'chotot.com'].includes(new URL(response.url).hostname)) {
            await response.body?.cancel();
            throw new Error('Chợ Tốt redirected the request outside the marketplace.');
          }
          return { html: await boundedText(response), url: response.url || url };
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (controller.signal.aborted) throw new Error('Chợ Tốt request timed out after 15 seconds.');
        if (error instanceof Error && /^Chợ Tốt|^This Chợ Tốt/.test(error.message)) throw error;
        throw new Error('Could not read Chợ Tốt. Check the connection and try refreshing again.');
      } finally { clearTimeout(timer); }
      await wait(retryDelay, signal);
    }
    throw new Error('Chợ Tốt could not be reached.');
  }
}
