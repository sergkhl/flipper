import type { FxSnapshot, LaptopPriceEvidence } from './retail.ts';
export type Category = 'laptop' | 'desktop' | 'gpu';
export type HardwareKind = Category | 'ram' | 'cpu' | 'ssd' | 'other' | 'wanted';
export type Condition = 'used' | 'new' | 'repaired' | 'unknown';

export interface RawListing {
  id: string;
  category: HardwareKind;
  title: string;
  description: string;
  price: number;
  url: string;
  images: string[];
  sellerId: string | null;
  sellerType: 'business' | 'private' | 'unknown';
  region: string;
  district: string;
  ward: string;
  condition: Condition;
  params: Record<string, string>;
  attributes: Record<string, string | number | boolean | null>;
  observedAt: string;
  displayAge: string;
}

export interface HardwareProfile {
  model: string | null;
  modelYear?: number | null;
  screenInches?: number | null;
  cpuCores?: number | null;
  gpuCores?: number | null;
  cpu: string | null;
  gpu: string | null;
  gpuClass: 'desktop' | 'mobile' | 'integrated' | null;
  vramGb: number | null;
  gpuMemoryType: string | null;
  gpuInclusion?: 'included' | 'absent' | 'unknown';
  ramGb: number | null;
  ramType: string | null;
  ramFormFactor: 'DIMM' | 'SODIMM' | 'soldered' | null;
  ramSpeedMhz: number | null;
  ramEcc?: 'non-ecc' | 'ecc' | 'registered' | null;
  storageGb: number | null;
  storageType: string | null;
  quantity: number | null;
  perUnitGb: number | null;
  priceBasis: 'item' | 'each' | 'bundle' | 'deposit' | 'unknown';
}

export interface Evidence { field: string; quote: string; }
export interface MemoryTypeSource {
  field: 'ramType' | 'gpuMemoryType';
  value: string;
  part: string;
  url: string;
  catalogVersion: string;
}
export interface MemoryTypeInference {
  field: 'ramType' | 'gpuMemoryType';
  types: string[];
  basis: string;
  manufacturerVerified: boolean;
  sources: Array<{ label: string; url: string }>;
  catalogVersion: string;
}
export interface LaptopSpecReference {
  name: string;
  cpu: string | null;
  gpu: string | null;
  modelYear: number | null;
  screenInches: number | null;
  cpuCores: number | null;
  gpuCores: number | null;
  ramGb: number | null;
  storageGb: number | null;
  ramType: string | null;
  url: string;
  sourceUrls: string[];
  fetchedAt: string;
}
export interface ComputerDetails {
  formFactor: 'tower' | 'sff' | 'mini' | 'aio' | null;
  cpuCount: number | null;
  motherboard: string | null;
  psu: string | null;
  case: string | null;
  cooling: string | null;
  ramEcc: 'non-ecc' | 'ecc' | 'registered' | null;
  ramReplaceable: boolean | null;
  storageReplaceable: boolean | null;
  missing: string[];
  evidence: Evidence[];
}
export interface PricedConfiguration {
  label: string;
  price: number;
  profile: HardwareProfile;
  evidence: string;
  memoryTypeSources?: MemoryTypeSource[];
  memoryTypeInferences?: MemoryTypeInference[];
  laptopSpecReferences?: LaptopSpecReference[];
}
export interface Assessment {
  kind: HardwareKind;
  profile: HardwareProfile;
  eligibility: 'eligible' | 'review' | 'excluded';
  risks: string[];
  unknowns: string[];
  conflicts: string[];
  evidence: Evidence[];
  confidence: number;
  method: 'rules' | 'ai';
  status: string;
  computer?: ComputerDetails;
  priceOptions?: PricedConfiguration[];
  memoryTypeSources?: MemoryTypeSource[];
  memoryTypeInferences?: MemoryTypeInference[];
  laptopSpecReferences?: LaptopSpecReference[];
}

export interface AIReceipt {
  id: string;
  model: string;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: string;
}

