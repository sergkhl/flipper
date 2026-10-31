import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownUp,
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  ExternalLink,
  Grid2X2,
  Info,
  Laptop,
  LoaderCircle,
  MapPin,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingDown,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  BootstrapResponse,
  Category,
  ListingDetail,
  ListingsResponse,
  ListingState,
  ListingView,
  RefreshJob,
  SavedSearch,
} from "../shared/types";
import { message, post, READ_TIMEOUT_MS, request } from "./api";
import { DEFAULT_SCAN_LIMIT } from '../shared/run-settings';
import { evidenceLabel } from "./valuation";
import {
  categoryLabels,
  compactMoney,
  date,
  isRunning,
  safeSourceUrl,
  timeAgo,
  usd,
} from "./format";
import ListingDrawer from "./ListingDrawer";
import DepreciatedRetail from './DepreciatedRetail';
import SettingsDrawer from "./SettingsDrawer";
import Runs from "./Runs";
import { useRunActivity } from './run-activity';
import { ActivityConnection } from './RunStatus';
import { hasDedicatedVram, hasMemoryTypeEstimates, hasTechApiMemoryData, memoryDescription, ramMinimums, vramMinimums } from "./memory";

type View = "all" | "saved" | "review" | "history" | "indicative" | "components" | "retail";
const viewLabels: Record<Exclude<View, 'all'>, string> = {
  saved: 'Shortlist', review: 'Review queue', history: 'Historical observations',
  indicative: 'Indicative comparisons', components: 'Below component value',
  retail: 'Below depreciated estimates',
};
const icons = { laptop: Laptop, desktop: Monitor, gpu: Cpu };
const categories: Category[] = ["laptop", "desktop", "gpu"];

