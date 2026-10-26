import type { Assessment, HardwareProfile, RawListing } from '../shared/types.ts';
import { cpuModels, gpuModels, listingText, normalize } from './hardware.ts';
import { isMacBookListing } from './macbook.ts';

export const LAPTOP_PARTS_POLICY = 1;
/**
 * Approximate used-part values reviewed on 26 October 2026 from stored used listings (see docs/data-sources.md).
 * RAM is the median implied price per GB between otherwise identical used laptops; the data cannot separate
 * generations. SSD values are the per-GB median of independent used-SSD sellers. Recalculate with
 * scripts/laptop-part-values.ts and update by hand.
 */
export const PART_VALUES = { reviewedAt: '2026-10-26', ramPerGb: 100_000, nvmePerGb: 2_500, sataPerGb: 2_000 } as const;
/** RAM/SSD adjustments may move a comparison laptop's asking price by at most this share. */
export const MAX_ADJUSTMENT_SHARE = 0.25;

export interface LaptopPartsKey {
  cpu: string;
  gpu: string;
  gpuLabel: string;
  gpuAssumed: boolean;
  ramGb: number;
  storageGb: number;
  hdd: boolean;
  sata: boolean;
}

/** One exact processor model, including "i5 11th 1135G7" spellings. A family or generation alone is not a model. */
export function laptopCpu(value: string | null): string | null {
  if (!value) return null;
  const models = cpuModels(value);
  if (models.length) return models.length === 1 ? models[0]! : null;
  const text = normalize(value), family = text.match(/\bi([3579])\b/)?.[1];
  const skus = [...new Set([...text.matchAll(/\b(\d{4,5}(?:g[147]|[a-z]{1,2}))\b/g)].map(match => match[1]!))];
  return family && skus.length === 1 ? `I${family}-${skus[0]!.toUpperCase()}` : null;
}

/** U, G-suffix, P and Y Intel parts, Core (Ultra) U/V parts and Ryzen U parts rarely ship with a discrete GPU. */
export function lowPowerCpu(cpu: string): boolean {
  return /^I[3579]-\d{4,5}(?:G\d|U|P|Y)$/.test(cpu) || /^CORE (?:ULTRA )?[3579] \d{3}[UV]$/.test(cpu)
    || /^RYZEN [3579] (?:PRO )?\d{4}U$/.test(cpu);
}

const integrated = /\b(?:intel\s*(?:uhd|hd|iris|arc\s*graphics)|iris\s*xe|uhd\s*graphics|integrated|onboard|tich hop|radeon\s*(?:vega|graphics|\d{3}m)|arc\s*1[34]0[vt])\b/;
function laptopGpu(p: HardwareProfile, raw: RawListing, cpu: string): { key: string; label: string; assumed: boolean } | null {
  if (p.gpuInclusion === 'absent' || p.gpuClass === 'integrated' || p.gpuClass !== 'mobile' && integrated.test(normalize(p.gpu ?? ''))) {
    return { key: 'integrated', label: 'Integrated graphics', assumed: false };
  }
  if (p.gpu) {
    const models = gpuModels(p.gpu);
    return models.length === 1 && p.vramGb ? { key: `${models[0]} ${p.vramGb}GB`, label: `${models[0]} ${p.vramGb} GB`, assumed: false } : null;
  }
  if (p.gpuClass === 'mobile') return null;
  // A low-power processor is assumed to use its integrated graphics when the ad names no discrete card.
  return lowPowerCpu(cpu) && !gpuModels(listingText(raw)).length ? { key: 'integrated', label: 'Integrated graphics (assumed)', assumed: true } : null;
}