export interface ComparableOffer {
  id: string;
  sellerId: string | null;
  title: string;
  price: number;
  url: string;
  region: string;
  observedAt: string;
  rejectedReason?: string;
}
export interface ComponentReference {
  kind: 'gpu' | 'ram' | 'cpu' | 'ssd';
  label: string;
  quantity: number;
  average: number;
  offers: ComparableOffer[];
}
export interface ComponentAdjustment {
  kind: 'gpu' | 'ram' | 'ssd';
  operation: 'add' | 'remove';
  label: string;
  quantity: number;
  average: number;
  total: number;
  offers: ComparableOffer[];
}
export interface AdjustedComparable extends ComparableOffer {
  askingPrice: number;
  configurationLabel: string;
  adjustments: ComponentAdjustment[];
  missingDetails: string[];
}
export interface ReferencePrice {
  policyVersion?: number;
  kind: 'model' | 'configuration' | 'component_floor' | 'adjusted_configuration' | 'retail_new' | 'historical_depreciation';
  retail?: LaptopPriceEvidence;
  label: string;
  average: number;
  offers: ComparableOffer[];
  rejected: ComparableOffer[];
  components: ComponentReference[];
  sampleCount: number;
  observedAt: string;
  min: number;
  max: number;
  methodology: string;
  baseSampleCount?: number;
  adjustedOffers?: AdjustedComparable[];
  missingDetails?: string[];
}
export interface Valuation {
  status: 'valued' | 'indicative' | 'insufficient_evidence' | 'needs_review' | 'excluded';
  reference: ReferencePrice | null;
  discountPercent: number | null;
  profit: number | null;
  roiPercent: number | null;
  opportunity: boolean;
  componentOpportunity: boolean;
  resaleOpportunity: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  costReserve: number;
  expectedResale: number | null;
  maxBuyPrice: number | null;
  missingDetails?: string[];
  evidenceIssue?: 'not_compared' | 'insufficient_offers' | 'configuration' | 'unavailable'
    | 'outdated_policy' | 'missing_description' | 'stale_listing' | 'stale_reference' | 'unverified_price' | 'exchange_rate' | 'retail_price';
}
export interface ListingState {
  saved: boolean;
  dismissed: boolean;
  costReserve: number | null;
  expectedResale: number | null;
}
export interface ListingView extends RawListing {
  assessment: Assessment;
  valuation: Valuation;
  state: ListingState;
}
export interface AppSettings {
  marketplaceWorkers: number;
  aiWorkers: number;
  requestLimit: number;
  automaticRequestLimit: number;
  automaticCategoryRequestLimit: number;
  minRamGb: number;
  minVramGb: number;
  includeUnknownMemory: boolean;
  discountPercent: number;
  minComparables: number;
  minProfit: number;
  minRoiPercent: number;
  resaleFactor: number;
  costReserves: Record<Category, number>;
  aiBudgetUsd: number;
  scanLimit: number;
  benchmarkLimit: number;
  aiEnabled: boolean;
}
export type PublicSettings = Pick<AppSettings, 'minRamGb' | 'minVramGb' | 'includeUnknownMemory' | 'discountPercent' | 'minComparables'>;
export interface AIStatus {
  configured: boolean;
  keySource: 'environment' | 'local' | null;
  enabled: boolean;
  mimoModel: string;
  deciderModel: string;
  status: 'ready' | 'not_configured' | 'disabled' | 'error' | 'budget_limited';
  lastError: string | null;
  totalCostUsd: number;
}
export interface SavedSearch {
  id: string;
  name: string;
  category: Category;
  query: string;
  district: string;
  mode: 'buy' | 'resale';
  maxPrice?: number | null;
  priceCurrency?: 'VND' | 'USD';
  minRamGb?: number;
  minVramGb?: number;
  includeUnknownMemory?: boolean;
  opportunities?: boolean;
}
export interface Coverage {
  category: Category;
  query: string;
  scanned: number;
  totalAvailable: number | null;
  limit: number;
  completedAt: string;
  error: string | null;
  requestCount: number;
}
export interface RefreshJob {
  id: string;
  category: Category;
  query: string;
  status: 'collecting' | 'assessing' | 'comparing' | 'waiting' | 'complete' | 'failed' | 'cancelled';
  message: string;
  scanned: number;
  target: number;
  assessed: number;
  benchmarked: number;
  totalAvailable: number | null;
  requestCount: number;
  aiCostUsd: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Retry costs include the earlier attempts against the same allowance. */
  retryOf?: string;
  resumeAt?: string;
  configurationsCompleted?: number;
  configurationsTotal?: number;
}
export type RunLimits = Pick<AppSettings, 'marketplaceWorkers' | 'aiWorkers' | 'requestLimit' | 'automaticRequestLimit' | 'automaticCategoryRequestLimit'>;
export type RunParameters = Pick<AppSettings, 'scanLimit' | 'benchmarkLimit' | 'aiBudgetUsd' | 'aiEnabled' | 'minRamGb' | 'minVramGb' | 'includeUnknownMemory'>;
export interface RunSummary {
  id: string;
  rootId: string;
  state: RefreshJob['status'] | 'interrupted';
  stage?: 'collecting' | 'assessing' | 'comparing';
  job: RefreshJob;
  parameters: RunParameters;
  workers: Pick<RunLimits, 'marketplaceWorkers' | 'aiWorkers'>;
  automatic: boolean;
  listingId?: string;
  scheduledDay?: string;
  aiIssue: string | null;
}
export interface RunsResponse {
  runs: RunSummary[];
  hasMore: boolean;
  busy: boolean;
  activeId: string | null;
  limits: RunLimits;
  marketplace: MarketplaceStatus;
}
/** Private, replaceable snapshot. Reconnecting clients always receive current state. */
export interface RunActivity {
  runs: RunsResponse;
  schedule: DailyScanStatus;
  job: RefreshJob | null;
}
export interface ListingsResponse {
  fx?: FxSnapshot | null;
  items: ListingView[];
  total: number;
  stats: { scanned: number; benchmarked: number; opportunities: number; componentOpportunities: number; indicative: number; saved: number; excluded: number; };
  districts: string[];
  coverage: Coverage | null;
  job: RefreshJob | null;
  ai: AIStatus | null;
}
export interface AdminBootstrapResponse {
  fx?: FxSnapshot | null;
  access: 'admin';
  settings: AppSettings;
  ai: AIStatus;
  schedule: DailyScanStatus;
  searches: SavedSearch[];
  counts: Record<Category, number>;
  marketplace?: MarketplaceStatus;
}
export interface PublicBootstrapResponse {
  fx?: FxSnapshot | null;
  access: 'read-only';
  settings: PublicSettings;
  ai: null;
  searches: [];
  counts: Record<Category, number>;
}
export type BootstrapResponse = AdminBootstrapResponse | PublicBootstrapResponse;
export interface ListingDetail extends ListingView { fx?: FxSnapshot | null; history: { at: string; price: number }[]; }

