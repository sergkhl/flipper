import { createHash } from 'node:crypto';
import type { HardwareProfile, RawListing } from '../shared/types.ts';
import { freshDate, type RetailLookup, type RetailPrice, type RetailPartKind } from '../shared/retail.ts';
import { assessWithRules, cpuModels, gpuModels, normalize, retailLaptopModel } from './hardware.ts';
import { readPublic, type PriceFetch, type RuntimeCache } from './price-cache.ts';
import { concurrent, WorkPool } from './concurrency.ts';

/** Reviewed Vietnamese shops. Their listed prices include VAT unless the product page explicitly says otherwise. */
export const RETAIL_SHOPS: Record<string, { name: string; vat: string }> = {
  'hacom.vn': { name: 'HACOM', vat: 'Product pages state “Giá đã bao gồm VAT” (reviewed 26 Oct 2026).' },
  'www.anphatpc.com.vn': { name: 'An Phát', vat: 'Product pages state “Giá đã có VAT” (reviewed 26 Oct 2026).' },
  'phongvu.vn': { name: 'Phong Vũ', vat: 'Terms of sale §3.1: listed prices include VAT (help.phongvu.vn/chinh-sach-ban-hang/dieu-kien-giao-dich, reviewed 26 Oct 2026).' },
  'www.tnc.com.vn': { name: 'TNC', vat: 'Product pages state “bao gồm VAT” (reviewed 26 Oct 2026).' },
};
const allowed = (url: URL) => url.hostname in RETAIL_SHOPS && !/^\/(?:api|admin|ajax|cart|checkout)(?:\/|$)/.test(url.pathname);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): any[] => Array.isArray(value) ? value : value == null ? [] : [value];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const decode = (value: string) => value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
  .replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_all,n) => Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : '');
