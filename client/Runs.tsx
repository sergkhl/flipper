import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowRight, ChevronDown, Play, RefreshCw, Settings2 } from 'lucide-react';
import type { AppSettings, Category, RefreshJob, RunLimits, RunParameters, RunSummary, RunsResponse } from '../shared/types';
import { message, post, request } from './api';
import { categoryLabels, usd } from './format';

const activeStates = ['collecting', 'assessing', 'comparing'];
const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : '—';
const title = (run: RunSummary) => `${categoryLabels[run.job.category]}${run.listingId ? ' · listing analysis' : run.job.query ? ` · ${run.job.query}` : ' · market refresh'}`;
const statusLabel: Record<RunSummary['state'], string> = {
  collecting: 'Collecting', assessing: 'Extracting specifications', comparing: 'Comparing nationwide',
  waiting: 'Waiting to resume', complete: 'Complete', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
};

export default function Runs({ settings, onJob, onResults }: {
  settings: AppSettings;
  onJob: (job: RefreshJob) => void;
  onResults: (run: RunSummary) => void;
}) {
  const [data, setData] = useState<RunsResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [detail, setDetail] = useState<{ run: RunSummary; attempts: RunSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const actionLock = useRef(false);
  const [limits, setLimits] = useState<RunLimits | null>(null);
  const [limitsDirty, setLimitsDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [category, setCategory] = useState<Category>('laptop');
  const [query, setQuery] = useState('');
  const [parameters, setParameters] = useState<RunParameters>(() => ({ scanLimit: settings.scanLimit,
    benchmarkLimit: settings.benchmarkLimit, aiBudgetUsd: settings.aiBudgetUsd, aiEnabled: settings.aiEnabled,
    minRamGb: settings.minRamGb, minVramGb: settings.minVramGb, includeUnknownMemory: settings.includeUnknownMemory }));

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await request<RunsResponse>(`/runs?offset=${offset}`, { signal });
    if (signal?.aborted) return;
    setData(result);
    if (!dirtyRef.current) setLimits(result.limits);
    if (selected) {
      const result = await request<{ run: RunSummary; attempts: RunSummary[] }>(`/runs/${encodeURIComponent(selected)}`, { signal });
      if (!signal?.aborted && selectedRef.current === selected) setDetail(result);
    }
  }, [offset, selected]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await load(controller.signal); } catch (error) { if (!controller.signal.aborted) setError(message(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load]);
  const mutate = async (work: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true; setPending(true); setError(null); setNotice('');
    try { await work(); await load(); }
    catch (error) { setError(message(error)); }
    finally { actionLock.current = false; setPending(false); }
  };
  const act = (run: RunSummary, action: 'resume' | 'retry' | 'cancel' | 'again') => void mutate(async () => {
    const { job } = await post<{ job: RefreshJob }>(`/runs/${encodeURIComponent(run.id)}/${action}`, {});
    onJob(job); setDetail(null); setSelected(job.id);
    setNotice(action === 'cancel' ? 'Cancellation requested. Saved progress remains available.' : 'Run accepted. Progress appears below.');
  });
  const launch = (event: FormEvent) => {
    event.preventDefault();
    void mutate(async () => {
      const { job } = await post<{ job: RefreshJob }>('/runs', { category, query, parameters });
      onJob(job); setOffset(0); setDetail(null); setSelected(job.id); setNotice('Run started. You can leave this page while it runs.');
    });
  };
  const saveLimits = (event: FormEvent) => {
    event.preventDefault();
    void mutate(async () => {
      const result = await post<{ limits: RunLimits }>('/runs/limits', limits);
      dirtyRef.current = false; setLimitsDirty(false); setLimits(result.limits);
      setNotice('Limits saved. Workers change at the next start or resume; request allowances apply to subsequent requests.');
    });
  };
  const updateLimit = (key: keyof RunLimits, value: number) => {
    dirtyRef.current = true; setLimitsDirty(true); setLimits(current => current && ({ ...current, [key]: value }));
  };
  const busy = !data || data.busy || pending;
  const current = detail?.run;
  const actions = (run: RunSummary) => <div className="run-actions">
    {['failed', 'cancelled', 'interrupted', 'waiting'].includes(run.state) && <button className="button primary" disabled={busy}
      onClick={() => act(run, run.state === 'failed' ? 'retry' : 'resume')}><Play size={15} />{run.state === 'failed' ? 'Retry' : 'Resume'}</button>}
    {(activeStates.includes(run.state) || run.state === 'waiting' || run.state === 'failed' || run.state === 'interrupted') &&
      <button className="button" disabled={pending} onClick={() => act(run, 'cancel')}>Cancel</button>}
    {!activeStates.includes(run.state) && run.state !== 'waiting' && <button className="button" disabled={busy} onClick={() => act(run, 'again')}><RefreshCw size={15} />Run again</button>}
    <button className="button subtle" onClick={() => onResults(run)}>View listings <ArrowRight size={15} /></button>
  </div>;

  return <section className="page-content runs-page">
    <div className="page-heading"><div><div className="page-kicker">PRIVATE WORKSPACE</div><h1>Runs</h1>
      <p>Collect listings, extract specifications, and compare nationwide prices.</p></div><Activity size={30} /></div>
    {error && <div className="notice error-notice" role="alert">{error}<button className="button" onClick={() => void mutate(async () => {})}>Reload status</button></div>}
    {notice && <p className="run-notice" role="status">{notice}</p>}
    {!data && !error && <p role="status">Loading runs…</p>}
    {data?.busy && <div className="run-notice" role="status">{data.activeId ? <>A run is active. <button className="text-button" onClick={() => { setDetail(null); setSelected(data.activeId); }}>Inspect active run</button></> : 'New runs are unavailable during an AI connection test or deployment.'}</div>}
    {data && <div className="run-metrics">
      <div><span>Marketplace · rolling 24 hours</span><strong>{data.marketplace.requests.used} / {data.marketplace.requests.limit}</strong><small>{data.marketplace.requests.remaining} requests remaining</small></div>
      <div><span>Reserved for manual work</span><strong>{data.marketplace.requests.manualReserve}</strong><small>Automatic use: {data.marketplace.requests.automaticUsed}</small></div>
      <div><span>Active marketplace workers</span><strong>{data.marketplace.proxies?.activeWorkers ?? 0} / {data.marketplace.proxies?.workerLimit ?? data.limits.marketplaceWorkers}</strong><small>Three seconds between starts per worker</small></div>
      <div><span>Active AI workers</span><strong>{data.marketplace.ai?.active ?? 0} / {data.marketplace.ai?.limit ?? data.limits.aiWorkers}</strong><small>Shared run allowance</small></div>
    </div>}
    <div className="run-controls">
      <details className="run-panel"><summary><Play size={17} /> Start a run <ChevronDown size={16} /></summary>
        <form onSubmit={launch} className="run-form">
          <label>Category<select aria-label="Category" value={category} onChange={e => setCategory(e.target.value as Category)}>{(['laptop','desktop','gpu'] as const).map(c => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select></label>
          <label>Model search (optional)<input value={query} maxLength={200} onChange={e => setQuery(e.target.value)} placeholder="All models" /></label>
          <NumberField label="Local listings" value={parameters.scanLimit} min={1} max={1000} onChange={v => setParameters(p => ({ ...p, scanLimit: v }))} />
          <NumberField label="National offers per query" value={parameters.benchmarkLimit} min={20} max={60} onChange={v => setParameters(p => ({ ...p, benchmarkLimit: v }))} />
          <NumberField label="AI allowance (USD)" value={parameters.aiBudgetUsd} min={0} max={10} step={0.01} onChange={v => setParameters(p => ({ ...p, aiBudgetUsd: v }))} />
          <NumberField label="Minimum RAM (GB)" value={parameters.minRamGb} min={0} max={4096} onChange={v => setParameters(p => ({ ...p, minRamGb: v }))} />
          <NumberField label="Minimum VRAM (GB)" value={parameters.minVramGb} min={0} max={4096} onChange={v => setParameters(p => ({ ...p, minVramGb: v }))} />
          <label className="run-check"><input type="checkbox" checked={parameters.includeUnknownMemory} onChange={e => setParameters(p => ({ ...p, includeUnknownMemory: e.target.checked }))} />Include unknown memory</label>
          <label className="run-check"><input type="checkbox" checked={parameters.aiEnabled} onChange={e => setParameters(p => ({ ...p, aiEnabled: e.target.checked }))} />Use AI when configured</label>
          <p className="run-form-note">An empty search refreshes the category. Collection includes specification extraction and bounded nationwide comparisons. For one listing, use “Refresh this evidence” in its details.</p>
          <button className="button primary" disabled={busy} type="submit"><Play size={15} />Start run</button>
        </form>
      </details>
      <details className="run-panel"><summary><Settings2 size={17} /> Workers & request limits <ChevronDown size={16} /></summary>
        {limits && <form onSubmit={saveLimits} className="run-form">
          <NumberField label="Marketplace workers" value={limits.marketplaceWorkers} min={1} max={8} onChange={v => updateLimit('marketplaceWorkers', v)} />
          <NumberField label="AI workers" value={limits.aiWorkers} min={1} max={8} onChange={v => updateLimit('aiWorkers', v)} />
          <NumberField label="Total requests / 24h" value={limits.requestLimit} min={1} onChange={v => updateLimit('requestLimit', v)} />
          <NumberField label="Automatic requests / 24h" value={limits.automaticRequestLimit} min={1} max={limits.requestLimit} onChange={v => updateLimit('automaticRequestLimit', v)} />
          <NumberField label="Automatic requests / category / 24h" value={limits.automaticCategoryRequestLimit} min={1} max={limits.automaticRequestLimit} onChange={v => updateLimit('automaticCategoryRequestLimit', v)} />
          <p className="run-form-note">Manual reserve: {Math.max(0, limits.requestLimit - limits.automaticRequestLimit)} requests. Usage is never reset. A lower limit can pause active work. Workers change on the next start or resume. Run targets, filters, and AI allowances stay fixed.</p>
          <button className="button primary" type="submit" disabled={pending || !limitsDirty}>Save limits</button>
        </form>}
      </details>
    </div>
    <div className="run-history-heading"><h2>Activity</h2><span>Completed and cancelled history · 90 days</span></div>
    {data && !data.runs.length && <div className="run-panel run-empty"><h3>No runs yet</h3><p>Start a category refresh above. Scheduled scans and listing analyses appear here too.</p></div>}
    <div className="run-list">{data?.runs.map(run => <button key={run.id} className={`run-row ${current?.rootId === run.rootId ? 'selected' : ''}`}
      onClick={() => { setDetail(null); setSelected(run.id); }} aria-label={`Inspect ${title(run)}: ${statusLabel[run.state]}`}>
      <span><strong>{title(run)}</strong><small>{run.automatic ? 'Scheduled' : 'Manual'}{run.job.retryOf ? ' · resumed attempt' : ''} · {stamp(run.job.startedAt)}</small></span>
      <span className={`run-state state-${run.state}`}>{statusLabel[run.state]}</span>
      <span className="run-row-counts">{run.job.scanned} collected · {run.job.assessed} extracted · {run.job.benchmarked} compared</span>
      <ArrowRight size={17} />
    </button>)}</div>
    {data && (offset > 0 || data.hasMore) && <div className="run-actions"><button className="button" disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 50))}>Previous</button><span>Page {offset / 50 + 1}</span><button className="button" disabled={!data.hasMore} onClick={() => setOffset(v => v + 50)}>Next</button></div>}
    {selected && !detail && <p role="status">Loading run details…</p>}
    {current && <section className="run-panel run-detail" aria-label="Run details">
      <div className="run-history-heading"><h2>{title(current)}</h2><span className={`run-state state-${current.state}`}>{statusLabel[current.state]}</span></div>
      <p>{current.job.message}</p>
      {current.stage && !activeStates.includes(current.state) && <p className="run-caption">Last stage: {statusLabel[current.stage]}</p>}
      {current.job.error && <p className="error-text">{current.job.error}</p>}
      {current.aiIssue && <p className="run-notice">{current.aiIssue}</p>}
      {current.state === 'waiting' && <p>Automatic recovery is queued{current.job.resumeAt ? ` for ${stamp(current.job.resumeAt)} or later` : ''}. Resume checks availability; source cooldowns and request limits still apply.</p>}
      <dl className="run-facts">
        <div><dt>Collected / target</dt><dd>{current.job.scanned} / {current.job.target}</dd></div>
        <div><dt>Specifications extracted</dt><dd>{current.job.assessed}</dd></div>
        <div><dt>Listings compared</dt><dd>{current.job.benchmarked}</dd></div>
        <div><dt>Configurations</dt><dd>{current.job.configurationsCompleted ?? 0} / {current.job.configurationsTotal ?? '—'}</dd></div>
        <div><dt>Requests, all attempts</dt><dd>{current.job.requestCount}</dd></div>
        <div><dt>AI accounted / allowance</dt><dd>{usd(current.job.aiCostUsd)} / {usd(current.parameters.aiBudgetUsd)}</dd></div>
      </dl>
      {actions(current)}
      <p className="run-caption">Retry and Resume retain completed work and the original AI allowance. Stale evidence is fetched again. Run again starts a separate manual run with a fresh allowance.</p>
      <details><summary>Parameters & attempt history</summary>
        <p>Up to {current.parameters.scanLimit} local listings and {current.parameters.benchmarkLimit} national offers per query. RAM ≥ {current.parameters.minRamGb} GB; VRAM ≥ {current.parameters.minVramGb} GB; unknown memory {current.parameters.includeUnknownMemory ? 'included' : 'excluded'}. AI {current.parameters.aiEnabled ? 'enabled when configured' : 'disabled'}.</p>
        <p>Workers for this attempt: {current.workers.marketplaceWorkers} marketplace, {current.workers.aiWorkers} AI.</p>
        <ol className="run-attempts">{detail.attempts.map(attempt => <li key={attempt.id}>
          <strong>{statusLabel[attempt.state]}</strong> · {stamp(attempt.job.startedAt)} → {stamp(attempt.job.completedAt)}
          <p>{attempt.job.error || attempt.job.message}</p><small>Accounted AI: {usd(attempt.job.aiCostUsd)} · {attempt.job.requestCount} cumulative requests</small>
        </li>)}</ol>
      </details>
    </section>}
  </section>;
}

function NumberField({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max?: number; step?: number; onChange: (value: number) => void;
}) {
  return <label>{label}<input type="number" required min={min} max={max} step={step} value={Number.isNaN(value) ? '' : value} onChange={e => onChange(e.target.valueAsNumber)} /></label>;
}
