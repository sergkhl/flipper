import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { ProxyPool } from '../server/proxies.ts';
import { ChototClient } from '../server/chotot.ts';
import { FlipperService } from '../server/service.ts';
import { LiteLLMClient, type RefreshBudget } from '../server/litellm.ts';
import { assessWithRules } from '../server/hardware.ts';
import { SourceCooldownError } from '../server/source-cooldown.ts';
import { SourceDeferredError } from '../server/source-policy.ts';
import { WorkPool, concurrent } from '../server/concurrency.ts';
import type { RawListing, RefreshJob } from '../shared/types.ts';
import { raw } from './helpers.ts';

const routes = ['http://8.8.8.8:8080','socks5://1.1.1.1:1080','http://9.9.9.9:3128','http://208.67.222.222:8080'];
const page = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"initialState":{"adlisting":{"data":{"ads":[],"total":0}}}}}}</script>';
const input = { kind: 'gpu' as const, location: 'danang' as const };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check() && Date.now() < deadline) await delay(2);
  assert.equal(check(), true, 'expected progress before deadline');
}
async function settled(service: FlipperService, id: string) {
  await until(() => !service.activeJob()); return service.getJob(id)!;
}
const catalog: typeof fetch = async () => new Response(routes.join('\n'));

test('four proxy workers overlap bodies while retaining one request per route', async () => {
  const store = new Store('', true), controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const byRoute = new Map<string,number>(); let active = 0, maximum = 0;
  const pool = new ProxyPool(store, { download: catalog, probe: async () => true, send: async uri => {
    assert.equal(byRoute.get(uri) ?? 0, 0); byRoute.set(uri, 1); maximum = Math.max(maximum, ++active);
    return new Response(new ReadableStream({ start(controller) {
      controllers.push({ enqueue(value) { controller.enqueue(value); }, close() { active--; byRoute.set(uri, 0); controller.close(); } } as ReadableStreamDefaultController<Uint8Array>);
    } }));
  } });
  const client = new ChototClient({ pauseMs: 0, proxies: pool, requestStore: store });
  client.beginJob({ id:'bodies',category:'gpu',automatic:false,onRequest() {} });
  const requests = Array.from({length:8},()=>client.search(input));
  try {
    await until(()=>controllers.length===4); assert.equal(active,4); assert.equal(store.sourceBudgetStatus().used,4);
    for (const controller of controllers.slice()) { controller.enqueue(new TextEncoder().encode(page)); controller.close(); }
    await until(()=>controllers.length===8);
    for (const controller of controllers.slice(4)) { controller.enqueue(new TextEncoder().encode(page)); controller.close(); }
    await Promise.all(requests); assert.equal(maximum,4); assert.equal(store.sourceBudgetStatus().used,8);
  } finally { await client.close(); store.close(); }
});

