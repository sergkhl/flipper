import type { Assessment, ComputerDetails, Evidence, HardwareProfile, PricedConfiguration, RawListing } from '../shared/types.ts';
import { assessWithRules, gpuModels, listingText, normalize } from './hardware.ts';
import { enrichMemoryTypes } from './memory-types.ts';
import type { MemoryTypeLookup } from './techapi.ts';
import { isMacBookListing } from './macbook.ts';
import { enrichLaptopSpecs } from './laptop-specs.ts';

const unique = <T,>(items: T[]): T[] => [...new Set(items)];
const noDiscreteGpu = /\b(?:(?:khong|ko|k|chua)\s+(?:(?:co|kem|gom|gan)\s+)?(?:card(?:\s+do hoa)?|vga|gpu)(?:\s+roi)?|(?:no|without|excluding)\s+(?:discrete\s+)?(?:gpu|graphics(?:\s+card)?|vga)|(?:onboard|integrated)\s+only|chi\s+(?:(?:dung|co|kem)\s+)?(?:card\s+)?onboard)\b/;
const withDiscreteGpu = /\b(?:(?:co|kem|bao gom|including|with)\s+(?:card(?:\s+do hoa)?|vga|gpu)|(?:gia\s+(?:ban\s+)?)?(?:ca bo|full bo|full pc|tron bo|complete pc))\b/;
const priceConflict = 'A stated cash price in the description differs from the displayed asking price';
const variantsConflict = 'Price or configuration describes several variants';
const unresolvedVariant = 'Displayed asking price does not select a verified computer configuration';

function sourceLines(raw: RawListing): { quote: string; text: string }[] {
  return listingText(raw).split('\n').map((quote) => ({ quote: quote.trim(), text: normalize(quote) })).filter((line) => line.quote);
}

