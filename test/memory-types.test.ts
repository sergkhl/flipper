import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWithRules } from '../server/hardware.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { MEMORY_TYPE_CATALOG_VERSION, sellerMemoryTypes } from '../server/memory-types.ts';
import { assessment, raw } from './helpers.ts';

test('seller memory facts follow observation and hardware-kind changes without sharing mutable results', () => {
  const item = raw('updated-memory', 8_000_000, { category: 'laptop', title: 'Laptop', description: 'RAM DDR4' });
  const initial = sellerMemoryTypes(item);
  initial.ramType[0]!.value = 'DDR2'; initial.ramType.push({ value: 'DDR3', quote: 'not seller evidence' });
  assert.deepEqual(sellerMemoryTypes(item).ramType.map((claim) => claim.value), ['DDR4']);
  item.description = 'RAM DDR5';
  assert.deepEqual(sellerMemoryTypes(item).ramType.map((claim) => claim.value), ['DDR5']);
  item.description = ''; item.params = { RAM: 'DDR3' };
  assert.deepEqual(sellerMemoryTypes(item).ramType.map((claim) => claim.value), ['DDR3']);
  item.params = {}; item.title = 'DDR4';
  assert.equal(sellerMemoryTypes(item, 'ram').ramType.length, 1);
  assert.equal(sellerMemoryTypes(item, 'gpu').gpuMemoryType.length, 1);
  assert.equal(sellerMemoryTypes(item, 'gpu').ramType.length, 0);
});

test('compact computer RAM and separate VRAM type lines keep their own capacities and generations', () => {
  const item = raw('compact', 10_000_000, { category: 'desktop',
    title: 'PC i5-12400 RTX3070 8GB RAM16GB DDR4 SSD512GB', description: 'VRAM GDDR6. Máy hoạt động tốt.' });
  const result = assessWithRules(item);
  assert.equal(result.profile.ramGb, 16); assert.equal(result.profile.vramGb, 8);
  assert.equal(result.profile.ramType, 'DDR4'); assert.equal(result.profile.gpuMemoryType, 'GDDR6');
  assert.ok(result.evidence.some((item) => item.field === 'ramType' && item.quote.includes('RAM16GB DDR4')));
  assert.ok(result.evidence.some((item) => item.field === 'gpuMemoryType' && item.quote.includes('VRAM GDDR6')));
  const legacy = assessWithRules(raw('legacy', 4_000_000, { category: 'desktop',
    title: 'PC i5-12400 VGA GT730 2GB DDR3 RAM16GB DDR4 SSD512GB' }));
  assert.equal(legacy.profile.ramGb, 16); assert.equal(legacy.profile.vramGb, 2);
  assert.equal(legacy.profile.ramType, 'DDR4'); assert.equal(legacy.profile.gpuMemoryType, 'DDR3');
  const card = assessWithRules(raw('standalone', 1_000_000, { title: 'GT730 2GB DDR3' }));
  assert.equal(card.profile.ramType, null); assert.equal(card.profile.gpuMemoryType, 'DDR3');
  const prefix = assessWithRules(raw('ram-prefix', 8_000_000, { category: 'desktop',
    title: 'PC i5-12400 RTX3070 8GB RAM DDR4 16GB SSD512GB' }));
  assert.equal(prefix.profile.ramGb, 16); assert.equal(prefix.profile.ramType, 'DDR4');
});

test('memory suffixes and known types survive an unknown capacity without fabricating gigabytes', () => {
  for (const type of ['DDR3L', 'DDR5', 'LPDDR4X', 'LPDDR5X']) {
    const item = raw(type, 8_000_000, { category: 'laptop', title: 'Laptop RAM ' + type, description: 'Dùng tốt' });
    const result = enrichComputerAssessment(item, assessWithRules(item));
    assert.equal(result.profile.ramType, type); assert.equal(result.profile.ramGb, null);
    assert.ok(result.evidence.some((item) => item.field === 'ramType' && item.quote.includes(type)));
  }
  const item = raw('type-only', 6_000_000, { title: 'RTX3080 GDDR6X', description: 'Card dùng tốt' });
  const result = assessWithRules(item);
  assert.equal(result.profile.gpuMemoryType, 'GDDR6X'); assert.equal(result.profile.vramGb, null);
  assert.ok(result.evidence.some((item) => item.field === 'gpuMemoryType'));
});

