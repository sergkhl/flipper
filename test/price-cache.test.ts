import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExchangeRates, readPublic, type RuntimeCache } from '../server/price-cache.ts';
import { LaptopPriceBook } from '../server/laptop-price-book.ts';
import { LAPTOP_LAUNCH_PRICES } from '../server/laptop-launch-prices.ts';
import { PRICE_CACHE_MS, type RetailLookup } from '../shared/retail.ts';
import { Store } from '../server/store.ts';
import { parseRetailPage, PublicRetailSources } from '../server/retail-sources.ts';

function cache(): RuntimeCache {
  const data = new Map<string,unknown>();
  return {runtimeValue:<T>(k:string) => structuredClone(data.get(k) ?? null) as T|null,setRuntimeValue:(k,v) => {data.set(k,structuredClone(v));}};
}
const pageUrl = 'https://hacom.vn/laptop-apple-macbook-air-m1-fixture';
const product = { '@type':'Product',name:'Laptop Apple MacBook Air M1 13.3 inch (8CPU/7GPU/8GB/256GB)',
  description:'RAM 8GB. SSD 256GB. Apple M1 8-core CPU 7-core GPU.',sku:'fixture',
  offers:{'@type':'Offer',url:pageUrl,price:'20000000',priceCurrency:'VND',itemCondition:'https://schema.org/NewCondition',
    availability:'https://schema.org/InStock',priceSpecification:{valueAddedTaxIncluded:true},
    shippingDetails:{shippingRate:{value:'0',currency:'VND'},shippingDestination:{addressCountry:'VN'}}} };
const html = (p:unknown) => `<script type="application/ld+json">${JSON.stringify(p)}</script>`;

