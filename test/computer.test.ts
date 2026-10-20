import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichComputerAssessment, expandPricedConfigurations } from '../server/computer.ts';
import { assessWithRules } from '../server/hardware.ts';
import { assessment, raw } from './helpers.ts';

function pricedPc(price = 21_000_000, suffix = '') {
  return raw('135055528', price, { category: 'desktop', title: 'PC i5-13500 RX 6600 XT SSD 1TB RAM 32GB',
    description: '* MSI B760M Mortar DDR4\n* PSU 750W Bronze\n* Case MIK LV07\n* Tản AIO Frozen Notte 360\n* VGA RX 6600 XT Challenger Pro 8GB\n- Giá bán cả bộ: 24 triệu\n- Giá bán không kèm card đồ họa: 21 triệu.' + suffix,
  });
}

test('the displayed GPU-free asking price selects the GPU-free profile and preserves the complete-PC alternative', () => {
  const source = pricedPc(), parsed = assessWithRules(source);
  const current = enrichComputerAssessment(source, parsed);
  assert.equal(current.profile.gpuInclusion, 'absent'); assert.equal(current.profile.gpu, null); assert.equal(current.profile.vramGb, null);
  assert.equal(current.profile.cpu, 'I5-13500'); assert.equal(current.profile.ramGb, 32); assert.equal(current.eligibility, 'eligible');
  assert.deepEqual(current.priceOptions?.map((option) => [option.price, option.profile.gpu, option.profile.gpuInclusion]), [
    [24_000_000, 'RX 6600 XT', 'included'], [21_000_000, null, 'absent'],
  ]);
  assert.deepEqual(enrichComputerAssessment(source, current), current);
  const variants = expandPricedConfigurations(source, current);
  assert.equal(variants.length, 2);
  for (const variant of variants) {
    assert.equal(variant.raw.id, source.id); assert.equal(variant.raw.sellerId, source.sellerId);
    assert.equal(variant.raw.observedAt, source.observedAt); assert.equal(variant.raw.description, source.description);
    assert.equal(variant.raw.price === 24_000_000 ? variant.assessment.profile.gpu : null, variant.assessment.profile.gpu);
    assert.deepEqual(enrichComputerAssessment(variant.raw, variant.assessment), variant.assessment);
  }
  assert.equal(variants.find((variant) => variant.raw.price === 24_000_000)!.assessment.profile.vramGb, 8);
  assert.equal(parsed.profile.gpu, 'RX 6600 XT', 'the caller assessment is not mutated');
});

test('unmatched and ambiguous displayed configuration prices remain reviewable', () => {
  const wrongPrice = pricedPc(23_000_000);
  const unresolved = enrichComputerAssessment(wrongPrice, assessWithRules(wrongPrice));
  assert.equal(unresolved.eligibility, 'review'); assert.equal(unresolved.profile.gpuInclusion, 'unknown');
  assert.match(unresolved.conflicts.join(' '), /Displayed asking price/);
  assert.equal(expandPricedConfigurations(wrongPrice, unresolved).length, 1);
  const ambiguous = pricedPc(21_000_000, '\nGiá có VGA: 21 triệu');
  assert.equal(enrichComputerAssessment(ambiguous, assessWithRules(ambiguous)).eligibility, 'review');
});

test('fully accounted GPU options can resolve AI ambiguity flags but an unexplained third price cannot', () => {
  const source = pricedPc();
  const ai = { ...assessWithRules(source), method: 'ai' as const, eligibility: 'review' as const,
    conflicts: ['Offered configuration or price is ambiguous.'], risks: ['multiPrice'] };
  const current = enrichComputerAssessment(source, ai);
  assert.equal(current.eligibility, 'eligible'); assert.deepEqual(current.conflicts, []); assert.deepEqual(current.risks, []);
  assert.equal(current.profile.gpuInclusion, 'absent');
  const thirdPrice = pricedPc(21_000_000, '\nGiá cấu hình khác: 27 triệu');
  const unresolved = enrichComputerAssessment(thirdPrice, ai);
  assert.equal(unresolved.eligibility, 'review'); assert.deepEqual(unresolved.risks, ['multiPrice']);
  assert.deepEqual(unresolved.conflicts, ['Offered configuration or price is ambiguous.']);
});

