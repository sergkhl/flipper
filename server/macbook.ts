import type { HardwareProfile, RawListing } from '../shared/types.ts';

const fold = (text: string) => text.normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[đĐ]/g, 'd').toLowerCase();
const unique = <T>(values: T[]) => [...new Set(values)];
export function isMacBookListing(raw: RawListing): boolean {
  return raw.category === 'laptop' && /\bmac\s*book\b/.test(fold(`${raw.title}\n${raw.params.pc_model ?? ''}`));
}
export function macScreenGroup(inches: number): number {
  // Apple's 13.3/13.6, 14.2, 15.3/15.4 and 16.2 panels use the
  // corresponding whole-inch model family, rather than a rounded diagonal.
  return Math.floor(inches);
}

/** Seller-stated identity only. A catalog configuration never supplies installed capacities. */
export function macBookFacts(raw: RawListing): { model: string | null; fields: Partial<HardwareProfile>; conflicts: string[]; evidence: Array<{field:string;quote:string}> } | null {
  if (!isMacBookListing(raw)) return null;
  const title = fold(raw.title), description = fold(raw.description), structuredModel = fold(raw.params.pc_model ?? '');
  const primary = `${title}\n${structuredModel}`;
  const family = primary.match(/\bmac\s*book\s*(air|pro|neo)\b/)?.[1];
  if (!family) return { model: null, fields: {}, conflicts: [], evidence: [] };
  const conflicts: string[] = [], evidence: Array<{field:string;quote:string}> = [];
  const lines = [raw.title, ...raw.description.split('\n'), ...Object.entries(raw.params).map(([key,value])=>`${key}: ${value}`)];
  const families = unique([...`${primary}\n${description}`.matchAll(/\bmac\s*book\s*(air|pro|neo)\b/g)].map(match=>match[1]!));
  if (families.length > 1) conflicts.push('Several MacBook families are advertised');
  const screenValues = (text: string) => [...text.matchAll(/\b(11(?:[.,]6)?|12|13(?:[.,][36])?|14(?:[.,]2)?|15(?:[.,][346])?|16(?:[.,]2)?|17)\s*[- ]?\s*(?:inch(?:es)?\b|in\b|["”″])/g)]
    .map(match => Number(match[1]!.replace(',', '.')));
  const namedSizes = (text: string) => [...text.matchAll(/\bmac\s*book\s*(?:air|pro|neo)\s*(1[1-7](?:[.,]\d)?)(?=\b|inch)/g)]
    .map(match=>Number(match[1]!.replace(',','.')));
  const structuredScreen = fold(raw.params.pc_screen_size ?? '').trim();
  const explicitSizes = [...screenValues(`${primary}\n${structuredScreen}`),...namedSizes(primary)];
  if (/^1[1-7](?:[.,]\d)?$/.test(structuredScreen)) explicitSizes.push(Number(structuredScreen.replace(',','.')));
  // Only model/display lines can supply a missing screen; unrelated monitor dimensions cannot.
  const modelLines = description.split('\n').filter(line => /\bmac\s*book\b|\b(?:man hinh|display|screen)\b/.test(line));
  const allSizes = [...explicitSizes, ...modelLines.flatMap(line=>[...screenValues(line),...namedSizes(line)])];
  const groups = unique(allSizes.map(macScreenGroup));
  if (groups.length > 1) conflicts.push('Several MacBook screen sizes are advertised');
  const size = groups.length === 1 ? allSizes.find(value => !Number.isInteger(value)) ?? allSizes[0]! : null;
  const modelYearValues = (text: string) => [...text.matchAll(/\b20(?:0[6-9]|[12]\d)\b/g)].map(match => Number(match[0]));
  const years = unique([...modelYearValues(primary.replace(/\b(?:bh|bao hanh|warranty)\b[^\n]*/g, '')), ...modelLines.filter(line => /\bmac\s*book\b/.test(line))
    .flatMap(line => modelYearValues(line.replace(/\b(?:bh|bao hanh|warranty)\b.*$/g, '')))]);
  if (years.length > 1) conflicts.push('Several MacBook model years are advertised');
  const counts = (type: 'cpu' | 'gpu', text = `${title}\n${description}`) => {
    const prefix = new RegExp(`\\b${type}\\s*[:=-]?\\s*(\\d{1,2})(?:\\s*[- ]?\\s*(?:core|nhan))?\\b(?!\\s*(?:gb|g)\\b)`, 'g');
    const suffix = new RegExp(`\\b(\\d{1,2})\\s*(?:[- ]?\\s*(?:core|nhan|c)\\s*)?${type}\\b`, 'g');
    // Retail titles abbreviate counts as "6C CPU/5C GPU". In "8-core CPU 7-core GPU", CPU already belongs to the preceding count;
    // it must not consume the following GPU count as a second CPU variant.
    const prefixed = [...text.matchAll(prefix)].filter(match => !/\b\d{1,2}\s*(?:[- ]?\s*(?:core|nhan|c)\s*)?$/.test(text.slice(0,match.index)));
    return unique([...prefixed, ...text.matchAll(suffix)].map(match => Number(match[1])).filter(value => value > 0 && value <= 80));
  };
  const cpuCounts = counts('cpu'), gpuCounts = counts('gpu');
  if (cpuCounts.length > 1) conflicts.push('Several Apple CPU core-count variants are stated');
  if (gpuCounts.length > 1) conflicts.push('Several Apple GPU core-count variants are stated');
  const fields: Partial<HardwareProfile> = { modelYear: years.length === 1 ? years[0]! : null, screenInches: size,
    cpuCores: cpuCounts.length === 1 ? cpuCounts[0]! : null, gpuCores: gpuCounts.length === 1 ? gpuCounts[0]! : null };
  for (const [field, value] of Object.entries(fields)) if (typeof value === 'number') {
    const quote = lines.find(line => {
      const text = fold(line);
      if (field === 'cpuCores' || field === 'gpuCores') return counts(field === 'cpuCores' ? 'cpu' : 'gpu',text).includes(value);
      if (field === 'screenInches') return [...screenValues(text),...namedSizes(text)].some(number=>number===value)
        || line === `pc_screen_size: ${raw.params.pc_screen_size}` && Number(structuredScreen.replace(',','.'))===value;
      return modelYearValues(text.replace(/\b(?:bh|bao hanh|warranty)\b[^\n]*/g,'')).includes(value);
    });
    if (quote) evidence.push({field,quote:quote.slice(0,240)});
  }
  return { model: families.length > 1 ? null : `MACBOOK ${family.toUpperCase()}${size ? ` ${macScreenGroup(size)}` : ''}`, fields, conflicts, evidence };
}

/** Explicit seller shorthand such as 16GB/512GB or M2/8/256, scoped to a MacBook ad. */
export function macBookCapacities(raw: RawListing): Array<{ramGb:number;storageGb:number;quote:string}> {
  if (!isMacBookListing(raw)) return [];
  const allowedRam = new Set([4,8,12,16,18,24,32,36,48,64,96,128]);
  const allowedStorage = new Set([128,256,512,1000,1024,2048,4096,8192]);
  const values: Array<{ramGb:number;storageGb:number;quote:string}> = [];
  for (const original of [raw.title,...raw.description.split('\n')]) {
    const text = fold(original);
    for (const match of text.matchAll(/\b(\d{1,3})\s*(?:gb|g)?\s*\/\s*(\d{1,4})\s*(tb|t|gb|g)?\b/g)) {
      const ramGb = Number(match[1]), storageGb = Number(match[2]) * (/^(?:tb|t)$/.test(match[3] ?? '') ? 1024 : 1);
      if (allowedRam.has(ramGb) && allowedStorage.has(storageGb)) values.push({ramGb,storageGb,quote:original.slice(0,240)});
    }
  }
  return values;
}
