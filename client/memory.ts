import type { Assessment, HardwareProfile } from "../shared/types";

export type MemoryTypeMetadata = Pick<Assessment, "memoryTypeSources" | "memoryTypeInferences" | "laptopSpecReferences">;

export const ramMinimums = [8, 16, 24, 32, 48, 64, 96, 128];
export const vramMinimums = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48];

export function hasDedicatedVram(profile: HardwareProfile): boolean {
  return profile.gpuInclusion !== "absent" && profile.gpuClass !== "integrated";
}

export function memoryDescription(
  profile: HardwareProfile,
  kind: "ram" | "vram",
  metadata?: MemoryTypeMetadata,
): string {
  const capacity = kind === "ram" ? profile.ramGb : profile.vramGb;
  const type = kind === "ram" ? profile.ramType : profile.gpuMemoryType;
  const field = kind === "ram" ? "ramType" : "gpuMemoryType";
  const inference = metadata?.memoryTypeInferences?.find((entry) => entry.field === field);
  const inferred = type && (
    metadata?.memoryTypeSources?.some((source) => source.field === field && source.value === type) ||
    (inference?.manufacturerVerified && inference.types.length === 1 && inference.types[0] === type)
  );
  if (type) {
    const value = capacity !== null ? `${capacity} GB ${type}` : `${type} · capacity unknown`;
    return inferred ? `${value} · inferred` : value;
  }
  const possibleTypes = [...new Set(inference?.types.filter(Boolean) ?? [])];
  if (possibleTypes.length) {
    const value = `${capacity !== null ? `${capacity} GB` : "Capacity unknown"} · possible ${possibleTypes.join(" / ")}`;
    return inference?.manufacturerVerified ? value : `${value} · unconfirmed`;
  }
  if (capacity !== null) return `${capacity} GB · type unknown`;
  return "Capacity / type unknown";
}

export function hasMemoryTypeEstimates(metadata: MemoryTypeMetadata): boolean {
  return Boolean(metadata.memoryTypeSources?.length || metadata.memoryTypeInferences?.some((entry) => entry.types.length));
}

export function hasTechApiMemoryData(metadata: MemoryTypeMetadata): boolean {
  const isTechApiUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "gettechapi.github.io" ||
        (parsed.hostname === "github.com" && /^\/gettechapi\/techapi(?:\/|$)/i.test(parsed.pathname));
    } catch {
      return false;
    }
  };
  return Boolean(metadata.laptopSpecReferences?.some((source) => isTechApiUrl(source.url)) ||
    metadata.memoryTypeSources?.some((source) => isTechApiUrl(source.url)) ||
    metadata.memoryTypeInferences?.some((entry) => entry.sources.some((source) =>
      /\bTechAPI\b/i.test(source.label) || isTechApiUrl(source.url))));
}
