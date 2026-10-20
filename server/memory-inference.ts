import type { Assessment, MemoryTypeInference, RawListing } from '../shared/types.ts';
import type { MemoryTypeLookup, TechMemoryRecord } from './techapi.ts';

export const MEMORY_INFERENCE_VERSION = '2026-10-14.1';
export const PLATFORM_CONFLICT = 'Identified CPU and socket disagree about the RAM platform';
const cpuKey = (name: string) => name.toLowerCase().replace(/\b(?:intel|core|amd)\b/g, '').replace(/[^a-z0-9]/g, '');
const gpuKey = (name: string) => name.toLowerCase().replace(/\b(?:nvidia|geforce|amd|radeon)\b/g, '').replace(/[^a-z0-9]/g, '');
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
interface ReviewedCPU { name: string; types: string[]; socket: string; url: string; }
const intel = (sku: string, slug: string) => `https://www.intel.com/content/www/us/en/products/sku/${sku}/${slug}/specifications.html`;
/** Complete generation sets reviewed against the linked manufacturer, not TechAPI's verified flag. */
const reviewedCPUs: ReviewedCPU[] = [
  { name: 'i5-12400', types: ['DDR4','DDR5'], socket: 'LGA1700', url: intel('134586','intel-core-i512400-processor-18m-cache-up-to-4-40-ghz') },
  { name: 'i5-12400F', types: ['DDR4','DDR5'], socket: 'LGA1700', url: intel('134587','intel-core-i512400f-processor-18m-cache-up-to-4-40-ghz') },
  { name: 'i5-14400F', types: ['DDR4','DDR5'], socket: 'LGA1700', url: intel('236777','intel-core-i5-processor-14400f-20m-cache-up-to-4-70-ghz') },
  { name: 'i5-11400F', types: ['DDR4'], socket: 'LGA1200', url: intel('212271','intel-core-i511400f-processor-12m-cache-up-to-4-40-ghz') },
  { name: 'i5-10400F', types: ['DDR4'], socket: 'LGA1200', url: intel('199278','intel-core-i510400f-processor-12m-cache-up-to-4-30-ghz') },
  { name: 'i3-8100', types: ['DDR4'], socket: 'LGA1151', url: intel('126688','intel-core-i38100-processor-6m-cache-3-60-ghz') },
  { name: 'i3-9100F', types: ['DDR4'], socket: 'LGA1151', url: intel('190886','intel-core-i39100f-processor-6m-cache-up-to-4-20-ghz') },
  { name: 'i5-9400F', types: ['DDR4'], socket: 'LGA1151', url: intel('190883','intel-core-i59400f-processor-9m-cache-up-to-4-10-ghz') },
  { name: 'i7-12700H', types: ['DDR4','DDR5','LPDDR4X','LPDDR5'], socket: 'BGA1744', url: intel('132228','intel-core-i712700h-processor-24m-cache-up-to-4-70-ghz') },
  { name: 'i5-1245U', types: ['DDR4','DDR5','LPDDR4X','LPDDR5'], socket: 'BGA1744', url: intel('226260','intel-core-i51245u-processor-12m-cache-up-to-4-40-ghz') },
  { name: 'Ryzen 5 5600X', types: ['DDR4'], socket: 'AM4', url: 'https://www.amd.com/en/products/processors/desktops/ryzen/5000-series/amd-ryzen-5-5600x.html' },
  ...['7600','7600X'].map(model => ({ name: `Ryzen 5 ${model}`, types: ['DDR5'], socket: 'AM5',
    url: `https://www.amd.com/en/products/processors/desktops/ryzen/7000-series/amd-ryzen-5-${model.toLowerCase()}.html` })),
];
const reviewedSockets: Record<string, { types: string[]; url: string }> = {
  AM4: { types: ['DDR4'], url: 'https://www.amd.com/en/products/processors/chipsets/am4.html' },
  AM5: { types: ['DDR5'], url: 'https://www.amd.com/en/products/processors/chipsets/am5.html' },
  LGA1700: { types: ['DDR4','DDR5'], url: 'https://www.intel.com/content/www/us/en/support/articles/000092149/processors.html' },
};
type Resolution = { inference?: MemoryTypeInference; conflict?: string };
function sources(rows: readonly TechMemoryRecord[], manufacturerUrl?: string): MemoryTypeInference['sources'] {
  const result = rows.map(row => ({ label: 'TechAPI', url: row.url }));
  if (manufacturerUrl) result.push({ label: 'Manufacturer specifications', url: manufacturerUrl });
  return result.filter((s,i,all) => all.findIndex(other => other.url === s.url) === i);
}
function hint(field: MemoryTypeInference['field'], types: string[], basis: string, rows: readonly TechMemoryRecord[], url?: string): Resolution {
  const unique = [...new Set(types)].sort();
  return unique.length ? { inference: { field, types: unique, basis, manufacturerVerified: !!url,
    sources: sources(rows,url), catalogVersion: MEMORY_INFERENCE_VERSION } } : {};
}
function explicitSockets(raw: RawListing): string[] {
  const result: string[] = [];
  for (const quote of [raw.title,raw.description,...Object.entries(raw.params).map(([k,v]) => `${k}: ${v}`)].join('\n').split(/[\n;]/)) {
    const line = fold(quote);
    // Cooler compatibility lists and historical upgrade suggestions do not identify the installed platform.
    if (/\b(?:cooler|cooling|tan nhiet|compatible|tuong thich|upgrade|nang cap|ho tro|support)\b/.test(line)) continue;
    if (!/\b(?:socket|platform|main|mainboard|motherboard|nen tang)\b/.test(line) && quote !== raw.title) continue;
    for (const match of line.matchAll(/\b(am[45]|(?:fc)?lga\s*-?\s*1700)\b/g)) result.push(match[1]!.replace(/^fc/,'').replace(/[\s-]/g,'').toUpperCase());
  }
  return [...new Set(result)];
}

