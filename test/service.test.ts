import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { appServer } from '../server/http.ts';
import { assessWithRules } from '../server/hardware.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { buildReference } from '../server/pricing.ts';
import type { LaptopSpecRequest, MemoryPartRequest, TechLaptopRecord, TechMemoryRecord } from '../server/techapi.ts';
import { assessment, raw } from './helpers.ts';

async function completed(service: FlipperService, id: string) {
  const deadline = Date.now() + 2_000;
  while (service.activeJob() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.activeJob(), null); return service.getJob(id)!;
}

test('laptop references are read offline and manual analysis tolerates an unavailable laptop catalog', async () => {
  const store = new Store('', true), batches: LaptopSpecRequest[][] = [];
  store.saveSettings({...store.getSettings(),aiEnabled:false});
  const candidate = raw('mac-catalog',20_000_000,{category:'laptop',
    title:'MacBook Pro 14inch M2 Pro 10CPU/16GPU 16GB/512GB',
    description:'MacBook Pro 14inch M2 Pro 10CPU/16GPU RAM 16GB SSD 512GB. Máy hoạt động tốt, chưa sửa chữa.'});
  const record: TechLaptopRecord = {name:'Apple MacBook Pro 14 M2 Pro',cpu:'M2 PRO',gpu:'Apple 16-Core GPU',
    modelYear:2023,screenInches:14.2,cpuCores:10,gpuCores:16,ramGb:16,storageGb:512,ramType:'LPDDR5',
    url:'https://gettechapi.github.io/TechAPI/v1/laptops/apple-macbook-pro/index.json',sourceUrls:[],fetchedAt:new Date().toISOString()};
  const service = new FlipperService(store,{async search(){return {items:[candidate],total:1};},async detail(item){return item;}},
    {get:()=>[],getLaptops:()=>[record],async warmLaptops(requests){batches.push(requests);throw Error('Optional laptop catalog unavailable');}});
  try {
    store.putListing(candidate,assessWithRules(candidate),true); store.setCollection('laptop','',[candidate.id]);
    const detail = service.detail(candidate.id)!;
    assert.equal(detail.assessment.laptopSpecReferences?.[0]?.modelYear,2023);
    assert.equal(detail.assessment.profile.modelYear,null,'catalog year must not become a seller fact');
    assert.equal(detail.assessment.profile.screenInches,14,'seller screen remains distinct from catalog diagonal');
    assert.equal(batches.length,0,'detail reads do not warm the catalog');
    assert.equal((await completed(service,service.analyze(candidate.id).id)).status,'complete');
    assert.ok(batches.flat().some(request=>request.model==='MACBOOK PRO 14' && request.gpuCores===16));
    assert.equal(service.detail(candidate.id)?.assessment.profile.ramGb,16);
  } finally { store.close(); }
});

test('cached memory hints enrich reads offline without invalidating unchanged GPU price evidence', () => {
  const store = new Store('', true); let warmCalls = 0;
  const cached: TechMemoryRecord = { kind:'gpu',name:'RTX 3060',types:['GDDR6'],gpuClass:'desktop',socket:null,
    url:'https://gettechapi.github.io/TechAPI/v1/gpus/geforce-rtx-3060/index.json',sourceUrls:[],fetchedAt:'2026-10-14T00:00:00.000Z' };
  const service = new FlipperService(store,undefined,{get:kind => kind==='gpu'?[cached]:[],async warm(){warmCalls++;}});
  try {
    const candidate = raw('cached-memory-read',4_000_000), a = enrichComputerAssessment(candidate,assessWithRules(candidate));
    store.putListing(candidate,a,true); store.setCollection('gpu','',[candidate.id]);
    const peers = Array.from({length:5},(_,i) => ({raw:raw(`cached-memory-peer-${i}`,6_000_000),assessment:a}));
    const reference = buildReference(candidate,a,peers,store.getSettings()).reference; assert.ok(reference);
    store.setReference(candidate.id,reference,'Supported comparison');
    const detail = service.detail(candidate.id)!;
    assert.equal(detail.assessment.profile.gpuMemoryType,'GDDR6'); assert.equal(detail.valuation.reference?.sampleCount,5);
    assert.ok(detail.assessment.memoryTypeInferences?.some(i => i.sources.some(s => s.label==='TechAPI')));
    assert.equal(service.listings('gpu',new URLSearchParams()).items.length,1);
    assert.equal(warmCalls,0);
  } finally { store.close(); }
});

test('manual collection warms a distinct-part batch while cache failure leaves marketplace and capacity filters usable', async () => {
  const store = new Store('',true), batches: MemoryPartRequest[][] = [];
  store.saveSettings({...store.getSettings(),aiEnabled:false});
  const candidate = raw('warm-candidate',4_000_000,{region:'Đà Nẵng'});
  const peers = Array.from({length:5},(_,i) => raw(`warm-peer-${i}`,6_000_000));
  const service = new FlipperService(store,{async search(input){return {items:input.location==='danang'?[candidate]:peers,total:input.location==='danang'?1:5};},async detail(item){return item;}},
    {get:()=>[],async warm(parts){batches.push(parts);throw Error('Optional specification service offline');}});
  try {
    assert.equal((await completed(service,service.refresh('gpu','',20).id)).status,'complete');
    assert.ok(batches.length>0); assert.ok(batches.flat().every(p => p.kind==='gpu' && p.model==='RTX 3060'));
    assert.equal(service.detail(candidate.id)?.valuation.opportunity,true);
    assert.equal(service.listings('gpu',new URLSearchParams('minVramGb=16')).items.length,0);
  } finally { store.close(); }
});