test('resolving GPU options cannot erase item damage, invalid prices, or unrelated hardware conflicts', () => {
  const damaged = pricedPc(21_000_000, '\nMáy đang bán bị lỗi, không lên hình.');
  const excluded = enrichComputerAssessment(damaged, assessWithRules(damaged));
  assert.equal(excluded.eligibility, 'excluded'); assert.match(excluded.risks.join(' '), /damage/);
  const invalid = { ...pricedPc(), attributes: { price_available: false } };
  assert.equal(enrichComputerAssessment(invalid, assessWithRules(invalid)).eligibility, 'review');
  const source = pricedPc();
  const conflicted = { ...assessWithRules(source), method: 'ai' as const, eligibility: 'review' as const,
    conflicts: ['A stated cash price in the description differs from the displayed asking price', 'RAM total and stick layout disagree'] };
  const enriched = enrichComputerAssessment(source, conflicted);
  assert.deepEqual(enriched.conflicts, ['RAM total and stick layout disagree']);
  assert.equal(enriched.eligibility, 'review');
  const retainedRulesConflict = enrichComputerAssessment(source, { ...conflicted, method: 'rules' });
  assert.deepEqual(retainedRulesConflict.conflicts, ['RAM total and stick layout disagree']);
  assert.equal(retainedRulesConflict.eligibility, 'review');
});

test('missing GPU information is distinct from explicit absence and onboard-only graphics', () => {
  const unknown = raw('unknown', 5_000_000, { category: 'desktop', title: 'PC i5-12400 RAM32GB SSD512GB', description: 'Máy dùng tốt' });
  assert.equal(enrichComputerAssessment(unknown, assessWithRules(unknown)).profile.gpuInclusion, 'unknown');
  const absent = { ...unknown, description: 'Giá bán không kèm card đồ họa' };
  const absentAssessment = enrichComputerAssessment(absent, assessWithRules(absent));
  assert.equal(absentAssessment.profile.gpuInclusion, 'absent');
  const onboard = { ...unknown, description: 'Chỉ dùng onboard' };
  assert.equal(enrichComputerAssessment(onboard, assessWithRules(onboard)).profile.gpuInclusion, 'absent');
  const optional = { ...unknown, title: `${unknown.title} RTX3070 8GB`, description: 'Tùy cấu hình, không kèm card hoặc thêm VGA' };
  assert.equal(enrichComputerAssessment(optional, assessWithRules(optional)).eligibility, 'review');
});

test('explicit desktop integrated graphics retain an absent discrete-GPU profile and no dedicated memory', () => {
  for (const graphics of ['Intel UHD 730', 'Intel Iris Xe Graphics', 'Radeon Vega 8', 'Chỉ dùng onboard', 'Integrated graphics only']) {
    const item = raw('onboard-desktop', 6_000_000, { category: 'desktop', title: 'PC i5-12400 RAM16GB DDR4 SSD512GB', description: graphics });
    const result = enrichComputerAssessment(item, assessWithRules(item));
    assert.equal(result.profile.gpuClass, 'integrated', graphics);
    assert.equal(result.profile.gpuInclusion, 'absent', graphics);
    assert.equal(result.profile.vramGb, null, graphics); assert.equal(result.profile.gpuMemoryType, null, graphics);
  }
});

test('base metadata is quoted from the listing and missing details do not block eligibility', () => {
  const source = pricedPc(); const current = enrichComputerAssessment(source, assessWithRules(source));
  assert.equal(current.computer?.motherboard, '* MSI B760M Mortar DDR4');
  assert.equal(current.computer?.psu, '* PSU 750W Bronze');
  assert.equal(current.computer?.case, '* Case MIK LV07');
  assert.equal(current.computer?.cooling, '* Tản AIO Frozen Notte 360');
  assert.equal(current.computer?.formFactor, null, 'an AIO cooler is not an all-in-one computer');
  assert.equal(current.computer?.cpuCount, null, 'a single named CPU does not prove its count');
  assert.ok(current.computer?.missing.includes('Desktop form factor')); assert.equal(current.eligibility, 'eligible');
  for (const item of current.computer!.evidence) assert.ok(source.description.includes(item.quote));
  const dual = raw('dual', 8_000_000, { category: 'desktop', title: 'Dual Xeon E5-2680 V4 RAM64GB ECC REG', description: 'Case tower, không VGA' });
  const dualAssessment = enrichComputerAssessment(dual, assessWithRules(dual));
  assert.equal(dualAssessment.computer?.cpuCount, 2); assert.equal(dualAssessment.computer?.ramEcc, 'registered');
});