function computerDetails(lines: ReturnType<typeof sourceLines>, kind: Assessment['kind']): ComputerDetails {
  const evidence: Evidence[] = [];
  const details: ComputerDetails = {
    formFactor: null, cpuCount: null, motherboard: null, psu: null, case: null, cooling: null,
    ramEcc: null, ramReplaceable: null, storageReplaceable: null, missing: [], evidence,
  };
  const record = <K extends keyof Omit<ComputerDetails, 'missing' | 'evidence'>>(field: K, value: ComputerDetails[K], quote: string) => {
    details[field] = value; evidence.push({ field: `computer.${field}`, quote });
  };
  // Store seller text as seller text. A model name is not a license to invent a PSU,
  // chassis, socket, memory layout, or upgrade path from external specifications.
  for (const line of lines) {
    const { text, quote } = line;
    if (!details.motherboard && (/\b(?:mainboard|motherboard|bo mach chu|main)\s*[:=-]?\s+\S/.test(text)
      || /^(?:[*•+-]\s*)?(?:asus|msi|gigabyte|asrock|biostar)\s+[abhxz]\d{3}[a-z0-9-]*\b/.test(text))) record('motherboard', quote, quote);
    if (!details.psu && /\b(?:psu|power supply|nguon)\s*[:=-]?\s+(?:\S)/.test(text)) record('psu', quote, quote);
    if (!details.case && /\b(?:case|chassis|vo may|vo thung)\s*[:=-]?\s+\S/.test(text)) record('case', quote, quote);
    if (!details.cooling && /\b(?:tan nhiet|tan aio|cpu cooler|cooling|aio cooler|tan nuoc)\b/.test(text)) record('cooling', quote, quote);
    if (kind === 'desktop' && !details.formFactor) {
      if (/\b(?:all[- ]in[- ]one|may tinh lien man|aio pc|pc aio)\b/.test(text)) record('formFactor', 'aio', quote);
      else if (/\b(?:sff|small form factor)\b/.test(text)) record('formFactor', 'sff', quote);
      else if (/\b(?:mini\s*(?:pc|computer)|pc\s*mini|tiny pc|micro pc)\b/.test(text)) record('formFactor', 'mini', quote);
      else if (/\b(?:tower|mid[- ]tower|full[- ]tower)\b/.test(text)) record('formFactor', 'tower', quote);
    }
    if (/\b(?:dual\s*(?:cpu|xeon|processor|socket)|2\s*(?:cpu|processors?|socket)|2\s*[x×]\s*xeon)\b/.test(text)) record('cpuCount', 2, quote);
    else if (details.cpuCount === null && /\b(?:single\s*(?:cpu|processor|socket)|1\s*(?:cpu|processor|socket))\b/.test(text)) record('cpuCount', 1, quote);
    if (/\b(?:non[- ]ecc|khong ecc)\b/.test(text)) record('ramEcc', 'non-ecc', quote);
    else if (/\b(?:rdimm|registered|ecc\s*(?:reg|registered))\b/.test(text)) record('ramEcc', 'registered', quote);
    else if (details.ramEcc === null && /\becc\b/.test(text)) record('ramEcc', 'ecc', quote);
  }
  const ramFixed = lines.find(({ text }) => /\b(?:ram|memory)\b.{0,45}\b(?:soldered|onboard|han|khong (?:the )?(?:nang cap|thay))\b|\b(?:soldered|han)\s+(?:ram|memory)\b/.test(text));
  const ramRemovable = lines.find(({ text }) => /\b(?:ram|memory)\b.{0,45}\b(?:replaceable|removable|upgradable|upgradeable|nang cap|thay the|thao roi)\b|\b(?:nang cap|thay the|thao roi)\s+(?:ram|memory)\b|\b(?:khe|slots?)\s+(?:cam\s+)?(?:ram|so[- ]?dimm)\b|\bso[- ]?dimm\b.{0,20}\bslots?\b/.test(text));
  if (ramFixed) record('ramReplaceable', false, ramFixed.quote);
  else if (ramRemovable) record('ramReplaceable', true, ramRemovable.quote);
  const storageFixed = lines.find(({ text }) => /\b(?:ssd|storage|o cung)\b.{0,45}\b(?:soldered|han|khong (?:the )?(?:nang cap|thay))\b|\b(?:soldered|han)\s+(?:ssd|storage)\b/.test(text));
  const storageRemovable = lines.find(({ text }) => /\b(?:ssd|storage|o cung)\b.{0,45}\b(?:replaceable|removable|upgradable|upgradeable|nang cap|thay the|thao roi)\b|\b(?:nang cap|thay the|thao roi)\s+(?:ssd|storage|o cung)\b|\b(?:khe|slots?)\s+(?:cam\s+)?(?:ssd|m\.?2|sata)\b|\bm\.?2\b.{0,20}\bslots?\b/.test(text));
  if (storageFixed) record('storageReplaceable', false, storageFixed.quote);
  else if (storageRemovable) record('storageReplaceable', true, storageRemovable.quote);
  const required: [keyof ComputerDetails, string][] = kind === 'desktop'
    ? [['formFactor', 'Desktop form factor'], ['cpuCount', 'Processor count'], ['motherboard', 'Motherboard'], ['psu', 'Power supply'], ['case', 'Case'], ['cooling', 'Cooling'], ['ramEcc', 'RAM ECC status']]
    : [['ramReplaceable', 'RAM replaceability'], ['storageReplaceable', 'Storage replaceability']];
  details.missing = required.filter(([field]) => details[field] === null).map(([, label]) => label);
  return details;
}

function amounts(text: string): number[] {
  // Prices require a money unit, or an explicit price label for unadorned VND.
  const unitPrices = [...text.matchAll(/\b(\d+(?:[.,]\d+)*)\s*(trieu|tr|m|k|nghin|ngan|vnd|dong|d|₫)(?=\b|\s|[.,;:]|$)/g)];
  const plain = [...text.matchAll(/\bgia(?:\s*ban)?\s*[:=]?\s*(\d{6,9})(?!\d)(?!\s*(?:gb|mhz))/g)];
  return unique([...unitPrices, ...plain].map((match) => {
    const unit = match[2] ?? 'vnd';
    const million = /^(?:trieu|tr|m)$/.test(unit);
    const value = !million && /^\d{1,3}(?:[.,]\d{3})+$/.test(match[1]!)
      ? Number(match[1]!.replace(/[.,]/g, '')) : Number(match[1]!.replace(',', '.'));
    return Math.round(value * (million ? 1_000_000 : /^(?:k|nghin|ngan)$/.test(unit) ? 1_000 : 1));
  }).filter((price) => Number.isFinite(price) && price >= 100_000));
}

