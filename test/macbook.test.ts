import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWithRules, profileKey } from '../server/hardware.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { configurationsMatch } from '../server/pricing.ts';
import type { MemoryTypeLookup, TechLaptopRecord } from '../server/techapi.ts';
import { raw } from './helpers.ts';

const laptop = (title:string,description='',params:Record<string,string>={}) => raw('mac',20_000_000,{category:'laptop',title,description,params});

test('compact screen and CPU/GPU notation yields a source-backed MacBook identity',()=>{
  const a=assessWithRules(laptop('Macbook Pro 14inch: M2 Pro/16GB/512GB LikeNew','M2 Pro (10CPU/16GPU) • RAM 16GB • SSD 512GB'));
  assert.equal(a.profile.model,'MACBOOK PRO 14');
  assert.equal(a.profile.cpu,'APPLE M2 PRO'); assert.equal(a.profile.screenInches,14);
  assert.equal(a.profile.cpuCores,10); assert.equal(a.profile.gpuCores,16);
  assert.equal(a.profile.gpu,'APPLE M2 PRO 16-CORE INTEGRATED');
  assert.equal(a.profile.ramGb,16); assert.equal(a.profile.storageGb,512);
  assert.equal(a.eligibility,'eligible'); assert.equal(a.profile.vramGb,null);
});

test('styled seller text and 32GPU keep the chip tier, actual screen and memory distinct',()=>{
  const a=assessWithRules(laptop('Macbook Pro 16inch M1 Max (32GPU)/Ram 32GB/SSD 1TB','𝐌𝐚𝐜𝐁𝐨𝐨𝐤 𝐏𝐫𝐨 𝟏𝟔𝐢𝐧𝐜𝐡 𝟐𝟎𝟐𝟏\n𝐌𝟏 𝐌𝐚𝐱 𝟑𝟐𝐆𝐏𝐔– 𝐑𝐚𝐦 𝟑𝟐𝐆𝐁/𝐒𝐒𝐃 𝟏𝐓𝐁'));
  assert.equal(a.profile.model,'MACBOOK PRO 16');assert.equal(a.profile.modelYear,2021);
  assert.equal(a.profile.cpu,'APPLE M1 MAX');assert.equal(a.profile.gpuCores,32);
  assert.equal(a.profile.ramGb,32);assert.equal(a.profile.storageGb,1024);assert.equal(a.eligibility,'eligible');
});

test('Apple integrated graphics remain visible when the core-count variant is not stated',()=>{
  const item=laptop('Apple MacBook Air M4 16GB/256GB Midnight','Chip Apple M4\nRAM 16GB\nSSD 256GB');
  const a=enrichComputerAssessment(item,assessWithRules(item));
  assert.equal(a.eligibility,'eligible'); assert.equal(a.profile.gpuClass,'integrated');
  assert.equal(a.profile.gpuInclusion,'absent'); assert.equal(a.profile.gpu,'APPLE M4 INTEGRATED');
  assert.equal(a.profile.gpuCores,null); assert.equal(a.profile.vramGb,null);
  assert.ok(a.computer?.missing.includes('GPU core-count variant'));
  assert.equal(a.unknowns.includes('Apple GPU core-count variant is not verified'),false);
});

test('structured exact storage is usable but ranges and contradictory claims cannot fill a capacity',()=>{
  const exact=assessWithRules(laptop('MacBook Air M4 RAM16GB','Chip Apple M4',{pc_drive_capacity:'256 GB',pc_drive_type:'SSD'}));
  assert.equal(exact.profile.storageGb,256);
  const range=assessWithRules(laptop('MacBook Air M4 RAM16GB','Chip Apple M4',{pc_drive_capacity:'Dưới 256 GB'}));
  assert.equal(range.profile.storageGb,null);
  const conflict=assessWithRules(laptop('MacBook Pro 14inch M1 Pro 32GB/1TB','RAM32GB SSD1TB',{pc_drive_capacity:'512 GB'}));
  assert.equal(conflict.eligibility,'review');assert.ok(conflict.conflicts.includes('Description and structured storage capacity disagree'));
});

test('memory and storage shorthand stays seller evidence and preserves configuration ambiguity',()=>{
  const a=assessWithRules(laptop('Macbook Air 13.6inch: Chip M2/8/256-Gray'));
  assert.equal(a.profile.ramGb,8); assert.equal(a.profile.storageGb,256);assert.equal(a.profile.screenInches,13.6);
  const mixed=assessWithRules(laptop('MacBook Air M2 16GB/512GB','Also MacBook Air M2 8GB/256GB'));
  assert.equal(mixed.eligibility,'review');assert.equal(mixed.profile.ramGb,null);assert.equal(mixed.profile.storageGb,null);
});

test('GPU capacities and warranty dates cannot become core counts or model years',()=>{
  const a=assessWithRules(laptop('MacBook Air M3 15.3 inch 16GB/512GB BH 03/2028','GPU 8GB shared\nRAM16GB SSD512GB'));
  assert.equal(a.profile.modelYear,null);assert.equal(a.profile.gpuCores,null);assert.equal(a.profile.screenInches,15.3);
});

test('incompatible screens and Apple bins retain review status',()=>{
  for(const description of ['MacBook Pro 14inch and MacBook Pro 16inch M1 Pro RAM16GB SSD512GB','M1 Pro 14GPU or 16GPU RAM16GB SSD512GB']) {
    const a=assessWithRules(laptop('MacBook Pro M1 Pro RAM16GB SSD512GB',description));
    assert.equal(a.eligibility,'review');assert.ok(a.conflicts.length);
  }
});