test('optional AI base unknowns are visible but nonblocking, while essential unknowns survive', () => {
  const source = raw('ai-pc', 10_000_000, { category: 'desktop', title: 'PC i5-12400 RAM32GB RTX3070 8GB SSD512GB', description: 'Máy dùng tốt' });
  const ai = assessment({ cpu: 'I5-12400', gpu: 'RTX 3070', vramGb: 8, ramGb: 32, storageGb: 512 }, {
    kind: 'desktop', method: 'ai', eligibility: 'review', unknowns: ['Motherboard and PSU are not documented'],
  });
  const current = enrichComputerAssessment(source, ai);
  assert.equal(current.eligibility, 'eligible'); assert.deepEqual(current.unknowns, []);
  assert.ok(current.computer?.missing.includes('Motherboard and PSU are not documented'));
  assert.deepEqual(enrichComputerAssessment(source, current), current);
  const essential = enrichComputerAssessment(source, { ...ai, unknowns: ['Motherboard and PSU are not documented', 'GPU and storage are not verified'] });
  assert.equal(essential.eligibility, 'review'); assert.deepEqual(essential.unknowns, ['GPU and storage are not verified']);
  const mixed = enrichComputerAssessment(source, { ...ai, unknowns: ['Motherboard and GPU are unknown'] });
  assert.equal(mixed.eligibility, 'review'); assert.deepEqual(mixed.unknowns, ['Motherboard and GPU are unknown']);
  const cooler = enrichComputerAssessment(source, { ...ai, unknowns: ['CPU cooling is not documented'] });
  assert.equal(cooler.eligibility, 'eligible'); assert.ok(cooler.computer?.missing.includes('CPU cooling is not documented'));
  const damagedPsu = enrichComputerAssessment(source, { ...ai, unknowns: ['Power supply is damaged; repair status unknown'] });
  assert.equal(damagedPsu.eligibility, 'review'); assert.equal(damagedPsu.unknowns.length, 1);
});

test('laptop replaceability requires explicit evidence and soldered memory remains fixed', () => {
  const laptop = raw('laptop', 10_000_000, { category: 'laptop', title: 'Dell Latitude 5490 i5-8350U RAM32GB SSD512GB Intel UHD620', description: 'Máy dùng tốt' });
  const unknown = enrichComputerAssessment(laptop, assessWithRules(laptop));
  assert.equal(unknown.computer?.ramReplaceable, null); assert.equal(unknown.computer?.storageReplaceable, null);
  const replaceable = { ...laptop, description: '2 khe RAM SODIMM hỗ trợ nâng cấp RAM.\nSSD thay thế được, khe M.2.' };
  const modular = enrichComputerAssessment(replaceable, assessWithRules(replaceable));
  assert.equal(modular.computer?.ramReplaceable, true); assert.equal(modular.computer?.storageReplaceable, true);
  const soldered = { ...laptop, description: 'RAM soldered onboard, không nâng cấp RAM. SSD M.2 512GB' };
  const fixed = enrichComputerAssessment(soldered, assessWithRules(soldered));
  assert.equal(fixed.computer?.ramReplaceable, false);
  assert.equal(fixed.computer?.storageReplaceable, null, 'an SSD interface alone does not verify a replaceable slot');
});

test('explicit source ECC labels enrich AI computers and standalone AI RAM without guessing', () => {
  const pc = raw('ai-ecc', 5_000_000, { category: 'desktop', title: 'Xeon E5-2680 V4 RAM32GB DDR4 ECC REG', description: 'Không kèm VGA' });
  const aiPc = assessment({ cpu: 'XEON E5-2680 V4', gpu: null, ramGb: 32 }, { kind: 'desktop', method: 'ai' });
  assert.equal(enrichComputerAssessment(pc, aiPc).profile.ramEcc, 'registered');
  const stick = raw('ai-ram', 400_000, { category: 'ram', title: 'RAM16GB DDR4 non-ECC DIMM bus2400', description: 'Một thanh' });
  const aiRam = assessment({ gpu: null, ramGb: 16 }, { kind: 'ram', method: 'ai' });
  assert.equal(enrichComputerAssessment(stick, aiRam).profile.ramEcc, 'non-ecc');
  assert.equal(enrichComputerAssessment({ ...stick, title: 'RAM16GB DDR4 DIMM bus2400' }, aiRam).profile.ramEcc, null);
});
