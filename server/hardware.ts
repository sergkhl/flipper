import { EMPTY_PROFILE } from './config.ts';
import type { Assessment, HardwareKind, HardwareProfile, RawListing } from '../shared/types.ts';
import { directMemoryTypeFacts, memoryComponentBefore } from './memory-types.ts';
import { macBookCapacities, macBookFacts } from './macbook.ts';

export function normalize(value: string): string {
  return value.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function listingText(raw: RawListing): string {
  return [raw.title, raw.description, ...Object.entries(raw.params).map(([key, value]) => `${key}: ${value}`)].join('\n');
}

export function sourceUnavailable(raw: RawListing): boolean {
  return raw.attributes._sourceUnavailable === true
    || /^(?:deleted|sold|expired|inactive|removed|hidden|rejected|refused)$/.test(String(raw.attributes.status ?? '').toLowerCase());
}

function uniqueMatches(text: string, regex: RegExp): string[] {
  return [...new Set(Array.from(text.matchAll(regex), (match) => match[0].trim().toUpperCase().replace(/\s+/g, ' ')))];
}

export function gpuModels(text: string): string[] {
  const n = normalize(text);
  const cards = uniqueMatches(n, /\b(?:rtx|gtx|gt|rx|mx)\s*[-]?\s*\d{3,4}m?(?:\s*(?:ti|super|xtx|xt))?\b/g)
    .map((value) => value.replace(/(RTX|GTX|GT|RX|MX)\s*-?\s*(\d+)/, '$1 $2').replace(/\s*(TI|SUPER|XTX|XT)$/, ' $1'));
  const quadro = uniqueMatches(n, /\b(?:quadro\s*)?(?:[pkm]\d{3,4}|t(?:400|600|1000)|a(?:2000|4000|5000|6000))\b/g)
    .filter((value) => !/^M[1-5]$/.test(value)).map((value) => `QUADRO ${value.replace(/^QUADRO\s*/, '')}`);
  const arc = uniqueMatches(n, /\barc\s*[ab]\d{3}\b/g);
  return [...new Set([...cards, ...quadro, ...arc])];
}

export function cpuModels(text: string): string[] {
  const n = normalize(text);
  const intel = uniqueMatches(n, /\bi[3579]\s*[- ]\s*\d{4,5}[a-z]{0,3}\b/g)
    .map((value) => value.replace(/(I[3579])\s*[- ]\s*/, '$1-'));
  const amd = uniqueMatches(n, /\bryzen\s*[3579]\s*[- ]?\s*\d{4}[a-z]{0,3}\b/g)
    .map((value) => value.replace(/^RYZEN\s*([3579])\s*[- ]?\s*(\d{4}[A-Z]{0,3})$/, 'RYZEN $1 $2'));
  const xeon = uniqueMatches(n, /\b(?:xeon\s*)?e[357]\s*[- ]?\s*\d{4}[a-z]{0,2}(?:\s*[- ]?\s*v[1-6])?\b/g)
    .map((value) => value.replace(/^(?:XEON\s*)?(E[357])\s*[- ]?\s*(\d{4}[A-Z]{0,2}?)(?:\s*[- ]?\s*V([1-6]))?$/, (_all, family: string, model: string, version: string | undefined) => `XEON ${family}-${model}${version ? ` V${version}` : ''}`));
  const appleText = n.replace(/\b(?:ssd|nvme|o cung)\s*m\.?2\b/g, 'storage-interface');
  const apple = /\b(?:apple|macbook|chip|cpu|processor)\b/.test(appleText)
    ? uniqueMatches(appleText, /\b(?:apple\s*)?(?:m[1-9](?:\s*(?:pro|max|ultra))?|a\d{2}\s*pro)\b/g)
    .map((value) => value.replace(/^APPLE\s*/, '').replace(/^(M[1-9]|A\d{2})\s*(PRO|MAX|ULTRA)$/, '$1 $2'))
    .map((value) => `APPLE ${value}`)
    : [];
  return [...new Set([...intel, ...amd, ...xeon, ...apple])];
}

function capacity(text: string, prefix: RegExp): { value: number; quote: string } | null {
  const match = text.match(prefix);
  if (!match) return null;
  const number = Number(match[1]);
  return { value: /^(?:tb|t|tera)$/i.test(match[2] ?? '') ? number * 1024 : number, quote: match[0] };
}

function foldedLines(value: string): string {
  return value.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().replace(/[^\S\n]+/g,' ');
}

function capacityValues(text: string, pattern: RegExp): number[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => Number(match[1]) * (/^(?:tb|t|tera)$/i.test(match[2] ?? '') ? 1024 : 1)))];
}

