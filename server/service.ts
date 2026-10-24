import { randomUUID } from 'node:crypto';
import type { AIStatus, AdminBootstrapResponse, AppSettings, Assessment, Category, Coverage, HardwareKind, HardwareProfile, ListingDetail, ListingsResponse, ListingState, ListingView, PublicBootstrapResponse, PublicSettings, RawListing, ReferencePrice, RefreshJob } from '../shared/types.ts';
import { DECIDER_MODEL, DEFAULT_SETTINGS, MIMO_MODEL } from './config.ts';
import { ChototClient } from './chotot.ts';
import { enrichComputerAssessment, expandPricedConfigurations } from './computer.ts';
import { assessWithRules, cpuModels, gpuModels, normalize, profileKey, sourceUnavailable } from './hardware.ts';
import { BudgetExceededError, LiteLLMClient, RefreshBudget } from './litellm.ts';
import { adjustmentRequirements, buildReference, filterComparableOffers, type AssessedListing, valueListing } from './pricing.ts';
import { EMPTY_STATE, Store, assessmentHash, type StoredListing } from './store.ts';
import type { LaptopSpecRequest, MemoryPartRequest, MemoryTypeLookup } from './techapi.ts';
import { laptopSpecRequest } from './laptop-specs.ts';
import { dailyScanStatus } from './scheduler.ts';
import type { ScanRetry, SourceCooldown } from '../shared/types.ts';
import { activeCooldown, SourceCooldownError } from './source-cooldown.ts';
import { reconcileAssessment } from './assessment.ts';
import { ProxyPool } from './proxies.ts';
import { AUTOMATIC_PART_SEARCHES, LOCAL_DETAIL_LIMIT, NATIONAL_OFFER_LIMIT, SourceDeferredError } from './source-policy.ts';
import type { RefreshProgress } from '../shared/types.ts';

const POOL_AGE_MS = 6 * 60 * 60 * 1000;
const AUTO_COHORTS = 12;
const COMPONENT_SEARCHES_PER_COHORT = 12;
const MAX_CONSECUTIVE_AI_FAILURES = 3;
type Source = Pick<ChototClient, 'search' | 'detail'> & Partial<Pick<ChototClient, 'beginJob' | 'endJob' | 'proxyStatus' | 'close'>>;
type MemoryCatalog = MemoryTypeLookup & { warm?(parts: MemoryPartRequest[], signal?: AbortSignal): Promise<void>;
  warmLaptops?(parts: LaptopSpecRequest[], signal?: AbortSignal): Promise<void> };
interface MemoryFilters { minRamGb: number; minVramGb: number; includeUnknownMemory: boolean; }
interface JobContext { job: RefreshJob; abort: AbortController; budget: RefreshBudget; settings: AppSettings; ai: LiteLLMClient | null; aiStopped: boolean; aiFailures: number; memory: MemoryFilters; pools: Map<string, AssessedListing[]>; automatic: boolean; progress: RefreshProgress; listingId?: string; scheduledDay?: string; retryId?: string; }

function applicableMemory(category: Category, profile: HardwareProfile, filters: MemoryFilters): Array<{ capacity: number | null; minimum: number }> {
  const fields = category === 'gpu' ? [] : [{ capacity: profile.ramGb, minimum: filters.minRamGb }];
  if (category === 'gpu' || (profile.gpuClass !== 'integrated' && profile.gpuInclusion !== 'absent')) {
    fields.push({ capacity: profile.vramGb, minimum: filters.minVramGb });
  }
  return fields;
}

function matchesMemory(category: Category, profile: HardwareProfile, filters: MemoryFilters): boolean {
  return applicableMemory(category, profile, filters).every(({ capacity, minimum }) =>
    capacity === null ? filters.includeUnknownMemory : minimum <= 0 || capacity >= minimum);
}

function memoryPriority(category: Category, profile: HardwareProfile, filters: MemoryFilters): number {
  const fields = applicableMemory(category, profile, filters);
  // A known failure takes precedence over another field that has not been stated.
  if (fields.some(({ capacity, minimum }) => capacity !== null && minimum > 0 && capacity < minimum)) return 2;
  // Disabled minima do not spend discovery work on unknowns unless unknowns are explicitly excluded.
  return fields.some(({ capacity, minimum }) => capacity === null && (minimum > 0 || !filters.includeUnknownMemory)) ? 1 : 0;
}

function capacityUnknown(note: string, assessment: Assessment): boolean {
  const p = assessment.profile, text = normalize(note);
  const validatedField = text.match(/^(ramgb|vramgb) (?:is not stated reliably|has no verifiable supporting quote)\.$/);
  if (validatedField) return validatedField[1] === 'ramgb' ? p.ramGb === null : p.vramGb === null;
  // Legacy parser messages combine several fields. Only relax them when memory
  // capacity is the sole remaining unknown, rather than dropping the whole check.
  if (text === 'exact gpu variant and video-memory capacity are required') return !!p.gpu && p.vramGb === null;
  if (text === 'exact laptop model, processor, gpu, ram and storage must be known') {
    return !!p.model && !!p.cpu && !!p.gpu && p.storageGb !== null && p.ramGb === null;
  }
  if (/\b(?:model|variant|generation|type|speed|layout|form factor|cpu|processor|storage|ssd|hdd|condition|price|seller)\b/.test(text)) return false;
  if (!/\b(?:capacity|size|amount|gb|gigabytes?)\b/.test(text)
    || !/\b(?:unknown|missing|unstated|unspecified|required|not (?:known|stated|specified|provided|verified)|no .*stated)\b/.test(text)) return false;
  return (p.ramGb === null && /\b(?:ram|system memory)\b/.test(text))
    || (p.vramGb === null && /\b(?:vram|video[- ]memory|gpu memory)\b/.test(text));
}

