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
failures within the existing allowance, inclusive 10% scoring, separate partial
component and indicative views, successful/failed/empty collection publication,
dated history and private bookmark retention. Evidence labels distinguish stale
asking prices, stale comparisons, sparse offers and configuration review.
Unavailable ads are checked for retention without spending detail/AI/comparison
capacity. Browser checks use isolated synthetic listings for current, indicative,
historical and component-value views and their evidence drawers on desktop and
mobile. No live provider or marketplace calls are needed for those UI checks.

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
changes without ledger resets. Worker tests exercise 1, 2 and 8 marketplace slots
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

Automated checks establish source behavior. A browser check establishes the
rendered controls and interactions. A source/provider check establishes the
specific live request observed. A deployment check must identify the selected
revision, actual running image, health, persistent data, TLS and access boundary.
None of these alone proves that a future scheduled execution has happened.

Keep dated production receipts and environment-specific diagnostic records
privately. Do not publish credentials, personal state, raw provider responses or
seller datasets as test evidence. New tests must not call live providers or
marketplaces.
