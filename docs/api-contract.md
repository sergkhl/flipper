# Application contract

The shared TypeScript types in `shared/types.ts` are authoritative. All JSON
routes are under `/api` in local loopback mode; Vite proxies there. Hosted mode
has anonymous read-only `/api` routes and private `/admin/api` routes. Errors
return `{error: string}` with an appropriate HTTP status. The same backend serves
the production UI.

## Hosted access

`FLIPPER_PUBLIC_ORIGIN` and `FLIPPER_ADMIN_TOKEN` enable hosted mode together;
incomplete configuration fails startup. Caddy authenticates `/admin` and
`/admin/*`, preserves the prefix, removes the browser's Authorization header,
and supplies a private `X-Flipper-Admin-Token`. The backend requires that token
independently for every administrator route and strips the prefix internally.
Public routes cannot gain write access by supplying the same header. Hosted
writes reject foreign origins and cross-site browser metadata.

Anonymous GET/HEAD access is limited to `/api/bootstrap`, `/api/listings`,
`/api/listings/:id`, static UI assets, and `/healthz`. Every public write is
rejected before parsing its body. Public bootstrap has `access: read-only`,
only the five browsing/scoring settings, empty searches and null AI status.
Public listing/detail responses neutralize personal state before valuation
and filtering, redact private resale values and operational diagnostics, and
return no job or AI information. Public searches filter the latest successful
full category collection without source/provider requests. `view=history`
searches retained local observations outside that collection; the saved-listings
view is private. Bootstrap counts describe the current full collections.
Coverage exposes no stored error details. The administrator and local bootstrap
has `access: admin` and retains the full contract below. `/healthz` exposes only
status and the running Git revision.

## Personal workspace routes

Use the following paths locally; prepend `/admin` on the hosted app.

### Runs

- `GET /api/runs?offset=0` → `RunsResponse`: 50 latest logical runs, `hasMore`,
  busy/active status, saved operational limits and marketplace usage. Each entry
  is the latest attempt; active and waiting entries appear first.
- `GET /api/runs/:id` → `{run, attempts}`: current summary and known attempt
  history for the selected run family. Summaries include captured parameters,
  worker counts, last stage, errors and cumulative accounting. They omit raw
  checkpoints and internal settings snapshots.
- `POST /api/runs` with `{category, query?, parameters?}` starts a manual refresh.
  Parameters may include `scanLimit` (1–1000), `benchmarkLimit` (20–60),
  `aiBudgetUsd` (0–10), `aiEnabled`, and the existing memory filters. Omitted
  parameters use saved defaults. An empty query refreshes the full category.
- `POST /api/runs/:id/retry` or `/resume` with `{}` continues failed, cancelled,
  interrupted or waiting work under its original scope, AI allowance and spending.
  Source cooldowns remain enforced; quota/proxy availability is rechecked.
- `POST /api/runs/:id/cancel` with `{}` stops active work or cancels automatic
  recovery, preserving its checkpoint. `POST /api/runs/:id/again` with `{}` starts
  a separate manual run with the same parameters and a fresh allowance.
- `POST /api/runs/limits` with all five `RunLimits` fields updates
  `marketplaceWorkers`, `aiWorkers` (each 1–8), `requestLimit`,
  `automaticRequestLimit`, and `automaticCategoryRequestLimit` (positive safe
  integers; category ≤ automatic ≤ total). Worker counts apply at the next start
  or resume. Request limits apply to subsequent admissions, including during an
  active run, without resetting usage. These fields are managed separately from
  `/api/settings`.

Run starts/actions return `{job: RefreshJob}` with HTTP 202. Busy admission and
actions on superseded attempts return 409. Missing runs return 404, malformed
parameters return 400, and persisted source cooldowns return 429. All routes are
private; public reads cannot retrieve history, settings, costs or errors. The
maintenance gate allows active cancellation while freezing other mutations.

Every new attempt is durable. Unfinished attempts after restart become
`interrupted` in run history, retain their original allowance for uncertain AI
charges, and require explicit resumption. Resolved run families expire after 90
days; unresolved families remain. Legacy scheduled/recovery snapshots are
imported when present; legacy in-memory manual history is unavailable.

### Existing workspace actions

- `GET /api/bootstrap` → BootstrapResponse.
- `GET /api/listings?category=laptop|desktop|gpu&q=...&district=...&view=all|saved|review|history|indicative|components&opportunities=true|false&maxPrice=...&minRamGb=...&minVramGb=...&includeUnknownMemory=true|false&sort=value|newest|price` → ListingsResponse. Missing memory parameters use persistent settings defaults (initially RAM 16 GB, VRAM 8 GB, include unknown true). RAM applies only to computers. VRAM applies to standalone GPUs and included discrete graphics; integrated-only and explicitly GPU-free computers are exempt. Minimums are inclusive; zero disables a capacity threshold. The unknown-memory flag independently includes/excludes unknown applicable capacities, including with a zero threshold. Known below-minimum capacity always fails. The policy applies before view selection and statistics. Missing memory capacity alone may stay in the main feed when included, but other review reasons and price-evidence gates remain effective. Collection coverage and scanned count describe the unfiltered pool. Legacy `mode` does not change deal filtering, counts or ranking.
- `POST /api/refresh` with `{category, query?, limit?, minRamGb?, minVramGb?, includeUnknownMemory?}` → `{job: RefreshJob}`. Omitted memory parameters use settings defaults. Bounded detail/AI and comparison work prioritizes known matches, possible unknown matches, then known failures, with price ordering within groups. Source collection and nationwide reference pools retain their existing bounds and matching rules.
- `GET /api/jobs/active` → `{job: RefreshJob|null}`.
- `GET /api/deployment` → `{busy: boolean}`. Private activation readiness; active
  jobs and provider probes are busy. A deployment maintenance marker freezes
  mutations with HTTP 503 except explicit job cancellation.
