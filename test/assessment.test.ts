import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAssessment } from '../server/assessment.ts';
import { assessWithRules } from '../server/hardware.ts';
import { assessment, raw } from './helpers.ts';

test('gift values do not conflict with the item price, while a different sale price still does', () => {
  const item = raw('gift', 7_900_000, { category: 'laptop', title: 'Dell Latitude 5490 i5-8250U RAM 16GB SSD 256GB',
    description: 'Máy cũ hoạt động tốt. Tặng ngay bộ quà tặng trị giá 650k. Giá bán: 7.900.000đ.' });
  const conflict = 'A stated cash price in the description differs from the displayed asking price';
  assert.ok(!assessWithRules(item).conflicts.includes(conflict));
  assert.ok(assessWithRules({ ...item, description: item.description + '\nGiá bán: 8.500.000đ.' }).conflicts.includes(conflict));
  const retained = { ...assessWithRules(item), method: 'ai' as const, eligibility: 'review' as const, conflicts: [conflict] };
  assert.ok(!reconcileAssessment(item, retained).conflicts.includes(conflict), 'retained parser flags are corrected offline');
});

test('an unambiguous single-card offer resolves an omitted AI quantity without changing bundle semantics', () => {
  const item = raw('single', 4_000_000), ai = assessment({ quantity: null }, { method: 'ai' });
  const result = reconcileAssessment(item, ai);
  assert.equal(result.profile.quantity, 1);
  assert.equal(result.eligibility, 'eligible');
  for (const description of ['Bán 2 card RTX 3060 12GB giá cả cặp.', 'A pair of cards RTX 3060 12GB.',
    'GPU bundle RTX 3060 12GB.', 'Two cards RTX 3060 12GB.', 'Combo RTX 3060 12GB and SSD 512GB.']) {
    const bundle = reconcileAssessment({ ...item, description }, ai);
    assert.equal(bundle.profile.quantity, null);
    assert.notEqual(bundle.eligibility, 'eligible');
  }
  assert.equal(reconcileAssessment(item, assessment({ quantity: null, priceBasis: 'bundle' }, { method: 'ai' })).profile.quantity, null);
  assert.equal(reconcileAssessment(item, { ...ai, eligibility: 'review' }).eligibility, 'review', 'an unexplained review decision is not cleared by filling quantity');
});

test('quoted local facts fill AI omissions, while conflicting identities and unsupported capacities stay unresolved', () => {
  const item = raw('facts', 4_000_000);
  const omitted = assessment({ gpu: null, gpuClass: null, vramGb: null, quantity: null }, {
    method: 'ai', eligibility: 'review', unknowns: ['gpu is not stated reliably.', 'vramGb has no verifiable supporting quote.'],
  });
  const resolved = reconcileAssessment(item, omitted);
  assert.equal(resolved.profile.gpu, 'RTX 3060'); assert.equal(resolved.profile.vramGb, 12);
  assert.equal(resolved.eligibility, 'eligible'); assert.deepEqual(resolved.unknowns, []);
  assert.ok(resolved.evidence.some(e => e.field === 'gpu' && e.quote.includes('RTX 3060')));
  const conflict = reconcileAssessment(item, assessment({ gpu: 'RTX 3070', vramGb: 8 }, { method: 'ai' }));
  assert.equal(conflict.eligibility, 'review'); assert.match(conflict.conflicts.join(';'), /disagree about gpu/);
  const noCapacity = reconcileAssessment({ ...item, title: 'RTX 3060', description: 'Used working graphics card' }, omitted);
  assert.equal(noCapacity.profile.vramGb, null); assert.equal(noCapacity.eligibility, 'review');
});

test('a longer source-backed laptop SKU is preserved and a generic CPU family can be refined from a quoted exact model', () => {
  const item = raw('precise-model', 8_000_000, { category: 'laptop',
    title: 'MSI Modern 14 B11MOU i5-1135G7 RAM 16GB SSD 512GB', description: 'Used working laptop' });
  const ai = assessment({ model: 'MSI Modern 14 B11MOU', cpu: 'Intel Core i5', gpu: null, gpuClass: null, vramGb: null,
    ramGb: 16, storageGb: 512 }, { method: 'ai', kind: 'laptop' });
  const result = reconcileAssessment(item, ai);
  assert.equal(result.profile.model, ai.profile.model);
  assert.equal(result.profile.cpu, 'I5-1135G7');
  assert.ok(!result.conflicts.some(note => /disagree about (?:model|cpu)/.test(note)));
});