test('unlabelled capacity/type clauses and a type before the next RAM clause remain system RAM', () => {
  for (const description of ['CPU i5-12400\n16GB DDR4\nSSD512GB NVMe\nWithout discrete GPU',
    'RTX3070 8GB, DDR4 16GB RAM, SSD512GB', 'DDR4 16GB']) {
    const item = raw('clause-order', 8_000_000, { category: 'desktop', title: 'PC i5-12400', description });
    const result = enrichComputerAssessment(item, assessWithRules(item));
    assert.equal(result.profile.ramGb, 16, description); assert.equal(result.profile.ramType, 'DDR4', description);
    assert.ok(!result.evidence.some((source) => source.field === 'gpuMemoryType' && source.quote.includes('DDR4')), description);
    assert.equal(result.profile.gpuMemoryType, description.includes('RTX3070') ? 'GDDR6' : null, description);
  }
});

test('incompatible seller memory generations clear the field and remain reviewable across reparsing', () => {
  for (const [title, description, field] of [
    ['PC i5-12400 RAM16GB DDR4 SSD512GB', 'RAM16GB DDR5', 'ramType'],
    ['PC i5-12400 GTX1660 6GB GDDR5 RAM16GB DDR4 SSD512GB', 'VGA GTX1660 6GB GDDR6', 'gpuMemoryType'],
  ] as const) {
    const item = raw(field, 6_000_000, { category: 'desktop', title, description });
    const result = enrichComputerAssessment(item, assessWithRules(item));
    assert.equal(result.profile[field], null); assert.equal(result.eligibility, 'review');
    assert.ok(result.conflicts.some((note) => note.includes('generation')));
    assert.deepEqual(enrichComputerAssessment(item, result), result);
  }
});

test('manufacturer type lookup has source provenance and never establishes GPU capacity', () => {
  const item = raw('known-gpu', 6_000_000, { title: 'RTX3070', description: 'Card dùng tốt' });
  const result = enrichComputerAssessment(item, assessWithRules(item));
  assert.equal(result.profile.gpuMemoryType, 'GDDR6'); assert.equal(result.profile.vramGb, null);
  assert.deepEqual(result.memoryTypeSources, [{ field: 'gpuMemoryType', value: 'GDDR6', part: 'NVIDIA GeForce RTX 3070',
    url: 'https://www.nvidia.com/en-us/geforce/graphics-cards/compare/', catalogVersion: MEMORY_TYPE_CATALOG_VERSION }]);
  assert.ok(!result.evidence.some((item) => item.field === 'gpuMemoryType'));
  assert.deepEqual(enrichComputerAssessment(item, result), result);
});

test('unresolved GTX1650, RTX3060 Ti and RTX4070 variants do not collapse to one memory generation', () => {
  for (const gpu of ['GTX1650', 'RTX3060Ti', 'RTX4070']) {
    const item = raw(gpu, 5_000_000, { title: `${gpu} 8GB`, description: 'Card dùng tốt' });
    const result = enrichComputerAssessment(item, assessWithRules(item));
    assert.equal(result.profile.gpuMemoryType, null, gpu); assert.equal(result.memoryTypeSources, undefined, gpu);
  }
  const item = raw('g5', 2_000_000, { title: 'GTX1650 (G5) 4GB', description: 'Card dùng tốt' });
  const result = enrichComputerAssessment(item, assessWithRules(item));
  assert.equal(result.profile.gpuMemoryType, 'GDDR5'); assert.equal(result.eligibility, 'eligible');
  assert.equal(result.memoryTypeSources?.[0]?.catalogVersion, MEMORY_TYPE_CATALOG_VERSION);
});

