# Persist source cooldowns and retry within the original allowance

Chợ Tốt can return HTTP 429 with a `Retry-After` longer than a scan can wait
inline. Discarding that deadline allowed the next category or a restart to send
another request during the advertised pause. Persist one source cooldown in
SQLite. All Chợ Tốt requests, manual scan admission and automatic work defer
until it expires. Later shorter responses cannot shorten an existing deadline.
Accept delay seconds and HTTP dates; account for server clock skew when reading
dates. A 429 without usable timing receives a conservative one minute pause.
Short server waits retain the adapter's bounded inline retry behavior.

HTTP timing follows [RFC 9110 section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)
and [HTTP 429 semantics](https://www.rfc-editor.org/rfc/rfc6585.html#section-4).

A full refresh interrupted by a source cooldown creates a durable recovery
record with the original settings, target, query, allowance and accounted cost.
The server timer admits due recoveries sequentially after the same
job/probe/maintenance/shutdown gate. Repeated source cooldowns defer that same
record. Other failures and user cancellations are terminal. A restart preserves
waiting recoveries; a running claim becomes interrupted and reserves the full
remaining allowance because receipt absence cannot establish that a request was
free. It does not automatically repeat an interrupted claim.

Retries do not create fresh AI budgets. A retry's `RefreshBudget` and job cost
start with all prior accounted spending, including uncertain billing reservations.
Its remaining allowance is the original cap minus that cumulative cost, floored
at zero. Above-ceiling provider charges remain accounted. Each receipt and
terminal outcome updates the durable record before releasing the busy gate.

The daily eligibility boundary remains 12:00 PM noon Asia/Ho_Chi_Minh. Cooldown
deferral consumes no daily claim. Due recoveries take priority. When a recovery
has the same scope as an unstarted due daily category, both share one job and
the tighter allowance, at most USD 0.25. The daily journal conservatively includes
the recovery's earlier costs and keeps its USD 0.75 nominal-day admission limit.
This can run a recovery category before the usual laptop/desktop/GPU order.
Different scopes retain separate work. Ordinary downtime still catches up only
the current daily date; explicit source-cooldown recoveries can cross dates.

This is a targeted exception to ADR 0006's rule against automatic repetition of
failed categories. It does not enable retries for other failures or crashes.
The private schedule response/UI exposes source cooldowns, recovery status and
remaining allowances. Queued recoveries have explicit cancellation controls and
run independently of the daily enable switch. Private operator recovery can
import a finalized failed attempt made before this feature; imports cannot raise
the current manual allowance or rearm an existing completed/cancelled record.
Public reads never expose operational timing, retry history or spending.

The additive `source_cooldowns` and `scan_retries` tables survive process/image
restarts. An older image ignores them and cannot enforce the pause or execute
the recovery queue; rollback requires an operator decision about source access.
Never roll back the database journal to reset spending or retry eligibility.
