import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { ExchangeRates } from '../server/price-cache.ts';
import { LaptopPriceBook } from '../server/laptop-price-book.ts';
import { LAPTOP_LAUNCH_PRICES } from '../server/laptop-launch-prices.ts';
import { PRICE_CACHE_MS } from '../shared/retail.ts';
import { assessWithRules } from '../server/hardware.ts';
import { buildReference } from '../server/pricing.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { raw } from './helpers.ts';

function fixture() {
  let now = Date.now(), lookups = 0, national = 0, local = 0;
  const store = new Store(':memory:',true);
  store.saveSettings({...store.getSettings(),aiEnabled:false,minRamGb:0,minVramGb:0});
  const item = raw('retail-service',19_999_999,{category:'laptop',title:'MacBook Air M1 2020 13.3 inch 8CPU 7GPU 8GB/256GB',
    description:'Máy cũ hoạt động tốt. RAM 8GB, SSD 256GB.'});
  const offer = {...LAPTOP_LAUNCH_PRICES[0],basis:'current_new' as const,available:true,amount:20_000_000,observedAt:new Date(now).toISOString()};
  const rates = new ExchangeRates(store,async () => { throw new Error('Native VND prices must never request FX'); },() => now);
  const prices = new LaptopPriceBook(store,{lookup:async () => {lookups++;return {status:'complete',checkedAt:new Date(now).toISOString(),offers:[offer],errors:[]};}},() => now,undefined,rates);
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
test('laptop collection and VND filters work without FX; reads remain offline and native prices stay exact', async () => {
  const f = fixture();
  try {
    const job = f.service.refresh('laptop','',20); await settled(f.service);
    assert.equal(f.service.getJob(job.id)?.status,'complete');
    assert.deepEqual(f.stats(),{lookups:1,national:0,local:1});
    const details = f.service.publicDetail(f.item.id)!;
    assert.equal(details.valuation.reference?.kind,'retail_new'); assert.equal(details.valuation.opportunity,true);
    assert.equal(details.price,19_999_999); assert.equal('fx' in details,false);
    assert.equal(f.service.publicListings('laptop',new URLSearchParams('maxPrice=19999999')).total,1);
    assert.equal(f.service.publicListings('laptop',new URLSearchParams('maxPrice=19999998')).total,0);
    assert.throws(() => f.service.publicListings('laptop',new URLSearchParams('maxPrice=800&priceCurrency=USD')),/VND only/);
    assert.equal('fx' in f.service.bootstrap(),false); assert.equal('fx' in f.service.publicBootstrap(),false);
    assert.equal('fx' in f.service.publicListings('laptop',new URLSearchParams()),false);
    assert.equal(f.store.runtimeValue('prices:fx:last-error'),null,'native collection never requests exchange rates');
    f.service.publicBootstrap(); f.service.detail(f.item.id); assert.deepEqual(f.stats(),{lookups:1,national:0,local:1});
    f.advance(); assert.equal(f.service.publicDetail(f.item.id)?.valuation.opportunity,false);
    assert.notEqual(f.service.publicDetail(f.item.id)?.valuation.evidenceIssue,'exchange_rate');
  } finally {await f.service.shutdown();f.store.close();}
});
test('background cache refresh participates in deployment exclusion and drains on shutdown', async () => {
  const f = fixture();
  f.store.putListing(f.item,assessWithRules(f.item),true);f.store.setCollection('laptop','',[f.item.id]);
  let entered=false;
  f.prices.warm = async (_p,signal) => {entered=true;await new Promise<void>((resolve,reject) => {
    signal!.addEventListener('abort',() => reject(new Error('stopped')),{once:true});
  });};
  const work = f.service.refreshPriceCache();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered,true); assert.equal(f.service.deploymentStatus().busy,true);
  assert.throws(() => f.service.refresh('laptop',''),/cache is refreshing/);
  await f.service.shutdown(); await work; assert.equal(f.service.deploymentStatus().busy,false);f.store.close();
});

test('native GPU deals retain their verdicts when the laptop price book has no exchange rates', async () => {
  const f = fixture();
  try {
    const item = raw('native-gpu',4_000_000), assessment = enrichComputerAssessment(item,assessWithRules(item));
    const peers = Array.from({length:5},(_,i) => ({raw:raw(`native-peer-${i}`,6_000_000),assessment}));
    const reference = buildReference(item,assessment,peers,f.store.getSettings()).reference;
    assert.ok(reference); f.store.putListing(item,assessment,true); f.store.setReference(item.id,reference,'Native VND peers');
    f.store.setCollection('gpu','',[item.id]);
    assert.equal(f.service.publicDetail(item.id)?.valuation.opportunity,true);
    assert.equal(f.service.publicListings('gpu',new URLSearchParams('maxPrice=4000000')).total,1);
    assert.equal(f.store.runtimeValue('prices:fx:v1'),null);
  } finally {await f.service.shutdown();f.store.close();}
});

test('indicative laptop prices remain discoverable when configuration review is required', async () => {
  const f = fixture();
  try {
    const item = {...f.item,title:'MacBook Air M1 2020 13.3 inch 8CPU 8GB/256GB'};
    const assessment = assessWithRules(item);
    assessment.eligibility = 'review';
    assessment.unknowns.push('GPU core count is unknown');
    f.store.putListing(item,assessment,true);f.store.setCollection('laptop','',[item.id]);
    await f.prices.warm(assessment.profile);
    assert.equal(f.service.publicDetail(item.id)?.valuation.status,'indicative');
    for (const readOnly of [false,true]) {
      const list = (query:string) => readOnly ? f.service.publicListings('laptop',new URLSearchParams(query))
        : f.service.listings('laptop',new URLSearchParams(query));
      const indicative = list('view=indicative');
      assert.equal(indicative.stats.indicative,1);
      assert.equal(indicative.total,1,'the indicative count must lead to its configuration-review listing');
      assert.equal(indicative.items[0]?.valuation.opportunity,false);
      assert.equal(list('view=all').total,0,'an indicative estimate does not clear configuration review');
      assert.equal(list('view=review').total,1);
      assert.equal(list('view=indicative&minRamGb=16').total,0,'memory filters still apply');
    }
    f.store.setState(item.id,{dismissed:true});
    assert.equal(f.service.listings('laptop',new URLSearchParams('view=indicative')).total,0);
    assert.equal(f.service.publicListings('laptop',new URLSearchParams('view=indicative')).total,1,'private dismissal never affects the public market');
  } finally {await f.service.shutdown();f.store.close();}
});
