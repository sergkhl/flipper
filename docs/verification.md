# Verification

Use Node.js 26 or newer with the locked dependencies:

```sh
npm ci
npm test
npm run build
```

The test suite uses fixtures and mocked adapters. It verifies marketplace parsing,
hardware ambiguity, supported price evidence, memory policies, persistence,
public/private API boundaries, maintenance exclusion and job lifecycle. Scheduler
tests cover strict next-noon activation in Vietnam time, sequential once-per-day
admission, competing ticks, busy/probe/maintenance deferral, pause, category
failure, durable crash reservations, current-day-only recovery, budget isolation,
overreported costs and private status/control.

Evidence recovery tests reproduce promotional gift-price conflicts, AI omissions
and unambiguous single-card quantities. They cover isolated versus repeated AI
failures within the existing allowance, strict below-reference scoring, separate partial
component and indicative views, successful/failed/empty collection publication,
dated history and private bookmark retention. Evidence labels distinguish stale
asking prices, stale comparisons, sparse offers and configuration review.
Unavailable ads are checked for retention without spending detail/AI/comparison
capacity. Browser checks use isolated synthetic listings for current, indicative,
historical and component-value views and their evidence drawers on desktop and
mobile. No live provider or marketplace calls are needed for those UI checks.

Retail tests cover current-new precedence over historical depreciation, exact
configuration/chip-bin matching, linear retention anchors and the post-five-year
tail, uncertain class/year/launch evidence, conflicting and foreign originals,
the 90-day original-price window, and indicative estimates beyond eight years.
One-dong-below and equality cases prove that display rounding cannot set badges.
Cache tests cover seven-day reuse and restart persistence, expiry, failure
backoff, provider-date validation, price observation dates, stock and VAT
evidence, redirect allowlists and bounded responses. Shop-reader tests skip
pre-orders, back-orders, display or used units and placeholder amounts without
failing a lookup, ignore template validity dates, require the structured price on
the page in dotted or comma grouping, honour explicit VAT exclusion, survive raw
control characters in generated JSON-LD, discover pages from all four shops and
never read pages that name another processor. Model-code tests match Windows
retail models across wording but never by processor or generation alone.
Service tests prove MacBook collection makes no nationwide used-peer queries,
other laptops' refreshes search each collected processor once nationwide and store
same-parts references, VND filtering preserves exact native amounts, offline reads issue no provider
requests, and price-cache maintenance drains during shutdown and excludes release.
Native VND retail, depreciation and GPU deals remain usable without FX. Foreign
references recalculate after successful rate refreshes; failed refreshes retain
stale estimates across restarts without deal badges. API tests exercise inclusive
VND budgets on both public and administrator routes, reject explicit non-VND
filters, and round-trip saved budgets without currency tags. Formatting tests
separate VND listing prices from native USD AI costs.
Same-parts tests cover exact processor models versus families and generations,
integrated graphics assumed only for low-power processors with no discrete GPU
named, discrete GPUs that need their video memory, and MacBook exclusion. Review
notes about the model name, graphics or SSD type become missing details, while
condition doubts still block a verdict. Five same-RAM/storage sellers decide alone;
otherwise RAM and SSD differences are priced per GB and offers beyond the 25% limit
are rejected. Other processors or graphics, duplicate sellers and stale offers never
count. Verdict tests prove same-parts sellers decide, a lower firm new retail price
caps them, depreciation estimates remain context, and three sellers stay indicative.
Indicative laptop estimates that require configuration review remain discoverable
in both the review and indicative views, without a deal badge or promotion into
working items. Memory filters and private dismissal still apply.

Same-parts validation on 26 October 2026: all 398 application tests and all 10
release-policy tests passed with Node 26.12.0, with TypeScript checking and the Vite
production build. Replaying a copy of the deployed database offline, with
observation ages ignored, 74 of the 118 non-excluded collection laptops other than
MacBooks had a parts key, across 45 processors; 43 received a same-parts reference,
38 of them from five or more sellers, and 35 of the 74 were eligible for a verdict. That pool came from model-name searches; processor searches add more
offers. Live verdicts additionally need observations within 24 hours. Synthetic browser checks at 1440×1000 and 390×844 showed the same-parts and
new-retail badges, the same-parts evidence with per-GB adjustments, and retail or
depreciation context beside the deciding reference, with no page errors or
horizontal overflow. They used an isolated database and made no external requests.

