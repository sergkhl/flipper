import { createHash } from 'node:crypto';
import type { HardwareProfile, RawListing } from '../shared/types.ts';
import { freshDate, type RetailLookup, type RetailPrice } from '../shared/retail.ts';
import { assessWithRules, normalize } from './hardware.ts';
import { readPublic, type PriceFetch, type RuntimeCache } from './price-cache.ts';
import { concurrent, WorkPool } from './concurrency.ts';

const hosts = new Set(['hacom.vn', 'www.anphatpc.com.vn']);
const allowed = (url: URL) => hosts.has(url.hostname) && !/^\/(?:api|admin|ajax|cart|checkout)(?:\/|$)/.test(url.pathname);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): any[] => Array.isArray(value) ? value : value == null ? [] : [value];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const decode = (value: string) => value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
  .replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_all,n) => Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : '');
const plain = (value: string) => decode(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' '));
const schemaType = (value: unknown, expected: string) => array(value).some(type => text(type).split('/').pop()?.toLowerCase() === expected.toLowerCase());
function nodes(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!object(value)) return [];
  return [value, ...array(value['@graph']).flatMap(nodes)];
}
function productProfile(product: Record<string, any>, url: string, at: string): HardwareProfile {
  const properties = array(product.additionalProperty).filter(object).map(p => `${plain(text(p.name))}: ${plain(text(p.value))}`);
  const title = plain(text(product.name)), description = [plain(text(product.description)),...properties].join('\n');
  const raw: RawListing = { id: url, title, description, category:'laptop', price:1, url, images:[], sellerId:null,
    sellerType:'business', region:'', district:'', ward:'', condition:'new', params:{}, attributes:{}, observedAt:at, displayAge:'' };
  const result = assessWithRules(raw);
  if (result.conflicts.length) throw new Error('Retail product configuration is conflicting');
  return result.profile;
}

