import type { Assessment, HardwareProfile, RawListing } from '../shared/types.ts';
import type { LaptopSpecRequest, MemoryTypeLookup } from './techapi.ts';
import { isMacBookListing } from './macbook.ts';

export function laptopSpecRequest(profile: HardwareProfile): LaptopSpecRequest | null {
  if (!profile.model) return null;
  return { model: profile.model, cpu: profile.cpu, modelYear: profile.modelYear, screenInches: profile.screenInches,
    cpuCores: profile.cpuCores, gpuCores: profile.gpuCores, ramGb: profile.ramGb, storageGb: profile.storageGb };
}

/** Catalog references are context, never seller facts or proof of installed capacity. */
export function enrichLaptopSpecs(raw: RawListing, input: Assessment, cache?: MemoryTypeLookup): Assessment {
  if (input.kind !== 'laptop') return input;
  const assessment = { ...input, ...(input.computer ? {computer:{...input.computer,missing:[...input.computer.missing]}} : {}) };
  delete assessment.laptopSpecReferences;
  const request = laptopSpecRequest(assessment.profile);
  if (request && cache?.getLaptops) {
    const records = cache.getLaptops(request);
    if (records.length) assessment.laptopSpecReferences = records.slice(0,8).map(record => ({...record,sourceUrls:[...record.sourceUrls]}));
  }
  if (isMacBookListing(raw) && assessment.computer) {
    const fields = [[assessment.profile.screenInches,'Screen size'],[assessment.profile.modelYear,'Model year'],
      [assessment.profile.cpuCores,'CPU core-count variant'],[assessment.profile.gpuCores,'GPU core-count variant']] as const;
    assessment.computer.missing = [...new Set([...assessment.computer.missing,...fields.filter(([value])=>!value).map(([,label])=>label)])];
  }
  return assessment;
}