function ramCapacities(text: string): { value: number; quote: string }[] {
  // Consume explicit storage and RAM claims in source order, so neither "SSD 1TB RAM 32GB"
  // nor "16GB RAM 256GB SSD" can give the SSD capacity to RAM. Claims stay on one line.
  const gap = String.raw`[^\S\n]*`, generation = String.raw`(?:lp)?ddr[2-6][xlt]?`;
  const label = `(?:ram|memory|bo nho ram|${generation})`, storage = '(?:ssd|hdd|nvme|o cung|storage)';
  const unit = '(?:gb|g|tb)', decoration = `${gap}[: =-]?${gap}(?:(?:ecc|${generation})[^\\S\\n]+)*`;
  const nextCapacity = `\\d{1,4}${gap}${unit}\\b`;
  // In "16GB RAM 256GB SSD", the second capacity belongs to storage. In
  // "RTX3070 8GB RAM DDR4 16GB", the RAM label introduces its own capacity.
  const storageSuffix = `${gap}${storage}\\b(?!${gap}[: =-]?${gap}${nextCapacity})`;
  const nextRamCapacity = `${decoration}\\d{1,3}${gap}${unit}\\b(?!${storageSuffix})`;
  const pattern = new RegExp(`\\b(?:${storage}${gap}[: =-]?${gap}${nextCapacity}|${nextCapacity}${gap}${storage}\\b|`
    + `(\\d{1,3})${gap}(gb|g|tb)${gap}${label}\\b(?!${nextRamCapacity})|${label}${decoration}(\\d{1,3})${gap}(gb|g|tb)\\b)`, 'g');
  return [...text.matchAll(pattern)].filter((match) => {
    if (match[1] === undefined && match[3] === undefined) return false;
    if (/ddr[2-6]/.test(match[0]) && !/^(?:ram|memory|bo nho ram)(?=\b|\d)/.test(match[0])) {
      const lineStart = text.lastIndexOf('\n', match.index!) + 1;
      const line = text.slice(lineStart, text.indexOf('\n', match.index!) < 0 ? undefined : text.indexOf('\n', match.index!));
      if (memoryComponentBefore(line, match.index! - lineStart) === 'gpu') return false;
    }
    return true;
  }).map((match) => ({
    value: Number(match[1] ?? match[3]) * (/tb/i.test(match[2] ?? match[4] ?? '') ? 1024 : 1), quote: match[0],
  }));
}

function computerRamLayouts(text: string): { count: number; perUnitGb: number; quote: string }[] {
  const layouts: { count: number; perUnitGb: number; quote: string }[] = [];
  for (const line of text.split('\n')) {
    const marker = line.match(/\b(?:ram|memory|bo nho ram)(?=\b|\d)/);
    let segment = '';
    if (marker) {
      segment = line.slice(marker.index).split(/\b(?:ssd|hdd|nvme|storage|cpu|vga|gpu|card|rtx|gtx|rx|quadro)(?=\b|\d)/)[0]!;
      if (gpuModels(line).length === 0) segment = `${line.slice(0, marker.index)} ${segment}`;
    } else if (/\b(?:ddr[345]|so[- ]?dimm)\b/.test(line) && gpuModels(line).length === 0) segment = line;
    const forward = segment.match(/\b(\d{1,2})\s*[x×*]\s*(\d{1,3})\s*(?:gb|g)\b/)
      ?? segment.match(/\b(\d{1,2})\s*thanh\s*(?:ram\s*)?(\d{1,3})\s*(?:gb|g)\b/);
    const reverse = segment.match(/\b(\d{1,3})\s*(?:gb|g)\s*[x×*]\s*(\d{1,2})\b/);
    if (forward) layouts.push({ count: Number(forward[1]), perUnitGb: Number(forward[2]), quote: line });
    else if (reverse) layouts.push({ count: Number(reverse[2]), perUnitGb: Number(reverse[1]), quote: line });
  }
  return layouts.filter((layout, index) => layouts.findIndex((other) => other.count === layout.count && other.perUnitGb === layout.perUnitGb) === index);
}

