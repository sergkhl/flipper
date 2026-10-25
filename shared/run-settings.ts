import type { RunParameters } from './types.ts';

export const MAX_RUN_WORKERS = 20;
export const DEFAULT_SCAN_LIMIT = 200;

export function runParameters(settings: RunParameters): RunParameters {
  const { scanLimit, benchmarkLimit, aiBudgetUsd, aiEnabled, minRamGb, minVramGb, includeUnknownMemory } = settings;
  return { scanLimit, benchmarkLimit, aiBudgetUsd, aiEnabled, minRamGb, minVramGb, includeUnknownMemory };
}