VND pricing validation on 26 October 2026: all 378 application tests, all 10
release-policy tests, TypeScript checking and the Vite production build passed
with Node 26.12.0. Synthetic browser checks at 1440×1080 and 390×844 verified
VND asking/reference prices, exact maximum-price filtering, saved-budget
round trips, retained native-price deal badges during an FX outage, and visibly
stale foreign estimates without deal badges. Both sizes had no page errors or
horizontal overflow, including the evidence drawer. These checks used an isolated
database and synthetic sources, with no external requests.

The twenty-case price benchmark also replayed entirely offline. The retained
snapshot produced six indicative references. Removing FX kept four native VND
references; expiring the verified snapshot kept all six, with exactly two marked
as stale foreign estimates. These replays made zero provider requests.

Separate live checks on 25 October 2026 verified USD/VND lookup, a purchasable
HACOM configuration, and historical fallback after a successful M1 absence check.
Expired An Phát offers and bounded/truncated lookups remained explicit failures.
This is evidence for the sampled providers/configurations, not full market or
historical-model coverage. See `docs/data-sources.md` for the source limitations.

Launch-price cases guard Surface
Pro 7 versus 7+, explicit Intel SKU aliases, contradictory CPU generations,
RAM/storage/GPU conflicts, reviewed launch dates and source links, exclusion of
restricted education prices, foreign Wi-Fi/LTE ranges without deal badges, and
rejection of unsupported upgraded MacBook configurations. Current-retail
precedence and seven-day cache tests are included in the application suite.

The separate [live coverage benchmark](laptop-price-benchmark.md) exercised twenty
configuration-only cases through the production retail adapters, reusing valid
cached observations and FX. Eighteen additional public retail requests yielded
fifteen complete lookups and five explicit failures. Replaying the same inputs
offline after the change increased indicative references from one to six, with
no firm reference or verified current exact price in either version. No new
marketplace scan, AI call or paid service was used. This is a bounded source
coverage measurement; it does not prove stock absence at other retailers.

Request-control tests cover the rolling 700-attempt ceiling, 150 automatic
attempts per category, manual reserve, exact expiration, persistent pacing and
shared SQLite reservations. Proxy tests mock both lists, unsafe endpoint input,
sticky routing, bounded network failover, empty pools, catalog outages, default
port normalization, redirects, complete response-body serialization and a 429
that blocks every route across restart. Queue tests cover partial local/national
resumption, duplicate-seller pagination, reuse/extension of shared pools, manual
analysis alongside queued category work, fresh timestamps, daily coalescing,
captured parameters despite changed defaults, and automatic versus on-demand component searches. Live public
proxy connectivity is checked separately without marketplace calls during an
active source cooldown.

Parallel acceptance covers four overlapping response bodies with one per route,
independent worker/proxy pacing, an atomic race for the last three request slots,
global 429 dispatch blocking while started responses drain, three failed workers
with one continuing route, a twelve-candidate HTTPS-probe ceiling, four shared
AI slots without overspending, concurrent configuration queries, shared-query
pagination without duplicate pages, and cancellation with a durable completed
configuration checkpoint. Source/provider failures stop new work while preserving
results from already-started calls. Tests use mocked routes and providers; real
performance and proxy health must be reported separately.

Run-control tests cover durable manual failures, cancellation and explicit resume,
restart interruption with uncertain AI accounting, immutable targets/filters and
AI budgets, attempt families, 90-day resolved-history retention, private API
redaction, stale-attempt rejection, maintenance cancellation, and request-limit
changes without ledger resets. Worker tests exercise 1, 2, 8 and 20 marketplace slots
and AI limits independently of marketplace concurrency. Browser checks exercise
launch, retry, cancellation, persisted limit edits and anonymous access at desktop
and mobile sizes against synthetic sources.

Runs validation on 24 October 2026: all 314 fixture tests passed in the Node 26
container, and the production TypeScript/Vite build passed. Synthetic browser
checks at 1440×1080 and 390×844 exercised retry, launch, cancellation, persisted
worker edits, reload and anonymous access. Both had no page errors or horizontal
overflow. No live marketplace or paid-provider requests were made.