/** Same parts means the same processor model and graphics; brand, model line, year and screen are ignored. */
export function laptopPartsKey(raw: RawListing, assessment: Assessment): { key: LaptopPartsKey | null; reason: string } {
  if (assessment.kind !== 'laptop' || isMacBookListing(raw)) return { key: null, reason: 'MacBooks are compared with new retail and launch prices' };
  const p = assessment.profile, cpu = laptopCpu(p.cpu);
  if (!cpu) return { key: null, reason: p.cpu ? 'The processor is not stated as one exact model' : 'The processor model is not stated' };
  if (!p.ramGb || !p.storageGb) return { key: null, reason: 'RAM and storage capacity must be stated' };
  const gpu = laptopGpu(p, raw, cpu);
  if (!gpu) return { key: null, reason: p.gpu || p.gpuClass === 'mobile' ? 'The graphics model or its video memory is not stated'
    : 'No graphics are stated, and this processor class often has a discrete GPU' };
  const storage = normalize(p.storageType ?? '');
  return { key: { cpu, gpu: gpu.key, gpuLabel: gpu.label, gpuAssumed: gpu.assumed, ramGb: p.ramGb, storageGb: p.storageGb,
    hdd: /hdd/.test(storage) && !/ssd|nvme/.test(storage), sata: /sata/.test(storage) }, reason: '' };
}

const fieldNote = /^(\w+) (?:is not stated reliably|has no verifiable supporting quote)\.$/;
const detailFields: Record<string, string> = {
  model: 'Model name', gpu: 'Graphics model', gpuClass: 'Graphics model', vramGb: 'Graphics memory', gpuMemoryType: 'Graphics memory type',
  storageType: 'SSD interface', ramType: 'RAM generation', ramSpeedMhz: '', ramFormFactor: '', perUnitGb: '', quantity: '',
  cpu: '', ramGb: '', storageGb: '',
};
/**
 * Once the parts key is known, a review note about the model name, graphics details or RAM/SSD types becomes a
 * displayed missing detail (its label, or '' when nothing is worth showing). Condition, price, classification and
 * unrecognized notes still block a verdict (null).
 */
export function partsDetail(note: string): string | null {
  const field = fieldNote.exec(note)?.[1];
  if (field) return field in detailFields ? detailFields[field]! : null;
  if (note === 'Exact laptop model, processor, GPU, RAM and storage must be known') return '';
  if (note.startsWith('This GPU has materially different memory-generation variants')) return 'Graphics memory type';
  const text = normalize(note);
  if (/condition|working|battery|\bpin\b|chai|wear|tinh trang|refurb|like ?new|grade|charger|\bsac\b|unavailable|verified|classif|confidence|listing type|price|\bgia\b|asking|deposit|\bcoc\b|multiple|several|bundle|quantity|units|vai con/.test(text)) return null;
  if (/vram|gddr|gpu memory|graphics|\bgpu\b|do hoa|\bcard\b|onboard|\bvga\b|radeon|iris/.test(text)) return 'Graphics model';
  if (/storage type|drive type|ssd\/hdd|hdd\/ssd|ssd\/nvme|interface|loai o|nvme|sata/.test(text)) return 'SSD interface';
  if (/\bram\b|memory|bo nho/.test(text) && /ddr|generation|stick|channel|layout|form factor|speed|\bbus\b/.test(text)) return 'RAM generation';
  if (/model|series|\bdong\b|ten may/.test(text)) return 'Model name';
  return null;
}

/** With the parts key known, missing model, graphics and RAM/SSD-type details lower confidence instead of blocking. */
export function withPartsDetails(raw: RawListing, assessment: Assessment): Assessment {
  if (assessment.kind !== 'laptop' || assessment.eligibility === 'excluded' || !assessment.computer) return assessment;
  const { key } = laptopPartsKey(raw, assessment);
  if (!key) return assessment;
  const details: string[] = [], blocking: string[] = [];
  for (const note of assessment.unknowns) {
    const detail = partsDetail(note);
    if (detail === null) blocking.push(note); else if (detail) details.push(detail);
  }
  if (key.gpuAssumed) details.push('Graphics assumed integrated: low-power processor and no discrete GPU named');
  if (!assessment.profile.model) details.push('Model name');
  if (!key.hdd && !key.sata && !/nvme/i.test(assessment.profile.storageType ?? '')) details.push('SSD interface');
  const eligibility = assessment.eligibility === 'review' && !blocking.length && !assessment.conflicts.length && !assessment.risks.length
    ? 'eligible' : assessment.eligibility;
  return { ...assessment, unknowns: blocking, eligibility,
    computer: { ...assessment.computer, missing: [...new Set([...assessment.computer.missing, ...details])] } };
}
