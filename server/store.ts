import * as sqlite from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AI_ASSESSMENT_VERSION, DEFAULT_SETTINGS } from './config.ts';
import { assessWithRules } from './hardware.ts';
import type { AIReceipt, AppSettings, Assessment, Category, Coverage, DailyScanAttempt, DailyScanControl, ListingState, RawListing, ReferencePrice, RefreshJob, SavedSearch, ScanRetry, SourceCooldown } from '../shared/types.ts';
import { DAILY_SCAN_BUDGET, DAILY_SCAN_CATEGORIES, DAILY_SCAN_CATEGORY_BUDGET, nextVietnamNoon, vietnamDay, vietnamNoon } from './scheduler.ts';
import { SOURCE_WINDOW_MS, SOURCE_INTERVAL_MS, SourceDeferredError, type SourceBudgetStatus } from './source-policy.ts';
import type { RefreshProgress } from '../shared/types.ts';
import { type StoredRun, validateRunLimits } from './runs.ts';

export interface PoolProgress { raws: RawListing[]; nextPage: number; exhausted: boolean; detailedIds: string[]; }

const Database = ('Database' in sqlite ? sqlite.Database : sqlite.DatabaseSync) as typeof sqlite.DatabaseSync;
export const EMPTY_STATE: ListingState = { saved: false, dismissed: false, costReserve: null, expectedResale: null };
export interface StoredListing {
  raw: RawListing; assessment: Assessment; reference: ReferencePrice | null; reason: string; state: ListingState; local: boolean;
}
export function assessmentHash(raw: RawListing): string {
  return createHash('sha256').update(JSON.stringify({ title: raw.title, description: raw.description, price: raw.price,
    condition: raw.condition, params: raw.params, category: raw.category,
    sourceStatus:raw.attributes.status, priceAvailable:raw.attributes.price_available,
    invalidPrice:raw.attributes.is_price_not_valid, unavailable:raw.attributes._sourceUnavailable })).digest('hex');
}

