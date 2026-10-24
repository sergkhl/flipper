import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWithRules, cpuModels, gpuModels, profileKey } from '../server/hardware.ts';
import { raw } from './helpers.ts';

test('GPU variant and VRAM stay distinct; multiple models go to review', () => {
  assert.deepEqual(gpuModels('MSI RTX3060Ti 8gb'), ['RTX 3060 TI']);
  const card = assessWithRules(raw('1', 6_000_000, { title: 'Gigabyte RTX3060 Gaming OC 12GB' }));
  assert.equal(card.profile.gpu, 'RTX 3060'); assert.equal(card.profile.vramGb, 12); assert.equal(card.eligibility, 'eligible');
  const multi = assessWithRules(raw('2', 6_000_000, { title: 'RTX3060 12gb / RTX3070 8gb, giá tùy cấu hình' }));
  assert.equal(multi.eligibility, 'review'); assert.equal(multi.profile.gpu, null);
  const bundle = assessWithRules(raw('bundle', 12_000_000, { description:'Bán 2 cây RTX3060 12GB, giá cả bộ 12 triệu' }));
  assert.equal(bundle.eligibility, 'review');
});

test('financing/shop boilerplate does not disqualify an otherwise used working item', () => {
  const card = assessWithRules(raw('1', 6_000_000, { description: 'Card RTX3060 12GB hoạt động tốt. Hỗ trợ trả góp. Shop thu mua các máy hỏng, vỡ màn.' }));
  assert.equal(card.eligibility, 'eligible');
  const broken = assessWithRules(raw('2', 1_000_000, { description: 'Card bị lỗi, không lên hình, bán xác.' }));
  assert.equal(broken.eligibility, 'excluded');
});

test('generic Core i5 family cannot become a specific CPU and missing specs remain reviewable', () => {
  const laptop = assessWithRules(raw('l', 4_000_000, { category: 'laptop', title: 'Dell Inspiron 3421 RAM 8GB SSD 128GB', params: { pc_cpu: 'Intel Core i5' } }));
  assert.equal(laptop.profile.model, 'DELL INSPIRON 3421'); assert.equal(laptop.profile.cpu, null);
  assert.equal(laptop.profile.ramGb, 8); assert.equal(laptop.profile.storageGb, 128); assert.equal(laptop.eligibility, 'review');
});

test('explicit Intel mobile G-series variants and compact CPU spellings retain their exact identity', () => {
  assert.deepEqual(cpuModels('Core i5-1135G7 / i7 1065G7 / i51035G1'), ['I5-1135G7', 'I7-1065G7', 'I5-1035G1']);
  assert.deepEqual(cpuModels('Intel Core i5'), []);
  const laptop = assessWithRules(raw('mobile-cpu', 8_000_000, { category: 'laptop',
    title: 'MSI Modern 14 B11MOU i5-1135G7 RAM 16GB SSD 512GB' }));
  assert.equal(laptop.profile.cpu, 'I5-1135G7');
  assert.ok(laptop.evidence.some(e => e.field === 'cpu' && e.quote.includes('i5-1135G7')));
});

test('fresh SSD evidence cannot turn an intermittent defective drive or a mixed-component bundle into a standalone price', () => {
  const defective = assessWithRules(raw('135033621', 480_000, { category: 'ssd',
    title: 'Ổ cứng SSD NVMe 256GB lỗi cần đổi', description: 'Hiện tại đang nhận tốt. Đổi nvme 256 khác theo giá thoả thuận' }));
  assert.equal(defective.eligibility, 'excluded');
  const bundle = assessWithRules(raw('135172734', 3_000_000, { category: 'ssd',
    title: 'RAM 16G LAPTOP, Ổ M2 NVME CRUCIAL 1T', description: 'RAM laptop DDR4 16G và SSD NVMe 1T. Bán giá cả 2 món 3 triệu' }));
  assert.equal(bundle.eligibility, 'review');
  assert.equal(bundle.profile.priceBasis, 'bundle');
  assert.match(bundle.conflicts.join(' '), /standalone component price/);
  const normal = assessWithRules(raw('normal-ssd', 1_500_000, { category: 'ssd',
    title: 'SSD NVMe 512GB', description: 'Chạy tốt, không lỗi, bảo hành lỗi 1 đổi 1' }));
  assert.equal(normal.eligibility, 'eligible');
});

