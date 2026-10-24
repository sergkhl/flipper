import { useState, type FormEvent } from "react";
import {
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { AdminBootstrapResponse, AppSettings } from "../shared/types";
import Drawer from "./Drawer";
import { message, post, request } from "./api";
import { usd } from "./format";
import { ramMinimums, vramMinimums } from "./memory";
import DailyScans from "./DailyScans";

type Probe = { model: string; ok: boolean; error?: string; costUsd?: number };
export default function SettingsDrawer({
  bootstrap,
  onClose,
  onSaved,
}: {
  bootstrap: AdminBootstrapResponse;
  onClose: () => void;
  onSaved: (bootstrap: AdminBootstrapResponse, quiet?: boolean) => void;
}) {
  const [draft, setDraft] = useState<AppSettings>({
    ...bootstrap.settings,
    costReserves: { ...bootstrap.settings.costReserves },
  });
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [probes, setProbes] = useState<Probe[] | null>(null);
  const ai = bootstrap.ai;
  const update = <K extends keyof AppSettings>(
    field: K,
    value: AppSettings[K],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...draft,
        ...(removeKey
          ? { liteLlmKey: "" }
          : key.trim()
            ? { liteLlmKey: key.trim() }
            : {}),
      };
      const result = await post<AdminBootstrapResponse>("/settings", payload);
      onSaved(result);
      setDraft(result.settings);
      setKey("");
      setRemoveKey(false);
      setSaved(true);
    } catch (error) {
      setError(message(error));
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    setError(null);
    setProbes(null);
    try {
      const result = await post<{ results: Probe[] }>("/ai/test");
      setProbes(result.results);
      const fresh = await request<AdminBootstrapResponse>("/bootstrap");
      onSaved(fresh, true);
    } catch (error) {
      setError(message(error));
    } finally {
      setTesting(false);
    }
  };
  return (
    <Drawer
      title="Settings & AI"
      subtitle="Your deal rules, daily scans, and provider connection"
      onClose={onClose}
    >
      <form onSubmit={save} className="settings-form">
        <DailyScans initial={bootstrap.schedule} />
        <section className="settings-section">
          <div className="section-heading">
            <h3>Your price rules</h3>
            <span className="badge">Recalculates saved data</span>
          </div>
          <p className="section-caption">
            Deal badges use fetched nationwide prices. These settings change the
            gates, not the source evidence.
          </p>
          <div className="settings-grid">
            <NumberField
              label="Minimum discount"
              unit="% below average"
              value={draft.discountPercent}
              min={1}
              max={90}
              step={1}
              onChange={(value) => update("discountPercent", value)}
            />
            <NumberField
              label="Minimum comparables"
              unit="Independent sellers · at least 5"
              value={draft.minComparables}
              min={5}
              max={50}
              step={1}
              onChange={(value) => update("minComparables", value)}
            />
          </div>
        </section>
        <section className="settings-section">
          <div className="section-heading">
            <h3>Memory filter defaults</h3>
            <span className="badge">Applied when saved</span>
          </div>
          <p className="section-caption">
            Saving applies these defaults to the current filters and future visits.
            Opening a saved search restores its own memory settings.
          </p>
          <div className="settings-grid">
            <MemoryMinimumField
              label="Default minimum RAM"
              kind="RAM"
              value={draft.minRamGb}
              options={ramMinimums}
              onChange={(value) => update("minRamGb", value)}
              help="System RAM in laptops and desktops"
            />
            <MemoryMinimumField
              label="Default minimum GPU VRAM"
              kind="VRAM"
              value={draft.minVramGb}
              options={vramMinimums}
              onChange={(value) => update("minVramGb", value)}
              help="Dedicated GPU memory in all categories"
            />
          </div>
          <label className="switch-setting">
            <div>
              <strong>Include unknown RAM / VRAM</strong>
              <span>Include unknown capacities. Known capacities must meet the minimums.</span>
            </div>
            <input
              type="checkbox"
              checked={draft.includeUnknownMemory}
              onChange={(event) => update("includeUnknownMemory", event.target.checked)}
            />
            <span className={`toggle-track ${draft.includeUnknownMemory ? "on" : ""}`}><span /></span>
          </label>
          <p className="footnote">Integrated-only computers and computers explicitly sold without a discrete GPU are exempt from the VRAM minimum. Unknown-memory inclusion is independent of the minimums.</p>
        </section>
        <section className="settings-section">
          <div className="section-heading">
            <h3>LiteLLM integration</h3>
            <Sparkles size={19} className="positive-text" />
          </div>
          <div
            className={`provider-status ${ai.status === "ready" ? "provider-ready" : ""}`}
          >
            <span className="ai-dot" />
            <div>
              <strong>
                {ai.status === "ready"
                  ? "Key configured · ready to test"
                  : ai.status === "not_configured"
                    ? "No API key configured"
                    : ai.status === "disabled"
                      ? "AI is disabled"
                      : ai.status === "budget_limited"
                        ? "Refresh budget reached"
                        : "Provider needs attention"}
              </strong>
              <span>
                {ai.lastError ||
                  (ai.configured
                    ? ai.keySource === "environment"
                      ? "The gateway key is loaded from this project's .env. Test model access below."
                      : "A gateway key is saved locally. Test model access below."
                    : "Connect a key to enable model-assisted assessment.")}
              </span>
            </div>
          </div>
          <label className="switch-setting">
            <div>
              <strong>Enable AI assessment</strong>
              <span>
                Classify listings and extract source-supported specifications
              </span>
            </div>
            <input
              type="checkbox"
              checked={draft.aiEnabled}
              onChange={(event) => update("aiEnabled", event.target.checked)}
            />
            <span className={`toggle-track ${draft.aiEnabled ? "on" : ""}`}>
              <span />
            </span>
          </label>
          <label className="settings-key">
            <span>
              <KeyRound size={15} />
              LiteLLM API key
            </span>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setRemoveKey(false);
                setSaved(false);
              }}
              placeholder={
                ai.configured
                  ? "Configured · enter a replacement key"
                  : "sk-…"
              }
              disabled={removeKey || ai.keySource === "environment"}
            />
            <small>
              {ai.keySource === "environment"
                ? "Update LITELLM_API_KEY in .env and restart the app to change this key."
                : "The key is saved on this computer and never returned to the browser."}
            </small>
          </label>
          {ai.keySource === "local" && (
            <button
              type="button"
              className="remove-key"
              onClick={() => {
                setRemoveKey(!removeKey);
                setKey("");
                setSaved(false);
              }}
            >
              <Trash2 size={13} />
              {removeKey ? "Undo key removal" : "Remove locally saved key"}
              {removeKey && <span>Will remove on save</span>}
            </button>
          )}
          <div className="model-list">
            <div>
              <span className="model-icon">
                <Sparkles size={16} />
              </span>
              <div>
                <strong>Specification extraction</strong>
                <code>{ai.mimoModel}</code>
              </div>
              <span className="model-route">Chat</span>
            </div>
            <div>
              <span className="model-icon">
                <ShieldCheck size={16} />
              </span>
              <div>
                <strong>Fast classification & decisions</strong>
                <code>{ai.deciderModel}</code>
              </div>
              <span className="model-route">Decisions</span>
            </div>
          </div>
          <NumberField
            label="AI budget per manual refresh"
            unit="USD · cached assessments avoid repeat charges"
            value={draft.aiBudgetUsd}
            min={0}
            max={10}
            step={0.01}
            onChange={(value) => update("aiBudgetUsd", value)}
          />
          <div className="provider-test-row">
            <button
              type="button"
              className="button"
              onClick={() => void test()}
              disabled={
                testing ||
                saving ||
                !ai.configured ||
                !draft.aiEnabled ||
                !!key ||
                removeKey
              }
            >
              {testing ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Check size={15} />
              )}
              Test both models
            </button>
            <span>Recorded provider cost: {usd(ai.totalCostUsd)}</span>
          </div>
          <p className="footnote">
            The test sends small requests to the two configured model routes and
            can incur provider charges through LiteLLM. Save a new key or budget before testing.
          </p>
          {probes && (
            <div className="probe-results" role="status">
              {probes.map((result) => (
                <div
                  key={result.model}
                  className={result.ok ? "probe-success" : "probe-failure"}
                >
                  {result.ok ? (
                    <Check size={15} />
                  ) : (
                    <TriangleAlert size={15} />
                  )}
                  <span>
                    <code>{result.model}</code>
                    <span>
                      {result.ok
                        ? `Provider responded${result.costUsd !== undefined ? ` · ${usd(result.costUsd)}` : ""}`
                        : result.error || "Provider request failed"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <a
            className="provider-link"
            href="http://localhost:4000/ui"
            target="_blank"
            rel="noreferrer"
          >
            Open LiteLLM dashboard
            <ExternalLink size={12} />
          </a>
        </section>
        <section className="settings-section">
          <div className="section-heading">
            <h3>Market collection</h3>
            <span className="badge">Chợ Tốt</span>
          </div>
          <p className="section-caption">
            Each refresh scans recent Da Nang listings in the selected category
            or query. It enriches 10 initial local ads, verifies descriptions for priced candidates, and compares
            up to 12 distinct configurations, using up to {draft.benchmarkLimit}{" "}
            nationwide offers per query, stopping once enough independent matching offers support the comparison. Open any listing and choose “Refresh
            this evidence” for a focused comparison. You can expand the local
            scan from the feed.
          </p>
          <div className="settings-grid">
            <NumberField
              label="Local listings per scan"
              unit="20–1,000 recent results"
              value={draft.scanLimit}
              min={20}
              max={1000}
              step={20}
              onChange={(value) => update("scanLimit", value)}
            />
            <NumberField
              label="National offers per query"
              unit="Focused comparable collection"
              value={draft.benchmarkLimit}
              min={20}
              max={60}
              step={20}
              onChange={(value) => update("benchmarkLimit", value)}
            />
          </div>
          <div className="settings-method-note">
            <ShieldCheck size={17} />
            <p>
              Collection shares a limit of 700 marketplace requests per rolling
              24 hours, with 150 per automatic category. Up to four proxy workers
              run concurrently, each starting requests at least 3 seconds apart.
              AI assessments use up to four concurrent calls within the same budget.
              Automatic comparisons use at most two adjustment-part searches per
              configuration; partial component baselines are retrieved on demand.
            </p>
          </div>
        </section>
        {error && (
          <div className="notice error-notice" role="alert">
            <TriangleAlert size={17} />
            <p>{error}</p>
          </div>
        )}
        <div className="settings-save">
          <p>Changes and searches are stored locally.</p>
          <button className="button primary" disabled={saving || testing}>
            {saving ? (
              <LoaderCircle size={16} className="spin" />
            ) : saved ? (
              <Check size={16} />
            ) : (
              <Save size={16} />
            )}
            {saving ? "Saving…" : saved ? "Saved" : "Save settings"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

function MemoryMinimumField({ label, kind, value, options, onChange, help }: {
  label: string;
  kind: "RAM" | "VRAM";
  value: number;
  options: number[];
  onChange: (value: number) => void;
  help: string;
}) {
  return (
    <label className="number-field memory-default-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={0}>Any {kind}</option>
        {options.map((minimum) => <option key={minimum} value={minimum}>{kind} ≥ {minimum} GB</option>)}
        {value > 0 && !options.includes(value) && <option value={value}>{kind} ≥ {value} GB</option>}
      </select>
      <small>{help}</small>
    </label>
  );
}

function NumberField({
  label,
  unit,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        required
        onChange={(event) => {
          if (event.target.value !== "") onChange(Number(event.target.value));
        }}
      />
      <small>{unit}</small>
    </label>
  );
}