AI recovery validation on 24 October 2026: all 329 fixture tests, TypeScript
checking and the production build passed in Node 26. The new cases cover the
validator-derived prompt contract, strict zero/range rejection, corrected output,
truncation headroom, one shared extra attempt per stage, transient HTTP failures,
long provider cooldowns, fatal rejections, uncertain charges, allowance exhaustion,
deadline/body cancellation, redacted diagnostics and cumulative probe costs.
A separate bounded live probe passed both fixed provider routes using synthetic
hardware text. That probe establishes the observed request contract, not
marketplace-wide semantic quality or a completed future scan. Billing receipts
remain in private operational records. Historical run warnings are preserved.

Market-opening checks cover read deadlines, stalled response bodies, caller
cancellation and catalog updates. In a browser, check a stalled bootstrap,
listings stalled after a slow bootstrap, a failed Retry and successful recovery.
Opening shares one ten-second deadline across settings and listings. Failed
background updates retain displayed cards; a loading error offers Retry without
claiming that the market is empty. Measure cold listing responses and first-card
rendering against the same retained dataset and server CPU allowance.

Live Runs validation on 24 October 2026: all 332 application tests passed in
Node 26, all 10 release-policy tests passed, and TypeScript/Vite production
building passed. New cases cover the exact native MiMo `parameter` trailer,
strict rejection of other suffixes/objects/invalid fields, private event access,
launch/cancel transitions, live limits and schedule changes, fresh reconnect
snapshots and subscription cleanup on disconnect/shutdown. Offline replay of all
24 privately captured trailer responses passed the original schema and
source-quote validation. Raw responses remain outside the published repository.

Synthetic browser checks at 1440×1000 and 390×844 passed for compact activity
rows, named status icons, processing spinners, details/attempt drawers, retry,
live changes initiated by another caller, offline indication with retained rows,
resynchronization after completion while offline, unsaved limit edits, saved
limits and the market progress banner. Runs, the banner and daily status share
one connection; each viewport opened exactly one replacement after the deliberate
disconnect. Idle checks observed no run/job/schedule polling, with no page errors
or horizontal overflow. These UI checks used no live marketplace/provider calls.

Run recovery validation on 25 October 2026: all 342 application tests passed in
Node 26, TypeScript/Vite building passed, and all 10 release-policy tests passed
on the host. New fixtures cover proxy deadlines during headers and body reads,
exhausted-route deferral, cancellation without route rotation, retained request
accounting, isolated RAM-speed range recovery, standalone RAM review, strict
rejection of other invalid fields, and rejection of guessed zero corrections
without source evidence. These fixtures use no live marketplace or provider
calls; production recovery is checked separately.

Run-default and price-basis validation on 25 October 2026: all 348 application
tests and the Node 26 TypeScript/Vite production build passed. New fixtures cover
the two observed multi-price aliases, retained hardware/source-quote validation,
price review after local reconciliation, combined RAM-speed recovery, and strict
rejection of other invalid values/fields. Persistence checks cover the one-time
100-to-200 upgrade, later explicit choices, all seven run defaults across restart,
future manual/daily admission, preserved prior parameters and worker counts,
lower daily AI allowances, and the 20-worker limit in the API and both pools.

AI-cost tests prove every ad is classified, extraction is skipped for MacBooks,
classifier rejections and fully stated laptops, cached model outputs rebuild
assessments without requests after a result-handling change or with AI off, and
nationwide offers naming another processor never reach AI. Daily-budget tests
cover the laptop, desktop and graphics-card ceilings within the daily total.

Offline replay of six privately retained MiMo responses through the decoder,
schema and source-quote validation recovered all six with an unknown price basis
and review status, without another extraction call. The Decider responses were
synthetic for this replay; no live provider requests were made.

Synthetic browser checks at 1440×1000 and 390×844 verified explicit saving without
launching, persistence across reloads and separate browser sessions, one-off run
overrides, saved worker values of 20, rejection of 21, and valid Settings controls
after saving non-round targets. Both sizes had no page errors or horizontal
overflow. The browser fixture used an isolated database and synthetic source;
these checks do not establish a production deployment or live source availability.

Automated checks establish source behavior. A browser check establishes the
rendered controls and interactions. A source/provider check establishes the
specific live request observed. A deployment check must identify the selected
revision, actual running image, health, persistent data, TLS and access boundary.
None of these alone proves that a future scheduled execution has happened.

Keep dated production receipts and environment-specific diagnostic records
privately. Do not publish credentials, personal state, raw provider responses or
seller datasets as test evidence. New tests must not call live providers or
marketplaces.