test('GPU memory generation is required for varying card models inside complete PCs too', () => {
  const pc = raw('variant-pc', 4_000_000, { category:'desktop', title:'PC i5-12400F GT 730 2GB RAM16GB SSD512GB' });
  assert.equal(assessWithRules(pc).eligibility, 'review');
  const stated = assessWithRules({ ...pc, title:`${pc.title} GDDR5` });
  assert.equal(stated.profile.gpuMemoryType, 'GDDR5');
  assert.equal(stated.eligibility, 'eligible');
});

test('conflicting explicit cash prices require review rather than a bargain score', () => {
  const mismatch = assessWithRules(raw('m', 5_000_000, { description: 'Card RTX3060 12GB còn bảo hành.\n- Giá: 6.5 triệu' }));
  assert.equal(mismatch.eligibility, 'review'); assert.match(mismatch.conflicts.join(' '), /cash price/);
  const matching = assessWithRules(raw('p', 6_500_000, { description: 'Card RTX3060 12GB còn bảo hành.\n- Giá: 6.500K' }));
  assert.equal(matching.eligibility, 'eligible');
});

test('never-repaired labels and unrelated shop text cannot cancel actual item defects', () => {
  const broken = assessWithRules(raw('b', 1_000_000, { description: 'Card chưa sửa nhưng không lên hình, bán xác', params: { elt_condition: 'Đã sử dụng (chưa sửa chữa)' } }));
  assert.equal(broken.eligibility, 'excluded');
  const afterShop = assessWithRules(raw('s', 1_000_000, { description: 'Shop thu mua máy hỏng.\nCard đang bán bị lỗi quạt.' }));
  assert.equal(afterShop.eligibility, 'excluded');
  const okay = assessWithRules(raw('ok', 6_000_000, { description: 'Card không bị lỗi, chưa qua sửa chữa. Shop thu mua các máy hỏng.' }));
  assert.equal(okay.eligibility, 'eligible');
});

test('GPU VRAM never absorbs adjacent system RAM across lines or labels', () => {
  const desktop = assessWithRules(raw('d', 22_900_000, { category: 'desktop', title: 'Máy Bàn gaming i5 12400F 16GB/512GB Quadro T1000',
    description: 'i5-12400F RAM16GB SSD512GB\nCard Quadro T1000 8GB', params: { pc_ram: '16 GB' } }));
  assert.equal(desktop.profile.vramGb, 8);
  const unverified = assessWithRules(raw('u', 6_000_000, { title: 'RTX3060 RAM16GB', description: 'Card tốt, chưa sửa' }));
  assert.equal(unverified.profile.vramGb, null); assert.equal(unverified.eligibility, 'review');
});

test('incompatible RAM, storage, and VRAM statements become review instead of choosing the first value', () => {
  const laptop = assessWithRules(raw('l', 4_000_000, { category: 'laptop', title: 'Latitude 5490 i5-8350U RAM16GB SSD512GB Intel UHD 620',
    description: 'Latitude 5490 i5-8350U RAM8GB SSD256GB Intel UHD 620' }));
  assert.equal(laptop.eligibility, 'review'); assert.equal(laptop.profile.storageGb, null);
  const gpu = assessWithRules(raw('g', 6_000_000, { description: 'RTX3060 VRAM 8GB' }));
  assert.equal(gpu.profile.vramGb, null); assert.equal(gpu.eligibility, 'review');
});

test('accessories, deposits and inline/full-VND cash-price conflicts cannot look like cheap cards', () => {
  assert.equal(assessWithRules(raw('a', 500_000, { title: 'Tản nhiệt ASUS RTX3060 12GB' })).eligibility, 'excluded');
  assert.equal(assessWithRules(raw('d', 500_000, { description: 'RTX3060 12GB không lỗi. Giá cọc 500k, giá bán 6.5triệu.' })).eligibility, 'excluded');
  assert.equal(assessWithRules(raw('p', 4_000_000, { description: 'Card tốt, giá 6.500.000đ.' })).eligibility, 'review');
  assert.equal(assessWithRules(raw('i', 4_000_000, { description: 'Card tốt, giá 6.5triệu.' })).eligibility, 'review');
});

test('a multiple-stick RAM offer cannot be valued as a kit without explicit price basis', () => {
  const ram = assessWithRules(raw('r', 400_000, { category: 'ram', title: 'RAM DDR4 4GB 2 thanh', description: '400k mỗi thanh, RAM PC DIMM bus 2400' }));
  assert.equal(ram.profile.perUnitGb, 4); assert.equal(ram.profile.quantity, 2); assert.equal(ram.profile.priceBasis, 'each');
  const ambiguous = assessWithRules(raw('r2', 400_000, { category: 'ram', title: 'RAM DDR4 4GB 2 thanh', description: 'RAM PC DIMM bus 2400' }));
  assert.equal(ambiguous.eligibility, 'review'); assert.equal(ambiguous.profile.priceBasis, 'unknown');
});