test('retained Apple GPU parser warnings retire, while cash-price and repair flags survive',()=>{
  const item=laptop('Macbook Pro 14inch M2 Pro 16GB/512GB','10CPU/16GPU RAM16GB SSD512GB');
  const old={...assessWithRules(item),eligibility:'review' as const,unknowns:['Apple GPU core-count variant is not verified','Exact laptop model, processor, GPU, RAM and storage must be known']};
  const refreshed=enrichComputerAssessment(item,old);
  assert.equal(refreshed.eligibility,'eligible');assert.equal(refreshed.unknowns.length,0);
  const conflicted=enrichComputerAssessment(item,{...old,conflicts:['A stated cash price in the description differs from the displayed asking price']});
  assert.equal(conflicted.eligibility,'review');assert.equal(conflicted.conflicts.length,1);
  const excluded=enrichComputerAssessment(item,{...old,eligibility:'excluded',risks:['Damaged item']});
  assert.equal(excluded.eligibility,'excluded');assert.ok(excluded.risks.includes('Damaged item'));
});

test('laptop catalog data is offline context and cannot fill installed capacities or matching identity',()=>{
  const item=laptop('MacBook Air M4','Chip Apple M4');
  const reference:TechLaptopRecord={name:'MacBook Air 2025 M4 16GB 256GB',cpu:'Apple M4',gpu:'8-core GPU',modelYear:2025,screenInches:13.6,cpuCores:10,gpuCores:8,ramGb:16,storageGb:256,ramType:'LPDDR5X',url:'https://gettechapi.github.io/TechAPI/v1/laptops/example/index.json',sourceUrls:['https://support.apple.com/en-us/122209'],fetchedAt:new Date().toISOString()};
  const cache:MemoryTypeLookup={get:()=>[],getLaptops:()=>[reference]};
  const a=enrichComputerAssessment(item,assessWithRules(item),cache);
  assert.equal(a.profile.ramGb,null);assert.equal(a.profile.storageGb,null);assert.equal(a.profile.gpuCores,null);assert.equal(a.profile.screenInches,null);
  assert.equal(a.profile.ramType,null);assert.equal(a.laptopSpecReferences?.length,1);assert.equal(a.eligibility,'review');
});

test('different stated Mac sizes and core bins have different cohort identities',()=>{
  const a=assessWithRules(laptop('MacBook Pro 14inch M1 Pro RAM16GB SSD512GB','14GPU'));
  const b=assessWithRules(laptop('MacBook Pro 16inch M1 Pro RAM16GB SSD512GB','16GPU'));
  assert.notEqual(profileKey(a.profile,'laptop'),profileKey(b.profile,'laptop'));
});

test('compact Apple chip tiers canonicalize without erasing a real base-versus-Pro conflict',()=>{
  const item=laptop('MacBook Pro 14inch M2Pro 16GB/512GB','M2 Pro 10CPU/16GPU RAM16GB SSD512GB');
  assert.equal(assessWithRules(item).profile.cpu,'APPLE M2 PRO');
  const conflict=assessWithRules({...item,description:'M2 chip RAM16GB SSD512GB'});
  assert.equal(conflict.eligibility,'review');
  assert.ok(conflict.conflicts.includes('More than one processor model is advertised'));
});

test('conflicting MacBook families and every structured screen claim stay in review',()=>{
  const title='MacBook Pro 14 M2 Pro RAM16GB SSD512GB',description='M2 Pro 10CPU/16GPU';
  const variants: Record<string,string>[] = [{pc_model:'MacBook Air 14'}, {pc_model:'MacBook Pro 16'},
    {pc_model:'MacBook Pro 16inch'}, {pc_screen_size:'16'}];
  for(const params of variants) {
    const a=assessWithRules(laptop(title,description,params));
    assert.equal(a.eligibility,'review',JSON.stringify(params));
    assert.ok(a.conflicts.some(note=>/Several MacBook (?:families|screen sizes)/.test(note)));
  }
  const a=assessWithRules(laptop('MacBook Pro 13 M2 16GB/512GB','MacBook Air 13.6inch M2 2022 8CPU/10GPU RAM16GB SSD512GB'));
  assert.equal(a.eligibility,'review');assert.equal(a.profile.model,null);
  assert.ok(a.conflicts.includes('Several MacBook families are advertised'));
  const numeric=assessWithRules(laptop('MacBook Air M2 RAM16GB SSD512GB','M2 8CPU/10GPU',{pc_screen_size:'13.6'}));
  assert.equal(numeric.profile.screenInches,13.6);
  assert.ok(numeric.evidence.some(entry=>entry.field==='screenInches' && entry.quote==='pc_screen_size: 13.6'));
});

test('compact SSD labels support exact MacBook comparisons and core quotes describe their field',()=>{
  const a=assessWithRules(laptop('MacBook Pro 14 M2 Pro RAM16GB SSD512GB','CPU 10 cores\nGPU 16 cores'));
  assert.equal(a.profile.storageType,'SSD');assert.equal(configurationsMatch('laptop',a.profile,a.profile),true);
  assert.equal(a.evidence.find(entry=>entry.field==='gpuCores')?.quote,'GPU 16 cores');
});
