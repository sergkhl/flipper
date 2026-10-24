import type { AppSettings, HardwareProfile } from '../shared/types.ts';

export const MIMO_MODEL = 'xiaomi_mimo/mimo-v2.6-flash';
// OpenRouter withdrew V1.1's endpoint around 2026-10-17; V1.2 is its 27B successor.
export const DECIDER_MODEL = 'perplexity/pplx-decider-v1.2';
// Increment when assessment prompts or validation change, so old AI interpretations are not reused.
export const AI_ASSESSMENT_VERSION = 6;
export interface LiteLLMEndpoints { chatCompletionsUrl: string; decisionsUrl: string; }

// Read at client creation, after server/index.ts has loaded the project's .env.
export function liteLLMEndpoints(env: NodeJS.ProcessEnv = process.env): LiteLLMEndpoints {
  const baseUrl = (env.LITELLM_BASE_URL?.trim() || 'http://localhost:4000/v1').replace(/\/+$/, '');
  return {
    chatCompletionsUrl: baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`,
    decisionsUrl: env.LITELLM_DECISIONS_URL?.trim() || 'http://localhost:4000/openrouter/api/alpha/decisions',
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  minRamGb: 16, minVramGb: 8, includeUnknownMemory: true,
  discountPercent: 10, minComparables: 5, minProfit: 500_000,
  minRoiPercent: 15, resaleFactor: 0.9,
  costReserves: { laptop: 500_000, desktop: 500_000, gpu: 200_000 },
  aiBudgetUsd: 0.25, scanLimit: 200, benchmarkLimit: 60, aiEnabled: true,
};
export const EMPTY_PROFILE: HardwareProfile = {
  model: null, cpu: null, gpu: null, gpuClass: null, vramGb: null,
  gpuMemoryType: null,
  ramGb: null, ramType: null, ramFormFactor: null, ramSpeedMhz: null,
  storageGb: null, storageType: null, quantity: null, perUnitGb: null,
  priceBasis: 'unknown',
};
