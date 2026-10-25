# Private run controls and durable history

Accepted 24 October 2026 after the Runs UI interview. This extends ADRs 0006–0010.
The private administrator workspace remains shared; this change introduces no
accounts, roles, or public write access.

Provide a Runs page for launching and observing the existing combined collection,
specification extraction and nationwide comparison pipeline. Category refreshes,
focused searches, listing analyses, scheduled scans and their recoveries share
one activity list. Keep contextual refresh actions and daily schedule controls.
Provider probes and specification-cache maintenance are outside this surface.

Persist each attempt with its parameters, last stage, progress checkpoint,
accounted AI spending, source-request count, errors and relationship to the
original run. Return summaries and attempt history over private APIs; never
return raw checkpoints, credentials, proxy endpoints or provider payloads.
Keep completed/cancelled run families for 90 days and unresolved families until
resolution. Import existing scheduled/recovery snapshots when available; old
in-memory manual history cannot be reconstructed. Result links open retained
listings, not historical snapshots of the feed.

Retry and Resume continue a saved checkpoint, retaining the original AI allowance
and cumulative spending. Completed fresh work is reused; expired observations
are fetched again. Cancel stops execution or automatic recovery while preserving
the checkpoint for explicit resumption. Run again creates a separate manual run
with the same scope and a fresh allowance. After an unclean restart, unfinished
runs become interrupted, reserve the original AI allowance for uncertain charges,
and require explicit resumption. Resumption never bypasses source cooldown,
request accounting, provider budget or the shared admission gate.

Only one collection/analysis run is active at a time. Other launches and resumes
are rejected while a job, AI probe or deployment is active. Keep the existing
automatic recovery queue; do not introduce a general manual queue. Old attempt
actions are rejected after a newer attempt exists. Active cancellation remains
available during deployment maintenance.

Marketplace and AI worker counts are independent editable integers from 1 to 8,
defaulting to 4. Apply them at each start/resume, not by resizing active pools.
Keep three seconds between marketplace starts per worker and the existing proxy
health-check bounds. The total rolling 24-hour request allowance, automatic total
and automatic per-category allowance become editable positive integers. Defaults
remain 700/450/150. Require category ≤ automatic ≤ total and show the manual
reserve as total minus automatic. Each request admission reads current limits;
edits never clear usage. Lowering a limit below usage pauses further dispatch;
raising it allows waiting work to recheck admission through Resume or its next
automatic attempt.

Run scope, listing targets, memory filters, comparison bounds and AI settings
remain captured for both manual and automatic resumptions. This supersedes ADR
0009's policy of adopting the latest automatic scan parameters. Matching daily
work can still share a recovery and tighten its AI ceiling, but changed scope
must use a new run. Ordinary application settings cannot overwrite the separate
operational limits from a stale settings form.

Validation uses synthetic sources for durable restart/retry/cancel behavior,
parameter and spending preservation, admission and privacy boundaries, retention,
live quota edits, and independent marketplace/AI concurrency. Browser checks use
synthetic activity at desktop/mobile sizes. These checks do not establish live
marketplace or model-provider availability.

Follow-up accepted 24 October 2026: use a compact activity table and a details
drawer, a single metrics strip and collapsed launch/limit forms. Status icons
replace status labels; collecting, assessing and comparing use an animated
spinner. Each icon keeps an accessible name and tooltip, and reduced-motion
preferences disable its animation. Keep AI warnings visible beside the run.

Share one private server-sent event connection across Runs, the market progress
banner and daily-scan status. Push replaceable snapshots of current status,
counters, spending, workers, limits and schedule outcomes after state changes.
Keep the existing durable attempt history. Automatic reconnect preserves the
last displayed state, shows a reconnecting indicator and receives a fresh
snapshot; it does not rely on a durable event log or polling fallback. Keep
checkpoints, seller text, credentials and proxy endpoints outside the stream.
After a provider fix, bounded focused reassessment can repair affected retained
listings while preserving the original attempt and its warning.

Follow-up accepted 25 October 2026: marketplace request deadlines, including
stalled response bodies, retire the affected proxy route and try an available
replacement. Exhausted routes use the existing durable waiting queue; cancellation
and source-wide HTTP cooldowns retain precedence. A timeout does not reset request
accounting, saved progress or AI spending.

An isolated out-of-range RAM speed in otherwise valid MiMo output becomes unknown
with an assessment explanation. Preserve other schema- and quote-validated fields
and discard the rejected speed evidence. Do not widen limits or infer a different
installed speed by adding/removing zeros. Standalone RAM remains in review without
its required speed; other schema failures keep the existing retry/fallback policy.
Repair affected retained evidence and explicitly resume failed work while keeping
the original attempts and their warnings.

Follow-up accepted 25 October 2026: recover the observed MiMo `priceBasis`
values `multi` and `multiPrice` as `unknown`, retaining independently validated
hardware facts and requiring price review. Discard evidence for the rejected
price basis; retain source-validated multi-price evidence, flags and conflicts.
Clarify the prompt's supported values and boolean multi-price flag. Other
schema failures keep their existing bounded retry/fallback policy; an isolated
RAM-speed range failure can be recovered in the same response. Preserve
historical run warnings and advance the assessment cache contract.

Add an explicit Save defaults action to the Runs launch form. Persist all seven
run parameters in the existing server settings; keep category and search text
specific to the launch. Starting a run alone does not change defaults. New
manual and daily runs use saved defaults across browser visits and restarts;
daily AI admission takes the lower of the saved allowance and existing
category/day ceilings. Existing runs, retries and Run again retain captured
parameters. Saving defaults uses the ordinary settings admission/maintenance
rules and preserves operational limits and unrelated settings.

The initial local-listing target becomes 200. Upgrade an existing saved value
of 100 once; preserve other existing targets and every later explicit choice,
including 100. Do not rewrite captured runs or recovery records. Raise both
worker caps to 20 while retaining factory defaults of four and previously saved
counts. Worker counts still apply at start/resume. Proxy pacing, distinct-route
requirements and the twelve-candidate check budget remain in force; obtaining
twenty marketplace routes can depend on previously verified routes.