const plain = (value: string) => decode(value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ');
const schemaType = (value: unknown, expected: string) => array(value).some(type => text(type).split('/').pop()?.toLowerCase() === expected.toLowerCase());
// A pre-order or back-order is not stock that can be bought now; it is skipped rather than treated as a failed read.
const unavailable = ['OutOfStock', 'SoldOut', 'Discontinued', 'PreOrder', 'PreSale', 'BackOrder'];
// Display, activated, clearance and second-hand units are not factory-new stock, whatever their structured condition says.
const notFactoryNew = /\b(?:demo|trung bay|da kich hoat|thanh ly|like ?new|cu dep|may cu|hang cu|open ?box|refurbished|renew|tan trang)\b/;
const vatExcluded = /\b(?:gia\s+)?chua\s+(?:bao\s+gom|gom|co|tinh)\s+(?:thue\s+)?(?:vat|gtgt)\b|\bexcluding\s+vat\b/;
// "Liên hệ" placeholders publish token amounts such as 0 or 1 VND; no factory-new laptop costs less than this.
const MIN_RETAIL_LAPTOP_VND = 1_000_000;
function nodes(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!object(value)) return [];
  return [value, ...array(value['@graph']).flatMap(nodes)];
}
type RetailKind = 'laptop' | RetailPartKind;
function productProfile(product: Record<string, any>, url: string, at: string, kind: RetailKind): HardwareProfile {
  const properties = array(product.additionalProperty).filter(object).flatMap(p => {
    const name = plain(text(p.name)), value = plain(text(p.value)), field = normalize(name);
    // A CPU's supported RAM generations are controller capabilities, not conflicting installed RAM.
    if (kind === 'cpu') return cpuModels(value).length && /cpu|model|ten goi|vi xu ly/.test(field) ? [`${name}: ${value}`] : [];
    if (kind === 'ram' && /ecc/.test(field)) {
      if (/on[- ]die/.test(field)) return [];
      if (/^(?:khong|no|non|false|0)(?:\b|$)/.test(normalize(value))) return ['non-ECC'];
      if (/^(?:n\/?a|none|khong ro|unknown|-)?$/.test(normalize(value))) return [];
    }
    return [`${name}: ${value}`];
  });
  const title = plain(text(product.name)).replace(/\bRAM Desktop\b/gi,'RAM PC');
  // Component marketing copy mentions other models and upgrade limits. Only the named product and its structured specifications identify a part.
  const description = [...(kind === 'laptop' ? [plain(text(product.description))] : []),...properties].join('\n');
  const raw: RawListing = { id: url, title, description, category:kind, price:1, url, images:[], sellerId:null,
    sellerType:'business', region:'', district:'', ward:'', condition:'new', params:{}, attributes:{}, observedAt:at, displayAge:'' };
  const result = assessWithRules(raw);
  if (result.kind !== kind) throw new Error('Retail product is not the requested hardware kind');
  if (kind !== 'laptop') {
    const named = normalize(title);
    if (/\b(?:combo|bundle|kem bo|kem may|waterblock|backplate|riser)\b/.test(named)
      || (kind === 'gpu' || kind === 'cpu') && /\b(?:laptop|mobile)\b/.test(named)) throw new Error('Not an individual desktop component');
    if (kind === 'ssd') {
      if (/\b(?:gan ngoai|external|portable|usb|di dong)\b/.test(named)) throw new Error('External storage is not an internal SSD');
      const interfaces = normalize(`${title}\n${description}`);
      if (/\bnvme\b/.test(interfaces) && /\bsata\b/.test(interfaces)) throw new Error('Retail SSD interface is conflicting');
    }
    if (kind === 'ram') {
      const layout = title.match(/\b(\d{1,2})\s*[x×]\s*(\d{1,3})\s*gb\b/i);
      const total = title.match(/\b(\d{1,3})\s*gb\b/i);
      if (layout && total && Number(total[1]) !== Number(layout[1])*Number(layout[2]) && total.index! < layout.index!) throw new Error('Retail RAM capacity and layout conflict');
      // A total plus its explicit kit layout are consistent claims, not two installed capacities.
      if (layout) {
        for (const property of array(product.additionalProperty).filter(object)) {
          if (!/^(?:dung luong|capacity|total capacity|tong dung luong|bo nho)$/.test(normalize(plain(text(property.name))))) continue;
          const explicit = plain(text(property.value)).match(/^(\d{1,3})\s*gb$/i);
          if (explicit && Number(explicit[1]) !== Number(layout[1])*Number(layout[2])) throw new Error('Retail RAM structured capacity and layout conflict');
        }
        result.profile.quantity = Number(layout[1]); result.profile.perUnitGb = Number(layout[2]);
        result.profile.ramGb = Number(layout[1])*Number(layout[2]);
        result.conflicts = result.conflicts.filter(c => c !== 'Title and description disagree about RAM capacity');
      }
    }
    if (result.conflicts.length) throw new Error('Retail product configuration is conflicting');
    const p = result.profile;
    if (kind === 'gpu' && (!p.gpu || !p.vramGb || p.gpuClass !== 'desktop')
      || kind === 'cpu' && !p.cpu || kind === 'ram' && (!p.ramGb || !p.ramType || !p.ramFormFactor)
      || kind === 'ssd' && (!p.storageGb || !/SSD/.test(p.storageType ?? ''))) throw new Error('Retail component identity is incomplete');
    return p;
  }
  if (result.conflicts.length) throw new Error('Retail product configuration is conflicting');
  const shown = titleCapacities(title), ramFromTitle = result.profile.ramGb === null && shown.ramGb !== null;
  return { ...result.profile, model: result.profile.model ?? retailLaptopModel(title),
    ramGb: result.profile.ramGb ?? shown.ramGb, storageGb: result.profile.storageGb ?? shown.storageGb,
    // An unlabelled "RTX 3050 | 16GB" pairs the card with the next bare capacity, which is the system RAM.
    vramGb: ramFromTitle && result.profile.vramGb === shown.ramGb ? null : result.profile.vramGb };
}
/** Shop titles list bare capacities ("… | 16GB | 512GB | …"); one unambiguous value each can fill an unlabelled field. */
function titleCapacities(title: string): { ramGb: number | null; storageGb: number | null } {
  const parts = title.toLowerCase().split(/[|/(),]+/).map(part => part.trim());
  const ram = new Set(parts.map(part => Number(/^(\d{1,3})\s*gb$/.exec(part)?.[1]))
    .filter(value => [4,8,12,16,18,24,32,36,48,64,96,128].includes(value)));
  const storage = new Set(parts.map(part => /^(\d{3,4})\s*gb$|^(\d)\s*tb$/.exec(part)).flatMap(match =>
    match ? [match[1] ? Number(match[1]) : Number(match[2]) * 1024] : []).filter(value => value >= 128));
  return { ramGb: ram.size === 1 ? [...ram][0]! : null, storageGb: storage.size === 1 ? [...storage][0]! : null };
}
/** The page has to show the structured amount, in any common Vietnamese grouping. */
function shownOnPage(amount: number, visible: string): boolean {
  const grouped = Math.round(amount).toLocaleString('en-US');
  return [grouped, grouped.replace(/,/g,'.'), grouped.replace(/,/g,' '), String(Math.round(amount))]
    .some(form => new RegExp(`(?<![\\d.,])${form.replace(/[.]/g,'\\.')}(?![\\d])`).test(visible));
}

