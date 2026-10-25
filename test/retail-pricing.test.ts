import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDate, validFx, PRICE_CACHE_MS, type FxSnapshot, type RetailLookup, type RetailPrice } from '../shared/retail.ts';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../server/config.ts';
import { laptopReference, retainedFraction, retailMatch } from '../server/laptop-pricing.ts';
import { LAPTOP_LAUNCH_PRICES } from '../server/laptop-launch-prices.ts';
import { valueListing } from '../server/pricing.ts';
import { EMPTY_STATE } from '../server/store.ts';
import { raw, assessment } from './helpers.ts';
import { originalMoney, money, setExchangeRates } from '../client/format.ts';

const now = Date.now(), at = new Date(now).toISOString();
export const profile = {...LAPTOP_LAUNCH_PRICES[0].profile};
export const fx: FxSnapshot = {base:'USD',date:at.slice(0,10),fetchedAt:at,rates:{USD:1,VND:25_818,EUR:.9},sourceUrl:'https://frankfurter.dev/'};
function offer(updates: Partial<RetailPrice> = {}): RetailPrice {
  return {...LAPTOP_LAUNCH_PRICES[0],id:'retail',basis:'current_new',amount:20_000_000,observedAt:at,available:true,...updates};
}
function lookup(offers: RetailPrice[] = [], updates: Partial<RetailLookup> = {}): RetailLookup {
  return {checkedAt:at,status:'complete',offers,errors:[],...updates};
}
function result(current: RetailLookup | null, history = LAPTOP_LAUNCH_PRICES, target = profile) {
  return laptopReference(target,current,history,fx,now);
}