test('exact motherboards and computer models can establish only RAM generation', () => {
  for (const [part, type] of [
    ['ASUS PRIME B660M-A D4', 'DDR4'], ['ASUS PRIME H610M-A WIFI', 'DDR5'],
    ['MSI MAG B760M MORTAR WIFI DDR4', 'DDR4'], ['Lenovo ThinkPad T480', 'DDR4'],
  ]) {
    const item = raw(part!, 8_000_000, { category: part!.includes('ThinkPad') ? 'laptop' : 'desktop',
      title: part!.includes('ThinkPad') ? part! : 'PC i5-12400', description: part!.includes('ThinkPad') ? 'Intel UHD 620' : `Motherboard ${part}` });
    const result = enrichComputerAssessment(item, assessWithRules(item));
    assert.equal(result.profile.ramType, type, part); assert.equal(result.profile.ramGb, null, part);
    assert.equal(result.memoryTypeSources?.find((source) => source.field === 'ramType')?.value, type, part);
    assert.ok(!result.evidence.some((source) => source.field === 'ramType'), part);
  }
  for (const description of ['CPU i5-12400, socket LGA1700', 'Mainboard ASUS B660', 'ASUS PRIME B660M-A', 'ThinkPad T480s']) {
    const item = raw('uncertain-board', 8_000_000, { category: 'desktop', title: 'PC', description });
    assert.equal(enrichComputerAssessment(item, assessWithRules(item)).profile.ramType, null, description);
  }
});

test('manufacturer contradictions remain conflicts instead of silently replacing seller claims', () => {
  for (const [title, description, field] of [
    ['PC i5-12400 RAM16GB DDR5', 'Motherboard ASUS PRIME B660M-A D4', 'ramType'],
    ['RTX3070 8GB GDDR5', 'Card dùng tốt', 'gpuMemoryType'],
  ] as const) {
    const item = raw(field, 8_000_000, { category: field === 'ramType' ? 'desktop' : 'gpu', title, description });
    const result = enrichComputerAssessment(item, assessWithRules(item));
    assert.equal(result.profile[field], null); assert.equal(result.eligibility, 'review');
    assert.ok(result.conflicts.some((note) => note.includes('manufacturer specifications') && note.includes('https://')));
    assert.equal(result.memoryTypeSources?.some((source) => source.field === field) ?? false, false);
    assert.ok(result.evidence.some((source) => source.field === field));
    assert.deepEqual(enrichComputerAssessment(item, result), result);
  }
});

test('direct seller generations retain source quotes rather than manufacturer provenance', () => {
  const item = raw('direct', 8_000_000, { category: 'desktop', title: 'PC i5-12400 RAM16GB DDR4 RTX3070 8GB GDDR6',
    description: 'Mainboard ASUS PRIME B660M-A D4' });
  const result = enrichComputerAssessment(item, assessWithRules(item));
  assert.equal(result.memoryTypeSources, undefined);
  assert.equal(result.evidence.filter((source) => source.field === 'ramType').length, 1);
  assert.equal(result.evidence.filter((source) => source.field === 'gpuMemoryType').length, 1);
});