function withoutDiscreteGpu(profile: HardwareProfile): HardwareProfile {
  return { ...profile, gpuInclusion: 'absent', gpu: profile.gpuClass === 'integrated' ? profile.gpu : null,
    gpuClass: profile.gpuClass === 'integrated' ? 'integrated' : null, vramGb: null, gpuMemoryType: null };
}

function verifiedPriceOptions(lines: ReturnType<typeof sourceLines>, profile: HardwareProfile): PricedConfiguration[] {
  const hasGpu = profile.gpu !== null && profile.gpuClass !== 'integrated';
  const options: PricedConfiguration[] = [];
  for (const { text, quote } of lines) {
    if (!/\bgia\b|\bprice\b|\b(?:without|including|with)\b/.test(text)) continue;
    const prices = amounts(text);
    // Multiple amounts on one line need a richer association than this bounded rule.
    if (prices.length !== 1) continue;
    if (noDiscreteGpu.test(text)) options.push({ label: 'PC without discrete GPU', price: prices[0]!, profile: withoutDiscreteGpu(profile), evidence: quote });
    else if (hasGpu && withDiscreteGpu.test(text)) options.push({ label: `PC including ${profile.gpu}`, price: prices[0]!, profile: { ...profile, gpuInclusion: 'included' }, evidence: quote });
  }
  return options.filter((option, index) => options.findIndex((other) => other.price === option.price && other.profile.gpuInclusion === option.profile.gpuInclusion) === index);
}