test('RAM kit layout and Apple chip context are parsed without reassigning unrelated capacities', () => {
  const kit = assessWithRules(raw('kit', 1_000_000, { category: 'ram', title: 'RAM DDR4 32GB kit2x16GB', description: 'RAM PC DIMM bus3200, giá cả bộ 1000k' }));
  assert.equal(kit.profile.perUnitGb, 16); assert.equal(kit.profile.quantity, 2); assert.equal(kit.profile.ramGb, 32);
  assert.equal(kit.profile.priceBasis, 'bundle'); assert.equal(kit.eligibility, 'eligible');
  const pc = assessWithRules(raw('pc', 4_000_000, { category: 'desktop', title: 'Máy tính Intel Core i5', description: 'SSD M2 512GB NVMe RAM16GB DDR4' }));
  assert.equal(pc.profile.cpu, null);
});

test('source RAM labels do not absorb adjacent or preceding SSD capacities', () => {
  const fixtures = [
    { id: 'macbook', category: 'laptop' as const, title: 'Apple MacBook Air M2 16GB/256GB',
      description: 'Bán macbook air M2 16GB RAM 256GB SSD 13"', storageGb: 256 },
    { id: 'ecc', category: 'desktop' as const, title: 'Bay Full Dàn PC Chiến Game Mượt Mà',
      description: 'SSD 128GB\nRAM ECC 16GB', storageGb: 128 },
    { id: 'one-stick', category: 'desktop' as const, title: 'Case PC cần lên đời, dư dùng nên bán',
      description: 'SSD 256GB\nRam 16GBx 1 thanh', storageGb: 256 },
    { id: 'reverse-ram', category: 'desktop' as const, title: 'Bộ pc AMD Ryzen 5 5500 - GTX 1660 SUPER',
      description: '16GB RAM\n500GB SSD storage', storageGb: 500 },
    { id: 'storage-first', category: 'desktop' as const, title: 'PC i5-13500 RX 6600 XT Trắng SSD 1TB RAM 32GB',
      description: 'RAM 32GB', storageGb: 1024, ramGb: 32 },
  ];
  for (const fixture of fixtures) {
    const a = assessWithRules(raw(fixture.id, 6_000_000, {
      category: fixture.category, title: fixture.title, description: fixture.description, params: { pc_ram: `${fixture.ramGb ?? 16} GB` },
    }));
    assert.equal(a.profile.ramGb, fixture.ramGb ?? 16, fixture.id);
    assert.equal(a.profile.storageGb, fixture.storageGb, fixture.id);
    assert.equal(a.conflicts.some((conflict) => /RAM capacity/.test(conflict)), false, fixture.id);
  }
});

test('conflicting RAM statements in either label order remain unresolved', () => {
  const a = assessWithRules(raw('ram-conflict', 6_000_000, {
    category: 'desktop', title: 'PC 32GB RAM SSD 512GB', description: 'RAM 16GB DDR4',
  }));
  assert.equal(a.profile.ramGb, null);
  assert.equal(a.eligibility, 'review');
  assert.match(a.conflicts.join(' '), /disagree about RAM capacity/);
});

test('CPU spellings canonicalize exact Ryzen and Xeon identifiers without inventing a family', () => {
  assert.deepEqual(cpuModels('RYZEN5 5600X / Ryzen 5-5600X'), ['RYZEN 5 5600X']);
  assert.deepEqual(cpuModels('Dual Xeon E5 2680v4, CPU E5-2680 V4'), ['XEON E5-2680 V4']);
  assert.deepEqual(cpuModels('Xeon E5-2696 V3'), ['XEON E5-2696 V3']);
  assert.deepEqual(cpuModels('RAM bus2680; CPU 2696'), []);
});