/** Read structured product offers only; crossed-out/list/instalment prices are never substituted. */
export function parseRetailPage(html: string, url: string, now = Date.now()): RetailPrice[] {
  const at = new Date(now).toISOString(), products: Record<string,any>[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { products.push(...nodes(JSON.parse(match[1])).filter(node => schemaType(node['@type'],'Product'))); }
    catch { /* A malformed unrelated JSON-LD block cannot become price evidence. */ }
  }
  if (!products.length) throw new Error('Retail page has no readable product offers');
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
      if (['OutOfStock','SoldOut','Discontinued'].some(state => schemaType(offer.availability,state))) continue;
      if (!schemaType(offer.availability,'InStock')) throw new Error('Retail stock availability is unverified');
      const amount = Number(offer.price), currency = text(offer.priceCurrency);
      if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) throw new Error('Retail offer has no valid cash price');
      if (offer.priceValidUntil) {
        const until = /^\d{4}-\d{2}-\d{2}$/.test(text(offer.priceValidUntil)) ? `${offer.priceValidUntil}T23:59:59.999Z` : offer.priceValidUntil;
        if (!Number.isFinite(Date.parse(until)) || Date.parse(until) < now) throw new Error('Retail source publishes an expired or invalid price');
      }
      if (offer.validFrom && Date.parse(offer.validFrom) > now) continue;
      if (offer.eligibleCustomerType || offer.eligibleQuantity || offer.membershipPointsEarned) continue;
      const profile = productProfile(product,url,at);
      if (!profile.model) throw new Error('Retail laptop model is unrecognized');
      const delivery = array(offer.shippingDetails).find(d => object(d) && array(d.shippingDestination).some(region =>
        object(region) && region.addressCountry === 'VN' && !region.addressRegion && !region.addressLocality && !region.postalCode && !region.postalCodeRange));
      const shipping = delivery?.shippingRate, shippingValue = shipping && Number(shipping.value);
      const shipsToVietnam = !!delivery;
      const taxKnown = offer.priceSpecification?.valueAddedTaxIncluded === true || /gia da bao gom vat|da (?:bao gom|co) vat/.test(normalize(plain(html)));
      const totalCostKnown = taxKnown && !!shipping && shipping.currency === currency && Number.isFinite(shippingValue) && shippingValue >= 0;
      result.push({ id:`${url}#${product.sku ?? result.length}`, title:plain(text(product.name)), url, source:new URL(url).hostname,
        profile, amount:amount+(totalCostKnown ? shippingValue : 0), currency, observedAt:at, basis:'current_new',
        priceDate:at.slice(0,10), releaseDate:null, releaseYear:profile.modelYear ?? null, releaseSourceUrl:null,
        market:'VN', available:true, totalCostKnown, shipsToVietnam });
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
  private async read(url: string, signal?: AbortSignal) {
    return this.gate.run(() => readPublic(url,allowed,this.fetcher,signal,5_000_000),signal);
  }
  private async hacomIndex(signal?: AbortSignal): Promise<string[]> {
    return this.cached('prices:hacom:index:v1',async () => {
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
      return urls.filter(url => /^https:\/\/hacom\.vn\/(?:laptop-|macbook)/.test(url));
    },signal);
  }
  private async products(urls: string[], errors: string[], checkedUrls: string[], signal?: AbortSignal): Promise<RetailPrice[]> {
    if (urls.length > 12) errors.push('Retail variants exceed the twelve-page limit; absence of a new price is unproven.');
    return (await concurrent(urls.slice(0,12),3,async url => {
      try {
        const page = await this.cached(`prices:product:v2:${digest(url)}`,async () => {
          const page = await this.read(url,signal); return {url:page.url,offers:parseRetailPage(page.body,page.url,this.now())};
        },signal);
        checkedUrls.push(url,page.url); return page.offers;
      } catch (error) {
        signal?.throwIfAborted(); errors.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : 'product lookup failed'}`); return [];
      }
    })).flat();
  }
  async lookup(profile: HardwareProfile, signal?: AbortSignal): Promise<RetailLookup> {
    const terms = modelTerms(profile), errors: string[] = [], offers: RetailPrice[] = [], checkedUrls: string[] = [];
    if (!terms.length) return { checkedAt:new Date(this.now()).toISOString(),status:'failed',offers,errors:['Laptop model is missing'] };
    const jobs = [
      async () => {
        const urls = await this.hacomIndex(signal);
        const candidates = urls.filter(url => terms.every(term => decodeURIComponent(url).toLowerCase().includes(term)));
        return this.products(candidates,errors,checkedUrls,signal);
      },
      async () => {
        const links = await this.cached(`prices:anphat:search:v1:${digest(terms.join(' '))}`,async () => {
          const page = await this.read(`https://www.anphatpc.com.vn/tim?q=${encodeURIComponent(terms.join(' '))}`,signal);
          const document = page.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
          const links: string[] = [];
          for (const match of document.matchAll(/<a\b[^>]*>/gi)) {
            if (!/\bclass=["'][^"']*\bp-name\b/.test(match[0])) continue;
            const href = match[0].match(/\bhref=["']([^"']+)/)?.[1];
            if (href) { const url = new URL(decode(href),page.url); if (url.hostname === 'www.anphatpc.com.vn') links.push(url.href); }
          }
          if (!links.length && !/\b0\s+san pham\b/.test(normalize(plain(page.body)))) throw new Error('Retail search results are not readable');
          if (/href=["'][^"']*[?&](?:page|p)=2\b/.test(document)) throw new Error('Retail search exceeds the first-page limit');
          return [...new Set(links)];
        },signal);
        return this.products(links,errors,checkedUrls,signal);
      },
    ];
    const results = await Promise.allSettled(jobs.map(job => job()));
    for (const [i,result] of results.entries()) {
      if (result.status === 'fulfilled') offers.push(...result.value);
      else errors.push(`${i === 0 ? 'HACOM' : 'An Phát'}: ${result.reason instanceof Error ? result.reason.message : 'lookup failed'}`);
    }
    signal?.throwIfAborted();
    return { checkedAt:new Date(this.now()).toISOString(),status:errors.length ? 'failed' : 'complete',offers,
      errors:[...new Set(errors)],checkedUrls:[...new Set(checkedUrls)] };
  }
}
