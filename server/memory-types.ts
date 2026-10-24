import type { Assessment, Evidence, HardwareKind, MemoryTypeInference, MemoryTypeSource, RawListing } from '../shared/types.ts';
import { inferMemoryTypes, PLATFORM_CONFLICT } from './memory-inference.ts';
import type { MemoryTypeLookup } from './techapi.ts';

export const MEMORY_TYPE_CATALOG_VERSION = '2026-10-14.1';
type MemoryField = MemoryTypeSource['field'];
type TypeClaim = { value: string; quote: string };
type TypeClaims = Record<MemoryField, TypeClaim[]>;
const sellerClaims = new WeakMap<RawListing, { text: string; kind: HardwareKind; claims: TypeClaims }>();
const copyClaims = (claims: TypeClaims): TypeClaims => ({
  ramType: claims.ramType.map((claim) => ({ ...claim })), gpuMemoryType: claims.gpuMemoryType.map((claim) => ({ ...claim })),
});
export const MEMORY_TYPE_CONFLICTS: Record<MemoryField, string> = {
  ramType: 'Title, description or parameters disagree about RAM generation',
  gpuMemoryType: 'Title, description or parameters disagree about GPU memory generation',
};
const fields: MemoryField[] = ['ramType', 'gpuMemoryType'];
const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
const textOf = (raw: RawListing) => [raw.title, raw.description, ...Object.entries(raw.params).map(([key, value]) => `${key}: ${value}`)].join('\n');
export function normalizeMemoryType(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '').replace(/^DR3$/, 'DDR3');
}
function componentMarkers(line: string) {
  return [...line.matchAll(/\b(?:(?<gpu>vram|video\s+memory|gpu\s+memory|bo nho\s+(?:vga|gpu)|vga|gpu|graphics(?:\s+card)?|card(?:\s+do hoa)?|(?:rtx|gtx|gt|rx|mx)\s*-?\s*\d{3,4}m?(?:\s*(?:ti|super|xtx|xt))?|quadro\s*[a-z]?\d{3,4}|arc\s*[ab]\d{3})|(?<ram>system\s+memory|bo nho ram|ram|memory)|(?<board>mainboard|motherboard|bo mach chu|main|(?:asus|msi|gigabyte|asrock|biostar)\s+(?:(?:prime|mag|pro|tuf)\s+)*[abhxz]\d{3}[a-z0-9-]*)|(?<other>cpu|processor|ssd|hdd|nvme|storage))(?=\b|\d)/g)]
    .map((match) => ({ index: match.index!, end: match.index! + match[0].length,
      component: match.groups?.gpu ? 'gpu' : match.groups?.ram ? 'ram' : match.groups?.board ? 'board' : 'other' }));
}
export function memoryComponentBefore(line: string, index: number): string | undefined {
  const clauseStart = Math.max(line.lastIndexOf(',', index - 1), line.lastIndexOf(';', index - 1)) + 1;
  return componentMarkers(line).filter((marker) => marker.index >= clauseStart && marker.end <= index).at(-1)?.component;
}