test('current exact retail wins over original depreciation, selecting the lowest verified complete Vietnam cash cost', () => {
  const ref = result(lookup([offer({id:'higher',amount:22_000_000}),offer(),offer({id:'foreign',amount:200,currency:'USD',market:'US',shipsToVietnam:false})])).reference!;
  assert.equal(ref.kind,'retail_new'); assert.equal(ref.retail?.referenceUsd,20_000_000/fx.rates.VND);
  assert.equal(ref.retail?.retention,null); assert.equal(ref.retail?.originalUsd,null);
  assert.equal(ref.retail?.sources[0].id,'retail'); assert.equal(ref.retail?.indicative,false);
});
test('any amount below new retail qualifies before rounding; exact equality and above do not', () => {
  const ref = result(lookup([offer()])).reference!;
  const a = assessment(profile,{kind:'laptop'});
  const item = raw('laptop',20_000_000,{category:'laptop',title:'MacBook Air 13 M1 2020 8CPU 7GPU 8GB/256GB',description:'Used, working. RAM 8GB. SSD 256GB.'});
  for (const [price,good] of [[19_999_999,true],[20_000_000,false],[20_000_001,false]] as const) {
    const v = valueListing({...item,price},a,ref,{...DEFAULT_SETTINGS,discountPercent:10},EMPTY_STATE);
    assert.equal(v.status,'valued'); assert.equal(v.opportunity,good); assert.equal(v.confidence,'medium');
  }
});
test('historical depreciation requires a successful current-price absence check and uses model release age', () => {
  const ref = result(lookup()).reference!;
  assert.equal(ref.kind,'historical_depreciation'); assert.equal(ref.retail?.indicative,false);
  const age = (now-Date.parse(LAPTOP_LAUNCH_PRICES[0].releaseDate!))/(365.25*86_400_000);
  assert.equal(ref.retail?.ageYears,age);
  assert.equal(ref.retail?.referenceUsd,28_990_000/fx.rates.VND*retainedFraction('apple_silicon',age));
  for (const state of [null,lookup([],{status:'failed',errors:['blocked']}),lookup([],{checkedAt:new Date(now-PRICE_CACHE_MS).toISOString()})]) {
    const fallback = result(state).reference!;
    assert.equal(fallback.retail?.indicative,true); assert.equal(fallback.kind,'historical_depreciation');
  }
});
test('fresh cached new prices survive lookup failures, but expired ones never prove absence', () => {
  assert.equal(result(lookup([offer()],{status:'failed',errors:['timeout']})).reference?.retail?.indicative,false);
  const expired = offer({observedAt:new Date(now-PRICE_CACHE_MS).toISOString()});
  const fallback = result(lookup([expired])).reference!;
  assert.equal(fallback.kind,'historical_depreciation'); assert.equal(fallback.retail?.indicative,true);
});
test('depreciation interpolates agreed anchors, then reduces the remaining value by 20% annually', () => {
  for (const [kind,points] of [['apple_silicon',[.85,.70,.40,.25]],['business',[.80,.60,.30,.15]],['consumer',[.75,.55,.25,.10]]] as const) {
    [0,1,3,5].forEach((age,i) => assert.equal(retainedFraction(kind,age),points[i]));
    assert.ok(Math.abs(retainedFraction(kind,2)-(points[1]+points[2])/2)<1e-12);
    assert.equal(retainedFraction(kind,6),points[3]*.8);
  }
});
test('configuration variants, chip tiers, screens, years, RAM and storage are never merged', () => {
  for (const change of [{cpu:'APPLE M1 PRO'},{model:'MACBOOK PRO 13'},{screenInches:15.3},{modelYear:2021},
    {ramGb:16},{storageGb:512},{cpuCores:10},{gpuCores:8}]) assert.equal(retailMatch(profile,{...profile,...change}),'different');
  for (const change of [{cpuCores:null},{gpuCores:null},{ramGb:null},{storageGb:null}]) assert.equal(retailMatch({...profile,...change},profile),'partial');
  const partial = result(lookup([offer({profile:{...profile,ramGb:null}})]),[]).reference!;
  assert.equal(partial.retail?.indicative,true);
  assert.equal(result(lookup([offer({profile:{...profile,ramGb:16}})]),[]).reference,null);
  assert.equal(retailMatch({...profile,model:'MACBOOK AIR',screenInches:null},profile),'partial');
  assert.equal(retailMatch({...profile,model:'MACBOOK AIR 15'},profile),'different');
  assert.equal(retailMatch({...profile,gpu:'APPLE M1 8-CORE INTEGRATED'},profile),'different');
});
test('foreign prices cannot displace Vietnamese history unless complete Vietnam purchase costs are verified', () => {
  const foreign = offer({currency:'USD',amount:500,market:'US',shipsToVietnam:false,totalCostKnown:false});
  assert.equal(result(lookup([foreign])).reference?.kind,'historical_depreciation');
  assert.equal(result(lookup([foreign]),[]).reference?.retail?.indicative,true);
  assert.equal(result(lookup([{...foreign,shipsToVietnam:true,totalCostKnown:true}])).reference?.kind,'retail_new');
  assert.equal(result(lookup(),[{...LAPTOP_LAUNCH_PRICES[0],currency:'USD',amount:999,market:'US',basis:'launch_msrp'}]).reference?.retail?.indicative,true);
});
test('incomplete purchase costs and unavailable currency conversions cannot create a firm retail verdict', () => {
  const cost = result(lookup([offer({totalCostKnown:false})]),[]).reference!;
  assert.equal(cost.retail?.indicative,true);
  assert.equal(result(lookup([offer({currency:'XYZ'})])).reference?.retail?.indicative,true);
});
test('unknown release year, age above eight years, unknown class and conflicting original prices remain indicative', () => {
  const base = LAPTOP_LAUNCH_PRICES[0];
  const yearOnly = result(lookup(),[{...base,releaseDate:null,priceDate:'2020-12-01'}]).reference!;
  assert.equal(yearOnly.retail?.indicative,true); assert.notEqual(yearOnly.min,yearOnly.max);
  const ancient = result(lookup(),[{...base,releaseDate:'2010-01-01',priceDate:'2010-02-01'}]).reference!;
  assert.equal(ancient.retail?.indicative,true);
  const unknown = {...EMPTY_PROFILE,model:'CUSTOM X1',cpu:'I5-8350U',gpu:'UHD 620',gpuClass:'integrated' as const,ramGb:8,storageGb:256};
  const unclassified = result(lookup(),[{...base,profile:unknown}],unknown).reference!;
  assert.equal(unclassified.retail?.laptopClass,null); assert.equal(unclassified.retail?.indicative,true); assert.notEqual(unclassified.min,unclassified.max);
  const conflict = result(lookup(),[base,{...base,id:'conflict',amount:30_000_000}]).reference!;
  assert.equal(conflict.retail?.indicative,true); assert.notEqual(conflict.min,conflict.max);
});
test('post-launch prices beyond 90 days and unverified release dates are not historical originals', () => {
  const base = LAPTOP_LAUNCH_PRICES[0];
  assert.equal(result(lookup(),[{...base,priceDate:'2022-01-01'}]).reference,null);
  assert.equal(result(lookup(),[{...base,releaseSourceUrl:null}]).reference,null);
});
test('Surface Plus identity and explicit Intel aliases match without guessing a CPU or merging variants', () => {
  const plus = LAPTOP_LAUNCH_PRICES.find(o => o.id === 'microsoft-hk-pro7plus-i5-1135g7-8-256-wifi')!.profile;
  assert.equal(retailMatch({...plus,model:'Surface Pro 7 Plus',cpu:'Intel Core i5 11th 1135G7 Tiger Lake'},plus),'exact');
  assert.equal(retailMatch({...plus,cpu:'Intel Core i5-1135G7'},plus),'exact');
  assert.equal(retailMatch({...plus,model:'Surface Pro 7',cpu:null},plus),'different');
  assert.equal(retailMatch({...plus,cpu:null},plus),'partial');
  for (const cpu of ['Intel Core i5 11th', 'Intel Core i5 10th 1135G7 Tiger Lake',
    'Intel Core i5 11th 1035G4 Tiger Lake', 'I5-1135G7 / I7-1165G7', 'I5-1135G7E']) {
    assert.equal(retailMatch({...plus,cpu},plus),'different',cpu);
  }
  for (const change of [{ramGb:16},{storageGb:500},{ramType:'LPDDR4'},{gpu:'Intel UHD Graphics'}]) {
    assert.equal(retailMatch({...plus,...change},plus),'different');
  }
});
test('reviewed launch rows have unique identities, configuration evidence and dates inside the original 90-day window', () => {
  assert.equal(new Set(LAPTOP_LAUNCH_PRICES.map(o => o.id)).size,LAPTOP_LAUNCH_PRICES.length);
  for (const row of LAPTOP_LAUNCH_PRICES) {
    assert.notEqual(row.basis,'current_new',row.id); assert.equal(row.available,false,row.id);
    assert.ok(row.amount > 0 && Number.isFinite(row.amount),row.id);
    const days = (Date.parse(row.priceDate!)-Date.parse(row.releaseDate!))/86_400_000;
    assert.ok(days >= 0 && days <= 90,row.id);
    for (const url of [row.url,row.releaseSourceUrl,row.configurationSourceUrl]) assert.equal(new URL(url!).protocol,'https:',row.id);
    assert.equal(retailMatch(row.profile,row.profile),'exact',row.id);
  }
});
test('Surface commercial launch prices retain Wi-Fi/LTE ranges and foreign estimates never award a deal badge', () => {
  const target = LAPTOP_LAUNCH_PRICES.find(o => o.id === 'microsoft-hk-pro7plus-i5-1135g7-8-256-wifi')!.profile;
  const rates = {...fx,rates:{...fx.rates,HKD:7.8474,SGD:1.2775}};
  const ref = laptopReference(target,lookup(),LAPTOP_LAUNCH_PRICES,rates,now).reference!;
  assert.equal(ref.kind,'historical_depreciation'); assert.equal(ref.retail?.indicative,true);
  assert.deepEqual(ref.retail?.sources.map(o => o.amount),[10_788,11_888]);
  assert.match(ref.retail!.reasons.join(' '),/Foreign launch price/);
  assert.ok(ref.min < ref.max);
  const v = valueListing(raw('surface',Math.round(ref.min/2),{category:'laptop'}),assessment(target,{kind:'laptop'}),ref,DEFAULT_SETTINGS,EMPTY_STATE);
  assert.equal(v.opportunity,false);
  const i5Base = LAPTOP_LAUNCH_PRICES.filter(o => o.id.startsWith('microsoft-hk-pro7plus-i5-1135g7-8-128'));
  assert.deepEqual(i5Base.map(o => o.amount),[8_188,9_388],'restricted EDU price is excluded');
});
test('new MacBook launch prices apply only to documented configurations and current retail still wins', () => {
  const base = LAPTOP_LAUNCH_PRICES.find(o => o.id === 'apple-vn-air-m4-13-16-256')!;
  assert.equal(result(lookup(),LAPTOP_LAUNCH_PRICES,base.profile).reference?.retail?.indicative,false);
  assert.equal(result(lookup(),LAPTOP_LAUNCH_PRICES,{...base.profile,storageGb:512,gpuCores:10}).reference,null);
  const m2 = LAPTOP_LAUNCH_PRICES.find(o => o.id === 'fpt-air-m2-8-256')!;
  assert.equal(m2.releaseDate,'2022-07-08','age starts at first orders, not the June announcement');
  assert.equal(result(lookup(),LAPTOP_LAUNCH_PRICES,{...m2.profile,ramGb:16}).reference,null);
  const ref = result(lookup([offer({profile:base.profile,amount:20_000_000})]),LAPTOP_LAUNCH_PRICES,base.profile).reference!;
  assert.equal(ref.kind,'retail_new'); assert.equal(ref.retail?.retention,null);
  assert.equal(ref.retail?.referenceUsd,20_000_000/fx.rates.VND);
});
test('retail and FX expire at seven days, with no new USD verdict from stale FX', () => {
  assert.equal(freshDate(at,now+PRICE_CACHE_MS-1),true); assert.equal(freshDate(at,now+PRICE_CACHE_MS),false);
  assert.equal(validFx(fx,now+PRICE_CACHE_MS-1),true); assert.equal(validFx(fx,now+PRICE_CACHE_MS),false);
  assert.equal(laptopReference(profile,lookup(),LAPTOP_LAUNCH_PRICES,{...fx,fetchedAt:new Date(now-PRICE_CACHE_MS).toISOString()},now).reference,null);
});
test('USD formatting uses the same snapshot while retaining exact native values for evidence', () => {
  setExchangeRates(fx); assert.equal(money(25_818),'$1.00'); assert.equal(originalMoney(25_818),'₫25,818');
  setExchangeRates(null); assert.equal(money(25_818),'—');
});
