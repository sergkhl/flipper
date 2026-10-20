import * as sqlite from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AI_ASSESSMENT_VERSION, DEFAULT_SETTINGS } from './config.ts';
import { assessWithRules } from './hardware.ts';
import type { AIReceipt, AppSettings, Assessment, Category, Coverage, DailyScanAttempt, DailyScanControl, ListingState, RawListing, ReferencePrice, RefreshJob, SavedSearch } from '../shared/types.ts';
import { DAILY_SCAN_BUDGET, DAILY_SCAN_CATEGORIES, DAILY_SCAN_CATEGORY_BUDGET, nextVietnamNoon, vietnamDay, vietnamNoon } from './scheduler.ts';

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
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, json TEXT NOT NULL, cost REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_scan_control (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_scan_attempts (day TEXT NOT NULL, category TEXT NOT NULL,
        budget_usd REAL NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, json TEXT NOT NULL,
        settings_json TEXT NOT NULL, PRIMARY KEY(day,category));`);
  }
  close(): void { this.db.close(); }
  deploymentMaintenanceActive(): boolean { return existsSync(join(this.directory, '.deployment-maintenance')); }
  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT json FROM settings WHERE id=1').get() as { json: string } | undefined;
    return row ? { ...DEFAULT_SETTINGS, ...JSON.parse(row.json), costReserves: { ...DEFAULT_SETTINGS.costReserves, ...JSON.parse(row.json).costReserves } }
      : structuredClone(DEFAULT_SETTINGS);
  }
  saveSettings(settings: AppSettings): void {
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
      (this.db.prepare('SELECT COUNT(*) as n FROM listings WHERE local=1 AND category=?').get(category) as { n: number }).n])) as Record<Category, number>;
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
    return row && Date.now() - Date.parse(row.at) < maxAgeMs ? JSON.parse(row.json) : null;
  }
  putPool(key: string, pool: RawListing[]): void {
    this.db.prepare('INSERT OR REPLACE INTO pools(cache_key,json,at) VALUES(?,?,?)').run(key, JSON.stringify(pool), new Date().toISOString());
  }
  addReceipt(receipt: AIReceipt): void {
    this.db.prepare('INSERT OR IGNORE INTO receipts(id,json,cost) VALUES(?,?,?)').run(receipt.id, JSON.stringify(receipt), receipt.costUsd);
  }
  totalCost(): number { return (this.db.prepare('SELECT COALESCE(SUM(cost),0) AS total FROM receipts').get() as { total: number }).total; }

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
  /** Atomically selects an unstarted category and retains its full crash allowance. */
  claimDailyScan(settings: AppSettings, now: Date): { attempt: DailyScanAttempt; settings: AppSettings } | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const control = this.dailyScanControl(), day = vietnamDay(now);
      if (!control.enabled || !control.firstDueAt || Date.parse(control.firstDueAt) > now.getTime() || vietnamNoon(now) > now.getTime()) {
        this.db.exec('COMMIT'); return null;
      }
      const attempts = this.dailyScanAttempts(day), category = DAILY_SCAN_CATEGORIES.find(category => !attempts.some(attempt => attempt.category === category));
      if (!category) { this.db.exec('COMMIT'); return null; }
      // Above-ceiling provider reports reduce admission for later categories too.
      const accounted = (this.db.prepare('SELECT COALESCE(SUM(MAX(budget_usd,cost_usd)),0) AS total FROM daily_scan_attempts WHERE day=?')
        .get(day) as { total: number }).total;
      const budgetUsd = Math.min(DAILY_SCAN_CATEGORY_BUDGET, Math.max(0, DAILY_SCAN_BUDGET - accounted));
      const captured = { ...settings, aiBudgetUsd: budgetUsd };
      const attempt: DailyScanAttempt = { day, category, status: 'running', budgetUsd,
        startedAt: now.toISOString(), completedAt: null, job: null, aiIssue: null };
      this.db.prepare('INSERT INTO daily_scan_attempts(day,category,budget_usd,json,settings_json) VALUES(?,?,?,?,?)')
        .run(day, category, budgetUsd, JSON.stringify(attempt), JSON.stringify(captured));
      this.db.exec('COMMIT'); return { attempt, settings: captured };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordDailyScan(day: string, job: RefreshJob, aiIssue: string | null = null): void {
    const attempt = this.dailyScanAttempts(day).find(attempt => attempt.category === job.category);
    if (!attempt) throw new Error('Daily scan claim is missing');
    const terminal = ['complete', 'failed', 'cancelled'].includes(job.status);
    const snapshot = { ...job, aiCostUsd: Math.max(attempt.job?.aiCostUsd ?? 0, job.aiCostUsd) };
    const updated: DailyScanAttempt = { ...attempt, job: snapshot, aiIssue,
      status: terminal ? job.status as 'complete' | 'failed' | 'cancelled' : 'running', completedAt: terminal ? job.completedAt : null };
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
