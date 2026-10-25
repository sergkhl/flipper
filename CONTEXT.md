# Used-item discovery

A personal web app for finding undervalued used computers and standalone GPUs
advertised on local marketplaces, focused on finding good deals against supported
asking-price references. Resale controls and assumptions are removed from the
interface as of 14 October 2026; legacy stored fields remain compatible. Phones
are excluded from the current version. Chợ Tốt is the initial
marketplace and Da Nang is the initial buying location. Reference comparisons
use new retail/original launch evidence for laptops and nationwide used offers
for GPUs and desktops. Display prices in USD using a current cached FX snapshot.
The app supports category browsing, model searches, saved searches, and manual
refresh, with LiteLLM-assisted classification and interpretation. Chat uses the
exact gateway route `xiaomi_mimo/mimo-v2.6-flash`; the dedicated OpenRouter
Decisions passthrough uses unprefixed `perplexity/pplx-decider-v1.2` (V1.1 until
2026-10-18, when OpenRouter had withdrawn its endpoint).
Both authenticate with the project's `LITELLM_API_KEY`. Current endpoints and
configuration are recorded in `docs/llm-settings.md` and ADR 0004.

The application is published under MIT. Runtime seller data, personal state,
credentials and operator-specific records remain outside the source repository.
Hosted operation permits anonymous read-only market evidence and private
administrator collection, settings and schedule control.

## Language

**Marketplace**:
An external service on which sellers advertise items. Chợ Tốt is the first
marketplace in scope.

**Listing**:
A seller's advertisement on a marketplace. Its attributes and description are
claims supplied by the seller.

**Asking price**:
The price advertised in a listing. It is distinct from the amount paid in a
completed sale.

**Personal buying**:
Finding a used item to acquire for the user's own use.

**Resale discovery**:
Legacy calculation retained for stored-data compatibility; its interface was
removed on 14 October. The initial estimate uses 90% of its chosen
reference price, subtracts the asking price and a cost reserve, and labels a
resale opportunity only when its discount, net-profit and return thresholds pass.

**Local listing**:
A listing advertised in Da Nang, the initial buying location. District filters
and pickup-first discovery are part of the accepted initial scope.

**Current collection**:
The membership of the latest successful full category refresh. Public searches
filter this collection offline. A failed or cancelled refresh does not replace
it. Private focused searches retain their own collection snapshots.

**Historical observation**:
A retained local listing outside the current collection, accessible separately
with its asking-price observation date. Retention does not establish present
availability. Saved items remain accessible independently of collection membership.

**Saved search**:
A search the user can return to and refresh manually. Saving a search does not
schedule collection or notifications.

**Daily market scan**:
The accepted 20 October 2026 design for a full market refresh of laptops,
desktops and standalone GPUs, starting at 12:00 Vietnam time each day. Categories
run sequentially with the current bounded collection, enrichment and nationwide
comparison work. This is separate from opening or saving a search. Each category receives at most one automatic attempt per Vietnam schedule day.
First enable waits for the next noon; interrupted attempts are not retried that
day. Schedule controls, execution history and budgets are private.

**Standalone GPU**:
A separately advertised graphics card, presented in its own search view.
The actual GPU model and memory configuration must be distinguished from
whole-system, accessory, wanted, or multi-model advertisements.

**Marketplace request allowance**:
At most 700 Chợ Tốt HTTP attempts in a rolling 24 hours, shared by all manual,
automatic, recovery and proxy routes, including retries and redirects. Automatic
work can consume at most 150 per category and 450 total. At least 250 are reserved
for manual work, which can also use the remaining total allowance. Four workers
run concurrently by default, configurable from 1 to 20, each with at least three seconds between starts.
The shared ledger and worker/proxy pacing survive restarts.

**Proxy worker**:
A marketplace request slot retaining one distinct proxy IP until a connection
failure. Its request includes the full response body. Workers share one allowance
and source-wide cooldown; fewer workers continue when fewer routes work.

**Queued marketplace work**:
A scan or focused analysis waiting for request allowance, a source cooldown or
a proxy. Its observations, pagination and original AI spending are retained for
automatic resumption. Overlapping automatic category work shares one queue entry
with its captured settings; focused manual listings retain separate scopes.

