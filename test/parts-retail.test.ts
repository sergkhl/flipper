import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PartsPriceBook, partMatch, type PartsRetailSource } from '../server/parts-retail.ts';
import { parseRetailPage, PublicRetailSources } from '../server/retail-sources.ts';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../server/config.ts';
import { assessWithRules } from '../server/hardware.ts';
import { buildReference } from '../server/pricing.ts';
import { PRICE_CACHE_MS, type RetailLookup, type RetailPartKind, type RetailPrice } from '../shared/retail.ts';
import { raw, assessment } from './helpers.ts';
import type { RawListing } from '../shared/types.ts';
import { appServer } from '../server/http.ts';

const at = new Date().toISOString();
const gpu = assessment({gpuMemoryType:'GDDR6'});
const pc = assessment({...EMPTY_PROFILE,cpu:'I5-12400F',gpu:'RTX 3060',gpuClass:'desktop',vramGb:12,gpuMemoryType:'GDDR6',
  ramGb:16,ramType:'DDR4',ramFormFactor:'DIMM',ramSpeedMhz:3200,quantity:2,perUnitGb:8,ramEcc:'non-ecc',
  storageGb:512,storageType:'NVME SSD',priceBasis:'item'},{kind:'desktop'});
function offer(profile = gpu.profile, amount = 6_000_000, id = 'gpu'): RetailPrice {
  return {id,title:'Synthetic retail component',url:`https://hacom.vn/${id}`,source:'hacom.vn',profile:structuredClone(profile),
    amount,currency:'VND',observedAt:at,basis:'current_new',priceDate:at.slice(0,10),releaseDate:null,releaseYear:null,releaseSourceUrl:null,
    market:'VN',available:true,totalCostKnown:true,shipsToVietnam:true};
}
const lookup = (offers: RetailPrice[] = [], status: RetailLookup['status'] = 'complete'): RetailLookup => ({checkedAt:at,status,offers,errors:[]});
function fixture(source: PartsRetailSource = {lookup:async () => lookup([offer()])}, clock = () => Date.now()) {
  const store = new Store('',true), book = new PartsPriceBook(store,source,clock);
  return {store,book};
}