/** Keep memory tokens in their own component clause; an unlabelled board spec is not installed RAM evidence. */
export function sellerMemoryTypes(raw: RawListing, kind: HardwareKind = raw.category): TypeClaims {
  const text = textOf(raw), previous = sellerClaims.get(raw);
  if (previous?.text === text && previous.kind === kind) return copyClaims(previous.claims);
  const claims: TypeClaims = { ramType: [], gpuMemoryType: [] };
  const hasGraphics = kind === 'gpu' || /\b(?:rtx|gtx|gt|rx|mx)\s*-?\s*\d{3,4}|\b(?:vram|vga|gpu|quadro|arc)\b/.test(fold(text));
  for (const quote of text.split('\n')) {
    const line = fold(quote).replace(/_/g, ' ');
    const tokens = [...line.matchAll(/\b(?:lp\s*ddr\s*[2-6][xlt]?|gddr\s*[3-7]x?|ddr\s*[2-6][xl]?|dr3)\b/g)];
    if (!tokens.length) continue;
    const markers = componentMarkers(line);
    for (const token of tokens) {
      const value = normalizeMemoryType(token[0]), index = token.index!;
      const clauseStart = Math.max(line.lastIndexOf(',', index - 1), line.lastIndexOf(';', index - 1)) + 1;
      const before = markers.filter((marker) => marker.index >= clauseStart && marker.end <= index).at(-1);
      const after = markers.find((marker) => marker.index >= index + token[0].length);
      let component = before?.component;
      if (value.startsWith('GDDR') && hasGraphics && component !== 'board') component = 'gpu';
      const followsWithRamCapacity = after?.component === 'ram'
        && /^\s*\d{1,3}\s*(?:gb|g)\s*$/.test(line.slice(index + token[0].length, after.index));
      if (!value.startsWith('GDDR') && component !== 'board' && followsWithRamCapacity) component = 'ram';
      const clause = line.slice(clauseStart);
      const suffixCapacity = /^\s*(?:[*•+-]\s*)?\d{1,3}\s*(?:gb|g)\s*$/.test(line.slice(clauseStart, index));
      if (!component && kind !== 'gpu' && (kind === 'ram' || /\b(?:so[- ]?dimm|dimm)\b/.test(clause)
        || suffixCapacity || /^\s*(?:[*•+-]\s*)?(?:lp\s*)?ddr\s*[2-6][xlt]?\s+\d{1,3}\s*(?:gb|g)\b/.test(clause))) component = 'ram';
      if (!component && after && after.index - index < 35 && !/[,;]/.test(line.slice(index, after.index))) component = after.component;
      if (!component && kind === 'gpu') component = 'gpu';
      const field = component === 'gpu' && !value.startsWith('LPDDR') ? 'gpuMemoryType'
        : component === 'ram' && !value.startsWith('GDDR') && kind !== 'gpu' ? 'ramType' : null;
      if (!field) continue;
      // A short contiguous excerpt stays verifiable even on long seller-description lines.
      const evidenceQuote = quote.length <= 500 ? quote : quote.slice(Math.max(0, index - 100), index + 200);
      claims[field].push({ value, quote: evidenceQuote });
    }
  }
  // Parsing and enrichment share facts only while the complete seller observation is unchanged.
  sellerClaims.set(raw, { text, kind, claims });
  return copyClaims(claims);
}