test('desktop reference GPU types do not fill mobile GPUs or invent an optional discrete GPU', () => {
  const laptop = raw('mobile', 8_000_000, { category: 'laptop', title: 'Laptop RTX3070 RAM16GB SSD512GB', description: 'Dùng tốt' });
  assert.equal(enrichComputerAssessment(laptop, assessWithRules(laptop)).profile.gpuMemoryType, null);
  const t480 = raw('mx150', 8_000_000, { category: 'laptop', title: 'ThinkPad T480 i7-8650U MX150 RAM16GB SSD512GB', description: 'Dùng tốt' });
  const result = enrichComputerAssessment(t480, assessWithRules(t480));
  assert.equal(result.profile.gpuMemoryType, 'GDDR5'); assert.equal(result.profile.vramGb, null);
  assert.equal(result.memoryTypeSources?.find((source) => source.field === 'gpuMemoryType')?.part, 'Lenovo ThinkPad T480 with NVIDIA GeForce MX150');
  const integrated = { ...t480, title: 'ThinkPad T480 i7-8650U Intel UHD620 RAM16GB SSD512GB' };
  const onboard = enrichComputerAssessment(integrated, assessWithRules(integrated));
  assert.equal(onboard.profile.gpuClass, 'integrated'); assert.equal(onboard.profile.gpuMemoryType, null);
});

test('retained AI types and catalog metadata are recomputed without erasing unrelated assessment decisions', () => {
  const item = raw('retained', 8_000_000, { category: 'desktop', title: 'PC i5-12400 RTX3070 8GB RAM16GB DDR4' });
  const input = assessment({ gpu: 'RTX 3070', vramGb: 8, ramGb: 16, ramType: 'DDR3', gpuMemoryType: 'GDDR5' }, {
    kind: 'desktop', method: 'ai', eligibility: 'review', unknowns: ['Condition is uncertain'],
    conflicts: ['A separate asking-price conflict'], evidence: [{ field: 'ramType', quote: 'old stale quote' }],
    memoryTypeSources: [{ field: 'gpuMemoryType', value: 'GDDR5', part: 'Outdated part', url: 'https://example.test/old', catalogVersion: 'old' }],
  });
  const result = enrichComputerAssessment(item, input);
  assert.equal(result.profile.ramType, 'DDR4'); assert.equal(result.profile.gpuMemoryType, 'GDDR6');
  assert.deepEqual(result.unknowns, input.unknowns); assert.deepEqual(result.conflicts, input.conflicts);
  assert.equal(result.eligibility, 'review'); assert.equal(result.memoryTypeSources?.[0]?.catalogVersion, MEMORY_TYPE_CATALOG_VERSION);
  assert.ok(!result.evidence.some((source) => source.quote === 'old stale quote'));
  assert.equal(input.profile.ramType, 'DDR3'); assert.equal(input.memoryTypeSources?.[0]?.catalogVersion, 'old');
  assert.deepEqual(enrichComputerAssessment(item, result), result);
});

test('quoted GPU alternatives carry independent memory type provenance at their own inclusion state', () => {
  const item = raw('alternatives', 10_000_000, { category: 'desktop', title: 'PC i5-12400 RAM16GB RTX3070 8GB SSD512GB',
    description: 'Mainboard ASUS PRIME B660M-A D4\nGiá không kèm card: 10 triệu\nGiá cả bộ: 14 triệu' });
  const result = enrichComputerAssessment(item, assessWithRules(item));
  assert.equal(result.profile.gpuInclusion, 'absent'); assert.equal(result.profile.gpuMemoryType, null);
  assert.equal(result.profile.ramType, 'DDR4');
  const included = result.priceOptions?.find((option) => option.profile.gpuInclusion === 'included');
  const absent = result.priceOptions?.find((option) => option.profile.gpuInclusion === 'absent');
  assert.equal(included?.profile.ramType, 'DDR4'); assert.equal(included?.profile.gpuMemoryType, 'GDDR6');
  assert.deepEqual(included?.memoryTypeSources?.map((source) => source.field).sort(), ['gpuMemoryType', 'ramType']);
  assert.equal(absent?.profile.ramType, 'DDR4'); assert.equal(absent?.profile.gpuMemoryType, null); assert.equal(absent?.profile.vramGb, null);
  assert.deepEqual(absent?.memoryTypeSources?.map((source) => source.field), ['ramType']);
  assert.ok(included?.evidence.includes('Giá cả bộ')); assert.ok(absent?.evidence.includes('Giá không kèm card'));
  assert.deepEqual(enrichComputerAssessment(item, result), result);
});
