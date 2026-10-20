import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichComputerAssessment } from '../server/computer.ts';
import { enrichMemoryTypes } from '../server/memory-types.ts';
import { PLATFORM_CONFLICT } from '../server/memory-inference.ts';
import type { MemoryTypeLookup, TechMemoryRecord } from '../server/techapi.ts';
import { raw, assessment } from './helpers.ts';

function cache(records: TechMemoryRecord[]): MemoryTypeLookup {
  return { get: (kind,model,gpuClass) => records.filter(r => r.kind === kind && r.name === model && (kind !== 'gpu' || r.gpuClass === gpuClass)) };
}
function record(name: string, types: string[], kind: 'cpu'|'gpu' = 'cpu', gpuClass: 'desktop'|'mobile'|null = null): TechMemoryRecord {
  return { kind,name,types,gpuClass,socket:null,url:`https://gettechapi.github.io/TechAPI/v1/${kind}s/example/index.json`,sourceUrls:[],fetchedAt:'2026-10-14T00:00:00.000Z' };
}
function computer(description: string, title = 'PC RAM16GB SSD512GB') {
  const item = raw('computer',8_000_000,{category:'desktop',title,description});
  return enrichComputerAssessment(item,assessment({cpu:null,ramGb:16,gpu:null,gpuClass:'integrated',vramGb:null},{kind:'desktop'}));
}

test('explicit AM4/AM5 infer only generation and preserve unknown capacity and integrated VRAM', () => {
  for (const [socket,type] of [['AM4','DDR4'],['AM5','DDR5']]) {
    const result = computer(`Motherboard socket ${socket}`,'PC Intel UHD620 SSD512GB');
    assert.equal(result.profile.ramType,type); assert.equal(result.profile.ramGb,null);
    assert.equal(result.profile.vramGb,null); assert.equal(result.profile.gpuMemoryType,null);
    assert.equal(result.memoryTypeInferences?.find(i => i.field === 'ramType')?.manufacturerVerified,true);
    assert.ok(!result.evidence.some(e => e.field === 'ramType'));
  }
});

test('known CPU infers a unique manufacturer-backed generation, while LGA1700 keeps both alternatives', () => {
  const single = computer('CPU i5-11400F RAM16GB SSD512GB');
  assert.equal(single.profile.ramType,'DDR4');
  assert.ok(single.memoryTypeSources?.some(s => s.field === 'ramType' && s.url.includes('intel.com')));
  const dual = computer('CPU i5-12400F socket LGA1700 RAM16GB SSD512GB');
  assert.equal(dual.profile.ramType,null);
  assert.deepEqual(dual.memoryTypeInferences?.find(i => i.field === 'ramType')?.types,['DDR4','DDR5']);
  assert.deepEqual(computer('Cooler supports AM4 and AM5').memoryTypeInferences,undefined);
  assert.equal(computer('Motherboard socket LGA1151').profile.ramType,null);
});

test('CPU and explicit socket disagreement stays reviewable without an actionable inferred type', () => {
  const result = computer('CPU i5-12400F, socket AM4 RAM16GB SSD512GB');
  assert.ok(result.conflicts.includes(PLATFORM_CONFLICT)); assert.equal(result.eligibility,'review');
  assert.equal(result.profile.ramType,null); assert.equal(result.memoryTypeInferences?.some(i => i.field === 'ramType') ?? false,false);
});

test('socket-only promotion cannot override an unreviewed CPU identity or contradictory cached socket', () => {
  const intel = computer('Motherboard socket AM5 RAM16GB SSD512GB','PC i7-8700 RAM16GB SSD512GB');
  assert.equal(intel.profile.ramType,null); assert.ok(intel.conflicts.includes(PLATFORM_CONFLICT));
  const item = raw('unreviewed-amd',8_000_000,{category:'desktop',title:'PC Ryzen 5 5600 RAM16GB SSD512GB',description:'Motherboard socket AM5'});
  const cpu = {...record('RYZEN 5 5600',['DDR4']),socket:'AM4'};
  const result = enrichMemoryTypes(item,assessment({cpu:'RYZEN 5 5600',ramGb:16},{kind:'desktop'}),cache([cpu]));
  assert.equal(result.profile.ramType,null); assert.ok(result.conflicts.includes(PLATFORM_CONFLICT));
  const unresolved = enrichMemoryTypes(item,assessment({cpu:'RYZEN 5 5600',ramGb:16},{kind:'desktop'}));
  assert.equal(unresolved.profile.ramType,null);
  assert.equal(unresolved.memoryTypeInferences?.find(i=>i.field==='ramType')?.manufacturerVerified,false);
});