function onlyUnknownMemoryNeedsReview(item: ListingView, reference: ReferencePrice | null): boolean {
  const a = item.assessment, p = a.profile;
  if (a.eligibility !== 'review' || a.conflicts.length || a.risks.length || !a.unknowns.length
    || !a.unknowns.every((note) => capacityUnknown(note, a))) return false;
  // Keep condition, source, seller, cash-price and description checks independent
  // of the browse filter. This admission never changes eligibility or scoring.
  if (item.condition !== 'used' || sourceUnavailable(item) || !item.sellerId || !Number.isFinite(item.price) || item.price <= 0
    || !item.description.trim() || item.attributes._detailError) return false;
  if (a.kind === 'gpu' && (p.quantity !== 1 || p.priceBasis === 'bundle')) return false;
  if (/^(?:GT 730|GT 1030|GTX 1650)$/.test(p.gpu ?? '') && !p.gpuMemoryType) return false;
  if (reference && reference.average > 0 && item.price < reference.average * .1) return false;
  return true;
}

export class FlipperService {
  private source: Source;
  private jobs = new Map<string, RefreshJob>();
  private active: JobContext | null = null;
  private aiProbeRunning = false;
  private aiError: string | null = null;
  private budgetLimited = false;
  private stopping = false;
  private pending = new Set<Promise<unknown>>();
  private probeAbort: AbortController | null = null;
  constructor(readonly store: Store, source?: Source, private memoryCatalog?: MemoryCatalog,
    private now: () => Date = () => new Date()) {
    this.source = source ?? new ChototClient({ cooldownStore: store, requestStore: store, proxies: new ProxyPool(store) });
  }
  private countRequest(context: JobContext): void { if (!this.source.beginJob) context.job.requestCount++; }

  private memoryAssessment(raw: RawListing, assessment: Assessment): Assessment {
    return enrichComputerAssessment(raw, reconcileAssessment(raw, assessment), this.memoryCatalog);
  }
  private async warmMemory(raws: RawListing[], signal: AbortSignal): Promise<void> {
    if (!this.memoryCatalog?.warm && !this.memoryCatalog?.warmLaptops) return;
    const parts: MemoryPartRequest[] = [];
    const laptops: LaptopSpecRequest[] = [];
    for (const raw of raws) {
      const p = assessWithRules(raw).profile;
      if (p.cpu) parts.push({ kind: 'cpu', model: p.cpu });
      if (p.gpu && p.gpuClass !== 'integrated' && p.gpuInclusion !== 'absent') parts.push({ kind: 'gpu', model: p.gpu, gpuClass: p.gpuClass });
      const laptop = raw.category === 'laptop' ? laptopSpecRequest(p) : null;
      if (laptop) laptops.push(laptop);
    }
    // One bounded batch per collection phase, keyed by distinct part identity. Reads stay offline.
    const batchSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try { await Promise.allSettled([this.memoryCatalog?.warm?.(parts,batchSignal),this.memoryCatalog?.warmLaptops?.(laptops,batchSignal)]); }
    catch (error) { if (signal.aborted) throw error; }
    signal.throwIfAborted();
  }