test('manual job retrieves national evidence, keeps local detail intact and failed refresh preserves snapshot', async () => {
  const store = new Store('', true); let broken = false;
  const candidate = raw('local', 4_000_000, { region: 'Đà Nẵng', district: 'Cẩm Lệ', description: '' });
  const peers = Array.from({ length: 5 }, (_, i) => raw(`national-${i}`, 6_000_000));
  const service = new FlipperService(store, {
    async search(input) {
      if (broken) throw new Error('Marketplace blocked during test');
      return { items: input.location === 'danang' ? [candidate] : [candidate, ...peers], total: input.location === 'danang' ? 1 : 6 };
    },
    async detail(item) { return { ...item, description: 'RTX 3060 12GB card working normally, original local detail' }; },
  });
  const job = service.refresh('gpu', '', 20);
  assert.throws(() => service.refresh('gpu', '', 20), /already running/);
  assert.equal((await completed(service, job.id)).status, 'complete');
  const listing = service.detail('local')!;
  assert.equal(listing.description.includes('original local detail'), true);
  assert.equal(listing.valuation.reference?.sampleCount, 5);
  assert.equal(listing.valuation.reference?.average, 6_000_000);
  assert.equal(listing.valuation.opportunity, true);
  service.state('local', { saved: true });
  broken = true;
  const failed = service.refresh('gpu', '', 20); assert.equal((await completed(service, failed.id)).status, 'failed');
  const retained = service.listings('gpu', new URLSearchParams());
  assert.equal(retained.items.length, 1); assert.equal(retained.items[0]?.state.saved, true);
  assert.match(retained.coverage?.error ?? '', /Marketplace blocked/);
  store.close();
});

test('cancellation interrupts a pending source request and leaves previous evidence', async () => {
  const store = new Store('', true);
  const service = new FlipperService(store, {
    async search(input) { return await new Promise((_resolve, reject) => { input.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); },
    async detail(item) { return item; },
  });
  const job = service.refresh('gpu', '', 20); service.cancelJob(job.id);
  assert.equal((await completed(service, job.id)).status, 'cancelled'); store.close();
});

test('local and national collection continue after a source page loses unusable ads during normalization', async () => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false, benchmarkLimit: 60 });
  const items = Array.from({ length: 45 }, (_, i) => raw(`pagination-${i}`, 6_000_000));
  const visited: Array<{ location: string; page: number }> = [];
  const service = new FlipperService(store, {
    async search(input) {
      const page = input.page ?? 1;
      visited.push({ location: input.location, page });
      // The source counted 46 ads, but one on page 1 had no usable link.
      return { items: page === 1 ? items.slice(0, 19) : page === 2 ? items.slice(19, 39) : items.slice(39), total: 46 };
    },
    async detail(item) { return item; },
  });
  try {
    const job = await completed(service, service.refresh('gpu', '', 60).id);
    assert.equal(job.status, 'complete');
    assert.equal(job.scanned, 45);
    assert.equal(service.listings('gpu', new URLSearchParams()).total, 45);
    assert.deepEqual(visited.filter((call) => call.location === 'danang').map((call) => call.page), [1, 2, 3]);
    assert.deepEqual(visited.filter((call) => call.location === 'nationwide').map((call) => call.page), [1],
      'enough matching independent offers stop national pagination early');
    assert.equal(service.detail('pagination-0')?.valuation.reference?.sampleCount, 7,
      'assessment stops after two bounded batches support the reference');
  } finally { store.close(); }
});

test('memory filters are inclusive, independently exclude known failures and optionally exclude unknowns even under Any', () => {
  const store = new Store('', true);
  const service = new FlipperService(store);
  try {
    for (const category of ['laptop', 'desktop'] as const) {
      const cases = [8, 16, null].flatMap((ramGb) => [4, 8, null].map((vramGb) => ({ id: `${category}-${ramGb}-${vramGb}`, ramGb, vramGb })));
      for (const item of cases) {
        store.putListing(raw(item.id, 10_000_000, { category,
          title: `RTX 3060${item.vramGb === null ? '' : ` ${item.vramGb}GB`} ${item.ramGb === null ? '' : `RAM ${item.ramGb}GB`}` }),
          assessment({ ramGb: item.ramGb, vramGb: item.vramGb, gpuClass: category === 'laptop' ? 'mobile' : 'desktop' }, { kind: category, method: 'ai' }), true);
        store.setState(item.id, { saved: true });
      }
      store.setCollection(category, '', cases.map((item) => item.id));
      for (const [minRamGb, minVramGb, includeUnknownMemory] of [[16, 8, true], [16, 8, false], [0, 0, true], [0, 0, false], [16, 0, true], [0, 8, false]] as const) {
        const params = new URLSearchParams({ minRamGb: String(minRamGb), minVramGb: String(minVramGb), includeUnknownMemory: String(includeUnknownMemory) });
        const expected = cases.filter(({ ramGb, vramGb }) =>
          (ramGb === null ? includeUnknownMemory : ramGb >= minRamGb) && (vramGb === null ? includeUnknownMemory : vramGb >= minVramGb)).map((item) => item.id).sort();
        const result = service.listings(category, params);
        assert.deepEqual(result.items.map((item) => item.id).sort(), expected, `${category}: ${params}`);
        assert.equal(result.stats.scanned, 9);
        assert.equal(result.stats.saved, expected.length);
        params.set('view', 'saved');
        assert.deepEqual(service.listings(category, params).items.map((item) => item.id).sort(), expected);
      }
      assert.equal(service.listings(category, new URLSearchParams()).total, 4);
      assert.ok(service.detail(`${category}-8-null`));
    }
    for (const vramGb of [4, 8, null]) store.putListing(raw(`gpu-${vramGb}`, 5_000_000), assessment({ vramGb }), true);
    store.setCollection('gpu', '', ['gpu-4', 'gpu-8', 'gpu-null']);
    assert.deepEqual(service.listings('gpu', new URLSearchParams('minRamGb=4096')).items.map((item) => item.id).sort(), ['gpu-8', 'gpu-null']);
    assert.equal(service.listings('gpu', new URLSearchParams('includeUnknownMemory=false')).total, 1);
    assert.equal(service.listings('gpu', new URLSearchParams('minVramGb=0&includeUnknownMemory=false')).total, 2);
    store.saveSettings({ ...store.getSettings(), minRamGb: 8, minVramGb: 4, includeUnknownMemory: false });
    assert.equal(service.listings('desktop', new URLSearchParams()).total, 4);
    assert.equal(service.listings('gpu', new URLSearchParams()).total, 2);
    assert.equal(service.listings('gpu', new URLSearchParams('minVramGb=8&includeUnknownMemory=true')).total, 2);
  } finally { store.close(); }
});

