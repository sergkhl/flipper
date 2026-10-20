import type { SourceCooldown } from '../shared/types.ts';

export interface CooldownStore {
  sourceCooldown(): SourceCooldown | null;
  recordSourceCooldown(value: SourceCooldown): SourceCooldown;
}

export class SourceCooldownError extends Error {
  constructor(readonly cooldown: SourceCooldown) {
    super(`Chợ Tốt requested a longer rate-limit wait. Requests are paused until ${cooldown.until}.`);
    this.name = 'SourceCooldownError';
  }
}

export function activeCooldown(value: SourceCooldown | null, now = new Date()): SourceCooldown | null {
  return value && Date.parse(value.until) > now.getTime() ? value : null;
}

/** Retry-After accepts delay seconds or an HTTP date (RFC 9110 §10.2.3). */
export function retryAfterMs(headers: Headers, now: Date): number | null {
  const value = headers.get('retry-after')?.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const date = Date.parse(value), serverDate = Date.parse(headers.get('date') ?? '');
  if (!Number.isFinite(date)) return null;
  // A skewed local clock must not shorten the server's requested wait.
  return Math.max(0, date - Math.min(now.getTime(), Number.isFinite(serverDate) ? serverDate : now.getTime()));
}