export class Store {
  private db: sqlite.DatabaseSync;
  private directory: string;
  constructor(directory = '.data', memory = false) {
    this.directory = directory;
    if (!memory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(memory ? ':memory:' : join(directory, 'flipper.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_root ON runs(root_id);
      CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, category TEXT NOT NULL, local INTEGER NOT NULL DEFAULT 0,
        raw TEXT NOT NULL, assessment TEXT NOT NULL, reference_json TEXT, reason TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, listing_id TEXT NOT NULL, at TEXT NOT NULL, price REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS history_listing ON history(listing_id,at);
      CREATE TABLE IF NOT EXISTS collections (category TEXT NOT NULL, query TEXT NOT NULL, listing_id TEXT NOT NULL,
        PRIMARY KEY(category, query, listing_id));
      CREATE TABLE IF NOT EXISTS coverage (category TEXT NOT NULL, query TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(category, query));
      CREATE TABLE IF NOT EXISTS searches (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assessments (hash TEXT PRIMARY KEY, json TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pools (cache_key TEXT PRIMARY KEY, json TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pool_progress (cache_key TEXT PRIMARY KEY, json TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_requests (id INTEGER PRIMARY KEY, at TEXT NOT NULL, category TEXT NOT NULL, automatic INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS source_requests_at ON source_requests(at);
      CREATE TABLE IF NOT EXISTS source_runtime (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, json TEXT NOT NULL, cost REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_scan_control (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_scan_attempts (day TEXT NOT NULL, category TEXT NOT NULL,
        budget_usd REAL NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, json TEXT NOT NULL,
        settings_json TEXT NOT NULL, PRIMARY KEY(day,category));
      CREATE TABLE IF NOT EXISTS source_cooldowns (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scan_retries (id TEXT PRIMARY KEY, original_job_id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL, query TEXT NOT NULL, status TEXT NOT NULL, due_at TEXT NOT NULL,
        json TEXT NOT NULL, settings_json TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '');`);
    const columns = this.db.prepare('PRAGMA table_info(scan_retries)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'scope')) this.db.exec("ALTER TABLE scan_retries ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
    this.db.exec(`DROP INDEX IF EXISTS scan_retries_pending;
      CREATE UNIQUE INDEX IF NOT EXISTS scan_retries_pending_v2 ON scan_retries(category,query,scope) WHERE status IN ('waiting','running');`);
  }
  close(): void { this.db.close(); }
  saveRun(run: StoredRun, now = new Date()): void {
    this.db.prepare(`INSERT INTO runs(id,root_id,state,updated_at,json) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,json=excluded.json`)
      .run(run.id, run.rootId, run.state, now.toISOString(), JSON.stringify(run));
  }
  getRun(id: string): StoredRun | null {
    const row = this.db.prepare('SELECT json FROM runs WHERE id=?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  runHistory(rootId: string): StoredRun[] {
    return this.db.prepare('SELECT json FROM runs WHERE root_id=? ORDER BY rowid').all(rootId).map(row => JSON.parse(row.json as string));
  }
  latestRun(rootId: string): StoredRun | null {
    const row = this.db.prepare('SELECT json FROM runs WHERE root_id=? ORDER BY rowid DESC LIMIT 1').get(rootId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  listRuns(offset = 0, limit = 51): StoredRun[] {
    return this.db.prepare(`SELECT r.json FROM runs r WHERE NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.root_id=r.root_id AND newer.rowid>r.rowid)
      ORDER BY CASE WHEN r.state IN ('collecting','assessing','comparing') THEN 0 WHEN r.state='waiting' THEN 1 ELSE 2 END, r.rowid DESC LIMIT ? OFFSET ?`)
      .all(limit, offset).map(row => JSON.parse(row.json as string));
  }
  pruneRuns(now = new Date()): void {
    const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM runs WHERE root_id IN (SELECT r.root_id FROM runs r
      WHERE r.state IN ('complete','cancelled') AND r.updated_at<?
      AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.root_id=r.root_id AND newer.rowid>r.rowid))`).run(cutoff);
  }
  interruptRuns(now = new Date()): void {
    // Queue transitions are durable before the final journal write. Reconcile
    // that small crash window before deciding which work was interrupted.
    for (const row of this.db.prepare('SELECT json FROM scan_retries').all()) {
      const retry: ScanRetry = JSON.parse(row.json as string), run = this.getRun(retry.job.id);
      if (!run || !['collecting', 'assessing', 'comparing', 'waiting'].includes(run.state)) continue;
      const state = retry.status === 'running' ? 'collecting' : retry.status;
      this.saveRun({ ...run, state, retryId: retry.id, progress: retry.progress ?? run.progress,
        job: { ...retry.job, status: state === 'interrupted' ? 'cancelled' : state,
          aiCostUsd: Math.max(retry.spentUsd, run.job.aiCostUsd), ...(state === 'waiting' ? { resumeAt: retry.dueAt } : {}) } }, now);
    }
    const rows = this.db.prepare("SELECT json FROM runs WHERE state IN ('collecting','assessing','comparing')").all();
    for (const row of rows) {
      const run: StoredRun = JSON.parse(row.json as string);
      run.state = 'interrupted';
      run.job = { ...run.job, status: 'cancelled', completedAt: now.toISOString(),
        aiCostUsd: Math.max(run.job.aiCostUsd, run.parameters.aiBudgetUsd),
        message: 'Interrupted by restart. Resume explicitly; uncertain AI charges retain the original allowance.' };
      this.saveRun(run, now);
    }
    this.pruneRuns(now);
  }
  /** Import only known legacy snapshots; unavailable manual history is not invented. */
  importRunHistory(now = new Date(), onlyRetry?: string): void {
    if (!onlyRetry && this.runtimeValue<boolean>('runs_history_imported')) return;
    const cutoff = now.getTime() - 90 * 86_400_000;
    const existing = new Set(this.db.prepare('SELECT id FROM runs').all().map(row => row.id));
    const add = (job: RefreshJob, settings: AppSettings, state: StoredRun['state'], metadata: Partial<StoredRun>) => {
      if (existing.has(job.id) || (['complete', 'cancelled'].includes(state) && Date.parse(job.completedAt ?? job.startedAt) < cutoff)) return;
      settings = { ...DEFAULT_SETTINGS, ...settings, scanLimit: job.target };
      if (state === 'interrupted') job = { ...job, aiCostUsd: Math.max(job.aiCostUsd, settings.aiBudgetUsd) };
      const { scanLimit, benchmarkLimit, aiBudgetUsd, aiEnabled, minRamGb, minVramGb, includeUnknownMemory } = settings;
      this.saveRun({ id: job.id, rootId: job.retryOf ?? job.id, job, state, settings,
        parameters: { scanLimit, benchmarkLimit, aiBudgetUsd, aiEnabled, minRamGb, minVramGb, includeUnknownMemory },
        workers: { marketplaceWorkers: settings.marketplaceWorkers, aiWorkers: settings.aiWorkers },
        automatic: false, aiIssue: null,
        progress: { ids: [], nextPage: 1, collected: false, assessedIds: [], comparedIds: [], initialDetails: 0 }, ...metadata,
      }, new Date(job.completedAt ?? job.startedAt));
    };
    for (const row of onlyRetry ? [] : this.db.prepare('SELECT json,settings_json FROM daily_scan_attempts ORDER BY day, rowid').all()) {
      const attempt: DailyScanAttempt = JSON.parse(row.json as string);
      if (attempt.job) add(attempt.job, JSON.parse(row.settings_json as string),
        attempt.status === 'running' ? attempt.job.status : attempt.status,
        { automatic: true, scheduledDay: attempt.day, aiIssue: attempt.aiIssue });
    }
    // Retry snapshots carry the most useful checkpoint and waiting state.
    for (const row of this.db.prepare('SELECT json,settings_json FROM scan_retries WHERE (? IS NULL OR id=?) ORDER BY rowid').all(onlyRetry ?? null, onlyRetry ?? null)) {
      const retry: ScanRetry = JSON.parse(row.json as string);
      add({ ...retry.job, ...(retry.status === 'waiting' ? { status: 'waiting', resumeAt: retry.dueAt } : {}),
        aiCostUsd: Math.max(retry.spentUsd, retry.job.aiCostUsd) },
      { ...JSON.parse(row.settings_json as string), aiBudgetUsd: retry.budgetUsd },
      retry.status === 'running' ? retry.job.status : retry.status,
      { rootId: retry.originalJobId, retryId: retry.id, automatic: retry.automatic ?? retry.dailyDay !== null,
        listingId: retry.listingId, scheduledDay: retry.dailyDay ?? undefined, aiIssue: retry.aiIssue,
        ...(retry.progress ? { progress: retry.progress } : {}) });
    }
    if (!onlyRetry) this.setRuntimeValue('runs_history_imported', true);
  }
  scanRetry(id: string): ScanRetry | null {
    const row = this.db.prepare('SELECT json FROM scan_retries WHERE id=?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  deploymentMaintenanceActive(): boolean { return existsSync(join(this.directory, '.deployment-maintenance')); }
  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string } | undefined;
    return row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.json), costReserves: { ...DEFAULT_SETTINGS.costReserves, ...JSON.parse(row.json).costReserves } }
      : structuredClone(DEFAULT_SETTINGS);
  }
  saveSettings(settings: AppSettings): void {
    validateRunLimits(settings);
    this.db.prepare('INSERT INTO settings(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(settings));
  }
  getKey(): string {
    if (process.env.LITELLM_API_KEY?.trim()) return process.env.LITELLM_API_KEY.trim();
    const path = join(this.directory, 'secrets.json');
    if (!existsSync(path)) return '';
    try {
      const key: unknown = JSON.parse(readFileSync(path, 'utf8')).liteLlmKey;
      return typeof key === 'string' ? key.trim() : '';
    } catch { return ''; }
  }
  saveKey(key: string): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'secrets.json');
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { /* No saved credentials yet. */ }
    writeFileSync(path, JSON.stringify({ ...existing, liteLlmKey: key.trim() }), { mode: 0o600 }); chmodSync(path, 0o600);
  }
  putListing(raw: RawListing, assessment: Assessment = assessWithRules(raw), local = false): StoredListing {
    const previous = this.getListing(raw.id);
    const state = previous?.state ?? { ...EMPTY_STATE };
    const unchanged = previous && assessmentHash(previous.raw) === assessmentHash(raw);
    const selectedAssessment = unchanged && previous.assessment.method === 'ai' && assessment.method === 'rules' ? previous.assessment : assessment;
    const sameInterpretation = unchanged && previous.assessment.kind === selectedAssessment.kind
      && previous.assessment.eligibility === selectedAssessment.eligibility
      && JSON.stringify(previous.assessment.profile) === JSON.stringify(selectedAssessment.profile)
      && JSON.stringify(previous.assessment.computer) === JSON.stringify(selectedAssessment.computer)
      && JSON.stringify(previous.assessment.priceOptions) === JSON.stringify(selectedAssessment.priceOptions)
      && JSON.stringify(previous.assessment.memoryTypeSources ?? []) === JSON.stringify(selectedAssessment.memoryTypeSources ?? [])
      && JSON.stringify(previous.assessment.conflicts) === JSON.stringify(selectedAssessment.conflicts);
    const reference = sameInterpretation ? previous.reference : null;
    const reason = sameInterpretation ? previous.reason : 'Nationwide comparison has not been collected for this configuration';
    this.db.prepare(`INSERT INTO listings(id,category,local,raw,assessment,reference_json,reason,state) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET category=excluded.category, local=MAX(local,excluded.local), raw=excluded.raw,
      assessment=excluded.assessment, reference_json=excluded.reference_json, reason=excluded.reason`).run(raw.id, raw.category, local ? 1 : 0,
      JSON.stringify(raw), JSON.stringify(selectedAssessment), reference ? JSON.stringify(reference) : null, reason, JSON.stringify(state));
    if (!previous || previous.raw.price !== raw.price) this.db.prepare('INSERT INTO history(listing_id,at,price) VALUES(?,?,?)').run(raw.id, raw.observedAt, raw.price);
    return { raw, assessment: selectedAssessment, reference, reason, state, local: local || !!previous?.local };
  }
  getListing(id: string): StoredListing | null {
    const row = this.db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? this.decode(row) : null;
  }
  private decode(row: Record<string, unknown>): StoredListing {
    return { raw: JSON.parse(row.raw as string), assessment: JSON.parse(row.assessment as string),
      reference: row.reference_json ? JSON.parse(row.reference_json as string) : null, reason: row.reason as string,
      state: JSON.parse(row.state as string), local: !!row.local };
  }
  localListings(category: Category, query?: string): StoredListing[] {
    const rows = query === undefined ? this.db.prepare('SELECT * FROM listings WHERE local=1 AND category=?').all(category)
      : this.db.prepare(`SELECT l.* FROM listings l JOIN collections c ON c.listing_id=l.id WHERE l.local=1 AND c.category=? AND c.query=?`).all(category, query);
    return rows.map((row) => this.decode(row));
  }
  marketListings(category: Category, historical = false): StoredListing[] {
    if (!historical) return this.localListings(category, '');
    return this.db.prepare(`SELECT l.* FROM listings l WHERE l.local=1 AND l.category=?
      AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.category=l.category AND c.query='' AND c.listing_id=l.id)`)
      .all(category).map(row => this.decode(row));
  }
  setCollection(category: Category, query: string, ids: string[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM collections WHERE category=? AND query=?').run(category, query);
      const stmt = this.db.prepare('INSERT OR IGNORE INTO collections(category,query,listing_id) VALUES(?,?,?)');
      for (const id of ids) stmt.run(category, query, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setAssessment(id: string, assessment: Assessment): void {
    this.db.prepare('UPDATE listings SET assessment=?,reference_json=NULL,reason=? WHERE id=?').run(JSON.stringify(assessment), 'Nationwide comparison needs recalculation', id);
  }
  setReference(id: string, reference: ReferencePrice | null, reason: string): void {
    this.db.prepare('UPDATE listings SET reference_json=?,reason=? WHERE id=?').run(reference ? JSON.stringify(reference) : null, reason, id);
  }
  setState(id: string, updates: Partial<ListingState>): StoredListing | null {
    const listing = this.getListing(id); if (!listing) return null;
    const state = { ...listing.state, ...updates };
    this.db.prepare('UPDATE listings SET state=? WHERE id=?').run(JSON.stringify(state), id);
    return { ...listing, state };
  }
  history(id: string): { at: string; price: number }[] {
    return this.db.prepare('SELECT at,price FROM history WHERE listing_id=? ORDER BY at DESC LIMIT 100').all(id) as { at: string; price: number }[];
  }
  counts(): Record<Category, number> {
    return Object.fromEntries(['laptop', 'desktop', 'gpu'].map((category) => [category,
      (this.db.prepare(`SELECT COUNT(*) as n FROM listings l JOIN collections c ON c.listing_id=l.id
        WHERE l.local=1 AND l.category=? AND c.category=l.category AND c.query=''`).get(category) as { n: number }).n])) as Record<Category, number>;
  }
  saveCoverage(coverage: Coverage): void {
    this.db.prepare('INSERT INTO coverage(category,query,json) VALUES(?,?,?) ON CONFLICT(category,query) DO UPDATE SET json=excluded.json')
      .run(coverage.category, coverage.query, JSON.stringify(coverage));
  }
  coverage(category: Category, query: string): Coverage | null {
    const row = this.db.prepare('SELECT json FROM coverage WHERE category=? AND query=?').get(category, query) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  searches(): SavedSearch[] { return this.db.prepare('SELECT json FROM searches ORDER BY rowid DESC').all().map((row) => JSON.parse(row.json as string)); }
  saveSearch(search: Omit<SavedSearch, 'id'>): SavedSearch {
    const saved = { ...search, id: randomUUID() };
    this.db.prepare('INSERT INTO searches(id,json) VALUES(?,?)').run(saved.id, JSON.stringify(saved)); return saved;
  }
  deleteSearch(id: string): void { this.db.prepare('DELETE FROM searches WHERE id=?').run(id); }
  cachedAssessment(raw: RawListing): Assessment | null {
    const row = this.db.prepare('SELECT json FROM assessments WHERE hash=?').get(`${AI_ASSESSMENT_VERSION}:${assessmentHash(raw)}`) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  cacheAssessment(raw: RawListing, assessment: Assessment): void {
    this.db.prepare('INSERT OR REPLACE INTO assessments(hash,json,at) VALUES(?,?,?)').run(`${AI_ASSESSMENT_VERSION}:${assessmentHash(raw)}`, JSON.stringify(assessment), new Date().toISOString());
  }
  getPool(key: string, maxAgeMs: number): RawListing[] | null {
    const row = this.db.prepare('SELECT json,at FROM pools WHERE cache_key=?').get(key) as { json: string; at: string } | undefined;
    if (!row || Date.now() - Date.parse(row.at) >= maxAgeMs) return null;
    const pool: RawListing[] = JSON.parse(row.json);
    return pool.every(raw => Date.now() - Date.parse(raw.observedAt) < maxAgeMs) ? pool : null;
  }
  putPool(key: string, pool: RawListing[]): void {
    this.db.prepare('INSERT OR REPLACE INTO pools(cache_key,json,at) VALUES(?,?,?)').run(key, JSON.stringify(pool), new Date().toISOString());
  }
  poolProgress(key: string, maxAgeMs: number): PoolProgress | null {
    const row = this.db.prepare('SELECT json,at FROM pool_progress WHERE cache_key=?').get(key) as { json: string; at: string } | undefined;
    if (!row || Date.now() - Date.parse(row.at) >= maxAgeMs) return null;
    const progress: PoolProgress = JSON.parse(row.json);
    return progress.raws.every(raw => Date.now() - Date.parse(raw.observedAt) < maxAgeMs) ? progress : null;
  }
  savePoolProgress(key: string, progress: PoolProgress): void {
    this.db.prepare('INSERT OR REPLACE INTO pool_progress(cache_key,json,at) VALUES(?,?,?)').run(key, JSON.stringify(progress), new Date().toISOString());
  }
  runtimeValue<T>(key: string): T | null {
    const row = this.db.prepare('SELECT json FROM source_runtime WHERE key=?').get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  setRuntimeValue(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO source_runtime(key,json) VALUES(?,?)').run(key, JSON.stringify(value));
  }
  sourceBudgetStatus(now = new Date()): SourceBudgetStatus {
    const limits = this.getSettings();
    const cutoff = new Date(now.getTime() - SOURCE_WINDOW_MS).toISOString();
    const rows = this.db.prepare('SELECT category,automatic,COUNT(*) AS n FROM source_requests WHERE at>? GROUP BY category,automatic').all(cutoff) as { category: Category; automatic: number; n: number }[];
    const categoryUsed: Record<Category, number> = { laptop: 0, desktop: 0, gpu: 0 };
    let used = 0, automaticUsed = 0;
    for (const row of rows) { used += row.n; if (row.automatic) { automaticUsed += row.n; categoryUsed[row.category] += row.n; } }
    return { limit: limits.requestLimit, used, automaticUsed, manualUsed: used - automaticUsed, categoryUsed,
      remaining: Math.max(0, limits.requestLimit - used), automaticCategoryLimit: limits.automaticCategoryRequestLimit,
      manualReserve: limits.requestLimit - limits.automaticRequestLimit,
      nextRequestAt: this.runtimeValue<string>('next_source_request') };
  }
  /** Reserve before dispatch; an interrupted attempt remains charged. */
  reserveSourceRequest(category: Category, automatic: boolean, now: Date, intervalMs = SOURCE_INTERVAL_MS,
    pacing?: { worker: string; proxy: string }): string | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const status = this.sourceBudgetStatus(now), limits = this.getSettings(), cutoff = new Date(now.getTime() - SOURCE_WINDOW_MS).toISOString();
      const deadlines: number[] = [];
      const oldest = (where: string, args: Array<string | number>) => {
        const row = this.db.prepare(`SELECT MIN(at) AS at FROM source_requests WHERE at>? ${where}`).get(cutoff, ...args) as { at: string };
        return Date.parse(row.at) + SOURCE_WINDOW_MS;
      };
      if (status.used >= limits.requestLimit) deadlines.push(oldest('', []));
      if (automatic && status.automaticUsed >= limits.automaticRequestLimit) deadlines.push(oldest('AND automatic=1', []));
      if (automatic && status.categoryUsed[category] >= limits.automaticCategoryRequestLimit) deadlines.push(oldest('AND automatic=1 AND category=?', [category]));
      if (deadlines.length) throw new SourceDeferredError(new Date(Math.max(...deadlines)).toISOString(), 'request_budget');
      const keys = pacing ? [`source_worker:${pacing.worker}`, `source_proxy:${createHash('sha256').update(new URL(pacing.proxy).hostname).digest('hex')}`] : ['next_source_request'];
      const next = Math.max(0, ...keys.map(key => Date.parse(this.runtimeValue<string>(key) ?? '') || 0));
      if (next > now.getTime()) {
        this.db.exec('COMMIT'); return new Date(next).toISOString();
      }
      this.db.prepare('INSERT INTO source_requests(at,category,automatic) VALUES(?,?,?)').run(now.toISOString(), category, automatic ? 1 : 0);
      const until = new Date(now.getTime() + intervalMs).toISOString();
      for (const key of keys) this.setRuntimeValue(key, until);
      if (pacing) {
        const values = this.db.prepare("SELECT json FROM source_runtime WHERE key LIKE 'source_worker:%'").all() as { json: string }[];
        this.setRuntimeValue('next_source_request', values.map(row => JSON.parse(row.json) as string).sort()[0] ?? until);
      }
      this.db.prepare('DELETE FROM source_requests WHERE at<=?').run(new Date(now.getTime() - SOURCE_WINDOW_MS * 2).toISOString());
      this.db.exec('COMMIT'); return null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addReceipt(receipt: AIReceipt): void {
    this.db.prepare('INSERT OR IGNORE INTO receipts(id,json,cost) VALUES(?,?,?)').run(receipt.id, JSON.stringify(receipt), receipt.costUsd);
  }
  totalCost(): number { return (this.db.prepare('SELECT COALESCE(SUM(cost),0) AS total FROM receipts').get() as { total: number }).total; }

  sourceCooldown(): SourceCooldown | null {
    const row = this.db.prepare('SELECT json FROM source_cooldowns WHERE id=1').get() as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  recordSourceCooldown(value: SourceCooldown): SourceCooldown {
    if (!Number.isFinite(Date.parse(value.until)) || !Number.isFinite(Date.parse(value.observedAt))) throw new Error('Invalid source cooldown');
    const previous = this.sourceCooldown();
    if (previous && Date.parse(previous.until) >= Date.parse(value.until)) return previous;
    const normalized = { ...value, until: new Date(value.until).toISOString(), observedAt: new Date(value.observedAt).toISOString() };
    this.db.prepare('INSERT INTO source_cooldowns(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(normalized));
    return normalized;
  }
  scanRetries(): ScanRetry[] {
    return this.db.prepare(`SELECT json FROM scan_retries ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,due_at DESC LIMIT 30`)
      .all().map(row => JSON.parse(row.json as string));
  }
  pendingScanRetry(category: Category, query: string, listingId = ''): ScanRetry | null {
    const row = this.db.prepare("SELECT json FROM scan_retries WHERE category=? AND query=? AND scope=? AND status IN ('waiting','running')").get(category, query, listingId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  deferScanRetry(job: RefreshJob, settings: AppSettings, cooldown: Pick<SourceCooldown, 'until'>, dailyDay: string | null, retryId?: string,
    details: Pick<ScanRetry, 'reason' | 'automatic' | 'listingId' | 'progress'> = {}): ScanRetry {
    const row = this.db.prepare('SELECT json FROM scan_retries WHERE ' + (retryId ? 'id=?' : 'original_job_id=?')).get(retryId ?? job.id) as { json: string } | undefined;
    const previous: ScanRetry | null = row ? JSON.parse(row.json) : this.pendingScanRetry(job.category, job.query, details.listingId);
    // Re-importing an operator recovery record must never rearm a completed/cancelled retry.
    if (!retryId && previous && previous.originalJobId === job.id) return previous;
    const retry: ScanRetry = previous ? { ...previous, dueAt: cooldown.until, status: 'waiting',
      spentUsd: Math.max(previous.spentUsd, job.aiCostUsd), job: { ...job }, dailyDay, aiIssue: previous.aiIssue }
      : { id: randomUUID(), category: job.category, query: job.query, originalJobId: job.id,
        dueAt: cooldown.until, budgetUsd: settings.aiBudgetUsd, spentUsd: job.aiCostUsd,
        status: 'waiting', attempts: 0, dailyDay, job: { ...job }, aiIssue: null };
    Object.assign(retry, details);
    retry.budgetUsd = Math.min(retry.budgetUsd, settings.aiBudgetUsd);
    this.saveScanRetry(retry, settings); return retry;
  }
  private saveScanRetry(retry: ScanRetry, settings?: AppSettings): void {
    if (settings) this.db.prepare(`INSERT INTO scan_retries(id,original_job_id,category,query,status,due_at,json,settings_json,scope) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,due_at=excluded.due_at,json=excluded.json`)
      .run(retry.id, retry.originalJobId, retry.category, retry.query, retry.status, retry.dueAt, JSON.stringify(retry), JSON.stringify(settings), retry.listingId ?? '');
    else this.db.prepare('UPDATE scan_retries SET status=?,due_at=?,json=? WHERE id=?')
      .run(retry.status, retry.dueAt, JSON.stringify(retry), retry.id);
  }
  /** A retry and a due daily category share one job and the tighter captured allowance. */
  claimScanRetry(now: Date, id?: string): { retry: ScanRetry; settings: AppSettings } | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cooldown = this.sourceCooldown();
      if (cooldown && Date.parse(cooldown.until) > now.getTime()) { this.db.exec('COMMIT'); return null; }
      const row = this.db.prepare("SELECT json,settings_json FROM scan_retries WHERE status='waiting' AND due_at<=? AND (? IS NULL OR id=?) ORDER BY due_at, rowid LIMIT 1")
        .get(now.toISOString(), id ?? null, id ?? null) as { json: string; settings_json: string } | undefined;
      if (!row) { this.db.exec('COMMIT'); return null; }
      const retry: ScanRetry = JSON.parse(row.json);
      let settings: AppSettings = JSON.parse(row.settings_json);
      const day = vietnamDay(now);
      const current = this.getSettings();
      // Scope and AI allowance belong to the run. Only worker counts follow current settings.
      settings = { ...DEFAULT_SETTINGS, ...settings, marketplaceWorkers: current.marketplaceWorkers, aiWorkers: current.aiWorkers,
        benchmarkLimit: Math.min(settings.benchmarkLimit, 60), aiBudgetUsd: retry.budgetUsd };
      const sharesDailyScope = !retry.listingId && retry.query === '' && retry.job.target === current.scanLimit
        && settings.benchmarkLimit === Math.min(current.benchmarkLimit, 60)
        && (['minRamGb', 'minVramGb', 'includeUnknownMemory', 'aiEnabled'] as const).every(key => settings[key] === current[key]);
      if (sharesDailyScope && this.dailyScansDue(now)) {
        const existing = this.dailyScanAttempts(day).find(a => a.category === retry.category);
        if (!existing) {
          const claim = this.insertDailyScan(settings, now, retry.category);
          retry.budgetUsd = Math.min(retry.budgetUsd, claim.attempt.budgetUsd);
          retry.dailyDay = day;
        } else if (retry.dailyDay !== day) {
          // A fresh completed daily refresh already satisfied this recovery request.
          if (existing.status === 'complete' && existing.job && Date.parse(existing.job.completedAt ?? '') >= Date.parse(retry.job.completedAt ?? '')) {
            this.saveScanRetry({ ...retry, status: 'complete', job: existing.job });
            this.db.exec('COMMIT'); return null;
          }
          retry.dailyDay = null;
        }
      }
      const claimed: ScanRetry = { ...retry, status: 'running', attempts: retry.attempts + 1 };
      this.saveScanRetry(claimed);
      this.db.exec('COMMIT'); return { retry: claimed, settings: { ...settings, aiBudgetUsd: retry.budgetUsd } };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordScanRetry(id: string, job: RefreshJob, aiIssue: string | null, progress?: RefreshProgress): void {
    const row = this.db.prepare('SELECT json FROM scan_retries WHERE id=?').get(id) as { json: string } | undefined;
    if (!row) throw new Error('Scan retry claim is missing');
    const retry: ScanRetry = JSON.parse(row.json);
    const terminal = ['complete', 'failed', 'cancelled'].includes(job.status);
    // A cooldown failure may already have returned this claim to the waiting queue.
    const status = retry.status === 'waiting' ? 'waiting' : terminal ? job.status as 'complete' | 'failed' | 'cancelled' : 'running';
    this.saveScanRetry({ ...retry, job: { ...job }, status, aiIssue, ...(progress ? { progress } : {}), spentUsd: Math.max(retry.spentUsd, job.aiCostUsd) });
  }
  cancelScanRetry(id: string): ScanRetry {
    const row = this.db.prepare('SELECT json FROM scan_retries WHERE id=?').get(id) as { json: string } | undefined;
    if (!row) throw new Error('Scan retry not found');
    const retry: ScanRetry = JSON.parse(row.json);
    if (retry.status === 'running') throw new Error('Cancel the active refresh before cancelling its retry');
    const cancelled: ScanRetry = retry.status === 'waiting' ? { ...retry, status: 'cancelled', job: { ...retry.job, status: 'cancelled', completedAt: new Date().toISOString() } } : retry;
    this.saveScanRetry(cancelled); return cancelled;
  }
  interruptScanRetries(now = new Date()): void {
    for (const retry of this.scanRetries().filter(retry => retry.status === 'running')) {
      this.saveScanRetry({ ...retry, status: 'interrupted', spentUsd: Math.max(retry.spentUsd, retry.budgetUsd),
        job: { ...retry.job, status: 'cancelled', completedAt: now.toISOString(),
          message: 'Retry interrupted by restart; its remaining allowance is reserved and automatic repetition is disabled' } });
    }
  }

  dailyScanControl(): DailyScanControl {
    const row = this.db.prepare('SELECT json FROM daily_scan_control WHERE id=1').get() as { json: string } | undefined;
    return row ? JSON.parse(row.json) : { enabled: false, firstDueAt: null };
  }
  configureDailyScans(enabled: boolean, now = new Date()): void {
    const previous = this.dailyScanControl();
    const control: DailyScanControl = { enabled, firstDueAt: enabled && !previous.enabled ? nextVietnamNoon(now) : previous.firstDueAt };
    this.db.prepare('INSERT INTO daily_scan_control(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(control));
  }
  latestDailyScanDay(): string | null {
    return (this.db.prepare('SELECT MAX(day) AS day FROM daily_scan_attempts').get() as { day: string | null }).day;
  }
  dailyScanAttempts(day: string): DailyScanAttempt[] {
    return this.db.prepare(`SELECT json FROM daily_scan_attempts WHERE day=? ORDER BY
      CASE category WHEN 'laptop' THEN 0 WHEN 'desktop' THEN 1 ELSE 2 END`).all(day)
      .map(row => JSON.parse(row.json as string));
  }
  private dailyScansDue(now: Date): boolean {
    const control = this.dailyScanControl();
    return control.enabled && control.firstDueAt !== null && Date.parse(control.firstDueAt) <= now.getTime() && vietnamNoon(now) <= now.getTime();
  }
  private insertDailyScan(settings: AppSettings, now: Date, category: Category): { attempt: DailyScanAttempt; settings: AppSettings } {
    const day = vietnamDay(now);
    const accounted = (this.db.prepare('SELECT COALESCE(SUM(MAX(budget_usd,cost_usd)),0) AS total FROM daily_scan_attempts WHERE day=?')
      .get(day) as { total: number }).total;
    const budgetUsd = Math.min(settings.aiBudgetUsd, DAILY_SCAN_CATEGORY_BUDGET, Math.max(0, DAILY_SCAN_BUDGET - accounted));
    const captured = { ...settings, aiBudgetUsd: budgetUsd };
    const attempt: DailyScanAttempt = { day, category, status: 'running', budgetUsd,
      startedAt: now.toISOString(), completedAt: null, job: null, aiIssue: null };
    this.db.prepare('INSERT INTO daily_scan_attempts(day,category,budget_usd,json,settings_json) VALUES(?,?,?,?,?)')
      .run(day, category, budgetUsd, JSON.stringify(attempt), JSON.stringify(captured));
    return { attempt, settings: captured };
  }
  /** Atomically selects an unstarted category and retains its full crash allowance. */
  claimDailyScan(settings: AppSettings, now: Date): { attempt: DailyScanAttempt; settings: AppSettings } | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const day = vietnamDay(now), cooldown = this.sourceCooldown();
      if (!this.dailyScansDue(now) || (cooldown && Date.parse(cooldown.until) > now.getTime())) {
        this.db.exec('COMMIT'); return null;
      }
      const attempts = this.dailyScanAttempts(day), category = DAILY_SCAN_CATEGORIES.find(category =>
        !attempts.some(attempt => attempt.category === category) && !this.pendingScanRetry(category, ''));
      if (!category) { this.db.exec('COMMIT'); return null; }
      const claim = this.insertDailyScan({ ...settings, aiBudgetUsd: DAILY_SCAN_CATEGORY_BUDGET }, now, category);
      this.db.exec('COMMIT'); return claim;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordDailyScan(day: string, job: RefreshJob, aiIssue: string | null = null): void {
    const attempt = this.dailyScanAttempts(day).find(attempt => attempt.category === job.category);
    if (!attempt) throw new Error('Daily scan claim is missing');
    const terminal = ['complete', 'failed', 'cancelled', 'waiting'].includes(job.status);
    const snapshot = { ...job, aiCostUsd: Math.max(attempt.job?.aiCostUsd ?? 0, job.aiCostUsd) };
    const updated: DailyScanAttempt = { ...attempt, job: snapshot, aiIssue,
      status: terminal ? job.status as 'complete' | 'failed' | 'cancelled' | 'waiting' : 'running', completedAt: terminal ? job.completedAt : null };
    this.db.prepare('UPDATE daily_scan_attempts SET json=?,cost_usd=? WHERE day=? AND category=?')
      .run(JSON.stringify(updated), snapshot.aiCostUsd, day, job.category);
  }
  interruptDailyScans(now = new Date()): void {
    // Called once on owner startup, never by a status read or timer tick.
    const rows = this.db.prepare('SELECT day,category,json FROM daily_scan_attempts').all();
    const update = this.db.prepare('UPDATE daily_scan_attempts SET json=? WHERE day=? AND category=?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const attempt: DailyScanAttempt = JSON.parse(row.json as string);
        if (attempt.status !== 'running') continue;
        const message = 'Interrupted by an application restart; automatic retry is disabled for this date';
        const interrupted: DailyScanAttempt = { ...attempt, status: 'interrupted', completedAt: now.toISOString(),
          job: attempt.job ? { ...attempt.job, status: 'cancelled', completedAt: now.toISOString(), message, error: message } : null };
        update.run(JSON.stringify(interrupted), row.day as string, row.category as string);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