function modelFromText(raw: RawListing, n: string): string | null {
  if (raw.category === 'gpu') return gpuModels(listingText(raw))[0] ?? null;
  const patterns = [
    /\b(?:dell\s*)?(?:inspiron|latitude|precision|vostro|xps)\s*\d{3,4}(?:\s*2[- ]in[- ]1)?\b/i,
    /\b(?:lenovo\s*)?(?:thinkpad|ideapad|legion|thinkbook)\s*(?:[a-z]\d{3}[a-z]?|\d\w*(?:\s*\d{2}[a-z0-9]+)?)(?:\s*gen\s*\d+)?\b/i,
    /\b(?:hp\s*)?(?:elitebook|probook|zbook)\s*\d{3,4}\s*g\d+\b/i,
    /\b(?:asus\s*)?(?:vivobook|zenbook|tuf|rog)\s*[a-z]{1,3}\d{3,4}[a-z0-9]*\b/i,
    /\bmacbook\s*(?:air|pro)\s*(?:m[1-5](?:\s*(?:pro|max))?|20\d{2}|\d{2})\b/i,
    /\b(?:acer\s*)?(?:nitro|aspire|swift)\s*[a-z]{1,3}\d{1,3}(?:[- ]\d{2})?[a-z0-9]*\b/i,
    /\b(?:msi\s*)?(?:katana|gf|gl|gs|ge|modern|prestige)\s*\d{2,3}[a-z0-9]*\b/i,
    /\b(?:dell\s*)?optiplex\s*\d{3,4}\b/i,
    /\b(?:hp\s*)?(?:elitedesk|prodesk)\s*\d{3}\s*g\d+\b/i,
  ];
  for (const pattern of patterns) {
    const match = n.match(pattern);
    if (match) return match[0].toUpperCase().trim();
  }
  // Structured generic family labels such as “Dell” or “Dòng khác” are not a specific model.
  const structured = Object.entries(raw.params).find(([key]) => /model|dong may|mau may/.test(normalize(key)))?.[1];
  if (structured && /\d/.test(structured) && !/khac|other/i.test(normalize(structured))) return structured.toUpperCase().trim();
  return null;
}