test('FX persists across restarts, coalesces, refreshes at seven days and retains the last verified rates on failure', async () => {
  const directory = mkdtempSync(join(tmpdir(),'flipper-prices-'));
  let now = Date.parse('2026-10-25T12:00:00Z'), calls = 0, fail = false;
  const fetcher: typeof fetch = async () => { calls++; if (fail) throw new Error('provider unavailable');
    return Response.json([{base:'USD',quote:'VND',rate:25_000,date:new Date(now).toISOString().slice(0,10)}]); };
  let store = new Store(directory);
  try {
    const first = new ExchangeRates(store,fetcher,() => now);
    await Promise.all([first.warm(),first.warm()]); assert.equal(calls,1); assert.equal(first.snapshot()?.rates.VND,25_000);
    store.close(); store = new Store(directory);
    const restarted = new ExchangeRates(store,fetcher,() => now);
    now += PRICE_CACHE_MS-1; fail = true; await restarted.warm(); assert.equal(calls,1); assert.ok(restarted.snapshot());
    now++; await restarted.warm(); assert.equal(calls,2); assert.equal(restarted.snapshot()?.rates.VND,25_000);
    assert.match(store.runtimeValue<{error:string}>('prices:fx:last-error')!.error,/unavailable/);
    await restarted.warm(); assert.equal(calls,2,'failed refresh is backed off');
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
test('invalid, future and stale provider rates cannot be cached as a current USD/VND snapshot', async () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  for (const row of [{base:'EUR',quote:'VND',rate:25_000,date:'2026-10-25'},
    {base:'USD',quote:'VND',rate:0,date:'2026-10-25'},{base:'USD',quote:'VND',rate:25_000,date:'2026-10-26'},
    {base:'USD',quote:'VND',rate:25_000,date:'2026-10-01'}]) {
    const rates = new ExchangeRates(cache(),async () => Response.json([row]),() => now);
    await rates.warm(); assert.equal(rates.snapshot(),null);
  }
});
test('foreign references survive failed FX refresh and restart, then recalculate when rates recover', async () => {
  const directory = mkdtempSync(join(tmpdir(),'flipper-foreign-prices-'));
  let now = Date.now(), calls = 0, fail = false, rate = 25_000;
  const fetcher: typeof fetch = async () => {
    calls++; if (fail) throw new Error('FX unavailable');
    return Response.json([{base:'USD',quote:'VND',rate,date:new Date(now).toISOString().slice(0,10)}]);
  };
  const p = LAPTOP_LAUNCH_PRICES[0].profile;
  const source = {lookup:async ():Promise<RetailLookup> => ({status:'complete',checkedAt:new Date(now).toISOString(),errors:[],offers:[{
    ...LAPTOP_LAUNCH_PRICES[0],basis:'current_new',available:true,currency:'USD',amount:1_000,observedAt:new Date(now).toISOString(),
  }]})};
  let store = new Store(directory);
  const book = () => new LaptopPriceBook(store,source,() => now,[],new ExchangeRates(store,fetcher,() => now));
  try {
    let prices = book(); await prices.warm(p);
    assert.equal(prices.reference(p).reference?.average,25_000_000); assert.equal(calls,1);
    now += PRICE_CACHE_MS; fail = true; await prices.warm(p);
    assert.equal(prices.reference(p).reference?.average,25_000_000);
    assert.equal(prices.reference(p).reference?.retail?.fxStale,true); assert.equal(calls,2);
    store.close(); store = new Store(directory); prices = book();
    assert.equal(prices.reference(p).reference?.retail?.fxStale,true,'offline reads retain stale conversion across restarts');
    assert.equal(calls,2,'reading a reference never refreshes FX');
    fail = false; rate = 30_000; await prices.warm(p);
    assert.equal(prices.reference(p).reference?.average,30_000_000);
    assert.equal(prices.reference(p).reference?.retail?.fxStale,false); assert.equal(calls,3);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
test('retail lookup caches positive and empty results for seven days, persists failures, and coalesces a configuration', async () => {
  const data = cache(), p = LAPTOP_LAUNCH_PRICES[0].profile;
  let now = Date.now(), calls = 0, fail = false;
  const source = {lookup:async ():Promise<RetailLookup> => { calls++; if (fail) throw new Error('blocked');
    return {checkedAt:new Date(now).toISOString(),status:'complete',offers:[],errors:[]}; }};
  const book = new LaptopPriceBook(data,source,() => now);
  await Promise.all([book.warm(p),book.warm(p)]); assert.equal(calls,1);
  const restarted = new LaptopPriceBook(data,source,() => now);
  now += PRICE_CACHE_MS-1; await restarted.warm(p); assert.equal(calls,1);
  now++; fail = true; await restarted.warm(p); assert.equal(calls,2); assert.equal(restarted.lookup(p)?.status,'failed');
  await restarted.warm(p); assert.equal(calls,2);
  now += 15*60_000; await restarted.warm(p); assert.equal(calls,3);
});
test('cached retail offers retain their own observation date and never get another seven days from a later lookup', async () => {
  const data = cache(); let now = Date.now(), calls = 0;
  const initial = new Date(now).toISOString(), offers = parseRetailPage(html(product),pageUrl,now);
  const source = {lookup:async ():Promise<RetailLookup> => { calls++; return {checkedAt:new Date(now).toISOString(),status:'complete',offers,errors:[]}; }};
  const book = new LaptopPriceBook(data,source,() => now), p = offers[0].profile;
  await book.warm(p); now += PRICE_CACHE_MS; await book.warm(p);
  assert.equal(calls,2); assert.equal(book.lookup(p)?.offers[0].observedAt,initial);
});
test('product extraction requires factory-new in-stock cash offers and explicit complete Vietnam shipping cost', () => {
  const offers = parseRetailPage(html(product),pageUrl);
  assert.equal(offers.length,1); assert.equal(offers[0].amount,20_000_000); assert.equal(offers[0].profile.ramGb,8);
  assert.equal(offers[0].profile.gpuCores,7); assert.equal(offers[0].totalCostKnown,true);
  assert.equal(parseRetailPage(html({...product,offers:{...product.offers,availability:'https://schema.org/OutOfStock'}}),pageUrl).length,0);
  assert.equal(parseRetailPage(html({...product,offers:{...product.offers,itemCondition:'https://schema.org/UsedCondition'}}),pageUrl).length,0);
  const missingShipping = parseRetailPage(html({...product,offers:{...product.offers,shippingDetails:undefined}}),pageUrl)[0];
  assert.equal(missingShipping.totalCostKnown,false); assert.equal(missingShipping.shipsToVietnam,false);
  const delivered = parseRetailPage(html({...product,offers:{...product.offers,shippingDetails:{...product.offers.shippingDetails,shippingRate:{value:'100000',currency:'VND'}}}}),pageUrl)[0];
  assert.equal(delivered.amount,20_100_000);
  assert.throws(() => parseRetailPage(html({...product,offers:{...product.offers,priceValidUntil:'2000-01-01'}}),pageUrl),/expired/);
  assert.throws(() => parseRetailPage(html({...product,offers:{...product.offers,'@type':'AggregateOffer',lowPrice:'1'}}),pageUrl),/range/);
  assert.throws(() => parseRetailPage(html({...product,offers:undefined}),pageUrl),/no readable offer/);
  assert.throws(() => parseRetailPage(html({...product,offers:{...product.offers,availability:undefined}}),pageUrl),/availability/);
  assert.throws(() => parseRetailPage('<html>Loading product…</html>',pageUrl),/no readable/);
});
test('public retailer discovery caches the catalog and product separately and reports a blocked second source', async () => {
  const calls:string[] = [], now = Date.now();
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url === 'https://hacom.vn/sitemap.xml') return new Response('<sitemapindex><loc>https://hacom.vn/sitemap-product-1.xml</loc></sitemapindex>');
    if (url.endsWith('.xml')) return new Response(`<urlset><loc>${pageUrl}</loc></urlset>`);
    if (url.startsWith('https://www.anphatpc.com.vn/')) return new Response('blocked',{status:403});
    return new Response(html(product));
  };
  const provider = new PublicRetailSources(cache(),fetcher,() => now), p = LAPTOP_LAUNCH_PRICES[0].profile;
  const first = await provider.lookup(p); assert.equal(first.status,'failed'); assert.equal(first.offers.length,1); assert.match(first.errors.join(' '),/403/);
  await provider.lookup(p); assert.equal(calls.filter(url => url === pageUrl).length,1);
  assert.equal(calls.filter(url => url.endsWith('.xml')).length,2);
});
test('public source requests reject redirects outside their allowlist and bound downloaded data', async () => {
  let calls = 0;
  await assert.rejects(readPublic(pageUrl,u => u.hostname === 'hacom.vn',async () => {
    calls++; return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});
  }),/not allowed/); assert.equal(calls,1);
  await assert.rejects(readPublic(pageUrl,() => true,async () => new Response('too much'),undefined,3),/exceeds limit/);
  await assert.rejects(readPublic('http://hacom.vn/insecure',() => true,async () => new Response('')),/not allowed/);
});