export default function App() {
  const [runsOpen, setRunsOpen] = useState(() => new URLSearchParams(window.location.search).get('page') === 'runs');
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [response, setResponse] = useState<ListingsResponse | null>(null);
  const [category, setCategory] = useState<Category>(() => {
    const value = new URLSearchParams(window.location.search).get("category");
    return categories.includes(value as Category) ? value as Category : "laptop";
  });
  const [query, setQuery] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [district, setDistrict] = useState("");
  const [view, setView] = useState<View>("all");
  const [opportunities, setOpportunities] = useState(false);
  const [maxPrice, setMaxPrice] = useState("");
  const [minRamGb, setMinRamGb] = useState(16);
  const [minVramGb, setMinVramGb] = useState(8);
  const [includeUnknownMemory, setIncludeUnknownMemory] = useState(true);
  const [memoryFiltersReady, setMemoryFiltersReady] = useState(false);
  const [sort, setSort] = useState("value");
  const [job, setJob] = useState<RefreshJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    text: string;
    undo?: () => void;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("listing"),
  );
  const [detail, setDetail] = useState<ListingDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveSearchOpen, setSaveSearchOpen] = useState(false);
  const [mobileSearchesOpen, setMobileSearchesOpen] = useState(false);
  const [searchName, setSearchName] = useState("");
  const [savingSearch, setSavingSearch] = useState(false);
  const [reload, setReload] = useState(0);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const memoryDefaultsLoaded = useRef(false);
  const loadDeadline = useRef<number | null>(performance.now() + READ_TIMEOUT_MS);
  const adminBootstrap = bootstrap?.access === "admin" ? bootstrap : null;
  const canManage = adminBootstrap !== null;
  const activity = useRunActivity(canManage);
  const latestActivity = useRef(activity.snapshot); latestActivity.current = activity.snapshot;
  const acceptJob = useCallback((incoming: RefreshJob) => {
    const observed = latestActivity.current?.job;
    setJob(observed?.id === incoming.id && !isRunning(observed) ? observed : incoming);
  }, []);
  const activityJob = useRef<RefreshJob | null>(null);
  const lastMarketUpdate = useRef(0);
  const workspaceHome = /^\/admin(?:\/|$)/.test(window.location.pathname)
    ? "/admin/"
    : "/";

  const loadBootstrap = useCallback(async (signal?: AbortSignal) => {
    const result = await request<BootstrapResponse>("/bootstrap", {
      signal,
      timeoutMs: loadDeadline.current === null ? undefined : loadDeadline.current - performance.now(),
    });
    signal?.throwIfAborted();
    if (!memoryDefaultsLoaded.current) {
      memoryDefaultsLoaded.current = true;
      setMinRamGb(result.settings.minRamGb);
      setMinVramGb(result.settings.minVramGb);
      setIncludeUnknownMemory(result.settings.includeUnknownMemory);
      setMemoryFiltersReady(true);
    }
    setBootstrap(result);
    if (result.access !== "admin") {
      setRunsOpen(false);
      setJob(null);
      setSettingsOpen(false);
      setSaveSearchOpen(false);
      setMobileSearchesOpen(false);
      setView((current) => current === "saved" ? "all" : current);
    }
    return result;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadBootstrap(controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) return;
        loadDeadline.current = null;
        setError(message(error));
        setLoading(false);
      });
    return () => controller.abort();
  }, [loadBootstrap]);

  useEffect(() => {
    if (!memoryFiltersReady) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      category,
      q: query,
      district,
      view,
      mode: "buy",
      opportunities: String(opportunities),
      minVramGb: String(minVramGb),
      includeUnknownMemory: String(includeUnknownMemory),
      sort,
    });
    if (maxPrice && Number(maxPrice) > 0) params.set("maxPrice", maxPrice);
    if (category !== "gpu") params.set("minRamGb", String(minRamGb));
    setLoading(true);
    void request<ListingsResponse>(`/listings?${params}`, {
      signal: controller.signal,
      timeoutMs: loadDeadline.current === null ? undefined : loadDeadline.current - performance.now(),
    })
      .then((result) => {
        setResponse(result);
        setError(null);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          loadDeadline.current = null;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    category,
    query,
    district,
    view,
    opportunities,
    maxPrice,
    minRamGb,
    minVramGb,
    includeUnknownMemory,
    memoryFiltersReady,
    sort,
    reload,
    canManage,
  ]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const result = await request<ListingDetail>(
        `/listings/${encodeURIComponent(id)}`,
      );
      if (selectedRef.current === id) {
        setDetail(result);
        setDetailError(null);
      }
    } catch (error) {
      if (selectedRef.current === id) setDetailError(message(error));
    }
  }, []);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (runsOpen) url.searchParams.set('page', 'runs'); else url.searchParams.delete('page');
    if (selectedId) {
      url.searchParams.set("listing", selectedId);
      url.searchParams.set("category", category);
    } else {
      url.searchParams.delete("listing");
    }
    window.history.replaceState(null, "", url);
  }, [selectedId, category, runsOpen]);

  useEffect(() => {
    if (!canManage || !activity.snapshot) return;
    const next = activity.snapshot.job, previous = activityJob.current;
    activityJob.current = next;
    setJob(next);
    setBootstrap(current => current?.access === 'admin' ? { ...current,
      schedule: activity.snapshot!.schedule, marketplace: activity.snapshot!.runs.marketplace } : current);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    const finished = previous && isRunning(previous) && (!next || !isRunning(next));
    if (finished || Date.now() - lastMarketUpdate.current > 1800) {
      lastMarketUpdate.current = Date.now(); setReload(value => value + 1);
    }
    if (finished) {
      void loadBootstrap().catch(error => setError(message(error)));
      if (selectedRef.current) void loadDetail(selectedRef.current);
      if (next?.status === 'failed') setToast({ text: next.error || 'The refresh failed. Previously collected data is still available.' });
      else if (next?.status === 'complete') setToast({ text: 'Refresh complete. Nationwide evidence is ready to inspect.' });
      else if (next?.status === 'waiting') setToast({ text: next.message });
    }
  }, [canManage, activity.snapshot, loadBootstrap, loadDetail]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => setToast(null),
      toast.undo ? 8000 : 5000,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);

  const closeDetail = useCallback(() => setSelectedId(null), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const changeCategory = (next: Category) => {
    setRunsOpen(false);
    setCategory(next);
    setQuery("");
    setQueryInput("");
    setDistrict("");
    setView("all");
    setResponse(null);
  };
  const changeState = async (id: string, state: Partial<ListingState>) => {
    if (!canManage) return;
    try {
      const result = await post<ListingView>(
        `/listings/${encodeURIComponent(id)}/state`,
        state,
      );
      if (selectedRef.current === id)
        setDetail((current) =>
          current ? { ...result, history: current.history } : null,
        );
      setReload((value) => value + 1);
      void loadBootstrap();
      return result;
    } catch (error) {
      setToast({ text: message(error) });
      throw error;
    }
  };
  const dismissListing = (item: ListingView) => {
    if (!canManage) return;
    void changeState(item.id, { dismissed: !item.state.dismissed })
      .then(() => {
        setToast({
          text: item.state.dismissed
            ? "Listing restored to the feed."
            : "Listing dismissed.",
          undo: () => {
            void changeState(item.id, {
              dismissed: item.state.dismissed,
            }).catch(() => {});
            setToast(null);
          },
        });
      })
      .catch(() => {});
  };
  const startRefresh = async (limit?: number, targetQuery = query) => {
    if (!adminBootstrap) return;
    setRefreshing(true);
    try {
      const result = await post<{ job: RefreshJob }>("/refresh", {
        category,
        query: targetQuery,
        limit: limit ?? adminBootstrap.settings.scanLimit,
        minRamGb,
        minVramGb,
        includeUnknownMemory,
      });
      acceptJob(result.job);
      if (result.job.status === "waiting") setToast({ text: result.job.message });
      setError(null);
    } catch (error) {
      setError(message(error));
    } finally {
      setRefreshing(false);
    }
  };
  const analyzeListing = async (id: string) => {
    if (!canManage) return;
    try {
      const result = await post<{ job: RefreshJob }>(
        `/listings/${encodeURIComponent(id)}/analyze`,
      );
      acceptJob(result.job);
      if (result.job.status === "waiting") setToast({ text: result.job.message });
    } catch (error) {
      setToast({ text: message(error) });
      throw error;
    }
  };
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const nextQuery = queryInput.trim();
    setQuery(nextQuery);
    setResponse(null);
    if (canManage && !running && !refreshing)
      void startRefresh(undefined, nextQuery);
  };
  const useSearch = (search: SavedSearch) => {
    if (!canManage) return;
    setRunsOpen(false);
    setCategory(search.category);
    setQuery(search.query);
    setQueryInput(search.query);
    setDistrict(search.district);
    setMaxPrice(search.maxPrice ? String(search.maxPrice) : "");
    setMinRamGb(search.minRamGb ?? bootstrap?.settings.minRamGb ?? 16);
    setMinVramGb(search.minVramGb ?? bootstrap?.settings.minVramGb ?? 8);
    setIncludeUnknownMemory(search.includeUnknownMemory ?? bootstrap?.settings.includeUnknownMemory ?? true);
    setOpportunities(search.opportunities ?? false);
    setView("all");
    setResponse(null);
  };
  const saveSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage) return;
    setSavingSearch(true);
    try {
      await post("/searches", {
        name:
          searchName.trim() ||
          `${categoryLabels[category]}${query ? ` · ${query}` : " in Da Nang"}`,
        category,
        query,
        district,
        mode: "buy",
        maxPrice: maxPrice && Number(maxPrice) > 0 ? Number(maxPrice) : null,
        minRamGb,
        minVramGb,
        includeUnknownMemory,
        opportunities,
      });
      await loadBootstrap();
      setSaveSearchOpen(false);
      setToast({ text: "Search saved. Run it again from the sidebar." });
    } catch (error) {
      setToast({ text: message(error) });
    } finally {
      setSavingSearch(false);
    }
  };
  const deleteSearch = async (id: string) => {
    if (!canManage) return;
    try {
      await request(`/searches/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await loadBootstrap();
    } catch (error) {
      setToast({ text: message(error) });
    }
  };
  const retryLoading = async () => {
    loadDeadline.current = performance.now() + READ_TIMEOUT_MS;
    setLoading(true);
    setError(null);
    try {
      await loadBootstrap();
      setReload((value) => value + 1);
    } catch (error) {
      loadDeadline.current = null;
      setError(message(error));
      setLoading(false);
    }
  };
  const running = canManage && isRunning(job);
  const ai = canManage ? response?.ai || adminBootstrap.ai : null;
  const stats = response?.stats;
  const coverage = response?.coverage;
  const Icon = icons[category];
  const items = response?.items ?? [];
  const hasActiveFilters = Boolean(query || district || maxPrice || opportunities || (category !== "gpu" && minRamGb > 0) || minVramGb > 0 || !includeUnknownMemory);
  const expandedLimit = Math.min(
    1000,
    Math.max(
      200,
      (coverage?.limit ?? adminBootstrap?.settings.scanLimit ?? DEFAULT_SCAN_LIMIT) * 2,
    ),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href={workspaceHome} aria-label="Flipper home">
          <span className="brand-mark">
            f<span />
          </span>
          <span>
            flipper<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="live-dot" /> {canManage ? "PERSONAL WORKSPACE" : "PUBLIC MARKET"}
        </div>
        <nav className="sidebar-nav" aria-label="Hardware categories">
          <span className="nav-heading">DISCOVER</span>
          {categories.map((value) => {
            const CategoryIcon = icons[value];
            return (
              <button
                key={value}
                className={`nav-item ${!runsOpen && category === value && view === "all" ? "active" : ""}`}
                onClick={() => changeCategory(value)}
              >
                <CategoryIcon size={19} />
                <span>{categoryLabels[value]}</span>
                <span className="nav-count">
                  {bootstrap?.counts[value] ?? 0}
                </span>
              </button>
            );
          })}
          <span className="nav-heading nav-spaced">{canManage ? "YOUR WORKSPACE" : "MARKET EVIDENCE"}</span>
          {canManage && <button className={`nav-item ${runsOpen ? 'active' : ''}`} onClick={() => setRunsOpen(true)}><RefreshCw size={18} /><span>Runs</span></button>}
          {canManage && <button
            className={`nav-item ${!runsOpen && view === "saved" ? "active" : ""}`}
            onClick={() => { setRunsOpen(false); setView("saved"); }}
          >
            <Bookmark size={18} />
            <span>Shortlist</span>
            {(stats?.saved ?? 0) > 0 && (
              <span className="nav-count">{stats?.saved}</span>
            )}
          </button>}
          <button
            className={`nav-item ${!runsOpen && view === "review" ? "active" : ""}`}
            onClick={() => { setRunsOpen(false); setView("review"); }}
          >
            <ShieldCheck size={18} />
            <span>Needs a closer look</span>
          </button>
          <button
            className={`nav-item ${!runsOpen && view === "history" ? "active" : ""}`}
            onClick={() => { setRunsOpen(false); setView("history"); setOpportunities(false); }}
          >
            <Grid2X2 size={18} />
            <span>Historical observations</span>
          </button>
        </nav>
        {canManage && <div className="saved-searches">
          <div className="nav-heading saved-search-heading">
            <span>SAVED SEARCHES</span>
            <button
              className="icon-button small"
              aria-label="Save current search"
              onClick={() => {
                setSearchName("");
                setSaveSearchOpen(true);
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {(bootstrap?.searches ?? []).map((search) => (
            <div className="saved-search-row" key={search.id}>
              <button
                onClick={() => useSearch(search)}
                title={`${categoryLabels[search.category]} · ${search.query || "all models"}`}
              >
                <Search size={14} />
                <span>{search.name}</span>
              </button>
              <button
                className="icon-button small delete-search"
                onClick={() => void deleteSearch(search.id)}
                aria-label={`Delete saved search ${search.name}`}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          {!bootstrap?.searches.length && (
            <p className="sidebar-hint">
              A model you keep looking for?
              <br />
              Save the search for next time.
            </p>
          )}
        </div>}
        <div className="sidebar-bottom">
          <div className="location-card">
            <div className="location-icon">
              <MapPin size={18} />
            </div>
            <div>
              <strong>Da Nang, Vietnam</strong>
              <span>Local pickup · supported price evidence</span>
            </div>
          </div>
          {canManage && <button className="nav-item" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={18} />
            <span>Settings & AI</span>
            <span
              className={`ai-dot ${ai?.configured && ai.enabled && ai.status === "ready" ? "connected" : ""}`}
            />
          </button>}
          <div className="sidebar-footnote">
            <span className="source-dot" />
            {canManage ? "Chợ Tốt · manual & daily scans" : "Chợ Tốt · retained market evidence"}
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Discover</span>
            <ChevronRight size={14} />
            <strong>
              {runsOpen && canManage ? 'Runs' : view === "all" ? categoryLabels[category] : viewLabels[view]}
            </strong>
          </div>
          <div className="topbar-right">
            {canManage && <ActivityConnection connection={activity.connection} />}
            {canManage && <button className="button subtle runs-link" onClick={() => setRunsOpen(value => !value)}>{runsOpen ? 'Market' : 'Runs'}</button>}
            <span className="nationwide-label">
              <ShieldCheck size={14} /> Price evidence
            </span>
            {canManage && <button
              className="icon-button settings-top"
              aria-label="Open settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={19} />
            </button>}
            {canManage && <span className="avatar" title="Your personal workspace">
              F
            </span>}
            <a className="access-link" href={canManage ? "/?public=1" : "/admin/"}>
              {canManage ? "Public view" : new URLSearchParams(window.location.search).get('public') === '1' ? "Admin workspace" : "Sign in"}
              <ArrowRight size={14} />
            </a>
          </div>
        </header>
        {runsOpen && adminBootstrap ? <Runs settings={adminBootstrap.settings} activity={activity} onJob={acceptJob} onDefaultsSaved={value => {
          setBootstrap(value); setReload(count => count + 1);
          setMinRamGb(value.settings.minRamGb); setMinVramGb(value.settings.minVramGb);
          setIncludeUnknownMemory(value.settings.includeUnknownMemory);
        }} onResults={run => {
          changeCategory(run.job.category); setQuery(run.job.query); setQueryInput(run.job.query);
          setMaxPrice(''); setOpportunities(false); setMinRamGb(run.parameters.minRamGb); setMinVramGb(run.parameters.minVramGb);
          setIncludeUnknownMemory(run.parameters.includeUnknownMemory); setReload(value => value + 1);
          if (run.listingId) setSelectedId(run.listingId);
        }} /> : <section className="page-content">
          <div className="page-heading">
            <div>
              <div className="page-kicker">
                <span className="live-dot" /> DA NANG FINDS
              </div>
              <h1>
                {view === "saved"
                  ? "Your shortlist."
                  : view === "review"
                    ? "Look a little closer."
                    : view === "history" ? "Previously observed hardware."
                    : view === "indicative" ? "Early price comparisons."
                    : view === "components" ? "Below component value."
                    : view === "retail" ? "Below depreciated estimates."
                    : "Good hardware. Better prices."}
              </h1>
              <p>
                {view === "saved"
                  ? "The finds you want to come back to. Price evidence stays one click away."
                  : view === "review"
                    ? "Missing specs, conflicting details, and listings that need your judgment."
                    : view === "history" ? "Retained observations outside the latest successful collection. Dates show when each price was retrieved; availability needs checking."
                    : view === "indicative" ? "These estimates need stronger source, configuration, or freshness evidence before they can qualify as good prices."
                    : view === "components" ? "The asking price is below the supported value of identified parts. Omitted parts remain unpriced."
                    : view === "retail" ? "Current new retail prices with a 25% reduction. Desktop totals cover only priced components; used-market comparisons remain separate."
                    : "Find used laptops, desktops, and GPUs from the latest successful collection."}
              </p>
            </div>
            {canManage ? <button
              className="button primary refresh-button"
              onClick={() => void startRefresh()}
              disabled={running || refreshing || !bootstrap}
            >
              {running || refreshing ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <RefreshCw size={17} />
              )}
              <span>{running ? "Scanning…" : "Refresh market"}</span>
            </button> : <span className="read-only-badge"><ShieldCheck size={15} /> Read-only market view</span>}
          </div>

          <div className={`overview-grid${canManage ? "" : " public-overview"}`}>
            <Stat
              label="Listings scanned"
              value={stats?.scanned ?? 0}
              icon={<Grid2X2 size={17} />}
              note={
                coverage
                  ? `Updated ${timeAgo(coverage.completedAt)}`
                  : canManage ? "Run a scan to get started" : "Stored market listings"
              }
            />
            <Stat
              label="Price references"
              value={stats?.benchmarked ?? 0}
              icon={<ShieldCheck size={17} />}
              note={category === 'laptop' ? `Same-parts laptops · ${bootstrap?.settings.minComparables ?? 5}+ sellers for scoring` : `3+ offers indicative · ${bootstrap?.settings.minComparables ?? 5}+ for scoring`}
            />
            <Stat
              label="Good-price finds"
              value={stats?.opportunities ?? 0}
              icon={<TrendingDown size={18} />}
              note="Any amount strictly below the reference"
              accent
            />
            {canManage && <Stat
              label="Saved for later"
              value={stats?.saved ?? 0}
              icon={<Bookmark size={17} />}
              note="Your personal shortlist"
            />}
          </div>

          {error && (
            <div className="notice error-notice" role="alert">
              <TriangleAlert size={18} />
              <div>
                <strong>Couldn’t complete the request</strong>
                <p>{error}</p>
              </div>
              <button
                className="button subtle"
                disabled={loading}
                onClick={() => void retryLoading()}
              >
                Retry
              </button>
            </div>
          )}
          {canManage && job && running && (
            <div className="scan-panel" role="status">
              <div className="scan-head">
                <span className="scan-icon">
                  <RefreshCw size={18} className="spin" />
                </span>
                <div>
                  <strong>
                    {job.status === "collecting"
                      ? "Collecting local listings"
                      : job.status === "assessing"
                        ? "Reading specifications"
                        : "Comparing nationwide prices"}
                  </strong>
                  <p>{job.message}</p>
                </div>
                <button
                  className="button subtle"
                  onClick={() => {
                    if (!canManage) return;
                    void post<{ job: RefreshJob }>(`/jobs/${job.id}/cancel`)
                      .then((result) => acceptJob(result.job))
                      .catch((error) => setError(message(error)));
                  }}
                >
                  Cancel
                </button>
              </div>
              <div className="scan-track">
                <div
                  style={{
                    width: `${job.status === "collecting" ? Math.max(4, Math.min(40, (job.scanned / Math.max(1, job.target)) * 40)) : job.status === "assessing" ? 40 + Math.min(25, (job.assessed / Math.max(1, job.scanned)) * 25) : 65 + Math.min(30, (job.benchmarked / Math.max(1, job.scanned)) * 30)}%`,
                  }}
                />
              </div>
              <div className="scan-meta">
                <span>
                  {categoryLabels[job.category]}
                  {job.query && ` · ${job.query}`}
                </span>
                <span>
                  {job.scanned} listings · {job.benchmarked} references · AI{" "}
                  {usd(job.aiCostUsd)}
                </span>
              </div>
            </div>
          )}
          {canManage && coverage?.error && !running && (
            <div className="notice warning-notice">
              <TriangleAlert size={18} />
              <div>
                <strong>Last refresh was incomplete</strong>
                <p>
                  {coverage.error} Cached listings are shown with their
                  observation times.
                </p>
              </div>
            </div>
          )}

          <div className="feed-section">
            <div className="feed-header">
              <div
                className="category-tabs"
                role="group"
                aria-label="Feed category"
              >
                {categories.map((value) => {
                  const CategoryIcon = icons[value];
                  return (
                    <button
                      key={value}
                      className={category === value ? "selected" : ""}
                      onClick={() => changeCategory(value)}
                    >
                      <CategoryIcon size={17} />
                      <span>{categoryLabels[value]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="search-toolbar">
              <form className="search-form" onSubmit={submitSearch}>
                <Search size={18} />
                <input
                  aria-label="Search hardware models"
                  placeholder={
                    category === "gpu"
                      ? "Search a GPU, e.g. RTX 3060 12GB"
                      : category === "laptop"
                        ? "Search a model, e.g. ThinkPad T14"
                        : "Search a build, CPU, or GPU…"
                  }
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                />
                <button
                  type="submit"
                  className="search-submit"
                  aria-label="Apply model search"
                >
                  <ArrowRight size={17} />
                </button>
              </form>
              <label className="select-control district-filter">
                <MapPin size={16} />
                <select
                  value={district}
                  onChange={(event) => setDistrict(event.target.value)}
                  aria-label="Filter by district"
                >
                  <option value="">All Da Nang</option>
                  {(response?.districts ?? []).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
              {category !== "gpu" && (
                <label className="select-control ram-filter" title="Minimum system RAM for laptops and desktops. Unknown capacities follow the unknown-memory setting.">
                  <Cpu size={16} />
                  <select
                    value={minRamGb}
                    onChange={(event) => setMinRamGb(Number(event.target.value))}
                    aria-label="Minimum RAM in GB"
                  >
                    <option value={0}>Any RAM</option>
                    {ramMinimums.map((value) => (
                      <option key={value} value={value}>RAM ≥ {value} GB</option>
                    ))}
                    {minRamGb > 0 && !ramMinimums.includes(minRamGb) && (
                      <option value={minRamGb}>RAM ≥ {minRamGb} GB</option>
                    )}
                  </select>
                  <ChevronDown size={14} />
                </label>
              )}
              <label className="select-control vram-filter" title="Minimum dedicated GPU memory. Integrated-only computers and computers explicitly sold without a discrete GPU are exempt.">
                <Cpu size={16} />
                <select
                  value={minVramGb}
                  onChange={(event) => setMinVramGb(Number(event.target.value))}
                  aria-label="Minimum GPU VRAM in GB"
                >
                  <option value={0}>Any VRAM</option>
                  {vramMinimums.map((value) => (
                    <option key={value} value={value}>VRAM ≥ {value} GB</option>
                  ))}
                  {minVramGb > 0 && !vramMinimums.includes(minVramGb) && (
                    <option value={minVramGb}>VRAM ≥ {minVramGb} GB</option>
                  )}
                </select>
                <ChevronDown size={14} />
              </label>
              <label className="price-filter">
                <span>Max ₫</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Any price"
                  value={maxPrice}
                  onChange={(event) => setMaxPrice(event.target.value)}
                  aria-label="Maximum asking price in VND"
                />
              </label>
              {canManage && <button
                className="button save-search-button"
                onClick={() => {
                  setSearchName("");
                  setSaveSearchOpen(!saveSearchOpen);
                }}
                title="Save this search"
              >
                <Bookmark size={16} />
                <span>Save search</span>
              </button>}
              {canManage && <button
                className="button mobile-searches-button"
                onClick={() => setMobileSearchesOpen(!mobileSearchesOpen)}
                aria-expanded={mobileSearchesOpen}
                aria-controls="mobile-saved-searches"
              >
                <Search size={15} />
                Saved searches
                <ChevronDown size={13} />
              </button>}
            </div>
            {canManage && mobileSearchesOpen && (
              <div id="mobile-saved-searches" className="mobile-searches-panel">
                {bootstrap?.searches.length ? (
                  bootstrap.searches.map((search) => (
                    <div key={search.id}>
                      <button
                        onClick={() => {
                          useSearch(search);
                          setMobileSearchesOpen(false);
                        }}
                      >
                        <Search size={14} />
                        <span>
                          <strong>{search.name}</strong>
                          <small>
                            {categoryLabels[search.category]} ·{" "}
                            {search.query || "All models"}
                          </small>
                        </span>
                        <ArrowRight size={14} />
                      </button>
                      <button
                        className="icon-button small"
                        onClick={() => void deleteSearch(search.id)}
                        aria-label={`Delete saved search ${search.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p>Save a model search to find it here next time.</p>
                )}
              </div>
            )}
            {canManage && saveSearchOpen && (
              <form className="save-search-form" onSubmit={saveSearch}>
                <label htmlFor="search-name">Name this search</label>
                <input
                  id="search-name"
                  autoFocus
                  placeholder={`${categoryLabels[category]}${query ? ` · ${query}` : " in Da Nang"}`}
                  value={searchName}
                  onChange={(event) => setSearchName(event.target.value)}
                  maxLength={100}
                />
                <button className="button primary" disabled={savingSearch}>
                  {savingSearch ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Check size={15} />
                  )}{" "}
                  Save
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel saving search"
                  onClick={() => setSaveSearchOpen(false)}
                >
                  <X size={17} />
                </button>
              </form>
            )}
            <div className="filter-row">
              <div className="filter-left">
                <button
                  className={`deal-filter ${opportunities ? "enabled" : ""}`}
                  onClick={() => setOpportunities(!opportunities)}
                  aria-pressed={opportunities}
                  disabled={view === "components" || view === "indicative" || view === "retail"}
                >
                  <span className="toggle-track">
                    <span />
                  </span>
                  <TrendingDown size={15} />
                  Deals only{" "}
                  <span className="threshold">Any amount below</span>
                </button>
                <span className="filter-divider" />
                <label className="unknown-memory-filter" title="Include listings with unknown RAM or VRAM capacity. Confirmed lower capacities still fail the selected minimums.">
                  <input
                    type="checkbox"
                    checked={includeUnknownMemory}
                    onChange={(event) => setIncludeUnknownMemory(event.target.checked)}
                  />
                  Include unknown RAM / VRAM
                </label>
                <span className="filter-divider" />
                <label className="plain-select">
                  <SlidersHorizontal size={14} />
                  <select
                    aria-label="Listing view"
                    value={view}
                    onChange={(event) => { setView(event.target.value as View); setOpportunities(false); }}
                  >
                    <option value="all">Working used items</option>
                    {canManage && <option value="saved">Shortlist</option>}
                    <option value="review">{canManage ? "Needs review & dismissed" : "Needs review"}</option>
                    <option value="indicative">Indicative comparisons ({stats?.indicative ?? 0})</option>
                    <option value="components">Below component value ({stats?.componentOpportunities ?? 0})</option>
                    {category !== 'laptop' && <option value="retail">Below depreciated estimates ({stats?.retailOpportunities ?? 0})</option>}
                    <option value="history">Historical observations</option>
                  </select>
                  <ChevronDown size={12} />
                </label>
              </div>
              <label className="plain-select sort-select">
                <ArrowDownUp size={14} />
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                  aria-label="Sort listings"
                >
                  <option value="value">Best value first</option>
                  <option value="newest">Recently observed</option>
                  <option value="price">Lowest price first</option>
                </select>
                <ChevronDown size={12} />
              </label>
            </div>
            {category !== "gpu" && (
              <p className="memory-filter-help">VRAM minimum applies when a discrete GPU is included. Integrated-only and explicitly GPU-free computers are included.</p>
            )}

            <div className="results-heading">
              <div>
                <h2>
                  {view !== "all" ? viewLabels[view] : query
                        ? `Results for “${query}”`
                        : `Discover ${categoryLabels[category].toLowerCase()}`}
                  <span>{response?.total ?? 0}</span>
                </h2>
                <p>
                  {view === "history" ? "Dated observations outside the current collection"
                    : view === "components" ? "Identified parts with supported prices; whole-PC value remains unpriced"
                    : view === "retail" ? "Lowest verified new prices × 75% retained value; these are policy estimates"
                    : category === 'laptop' ? 'Used laptops compared with same-parts laptops across Vietnam; MacBooks with new retail or launch prices'
                    : "Local asking prices, with matching used offers across Vietnam"}
                </p>
                <p>Prices and budgets in VND · retail prices cached for 7 days</p>
              </div>
              {loading && response && (
                <span className="updating">
                  <LoaderCircle size={13} className="spin" />
                  Updating
                </span>
              )}
            </div>
            {loading && !response ? (
              <div className="loading-state">
                <LoaderCircle size={28} className="spin" />
                <strong>{canManage ? "Opening your workspace…" : "Opening the market…"}</strong>
              </div>
            ) : !response && error ? (
              <div className="empty-state">
                <div className="empty-icon"><TriangleAlert size={40} strokeWidth={1.4} /></div>
                <h3>Couldn’t load listings.</h3>
                <p>Use Retry above to load the market again.</p>
              </div>
            ) : items.length ? (
              <div className="listing-grid">
                {items.map((item) => (
                  <ListingCard
                    key={item.id}
                    item={item}
                    canManage={canManage}
                    onOpen={() => setSelectedId(item.id)}
                    onSave={() => {
                      void changeState(item.id, {
                        saved: !item.state.saved,
                      }).catch(() => {});
                    }}
                    onDismiss={() => dismissListing(item)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon size={40} strokeWidth={1.4} />
                  <span>
                    <Search size={15} />
                  </span>
                </div>
                <h3>
                  {view === "saved"
                    ? "Make room for a good find."
                    : view === "review"
                      ? "Nothing in the review queue."
                      : view === "history" ? "No historical observations match."
                      : view === "indicative" ? "No indicative comparisons match."
                      : view === "components" ? "No component-value finds match."
                      : view === "retail" ? "No depreciated-estimate finds match."
                      : coverage
                        ? opportunities
                          ? "No verified price gaps yet."
                          : "No listings match these filters."
                        : canManage ? "Your next good find starts here." : "No market listings are available yet."}
                </h3>
                <p>
                  {view === "saved"
                    ? "Use the bookmark on any listing to keep it here. Active memory and search filters also apply to your shortlist."
                    : view === "review"
                      ? "Listings with conflicting specifications, unclear prices, or other details to check appear here. Active filters also apply."
                      : view === "history" ? "Observations outside the latest successful collection appear here with their retrieval dates. Active filters also apply."
                      : view === "indicative" ? "Estimates with incomplete source, configuration, or freshness evidence appear here without a deal badge."
                      : view === "components" ? 'The asking price must be strictly below independently supported component values. Whole-PC value remains unpriced.'
                      : view === "retail" ? 'Fresh, verified retail inputs and a current eligible asking price below the depreciated estimate are needed. Incomplete matches remain indicative.'
                      : coverage
                        ? opportunities
                          ? `A find needs a supported reference and an asking price strictly below it. ${canManage ? "Browse all items or collect more evidence." : "Try browsing all items."}`
                          : `Try another model, district, RAM or VRAM minimum, unknown-memory setting, or maximum price.${canManage ? " You can refresh a focused search too." : ""}`
                        : canManage
                          ? `Scan used ${categoryLabels[category].toLowerCase()} in Da Nang. Flipper checks price evidence for each configuration.`
                          : "Flipper shows stored used-hardware listings and their price evidence. Check another category or return after the market data is updated."}
                </p>
                {(view === "all" || hasActiveFilters) && (
                  <div className="empty-actions">
                    {view === "all" && (opportunities && coverage ? (
                      <button
                        className="button primary"
                        onClick={() => setOpportunities(false)}
                      >
                        Browse all items
                        <ArrowRight size={16} />
                      </button>
                    ) : canManage ? (
                      <button
                        className="button primary"
                        onClick={() => void startRefresh()}
                        disabled={running || refreshing || !bootstrap}
                      >
                        <RefreshCw size={16} />
                        {running
                          ? "Scan in progress"
                          : `Scan ${categoryLabels[category].toLowerCase()}`}
                      </button>
                    ) : null)}
                    {hasActiveFilters && (
                      <button
                        className="button"
                        onClick={() => {
                          setQuery("");
                          setQueryInput("");
                          setDistrict("");
                          setMaxPrice("");
                          setMinRamGb(0);
                          setMinVramGb(0);
                          setIncludeUnknownMemory(true);
                          setOpportunities(false);
                        }}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                )}
                <div className="empty-note">
                  <ShieldCheck size={14} />
                  No invented prices. Insufficient evidence stays visible.
                </div>
              </div>
            )}

            <footer className="feed-footer">
              <div>
                <span className="source-dot" />
                <span>
                  {coverage
                    ? `${coverage.scanned} recent listings scanned${coverage.totalAvailable !== null ? ` of ${coverage.totalAvailable.toLocaleString()} source results` : ""} · ${date(coverage.completedAt)}`
                    : "Chợ Tốt · public listings · no scan yet"}
                </span>
              </div>
              {canManage && coverage && coverage.limit < 1000 && (
                <button
                  onClick={() => void startRefresh(expandedLimit)}
                  disabled={running || refreshing}
                >
                  Expand scan to {expandedLimit}
                  <ArrowRight size={14} />
                </button>
              )}
            </footer>
            {items.some((item) => hasTechApiMemoryData(item.assessment) ||
              item.assessment.priceOptions?.some(hasTechApiMemoryData)) && (
              <p className="memory-data-attribution">
                Specification information includes adapted data from{" "}
                <a href={safeSourceUrl("https://gettechapi.github.io/TechAPI/")} target="_blank" rel="noreferrer">TechAPI</a>
                {" · "}
                <a href={safeSourceUrl("https://creativecommons.org/licenses/by-sa/4.0/")} target="_blank" rel="noreferrer">CC BY-SA 4.0</a>.
                {" "}Hardware-derived memory types and external catalog references are labelled on each listing.
              </p>
            )}
          </div>
          <div className="method-note">
            <CircleHelp size={16} />
            <p>
              Laptops other than MacBooks are compared with used laptops of any brand with the same processor and graphics, adjusted for RAM and SSD; a lower current new retail price caps them. MacBooks use new retail prices, with launch-price depreciation as a fallback.
              GPUs and desktops use filtered used asking prices; desktop configurations may be adjusted using verified part prices.
              Any amount strictly below a supported reference qualifies. Equality does not.{" "}
              {canManage ? <button onClick={() => setSettingsOpen(true)}>
                Price rules
              </button> : null}
            </p>
          </div>
          {canManage && ai && ai.status !== "ready" && (
            <button
              className="ai-callout"
              onClick={() => setSettingsOpen(true)}
            >
              <Sparkles size={18} />
              <span>
                <strong>
                  {ai.status === "not_configured"
                    ? "Add AI specification checks"
                    : ai.status === "disabled"
                      ? "AI assessment is switched off"
                      : ai.status === "budget_limited"
                        ? "The AI refresh budget was reached"
                        : "AI assessment needs attention"}
                </strong>
                <span>
                  {ai.lastError ||
                    (ai.status === "not_configured"
                      ? "Connect LiteLLM for MiMo extraction and Decider classification. Local rules and fetched price evidence remain available."
                      : "Inspect the provider status and refresh budget in settings.")}
                </span>
              </span>
              <ChevronRight size={18} />
            </button>
          )}
        </section>}
      </main>

      {selectedId && (
        <ListingDrawer
          item={detail}
          error={detailError}
          onClose={closeDetail}
          onRetry={() => void loadDetail(selectedId)}
          onState={(state) => changeState(selectedId, state)}
          onAnalyze={() => analyzeListing(selectedId)}
          running={running}
          settings={bootstrap?.settings}
          canManage={canManage}
        />
      )}
      {settingsOpen && adminBootstrap && (
        <SettingsDrawer
          activity={activity}
          bootstrap={adminBootstrap}
          onClose={closeSettings}
          onSaved={(value, quiet) => {
            setBootstrap(value);
            setReload((count) => count + 1);
            if (!quiet) {
              setMinRamGb(value.settings.minRamGb);
              setMinVramGb(value.settings.minVramGb);
              setIncludeUnknownMemory(value.settings.includeUnknownMemory);
              setToast({
                text: "Settings saved. Memory defaults are applied and price rules recalculated.",
              });
            }
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast.text}</span>
          {toast.undo && <button onClick={toast.undo}>Undo</button>}
          <button
            className="icon-button small"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  note,
  accent = false,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  note: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat-card ${accent ? "stat-accent" : ""}`}>
      <div className="stat-label">
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value.toLocaleString()}</strong>
      <span className="stat-note">{note}</span>
    </div>
  );
}

function ListingCard({
  item,
  canManage,
  onOpen,
  onSave,
  onDismiss,
}: {
  item: ListingView;
  canManage: boolean;
  onOpen: () => void;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const [failedImage, setFailedImage] = useState(false);
  const Icon = icons[item.category as Category] ?? Cpu;
  const matchingConfigurations = item.assessment.priceOptions?.filter((option) => option.price === item.price) ?? [];
  const displayedConfiguration = matchingConfigurations.length === 1 ? matchingConfigurations[0] : undefined;
  const profile = displayedConfiguration?.profile ?? item.assessment.profile;
  const memoryMetadata = displayedConfiguration ?? item.assessment;
  const valuation = item.valuation;
  const reference = valuation.reference;
  const discount = valuation.discountPercent;
  const adjusted = reference?.kind === "adjusted_configuration";
  const sameParts = reference?.kind === "parts_market";
  const missingDetails = [...new Set([
    ...(valuation.missingDetails ?? []),
    ...(reference?.missingDetails ?? []),
    ...(item.assessment.computer?.missing ?? []),
  ])];
  const specs = [
    profile.cpu,
    profile.gpuClass === "integrated" ? profile.gpu || "Integrated graphics"
      : profile.gpuInclusion === "absent" ? "No discrete GPU included" : profile.gpu,
    profile.storageGb
      ? `${profile.storageGb}GB ${profile.storageType || "storage"}`
      : null,
  ].filter(Boolean);
  const image = safeSourceUrl(item.images[0] || "");
  return (
    <article
      className={`listing-card ${valuation.opportunity ? "card-opportunity" : ""}`}
    >
      <div className="listing-image">
        <button
          onClick={onOpen}
          className="image-button"
          aria-label={`Inspect ${item.title}`}
        >
          {image && !failedImage ? (
            <img
              src={image}
              alt={item.title}
              loading="lazy"
              onError={() => setFailedImage(true)}
            />
          ) : (
            <div className="image-placeholder">
              <Icon size={45} strokeWidth={1.3} />
              <span>Photo unavailable</span>
            </div>
          )}
        </button>
        <div className="image-tags">
          {valuation.opportunity || valuation.componentOpportunity ? (
            <span
              className={`deal-badge ${reference?.kind === "component_floor" ? "component-badge" : ""}`}
            >
              <TrendingDown size={13} />
              {valuation.componentOpportunity ? "Below component value" : sameParts ? "Good price vs same-parts laptops" : reference?.retail
                ? reference.retail.basis === 'current_new' ? 'Good price vs new retail' : 'Good price vs depreciation estimate'
                : `Good price · below${adjusted ? " adjusted reference" : " market"}`}
            </span>
          ) : (
            <span className="condition-badge">
              {item.assessment.eligibility === "review"
                ? "Needs review"
                : item.assessment.eligibility === "excluded"
                  ? "Excluded"
                  : "Used hardware"}
            </span>
          )}
        </div>
        {canManage && <button
          className={`bookmark-button ${item.state.saved ? "is-saved" : ""}`}
          onClick={onSave}
          aria-label={
            item.state.saved ? `Unsave ${item.title}` : `Save ${item.title}`
          }
          aria-pressed={item.state.saved}
        >
          <Bookmark
            size={18}
            fill={item.state.saved ? "currentColor" : "none"}
          />
        </button>}
      </div>
      <div className="listing-body">
        <div className="listing-location">
          <MapPin size={12} />
          <span>{item.district || item.region || "Da Nang"}</span>
          <span className="listing-age" title={date(item.observedAt)}>Observed {timeAgo(item.observedAt)}</span>
        </div>
        <button className="listing-title" onClick={onOpen}>
          {item.title}
        </button>
        <p className="listing-specs">
          {specs.slice(0, 3).join(" · ") || "Specifications need a closer look"}
        </p>
        <div className="listing-memory">
          {item.category !== "gpu" && <span>RAM: {memoryDescription(profile, "ram", memoryMetadata)}</span>}
          {hasDedicatedVram(profile) && <span>VRAM: {memoryDescription(profile, "vram", memoryMetadata)}</span>}
          {hasMemoryTypeEstimates(memoryMetadata) && (
            <button className="derived-memory-label" onClick={onOpen} title="Inspect the identified hardware, possible memory types, and source evidence">Memory type evidence</button>
          )}
        </div>
        <div className="asking-row">
          <strong>{compactMoney(item.price)}</strong>
          <span>asking price</span>
        </div>
        {displayedConfiguration && (
          <p className="listing-configuration">{displayedConfiguration.label}</p>
        )}
        {reference ? (
          <div className="reference-box">
            <div>
              <span>
                {reference.retail ? reference.label : sameParts
                  ? valuation.status === "indicative" ? "Indicative same-parts average" : "Same-parts laptop average"
                  : adjusted
                  ? valuation.status === "indicative" ? "Indicative adjusted average" : "Component-adjusted average"
                  : valuation.status === "indicative"
                  ? "Indicative average"
                  : reference.kind === "component_floor"
                  ? "Partial component baseline"
                  : "Nationwide average"}
              </span>
              <strong>{compactMoney(reference.average)}</strong>
            </div>
            <div className="reference-caption">
              <span>
                {reference.retail ? `${reference.sampleCount} retail source${reference.sampleCount === 1 ? '' : 's'} · ${reference.retail.fxStale ? 'stale exchange rate · indicative only' : valuation.status === 'indicative' ? 'indicative only' : valuation.confidence+' confidence'}`
                  : sameParts ? `${reference.sampleCount} independent seller${reference.sampleCount === 1 ? '' : 's'} · ${valuation.status === 'indicative' ? 'indicative only' : valuation.confidence+' confidence'}`
                  : adjusted
                  ? `${reference.baseSampleCount ?? reference.adjustedOffers?.length ?? reference.offers.length} computer offers · smallest pool ${reference.sampleCount} sellers`
                  : reference.kind === "component_floor"
                  ? `${reference.components.length} supported components`
                  : `${reference.sampleCount} independent offers`}
              </span>
              <span
                className={
                  valuation.opportunity || valuation.componentOpportunity
                    ? "positive-text"
                    : ""
                }
              >
                {discount !== null
                  ? discount === 0 ? 'Equal to reference' : `${Math.abs(discount).toFixed(1)}% ${discount > 0 ? "below" : "above"}`
                  : valuation.status === "indicative" ? "Low evidence" : "—"}
              </span>
            </div>
          </div>
        ) : (
          <div className="reference-box reference-pending">
            <ShieldCheck size={15} />
            <div>
              <strong>
                {evidenceLabel(valuation)}
              </strong>
              <span>{valuation.reason}</span>
            </div>
          </div>
        )}
        {valuation.depreciatedRetail && <DepreciatedRetail estimate={valuation.depreciatedRetail} compact />}
        {missingDetails.length > 0 && (
          <button className="listing-missing-details" onClick={onOpen}>
            <Info size={14} />
            <span>{missingDetails.length} hardware {missingDetails.length === 1 ? "detail" : "details"} missing · {valuation.confidence} confidence</span>
          </button>
        )}
        <div className="listing-actions">
          <button onClick={onOpen}>
            Inspect price evidence
            <ArrowRight size={15} />
          </button>
          <div>
            <a
              href={safeSourceUrl(item.url)}
              target="_blank"
              rel="noreferrer"
              className="icon-button small"
              aria-label={`Open ${item.title} on Chợ Tốt`}
              title="Original listing"
            >
              <ExternalLink size={15} />
            </a>
            {canManage && <button
              className="icon-button small"
              onClick={onDismiss}
              aria-label={
                item.state.dismissed
                  ? `Restore ${item.title}`
                  : `Dismiss ${item.title}`
              }
              title={
                item.state.dismissed ? "Restore listing" : "Dismiss listing"
              }
            >
              {item.state.dismissed ? (
                <RefreshCw size={14} />
              ) : (
                <Trash2 size={14} />
              )}
            </button>}
          </div>
        </div>
      </div>
    </article>
  );
}