test('integrated and GPU-free computers are exempt from VRAM, and an alternative GPU offer cannot qualify a lower-memory displayed-price configuration', () => {
  const store = new Store('', true), service = new FlipperService(store);
  try {
    for (const category of ['laptop', 'desktop'] as const) {
      const integrated = raw(`${category}-integrated`, 10_000_000, { category, title: 'Computer with integrated graphics' });
      store.putListing(integrated, assessment({ ramGb: 16, gpu: 'Intel UHD', gpuClass: 'integrated', vramGb: null }, { kind: category, method: 'ai' }), true);
      const absent = raw(`${category}-no-gpu`, 10_000_000, { category, title: 'Computer without GPU' });
      store.putListing(absent, assessment({ ramGb: 16, gpu: null, gpuClass: null, vramGb: null }, { kind: category, method: 'ai' }), true);
      const unknown = raw(`${category}-unknown-gpu`, 10_000_000, { category, title: 'Computer' });
      store.putListing(unknown, assessment({ ramGb: 16, gpu: null, gpuClass: null, vramGb: null }, { kind: category, method: 'ai' }), true);
      store.setCollection(category, '', [integrated.id, absent.id, unknown.id]);
      assert.deepEqual(service.listings(category, new URLSearchParams('minVramGb=4096&includeUnknownMemory=false')).items.map((item) => item.id).sort(), [integrated.id, absent.id].sort());
      assert.equal(service.listings(category, new URLSearchParams()).total, 3);
    }
    const optionPc = raw('displayed-price-option', 10_000_000, {
      category: 'desktop', title: 'PC i5-12400 RAM8GB DDR4 RTX3070 8GB SSD512GB NVMe',
      description: 'CPU i5-12400\nRAM8GB DDR4\nSSD512GB NVMe\nVGA RTX3070 8GB\nGiá không card rời 10tr\nGiá full bộ 14tr\nMáy hoạt động tốt, chưa sửa chữa',
    });
    store.putListing(optionPc, assessWithRules(optionPc), true);
    store.setCollection('desktop', '', [optionPc.id]);
    assert.equal(service.detail(optionPc.id)?.assessment.profile.gpuInclusion, 'absent');
    assert.equal(service.listings('desktop', new URLSearchParams()).total, 0);
    assert.equal(service.listings('desktop', new URLSearchParams('minRamGb=8&includeUnknownMemory=false')).total, 1);
    assert.equal(service.detail(optionPc.id)?.assessment.priceOptions?.length, 2);
  } finally { store.close(); }
});

test('allowing unknown capacity admits memory-only review listings without scoring and keeps other review reasons in the review queue', () => {
  const store = new Store('', true), service = new FlipperService(store);
  try {
    const card = raw('unknown-card-capacity', 5_000_000, { title: 'RTX 3070', description: 'Card RTX 3070 hoạt động tốt, chưa sửa chữa' });
    store.putListing(card, assessWithRules(card), true);
    const extraIssue = raw('unknown-capacity-plus-condition', 5_000_000, { title: 'RTX 3070', condition: 'unknown' });
    store.putListing(extraIssue, assessWithRules(extraIssue), true);
    const conflict = raw('unknown-capacity-plus-conflict', 5_000_000, { title: 'RTX 3070', description: 'Card RTX 3070 hoạt động tốt, chưa sửa chữa' });
    store.putListing(conflict, assessment({ gpu: 'RTX 3070', vramGb: null }, { eligibility: 'review', unknowns: ['VRAM capacity is unknown'], conflicts: ['Price conflict'], method: 'ai' }), true);
    const generation = raw('unknown-capacity-plus-generation', 5_000_000, { title: 'GTX 1650', description: 'Card GTX 1650 hoạt động tốt, chưa sửa chữa' });
    store.putListing(generation, assessWithRules(generation), true);
    const unidentified = raw('unknown-capacity-plus-seller', 5_000_000, { title: 'RTX 3070', sellerId: null });
    store.putListing(unidentified, assessWithRules(unidentified), true);
    const bundle = raw('unknown-capacity-plus-bundle', 5_000_000, { title: 'RTX 3070' });
    store.putListing(bundle, assessment({ gpu: 'RTX 3070', vramGb: null, quantity: 2, priceBasis: 'bundle' }, { eligibility: 'review', unknowns: ['VRAM capacity is unknown'], method: 'ai' }), true);
    const ids = [card, extraIssue, conflict, generation, unidentified, bundle].map((item) => item.id);
    store.setCollection('gpu', '', ids);
    for (const id of ids) store.setState(id, { saved: true });
    const all = service.listings('gpu', new URLSearchParams());
    assert.deepEqual(all.items.map((item) => item.id), [card.id]);
    assert.equal(all.items[0]?.assessment.eligibility, 'review');
    assert.equal(all.items[0]?.valuation.status, 'needs_review');
    assert.equal(all.items[0]?.valuation.discountPercent, null);
    assert.equal(all.items[0]?.valuation.opportunity, false);
    assert.equal(all.stats.saved, ids.length);
    assert.equal(all.stats.excluded, ids.length - 1);
    assert.equal(service.listings('gpu', new URLSearchParams('view=saved')).total, ids.length);
    assert.equal(service.listings('gpu', new URLSearchParams('view=review')).total, ids.length - 1);
    assert.equal(service.listings('gpu', new URLSearchParams('opportunities=true')).total, 0);
    for (const view of ['all', 'saved', 'review']) {
      const excluded = service.listings('gpu', new URLSearchParams(`view=${view}&includeUnknownMemory=false`));
      assert.equal(excluded.total, 0);
      assert.equal(excluded.stats.saved, 0);
      assert.equal(excluded.stats.excluded, 0);
    }
    const laptop = raw('unknown-laptop-ram', 10_000_000, {
      category: 'laptop', title: 'Laptop Lenovo Legion 5 15ITH6H i5-11400H RTX3060 6GB SSD512GB NVMe',
      description: 'Lenovo Legion 5 15ITH6H\ni5-11400H\nRTX3060 6GB\nSSD512GB NVMe\nMáy hoạt động tốt, chưa sửa chữa',
    });
    store.putListing(laptop, assessWithRules(laptop), true);
    store.setCollection('laptop', '', [laptop.id]);
    assert.equal(service.listings('laptop', new URLSearchParams('minVramGb=6')).total, 1);
    assert.equal(service.listings('laptop', new URLSearchParams()).total, 0);
    assert.equal(service.listings('laptop', new URLSearchParams('minVramGb=6&includeUnknownMemory=false')).total, 0);
  } finally { store.close(); }
});