/** Enrich stored or fresh assessments using only the supplied seller observation. */
export function enrichComputerAssessment(raw: RawListing, input: Assessment, cache?: MemoryTypeLookup): Assessment {
  if (input.kind === 'ram') {
    const ramEcc = assessWithRules(raw).profile.ramEcc;
    return enrichMemoryTypes(raw, { ...input, profile: { ...input.profile, ramEcc: ramEcc ?? null } },cache);
  }
  if (input.kind !== 'desktop' && input.kind !== 'laptop') return enrichMemoryTypes(raw, input,cache);
  // Reparse retained rules assessments so parser corrections also apply on reads.
  // AI profiles remain intact: this layer adds source-backed configuration semantics.
  const reparseMac = isMacBookListing(raw);
  const parsed = input.method === 'rules' || reparseMac ? assessWithRules(raw) : input;
  const assessment: Assessment = { ...parsed, profile: { ...parsed.profile }, risks: [...parsed.risks], unknowns: [...parsed.unknowns], conflicts: [...parsed.conflicts], evidence: [...parsed.evidence] };
  if (input.method === 'ai' && !reparseMac) {
    const source = assessWithRules(raw);
    if (!assessment.profile.gpuClass && source.profile.gpuClass === 'integrated') {
      assessment.profile.gpuClass = 'integrated';
      assessment.profile.gpu = source.profile.gpu;
      assessment.profile.vramGb = null;
    }
    assessment.profile.ramEcc = source.profile.ramEcc ?? null;
    if (source.profile.ramSpeedMhz !== null) assessment.profile.ramSpeedMhz = source.profile.ramSpeedMhz;
    if (source.conflicts.includes('Title, description or parameters disagree about RAM speed')) {
      assessment.profile.ramSpeedMhz = null;
      assessment.conflicts = unique([...assessment.conflicts, 'Title, description or parameters disagree about RAM speed']);
      if (assessment.eligibility === 'eligible') assessment.eligibility = 'review';
    }
  }
  if (input.method === 'rules' || reparseMac) {
    // Only claims handled by the corrected capacity/CPU parsers can be retired by a
    // reparse. Preserve unrelated retained review information, especially price/condition.
    const reparsedFields = new Set([
      'Title, description or parameters disagree about video-memory capacity',
      'Title and description disagree about RAM capacity', 'Description and structured RAM capacity disagree',
      'Several storage capacities are stated; the offered configuration is not resolved',
      'More than one processor model is advertised',
      'Exact laptop model, processor, GPU, RAM and storage must be known', 'No valuable desktop components identified',
      'Apple GPU core-count variant is not verified',
      'Description and structured storage capacity disagree',
      'Several MacBook screen sizes are advertised', 'Several MacBook model years are advertised',
      'Several MacBook families are advertised',
      'Several Apple CPU core-count variants are stated', 'Several Apple GPU core-count variants are stated',
    ]);
    assessment.risks = unique([...assessment.risks, ...input.risks]);
    assessment.conflicts = unique([...assessment.conflicts, ...input.conflicts.filter((note) => !reparsedFields.has(note))]);
    assessment.unknowns = unique([...assessment.unknowns, ...input.unknowns.filter((note) => !reparsedFields.has(note))]);
    if (assessment.eligibility === 'eligible' && (assessment.conflicts.length || assessment.unknowns.length
      || (input.eligibility === 'review' && assessment.risks.length))) assessment.eligibility = 'review';
  }
  if (input.eligibility === 'excluded') { assessment.eligibility = 'excluded'; assessment.risks = unique([...assessment.risks, ...input.risks]); }
  const lines = sourceLines(raw);
  assessment.computer = computerDetails(lines, input.kind);
  const ramLabels = ['RAM generation', 'RAM speed', 'RAM stick layout', 'RAM form factor'];
  assessment.computer.missing = unique([...assessment.computer.missing,
    ...(!assessment.profile.ramType ? [ramLabels[0]!] : []),
    ...(!assessment.profile.ramSpeedMhz ? [ramLabels[1]!] : []),
    ...(!assessment.profile.perUnitGb || !assessment.profile.quantity ? [ramLabels[2]!] : []),
    ...(!assessment.profile.ramFormFactor ? [ramLabels[3]!] : []),
    ...(input.computer?.missing ?? []).filter(note => !ramLabels.includes(note)),
  ]);
  const optionalBaseUnknowns = assessment.unknowns.filter((note) => {
    const text = normalize(note).replace(/\b(?:cpu|processor)\s+(?=cooler|cooling)/g, '');
    return /\b(?:motherboard|mainboard|psu|power supply|case|chassis|cooling|cooler|form factor)\b/.test(text)
      && /\b(?:unknown|missing|unspecified|undocumented|unverified|not (?:known|specified|stated|provided|documented|verified)|thieu|chua ro|khong ro)\b/.test(text)
      && !/\b(?:cpu|processor|gpu|graphics|vram|ram|memory|storage|ssd|hdd|price|condition|damaged?|repairs?|repaired|locked|broken|fault|faulty|defect|defective|unsafe|underpowered|incompatible)\b/.test(text);
  });
  if (optionalBaseUnknowns.length) {
    assessment.computer.missing = unique([...assessment.computer.missing, ...optionalBaseUnknowns]);
    assessment.unknowns = assessment.unknowns.filter((note) => !optionalBaseUnknowns.includes(note));
    if (assessment.eligibility === 'review' && !assessment.unknowns.length && !assessment.conflicts.length && !assessment.risks.length) assessment.eligibility = 'eligible';
  }
  const previousIncluded = input.priceOptions?.find((option) => option.profile.gpuInclusion === 'included')?.profile;
  const profile = assessment.profile.gpuInclusion === 'absent' && previousIncluded ? { ...previousIncluded } : assessment.profile;
  const options = verifiedPriceOptions(lines, profile);
  assessment.priceOptions = options;
  const explicitAbsence = lines.find(({ text }) => noDiscreteGpu.test(text));
  const gpuCount = gpuModels(listingText(raw)).length;
  if (options.length) {
    const matching = options.filter((option) => option.price === raw.price);
    if (matching.length === 1) {
      assessment.profile = { ...matching[0]!.profile };
      assessment.evidence = assessment.evidence.filter((item) => item.field !== 'gpuInclusion');
      assessment.evidence.push({ field: 'gpuInclusion', quote: matching[0]!.evidence });
      // Resolve only the two known price-variant flags, and only if every explicitly
      // quoted price is accounted for. Condition, damage and hardware conflicts survive.
      const cashLines = lines.filter(({ text }) => /\b(?:gia|price)\b/.test(text));
      const allPricesAccountedFor = cashLines.every(({ text }) => amounts(text).every((price) => options.some((option) => option.price === price)));
      const resolved = new Set([unresolvedVariant]);
      let hadResolvedRisk = false;
      if (gpuCount <= 1 && allPricesAccountedFor) {
        resolved.add(priceConflict);
        if (options.length > 1) {
          resolved.add(variantsConflict);
          resolved.add('Offered configuration or price is ambiguous.');
          hadResolvedRisk = assessment.risks.includes('multiPrice');
          assessment.risks = assessment.risks.filter((risk) => risk !== 'multiPrice');
        }
      }
      const hadResolvedConflict = assessment.conflicts.some((conflict) => resolved.has(conflict));
      assessment.conflicts = assessment.conflicts.filter((conflict) => !resolved.has(conflict));
      if ((hadResolvedConflict || hadResolvedRisk) && assessment.eligibility === 'review' && !assessment.conflicts.length && !assessment.unknowns.length && !assessment.risks.length) assessment.eligibility = 'eligible';
    } else {
      assessment.profile.gpuInclusion = 'unknown';
      assessment.conflicts = unique([...assessment.conflicts, unresolvedVariant]);
      if (assessment.eligibility !== 'excluded') assessment.eligibility = 'review';
    }
  } else if (explicitAbsence) {
    // An unpriced optional-card advertisement cannot silently clear a known priced GPU.
    const hasAlternative = /\b(?:tuy cau hinh|nhieu cau hinh|them\s+(?:card|vga|gpu)|optional\s+(?:gpu|graphics)|co hoac khong)\b/.test(normalize(listingText(raw)));
    if (hasAlternative && assessment.profile.gpu && assessment.profile.gpuClass !== 'integrated') {
      assessment.profile.gpuInclusion = 'unknown';
      assessment.conflicts = unique([...assessment.conflicts, unresolvedVariant]);
      if (assessment.eligibility !== 'excluded') assessment.eligibility = 'review';
    } else {
      assessment.profile = withoutDiscreteGpu(assessment.profile);
      assessment.evidence = assessment.evidence.filter((item) => item.field !== 'gpuInclusion');
      assessment.evidence.push({ field: 'gpuInclusion', quote: explicitAbsence.quote });
    }
  } else {
    assessment.profile.gpuInclusion = assessment.profile.gpuClass === 'integrated' ? 'absent'
      : assessment.profile.gpu ? 'included' : 'unknown';
  }
  if (assessment.profile.gpuInclusion === 'absent' && !assessment.profile.gpu) {
    assessment.evidence = assessment.evidence.filter((item) => !['gpu', 'gpuClass', 'vramGb', 'gpuMemoryType'].includes(item.field));
  }
  const enriched = enrichMemoryTypes(raw, assessment,cache);
  if (enriched.priceOptions) enriched.priceOptions = enriched.priceOptions.map((option) => {
    const resolved = enrichMemoryTypes(raw, { ...assessment, profile: { ...option.profile } },cache);
    const { memoryTypeSources: _previousSources, memoryTypeInferences: _previousInferences, ...quoted } = option;
    return { ...quoted, profile: resolved.profile, ...(resolved.memoryTypeSources ? { memoryTypeSources: resolved.memoryTypeSources } : {}),
      ...(resolved.memoryTypeInferences ? { memoryTypeInferences: resolved.memoryTypeInferences } : {}) };
  });
  if (enriched.computer) {
    enriched.computer.missing = enriched.computer.missing.filter((note) => note !== 'RAM generation');
    if (!enriched.profile.ramType) enriched.computer.missing.unshift('RAM generation');
  }
  return enrichLaptopSpecs(raw,enriched,cache);
}

/** Expand verified asking-price alternatives without manufacturing independent sellers. */
export function expandPricedConfigurations(raw: RawListing, input: Assessment): Array<{ raw: RawListing; assessment: Assessment }> {
  const assessment = enrichComputerAssessment(raw, input);
  if (!assessment.priceOptions?.length || assessment.conflicts.includes(unresolvedVariant)) return [{ raw, assessment }];
  return assessment.priceOptions.map((option) => {
    const variantRaw = { ...raw, price: option.price };
    return { raw: variantRaw, assessment: enrichComputerAssessment(variantRaw, assessment) };
  });
}
