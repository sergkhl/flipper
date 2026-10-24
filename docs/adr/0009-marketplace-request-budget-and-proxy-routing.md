# Bound marketplace traffic and resume through public HTTPS proxies

Accepted 24 October 2026 after the request-reduction interview. This extends
ADR 0007's durable recovery queue and narrows the collection bounds in ADR 0006.

One persisted rolling 24-hour allowance covers **500 actual Chợ Tốt HTTP
attempts**, including manual work, automatic scans, recoveries, redirects,
connection failures and HTTP retries across every proxy. Automatic work can use
at most 150 attempts per category and 450 total, leaving at least 50 for focused
manual work; manual work can use any remaining total allowance. Reserve an
attempt transactionally before dispatch. A failed or interrupted request stays
charged. Expiration follows individual request timestamps, not midnight or a
process restart. One request remains in flight through response-body completion,
with starts at least three seconds apart. Persist the next permitted start too.

The local scan defaults to 100 listings and ten initial detail reads, prioritized
by the existing memory policy. Additional descriptions remain necessary before
a candidate can support a price score. Each national query collects at most 60
offers, incrementally: stop pagination and details when enough independently
supported matching offers pass seller deduplication, configuration and outlier
checks. Keep the existing five-seller (or higher configured) scoring minimum and
24-hour observation requirement. Incremental caches retain the original source
timestamps; writing a checkpoint cannot make an observation fresh.

Automatic computer comparisons collect whole-PC evidence and at most two
adjustment-part queries per configuration, choosing the most reusable parts
first. Partial component baseline searches run on demand during manual analysis.
Deeper manual adjustments retain the same global allowance and per-query bound.

Request exhaustion or unavailable proxies produces a durable waiting record,
including local pagination, collected observations, assessed/compared listings,
partial national pools, original AI ceiling and cumulative spending. The server
resumes due work sequentially, independently of the daily enable switch. Expired
observations are fetched again rather than retimestamped. A pending automatic
category/query absorbs overlapping daily work using the latest settings and the
tighter original AI ceiling. A focused listing analysis has a separate queue
scope and can use the manual reserve. Waiting work survives restart; uncertain
in-flight crash claims remain terminal with their original allowance reserved,
as in ADR 0007. A retry never creates a fresh AI allowance.

Public proxy candidates come at runtime from
[monosans/proxy-list](https://github.com/monosans/proxy-list) and
[proxifly/free-proxy-list](https://github.com/proxifly/free-proxy-list).
Cache a bounded interleaved set for 30 minutes, retaining last-good candidates
through catalog outages and bounding catalog retries. Accept only credential-free
public IPv4 endpoints using HTTP, HTTPS or SOCKS5; unsupported entries are skipped.
Use Undici's explicit per-request proxy dispatcher, HTTPS tunnels and default
certificate verification. Keep one proxy per job. Only connection/proxy errors
can switch the route, with at most three attempts before a five-minute queue
pause; failed candidates cool down for fifteen minutes. Do not fall back to a
direct marketplace connection. Pool availability means an unexpired candidate,
not a guarantee that a public proxy is operational.

The source-wide persisted HTTP cooldown takes precedence over routing. A 429
does not trigger rotation or bypass the advertised pause. Proxy catalog
downloads use direct requests to the two fixed GitHub URLs. LiteLLM, admin
credentials and unrelated traffic retain their existing direct connections;
there is no global proxy dispatcher or shared credential header. Private status
shows allowance usage, provider links and candidate counts, never proxy endpoints
or raw queue checkpoints. Ordinary public reads perform no collection or proxy
catalog requests. Runtime lists and operational state are excluded from Git.

Additive SQLite request/runtime/progress tables and scoped retry records preserve
existing cooldowns and accounted costs. An older image cannot enforce these new
limits; rollbacks retain the database and require operator source-access review.
Automated acceptance uses mocked catalogs and marketplace responses. Live HTTPS
proxy checks are separate evidence and do not prove marketplace availability.