test('real validated AI memory-capacity messages admit unknown memory while non-memory validation failures stay in review', () => {
  const store = new Store('', true), service = new FlipperService(store);
  try {
    const ids: string[] = [];
    for (const field of ['ramGb', 'vramGb'] as const) for (const reason of ['is not stated reliably.', 'has no verifiable supporting quote.']) {
      const id = `ai-${field}-${ids.length}`;
      const item = raw(id, 10_000_000, { category: 'laptop', title: 'Lenovo Legion 5 15ITH6H i5-11400H RTX3060' });
      store.putListing(item, assessment({ model: 'Lenovo Legion 5 15ITH6H', cpu: 'I5-11400H', gpu: 'RTX 3060', gpuClass: 'mobile',
        ramGb: field === 'ramGb' ? null : 16, vramGb: field === 'vramGb' ? null : 8, storageGb: 512, storageType: 'NVME SSD' }, {
        kind: 'laptop', method: 'ai', eligibility: 'review', unknowns: [`${field} ${reason}`],
      }), true);
      ids.push(id);
    }
    for (const field of ['cpu', 'gpuMemoryType']) {
      const id = `ai-other-${field}`;
      store.putListing(raw(id, 10_000_000, { category: 'laptop' }), assessment({ ramGb: 16, vramGb: 8 }, {
        kind: 'laptop', method: 'ai', eligibility: 'review', unknowns: ['vramGb is not stated reliably.', `${field} has no verifiable supporting quote.`],
      }), true);
      ids.push(id);
    }
    store.setCollection('laptop', '', ids);
    assert.deepEqual(service.listings('laptop', new URLSearchParams()).items.map((item) => item.id).sort(), ids.slice(0, 4).sort());
    assert.deepEqual(service.listings('laptop', new URLSearchParams('view=review')).items.map((item) => item.id).sort(), ids.slice(4).sort());
    assert.equal(service.listings('laptop', new URLSearchParams('includeUnknownMemory=false')).total, 0);
    for (const id of ids.slice(0, 4)) assert.equal(service.detail(id)?.valuation.opportunity, false);
  } finally { store.close(); }
});

test('bounded refresh spends detail and comparison work on the active RAM filter before cheap low-RAM PCs', async () => {
  for (const minimum of [24, 64, 0]) {
    const store = new Store('', true);
    store.saveSettings({ ...store.getSettings(), aiEnabled: false });
    const cpuFor = (i: number) => `I5-${10400 + i}`;
    const pc = (id: string, price: number, cpu: string, ram: number | null) => raw(id, price, {
      category: 'desktop', title: `PC ${cpu} RTX3060 12GB ${ram === null ? '' : `RAM${ram}GB`} SSD 512GB NVME`, description: '',
    });
    const low = Array.from({ length: 31 }, (_, i) => pc(`low-${i}`, 2_000_000 + i * 10_000, cpuFor(i), 16));
    const medium = pc('ram32', 10_000_000, 'I5-12400', 32);
    const high = pc('ram64', 14_000_000, 'I5-13400', 64);
    const unknown = pc('unknown', 3_000_000, 'I5-11400', null);
    const all = [...low, unknown, medium, high];
    const details: string[] = [], comparisons: string[] = [];
    const service = new FlipperService(store, {
      async search(input) {
        if (input.location === 'danang') return { items: all.slice(((input.page ?? 1) - 1) * 20, (input.page ?? 1) * 20), total: all.length };
        if (input.kind === 'desktop') comparisons.push(input.query ?? '');
        const target = all.find((row) => input.query?.includes(row.id === 'ram64' ? 'I5-13400' : row.id === 'ram32' ? 'I5-12400' : 'NO MATCH'));
        return { items: input.kind === 'desktop' && target ? Array.from({ length: 3 }, (_, i) => ({
          ...target, id: `${target.id}-peer-${i}`, sellerId: `peer-${target.id}-${i}`, price: target.price + 2_000_000,
          description: 'Máy hoạt động tốt, chưa sửa chữa',
        })) : [], total: target ? 3 : 0 };
      },
      async detail(item) { details.push(item.id); return { ...item, description: 'Máy hoạt động tốt, chưa sửa chữa' }; },
    });
    try {
      const job = service.refresh('desktop', '', all.length, minimum);
      assert.equal((await completed(service, job.id)).status, 'complete');
      const first = minimum === 64 ? 'ram64' : minimum === 24 ? 'ram32' : 'low-0';
      assert.equal(details[0], first);
      assert.ok(comparisons[0]?.includes(minimum === 64 ? 'I5-13400' : minimum === 24 ? 'I5-12400' : cpuFor(0)));
      if (minimum > 0) {
        assert.ok(details.indexOf('unknown') < details.indexOf('low-0'));
        const item = service.detail(first)!;
        assert.equal(item.valuation.status, 'indicative');
        assert.equal(item.valuation.reference?.sampleCount, 3);
        assert.equal(item.valuation.opportunity, false);
        const feed = service.listings('desktop', new URLSearchParams(`minRamGb=${minimum}`));
        assert.equal(feed.stats.benchmarked, minimum === 64 ? 1 : 2);
      } else {
        assert.equal(service.detail('ram64')?.valuation.reference, null);
        assert.ok(!comparisons.some((query) => query.includes('I5-13400')));
      }
      assert.equal(store.getSettings().aiBudgetUsd, 0.25);
    } finally { store.close(); }
  }
});

