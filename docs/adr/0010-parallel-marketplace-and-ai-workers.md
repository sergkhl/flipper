# Parallelize proxy collection and AI work under shared allowances

Accepted 24 October 2026 after the parallel-processing interview. This replaces
ADR 0009's single-request transport, stable job proxy and 500-attempt total limit.
The operator selected four marketplace workers, three seconds between starts
per worker, and a **700-attempt rolling 24-hour allowance**. There is no additional
global start interval. Retain 150 automatic attempts per category and 450 total,
which now leaves at least 250 for manual work. Keep the existing evidence gates,
100/10/60 collection defaults, automatic two-part-query bound, original AI
ceilings and cumulative spending. Categories still run one job at a time.

Each marketplace worker retains a distinct proxy IP until a connection failure.
Hold its slot through the entire response body. Reserve every destination attempt
transactionally against the one SQLite ledger before dispatch, including failures,
redirects and HTTP retries. Persist both worker and proxy pacing so restarts,
route replacement or reassignment cannot bypass the three-second interval.
No direct fallback is permitted, and LiteLLM/admin traffic does not use proxies.

Validate candidate routes using certificate-verified HTTPS to `example.com`,
with at most twelve candidate checks per job and four checks in flight. These
checks do not call Chợ Tốt or consume its request allowance. Reuse recent health
observations; distinguish candidate counts from routes with successful checks.
Workers continue with fewer routes when necessary. A connection failure retires
that route, checks for a replacement and lets other workers continue. Queue the
job only when no usable worker remains; the existing five-minute retry and
fifteen-minute failed-route cooldown remain. A health check proves HTTPS routing,
not marketplace access.

An HTTP 429 pauses new marketplace dispatch globally, including other workers
and queued retries; it never triggers proxy rotation. Let requests already in
flight finish, retain their observations and settle recorded AI spending before
checkpointing the job. Even a zero-length `Retry-After` ends the current batch
rather than allowing other workers to race ahead. User cancellation aborts
outstanding requests and accounts for uncertain provider charges.

Use a separate four-slot pool for AI assessment workflows over the existing
direct gateway connections. Classification and extraction remain ordered within
each listing. One shared budget reserves spending before every provider call.
Unchanged content shares one pending assessment across simultaneous consumers,
including a conservative rule fallback after failure. Existing failure and
validation policies remain; already-started calls may settle after the third
failure stops new AI work. Parallelism does not relax incomplete-output checks.

Parallelize local enrichment, independent comparison configurations and part
queries. Serialize pagination and checkpoint writes for the same national query
so concurrent configurations reuse its pages rather than duplicating collection.
Assess national offers in small batches and stop once the configured independent
evidence minimum passes matching, seller deduplication and outlier checks.
Batch necessary detail reads according to the remaining evidence deficit.
Retain the results of already-started work; do not prefetch all national pages.

Drain every started task before reporting failure, releasing the busy gate or
ending its source context. Stop new work across the job on a source deferral.
Persist local assessment and completed-configuration progress as it changes,
and include that checkpoint in the terminal/recovery journal. Resumption keeps
fresh observations and original AI spending. Private status reports assigned and
active proxy workers, checked routes, active AI slots and completed configurations.
Public reads retain their existing offline and privacy boundaries.

Verification must prove four-way overlap, one response per proxy at a time,
persistent pacing, atomic last-slot quota admission, source-wide 429 deferral
with response draining, reduced-capacity operation, bounded proxy probing,
shared AI-budget reservations, duplicate-query suppression, early stopping and
checkpoint preservation. Synthetic overlap/latency results and actual production
progress remain separate evidence.