Collection defaults to 200 local listings, ten initial detail reads and at most
60 national offers per query, stopping once enough valid independent comparisons
exist. Automatic PC work uses at most two adjustment-part searches per
configuration; partial component baseline searches run on demand. Public HTTPS
marketplace traffic uses stable worker proxies from the two configured runtime
lists, switching only on connection/proxy errors. Unavailable proxies pause work
without direct fallback; HTTP 429 retains the global source cooldown. Four
AI assessment workflows run concurrently by default, independently configurable
from 1 to 20 over direct gateway connections with shared spending reservations.
The Runs form can explicitly save its seven parameter defaults on the server
for future manual and daily work. Category/search remain launch-specific;
existing runs and recoveries retain their captured parameters. Daily AI allowances
use the saved default subject to the USD 0.25 category ceiling. See ADRs 0009–0011.

**Reference price**:
A supported comparison value. Laptops use the lowest verified exact-configuration
new retail price including known Vietnam purchase costs, or original launch price
times historical retained value after a successful current-price absence check.
See ADR 0012 for the source hierarchy, seven-day caches and depreciation policy.
GPUs and desktops use a filtered arithmetic mean of matching nationwide used
Chợ Tốt asking-price offers from independent sellers. At least three offers provide an indicative
average and range; at least five (or a higher configured minimum) are required
for deal scoring. The candidate, its seller,
duplicates, incompatible configurations, ambiguous offers, and numeric outliers
are excluded. Explicit shared business contact evidence also links seller
accounts for deduplication; unrelated accounts are not proof of independent
businesses. Sufficient complete-configuration evidence is preferred; sparse
computer evidence can be supplemented by component-adjusted comparisons.

**Component-adjusted comparison**:
A comparable computer's asking price minus supported averages for removed parts
plus supported averages for added parts. Desktops retain CPU/platform and can
adjust GPU, RAM and SSD. Laptop used-peer adjustment was superseded by retail
pricing on 25 October 2026. Explicit GPU absence differs from unknown GPU
inclusion, and separately priced configurations retain their own included parts.
Each PC advertisement and seller contributes once. The weakest PC/part pool
sets the evidence count; combinations do not manufacture independent samples.
Missing base details are displayed and reduce confidence without blocking
deal scoring, as explicitly requested on 13 October. Required
part identities and prices still need evidence. This method is implemented;
the accepted decisions are recorded in `docs/design-interview.md`.

Computer browsing defaults to RAM ≥16 GB; standalone GPUs and included discrete
computer graphics default to VRAM ≥8 GB. Integrated-only and explicitly GPU-free
computers are exempt from the VRAM minimum. Unknown applicable capacities are
included by default, with one explicit filter controlling both. The defaults
persist in Settings & AI, toolbar controls affect the current search, and saved
searches retain their own choices. Manual refresh prioritizes known matches,
then possible unknown matches, then known failures, with price ordering within
each group. Directly stated memory types and uniquely manufacturer-supported
derived types are displayed separately from capacity, with provenance for the
latter. Ambiguous variants and contradictory evidence remain unresolved.

**Discount threshold**:
Any strictly positive reduction from the supported reference. For reference R
and asking price P, the discount is `(R − P) / R`; a good price requires `P < R`.
Equality does not qualify. The legacy setting is fixed at zero.

**Below-market find**:
A current, eligible listing whose asking price is strictly below its whole-item
reference. Laptop badges explicitly name new retail or depreciation estimates.
GPU/desktop complete or component-adjusted references require at least five
independent sellers (or the higher configured minimum) and observations within
24 hours. Three or four offers provide separately browsable
indicative comparisons without a scored discount or deal badge.

**Partial component baseline**:
A sum of independently supported prices for explicitly identified desktop
components. Only the displayed parts are included; omitted parts have no inferred
value. This is not a complete-system market price. Each included component needs
at least five independent matching nationwide offers.

**Below component value**:
An asking price meeting the discount threshold against a partial component
baseline. It has a separate label and filter and does not count as a
below-market find or a resale opportunity.

**Cost reserve**:
Legacy stored allowance for transport, preparation and other purchase/resale costs.
Defaults are VND 500,000 for laptops/desktops and VND 200,000 for standalone GPUs.

**Observed price**:
An asking price retrieved at a recorded time. It is historical evidence, not a
claim that the listing is still available or that a completed sale occurred.

**AI assessment**:
Decider classifies a listing's type, eligibility and ambiguity. MiMo extracts
stated hardware specifications and supporting seller-text quotes. Numeric price
references and opportunity calculations use retrieved offers and deterministic
arithmetic. A manual refresh has a configurable USD 0.25 initial AI budget.
Quoted deterministic facts can fill AI omissions; conflicting claims remain
in review. An unambiguous single-model GPU offer at a whole-item price may be
interpreted as one card without an explicit quantity word. Bundle or multi-card
language prevents this interpretation.