test('refresh prioritizes memory matches for ten initial details and verifies additional priced candidates', async () => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false, minRamGb: 16, minVramGb: 8, includeUnknownMemory: false });
  const pc = (id: string, price: number, ram: number | null, gpu: string) => raw(id, price, {
    category: 'desktop', title: `PC i5-12400 ${ram === null ? '' : `RAM${ram}GB DDR4`} ${gpu} SSD512GB NVMe`, description: '',
  });
  const matching = pc('memory-match', 12_000_000, 16, 'RTX3070 8GB');
  const integrated = pc('memory-integrated', 10_000_000, 16, 'Intel UHD 730');
  const absent = pc('memory-absent', 11_000_000, 16, 'không card rời');
  const unknownRam = pc('memory-unknown-ram', 8_000_000, null, 'RTX3070 8GB');
  const unknownVram = pc('memory-unknown-vram', 9_000_000, 16, 'RTX3070');
  const failRam = pc('memory-low-ram', 3_000_000, 8, 'RTX3070 8GB');
  const failVram = pc('memory-low-vram', 2_000_000, 16, 'GTX1060 6GB');
  const knownFailUnknownOther = pc('memory-known-failure-with-unknown', 1_000_000, 8, 'RTX3070');
  const moreFailures = Array.from({ length: 30 }, (_, i) => ({ ...pc(`memory-low-${i}`, 4_000_000 + i * 10_000, 8, 'GTX1060 6GB'),
    title: `PC I5-${10400 + i} RAM8GB DDR4 GTX1060 6GB SSD512GB NVMe` }));
  const all = [knownFailUnknownOther, failVram, failRam, ...moreFailures, unknownRam, unknownVram, integrated, absent, matching];
  const details: string[] = [], comparisons: string[] = [];
  const service = new FlipperService(store, {
    async search(input) {
      if (input.location === 'danang') {
        const start = ((input.page ?? 1) - 1) * 20;
        return { items: all.slice(start, start + 20), total: all.length };
      }
      if (input.kind === 'desktop') comparisons.push(input.query ?? '');
      return { items: [], total: 0 };
    },
    async detail(item) { details.push(item.id); return { ...item, description: 'Máy hoạt động tốt, chưa sửa chữa' }; },
  });
  try {
    assert.equal((await completed(service, service.refresh('desktop', '', all.length).id)).status, 'complete');
    assert.deepEqual(details.slice(0, 8), [integrated.id, absent.id, matching.id, unknownRam.id, unknownVram.id, knownFailUnknownOther.id, failVram.id, failRam.id]);
    assert.equal(details.length, 13, 'ten initial detail reads plus three verified comparison candidates');
    assert.ok(comparisons.length > 0);
    assert.equal(service.listings('desktop', new URLSearchParams()).total, 3);
    assert.equal(store.getSettings().aiBudgetUsd, .25);
  } finally { store.close(); }
});

test('legacy resale mode does not alter deal filtering, counts or sorting', () => {
  const store = new Store('', true), service = new FlipperService(store);
  try {
    const candidate = raw('discount-opportunity', 4_000_000);
    const a = enrichComputerAssessment(candidate, assessWithRules(candidate));
    store.putListing(candidate, a, true);
    const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`discount-peer-${i}`, 6_000_000), assessment: a }));
    const reference = buildReference(candidate, a, peers, store.getSettings()).reference;
    assert.ok(reference);
    store.setReference(candidate.id, reference, 'Supported used asking-price comparison');
    store.setState(candidate.id, { costReserve: 20_000_000 });
    store.setCollection('gpu', '', [candidate.id]);
    assert.equal(service.detail(candidate.id)?.valuation.opportunity, true);
    assert.equal(service.detail(candidate.id)?.valuation.resaleOpportunity, false);
    for (const mode of ['buy', 'resale']) {
      const result = service.listings('gpu', new URLSearchParams(`mode=${mode}&opportunities=true`));
      assert.deepEqual(result.items.map((item) => item.id), [candidate.id]);
      assert.equal(result.stats.opportunities, 1);
    }
  } finally { store.close(); }
});

test('read-time profile corrections invalidate a reference until focused evidence is refreshed', () => {
  const store = new Store('', true), service = new FlipperService(store);
  try {
    const candidate = raw('changed-read-profile', 8_000_000, {
      category: 'desktop', title: 'PC i5-12400 RAM16GB DDR4 RTX3070 8GB SSD512GB NVMe',
    });
    const oldAssessment = { ...assessWithRules(candidate), profile: { ...assessWithRules(candidate).profile, ramGb: 32 } };
    store.putListing(candidate, oldAssessment, true);
    const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`changed-read-peer-${i}`, 6_000_000), assessment: assessment() }));
    const card = raw('changed-read-card', 4_000_000), reference = buildReference(card, assessment(), peers, store.getSettings()).reference;
    assert.ok(reference);
    store.setReference(candidate.id, reference, 'Old hardware interpretation');
    assert.equal(service.detail(candidate.id)?.assessment.profile.ramGb, 16);
    assert.equal(service.detail(candidate.id)?.valuation.reference, null);
    assert.match(service.detail(candidate.id)?.valuation.reason ?? '', /Hardware interpretation changed/);
    assert.equal(service.detail(candidate.id)?.valuation.opportunity, false);
  } finally { store.close(); }
});

