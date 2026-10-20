import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryTypeInference, PricedConfiguration } from '../shared/types.ts';
import { hasDedicatedVram, hasMemoryTypeEstimates, hasTechApiMemoryData, memoryDescription } from '../client/memory.ts';
import { assessment } from './helpers.ts';

function inference(updates: Partial<MemoryTypeInference> = {}): MemoryTypeInference {
  return { field: 'ramType', types: ['DDR4', 'DDR5'], basis: 'Intel Core i5-12400 supports both generations',
    manufacturerVerified: true, sources: [{ label: 'Intel specifications', url: 'https://www.intel.com/example' }],
    catalogVersion: 'test', ...updates };
}

test('seller-stated memory types remain direct even when compatible alternatives are available', () => {
  const item = assessment({ ramGb: 16, ramType: 'DDR4', gpuMemoryType: 'GDDR6' }, {
    memoryTypeInferences: [inference()],
  });
  assert.equal(memoryDescription(item.profile, 'ram', item), '16 GB DDR4');
  assert.equal(memoryDescription(item.profile, 'vram', item), '12 GB GDDR6');
});

test('manufacturer-derived memory types are labelled inferred and never create a capacity', () => {
  const item = assessment({ ramGb: 16, ramType: 'DDR4', vramGb: null, gpuMemoryType: 'GDDR6' }, {
    memoryTypeSources: [
      { field: 'ramType', value: 'DDR4', part: 'AMD AM4', url: 'https://www.amd.com/example', catalogVersion: 'test' },
      { field: 'gpuMemoryType', value: 'GDDR6', part: 'RTX 3070', url: 'https://www.nvidia.com/example', catalogVersion: 'test' },
    ],
  });
  assert.equal(memoryDescription(item.profile, 'ram', item), '16 GB DDR4 · inferred');
  assert.equal(memoryDescription(item.profile, 'vram', item), 'GDDR6 · capacity unknown · inferred');
  assert.equal(item.profile.vramGb, null);
  assert.equal(hasMemoryTypeEstimates(item), true);
});

test('complete manufacturer-supported alternatives remain possibilities with known or unknown capacity', () => {
  const item = assessment({ ramGb: 16, ramType: null }, { memoryTypeInferences: [inference()] });
  assert.equal(memoryDescription(item.profile, 'ram', item), '16 GB · possible DDR4 / DDR5');
  item.profile.ramGb = null;
  assert.equal(memoryDescription(item.profile, 'ram', item), 'Capacity unknown · possible DDR4 / DDR5');
  assert.equal(item.profile.ramType, null);
});

test('an external singleton is an unconfirmed possibility and cannot populate the profile type', () => {
  const item = assessment({ ramGb: 16, ramType: null }, {
    memoryTypeInferences: [inference({ types: ['DDR5'], manufacturerVerified: false,
      sources: [{ label: 'TechAPI', url: 'https://gettechapi.github.io/TechAPI/v1/cpus/example/index.json' }] })],
  });
  assert.equal(memoryDescription(item.profile, 'ram', item), '16 GB · possible DDR5 · unconfirmed');
  assert.equal(item.profile.ramType, null);
  assert.equal(hasTechApiMemoryData(item), true);
});

test('memory metadata applies to its own priced configuration rather than another seller option', () => {
  const ddr4: PricedConfiguration = { label: 'AM4', price: 8_000_000,
    profile: assessment({ ramGb: 16, ramType: 'DDR4' }).profile, evidence: 'Quoted option',
    memoryTypeInferences: [inference({ types: ['DDR4'], basis: 'AM4 platform' })] };
  const ddr5: PricedConfiguration = { label: 'AM5', price: 12_000_000,
    profile: assessment({ ramGb: 32, ramType: 'DDR5' }).profile, evidence: 'Quoted option',
    memoryTypeSources: [{ field: 'ramType', value: 'DDR5', part: 'AM5', url: 'https://www.amd.com/example', catalogVersion: 'test' }] };
  assert.equal(memoryDescription(ddr4.profile, 'ram', ddr4), '16 GB DDR4 · inferred');
  assert.equal(memoryDescription(ddr5.profile, 'ram', ddr5), '32 GB DDR5 · inferred');
  assert.equal(memoryDescription(ddr5.profile, 'ram'), '32 GB DDR5');
});

test('unknown memory stays explicit and mobile dedicated GPUs remain eligible for a VRAM description', () => {
  const profile = assessment({ ramGb: null, ramType: null, vramGb: null, gpuMemoryType: null, gpuClass: 'mobile' }).profile;
  assert.equal(memoryDescription(profile, 'ram'), 'Capacity / type unknown');
  assert.equal(memoryDescription(profile, 'vram'), 'Capacity / type unknown');
  assert.equal(hasDedicatedVram(profile), true);
  assert.equal(hasDedicatedVram({ ...profile, gpuClass: 'integrated' }), false);
  assert.equal(hasDedicatedVram({ ...profile, gpuInclusion: 'absent' }), false);
});

test('TechAPI attribution follows relevant metadata and is absent for manufacturer-only sources', () => {
  assert.equal(hasTechApiMemoryData({ memoryTypeInferences: [inference()] }), false);
  assert.equal(hasTechApiMemoryData({ memoryTypeSources: [{ field: 'ramType', value: 'DDR4', part: 'CPU',
    url: 'https://github.com/GetTechAPI/TechAPI/tree/develop/data', catalogVersion: 'test' }] }), true);
  assert.equal(hasTechApiMemoryData({ memoryTypeSources: [{ field: 'ramType', value: 'DDR4', part: 'CPU',
    url: 'https://gettechapi.github.io.example.com/TechAPI/', catalogVersion: 'test' }] }), false);
  assert.equal(hasMemoryTypeEstimates({ memoryTypeInferences: [inference({ types: [] })] }), false);
});