interface CatalogRecord {
  field: MemoryField;
  part: string;
  types: readonly string[];
  url: string;
  gpu?: string;
  match?: RegExp;
  variant?: RegExp;
  mobileModel?: RegExp;
}
const nvidia = 'https://www.nvidia.com/en-us/geforce/graphics-cards/compare/';
const gpuRecords = (types: readonly string[], models: string[]): CatalogRecord[] => models.map((gpu) => ({
  field: 'gpuMemoryType', part: `NVIDIA GeForce ${gpu}`, gpu, types, url: nvidia,
}));
/** Deliberately scoped, reviewed manufacturer specifications; no capacities or socket heuristics. */
const catalog: CatalogRecord[] = [
  ...gpuRecords(['GDDR6'], ['RTX 2080 TI', 'RTX 2080 SUPER', 'RTX 2080', 'RTX 2070 SUPER', 'RTX 2070', 'RTX 2060 SUPER', 'RTX 2060',
    'RTX 3070', 'RTX 3060', 'RTX 3050', 'GTX 1660 TI', 'GTX 1660 SUPER', 'GTX 1650 SUPER', 'GTX 1630', 'RTX 4060 TI', 'RTX 4060']),
  ...gpuRecords(['GDDR6X'], ['RTX 3090 TI', 'RTX 3090', 'RTX 3080 TI', 'RTX 3080', 'RTX 3070 TI',
    'RTX 4090', 'RTX 4080 SUPER', 'RTX 4080', 'RTX 4070 TI SUPER', 'RTX 4070 TI', 'RTX 4070 SUPER']),
  ...gpuRecords(['GDDR5'], ['GTX 1660']),
  ...gpuRecords(['GDDR6', 'GDDR6X'], ['RTX 3060 TI', 'RTX 4070']),
  { ...gpuRecords(['GDDR5'], ['GTX 1650'])[0]!, variant: /\bgtx\s*-?\s*1650\s*\(?\s*g5\b/ },
  { ...gpuRecords(['GDDR6'], ['GTX 1650'])[0]!, variant: /\bgtx\s*-?\s*1650\s*\(?\s*g6\b/ },
  { field: 'gpuMemoryType', gpu: 'RX 6600 XT', part: 'AMD Radeon RX 6600 XT', types: ['GDDR6'],
    url: 'https://www.amd.com/en/products/graphics/desktops/radeon/6000-series/amd-radeon-rx-6600-xt.html' },
  { field: 'ramType', part: 'ASUS PRIME B660M-A D4', types: ['DDR4'],
    match: /\b(?:asus\s+)?prime\s+b660m[- ]a\s+d4\b(?!\s*(?:wifi|ii|csm)\b)/,
    url: 'https://www.asus.com/motherboards-components/motherboards/prime/prime-b660m-a-d4/techspec/' },
  { field: 'ramType', part: 'ASUS PRIME H610M-A WIFI', types: ['DDR5'],
    match: /\b(?:asus\s+)?prime\s+h610m[- ]a\s+wi[- ]?fi\b(?!\s*(?:d4|ddr4|ii|csm)\b)/,
    url: 'https://www.asus.com/me-en/motherboards-components/motherboards/prime/prime-h610m-a-wifi/techspec/' },
  { field: 'ramType', part: 'MSI MAG B760M MORTAR WIFI DDR4', types: ['DDR4'],
    match: /\b(?:msi\s+)?(?:mag\s+)?b760m\s+mortar\s+wi[- ]?fi\s+ddr4\b/,
    url: 'https://www.msi.com/Motherboard/MAG-B760M-MORTAR-WIFI-DDR4/Specification' },
  { field: 'ramType', part: 'MSI MAG B760M MORTAR DDR4', types: ['DDR4'],
    match: /\b(?:msi\s+)?(?:mag\s+)?b760m\s+mortar\s+ddr4\b/,
    url: 'https://www.msi.com/Motherboard/MAG-B760M-MORTAR-DDR4/Specification' },
  { field: 'ramType', part: 'Lenovo ThinkPad T480', types: ['DDR4'], match: /\b(?:lenovo\s+)?thinkpad\s+t480\b/,
    url: 'https://psref.lenovo.com/syspool/Sys/PDF/ThinkPad/ThinkPad_T480/ThinkPad_T480_Spec.PDF' },
  { field: 'gpuMemoryType', part: 'Lenovo ThinkPad T480 with NVIDIA GeForce MX150', gpu: 'MX150', types: ['GDDR5'],
    mobileModel: /\b(?:lenovo\s+)?thinkpad\s+t480\b/,
    url: 'https://psref.lenovo.com/syspool/Sys/PDF/ThinkPad/ThinkPad_T480/ThinkPad_T480_Spec.PDF' },
];

const gpuKey = (gpu: string | null) => fold(gpu ?? '').replace(/nvidia|geforce|amd|radeon/g, '').replace(/[^a-z0-9]/g, '');
const catalogConflict = (field: MemoryField) => `Stated ${field === 'ramType' ? 'RAM' : 'GPU memory'} generation conflicts with manufacturer specifications`;
function ownedConflict(note: string): boolean {
  return note === PLATFORM_CONFLICT || fields.some((field) => note === MEMORY_TYPE_CONFLICTS[field] || note.startsWith(catalogConflict(field)));
}

/** Derive only a missing type with one possible manufacturer value; recompute provenance on every read. */
export function enrichMemoryTypes(raw: RawListing, input: Assessment, cache?: MemoryTypeLookup): Assessment {
  const assessment: Assessment = { ...input, profile: { ...input.profile },
    evidence: input.evidence.filter((item) => !fields.includes(item.field as MemoryField)),
    conflicts: input.conflicts.filter((note) => !ownedConflict(note)), unknowns: [...input.unknowns] };
  delete assessment.memoryTypeSources;
  delete assessment.memoryTypeInferences;
  const direct = sellerMemoryTypes(raw, input.kind), text = fold(textOf(raw)).replace(/_/g, ' ');
  const targetGpu = gpuKey(input.profile.gpu);
  const sources: MemoryTypeSource[] = [];
  const inferences: MemoryTypeInference[] = [];
  for (const field of fields) {
    assessment.profile[field] = null;
    if (field === 'ramType' && !['laptop', 'desktop', 'ram'].includes(input.kind)) continue;
    if (field === 'gpuMemoryType' && (input.profile.gpuClass === 'integrated' || input.profile.gpuInclusion === 'absent')) continue;
    const values = [...new Set(direct[field].map((claim) => claim.value))];
    if (values.length > 1) {
      assessment.conflicts.push(MEMORY_TYPE_CONFLICTS[field]);
      assessment.evidence.push(...direct[field].map(({ quote }) => ({ field, quote })));
      continue;
    }
    const records = catalog.filter((record) => {
      if (record.field !== field) return false;
      if (field === 'ramType') return ['laptop', 'desktop'].includes(input.kind) && !!record.match?.test(text);
      if (!record.gpu || gpuKey(record.gpu) !== targetGpu) return false;
      return record.mobileModel ? input.profile.gpuClass === 'mobile' && record.mobileModel.test(text)
        : input.profile.gpuClass === 'desktop';
    });
    const decisive = records.filter((record) => record.variant?.test(text));
    const matching = decisive.length ? decisive : records;
    const possibleTypes = [...new Set(matching.flatMap((record) => record.types))];
    const fallback = inferMemoryTypes(raw,input,field,cache);
    if (fallback.conflict) {
      assessment.conflicts.push(fallback.conflict);
      assessment.evidence.push(...direct[field].map(({ quote }) => ({ field, quote })));
      continue;
    }
    let inferred = fallback.inference;
    if (possibleTypes.length) {
      if (field === 'ramType' && inferred?.manufacturerVerified && !possibleTypes.some(type => inferred!.types.includes(type))) {
        assessment.conflicts.push(`${catalogConflict(field)} between the identified motherboard and CPU (${matching[0]!.url})`);
        assessment.evidence.push(...direct[field].map(({ quote }) => ({ field, quote })));
        continue;
      }
      inferred = { field, types: possibleTypes.sort(), basis: matching.map(record => record.part).join(' / '),
        manufacturerVerified: true, catalogVersion: MEMORY_TYPE_CATALOG_VERSION,
        sources: [{ label: 'Manufacturer specifications', url: matching[0]!.url },
          ...(inferred?.sources.filter(source => source.label === 'TechAPI') ?? [])] };
    }
    const stated = values[0];
    if (stated) {
      assessment.evidence.push(...direct[field].map(({ quote }) => ({ field, quote })));
      if (inferred?.manufacturerVerified && !inferred.types.includes(stated)) {
        const manufacturer = inferred.sources.find(source => source.label !== 'TechAPI')!;
        assessment.conflicts.push(`${catalogConflict(field)} for ${inferred.basis} (${manufacturer.url})`);
      } else assessment.profile[field] = stated;
    } else if (inferred) {
      inferences.push(inferred);
      if (inferred.manufacturerVerified && inferred.types.length === 1) {
        assessment.profile[field] = inferred.types[0]!;
        const manufacturer = inferred.sources.find(source => source.label !== 'TechAPI')!;
        sources.push({ field, value: inferred.types[0]!, part: inferred.basis, url: manufacturer.url, catalogVersion: inferred.catalogVersion });
      }
    }
  }
  if (sources.length) assessment.memoryTypeSources = sources;
  if (inferences.length) assessment.memoryTypeInferences = inferences;
  // Retire only a type-specific missing claim that this pass actually resolves.
  assessment.unknowns = assessment.unknowns.filter((note) => {
    if ((assessment.profile.gpuMemoryType || assessment.profile.gpuClass === 'integrated' || assessment.profile.gpuInclusion === 'absent') && (/^gpuMemoryType\b/.test(note)
      || note === 'This GPU has materially different memory-generation variants; its memory type is required')) return false;
    if (assessment.profile.ramType && /^ramType\b/.test(note)) return false;
    return true;
  });
  if (!assessment.profile.gpuMemoryType && assessment.profile.gpuClass !== 'integrated' && assessment.profile.gpuInclusion !== 'absent'
    && ['gt730', 'gt1030', 'gtx1650'].includes(gpuKey(assessment.profile.gpu))) {
    const missing = 'This GPU has materially different memory-generation variants; its memory type is required';
    if (!assessment.unknowns.includes(missing)) assessment.unknowns.push(missing);
    if (assessment.eligibility === 'eligible') assessment.eligibility = 'review';
  }
  assessment.conflicts = [...new Set(assessment.conflicts)];
  assessment.evidence = assessment.evidence.filter((item, index, all) => all.findIndex((other) => other.field === item.field && other.quote === item.quote) === index);
  if (assessment.eligibility !== 'excluded' && assessment.conflicts.length) assessment.eligibility = 'review';
  else if (assessment.eligibility === 'review' && !assessment.unknowns.length && !assessment.conflicts.length && !assessment.risks.length
    && (input.conflicts.some(ownedConflict) || input.unknowns.length !== assessment.unknowns.length)) assessment.eligibility = 'eligible';
  return assessment;
}

export function directMemoryTypeFacts(raw: RawListing, kind: HardwareKind): { values: Record<MemoryField, string | null>; evidence: Evidence[]; conflicts: string[] } {
  const claims = sellerMemoryTypes(raw, kind), values: Record<MemoryField, string | null> = { ramType: null, gpuMemoryType: null };
  const evidence: Evidence[] = [], conflicts: string[] = [];
  for (const field of fields) {
    const types = [...new Set(claims[field].map((claim) => claim.value))];
    values[field] = types.length === 1 ? types[0]! : null;
    evidence.push(...claims[field].map(({ quote }) => ({ field, quote })));
    if (types.length > 1) conflicts.push(MEMORY_TYPE_CONFLICTS[field]);
  }
  return { values, evidence, conflicts };
}
