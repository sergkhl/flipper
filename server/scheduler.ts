import type { Category, DailyScanStatus, RefreshJob } from '../shared/types.ts';
import type { Store } from './store.ts';
import type { FlipperService } from './service.ts';
import { activeCooldown } from './source-cooldown.ts';

export const DAILY_SCAN_ZONE = 'Asia/Ho_Chi_Minh';
export const DAILY_SCAN_CATEGORIES: readonly Category[] = ['laptop', 'desktop', 'gpu'];
export const DAILY_SCAN_CATEGORY_BUDGET = 0.25;
export const DAILY_SCAN_BUDGET = 0.75;
const DAY_MS = 86_400_000;
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DAILY_SCAN_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function vietnamDay(now: Date): string { return dayFormatter.format(now); }
export function vietnamNoon(now: Date): number { return Date.parse(`${vietnamDay(now)}T12:00:00+07:00`); }
/** Strictly future noon: enabling at or after noon waits until tomorrow. */
export function nextVietnamNoon(now: Date): string {
  const noon = vietnamNoon(now);
  return new Date(noon > now.getTime() ? noon : noon + DAY_MS).toISOString();
}

export function dailyScanStatus(store: Store, active: RefreshJob | null, busy: boolean, now = new Date()): DailyScanStatus {
  const control = store.dailyScanControl(), day = vietnamDay(now);
  const today = store.dailyScanAttempts(day), lastRunDay = store.latestDailyScanDay();
  const attempts = lastRunDay ? store.dailyScanAttempts(lastRunDay) : [];
  // Include current progress without making ordinary reads write to SQLite.
  for (const attempt of attempts) if (active && attempt.job?.id === active.id) attempt.job = { ...active };
  const eligible = control.enabled && control.firstDueAt !== null && Date.parse(control.firstDueAt) <= now.getTime()
    && vietnamNoon(now) <= now.getTime() && today.length < DAILY_SCAN_CATEGORIES.length;
  const running = attempts.some(attempt => attempt.status === 'running');
  const cooldown = activeCooldown(store.sourceCooldown(), now), retries = store.scanRetries();
  for (const retry of retries) if (active && retry.job.id === active.id) {
    retry.job = { ...active }; retry.spentUsd = Math.max(retry.spentUsd, active.aiCostUsd);
  }
  const state = !control.enabled ? 'disabled' : running ? 'running'
    : cooldown ? 'cooldown'
    : eligible && store.deploymentMaintenanceActive() ? 'maintenance' : eligible && busy ? 'busy'
    : eligible ? 'due' : 'scheduled';
  return {
    enabled: control.enabled, timeZone: DAILY_SCAN_ZONE, time: '12:00', categories: [...DAILY_SCAN_CATEGORIES],
    perCategoryBudgetUsd: DAILY_SCAN_CATEGORY_BUDGET, dailyBudgetUsd: DAILY_SCAN_BUDGET,
    nextRunAt: !control.enabled ? null : eligible ? new Date(vietnamNoon(now)).toISOString()
      : control.firstDueAt && Date.parse(control.firstDueAt) > now.getTime() ? control.firstDueAt : nextVietnamNoon(now),
    state, lastRunDay, attempts, cooldown, retries,
  };
}

/** One process owns one data directory. The service owns synchronous admission. */
export class DailyScanner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  constructor(private service: FlipperService, private now: () => Date = () => new Date()) {}
  start(): void {
    if (this.started) return;
    this.service.store.interruptDailyScans(this.now());
    this.service.store.interruptScanRetries(this.now());
    this.started = true;
    this.wake();
  }
  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** Also serves as the deterministic, no-timer verification seam. */
  tick(now = this.now()): RefreshJob | null { return this.service.tryStartDailyRefresh(now); }
  private wake(): void {
    if (!this.started) return;
    try { this.tick(); }
    catch (error) { process.stderr.write(`Daily scans could not advance: ${error instanceof Error ? error.message : 'unknown error'}\n`); }
    const now = this.now(), control = this.service.store.dailyScanControl();
    const boundary = control.firstDueAt && Date.parse(control.firstDueAt) > now.getTime()
      ? Date.parse(control.firstDueAt) : Date.parse(nextVietnamNoon(now));
    this.timer = setTimeout(() => this.wake(), Math.min(15_000, Math.max(1, boundary - now.getTime())));
    this.timer.unref();
  }
}