test('pre-inference references are rejected even when only a comparable would change interpretation', () => {
  const store = new Store('',true),service = new FlipperService(store);
  try {
    const candidate = raw('unchanged-target',4_000_000,{category:'desktop',title:'PC i5-12400 RAM16GB DDR4 RTX3070 8GB GDDR6 SSD512GB NVMe'});
    const target = enrichComputerAssessment(candidate,assessWithRules(candidate));
    store.putListing(candidate,target,true);
    const peers = Array.from({length:5},(_,i)=>raw(`old-platform-peer-${i}`,6_000_000,{category:'desktop',title:candidate.title,description:'Motherboard socket AM4'}));
    assert.ok(peers.every(peer=>enrichComputerAssessment(peer,assessWithRules(peer)).eligibility==='review'));
    store.setReference(candidate.id,{policyVersion:3,kind:'configuration',label:'Old same-configuration reference',average:6_000_000,
      offers:peers.map(p=>({id:p.id,sellerId:p.sellerId!,title:p.title,price:p.price,url:p.url,region:p.region,observedAt:p.observedAt})),
      rejected:[],components:[],sampleCount:5,observedAt:new Date().toISOString(),min:6_000_000,max:6_000_000,methodology:'Pre-inference policy'},'Previously supported');
    assert.deepEqual(service.detail(candidate.id)?.assessment.profile,target.profile);
    assert.equal(service.detail(candidate.id)?.valuation.reference,null);
    assert.equal(service.detail(candidate.id)?.valuation.opportunity,false);
    assert.match(service.detail(candidate.id)?.valuation.reason??'',/current memory-type/);
  } finally {store.close();}
});

test('new references persist the enriched interpretation when unchanged listings retain an older AI assessment', async () => {
  for (const action of ['refresh', 'analyze'] as const) {
    const store = new Store('', true);
    store.saveSettings({ ...store.getSettings(), aiEnabled: false });
    const candidate = raw(`retained-ai-${action}`, 4_000_000, {
      title: 'RTX3070 8GB', description: 'Card RTX3070 8GB hoạt động tốt, chưa sửa chữa',
    });
    const retainedAi = { ...assessWithRules(candidate), method: 'ai' as const };
    assert.equal(retainedAi.profile.gpuMemoryType, null);
    assert.equal(retainedAi.memoryTypeSources, undefined);
    store.putListing(candidate, retainedAi, true);
    store.setState(candidate.id, { saved: true, costReserve: 300_000 });
    store.setCollection('gpu', '', [candidate.id]);
    const peers = Array.from({ length: 5 }, (_, i) => raw(`retained-ai-peer-${action}-${i}`, 6_000_000, {
      title: 'RTX3070 8GB', description: 'Card RTX3070 8GB hoạt động tốt, chưa sửa chữa',
    }));
    const current = enrichComputerAssessment(candidate, retainedAi);
    const initialReference = buildReference(candidate, current, peers.map((item) => ({ raw: item, assessment: enrichComputerAssessment(item, assessWithRules(item)) })), store.getSettings()).reference;
    assert.ok(initialReference);
    store.setReference(candidate.id, initialReference, 'Reference from a prior hardware interpretation');
    const service = new FlipperService(store, {
      async search(input) { return { items: input.location === 'danang' ? [candidate] : peers, total: input.location === 'danang' ? 1 : peers.length }; },
      async detail(item) { return item; },
    });
    try {
      assert.equal(service.detail(candidate.id)?.assessment.profile.gpuMemoryType, 'GDDR6');
      assert.equal(service.detail(candidate.id)?.valuation.reference, null);
      assert.match(service.detail(candidate.id)?.valuation.reason ?? '', /Hardware interpretation changed/);
      const job = action === 'refresh' ? service.refresh('gpu', '', 20) : service.analyze(candidate.id);
      assert.equal((await completed(service, job.id)).status, 'complete');
      assert.equal(service.getJob(job.id)?.benchmarked, 1);
      const recomputed = service.detail(candidate.id)!;
      assert.equal(recomputed.valuation.status, 'valued', action);
      assert.equal(recomputed.valuation.reference?.sampleCount, 5);
      assert.equal(recomputed.valuation.opportunity, true);
      assert.equal(recomputed.assessment.method, 'ai');
      assert.equal(store.getListing(candidate.id)?.assessment.profile.gpuMemoryType, 'GDDR6');
      assert.equal(store.getListing(candidate.id)?.assessment.memoryTypeSources?.[0]?.value, 'GDDR6');
      assert.equal(recomputed.state.saved, true);
      assert.equal(recomputed.state.costReserve, 300_000);
      assert.equal(store.history(candidate.id).length, 1);
    } finally { store.close(); }
  }
});

test('focused desktop analysis finds GPU-free peers by CPU and collects the standalone GPU without blocking missing base details', async () => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false });
  const baseDescription = 'CPU Intel Core i5-12400\nRAM 32GB DDR4\nSSD 512GB NVMe\nMáy hoạt động tốt, chưa sửa chữa';
  const candidate = raw('adjusted-local', 9_500_000, {
    category: 'desktop', title: 'PC i5-12400 RAM32GB RTX3070 8GB', description: `${baseDescription}\nVGA RTX3070 8GB`,
  });
  store.putListing(candidate, assessWithRules(candidate), true);
  store.setCollection('desktop', '', [candidate.id]);
  store.setState(candidate.id, { saved: true });
  const peers = Array.from({ length: 5 }, (_, i) => raw(`base-${i}`, 8_000_000 + i * 100_000, {
    category: 'desktop', title: 'PC i5-12400 RAM32GB không card rời', description: `${baseDescription}\nKhông có card đồ họa rời`,
  }));
  const cards = Array.from({ length: 5 }, (_, i) => raw(`card-${i}`, 4_800_000 + i * 100_000, {
    title: 'RTX3070 8GB', description: 'Bán 1 card RTX3070 8GB hoạt động tốt, chưa sửa chữa',
  }));
  const searches: Array<{ kind: string; query?: string }> = [];
  const service = new FlipperService(store, {
    async search(input) {
      searches.push({ kind: input.kind, query: input.query });
      const items = input.kind === 'desktop' ? peers : input.kind === 'gpu' ? cards : [];
      return { items, total: items.length };
    },
    async detail(item) { return item; },
  });
  try {
    const job = service.analyze(candidate.id);
    assert.equal((await completed(service, job.id)).status, 'complete');
    assert.deepEqual(searches[0], { kind: 'desktop', query: 'I5-12400' });
    assert.ok(searches.some((search) => search.kind === 'gpu' && search.query === 'RTX 3070 8gb'));
    const item = service.detail(candidate.id)!;
    assert.equal(item.valuation.reference?.kind, 'adjusted_configuration');
    assert.equal(item.valuation.reference?.average, 13_200_000);
    assert.equal(item.valuation.reference?.baseSampleCount, 5);
    assert.equal(item.valuation.status, 'valued');
    assert.equal(item.valuation.opportunity, true);
    assert.equal(item.valuation.resaleOpportunity, true);
    assert.equal(item.valuation.confidence, 'low');
    assert.ok(item.valuation.missingDetails?.some((detail) => /motherboard/i.test(detail)));
    assert.equal(item.state.saved, true);
    assert.equal(service.detail(candidate.id)?.history.length, 1);
    assert.equal(job.aiCostUsd, 0);
  } finally { store.close(); }
});

