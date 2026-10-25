import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { ExchangeRates } from '../server/price-cache.ts';
import { LaptopPriceBook } from '../server/laptop-price-book.ts';
import { LAPTOP_LAUNCH_PRICES } from '../server/laptop-launch-prices.ts';
import { PRICE_CACHE_MS, type FxSnapshot } from '../shared/retail.ts';
import { assessWithRules } from '../server/hardware.ts';
import { raw } from './helpers.ts';

function fixture() {
  let now = Date.now(), lookups = 0, national = 0, local = 0;
  const store = new Store(':memory:',true);
  store.saveSettings({...store.getSettings(),aiEnabled:false,minRamGb:0,minVramGb:0});
  const item = raw('retail-service',19_999_999,{category:'laptop',title:'MacBook Air M1 2020 13.3 inch 8CPU 7GPU 8GB/256GB',
    description:'Máy cũ hoạt động tốt. RAM 8GB, SSD 256GB.'});
  const offer = {...LAPTOP_LAUNCH_PRICES[0],basis:'current_new' as const,available:true,amount:20_000_000,observedAt:new Date(now).toISOString()};
  const fx:FxSnapshot = {base:'USD',date:new Date(now).toISOString().slice(0,10),fetchedAt:new Date(now).toISOString(),rates:{USD:1,VND:25_000},sourceUrl:'https://frankfurter.dev/'};
  store.setRuntimeValue('prices:fx:v1',fx);
  const prices = {fx:new ExchangeRates(store,async () => { throw new Error('No read-triggered FX request is allowed'); },() => now),
    laptops:new LaptopPriceBook(store,{lookup:async () => {lookups++;return {status:'complete',checkedAt:new Date(now).toISOString(),offers:[offer],errors:[]};}},() => now)};
  const service = new FlipperService(store,{search:async input => {
    if (input.location === 'nationwide') { national++; throw new Error('Laptop must not search used peers'); }
    local++; return {items:[item],total:1};
  },detail:async input => input},undefined,() => new Date(now),prices);
  return {store,service,prices,item,stats:() => ({lookups,national,local}),advance:() => {now+=PRICE_CACHE_MS;}};
}
async function settled(service:FlipperService) {
  for (let i=0;i<100 && service.activeJob();i++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(service.activeJob(),null);
}
test('laptop collection uses retail evidence without nationwide used searches; reads remain offline and USD filters preserve native prices', async () => {
  const f = fixture();
  try {
    const job = f.service.refresh('laptop','',20); await settled(f.service);
    assert.equal(f.service.getJob(job.id)?.status,'complete');
    assert.deepEqual(f.stats(),{lookups:1,national:0,local:1});
    const details = f.service.publicDetail(f.item.id)!;
    assert.equal(details.valuation.reference?.kind,'retail_new'); assert.equal(details.valuation.opportunity,true);
    assert.equal(details.price,19_999_999); assert.equal(details.fx?.rates.VND,25_000);
    assert.equal(f.service.publicListings('laptop',new URLSearchParams('maxPrice=800&priceCurrency=USD')).total,1);
    assert.equal(f.service.publicListings('laptop',new URLSearchParams('maxPrice=799&priceCurrency=USD')).total,0);
    assert.equal(f.service.publicListings('laptop',new URLSearchParams('maxPrice=20000000')).total,1,'legacy API prices remain VND');
    f.service.publicBootstrap(); f.service.detail(f.item.id); assert.deepEqual(f.stats(),{lookups:1,national:0,local:1});
    f.advance(); assert.equal(f.service.publicDetail(f.item.id)?.valuation.opportunity,false);
    assert.equal(f.service.publicDetail(f.item.id)?.valuation.evidenceIssue,'exchange_rate');
  } finally {await f.service.shutdown();f.store.close();}
});
test('background cache refresh participates in deployment exclusion and drains on shutdown', async () => {
  const f = fixture();
  f.store.putListing(f.item,assessWithRules(f.item),true);f.store.setCollection('laptop','',[f.item.id]);
  let entered=false;
  f.prices.laptops.warm = async (_p,signal) => {entered=true;await new Promise<void>((resolve,reject) => {
    signal!.addEventListener('abort',() => reject(new Error('stopped')),{once:true});
  });};
  const work = f.service.refreshPriceCache();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered,true); assert.equal(f.service.deploymentStatus().busy,true);
  assert.throws(() => f.service.refresh('laptop',''),/cache is refreshing/);
  await f.service.shutdown(); await work; assert.equal(f.service.deploymentStatus().busy,false);f.store.close();
});