/** Read structured product offers only; crossed-out/list/instalment prices are never substituted. */
export function parseRetailPage(html: string, url: string, now = Date.now(), kind: RetailKind = 'laptop'): RetailPrice[] {
  const at = new Date(now).toISOString(), products: Record<string,any>[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    // Raw control characters inside generated strings are invalid JSON but carry no product data.
    try { products.push(...nodes(JSON.parse(match[1].replace(/[\x00-\x1f]/g,' '))).filter(node => schemaType(node['@type'],'Product'))); }
    catch { /* A malformed unrelated JSON-LD block cannot become price evidence. */ }
  }
  if (!products.length) throw new Error('Retail page has no readable product offers');
  const visible = plain(html), shop = RETAIL_SHOPS[new URL(url).hostname];
  const vatIncluded = !vatExcluded.test(normalize(visible));
  const result: RetailPrice[] = []; let inspected = false;
  for (const product of products) {
    for (const offer of array(product.offers).filter(object)) {
      const canonical = new URL(text(offer.url) || text(product.url) || url, url);
      if (canonical.origin !== new URL(url).origin || canonical.pathname.replace(/\/$/,'') !== new URL(url).pathname.replace(/\/$/,'')) continue;
      inspected = true;
      if (!schemaType(offer['@type'],'Offer')) throw new Error('Retail price is an unspecified configuration range');
      const condition = offer.itemCondition ?? product.itemCondition;
      if (schemaType(condition,'UsedCondition') || schemaType(condition,'RefurbishedCondition')) continue;
      if (!schemaType(condition,'NewCondition')) throw new Error('Factory-new retail condition is unverified');
      if (notFactoryNew.test(normalize(`${plain(text(product.name))} ${decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g,' ')}`))) continue;
      if (unavailable.some(state => schemaType(offer.availability,state))) continue;
      if (!schemaType(offer.availability,'InStock')) throw new Error('Retail stock availability is unverified');
      const amount = Number(offer.price), currency = text(offer.priceCurrency);
      if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) throw new Error('Retail offer has no valid cash price');
      if (currency === 'VND' ? amount < (kind === 'laptop' ? MIN_RETAIL_LAPTOP_VND : 50_000) : amount === 0) continue;
      if (kind !== 'laptop' && /\b(?:tinh trang\s*:?\s*(?:hang dat truoc|order truoc|het hang)|san pham da ngung kinh doanh)\b/.test(normalize(visible))) continue;
      // Shops publish template validity dates (past, today or 2099), so freshness comes from Flipper's own observation date.
      if (offer.validFrom && Date.parse(offer.validFrom) > now) continue;
      if (offer.eligibleCustomerType || offer.eligibleQuantity || offer.membershipPointsEarned) continue;
      if (!shownOnPage(amount,visible)) throw new Error('Structured retail price is not shown on the product page');
      const profile = productProfile(product,url,at,kind);
      if (kind === 'laptop' && !profile.model) throw new Error('Retail laptop model is unrecognized');
      // Domestic shops: the VAT-inclusive cash price is the purchase cost; delivery is not part of the comparison.
      result.push({ id:`${url}#${product.sku ?? result.length}`, title:plain(text(product.name)).trim(), url, source:new URL(url).hostname,
        profile, amount, currency, observedAt:at, basis:'current_new',
        priceDate:at.slice(0,10), releaseDate:null, releaseYear:profile.modelYear ?? null, releaseSourceUrl:null,
        market:'VN', available:true, totalCostKnown:!!shop && vatIncluded, shipsToVietnam:true });
    }
  }
  if (!inspected) throw new Error('Retail page has no readable offer for this product');
  return result;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sitemapUrls = (xml: string) => [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map(m => decode(m[1].trim()));
function modelTerms(profile: HardwareProfile): string[] {
  const model = normalize(profile.model ?? '').replace(/^(?:apple|dell|lenovo|hp|asus|acer|msi)\s+/, '');
  const mac = model.match(/macbook\s+(air|pro|neo)/);
  return mac ? ['macbook',mac[1], ...(normalize(profile.cpu ?? '').match(/\bm\d+(?:\s+(?:pro|max))?\b/)?.[0].split(' ') ?? [])]
    : model.split(/[^a-z0-9]+/).filter(Boolean);
}
const slug = (url: string) => decodeURIComponent(url).toLowerCase();
/** Model-name candidates, minus pages whose address names a different processor. */
function candidates(urls: string[], profile: HardwareProfile, terms: string[]): string[] {
  const cpu = profile.cpu ? normalize(profile.cpu).replace(/[^a-z0-9]/g,'') : null;
  return urls.filter(url => terms.every(term => slug(url).includes(term))).filter(url => {
    if (!cpu) return true;
    const named = cpuModels(slug(url).replace(/[-_/]+/g,' '));
    return named.length !== 1 || normalize(named[0]!).replace(/[^a-z0-9]/g,'') === cpu;
  });
}

const partPaths: Record<RetailPartKind, RegExp> = {
  gpu: /^\/(?:card-man-hinh-|vga-)/,
  cpu: /^\/(?:cpu-|bo-vi-xu-ly-)/,
  ram: /^\/(?:ram-|bo-nho-trong-)/,
  ssd: /^\/(?:o-cung-(?:gan-trong-)?(?:ssd|the-ran)|ssd-)/,
};
export const ssdCapacityClass = (gb: number | null): number | null =>
  [[120,128],[240,250,256],[480,500,512],[960,1000,1024]].find(group => gb !== null && group.includes(gb))?.at(-1) ?? gb;
function partTerms(kind: RetailPartKind, p: HardwareProfile): string[] {
  if (kind === 'cpu') return (p.cpu ?? '').toLowerCase().split(/[ -]+/).filter(Boolean);
  if (kind === 'gpu') return (p.gpu ?? '').toLowerCase().split(/[ -]+/).filter(Boolean);
  if (kind === 'ram') return ['ram', p.ramType?.toLowerCase() ?? '', `${p.ramGb}gb`].filter(Boolean);
  return ['ssd', /nvme/i.test(p.storageType ?? '') ? 'nvme' : /sata/i.test(p.storageType ?? '') ? 'sata' : ''];
}
function partCandidates(urls: string[], kind: RetailPartKind, p: HardwareProfile): string[] {
  const compact = (s: string) => normalize(s).replace(/[^a-z0-9]/g,'');
  return urls.filter(url => partPaths[kind].test(new URL(url).pathname)).filter(url => {
    const path = slug(new URL(url).pathname).replace(/[-_/]+/g,' ');
    if (kind === 'cpu') return cpuModels(path).some(cpu => compact(cpu) === compact(p.cpu ?? ''));
    if (kind === 'gpu') return gpuModels(path).some(gpu => compact(gpu) === compact(p.gpu ?? ''));
    if (kind === 'ram') return compact(path).includes(compact(p.ramType ?? ''))
      && (new RegExp(`(?:^|[^0-9])${p.ramGb}\\s*(?:gb|g)\\b`).test(path) || /\b\d+\s*x\s*\d+\s*(?:gb|g)\b/.test(path));
    return [...path.matchAll(/\b(\d{1,4})\s*(gb|g|tb)\b/g)].some(m => ssdCapacityClass(Number(m[1])*(m[2] === 'tb' ? 1024 : 1)) === ssdCapacityClass(p.storageGb));
  });
}

/** Free public catalog/product pages, with shared bounded concurrency and durable seven-day caches. */
export class PublicRetailSources {
  private gate = new WorkPool(3);
  private pending = new Map<string, Promise<any>>();
  constructor(private cache: RuntimeCache, private fetcher: PriceFetch = fetch, private now = () => Date.now()) {}
  private async cached<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const saved = this.cache.runtimeValue<{ at:string; value?:T; failure?:{at:string;message:string} }>(key);
    if (saved?.value !== undefined && freshDate(saved.at,this.now())) return saved.value;
    if (saved?.failure && freshDate(saved.failure.at,this.now(),15*60_000)) throw new Error(saved.failure.message);
    if (!this.pending.has(key)) this.pending.set(key, work().then(value => {
      this.cache.setRuntimeValue(key,{at:new Date(this.now()).toISOString(),value}); return value;
    }).catch(error => {
      if (!signal?.aborted) this.cache.setRuntimeValue(key,{...saved,at:saved?.at ?? '',
        failure:{at:new Date(this.now()).toISOString(),message:error instanceof Error ? error.message : 'Retail source unavailable'}});
      throw error;
    }).finally(() => this.pending.delete(key)));
    return this.pending.get(key)!;
  }
  private async read(url: string, signal?: AbortSignal, maxBytes = 5_000_000) {
    return this.gate.run(() => readPublic(url,allowed,this.fetcher,signal,maxBytes),signal);
  }
  private async hacomIndex(signal?: AbortSignal, parts = false): Promise<string[]> {
    return this.cached(`prices:hacom:index:${parts ? 'parts-v1' : 'v1'}`,async () => {
      const index = await this.read('https://hacom.vn/sitemap.xml',signal);
      const maps = sitemapUrls(index.body).filter(url => /^https:\/\/hacom\.vn\/sitemap-product-\d+\.xml$/.test(url));
      if (!maps.length || maps.length > 64) throw new Error('Retail sitemap index is incomplete or too large');
      const pages = await concurrent(maps,3,async url => {
        const page = await this.read(url,signal);
        if (!/<urlset\b/.test(page.body)) throw new Error('Invalid retail sitemap');
        return sitemapUrls(page.body);
      });
      const urls = [...new Set(pages.flat())];
      if (urls.length > 100_000) throw new Error('Retail catalog exceeds limit');
      return urls.filter(url => /^https:\/\/hacom\.vn\//.test(url) && (parts
        ? Object.values(partPaths).some(pattern => pattern.test(new URL(url).pathname)) : /^https:\/\/hacom\.vn\/(?:laptop-|macbook)/.test(url)));
    },signal);
  }
  /** One product sitemap per shop; only laptop and MacBook product pages are retained. */
  private async sitemapIndex(key: string, url: string, pattern: RegExp, maxBytes: number, signal?: AbortSignal): Promise<string[]> {
    return this.cached(key,async () => {
      const page = await this.read(url,signal,maxBytes);
      if (!/<urlset\b/.test(page.body)) throw new Error('Invalid retail sitemap');
      const urls = [...new Set(sitemapUrls(page.body))];
      if (!urls.length || urls.length > 100_000) throw new Error('Retail catalog is empty or exceeds limit');
      return urls.filter(item => pattern.test(item));
    },signal);
  }
  private async products(urls: string[], errors: string[], checkedUrls: string[], signal?: AbortSignal, kind: RetailKind = 'laptop'): Promise<RetailPrice[]> {
    if (urls.length > 12) errors.push('Retail variants exceed the twelve-page limit; absence of a new price is unproven.');
    return (await concurrent(urls.slice(0,12),3,async url => {
      try {
        const page = await this.cached(`prices:product:${kind === 'laptop' ? 'v3' : `${kind}-v1`}:${digest(url)}`,async () => {
          const page = await this.read(url,signal); return {url:page.url,offers:parseRetailPage(page.body,page.url,this.now(),kind)};
        },signal);
        checkedUrls.push(url,page.url); return page.offers;
      } catch (error) {
        signal?.throwIfAborted(); errors.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : 'product lookup failed'}`); return [];
      }
    })).flat();
  }
  async lookup(profile: HardwareProfile, signal?: AbortSignal, kind: RetailKind = 'laptop'): Promise<RetailLookup> {
    const parts = kind !== 'laptop';
    const terms = parts ? partTerms(kind,profile) : modelTerms(profile), errors: string[] = [], offers: RetailPrice[] = [], checkedUrls: string[] = [];
    if (!terms.length) return { checkedAt:new Date(this.now()).toISOString(),status:'failed',offers,errors:['Laptop model is missing'] };
    const select = (urls: string[], names = terms) => parts ? partCandidates(urls,kind,profile) : candidates(urls,profile,names);
    const fromIndex = (index: Promise<string[]>) => index.then(urls => this.products(select(urls),errors,checkedUrls,signal,kind));
    const jobs: Array<[string, () => Promise<RetailPrice[]>]> = [
      ['HACOM', () => fromIndex(this.hacomIndex(signal,parts))],
      ['Phong Vũ', () => fromIndex(parts ? this.phongvuPartsIndex(signal) : this.sitemapIndex('prices:phongvu:index:v1','https://phongvu.vn/sitemap-collection-products-4-laptop.xml',
        /^https:\/\/phongvu\.vn\/(?!.*(?:thanh-ly|demo))/,1_000_000,signal))],
      // TNC's single product sitemap is about 6.4 MB; its laptop and MacBook pages are a small part of it.
      ['TNC', () => fromIndex(this.sitemapIndex(`prices:tnc:index:${parts ? 'parts-v1' : 'v1'}`,'https://www.tnc.com.vn/sitemaps/sitemap_product.xml',
        parts ? /^https:\/\/www\.tnc\.com\.vn\// : /^https:\/\/www\.tnc\.com\.vn\/(?:laptop-|macbook-)/,10_000_000,signal))],
      ['An Phát', async () => {
        const discovery = await this.cached(`prices:anphat:search:${parts ? 'parts-v1' : 'v1'}:${digest(terms.join(' '))}`,async () => {
          const page = await this.read(`https://www.anphatpc.com.vn/tim?q=${encodeURIComponent(terms.join(' '))}`,signal);
          const document = page.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
          const links: string[] = [];
          for (const match of document.matchAll(/<a\b[^>]*>/gi)) {
            if (!/\bclass=["'][^"']*\bp-name\b/.test(match[0])) continue;
            const href = match[0].match(/\bhref=["']([^"']+)/)?.[1];
            if (href) { const url = new URL(decode(href),page.url); if (url.hostname === 'www.anphatpc.com.vn') links.push(url.href); }
          }
          if (!links.length && !/\b0\s+san pham\b/.test(normalize(plain(page.body)))) throw new Error('Retail search results are not readable');
          const truncated = /href=["'][^"']*[?&](?:page|p)=2\b/.test(document);
          if (!parts && truncated) throw new Error('Retail search exceeds the first-page limit');
          const unique = [...new Set(links)];
          return parts ? {links:unique,truncated} : unique;
        },signal);
        const links = Array.isArray(discovery) ? discovery : discovery.links;
        if (!Array.isArray(discovery) && discovery.truncated) errors.push('An Phát search exceeds the first-page limit; absence is unproven.');
        return this.products(select(links,[]),errors,checkedUrls,signal,kind);
      }],
    ];
    const results = await Promise.allSettled(jobs.map(([, job]) => job()));
    for (const [i,result] of results.entries()) {
      if (result.status === 'fulfilled') offers.push(...result.value);
      else errors.push(`${jobs[i]![0]}: ${result.reason instanceof Error ? result.reason.message : 'lookup failed'}`);
    }
    signal?.throwIfAborted();
    return { checkedAt:new Date(this.now()).toISOString(),status:errors.length ? 'failed' : 'complete',offers,
      errors:[...new Set(errors)],checkedUrls:[...new Set(checkedUrls)] };
  }
  private async phongvuPartsIndex(signal?: AbortSignal): Promise<string[]> {
    return this.cached('prices:phongvu:index:parts-v1',async () => {
      const index = await this.read('https://phongvu.vn/sitemap-collection-products.xml',signal);
      const maps = sitemapUrls(index.body).filter(url => /^https:\/\/phongvu\.vn\/sitemap-collection-products-\d+-[^/]+\.xml$/.test(url)
        && /linh-kien|cpu|ram|vga|card-man-hinh|o-cung|ssd/.test(url));
      if (!maps.length || maps.length > 32) throw new Error('Component sitemap index is unreadable or exceeds limits');
      const pages = await concurrent(maps,3,url => this.read(url,signal));
      if (pages.some(page => !/<urlset\b/.test(page.body))) throw new Error('Invalid component sitemap');
      const urls = [...new Set(pages.flatMap(page => sitemapUrls(page.body)))];
      if (urls.length > 100_000) throw new Error('Component catalog exceeds limit');
      return urls;
    },signal);
  }
}