test('worker and proxy pacing persist independently without a global start delay', () => {
  const directory=mkdtempSync(join(tmpdir(),'flipper-worker-pacing-'));
  let store = new Store(directory); const now = new Date('2026-10-24T10:00:00Z');
  try {
    for(let i=0;i<4;i++) assert.equal(store.reserveSourceRequest('gpu',false,now,3000,{worker:String(i),proxy:routes[i]!}),null);
    store.close();store=new Store(directory);
    assert.equal(store.reserveSourceRequest('gpu',false,new Date(now.getTime()+2999),3000,{worker:'0',proxy:routes[0]!}), '2026-10-24T10:00:03.000Z');
    assert.equal(store.reserveSourceRequest('gpu',false,new Date(now.getTime()+2999),3000,{worker:'new-worker',proxy:routes[0]!}), '2026-10-24T10:00:03.000Z', 'moving a route cannot evade its pacing');
    assert.equal(store.reserveSourceRequest('gpu',false,new Date(now.getTime()+2999),3000,{worker:'new-worker',proxy:'https://8.8.8.8:443'}), '2026-10-24T10:00:03.000Z', 'another protocol or port on the same IP shares pacing');
    assert.equal(store.reserveSourceRequest('gpu',false,new Date(now.getTime()+3000),3000,{worker:'0',proxy:routes[0]!}),null);
    assert.equal(store.sourceBudgetStatus(now).used,5);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('one 429 stops queued dispatches globally and allows already-started responses to finish', async () => {
  const store = new Store('',true); let sent=0, ready!:()=>void;
  const allStarted = new Promise<void>(resolve=>{ready=resolve;});
  const pool = new ProxyPool(store,{download:catalog,probe:async()=>true,send:async()=>{
    const number=++sent;if(sent===4)ready();await allStarted;
    if(number===1)return new Response('',{status:429,headers:{'retry-after':'3600'}});
    await delay(10);return new Response(page);
  }});
  const client=new ChototClient({pauseMs:0,proxies:pool,requestStore:store,cooldownStore:store});
  client.beginJob({id:'429-batch',category:'gpu',automatic:false,onRequest(){}});
  try {
    const outcomes=await Promise.allSettled(Array.from({length:8},()=>client.search(input)));
    assert.equal(sent,4);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,3);
    assert.ok(outcomes.filter(x=>x.status==='rejected').every(x=>x.status==='rejected'&&x.reason instanceof SourceCooldownError));
    assert.equal(store.sourceBudgetStatus().used,4);assert.equal(pool.status().available,4);
    await assert.rejects(client.search(input),SourceCooldownError);assert.equal(sent,4);
  } finally {await client.close();store.close();}
});

test('simultaneous workers cannot overspend the final three attempts of a 700-request allowance', async () => {
  const store=new Store('',true);let sent=0;
  for(let i=0;i<697;i++)store.reserveSourceRequest('gpu',false,new Date(),0);
  const pool=new ProxyPool(store,{download:catalog,probe:async()=>true,send:async()=>{sent++;await delay(10);return new Response(page);}});
  const client=new ChototClient({pauseMs:0,proxies:pool,requestStore:store});
  client.beginJob({id:'last-three',category:'gpu',automatic:false,onRequest(){}});
  try {
    const outcomes=await Promise.allSettled(Array.from({length:8},()=>client.search(input)));
    assert.equal(sent,3);assert.equal(store.sourceBudgetStatus().used,700);
    assert.ok(outcomes.some(x=>x.status==='rejected'&&x.reason instanceof SourceDeferredError));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,3);
  } finally {await client.close();store.close();}
});

test('failed workers retire while one healthy route continues all unfinished requests', async () => {
  const store=new Store('',true);let sent=0,direct=0;
  const pool=new ProxyPool(store,{download:catalog,probe:async()=>true,send:async uri=>{
    sent++;if(uri!==routes[3])throw new TypeError('Proxy connection failed');await delay(2);return new Response(page);
  }});
  const client=new ChototClient({pauseMs:0,proxies:pool,requestStore:store,fetch:async()=>{direct++;return new Response(page);}});
  client.beginJob({id:'one-survivor',category:'gpu',automatic:false,onRequest(){}});
  try {
    await Promise.all(Array.from({length:8},()=>client.search(input)));
    assert.equal(sent,11);assert.equal(direct,0);assert.equal(client.proxyStatus()?.workers,1);
    assert.equal(pool.status().retryAt,null);assert.equal(store.sourceBudgetStatus().used,11);
  } finally {await client.close();store.close();}
});

test('HTTPS health checks have a twelve-candidate job ceiling and do not consume marketplace allowance', async () => {
  const store=new Store('',true);let probes=0,active=0,maximum=0;
  const candidates=Array.from({length:40},(_,i)=>`http://8.8.1.${i+1}:8080`);
  const pool=new ProxyPool(store,{download:async()=>new Response(candidates.join('\n')),probe:async uri=>{
    probes++;maximum=Math.max(maximum,++active);await delay(2);active--;return uri===candidates[0];
  }});
  try {
    assert.deepEqual(await pool.routes(4),[candidates[0]]);assert.equal(probes,12);assert.equal(maximum,4);
    assert.deepEqual(await pool.routes(4),[candidates[0]]);assert.equal(probes,12);
    assert.equal(pool.status().verified,1);assert.equal(store.sourceBudgetStatus().used,0);
  } finally {await pool.close();store.close();}
});

test('concurrent AI assessments share the original budget and stop before overspending', async t => {
  const store=new Store('',true);store.saveSettings({...store.getSettings(),aiBudgetUsd:.05});
  t.mock.method(store,'getKey',()=> 'fixture-no-network');let active=0,maximum=0,calls=0;
  t.mock.method(LiteLLMClient.prototype,'assess',async(item:RawListing,budget:RefreshBudget)=>{
    const reservation=budget.reserve(.01);calls++;maximum=Math.max(maximum,++active);
    await delay(10);reservation.settle(.01);active--;
    return {...assessWithRules(item),method:'ai' as const};
  });
  const locals=Array.from({length:12},(_,i)=>raw(`ai-parallel-${i}`,4_000_000+i));
  const service=new FlipperService(store,{async search(q){return{items:q.location==='danang'?locals:Array.from({length:5},(_,i)=>raw(`ai-peer-${i}`,6_000_000)),total:q.location==='danang'?12:5};},async detail(item){return item;}});
  try {
    const job=await settled(service,service.refresh('gpu','',20).id);
    assert.equal(job.status,'complete');assert.equal(job.assessed,12);assert.equal(maximum,4);assert.equal(calls,5);
    assert.ok(Math.abs(job.aiCostUsd-.05)<1e-12);assert.equal(service.aiStatus().status,'budget_limited');
  } finally {await service.shutdown();store.close();}
});

test('independent configuration queries run concurrently and publish only complete evidence', async () => {
  const store=new Store('',true);store.saveSettings({...store.getSettings(),aiEnabled:false});
  const models=['RTX3060 12GB','RTX3070 8GB','RTX3080 10GB','RTX3090 24GB'];
  const locals=models.map((title,i)=>raw(`query-local-${i}`,4_000_000,{title}));let active=0,maximum=0;
  const service=new FlipperService(store,{async search(q){
    if(q.location==='danang')return{items:locals,total:4};
    maximum=Math.max(maximum,++active);await delay(15);active--;
    const title=models.find(model=>(q.query??'').includes(model.slice(3,7)))!;
    return{items:Array.from({length:5},(_,i)=>raw(`query-${title}-${i}`,6_000_000,{title})),total:5};
  },async detail(item){return item;}});
  try {
    const job=await settled(service,service.refresh('gpu','',20).id);
    assert.equal(job.status,'complete');assert.equal(maximum,4);assert.equal(job.configurationsCompleted,4);
    assert.equal(job.benchmarked,4);assert.equal(service.listings('gpu',new URLSearchParams()).stats.opportunities,4);
  } finally {await service.shutdown();store.close();}
});

test('concurrent configurations share national pagination without duplicate first pages', async () => {
  const store=new Store('',true);store.saveSettings({...store.getSettings(),aiEnabled:false});
  const pc=(id:string,ram:number)=>raw(id,8_000_000,{category:'desktop',title:`PC i5-12400 RAM${ram}GB DDR4 RTX3070 8GB SSD512GB NVMe`});
  const locals=[pc('shared-local-16',16),pc('shared-local-32',32)];
  const peers=[...Array.from({length:20},(_,i)=>pc(`shared-peer-16-${i}`,16)),...Array.from({length:5},(_,i)=>pc(`shared-peer-32-${i}`,32))];
  const pages:number[]=[];
  const service=new FlipperService(store,{async search(q){
    if(q.location==='danang')return{items:locals,total:2};
    assert.equal(q.kind,'desktop');const page=q.page??1;pages.push(page);await delay(5);
    return{items:peers.slice((page-1)*20,page*20),total:25};
  },async detail(item){return item;}});
  try {
    const job=await settled(service,service.refresh('desktop','',20).id);
    assert.equal(job.status,'complete');assert.deepEqual(pages,[1,2]);assert.equal(job.configurationsCompleted,2);
    assert.ok((service.detail(locals[0]!.id)?.valuation.reference?.sampleCount??0)>=5);
    assert.equal(service.detail(locals[1]!.id)?.valuation.reference?.sampleCount,5);
  } finally {await service.shutdown();store.close();}
});

test('cancelling concurrent recovery drains workers and checkpoints completed configuration progress', async () => {
  const store=new Store('',true);store.saveSettings({...store.getSettings(),aiEnabled:false});
  const models=['RTX3060 12GB','RTX3070 8GB','RTX3080 10GB','RTX3090 24GB'];
  const locals=models.map((title,i)=>raw(`checkpoint-local-${i}`,4_000_000,{title}));
  const now=new Date(),seed:RefreshJob={id:'parallel-recovery',category:'gpu',query:'',status:'failed',message:'Old work',scanned:0,target:20,assessed:0,benchmarked:0,totalAvailable:null,requestCount:0,aiCostUsd:.02,error:'Old failure',startedAt:now.toISOString(),completedAt:now.toISOString()};
  const queued=store.deferScanRetry(seed,store.getSettings(),{until:now.toISOString()},null);
  const service=new FlipperService(store,{async search(q){
    if(q.location==='danang')return{items:locals,total:4};
    if(!(q.query??'').includes('3060'))return await new Promise<never>((_resolve,reject)=>q.signal!.addEventListener('abort',()=>reject(q.signal!.reason),{once:true}));
    return{items:Array.from({length:5},(_,i)=>raw(`checkpoint-peer-${i}`,6_000_000)),total:5};
  },async detail(item){return item;}});
  try {
    const job=service.tryStartDailyRefresh(now)!;
    await until(()=>store.scanRetries().find(x=>x.id===queued.id)!.progress?.comparedIds.length===1);
    service.cancelJob(job.id);assert.equal((await settled(service,job.id)).status,'cancelled');
    const saved=store.scanRetries().find(x=>x.id===queued.id)!;
    assert.equal(saved.progress?.assessedIds.length,4);assert.equal(saved.progress?.comparedIds.length,1);
    assert.equal(saved.spentUsd,.02);assert.equal(service.activeJob(),null);
  } finally {await service.shutdown();store.close();}
});

test('parallel batches drain started operations before reporting a failure', async () => {
  let active=0,finished=0;
  await assert.rejects(concurrent([0,1,2,3,4,5],4,async value=>{
    active++;await delay(value===0?1:10);active--;finished++;
    if(value===0)throw new Error('Stop dispatch');return value;
  }),/Stop dispatch/);
  assert.equal(active,0);assert.equal(finished,4);
  const pool=new WorkPool(4);let maximum=0;
  await Promise.all(Array.from({length:12},()=>pool.run(async()=>{maximum=Math.max(maximum,++active);await delay(2);active--;})));
  assert.equal(maximum,4);assert.equal(pool.running,0);
});