  aiStatus(): AIStatus {
    const settings = this.store.getSettings(), configured = !!this.store.getKey();
    return { configured, keySource: process.env.LITELLM_API_KEY?.trim() ? 'environment' : configured ? 'local' : null,
      enabled: settings.aiEnabled, mimoModel: MIMO_MODEL, deciderModel: DECIDER_MODEL,
      status: !settings.aiEnabled ? 'disabled' : !configured ? 'not_configured' : this.aiError ? 'error' : this.budgetLimited ? 'budget_limited' : 'ready',
      lastError: this.aiError, totalCostUsd: this.store.totalCost() };
  }
  private marketplaceStatus() { return { requests: this.store.sourceBudgetStatus(this.now()), proxies: this.source.proxyStatus?.() ?? null }; }
  bootstrap(): AdminBootstrapResponse { return { access: 'admin', settings: this.store.getSettings(), ai: this.aiStatus(), schedule: this.scheduleStatus(), searches: this.store.searches(), counts: this.store.counts(), marketplace: this.marketplaceStatus() }; }
  scheduleStatus(now = this.now()) { return { ...dailyScanStatus(this.store, this.activeJob(), this.deploymentStatus().busy, now), marketplace: this.marketplaceStatus() }; }
  configureDailyScans(enabled: boolean, now = this.now()) {
    this.ensureWorkAllowed(); this.store.configureDailyScans(enabled, now); return this.scheduleStatus(now);
  }
  /** Private operator recovery for attempts made before durable retry support. */
  recoverScanRetry(job: RefreshJob, budgetUsd: number, cooldown: SourceCooldown): ScanRetry {
    this.ensureWorkAllowed();
    if (this.active || this.aiProbeRunning) throw new Error('Wait for the active refresh or AI probe before restoring a retry');
    const settings = this.store.getSettings();
    if (job.status !== 'failed' || !job.completedAt) throw new Error('Only a finalized failed refresh can be recovered');
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > settings.aiBudgetUsd) throw new Error('Recovery cannot increase the configured manual budget');
    job = { ...job, query: normalize(job.query) };
    const pending = this.store.pendingScanRetry(job.category, job.query);
    if (pending && pending.originalJobId !== job.id) throw new Error('A refresh retry is already queued for this category and search');
    const persisted = this.store.recordSourceCooldown(cooldown);
    return this.store.deferScanRetry(job, { ...settings, scanLimit: job.target, aiBudgetUsd: budgetUsd }, persisted, null);
  }
  cancelScanRetry(id: string): ScanRetry { this.ensureWorkAllowed(); return this.store.cancelScanRetry(id); }
  private ensureSourceAvailable(now = this.now()): void {
    const cooldown = activeCooldown(this.store.sourceCooldown(), now);
    if (cooldown) throw new SourceCooldownError(cooldown);
  }
  private publicSettings(): PublicSettings {
    const { minRamGb, minVramGb, includeUnknownMemory, discountPercent, minComparables } = this.store.getSettings();
    return { minRamGb, minVramGb, includeUnknownMemory, discountPercent, minComparables };
  }
  publicBootstrap(): PublicBootstrapResponse {
    return { access: 'read-only', settings: this.publicSettings(), ai: null, searches: [], counts: this.store.counts() };
  }
  private prepared(listing: StoredListing): StoredListing {
    const assessment = this.memoryAssessment(listing.raw, listing.assessment);
    const changed = JSON.stringify(assessment.profile) !== JSON.stringify(listing.assessment.profile)
      || JSON.stringify(assessment.priceOptions) !== JSON.stringify(listing.assessment.priceOptions)
      || JSON.stringify(assessment.memoryTypeSources) !== JSON.stringify(listing.assessment.memoryTypeSources);
    return { ...listing, assessment, ...(changed && listing.reference ? { reference: null,
      reason: 'Hardware interpretation changed; refresh this evidence before using its reference price' } : {}) };
  }
  private view(listing: StoredListing, readOnly = false): ListingView {
    // Personal overrides must not affect anonymous valuations, admission, or ordering.
    const settings = readOnly ? { ...DEFAULT_SETTINGS, ...this.publicSettings() } : this.store.getSettings();
    return this.preparedView(this.prepared(listing), readOnly, settings);
  }
  private preparedView(listing: StoredListing, readOnly: boolean, settings: AppSettings): ListingView {
    const state = readOnly ? { ...EMPTY_STATE } : listing.state;
    const valuation = valueListing(listing.raw, listing.assessment, listing.reference, settings, state, listing.reason);
    if (!readOnly) return { ...listing.raw, assessment: listing.assessment, state, valuation };
    return { ...listing.raw,
      attributes: Object.fromEntries(Object.entries(listing.raw.attributes).filter(([key]) => !key.startsWith('_'))),
      assessment: { ...listing.assessment, status: `Retained seller evidence; ${listing.assessment.eligibility}.` }, state,
      valuation: { ...valuation, costReserve: 0, expectedResale: null, profit: null, roiPercent: null, resaleOpportunity: false } };
  }
  detail(id: string): ListingDetail | null {
    const item = this.store.getListing(id); return item ? { ...this.view(item), history: this.store.history(id) } : null;
  }
  publicDetail(id: string): ListingDetail | null {
    const item = this.store.getListing(id); return item ? { ...this.view(item, true), history: this.store.history(id) } : null;
  }
  state(id: string, updates: Partial<ListingState>): ListingView | null {
    const item = this.store.setState(id, updates); return item ? this.view(item) : null;
  }
  listings(category: Category, params: URLSearchParams): ListingsResponse {
    return this.listingResponse(category, params, false);
  }
  publicListings(category: Category, params: URLSearchParams): ListingsResponse {
    if (params.get('view') === 'saved') throw new Error('Saved listings require administrator access');
    return this.listingResponse(category, params, true);
  }
  private listingResponse(category: Category, params: URLSearchParams, readOnly: boolean): ListingsResponse {
    const query = normalize(params.get('q') ?? ''), view = params.get('view') ?? 'all';
    const settings = this.store.getSettings();
    const memory: MemoryFilters = { minRamGb: Number(params.get('minRamGb') ?? settings.minRamGb),
      minVramGb: Number(params.get('minVramGb') ?? settings.minVramGb),
      includeUnknownMemory: params.has('includeUnknownMemory') ? params.get('includeUnknownMemory') === 'true' : settings.includeUnknownMemory };
    const offlineSearch = readOnly || view === 'history' || view === 'saved';
    const retained = view === 'saved' ? this.store.localListings(category)
      : view === 'history' ? this.store.marketListings(category, true)
      : readOnly ? this.store.marketListings(category) : this.store.localListings(category, query);
    const pool = offlineSearch && query ? retained.filter((row) => normalize(`${row.raw.title} ${row.raw.description}`).includes(query)) : retained;
    const displaySettings = readOnly ? { ...DEFAULT_SETTINGS, ...this.publicSettings() } : settings;
    const admittedUnknownMemory = new Set<string>();
    let items = pool.map((row) => {
      const prepared = this.prepared(row), item = this.preparedView(prepared, readOnly, displaySettings);
      if (memory.includeUnknownMemory && onlyUnknownMemoryNeedsReview({ ...item, attributes: prepared.raw.attributes }, prepared.reference)) admittedUnknownMemory.add(item.id);
      return item;
    });
    const districts = [...new Set(items.map((item) => item.district).filter(Boolean))].sort((a,b) => a.localeCompare(b));
    const needsReview = (item: ListingView) => (item.assessment.eligibility !== 'eligible' || item.valuation.status === 'needs_review')
      && !admittedUnknownMemory.has(item.id);
    items = items.filter((item) => matchesMemory(category, item.assessment.profile, memory));
    const stats = { scanned: pool.length, benchmarked: items.filter((item) => item.valuation.reference !== null).length,
      opportunities: items.filter((item) => item.valuation.opportunity).length,
      componentOpportunities: items.filter(item => item.valuation.componentOpportunity).length,
      indicative: items.filter(item => item.valuation.status === 'indicative').length,
      saved: items.filter((item) => item.state.saved).length, excluded: items.filter(needsReview).length };
    if (view === 'saved') items = items.filter((item) => item.state.saved);
    else if (view === 'review') items = items.filter((item) => needsReview(item) || item.state.dismissed);
    else if (view !== 'history') items = items.filter((item) => !needsReview(item) && !item.state.dismissed);
    if (view === 'indicative') items = items.filter(item => item.valuation.status === 'indicative');
    if (view === 'components') items = items.filter(item => item.valuation.componentOpportunity);
    const district = params.get('district'); if (district) items = items.filter((item) => item.district === district);
    const maxPrice = Number(params.get('maxPrice')); if (maxPrice > 0) items = items.filter((item) => item.price <= maxPrice);
    if (params.get('opportunities') === 'true') items = items.filter((item) => item.valuation.opportunity);
    const sort = params.get('sort');
    items.sort(sort === 'price' ? (a,b) => a.price-b.price : sort === 'newest' ? (a,b) => b.observedAt.localeCompare(a.observedAt)
      : (a,b) => Number(b.valuation.opportunity) - Number(a.valuation.opportunity)
        || (b.valuation.discountPercent ?? -1000) - (a.valuation.discountPercent ?? -1000) || a.price-b.price);
    // Public coverage describes retained market observations, never the private collection log.
    const coverage: Coverage | null = readOnly ? pool.length ? { category, query, scanned: pool.length, limit: pool.length,
      totalAvailable: null, completedAt: pool.reduce((latest, row) => row.raw.observedAt > latest ? row.raw.observedAt : latest, ''),
      error: null, requestCount: 0 } : null : this.store.coverage(category, query);
    return { items, total: items.length, stats, districts, coverage,
      job: readOnly ? null : this.active?.job ?? null, ai: readOnly ? null : this.aiStatus() };
  }
  activeJob(): RefreshJob | null { return this.active?.job ?? null; }
  deploymentStatus(): { busy: boolean } { return { busy: !!this.active || this.aiProbeRunning }; }
  getJob(id: string): RefreshJob | null {
    const queued = this.store.scanRetries().find(retry => retry.originalJobId === id || retry.job.id === id);
    return queued && queued.status !== 'running' ? queued.status === 'waiting'
      ? { ...queued.job, status: 'waiting', resumeAt: queued.dueAt } : queued.job : this.jobs.get(id) ?? queued?.job ?? null;
  }
  cancelJob(id: string): RefreshJob | null {
    if (this.active?.job.id === id) { this.active.abort.abort(); this.active.job.message = 'Cancelling after the current request'; }
    return this.jobs.get(id) ?? null;
  }
  clearAIStatus(): void { this.aiError = null; this.budgetLimited = false; }
  private ensureWorkAllowed(): void {
    if (this.stopping) throw new Error('Application is stopping; try again after it restarts');
    if (this.store.deploymentMaintenanceActive()) throw new Error('Deployment is in progress; try again shortly');
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.active?.abort.abort(); this.probeAbort?.abort();
    await Promise.allSettled([...this.pending]);
    await this.source.close?.();
  }
  testAI(): Promise<Array<{ model: string; ok: boolean; error?: string; costUsd?: number }>> {
    // Register synchronous exclusion before launching the asynchronous request.
    return this.track(this.runAIProbe());
  }
  private async runAIProbe(): Promise<Array<{ model: string; ok: boolean; error?: string; costUsd?: number }>> {
    this.ensureWorkAllowed();
    if (this.active) throw new Error('Wait for or cancel the active refresh before testing AI');
    if (this.aiProbeRunning) throw new Error('An AI probe is already running. Wait for it to finish.');
    this.aiProbeRunning = true;
    this.probeAbort = new AbortController();
    try {
      const key = this.store.getKey(); if (!key) throw new Error('Set LITELLM_API_KEY in .env or add a LiteLLM key in Settings first');
      const client = new LiteLLMClient({ key, onReceipt: (receipt) => this.store.addReceipt(receipt) });
      const results = await client.test(new RefreshBudget(this.store.getSettings().aiBudgetUsd), this.probeAbort.signal);
      this.aiError = results.find((result) => !result.ok)?.error ?? null;
      return results;
    } finally { this.aiProbeRunning = false; this.probeAbort = null; }
  }
  refresh(category: Category, query: string, limit?: number, minRamGb?: number, minVramGb?: number, includeUnknownMemory?: boolean): RefreshJob {
    this.ensureWorkAllowed();
    const queued = this.store.pendingScanRetry(category, normalize(query));
    if (queued?.status === 'waiting') return { ...queued.job, status: 'waiting', resumeAt: queued.dueAt };
    const context = this.startJob(category, query, limit, { minRamGb, minVramGb, includeUnknownMemory });
    this.launchRefresh(context); return context.job;
  }
  analyze(id: string): RefreshJob {
    this.ensureWorkAllowed();
    const listing = this.store.getListing(id); if (!listing || !['laptop','desktop','gpu'].includes(listing.raw.category)) throw new Error('Listing not found');
    const queued = this.store.pendingScanRetry(listing.raw.category as Category, '', id);
    if (queued?.status === 'waiting') return { ...queued.job, status: 'waiting', resumeAt: queued.dueAt };
    const context = this.startJob(listing.raw.category as Category, '', 1, {}, id);
    context.listingId = id;
    context.job.message = 'Retrieving this listing and focused nationwide comparisons';
    void this.track(this.runFocused(context, listing)); return context.job;
  }
  private startJob(category: Category, query: string, limit?: number, memory: Partial<MemoryFilters> = {}, listingId?: string): JobContext {
    this.ensureWorkAllowed();
    if (this.active) throw new Error('A refresh is already running. Wait for it or cancel it first.');
    if (this.aiProbeRunning) throw new Error('Wait for the active AI probe before starting a refresh or analysis');
    this.ensureSourceAvailable();
    if (this.store.pendingScanRetry(category, normalize(query), listingId)) throw new Error('A refresh retry is already queued for this category and search');
    const settings = this.store.getSettings();
    return this.createJob(category, query, settings, limit, memory);
  }
  /** Claims only after the shared job/probe/maintenance gate, with no await gap. */
  tryStartDailyRefresh(now = this.now()): RefreshJob | null {
    if (this.stopping || this.active || this.aiProbeRunning || this.store.deploymentMaintenanceActive()) return null;
    if (activeCooldown(this.store.sourceCooldown(), now)) return null;
    const recovery = this.store.claimScanRetry(now);
    if (recovery) {
      const { retry, settings } = recovery;
      const context = this.createJob(retry.category, retry.query, settings, retry.job.target, {}, now, retry, retry.automatic ?? retry.dailyDay !== null);
      context.retryId = retry.id;
      context.listingId = retry.listingId;
      if (retry.dailyDay) context.scheduledDay = retry.dailyDay;
      this.store.recordScanRetry(retry.id, context.job, null);
      if (context.scheduledDay) this.store.recordDailyScan(context.scheduledDay, context.job);
      if (retry.listingId) {
        const listing = this.store.getListing(retry.listingId);
        if (listing) void this.track(this.runFocused(context, listing));
        else { context.job.status = 'failed'; context.job.error = 'Queued listing is no longer retained'; this.finish(context); }
      } else this.launchRefresh(context);
      return context.job;
    }
    const claim = this.store.claimDailyScan(this.store.getSettings(), now);
    if (!claim) return null;
    const context = this.createJob(claim.attempt.category, '', claim.settings, undefined, {}, now, undefined, true);
    context.scheduledDay = claim.attempt.day;
    this.store.recordDailyScan(context.scheduledDay, context.job);
    this.launchRefresh(context);
    return context.job;
  }
  private launchRefresh(context: JobContext): void {
    void this.track(this.runRefresh(context)).catch(() => {
      // A journal write failure must not admit more scheduled work.
      this.stopping = true;
      process.stderr.write('Refresh finalization failed; restart after checking persistent storage.\n');
    });
  }
  private createJob(category: Category, query: string, settings: AppSettings, limit?: number,
    memory: Partial<MemoryFilters> = {}, now = this.now(), retry?: ScanRetry, automatic = false): JobContext {
    settings = { ...settings, benchmarkLimit: Math.min(settings.benchmarkLimit, NATIONAL_OFFER_LIMIT) };
    const job: RefreshJob = { id: randomUUID(), category, query: normalize(query), status: 'collecting', message: 'Collecting live Da Nang listings',
      scanned: 0, target: limit ?? settings.scanLimit, assessed: 0, benchmarked: 0, totalAvailable: retry?.job.totalAvailable ?? null, requestCount: retry?.job.requestCount ?? 0, aiCostUsd: retry?.spentUsd ?? 0,
      error: null, startedAt: now.toISOString(), completedAt: null, ...(retry ? { retryOf: retry.originalJobId } : {}) };
    const key = settings.aiEnabled ? this.store.getKey() : '';
    const context: JobContext = { job, abort: new AbortController(), budget: new RefreshBudget(settings.aiBudgetUsd, retry?.spentUsd), settings,
      memory: { minRamGb: memory.minRamGb ?? settings.minRamGb, minVramGb: memory.minVramGb ?? settings.minVramGb,
        includeUnknownMemory: memory.includeUnknownMemory ?? settings.includeUnknownMemory }, pools: new Map(),
      ai: key ? new LiteLLMClient({ key, onReceipt: (receipt) => {
        this.store.addReceipt(receipt); job.aiCostUsd = context.budget.spent;
        if (context.retryId) this.store.recordScanRetry(context.retryId, job, this.aiError);
        if (context.scheduledDay) this.store.recordDailyScan(context.scheduledDay, job);
      } }) : null, aiStopped: false, aiFailures: 0, automatic,
      progress: retry?.progress ? structuredClone(retry.progress) : { ids: [], nextPage: 1, collected: false, assessedIds: [], comparedIds: [], initialDetails: 0 } };
    this.source.beginJob?.({ id: job.id, category, automatic, onRequest: () => { job.requestCount++; } });
    this.clearAIStatus(); this.active = context; this.jobs.set(job.id, job);
    if (this.jobs.size > 50) this.jobs.delete(this.jobs.keys().next().value!);
    return context;
  }
  private async assessed(raw: RawListing, context: JobContext): Promise<Assessment> {
    context.abort.signal.throwIfAborted();
    if (sourceUnavailable(raw)) return this.memoryAssessment(raw, assessWithRules(raw));
    const cached = this.store.cachedAssessment(raw); if (cached) return this.memoryAssessment(raw, cached);
    const rules = this.memoryAssessment(raw, assessWithRules(raw));
    if (!context.ai || context.aiStopped || rules.eligibility === 'excluded') return rules;
    try {
      const assessment = await context.ai.assess(raw, context.budget, context.abort.signal);
      // Canonical names reflect only stated identifiers; no new specification or price is inferred.
      const gpus = assessment.profile.gpu ? gpuModels(assessment.profile.gpu) : [];
      const cpus = assessment.profile.cpu ? cpuModels(assessment.profile.cpu) : [];
      if (gpus.length === 1) assessment.profile.gpu = gpus[0]!;
      if (cpus.length === 1) assessment.profile.cpu = cpus[0]!;
      if (assessment.profile.storageType) {
        const storage = normalize(assessment.profile.storageType);
        assessment.profile.storageType = storage.includes('nvme') ? 'NVME SSD' : storage.includes('sata') ? 'SATA SSD' : storage.includes('ssd') ? 'SSD' : storage.includes('hdd') ? 'HDD' : assessment.profile.storageType;
      }
      if (assessment.profile.ramType) assessment.profile.ramType = assessment.profile.ramType.toUpperCase().replace(/\s/g,'');
      assessment.conflicts = [...new Set([...assessment.conflicts, ...rules.conflicts])];
      if (assessment.eligibility === 'eligible' && assessment.conflicts.length) assessment.eligibility = 'review';
      const resolved = this.memoryAssessment(raw, assessment);
      context.aiFailures = 0;
      this.store.cacheAssessment(raw, resolved); return resolved;
    } catch (error) {
      if (context.abort.signal.aborted) throw error;
      if (error instanceof BudgetExceededError || context.budget.remaining === 0) {
        this.budgetLimited = true; context.aiStopped = true;
      } else {
        this.aiError = error instanceof Error ? error.message : 'AI provider request failed';
        context.aiStopped = ++context.aiFailures >= MAX_CONSECUTIVE_AI_FAILURES;
      }
      return { ...rules, status: `${rules.status}. ${this.budgetLimited ? 'AI refresh budget exhausted'
        : context.aiStopped ? 'AI paused after repeated failures' : 'AI failed for this listing; continuing with local rules'}` };
    } finally { context.job.aiCostUsd = context.budget.spent; }
  }
  private async enriched(raw: RawListing, context: JobContext, force = false): Promise<RawListing> {
    const previous = this.store.getListing(raw.id)?.raw;
    if (!force && previous && Date.now() - Date.parse(String(previous.attributes._detailedAt ?? '')) < POOL_AGE_MS
      && previous.title === raw.title && previous.price === raw.price && previous.condition === raw.condition
      && previous.attributes.status === raw.attributes.status) {
      return { ...raw, description: previous.description, params: { ...raw.params, ...previous.params },
        attributes: { ...raw.attributes, ...previous.attributes }, condition: previous.condition,
        images: previous.images.length ? previous.images : raw.images, sellerType: previous.sellerType };
    }
    try {
      this.countRequest(context);
      const detail = await this.source.detail(raw, context.abort.signal);
      detail.attributes._detailedAt = new Date().toISOString(); return detail;
    } catch (error) {
      if (context.abort.signal.aborted) throw error;
      if (error instanceof SourceCooldownError || error instanceof SourceDeferredError) throw error;
      // A vanished listing is retained in history and cannot be presented as a fresh eligible candidate.
      if (/404|410/.test(error instanceof Error ? error.message : '')) return { ...raw, condition: 'unknown', attributes: { ...raw.attributes, _sourceUnavailable: true } };
      return { ...raw, attributes: { ...raw.attributes, _detailError: error instanceof Error ? error.message : 'Detail request failed' } };
    }
  }
  private async runRefresh(context: JobContext): Promise<void> {
    const { job } = context;
    if (context.progress.raws?.some(raw => Date.now() - Date.parse(raw.observedAt) >= 24 * 60 * 60_000)) {
      context.progress = { ids: [], nextPage: 1, collected: false, assessedIds: [], comparedIds: [], initialDetails: 0 };
    }
    const progress = context.progress;
    const gathered = new Map<string, RawListing>((progress.raws ?? []).map(raw => [raw.id, raw]));
    for (const id of progress.assessedIds) {
      const stored = this.store.getListing(id), snapshot = gathered.get(id);
      if (stored && snapshot && assessmentHash(stored.raw) !== assessmentHash(snapshot)) {
        gathered.set(id, stored.raw);
        progress.assessedIds = progress.assessedIds.filter(item => item !== id);
        progress.comparedIds = progress.comparedIds.filter(item => item !== id);
      }
    }
    job.scanned = gathered.size; job.assessed = progress.assessedIds.length; job.benchmarked = progress.comparedIds.length;
    try {
      let page = progress.nextPage;
      while (!progress.collected && gathered.size < job.target) {
        context.abort.signal.throwIfAborted(); this.countRequest(context);
        const result = await this.source.search({ kind: job.category, location: 'danang', query: job.query, page, signal: context.abort.signal });
        job.totalAvailable = result.total; let added = 0;
        for (const raw of result.items) if (!gathered.has(raw.id) && gathered.size < job.target) { gathered.set(raw.id, raw); added++; }
        job.scanned = gathered.size; job.message = `Collected ${job.scanned} of up to ${job.target} local listings`;
        // Normalization can discard ads from a 20-ad source page; its usable length is not the source-page length.
        progress.ids = [...gathered.keys()]; progress.raws = [...gathered.values()]; progress.nextPage = page + 1;
        if (!added || (result.total !== null ? page * 20 >= result.total : result.items.length < 20)) { progress.collected = true; break; }
        page++;
      }
      progress.collected = true;
      job.status = 'assessing'; job.message = 'Checking listing types, condition and hardware specifications';
      // Spend bounded detail/AI work on known memory matches, then possible
      // matches with missing capacities, then known failures, ordered by price.
      const ordered = [...gathered.values()].map((raw) => ({ raw,
        priority: memoryPriority(job.category, this.memoryAssessment(raw, this.store.cachedAssessment(raw) ?? assessWithRules(raw)).profile, context.memory) }))
        .sort((a,b) => a.priority-b.priority || a.raw.price-b.raw.price).map(({ raw }) => raw);
      for (let raw of ordered) {
        if (progress.assessedIds.includes(raw.id)) continue;
        const rules = assessWithRules(raw);
        if (!sourceUnavailable(raw) && rules.eligibility !== 'excluded' && progress.initialDetails < LOCAL_DETAIL_LIMIT) {
          raw = await this.enriched(raw, context); progress.initialDetails++;
        }
        const assessment = await this.assessed(raw, context);
        this.store.putListing(raw, assessment, true); job.assessed++;
        gathered.set(raw.id, raw); progress.raws = [...gathered.values()]; progress.assessedIds.push(raw.id);
      }
      await this.warmMemory([...gathered.keys()].map(id => this.store.getListing(id)!.raw), context.abort.signal);
      job.status = 'comparing';
      const groups = new Map<string, StoredListing[]>();
      const completedConfigurations = new Set<string>();
      for (const listing of [...gathered.keys()].map(id => this.prepared(this.store.getListing(id)!)).sort((a,b) =>
        memoryPriority(job.category, a.assessment.profile, context.memory) - memoryPriority(job.category, b.assessment.profile, context.memory)
        || a.raw.price-b.raw.price)) {
        if (listing.assessment.eligibility !== 'eligible' || sourceUnavailable(listing.raw)) continue;
        const c = listing.assessment.computer;
        const key = `${profileKey(listing.assessment.profile, listing.assessment.kind)}:${JSON.stringify([c?.formFactor, c?.cpuCount, c?.ramEcc, c?.ramReplaceable, c?.storageReplaceable])}`;
        if (progress.comparedIds.includes(listing.raw.id)) completedConfigurations.add(key);
        else groups.set(key, [...(groups.get(key) ?? []), listing]);
      }
      let count = completedConfigurations.size;
      for (const [key, members] of groups) {
        if (count >= AUTO_COHORTS && !completedConfigurations.has(key)) {
          for (const listing of members) if (!listing.reference) this.store.setReference(listing.raw.id, null,
            'Not benchmarked in this bounded refresh. Open the listing and choose Analyze to retrieve its focused nationwide comparisons.');
          continue;
        }
        if (!completedConfigurations.has(key)) count++;
        job.message = `Comparing hardware configuration ${count} of ${Math.min(groups.size + completedConfigurations.size, AUTO_COHORTS)} nationwide`;
        await this.benchmark(members, context);
        progress.comparedIds.push(...members.map(member => member.raw.id));
      }
      job.status = 'complete'; job.message = `Collected ${job.scanned} local listings; compared ${job.benchmarked} listings across ${count} configurations. Analyze any remaining listing individually.`;
      // Publish membership only after the full refresh succeeds. Failed or
      // cancelled comparison work leaves the last successful collection active.
      this.store.setCollection(job.category, job.query, [...gathered.keys()]);
      this.store.saveCoverage({ category: job.category, query: job.query, scanned: job.scanned, totalAvailable: job.totalAvailable,
        limit: job.target, completedAt: new Date().toISOString(), error: null, requestCount: job.requestCount });
    } catch (error) { this.failed(context, error, true); }
    finally { this.finish(context); }
  }
  private async runFocused(context: JobContext, listing: StoredListing): Promise<void> {
    try {
      const canResume = context.progress.assessedIds.includes(listing.raw.id)
        && Date.now() - Date.parse(listing.raw.observedAt) < 24 * 60 * 60_000;
      const raw = canResume ? listing.raw : await this.enriched(listing.raw, context, true); context.job.scanned = 1;
      await this.warmMemory([raw], context.abort.signal);
      context.job.status = 'assessing'; const assessment = await this.assessed(raw, context);
      const updated = this.store.putListing(raw, assessment, listing.local); context.job.assessed = 1;
      context.progress.raws = [raw]; context.progress.assessedIds = [raw.id];
      if (assessment.eligibility === 'eligible') {
        context.job.status = 'comparing'; context.job.message = 'Retrieving focused nationwide price evidence';
        await this.benchmark([updated], context);
      }
      context.job.status = 'complete'; context.job.message = 'Listing analysis complete; see specifications, status and price evidence';
    } catch (error) { this.failed(context, error, false); }
    finally { this.finish(context); }
  }
  private failed(context: JobContext, error: unknown, coverage: boolean): void {
    const { job } = context;
    const cancelled = context.abort.signal.aborted;
    job.status = cancelled ? 'cancelled' : 'failed';
    job.error = cancelled ? null : error instanceof Error ? error.message : 'Marketplace refresh failed';
    job.message = cancelled ? 'Refresh cancelled; retained previously observed results' : 'Refresh failed; retained timestamped results';
    if (!cancelled && error instanceof SourceDeferredError) {
      job.status = 'waiting'; job.error = null; job.resumeAt = error.until; job.aiCostUsd = context.budget.spent;
      job.message = error.message;
      const retry = this.store.deferScanRetry(job, { ...context.settings, ...context.memory }, { until: error.until }, context.scheduledDay ?? null,
        context.retryId, { reason: error.reason, automatic: context.automatic, listingId: context.listingId, progress: context.progress });
      context.retryId = retry.id; return;
    }
    if (!cancelled && (coverage || context.listingId) && error instanceof SourceCooldownError) {
      job.aiCostUsd = context.budget.spent;
      const cooldown = this.store.recordSourceCooldown(error.cooldown);
      const retry = this.store.deferScanRetry(job, { ...context.settings, ...context.memory }, cooldown, context.scheduledDay ?? null, context.retryId,
        { reason: 'cooldown', automatic: context.automatic, listingId: context.listingId, progress: context.progress });
      context.retryId = retry.id;
      job.message = `Refresh deferred by Chợ Tốt; automatic retry after ${cooldown.until} within the original AI allowance`;
    }
    const previous = this.store.coverage(job.category, job.query);
    if (coverage && !cancelled) this.store.saveCoverage(previous ? { ...previous, error: job.error }
      : { category: job.category, query: job.query, scanned: 0, totalAvailable: null, limit: job.target, completedAt: new Date().toISOString(), error: job.error, requestCount: job.requestCount });
  }
  private finish(context: JobContext): void {
    context.job.completedAt = this.now().toISOString(); context.job.aiCostUsd = context.budget.spent;
    const aiIssue = this.budgetLimited ? 'AI refresh budget exhausted; conservative parsing continued'
      : this.aiError ? `${context.aiStopped ? 'AI paused after repeated failures' : 'Some AI assessments failed'}: ${this.aiError}` : null;
    if (context.retryId) this.store.recordScanRetry(context.retryId, context.job, aiIssue);
    if (context.scheduledDay) this.store.recordDailyScan(context.scheduledDay, context.job, aiIssue);
    if (this.active === context) this.active = null;
    this.source.endJob?.();
  }
  private searchQuery(kind: HardwareKind, listing: StoredListing): string {
    const p = listing.assessment.profile;
    if (kind === 'gpu') return `${p.gpu ?? ''} ${p.vramGb ? `${p.vramGb}gb` : ''}`.trim();
    if (kind === 'cpu') return p.cpu ?? '';
    if (kind === 'ram') return `${p.ramType ?? ''} ${p.perUnitGb ?? p.ramGb ?? ''}gb ${p.ramSpeedMhz ?? ''}`.trim();
    if (kind === 'ssd') {
      const capacity = p.storageGb && p.storageGb % 1024 === 0 ? `${p.storageGb / 1024}tb` : `${p.storageGb ?? ''}gb`;
      return `${capacity} ${p.storageType ?? ''}`.trim();
    }
    // A CPU-only desktop query also finds GPU-free and differently equipped base PCs.
    if (kind === 'laptop' && /^MACBOOK /i.test(p.model ?? '')) {
      return `${p.model!.replace(/\s+\d+(?:\.\d+)?\b/g,'')} ${(p.cpu ?? '').replace(/^APPLE\s+/,'')}`.trim();
    }
    return kind === 'laptop' ? p.model ?? '' : p.cpu ?? '';
  }
  private async collectPool(kind: HardwareKind, query: string, target: StoredListing, context: JobContext,
    reserveBaseSeller = false): Promise<AssessedListing[]> {
    const limit = Math.min(context.settings.benchmarkLimit, NATIONAL_OFFER_LIMIT);
    const key = `incremental-v3:${kind}:${normalize(query)}:${limit}`;
    const required = Math.max(5, context.settings.minComparables) + (reserveBaseSeller ? 1 : 0);
    const enough = (pool: AssessedListing[]) => kind === 'desktop' || kind === 'laptop'
      ? (buildReference(target.raw, target.assessment, pool, context.settings).reference?.sampleCount ?? 0) >= required
      : filterComparableOffers(target.raw, target.assessment.profile, kind, pool).accepted.length >= required;
    const collected = context.pools.get(key); if (collected && enough(collected)) return collected;
    const cached = this.store.getPool(key, POOL_AGE_MS);
    const progress = this.store.poolProgress(key, POOL_AGE_MS)
      ?? { raws: cached ?? [], nextPage: cached ? Math.ceil(cached.length / 20) + 1 : 1, exhausted: !!cached, detailedIds: [] };
    const assessed = new Map<string, { hash: string; assessment: Assessment }>();
    let pool: AssessedListing[] = [];
    while (true) {
      context.abort.signal.throwIfAborted();
      pool = [];
      for (const raw of progress.raws) {
        const hash = assessmentHash(raw), existing = assessed.get(raw.id);
        const assessment = existing?.hash === hash ? existing.assessment : await this.assessed(raw, context);
        assessed.set(raw.id, { hash, assessment });
        if (!this.store.getListing(raw.id)?.local) this.store.putListing(raw, assessment, false);
        pool.push({ raw, assessment });
      }
      if (enough(pool)) break;
      const canCollect = !progress.exhausted && progress.raws.length < limit;
      const ram = target.assessment.profile.ramGb;
      const rank = (value: number | null) => value === ram ? 0 : value === null ? 1 : 2;
      const computer = kind === 'desktop' || kind === 'laptop';
      const candidates = pool.map((item, index) => ({ ...item, index })).filter(({ raw, assessment: a }) => {
        const p = target.assessment.profile;
        const plausible = kind === 'gpu' ? !a.profile.gpu || a.profile.gpu === p.gpu
          : kind === 'cpu' || kind === 'desktop' ? !a.profile.cpu || a.profile.cpu === p.cpu : a.eligibility !== 'excluded';
        return raw.id !== target.raw.id && !progress.detailedIds.includes(raw.id) && !sourceUnavailable(raw)
          && plausible && a.eligibility !== 'excluded' && (!raw.description.trim() || a.eligibility === 'review')
          && (!computer || !canCollect || rank(a.profile.ramGb) < 2);
      }).sort((a, b) => computer ? rank(a.assessment.profile.ramGb) - rank(b.assessment.profile.ramGb) : 0);
      if (candidates.length && progress.detailedIds.length < 20) {
        const next = candidates[0]!;
        progress.raws[next.index] = await this.enriched(next.raw, context);
        progress.detailedIds.push(next.raw.id);
        this.store.savePoolProgress(key, progress); continue;
      }
      if (!canCollect) break;
      this.countRequest(context);
      const page = progress.nextPage;
      const result = await this.source.search({ kind, location: 'nationwide', query, page, signal: context.abort.signal });
      const ids = new Set(progress.raws.map(raw => raw.id)); let added = 0;
      for (const raw of result.items) if (!ids.has(raw.id) && progress.raws.length < limit) {
        ids.add(raw.id); progress.raws.push(raw); added++;
      }
      progress.nextPage++;
      progress.exhausted = !added || (result.total !== null ? page * 20 >= result.total : result.items.length < 20);
      this.store.savePoolProgress(key, progress);
      await this.warmMemory(progress.raws, context.abort.signal);
    }
    this.store.putPool(key, progress.raws);
    context.pools.set(key, pool); return pool;
  }
  private async benchmark(members: StoredListing[], context: JobContext): Promise<void> {
    const verified: StoredListing[] = [];
    for (let member of members) {
      member = this.prepared(member);
      if (!member.raw.description.trim()) {
        const raw = await this.enriched(member.raw, context);
        const assessment = await this.assessed(raw, context);
        member = this.store.putListing(raw, assessment, member.local);
      }
      if (member.assessment.eligibility === 'eligible' && !sourceUnavailable(member.raw) && member.raw.description.trim()) verified.push(member);
    }
    if (!verified.length) return;
    const target = verified[0]!, kind = target.assessment.kind;
    const query = this.searchQuery(kind, target);
    if (!query) { for (const item of members) this.store.setReference(item.raw.id, null, 'No reliable model or component search can be constructed'); return; }
    const peers = await this.collectPool(kind, query, target, context);
    const components: Partial<Record<'gpu'|'ram'|'cpu'|'ssd', AssessedListing[]>> = {};
    const direct = buildReference(target.raw, target.assessment, peers, context.settings).reference;
    if ((kind === 'desktop' || kind === 'laptop') && (!direct || direct.sampleCount < Math.max(5, context.settings.minComparables))) {
      const requests = new Map<string, { kind: 'gpu'|'ram'|'ssd'; profile: HardwareProfile; query: string; uses: number }>();
      for (const peer of peers.filter((item) => item.raw.id !== target.raw.id && item.raw.sellerId !== target.raw.sellerId
        && item.raw.condition === 'used' && item.raw.description.trim() && item.assessment.eligibility === 'eligible')
        .flatMap((item) => expandPricedConfigurations(item.raw, item.assessment))) {
        for (const requirement of adjustmentRequirements(target.raw, target.assessment, peer.raw, peer.assessment)) {
          const searchTarget = { ...target, assessment: { ...target.assessment, profile: requirement.profile } };
          const query = this.searchQuery(requirement.kind, searchTarget);
          if (!query) continue;
          const key = `${requirement.kind}:${normalize(query)}`, previous = requests.get(key);
          requests.set(key, { ...requirement, query, uses: (previous?.uses ?? 0) + 1 });
        }
      }
      // Collect the most reusable required parts first; unsupported adjustments remain unpriced.
      for (const request of [...requests.values()].sort((a,b) => b.uses-a.uses)
        .slice(0, context.automatic ? AUTOMATIC_PART_SEARCHES : COMPONENT_SEARCHES_PER_COHORT)) {
        const searchTarget = { ...target, assessment: { ...target.assessment, profile: request.profile } };
        const pool = await this.collectPool(request.kind, request.query, searchTarget, context, true);
        components[request.kind] = [...(components[request.kind] ?? []), ...pool];
      }
    }
    if (!context.automatic && kind === 'desktop' && !buildReference(target.raw, target.assessment, peers, context.settings, components).reference) {
      const p = target.assessment.profile;
      for (const component of ['gpu','ram','cpu','ssd'] as const) {
        if (component === 'gpu' && (!p.gpu || !p.vramGb || p.gpuClass !== 'desktop')) continue;
        if (component === 'ram' && (!p.perUnitGb || !p.quantity || !p.ramType || !p.ramFormFactor || !p.ramSpeedMhz)) continue;
        if (component === 'cpu' && !p.cpu) continue;
        if (component === 'ssd' && (!p.storageGb || !p.storageType || p.storageType === 'SSD')) continue;
        const pool = await this.collectPool(component, this.searchQuery(component, target), target, context);
        components[component] = [...(components[component] ?? []), ...pool];
      }
    }
    for (const member of verified) {
      context.abort.signal.throwIfAborted();
      const result = buildReference(member.raw, member.assessment, peers, context.settings, components);
      // putListing preserves an earlier AI assessment when unchanged source text
      // is rechecked with rules. Persist the enriched interpretation that actually
      // produced this reference so the next read does not invalidate it again.
      this.store.setAssessment(member.raw.id, member.assessment);
      this.store.setReference(member.raw.id, result.reference, result.reason); context.job.benchmarked++;
    }
  }
}