- `GET /api/jobs/:id` → `{job: RefreshJob}`.
- `POST /api/jobs/:id/cancel` → `{job: RefreshJob}`.
- `GET /api/listings/:id` → ListingDetail.
- `POST /api/listings/:id/state` with partial ListingState → ListingView.
- `POST /api/listings/:id/analyze` → `{job: RefreshJob}`. This refreshes the detail and focused nationwide comparisons; poll the job, then reload the listing.
- `POST /api/searches` with `{name, category, query, district?, mode?, maxPrice?, minRamGb?, minVramGb?, includeUnknownMemory?, opportunities?}` → `{search: SavedSearch}`. Memory defaults come from settings when omitted. Saved values, including Any (zero) and false for unknown memory, are restored alongside model/district, asking-price cap and deals-only choice. The client saves legacy `mode: buy`; resale mode is absent from the interface.
- `DELETE /api/searches/:id` → `{ok: true}`.
- `POST /api/settings` with partial AppSettings, including persistent `minRamGb`, `minVramGb` and `includeUnknownMemory`, optional `liteLlmKey` string (empty removes the locally saved LiteLLM key) → BootstrapResponse. The client immediately applies saved memory defaults to its toolbar. Legacy resale settings remain compatible but have no interface controls. Keys are never returned. `ai.keySource` is `environment`, `local`, or `null`; `LITELLM_API_KEY` takes precedence over a saved key.
- `POST /api/ai/test` → `{results: Array<{model, ok, error?, costUsd?}>}`. User-triggered bounded probes of both actual model routes, subject to the configured budget.

- `GET /api/schedule` → DailyScanStatus. Private control, next start, latest
  scheduled day and per-category outcomes, budgets and AI degradation.
- `POST /api/schedule` with `{enabled: boolean}` → DailyScanStatus. Enable or
  pause independently of the ordinary settings form, including during a job.
  First enable or resume waits for the strictly next Vietnam noon. Repeated
  enable requests preserve the existing first-due timestamp. Maintenance
  rejects the mutation with HTTP 503.

Only one collection job runs at a time. Administrator actions can start manual
refreshes; the enabled daily scanner uses the same pipeline. Public bootstrap
and listing responses never include schedule controls, schedule history or budgets.

Request/proxy pauses return a `waiting` job with `resumeAt`. Repeating the same
pending refresh or focused analysis returns that queued job. `GET /api/jobs/:id`
resolves its durable recovery record across restarts. The private bootstrap and
schedule include `marketplace` request usage (700 total, 150 per automatic
category, 250 manual reserve) and proxy provider/candidate status. Retry status
includes a `cooldown`, `request_budget` or `proxy` reason and optional focused
`listingId`; raw progress checkpoints are excluded from HTTP responses. Waiting
work resumes on the server using its recorded AI spending and can be cancelled
through `POST /api/scan-retries/:id/cancel`. This queue runs independently of the
daily enable switch. New default bounds are 100 local listings, ten initial
detail reads and at most 60 national offers per query. Settings reject a national
limit above 60. The private schedule displays quota/proxy waiting states.
Proxy status also reports `workerLimit`, assigned `workers`, `activeWorkers`,
`verified` HTTPS routes and the per-worker `intervalMs`. `marketplace.ai` reports
the separate AI pool's limit and active slots. Jobs report optional
`configurationsCompleted` and `configurationsTotal`. Both pools default to four slots and support 1–8 through Runs;
marketplace starts are spaced by three seconds per worker and proxy. A shared
national query serializes pagination, and completed observations/AI spending
survive partial failures after all started work drains. These fields remain private.

The default discount threshold is 10%. `Valuation.opportunity` counts only
complete or component-adjusted whole-item references. `componentOpportunity`
applies the same threshold to a partial component baseline and is excluded from
market and resale opportunities. `view=components` selects these separate finds;
`view=indicative` selects fresh references below the configured evidence minimum,
with no discount score or badge. Statistics expose `componentOpportunities` and
`indicative` separately. `evidenceIssue` identifies a missing, sparse, outdated,
unavailable or ambiguous input for a specific UI explanation.

Current membership is published after a refresh succeeds. A failed or cancelled
refresh retains the previous collection. History includes retained local rows
outside the current full category collection, including review/excluded rows;
it preserves observation dates and the same public/private state boundary.
Private saved items span current and historical rows, and focused private search
collections remain separate from the public full-category membership.

`Assessment.memoryTypeSources` records manufacturer-derived types separately
from seller-text `evidence`, with `field`, `value`, `part`, `url` and
`catalogVersion`. These records establish types only, not installed capacities.
Ambiguous variants remain unknown; contradictions retain review status. A
memory-matching policy/provenance change invalidates affected references instead
of reusing older scores. Catalog coverage and primary sources are recorded in
`docs/data-sources.md`.
`Assessment.memoryTypeInferences` and each quoted configuration's optional
`memoryTypeInferences` contain `field`, `types`, `basis`,
`manufacturerVerified`, source `{label,url}` links and `catalogVersion`.
Multiple alternatives and TechAPI-only hints leave the corresponding profile
type null. The provider's verification flag is not copied or treated as
manufacturer verification. This metadata never supplies RAM/VRAM capacity.
Feed/detail reads use only the local cache. Manual collection phases warm
distinct CPU/GPU identities in bounded batches; optional provider failure retains
the reviewed catalog and last-good cache. Changed scoring interpretations require
fresh nationwide evidence before a deal score is reused.
The app does not invent listings, comparables, or provider success. Empty,
insufficient-evidence, failed-refresh, and unavailable-AI states remain visible.