test('incompatible CPU/board and seller/platform claims remain conflicts', () => {
  const board = computer('CPU Ryzen 5 5600X, Motherboard ASUS PRIME H610M-A WIFI RAM16GB SSD512GB');
  assert.equal(board.profile.ramType,null); assert.ok(board.conflicts.some(c => c.includes('motherboard and CPU')));
  const seller = computer('CPU i5-11400F RAM16GB DDR5 SSD512GB');
  assert.equal(seller.profile.ramType,null); assert.ok(seller.conflicts.some(c => c.includes('manufacturer specifications')));
  const direct = computer('CPU i5-12400F RAM16GB DDR4 SSD512GB');
  assert.equal(direct.profile.ramType,'DDR4');
  assert.equal(direct.memoryTypeInferences?.some(i => i.field === 'ramType') ?? false,false);
});

test('manufacturer completeness corrects the cached i7-12700H omission without choosing a generation', () => {
  const item = raw('mobile',8_000_000,{category:'laptop',title:'Laptop i7-12700H RAM16GB SSD512GB'});
  const result = enrichMemoryTypes(item,assessment({cpu:'I7-12700H',ramGb:16},{kind:'laptop'}),cache([record('I7-12700H',['DDR5','LPDDR5'])]));
  const inferred = result.memoryTypeInferences!.find(i => i.field === 'ramType')!;
  assert.deepEqual(inferred.types,['DDR4','DDR5','LPDDR4X','LPDDR5']); assert.equal(result.profile.ramType,null);
  assert.equal(inferred.manufacturerVerified,true); assert.ok(inferred.sources.some(s => s.label === 'TechAPI'));
});

test('unverified cached singleton is an unconfirmed hint and cannot clear required specification checks', () => {
  const item = raw('hint',8_000_000,{category:'laptop',title:'Laptop i5-13420H RAM16GB SSD512GB'});
  const input = assessment({cpu:'I5-13420H',ramGb:16,ramType:null},{kind:'laptop',eligibility:'review',unknowns:['ramType is not stated reliably.']});
  const result = enrichMemoryTypes(item,input,cache([record('I5-13420H',['DDR5'])]));
  assert.equal(result.profile.ramType,null); assert.equal(result.eligibility,'review');
  assert.deepEqual(result.unknowns,input.unknowns);
  assert.equal(result.memoryTypeInferences?.find(i => i.field === 'ramType')?.manufacturerVerified,false);
  const direct = enrichMemoryTypes({...item,title:'Laptop i5-13420H RAM16GB DDR4 SSD512GB'},input,cache([record('I5-13420H',['DDR5'])]));
  assert.equal(direct.profile.ramType,'DDR4'); assert.equal(direct.conflicts.length,0);
});

test('manufacturer GPU alternatives survive an incomplete cached default record', () => {
  const item = raw('gpu',5_000_000,{title:'RTX3060Ti 8GB'});
  const result = enrichMemoryTypes(item,assessment({gpu:'RTX 3060 TI',vramGb:8}),cache([record('RTX 3060 TI',['GDDR6'],'gpu','desktop')]));
  assert.equal(result.profile.gpuMemoryType,null);
  assert.deepEqual(result.memoryTypeInferences?.find(i => i.field === 'gpuMemoryType')?.types,['GDDR6','GDDR6X']);
});

test('RTX3070Ti desktop and laptop types stay distinct and never establish VRAM capacity', () => {
  for (const [gpuClass,type] of [['desktop','GDDR6X'],['mobile','GDDR6']] as const) {
    const item = raw('gpu',8_000_000,{category:gpuClass==='mobile'?'laptop':'gpu',title:'RTX3070Ti'});
    const result = enrichMemoryTypes(item,assessment({gpu:'RTX 3070 TI',gpuClass,vramGb:null},{kind:gpuClass==='mobile'?'laptop':'gpu'}));
    assert.equal(result.profile.gpuMemoryType,type); assert.equal(result.profile.vramGb,null);
  }
});

test('inferences are recomputed on reads and preserve unrelated AI risks and decisions', () => {
  const item = raw('retained',8_000_000,{category:'desktop',title:'PC i5-11400F RAM16GB SSD512GB'});
  const input = assessment({cpu:'I5-11400F',ramGb:16},{kind:'desktop',method:'ai',eligibility:'review',unknowns:['Condition not verified'],risks:['unrelated risk']});
  const once = enrichMemoryTypes(item,input), twice = enrichMemoryTypes(item,once);
  assert.deepEqual(twice,once); assert.deepEqual(once.unknowns,input.unknowns); assert.deepEqual(once.risks,input.risks);
  assert.equal(input.profile.ramType,null); assert.equal(once.profile.ramType,'DDR4');
});