export function assessWithRules(raw: RawListing): Assessment {
  const text = listingText(raw);
  const n = foldedLines(text);
  const title = normalize(raw.title);
  const profile: HardwareProfile = { ...EMPTY_PROFILE };
  const evidence: Assessment['evidence'] = [];
  const risks: string[] = [];
  const conflicts: string[] = [];
  const unknowns: string[] = [];
  let kind: HardwareKind = raw.category;
  let eligibility: Assessment['eligibility'] = 'eligible';
  const vramQuotes: string[] = [];
  if (/^(?:can mua|thu mua|tim mua|mua lai)|\bcan mua\b/.test(title)) kind = 'wanted';
  if (kind === 'gpu' && (/^(?:tan nhiet|quat|fan|vo|box|dock|adapter|riser|day|cap|nguon|mainboard|backplate|heatsink)\b/.test(title)
    || /\b(?:e?gpu box|vo egpu|dock egpu)\b/.test(title))) kind = 'other';
  const gpus = gpuModels(text);
  const cpus = cpuModels(text);
  const statedRamCapacities = new Set(ramCapacities(n).map((claim) => claim.value));
  for (const [key, value] of Object.entries(raw.params)) {
    if (/pc_ram|dung luong ram/.test(normalize(key))) {
      const match = value.match(/^(\d{1,3})\s*(?:gb|g)$/i);
      if (match) statedRamCapacities.add(Number(match[1]));
    }
  }
  profile.gpu = gpus.length === 1 ? gpus[0]! : null;
  profile.cpu = cpus.length === 1 ? cpus[0]! : null;
  profile.model = modelFromText(raw, n);
  const mac = macBookFacts(raw);
  if (mac) { profile.model = mac.model; Object.assign(profile,mac.fields); conflicts.push(...mac.conflicts); evidence.push(...mac.evidence); }
  if (profile.gpu) {
    profile.gpuClass = kind === 'laptop' ? 'mobile' : 'desktop';
    const escaped = profile.gpu.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*');
    const capacities = new Set<number>();
    for (const line of text.split('\n')) {
      const folded = foldedLines(line);
      const modelAt = folded.search(new RegExp(escaped));
      const modelLine = modelAt >= 0 ? folded.slice(modelAt) : '';
      const afterModel = modelLine.split(/\b(?:ram|ssd|hdd|cpu|bo nho ram)(?=\b|\d)/)[0]!;
      // In complete-PC shorthand, "RTX3070 32GB/256GB" describes system RAM/storage.
      // A capacity followed by a storage-sized slash pair or a RAM label is not VRAM.
      let nearModel = afterModel.match(new RegExp(`${escaped}[^\\n,;]{0,45}?\\b(2|3|4|6|8|10|11|12|16|20|24|32|48)\\s*(?:gb|g)\\b(?!\\s*(?:/\\s*\\d{2,4}\\s*(?:gb|g|tb)\\b|ram\\b))`));
      if (nearModel) {
        const suffix = modelLine.slice(nearModel.index! + nearModel[0].length);
        if (/^\s*ram\b/.test(suffix) && !/^\s*ram\s*[:=-]?\s*\d{1,3}\s*(?:gb|g)\b/.test(suffix)) nearModel = null;
        else if ((kind === 'desktop' || kind === 'laptop') && statedRamCapacities.has(Number(nearModel[1]))
          && cpuModels(line).length > 0 && !/\b(?:vga|card|gpu)\b[^,;]*$/.test(folded.slice(0, modelAt))) nearModel = null;
      }
      const explicit = folded.match(/\b(?:vram|gddr[3-7])\s*[: -]?\s*(\d{1,2})\s*(?:gb|g)\b/);
      for (const match of [nearModel, explicit]) if (match) { capacities.add(Number(match[1])); vramQuotes.push(line); }
    }
    if (capacities.size === 1) profile.vramGb = [...capacities][0]!;
    else if (capacities.size > 1) conflicts.push('Title, description or parameters disagree about video-memory capacity');
  } else if ((kind === 'laptop' || kind === 'desktop') && /\b(?:intel\s*(?:uhd|hd|iris)(?:\s*(?:xe|graphics|\d{3,4}))*|radeon\s*(?:vega|graphics)|integrated|onboard|tich hop)\b/.test(n)) {
    const integrated = n.match(/\b(?:intel\s*(?:uhd|hd|iris(?:\s*xe)?)(?:\s*graphics)?(?:\s*\d{3,4})?|radeon\s*(?:vega(?:\s*\d+)?|graphics))\b/);
    profile.gpu = integrated?.[0].toUpperCase() ?? 'INTEGRATED';
    profile.gpuClass = 'integrated';
  } else if (kind === 'laptop' && profile.cpu?.startsWith('APPLE') && mac) {
    profile.gpu = profile.gpuCores ? `${profile.cpu} ${profile.gpuCores}-CORE INTEGRATED` : `${profile.cpu} INTEGRATED`;
    profile.gpuClass = 'integrated';
  }
  const ramClaims = ramCapacities(n), ram = ramClaims[0];
  if (ram) { profile.ramGb = ram.value; evidence.push({ field: 'ramGb', quote: text.split('\n').find((line) => normalize(line).includes(ram.quote))?.slice(0,240) ?? ram.quote }); }
  const macCapacities = macBookCapacities(raw);
  if (!profile.ramGb && macCapacities.length) { profile.ramGb = macCapacities[0]!.ramGb; evidence.push({field:'ramGb',quote:macCapacities[0]!.quote}); }
  const ramValues = [...new Set([...ramClaims.map((claim) => claim.value), ...macCapacities.map(claim => claim.ramGb)])];
  if (ramValues.length > 1) { profile.ramGb = null; conflicts.push('Title and description disagree about RAM capacity'); }
  const structuredRam = Object.entries(raw.params).find(([key]) => /pc_ram|dung luong ram/.test(normalize(key)))?.[1];
  const ramParam = structuredRam?.match(/^(\d{1,3})\s*(?:gb|g)$/i);
  if (ramParam) {
    if (profile.ramGb && profile.ramGb !== Number(ramParam[1])) conflicts.push('Description and structured RAM capacity disagree');
    else if (!profile.ramGb) profile.ramGb = Number(ramParam[1]);
  }
  // Vietnamese warranty durations such as "BH 12T" are months, not terabytes.
  // Mask those claims for both prefix and suffix capacity matching, and keep model
  // descriptions from crossing into a warranty clause while looking for capacity.
  const storageText = n.replace(/\b(?:bh|bao hanh|warranty)[^\S\n]*[:=-]?[^\S\n]*\d{1,3}[^\S\n]*(?:t|thang|months?)\b/g, 'warranty');
  const storagePrefix = /\b(?:ssd|hdd|nvme|o cung|storage)(?:[^\S\n]+(?:ssd|nvme|sata|m\.?2))*[^\S\n]*[: =-]?[^\S\n]*(\d{1,4})[^\S\n]*(tb|t|gb|g)\b/;
  const storageModelPrefix = /\b(?:ssd|hdd|nvme|o cung|storage)\b(?:(?!\b(?:ram|memory|bo nho ram|cpu|vga|gpu|ddr[345]|bh|bao hanh|warranty)(?=\b|\d))[^\n,;]){0,80}?\b(\d{1,4})[^\S\n]*(tb|t|gb|g)\b/;
  const storageSuffix = /\b(\d{1,4})[^\S\n]*(tb|t|gb|g)[^\S\n]*(?:ssd|hdd|nvme)\b/;
  const storage = capacity(storageText, storagePrefix) ?? capacity(storageText, storageSuffix) ?? capacity(storageText, storageModelPrefix);
  if (storage) { profile.storageGb = storage.value; evidence.push({ field: 'storageGb', quote: text.split('\n').find((line) => normalize(line).includes(storage.quote))?.slice(0,240) ?? storage.quote }); }
  if (!profile.storageGb && macCapacities.length) { profile.storageGb = macCapacities[0]!.storageGb; evidence.push({field:'storageGb',quote:macCapacities[0]!.quote}); }
  const storageValues = [...new Set([...macCapacities.map(claim => claim.storageGb), ...capacityValues(storageText, new RegExp(storagePrefix.source, 'g')),
    ...capacityValues(storageText, new RegExp(storageModelPrefix.source, 'g')),
    ...capacityValues(storageText, new RegExp(`${storageSuffix.source}(?![^\\S\\n]*[:= -]?[^\\S\\n]*\\d)`, 'g'))])];
  if (storageValues.length > 1) { profile.storageGb = null; conflicts.push('Several storage capacities are stated; the offered configuration is not resolved'); }
  const structuredStorage = Object.entries(raw.params).find(([key]) => /pc_drive_capacity/.test(key))?.[1];
  const storageLabel = normalize(structuredStorage ?? '');
  const storageBound = storageLabel.match(/(\d{1,4})\s*(gb|tb)/);
  const exactStorage = storageLabel.match(/^(\d{1,4})\s*(gb|tb)$/);
  if (kind === 'laptop' && exactStorage) {
    const value = Number(exactStorage[1]) * (exactStorage[2] === 'tb' ? 1024 : 1);
    if (profile.storageGb && profile.storageGb !== value) conflicts.push('Description and structured storage capacity disagree');
    else if (!profile.storageGb && storageValues.length <= 1) { profile.storageGb = value; evidence.push({field:'storageGb',quote:`pc_drive_capacity: ${structuredStorage}`}); }
  }
  if (profile.storageGb && storageBound) {
    const bound = Number(storageBound[1]) * (storageBound[2] === 'tb' ? 1024 : 1);
    if ((/duoi|less|</.test(storageLabel) && profile.storageGb >= bound) || (/tren|more|>/.test(storageLabel) && profile.storageGb <= bound)) conflicts.push('Stated storage capacity contradicts the structured capacity range');
  }
  if (mac && /\b(?:ssd|nvme)(?=\b|\d)/.test(n)) profile.storageType = 'SSD';
  else if (/\b(?:ssd|nvme)(?=\b|\d)/.test(n)) profile.storageType = /nvme/.test(n) ? 'NVME SSD' : /sata/.test(n) ? 'SATA SSD' : 'SSD';
  else if (/\bhdd(?=\b|\d)/.test(n)) profile.storageType = 'HDD';
  const memoryTypes = directMemoryTypeFacts(raw, kind);
  profile.ramType = memoryTypes.values.ramType;
  profile.gpuMemoryType = profile.gpuClass === 'integrated' ? null : memoryTypes.values.gpuMemoryType;
  evidence.push(...memoryTypes.evidence.filter((item) => item.field !== 'gpuMemoryType' || profile.gpuClass !== 'integrated'));
  conflicts.push(...memoryTypes.conflicts);
  if (kind === 'ram' || kind === 'desktop' || kind === 'laptop') {
    profile.ramEcc = /\b(?:non[- ]ecc|khong ecc)\b/.test(n) ? 'non-ecc'
      : /\b(?:rdimm|registered|ecc\s*(?:reg|registered))\b/.test(n) ? 'registered'
        : /\becc\b/.test(n) ? 'ecc' : null;
  }
  const ramSpeeds = new Set<number>();
  for (const line of text.split('\n').map(foldedLines)) {
    const start = line.search(/\b(?:ram(?=\b|\d)|ddr[345]\b|memory\b)/);
    if (start < 0) continue;
    const claim = line.slice(start).split(/\b(?:ssd|nvme|vga|gpu|cpu|card|rtx|gtx|rx)\b/)[0]!;
    for (const match of claim.matchAll(/\b(?:bus\s*|speed\s*|ddr[345][- ]+)(\d{4})(?=\b|mhz\b)|\b(\d{4})\s*mhz\b/g)) {
      ramSpeeds.add(Number(match[1] ?? match[2]));
    }
  }
  profile.ramSpeedMhz = ramSpeeds.size === 1 ? [...ramSpeeds][0]! : null;
  if (ramSpeeds.size > 1) conflicts.push('Title, description or parameters disagree about RAM speed');
  profile.ramFormFactor = /so[- ]?dimm|ram laptop|ram cho laptop/.test(n) ? 'SODIMM' : /\bdimm\b|ram pc|ram may ban/.test(n) ? 'DIMM' : null;
  profile.quantity = 1;
  profile.priceBasis = 'item';
  if (kind === 'desktop' || kind === 'laptop') {
    const layouts = computerRamLayouts(n), layout = layouts[0];
    if (layout) {
      profile.quantity = layout.count; profile.perUnitGb = layout.perUnitGb;
      const total = profile.quantity * profile.perUnitGb;
      if (profile.ramGb && profile.ramGb !== total) conflicts.push('RAM total and stick layout disagree');
      else profile.ramGb = total;
    }
    if (layouts.length > 1) { profile.quantity = null; profile.perUnitGb = null; conflicts.push('Several RAM stick layouts are stated; the offered layout is not resolved'); }
    // No stick count or DIMM form factor is guessed from a total memory capacity.
  }
  if (kind === 'gpu' && /\b(?:[2-9]\s*(?:card|cay|vga|gpu|cai|chiec)|cap card|bo card)\b/.test(n)) {
    conflicts.push('Several graphics cards are advertised; the single-card cash price is not verified');
  }
  if (kind === 'ram') {
    const one = capacity(n, /\b(?:ram\s*|ddr[345]\s*)?(\d{1,3})\s*(gb|g)\b/);
    const layout = n.match(/(?:\b|kit\s*)(\d{1,2})\s*[x×]\s*(\d{1,3})\s*(?:gb|g)/);
    const sticks = n.match(/\b(\d{1,2})\s*(?:thanh|sticks?)\b/);
    profile.quantity = layout ? Number(layout[1]) : sticks ? Number(sticks[1]) : 1;
    profile.perUnitGb = layout ? Number(layout[2]) : one?.value ?? profile.ramGb;
    if (profile.perUnitGb) profile.ramGb = profile.perUnitGb * profile.quantity;
    const statedTotal = n.match(/\b(?:kit|tong|total|ca bo)\s*(\d{1,3})\s*(?:gb|g)\b/);
    if (statedTotal && profile.ramGb !== Number(statedTotal[1])) conflicts.push('RAM kit total and explicit stick layout disagree');
    if (/\b(?:moi thanh|1 thanh|mot thanh|per stick|\/thanh)\b/.test(n)) profile.priceBasis = 'each';
    else if (profile.quantity > 1 && /\b(?:ca bo|ca cap|combo|kit|2x|4x|gia bo|gia cap)|kit\d+x/.test(n)) profile.priceBasis = 'bundle';
    else if (profile.quantity > 1) profile.priceBasis = 'unknown';
    if (!profile.perUnitGb || !profile.ramType || !profile.ramFormFactor || !profile.ramSpeedMhz || profile.priceBasis === 'unknown') {
      unknowns.push('RAM capacity, generation, form factor, speed and price per stick/bundle must be explicit');
    }
  }
  if (gpus.length > 1) conflicts.push('More than one graphics-card model is advertised');
  if (cpus.length > 1) conflicts.push('More than one processor model is advertised');
  if (raw.condition === 'new') { eligibility = 'excluded'; risks.push('Advertised as new, outside the used-price pool'); }
  if (raw.condition === 'repaired') { eligibility = 'excluded'; risks.push('Advertised as repaired'); }
  if (kind === 'wanted' || kind === 'other') { eligibility = 'excluded'; risks.push('Not an individual hardware item for sale'); }
  if (!Number.isFinite(raw.price) || raw.price <= 0) { eligibility = 'review'; risks.push('No usable cash asking price'); }
  // Negation applies to its own claim. A “never repaired” source label cannot cancel another defect.
  const clauses = foldedLines(`${raw.title}\n${raw.description}`).split(/[\n;.!?]+/).map((clause) => clause.trim());
  const itemClauses = clauses.filter((clause) => !/\b(?:thu mua|nhan sua|chuyen sua|dich vu sua)\b/.test(clause));
  const itemText = itemClauses.join('\n');
  const withoutNegatedClaims = itemClauses.map((clause) => clause.replace(/\b(?:khong (?:bi )?(?:loi|hong|vo man|khoa bios|khoa icloud)|chua (?:qua )?sua(?: chua)?|khong qua sua(?: chua)?)\b/g,''));
  const damage = withoutNegatedClaims.some((clause) => /\b(?:bi loi|dang loi|loi can (?:doi|sua)|loi man|soc man|man bi|khong len|khong hoat dong|hong|vo man|ban xac|chi lay linh kien|parts only|khoa icloud|khoa bios|mat khau bios|da sua|da qua sua)\b/.test(clause));
  if (damage) {
    eligibility = 'excluded'; risks.push('Possible item damage, repair, lock or parts-only sale');
  }
  if (/\b(?:tien coc|dat coc|gia coc|chi la coc|deposit only)\b/.test(itemText.replace(/\bkhong (?:can )?(?:dat coc|coc)\b/g,''))) {
    eligibility = 'excluded'; profile.priceBasis = 'deposit'; risks.push('Advertised amount may be a deposit');
  }
  if (/\b(?:gia tu|gia chi tu|tuy cau hinh|nhieu cau hinh|nhieu model)\b/.test(itemText)) conflicts.push('Price or configuration describes several variants');
  if (['gpu', 'cpu', 'ram', 'ssd'].includes(kind)
    && /\b(?:ca|full|tron)\s+(?:[2-9]|\d{2})\s*(?:mon|linh kien|san pham)\b/.test(itemText)) {
    profile.priceBasis = 'bundle';
    conflicts.push('Several components share the asking price; the standalone component price is not verified');
  }
  if (itemClauses.some((clause) => /\b(?:new box|new seal|nguyen seal|moi 100%|chua su dung)\b/.test(clause))) { eligibility = 'excluded'; risks.push('Seller description states new/unopened rather than used'); }
  if (raw.attributes.is_price_not_valid === true || raw.attributes.price_available === false) conflicts.push('The source marks the advertised price as unavailable or invalid');
  const priceText = raw.description.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g,'d').toLowerCase();
  const cashPrices = [...priceText.matchAll(/\bgia(?:\s*ban)?\s*[:=]?\s*(\d+(?:[.,]\d+)*)\s*(trieu|tr|m|k|nghin|ngan|vnd|dong|d|₫)?/g)]
    .map((match) => {
      const unit = match[2] ?? 'vnd';
      const numberText = !/^(?:trieu|tr|m)$/.test(unit) && /^\d{1,3}(?:[.,]\d{3})+$/.test(match[1]!)
        ? match[1]!.replace(/[.,]/g,'') : match[1]!.replace(',', '.');
      const multiplier = /^(?:trieu|tr|m)$/.test(unit) ? 1_000_000 : /^(?:k|nghin|ngan)$/.test(unit) ? 1_000 : 1;
      return Number(numberText) * multiplier;
    });
  if (cashPrices.some((price) => !Number.isFinite(price) || Math.abs(price-raw.price) > Math.max(10_000, raw.price * .02))) conflicts.push('A stated cash price in the description differs from the displayed asking price');
  if (raw.condition === 'unknown') unknowns.push('Used condition is not verified');
  if (sourceUnavailable(raw)) unknowns.push('The source marks this listing as unavailable; its price is retained only as a historical observation');
  if (kind === 'gpu' && (!profile.gpu || !profile.vramGb)) unknowns.push('Exact GPU variant and video-memory capacity are required');
  if (/^(?:GT 730|GT 1030|GTX 1650)$/.test(profile.gpu ?? '') && !profile.gpuMemoryType) unknowns.push('This GPU has materially different memory-generation variants; its memory type is required');
  if (kind === 'laptop' && (!profile.model || !profile.cpu || !profile.ramGb || !profile.storageGb || !profile.gpu)) unknowns.push('Exact laptop model, processor, GPU, RAM and storage must be known');
  if (kind === 'desktop' && !profile.cpu && !profile.gpu && !profile.ramGb) unknowns.push('No valuable desktop components identified');
  if (kind === 'cpu' && !profile.cpu) unknowns.push('Exact processor model is missing');
  if (kind === 'ssd' && (!profile.storageGb || !profile.storageType || profile.storageType === 'SSD')) unknowns.push('Storage capacity and interface are missing');
  if (eligibility === 'eligible' && (conflicts.length || unknowns.length)) eligibility = 'review';
  for (const field of ['model', 'cpu', 'gpu'] as const) {
    if (profile[field]) {
      const quote = text.split('\n').find((line) => field === 'gpu' ? gpuModels(line).includes(profile.gpu!)
        : field === 'cpu' ? cpuModels(line).includes(profile.cpu!) : normalize(line).includes(normalize(profile[field]!).replace(/^apple /, '')));
      if (quote) evidence.push({ field, quote: quote.slice(0, 240) });
    }
  }
  if (profile.vramGb) {
    const quote = vramQuotes[0];
    if (quote) evidence.push({ field: 'vramGb', quote: quote.slice(0,240) });
  }
  return { kind, profile, eligibility, risks, unknowns, conflicts, evidence,
    confidence: eligibility === 'eligible' ? 0.75 : 0.35, method: 'rules',
    status: 'Parsed from seller text and structured fields; AI assessment not performed' };
}

export function profileKey(profile: HardwareProfile, kind: HardwareKind): string {
  const fields = kind === 'gpu' ? ['gpu', 'vramGb', 'gpuMemoryType'] : kind === 'cpu' ? ['cpu']
    : kind === 'ram' ? ['perUnitGb', 'ramType', 'ramFormFactor', 'ramSpeedMhz', 'ramEcc']
      : kind === 'ssd' ? ['storageGb', 'storageType'] : ['model', 'modelYear', 'screenInches', 'cpuCores', 'gpuCores', 'cpu', 'gpu', 'gpuClass', 'vramGb', 'gpuMemoryType', 'gpuInclusion', 'ramGb', 'ramType', 'ramFormFactor', 'ramSpeedMhz', 'ramEcc', 'perUnitGb', 'quantity', 'storageGb', 'storageType'];
  return `${kind}:${fields.map((field) => normalize(String(profile[field as keyof HardwareProfile] ?? '?'))).join('|')}`;
}