export interface DailyScanControl { enabled: boolean; firstDueAt: string | null; }
export interface SourceCooldown {
  until: string;
  observedAt: string;
  status: number;
}
export interface ScanRetry {
  id: string;
  category: Category;
  query: string;
  originalJobId: string;
  dueAt: string;
  budgetUsd: number;
  spentUsd: number;
  status: 'waiting' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  attempts: number;
  dailyDay: string | null;
  job: RefreshJob;
  aiIssue: string | null;
  reason?: 'cooldown' | 'request_budget' | 'proxy';
  automatic?: boolean;
  listingId?: string;
  progress?: RefreshProgress;
}
export interface RefreshProgress {
  ids: string[];
  raws?: RawListing[];
  nextPage: number;
  collected: boolean;
  assessedIds: string[];
  comparedIds: string[];
  initialDetails: number;
  truncated?: boolean;
}
export interface DailyScanAttempt {
  day: string;
  category: Category;
  status: 'running' | 'waiting' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  budgetUsd: number;
  startedAt: string;
  completedAt: string | null;
  job: RefreshJob | null;
  aiIssue: string | null;
}
export interface DailyScanStatus {
  enabled: boolean;
  timeZone: string;
  time: string;
  categories: Category[];
  perCategoryBudgetUsd: number;
  dailyBudgetUsd: number;
  nextRunAt: string | null;
  state: 'disabled' | 'scheduled' | 'due' | 'busy' | 'maintenance' | 'running' | 'cooldown' | 'request_budget' | 'proxy';
  lastRunDay: string | null;
  attempts: DailyScanAttempt[];
  cooldown: SourceCooldown | null;
  retries: ScanRetry[];
  marketplace?: MarketplaceStatus;
}
export interface SourceBudgetStatus {
  limit: number; used: number; automaticUsed: number; manualUsed: number;
  categoryUsed: Record<Category, number>; remaining: number; automaticCategoryLimit: number;
  manualReserve: number; nextRequestAt: string | null;
}
export interface MarketplaceStatus {
  requests: SourceBudgetStatus;
  proxies: { enabled: boolean; sources: string[]; cached: number; available: number; verified?: number;
    workerLimit?: number; workers?: number; activeWorkers?: number; intervalMs?: number;
    fetchedAt: string | null; retryAt: string | null } | null;
  ai?: { limit: number; active: number };
}