/** A cached source is a hint until a complete allowed-type set has independent manufacturer review. */
export function inferMemoryTypes(raw: RawListing, input: Assessment, field: MemoryTypeInference['field'], cache?: MemoryTypeLookup): Resolution {
  const p = input.profile;
  if (field === 'ramType') {
    if (input.kind !== 'desktop' && input.kind !== 'laptop') return {};
    const rows = p.cpu ? cache?.get('cpu',p.cpu) ?? [] : [];
    const reviewed = p.cpu ? reviewedCPUs.find(record => cpuKey(record.name) === cpuKey(p.cpu!)) : undefined;
    const sockets = explicitSockets(raw);
    const socket = sockets[0];
    const cpu = p.cpu ? cpuKey(p.cpu) : '';
    const vendorMismatch = socket && cpu && (/^(?:i[3579]|xeon|pentium|celeron)/.test(cpu) && /^AM[45]$/.test(socket)
      || /^(?:ryzen|athlon|fx)/.test(cpu) && socket === 'LGA1700');
    const cachedSockets = [...new Set(rows.map(row => row.socket?.toUpperCase().replace(/^FC/,'').replace(/[\s-]/g,'')).filter(Boolean))];
    if (sockets.length > 1 || vendorMismatch || (reviewed && socket && socket !== reviewed.socket)
      || (!reviewed && socket && cachedSockets.length && !cachedSockets.includes(socket))) return { conflict: PLATFORM_CONFLICT };
    if (reviewed) return hint(field,reviewed.types,`${reviewed.name} · ${reviewed.socket}`,rows,reviewed.url);
    const platform = socket ? reviewedSockets[socket] : undefined;
    if (platform) {
      const result = hint(field,platform.types,`Socket ${socket}${p.cpu ? ' · CPU compatibility unconfirmed' : ''}`,rows,platform.url);
      // The socket's allowed memory is known, but an unreviewed CPU/platform association is not verified.
      if (p.cpu && result.inference) result.inference.manufacturerVerified = false;
      return result;
    }
    return hint(field,rows.flatMap(row => row.types),p.cpu ?? 'Unconfirmed CPU identity',rows);
  }
  if (!p.gpu || !p.gpuClass || p.gpuClass === 'integrated' || p.gpuInclusion === 'absent') return {};
  const rows = cache?.get('gpu',p.gpu,p.gpuClass) ?? [];
  if (gpuKey(p.gpu) === 'rtx3070ti' && p.gpuClass === 'mobile') {
    return hint(field,['GDDR6'],'NVIDIA GeForce RTX 3070 Ti Laptop GPU',rows,'https://www.nvidia.com/en-us/geforce/laptops/30-series/');
  }
  return hint(field,rows.flatMap(row => row.types),`${p.gpu} · ${p.gpuClass}`,rows);
}