test('source RAM clocks retain attached MHz units without absorbing CPU or GPU clocks', () => {
  for (const claim of ['RAM 32GB (2x16GB) 3200MHz', 'RAM 32GB DDR5 BUS 6000MHZ', 'DDR4 16GB 3200MHz DIMM']) {
    const result = assessWithRules(raw('ram-clock', 10_000_000, { category: 'desktop', title: 'PC i5-14400F', description: claim }));
    assert.equal(result.profile.ramSpeedMhz, claim.includes('6000') ? 6000 : 3200, claim);
  }
  const unrelated = assessWithRules(raw('gpu-clock', 10_000_000, { category: 'desktop', title: 'PC i5-14400F',
    description: 'RAM 32GB DDR4\nVGA RTX3070 8GB clock 1800MHz\nCPU i5-14400F 2500MHz' }));
  assert.equal(unrelated.profile.ramSpeedMhz, null);
  const conflicting = assessWithRules(raw('different-clocks', 10_000_000, { category: 'desktop', title: 'PC RAM32GB DDR4 3200MHz',
    description: 'RAM 32GB DDR4 3600MHz' }));
  assert.equal(conflicting.eligibility, 'review');
  assert.equal(conflicting.profile.ramSpeedMhz, null);
});

test('GPU VRAM ignores unlabeled RAM/storage shorthand and a following RAM label', () => {
  for (const title of ['PC i5-12400 RTX3070 32GB/256GB', 'PC i5-12400 RTX3070 32GB RAM SSD256GB']) {
    const unknown = assessWithRules(raw('pc-vram', 10_000_000, { category: 'desktop', title, description: 'Máy dùng tốt' }));
    assert.equal(unknown.profile.vramGb, null, title);
    const stated = assessWithRules(raw('pc-vram', 10_000_000, { category: 'desktop', title, description: 'VGA RTX3070 8GB' }));
    assert.equal(stated.profile.vramGb, 8, title);
    assert.equal(stated.conflicts.length, 0, title);
  }
});

test('NVMe storage labels and explicit laptop stick layouts remain separate capacities', () => {
  for (const storage of ['SSD NVMe 512GB', 'NVMe SSD 512GB', '512GB NVMe', 'SSD M.2 512GB NVMe']) {
    const pc = assessWithRules(raw('laptop-layout', 10_000_000, { category: 'laptop',
      title: 'Dell Latitude 5490 i5-8350U Intel UHD620', description: `RAM 32GB 2x16GB DDR4 SODIMM bus2400. ${storage}` }));
    assert.equal(pc.profile.storageGb, 512, storage);
    assert.equal(pc.profile.storageType, 'NVME SSD', storage);
    assert.equal(pc.profile.ramGb, 32); assert.equal(pc.profile.quantity, 2); assert.equal(pc.profile.perUnitGb, 16);
    assert.equal(pc.profile.ramFormFactor, 'SODIMM');
  }
});

test('explicit ECC claims distinguish memory pools and absent GPU from unknown GPU keys', () => {
  const ecc = assessWithRules(raw('ecc', 400_000, { category: 'ram', title: 'RAM 16GB DDR4 ECC REG DIMM bus2400', description: 'Giá mỗi thanh 400k' }));
  const nonEcc = assessWithRules(raw('non-ecc', 400_000, { category: 'ram', title: 'RAM 16GB DDR4 non-ECC DIMM bus2400', description: 'Giá mỗi thanh 400k' }));
  assert.equal(ecc.profile.ramEcc, 'registered'); assert.equal(nonEcc.profile.ramEcc, 'non-ecc');
  assert.notEqual(profileKey(ecc.profile, 'ram'), profileKey(nonEcc.profile, 'ram'));
  assert.notEqual(profileKey({ ...ecc.profile, gpuInclusion: 'absent' }, 'desktop'), profileKey({ ...ecc.profile, gpuInclusion: 'unknown' }, 'desktop'));
});

test('fresh i5-13500 source examples retain model-before-capacity storage and reject system RAM as VRAM', () => {
  const storagePc = assessWithRules(raw('134490871', 22_000_000, { category: 'desktop',
    title: 'Máy tính để bàn Lắp ráp i5 13500 32GB/1TB RTX 3070 Đen',
    description: '- ram 32gb ddr4 t-force delta rgb 16gb x2 bus 3200\n- card rtx 3070 8gb gaming x trio\n- ssd nvme gen4 teamgroup mp44l 1tb',
    params: { pc_ram: '32 GB' },
  }));
  assert.equal(storagePc.profile.storageGb, 1024); assert.equal(storagePc.profile.storageType, 'NVME SSD');
  assert.equal(storagePc.profile.vramGb, 8);
  const unknownVram = assessWithRules(raw('130727852', 20_000_000, { category: 'desktop',
    title: 'GIGABYTE i5 13500 RTX 3060 32GB',
    description: '* cpu core i5 13500\n* ram Corsair ddr4 32gb buss 3200 (2*16gb)\n* ssd m2 nvme gen 4x4 dung lượng 1TB tốc độ 7000 cực nhanh.\n* vga gigabyte rtx 3060 Vision',
    params: { pc_ram: '32 GB' },
  }));
  assert.equal(unknownVram.profile.ramGb, 32); assert.equal(unknownVram.profile.vramGb, null);
  assert.equal(unknownVram.profile.storageGb, 1024); assert.equal(unknownVram.profile.storageType, 'NVME SSD');
});