test('focused SSD adjustments search the advertised TB capacity and retain distinct GB configurations', async () => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false });
  const pc = (id: string, price: number, storage: string) => raw(id, price, {
    category: 'desktop', title: `PC i5-12400 RAM32GB ${storage}`,
    description: `CPU i5-12400\nRAM32GB DDR4\nSSD ${storage} NVMe\nKhông có card đồ họa rời\nMáy hoạt động tốt`,
  });
  const candidate = pc('ssd-local', 9_000_000, '1TB');
  store.putListing(candidate, assessWithRules(candidate), true);
  const peers = Array.from({ length: 5 }, (_, i) => pc(`ssd-base-${i}`, 8_000_000, '512GB'));
  const queries: string[] = [];
  const service = new FlipperService(store, {
    async search(input) {
      if (input.kind === 'desktop') return { items: peers, total: peers.length };
      if (input.kind !== 'ssd') return { items: [], total: 0 };
      queries.push(input.query ?? '');
      const tb = input.query === '1tb NVME SSD';
      const items = Array.from({ length: 5 }, (_, i) => raw(`ssd-${tb ? 'tb' : 'gb'}-${i}`, tb ? 1_200_000 : 600_000, {
        category: 'ssd', title: `SSD NVMe ${tb ? '1TB' : '512GB'}`, description: 'SSD đã sử dụng, hoạt động tốt',
      }));
      return { items, total: items.length };
    },
    async detail(item) { return item; },
  });
  try {
    assert.equal((await completed(service, service.analyze(candidate.id).id)).status, 'complete');
    assert.deepEqual(queries.sort(), ['1tb NVME SSD', '512gb NVME SSD']);
    const reference = service.detail(candidate.id)?.valuation.reference;
    assert.equal(reference?.kind, 'adjusted_configuration');
    assert.equal(reference?.average, 8_600_000);
    assert.equal(reference?.sampleCount, 5);
    assert.equal(reference?.adjustedOffers?.[0]?.adjustments.find((term) => term.operation === 'add')?.label, '1024 GB NVME SSD');
  } finally { store.close(); }
});

test('refreshing a nationwide evidence listing preserves its geography instead of promoting it to a local buying candidate', async () => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false });
  const candidate = raw('national-evidence-card', 5_000_000);
  store.putListing(candidate, assessWithRules(candidate), false);
  const peers = Array.from({ length: 5 }, (_, i) => raw(`national-evidence-peer-${i}`, 6_000_000));
  const service = new FlipperService(store, { async search() { return { items: peers, total: peers.length }; }, async detail(item) { return item; } });
  try {
    assert.equal((await completed(service, service.analyze(candidate.id).id)).status, 'complete');
    assert.equal(service.detail(candidate.id)?.valuation.status, 'valued');
    assert.equal(store.getListing(candidate.id)?.local, false);
    assert.equal(store.localListings('gpu').length, 0);
  } finally { store.close(); }
});

test('national computer detail budget reaches matching high-RAM PCs beyond cheaper low-RAM search results', async () => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: false });
  const pc = (id: string, ramGb: number) => raw(id, 10_000_000, {
    category: 'desktop', title: `PC i5-12400 RAM ${ramGb}GB DDR4 RTX3070 8GB SSD 512GB NVMe`, description: '',
  });
  const candidate = { ...pc('national-priority-local', 32), description: 'Máy hoạt động tốt, chưa sửa chữa' };
  store.putListing(candidate, assessWithRules(candidate), true);
  const peers = [...Array.from({ length: 20 }, (_, i) => pc(`low-ram-${i}`, 16)),
    ...Array.from({ length: 5 }, (_, i) => pc(`matching-ram-${i}`, 32))];
  const detailed: string[] = [];
  const service = new FlipperService(store, {
    async search(input) {
      if (input.kind !== 'desktop') return { items: [], total: 0 };
      const start = ((input.page ?? 1) - 1) * 20;
      return { items: peers.slice(start, start + 20), total: peers.length };
    },
    async detail(item) { detailed.push(item.id); return { ...item, description: 'Máy hoạt động tốt, chưa sửa chữa' }; },
  });
  try {
    assert.equal((await completed(service, service.analyze(candidate.id).id)).status, 'complete');
    assert.deepEqual(detailed.filter((id) => id !== candidate.id).slice(0, 5), peers.slice(20).map((peer) => peer.id));
    assert.equal(detailed.filter((id) => id !== candidate.id).length, 5, 'stop details once five matching independent offers support a price');
    assert.equal(service.detail(candidate.id)?.valuation.reference?.sampleCount, 5);
  } finally { store.close(); }
});

