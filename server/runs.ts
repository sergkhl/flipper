import type { AppSettings, RefreshProgress, RunSummary, RunLimits } from '../shared/types.ts';

/** Internal journal: checkpoints never cross the HTTP boundary. */
export interface StoredRun extends RunSummary {
  settings: AppSettings;
  progress: RefreshProgress;
  retryId?: string;
}

export function runSummary({ settings: _settings, progress: _progress, retryId: _retryId, ...summary }: StoredRun): RunSummary {
  return summary;
}

export function runLimits(settings: AppSettings): RunLimits {
  const { marketplaceWorkers, aiWorkers, requestLimit, automaticRequestLimit, automaticCategoryRequestLimit } = settings;
  return { marketplaceWorkers, aiWorkers, requestLimit, automaticRequestLimit, automaticCategoryRequestLimit };
}

export function validateRunLimits(value: RunLimits): void {
  for (const key of ['marketplaceWorkers', 'aiWorkers'] as const) {
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 8) throw new Error(`${key} must be an integer from 1 to 8`);
  }
  for (const key of ['requestLimit', 'automaticRequestLimit', 'automaticCategoryRequestLimit'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error(`${key} must be a positive safe integer`);
  }
  if (value.automaticCategoryRequestLimit > value.automaticRequestLimit || value.automaticRequestLimit > value.requestLimit) {
    throw new Error('Automatic category allowance must not exceed automatic total, and automatic total must not exceed overall total');
  }
}