test('RAM layouts stay inside RAM context instead of absorbing a GPU cooler model', () => {
  const pc = assessWithRules(raw('135131180', 19_200_000, { category: 'desktop',
    title: 'PC i7 12700KF 32GB/SSD 500GB RTX 2070 Đen',
    description: '🔹Ram Gskill Ripjaws 32GB (16GBx2) 3200Mhz\n🔹SSD Samsung 500GB 980 NVMe\n🔹VGA MSI RTX 2070 Ventus 2x 8GB BH 3th',
    params: { pc_ram: '32 GB' },
  }));
  assert.equal(pc.profile.ramGb, 32); assert.equal(pc.profile.quantity, 2); assert.equal(pc.profile.perUnitGb, 16);
  assert.equal(pc.profile.vramGb, 8); assert.equal(pc.profile.storageGb, 500);
  assert.equal(pc.conflicts.length, 0);
  const noLayout = assessWithRules(raw('no-layout', 19_200_000, { category: 'desktop',
    title: 'PC i7-12700KF RAM32GB RTX2070 Ventus 2x 8GB', description: 'Máy dùng tốt',
  }));
  assert.equal(noLayout.profile.ramGb, 32); assert.equal(noLayout.profile.perUnitGb, null);
  const older = assessWithRules(raw('134648391', 7_500_000, { category: 'desktop',
    title: 'Antec i7-8700 GTX 1050 Ti 32GB SSD 120GB Win 11',
    description: 'Vi xử lý Intel i7-8700, RAM 32 GB, card đồ họa NVIDIA GTX 1050 Ti.\nỔ cứng SSD 120 GB',
  }));
  assert.equal(older.profile.ramGb, 32); assert.equal(older.profile.vramGb, null);
});

test('a bare T denotes terabytes only inside an explicit storage claim', () => {
  const pc = assessWithRules(raw('134884791', 27_500_000, { category: 'desktop', title: 'Case i7-12700KF /32GB/1TB /RTX 3060 12G',
    description: 'Cấu hình case pc làm đồ hoạ , game online , ae cần tham khảo !\n•Main B760 Asus Tuf gaming wifi NEW ( BH 36T )\n•Cpu Intel Core i7-12700KF TRAY NEW ( BH 36T )\n•Ram Corsair LPX 32GB x1 DDR4 3200MHz ( BH 12T ) 2ND\n•Vga GiGa RTX3060 12G Dr6 ( BH 12T ) 2ND\n•SSD Adata Legend710 1T NVME 2280 PCIe Gen3 x4 ( BH 12T )2ND\n•Tản Nhiệt khí frozn A410 ARGB back NEW ( BH 24T )\n•Psu VSP VGP650BRU PRO 650W (80Plus Bronze) NEW ( BH 36T )\n•Case XIGMATEK MIK MORAX 3GF M-ATX NEW ( BH 12T )\n• Giá : 27.500.000 VND ( chưa kèm màn hình )\nlcd 24 , 27in new giá dưới 2m ( BH 24T )',
    params: { pc_ram: '32 GB', pc_drive_capacity: '1 TB', pc_drive_type: 'SSD' },
  }));
  assert.equal(pc.profile.storageGb, 1024); assert.equal(pc.profile.storageType, 'NVME SSD');
  assert.equal(pc.conflicts.some((conflict) => /storage capacities/.test(conflict)), false);
  const noStorage = assessWithRules(raw('not-storage', 18_000_000, { category: 'desktop', title: 'PC i5-13500 RAM32GB', description: 'Bảo hành 1T' }));
  assert.equal(noStorage.profile.storageGb, null);
  for (const warranty of ['BH 12T', 'Bảo hành 12T', 'Warranty 12T']) {
    const durationOnly = assessWithRules(raw('warranty-only', 18_000_000, { category: 'desktop', title: 'PC i5-13500 RAM32GB', description: `SSD NVMe Teamgroup (${warranty})` }));
    assert.equal(durationOnly.profile.storageGb, null, warranty);
    const precedingWarranty = assessWithRules(raw('warranty-before', 18_000_000, { category: 'desktop', title: 'PC i5-13500 RAM32GB', description: `${warranty} NVMe SSD` }));
    assert.equal(precedingWarranty.profile.storageGb, null, warranty);
  }
});