test('local HTTP settings validate economic gates, never return a key and reject external writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-settings-'));
  const originalKey = process.env.LITELLM_API_KEY;
  delete process.env.LITELLM_API_KEY;
  const store = new Store(directory, true), service = new FlipperService(store, { async search() { return { items: [], total: 0 }; }, async detail(item) { return item; } });
  const server = appServer(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const bootstrap = await (await fetch(base + '/api/bootstrap')).json() as Record<string,unknown>;
    assert.equal('liteLlmKey' in bootstrap, false);
    assert.equal('openRouterKey' in bootstrap, false);
    const invalid = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ minComparables: 4 }) });
    assert.equal(invalid.status, 400);
    const oversizedPool = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ benchmarkLimit: 61 }) });
    assert.equal(oversizedPool.status, 400);
    const forbidden = await fetch(base + '/api/settings', { method:'POST', headers: { 'content-type':'application/json', origin:'https://example.com' }, body: JSON.stringify({ discountPercent: 30 }) });
    assert.equal(forbidden.status, 403);
    const settings = await fetch(base + '/api/settings', { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ discountPercent: 0, costReserves: { gpu: 300_000 }, minRamGb: 32, minVramGb: 12, includeUnknownMemory: false, liteLlmKey: 'settings-gateway-fixture' }) });
    assert.equal(settings.status, 200); assert.equal(store.getSettings().discountPercent, 0);
    assert.equal(store.getSettings().costReserves.laptop, 500_000); assert.equal(store.getSettings().costReserves.gpu, 300_000);
    const saved = await settings.json() as { ai: { configured: boolean; keySource: string }; settings: Record<string, unknown> };
    assert.equal(saved.ai.configured, true);
    assert.equal(saved.settings.minRamGb, 32);
    assert.equal(saved.settings.minVramGb, 12);
    assert.equal(saved.settings.includeUnknownMemory, false);
    assert.equal(saved.ai.keySource, 'local');
    assert.equal(store.getKey(), 'settings-gateway-fixture');
    assert.equal('liteLlmKey' in saved.settings, false);
    assert.ok(!JSON.stringify(saved).includes('settings-gateway-fixture'));
    process.env.LITELLM_API_KEY = 'environment-gateway-fixture';
    assert.equal(service.bootstrap().ai.keySource, 'environment');
    assert.ok(!JSON.stringify(service.bootstrap()).includes('environment-gateway-fixture'));
    delete process.env.LITELLM_API_KEY;
    const removed = await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ liteLlmKey: '' }) });
    assert.equal(removed.status, 200);
    assert.equal(store.getKey(), '');
    assert.equal(service.bootstrap().ai.configured, false);
    const empty = await fetch(base + '/api/listings?category=gpu'); assert.equal(empty.status, 200);
    assert.equal((await empty.json() as { total: number }).total, 0);
    const invalidRam = await fetch(base + '/api/listings?category=laptop&minRamGb=oops');
    assert.equal(invalidRam.status, 400);
    for (const query of ['minRamGb=', 'minVramGb=oops', 'minVramGb=-1', 'minVramGb=8.5', 'minVramGb=4097', 'includeUnknownMemory=0', 'includeUnknownMemory=yes', 'includeUnknownMemory=']) {
      assert.equal((await fetch(base + '/api/listings?category=laptop&' + query)).status, 400, query);
    }
    for (const updates of [{ minRamGb: -1 }, { minVramGb: 4097 }, { minVramGb: 7.5 }, { minRamGb: '16' }, { includeUnknownMemory: 'false' }]) {
      assert.equal((await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates) })).status, 400, JSON.stringify(updates));
    }
    const invalidRefreshRam = await fetch(base + '/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'desktop', minRamGb: -1 }) });
    assert.equal(invalidRefreshRam.status, 400);
    for (const updates of [{ minVramGb: -1 }, { minVramGb: '8' }, { includeUnknownMemory: 'false' }]) {
      assert.equal((await fetch(base + '/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'desktop', ...updates }) })).status, 400);
    }
    const refresh = await fetch(base + '/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'desktop', minRamGb: 32 }) });
    assert.equal(refresh.status, 202);
    await completed(service, (await refresh.json() as { job: { id: string } }).job.id);
    const searchResponse = await fetch(base + '/api/searches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'RAM default', category: 'laptop', query: '' }) });
    assert.equal(searchResponse.status, 201);
    const defaultSearch = (await searchResponse.json() as { search: { minRamGb: number; minVramGb: number; includeUnknownMemory: boolean } }).search;
    assert.equal(defaultSearch.minRamGb, 32);
    assert.equal(defaultSearch.minVramGb, 12);
    assert.equal(defaultSearch.includeUnknownMemory, false);
    const explicitSearch = await fetch(base + '/api/searches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Any memory', category: 'desktop', query: '', minRamGb: 0, minVramGb: 0, includeUnknownMemory: true }) });
    assert.equal(explicitSearch.status, 201);
    const explicit = (await explicitSearch.json() as { search: { id: string } }).search;
    const stored = store.searches().find((item) => item.id === explicit.id)!;
    assert.equal(stored.minRamGb, 0);
    assert.equal(stored.minVramGb, 0);
    assert.equal(stored.includeUnknownMemory, true);
    for (const updates of [{ minRamGb: -1 }, { minVramGb: '8' }, { includeUnknownMemory: 'true' }]) {
      assert.equal((await fetch(base + '/api/searches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Invalid filters', category: 'desktop', query: '', ...updates }) })).status, 400);
    }
    for (const [id, ramGb, vramGb] of [['api-matching', 32, 12], ['api-below-defaults', 16, 8], ['api-unknown', null, null]] as const) {
      store.putListing(raw(id, 10_000_000, { category: 'desktop',
        title: `RTX 3060${vramGb === null ? '' : ` ${vramGb}GB`} ${ramGb === null ? '' : `RAM ${ramGb}GB`}` }),
        assessment({ ramGb, vramGb }, { kind: 'desktop', method: 'ai' }), true);
    }
    store.setCollection('desktop', '', ['api-matching', 'api-below-defaults', 'api-unknown']);
    const defaultFeed = await (await fetch(base + '/api/listings?category=desktop')).json() as { items: { id: string }[] };
    assert.deepEqual(defaultFeed.items.map((item) => item.id), ['api-matching']);
    const overrideFeed = await (await fetch(base + '/api/listings?category=desktop&minRamGb=16&minVramGb=8&includeUnknownMemory=true')).json() as { total: number };
    assert.equal(overrideFeed.total, 3);
    const anyKnownFeed = await (await fetch(base + '/api/listings?category=desktop&minRamGb=0&minVramGb=0&includeUnknownMemory=false')).json() as { total: number };
    assert.equal(anyKnownFeed.total, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())); store.close();
    if (originalKey === undefined) delete process.env.LITELLM_API_KEY; else process.env.LITELLM_API_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  }
});