test('a single cheapest verified new GPU price is reduced by 25%, separately from the used-market comparison', async () => {
  const {store,book} = fixture({lookup:async () => lookup([offer(gpu.profile,8_000_000,'higher'),offer()])});
  try {
    await book.warm(gpu);
    const candidate = raw('target',4_500_000);
    const equal = book.estimate(candidate,gpu);
    assert.equal(equal.estimateVnd,4_500_000); assert.equal(equal.newTotalVnd,6_000_000);
    assert.equal(equal.status,'valued'); assert.equal(equal.opportunity,false); assert.equal(equal.discountPercent,0);
    assert.equal(book.estimate({...candidate,price:4_499_999},gpu).opportunity,true);
    assert.equal(book.estimate({...candidate,price:4_500_001},gpu).opportunity,false);
    assert.equal(equal.components[0].sources.length,2);
  } finally {store.close();}
});
test('GPU variants, VRAM, memory generation and desktop class cannot be mixed; unknown memory stays indicative', () => {
  for (const diff of [{gpu:'RTX 3060 TI'},{vramGb:8},{gpuMemoryType:'GDDR5'},{gpuClass:'mobile' as const}]) {
    assert.equal(partMatch('gpu',gpu.profile,{...gpu.profile,...diff}),'different');
  }
  assert.equal(partMatch('gpu',gpu.profile,{...gpu.profile,model:'Different board manufacturer'}),'exact');
  assert.equal(partMatch('gpu',{...gpu.profile,gpuMemoryType:null},gpu.profile),'partial');
});
test('RAM matching respects layout, speed, ECC and form factor without inventing missing specifications', () => {
  const p = pc.profile;
  assert.equal(partMatch('ram',p,{...p,model:'Another RAM brand'}),'exact');
  for (const diff of [{ramType:'DDR5'},{ramFormFactor:'SODIMM' as const},{ramSpeedMhz:2666},{perUnitGb:16,quantity:1},{ramEcc:'registered' as const}]) {
    assert.equal(partMatch('ram',p,{...p,...diff}),'different');
  }
  assert.equal(partMatch('ram',{...p,quantity:null,perUnitGb:null,ramSpeedMhz:null},p),'partial');
  assert.equal(partMatch('ram',{...p,quantity:1,perUnitGb:null},p),'partial','a parser default is not an explicitly stated one-stick layout');
  assert.equal(partMatch('ram',{...p,ramType:null},p),'different');
});
test('SSD capacity classes match across brands, while known interfaces and distinct classes do not', () => {
  const p = pc.profile;
  assert.equal(partMatch('ssd',p,{...p,storageGb:500}),'exact');
  assert.equal(partMatch('ssd',p,{...p,storageGb:480}),'exact');
  assert.equal(partMatch('ssd',p,{...p,storageGb:256}),'different');
  assert.equal(partMatch('ssd',p,{...p,storageType:'SATA SSD'}),'different');
  assert.equal(partMatch('ssd',{...p,storageType:'SSD'},p),'partial');
  assert.equal(partMatch('ssd',{...p,storageGb:1024},{...p,storageGb:1000}),'exact');
});
test('desktop totals include only supported core parts and explicitly omit unavailable components', async () => {
  const {store,book} = fixture({lookup:async (_p,_s,kind) => lookup(kind === 'cpu' ? [offer(pc.profile,2_000_000,'cpu')] : kind === 'gpu' ? [offer(pc.profile,6_000_000,'gpu')] : [])});
  try {
    await book.warm(pc); const result = book.estimate(raw('pc',5_000_000,{category:'desktop'}),pc);
    assert.equal(result.newTotalVnd,8_000_000); assert.equal(result.estimateVnd,6_000_000);
    assert.equal(result.components.length,2); assert.equal(result.opportunity,true);
    assert.match(result.omitted.join(' '),/Motherboard.*PSU/); assert.match(result.omitted.join(' '),/RAM.*no verified/);
    assert.match(result.reason,/partial component/);
  } finally {store.close();}
});
test('RAM layouts and SSD interfaces that are unknown produce ranges and never badges', async () => {
  const {store,book} = fixture({lookup:async (_p,_s,kind) => lookup(kind === 'ram' ? [offer(pc.profile,1_000_000,'ram-a'),offer({...pc.profile,quantity:1,perUnitGb:16},2_000_000,'ram-b')] : [])});
  try {
    const a = {...pc,profile:{...pc.profile,quantity:null,perUnitGb:null,ramSpeedMhz:null}};
    await book.warm(a); const result = book.estimate(raw('ram-pc',500_000,{category:'desktop'}),a);
    assert.equal(result.status,'indicative'); assert.deepEqual(result.rangeVnd,[750_000,1_500_000]); assert.equal(result.opportunity,false);
  } finally {store.close();}
});
test('unverified, unavailable, expired, foreign and conditional purchase-cost evidence cannot supply a component estimate', async () => {
  const invalid = [{available:false},{totalCostKnown:false},{basis:'launch_msrp' as const},{currency:'USD'},{market:'US'},
    {observedAt:new Date(Date.now()-PRICE_CACHE_MS).toISOString()},{source:'unreviewed.example',url:'https://unreviewed.example/gpu'},
    {amount:1},{amount:NaN}];
  const {store,book} = fixture({lookup:async () => lookup(invalid.map((change,i) => ({...offer(gpu.profile,6_000_000,`invalid-${i}`),...change})))});
  try {await book.warm(gpu); const result = book.estimate(raw('invalid',1_000_000),gpu); assert.equal(result.status,'unavailable'); assert.equal(result.estimateVnd,null); assert.equal(result.opportunity,false);}
  finally {store.close();}
});
test('retail badges retain condition, availability, seller, description, freshness and cash-price gates', async () => {
  const {store,book} = fixture();
  try {
    await book.warm(gpu);
    const changes: Array<Partial<RawListing>> = [{condition:'new'},{sellerId:null},{description:''},{observedAt:new Date(Date.now()-86_400_000).toISOString()},
      {attributes:{status:'sold'}},{attributes:{_detailError:'failed'}},{price:1},{price:0},{attributes:{is_price_not_valid:true}}];
    for (const change of changes) {
      const result = book.estimate(raw('blocked',3_000_000,change),gpu);
      assert.equal(result.opportunity,false,JSON.stringify(change)); assert.equal(result.status,'indicative');
    }
    for (const change of [{eligibility:'review' as const},{eligibility:'excluded' as const},{conflicts:['Conflicting VRAM']}]) {
      assert.equal(book.estimate(raw('blocked',3_000_000),{...gpu,...change}).opportunity,false);
    }
    assert.equal(book.estimate(raw('bundle',3_000_000),{...gpu,profile:{...gpu.profile,quantity:2,priceBasis:'bundle'}}).opportunity,false);
  } finally {store.close();}
});
test('part lookups coalesce, persist across restarts, expire at seven days and retain only still-fresh evidence after failures', async () => {
  const directory = mkdtempSync(join(tmpdir(),'flipper-part-retail-'));
  let now = Date.parse(at), calls = 0, fail = false, store = new Store(directory);
  const source: PartsRetailSource = {lookup:async () => { calls++; if (fail) throw new Error('Source unavailable'); return {...lookup([offer()]),checkedAt:new Date(now).toISOString()}; }};
  try {
    let book = new PartsPriceBook(store,source,() => now);
    await Promise.all([book.warm(gpu),book.warm(gpu)]); assert.equal(calls,1);
    store.close(); store = new Store(directory); book = new PartsPriceBook(store,source,() => now);
    now += PRICE_CACHE_MS-1; await book.warm(gpu); assert.equal(calls,1);
    now++; fail = true; await book.warm(gpu); assert.equal(calls,2);
    assert.equal(book.estimate(raw('expired',3_000_000),gpu).status,'unavailable');
    await book.warm(gpu); assert.equal(calls,2,'failures back off for fifteen minutes');
    now += 15*60_000; await book.warm(gpu); assert.equal(calls,3);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
test('a fresh matching offer remains usable when another reviewed source fails', async () => {
  const {store,book} = fixture({lookup:async () => lookup([offer()],'failed')});
  try {await book.warm(gpu); assert.equal(book.estimate(raw('partial-source',3_000_000),gpu).opportunity,true);}
  finally {store.close();}
});
test('failed retries keep fresh positives, while an authoritative empty recheck removes the offer', async () => {
  let now = Date.parse(at), attempt = 0;
  const {store,book} = fixture({lookup:async () => {
    attempt++;
    if (attempt === 2) throw new Error('Transient failure');
    return {...lookup(attempt === 1 ? [offer()] : [],attempt === 1 ? 'failed' : 'complete'),checkedAt:new Date(now).toISOString(),checkedUrls:attempt === 3 ? [offer().url] : []};
  }},() => now);
  try {
    await book.warm(gpu); now += 15*60_000; await book.warm(gpu);
    assert.equal(book.estimate(raw('retained-positive',3_000_000),gpu).opportunity,true);
    now += 15*60_000; await book.warm(gpu);
    assert.equal(book.estimate(raw('removed-positive',3_000_000),gpu).status,'unavailable');
  } finally {store.close();}
});
test('cancelled component lookups drain without writing a false absence result', async () => {
  const controller = new AbortController(); let started!:()=>void;
  const ready = new Promise<void>(resolve => started=resolve);
  const {store,book} = fixture({lookup:async (_p,signal) => {started();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));return lookup();}});
  try {
    const warm = book.warm(gpu,controller.signal); await ready; controller.abort(); await assert.rejects(warm);
    assert.equal(book.checkedAt(gpu),'');
  } finally {store.close();}
});

function productHtml(url: string, name: string, price: number, extra = '', changes: Record<string,unknown> = {}) {
  return `<script type="application/ld+json">${JSON.stringify({'@type':'Product',name,sku:'synthetic',offers:{'@type':'Offer',url,price,priceCurrency:'VND',itemCondition:'https://schema.org/NewCondition',availability:'https://schema.org/InStock',...changes}})}</script><h1>${name}</h1><p>${price.toLocaleString('vi-VN')}₫</p>${extra}`;
}
test('retail component pages support sub-million prices and explicit kits, without borrowing laptop or accessory identities', () => {
  const url = 'https://hacom.vn/ram-pc-synthetic';
  const single = parseRetailPage(productHtml(url,'RAM Desktop 16GB (1x16GB) DDR4 3200MHz non-ECC',500_000),url,Date.now(),'ram')[0];
  assert.equal(single.profile.ramGb,16); assert.equal(single.profile.ramFormFactor,'DIMM'); assert.equal(single.amount,500_000);
  const kit = parseRetailPage(productHtml(url,'RAM Desktop 16GB (2x8GB) DDR4 3200MHz non-ECC',900_000),url,Date.now(),'ram')[0];
  assert.equal(kit.profile.quantity,2); assert.equal(kit.profile.perUnitGb,8); assert.equal(kit.profile.ramGb,16);
  assert.throws(() => parseRetailPage(productHtml(url,'RAM Desktop 32GB (2x8GB) DDR4 3200MHz',900_000),url,Date.now(),'ram'),/conflict/);
  assert.throws(() => parseRetailPage(productHtml(url,'Waterblock RTX 3060 12GB GDDR6',900_000),url,Date.now(),'gpu'),/individual/);
  assert.equal(parseRetailPage(productHtml(url,'Card màn hình RTX 3060 12GB GDDR6',6_000_000,'<p>Sản phẩm đã ngừng kinh doanh</p>'),url,Date.now(),'gpu').length,0);
  assert.equal(parseRetailPage(productHtml(url,'RAM Desktop 16GB DDR4 3200MHz',1),url,Date.now(),'ram').length,0);
  assert.equal(parseRetailPage(productHtml(url,'RAM Laptop 16GB (1x16GB) DDR4 3200MHz',500_000),url,Date.now(),'ram')[0].profile.ramFormFactor,'SODIMM');
  assert.throws(() => parseRetailPage(productHtml(url,'Ổ cứng SSD portable USB NVMe 500GB',2_000_000),url,Date.now(),'ssd'),/External storage/);
  assert.throws(() => parseRetailPage(productHtml(url,'Ổ cứng SSD NVMe SATA 500GB',2_000_000),url,Date.now(),'ssd'),/conflicting/);
});
test('retail controller capabilities do not conflict with CPU identity, and negative ECC declarations are not positive ECC claims', () => {
  const url = 'https://hacom.vn/cpu-synthetic';
  const product = {'@type':'Product',name:'CPU Intel Core i5 12400F',additionalProperty:[{name:'Bộ nhớ hỗ trợ',value:'DDR4-3200 / DDR5-4800'}],
    offers:{'@type':'Offer',url,price:3_000_000,priceCurrency:'VND',itemCondition:'https://schema.org/NewCondition',availability:'https://schema.org/InStock'}};
  const render = (p: unknown) => `<script type="application/ld+json">${JSON.stringify(p)}</script><p>3.000.000đ</p>`;
  assert.equal(parseRetailPage(render(product),url,Date.now(),'cpu')[0].profile.cpu,'I5-12400F');
  assert.throws(() => parseRetailPage(render({...product,additionalProperty:[{name:'CPU',value:'I5-12400'}]}),url,Date.now(),'cpu'),/conflicting/);
  const ram = {...product,name:'RAM Desktop 16GB DDR4 3200MHz',additionalProperty:[{name:'ECC',value:'Không'}]};
  assert.equal(parseRetailPage(render(ram),url,Date.now(),'ram')[0].profile.ramEcc,'non-ecc');
  assert.throws(() => parseRetailPage(render({...ram,name:'RAM Desktop 16GB (2x8GB) DDR4 3200MHz',additionalProperty:[{name:'Dung lượng',value:'32GB'}]}),url,Date.now(),'ram'),/conflict/);
});
test('all four shop adapters discover parts without interpreting complete PCs as component offers', async () => {
  const urls = ['https://hacom.vn/card-man-hinh-rtx-3060-12gb', 'https://phongvu.vn/card-man-hinh-rtx-3060-12gb',
    'https://www.tnc.com.vn/card-man-hinh-rtx-3060-12gb.html','https://www.anphatpc.com.vn/vga-rtx-3060-12gb.html'];
  const calls: string[] = [], store = new Store('',true);
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url === 'https://hacom.vn/sitemap.xml') return new Response('<sitemapindex><loc>https://hacom.vn/sitemap-product-1.xml</loc></sitemapindex>');
    if (url === 'https://phongvu.vn/sitemap-collection-products.xml') return new Response('<sitemapindex><loc>https://phongvu.vn/sitemap-collection-products-9-linh-kien.xml</loc></sitemapindex>');
    if (url.endsWith('.xml')) return new Response(`<urlset>${urls.filter(u => new URL(u).hostname === new URL(url).hostname).map(u => `<url><loc>${u}</loc></url>`).join('')}</urlset>`);
    if (url.includes('/tim?')) return new Response(`<a class="p-name" href="${urls[3]}">GPU</a><a class="p-name" href="/pc-i5-12400-rtx-3060-12gb.html">PC</a>`);
    assert.ok(urls.includes(url),url); return new Response(productHtml(url,'Card màn hình RTX 3060 12GB GDDR6',6_000_000));
  };
  try {
    const source = new PublicRetailSources(store,fetcher);
    const result = await source.lookup(gpu.profile,undefined,'gpu');
    assert.equal(result.offers.length,4); assert.equal(result.status,'complete');
    await source.lookup(gpu.profile,undefined,'gpu');
    assert.equal(calls.filter(u => urls.includes(u)).length,4,'products are cached separately from discovery');
  } finally {store.close();}
});
test('automatic refresh warms retail parts, public reads stay offline, and retail filters never change used-market opportunities', async () => {
  let calls = 0;
  const {store,book} = fixture({lookup:async () => {calls++;return lookup([offer()]);}});
  store.saveSettings({...DEFAULT_SETTINGS,aiEnabled:false,minRamGb:0,minVramGb:0});
  const candidate = raw('service-retail',4_000_000,{region:'Đà Nẵng'});
  const peers = Array.from({length:5},(_,i) => ({raw:raw(`used-peer-${i}`,3_000_000),assessment:gpu}));
  const service = new FlipperService(store,{search:async input => ({items:input.location === 'danang' ? [candidate] : peers.map(p => p.raw),total:input.location === 'danang' ? 1 : 5}),detail:async input => input},undefined,undefined,undefined,book);
  try {
    const job = service.refresh('gpu','',20);
    for (let i=0;i<200 && service.activeJob();i++) await new Promise(r => setTimeout(r,5));
    assert.equal(service.getJob(job.id)?.status,'complete'); assert.equal(calls,1);
    const current = store.getListing(candidate.id)!;
    const used = buildReference(candidate,current.assessment,peers,store.getSettings()).reference;
    assert.ok(used); store.setReference(candidate.id,used,'Used-market comparison');
    const result = service.publicDetail(candidate.id)!;
    assert.equal(result.valuation.opportunity,false); assert.equal(result.valuation.reference?.average,3_000_000);
    assert.equal(result.valuation.depreciatedRetail?.opportunity,true);
    assert.equal(service.publicListings('gpu',new URLSearchParams('view=retail')).total,1);
    assert.equal(service.publicListings('gpu',new URLSearchParams('opportunities=true')).total,0);
    assert.equal(service.publicListings('gpu',new URLSearchParams()).stats.retailOpportunities,1);
    const server = appServer(service,undefined,{publicOrigin:'https://fixture.example',adminToken:'synthetic-test-administrator-token-12345678'});
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/listings?category=gpu&view=retail`);
      assert.equal(response.status,200); const body = await response.json();
      assert.equal(body.total,1); assert.equal(body.stats.retailOpportunities,1); assert.equal(body.job,null); assert.equal(body.ai,null);
    } finally {await new Promise<void>(resolve => server.close(() => resolve()));}
    store.setState(candidate.id,{dismissed:true});
    assert.equal(service.listings('gpu',new URLSearchParams('view=retail')).total,0);
    assert.equal(service.publicListings('gpu',new URLSearchParams('view=retail')).total,1);
    assert.equal(calls,1,'all public reads and filtering remain offline');
  } finally {await service.shutdown();store.close();}
});
