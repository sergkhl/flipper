# Laptop retail references and VND prices

Laptop references use current new retail or original launch evidence. Desktop
and GPU references use nationwide used offers. Physical-condition exclusions
and the 24-hour freshness requirement for Chợ Tốt observations remain in force.
The laptop reference policy is version 2.

Compare a used laptop with the lowest verified, currently purchasable factory-new
cash price for its exact configuration. Current prices come from four reviewed
Vietnamese shops: HACOM, An Phát, Phong Vũ and TNC. Each shop's listed prices
include VAT according to its reviewed policy; a product page that explicitly
excludes VAT makes that price indicative. Delivery is not part of a domestic
comparison and is never added. Foreign prices still need known VAT and delivery
to Vietnam. Pre-orders and back-orders are not current stock; display, activated,
clearance and second-hand units are not factory-new; "contact us" placeholder
amounts below VND 1,000,000 are not prices. The structured price must appear in
the page's visible text. Shops publish template validity dates, so freshness
comes from Flipper's own observation date and the seven-day cache.
Do not deduct its age depreciation from a current new price again.
Match model/generation, CPU, GPU/bin, RAM and storage; a shared manufacturer model
code (such as ANV15-51 or 15ARP9) identifies a Windows model line across different
wording. MacBooks also need family, screen and explicit CPU/GPU core counts. Known disagreements never match;
incomplete identities can support an indicative range, without a deal badge.
One direct credible price source supports medium confidence; a used-peer quorum
is not required for laptop retail evidence.

Only after a successful bounded current-price lookup finds no suitable new price,
use original new retail evidence from the first 90 days after model release.
Prefer Vietnamese launch retail; exact-configuration launch MSRP is an explicitly
labeled fallback. Archived shop pages (Wayback Machine captures) within the 90-day
window count as Vietnamese launch retail after review; later captures are not launch
evidence, because their discounts would be depreciated a second time. Foreign prices lacking a known complete Vietnam purchase cost
are indicative and do not displace local history. Source URLs, native amounts,
currency, configuration, price date, release provenance and observation date stay
with the evidence. TechAPI MSRP and verification flags are never accepted on
their own. Reviewed coverage and source evidence are maintained in
[data sources](../data-sources.md) and the configuration price book;
unsupported configurations remain unpriced, rather than receiving invented prices.

The historical retained-value policy uses linear interpolation between these
anchors, measured from the model's first release/order date, not the owner's
purchase date. These are explicit product assumptions, not fitted resale data.

| Class | Newly used | 1 year | 3 years | 5 years |
| --- | ---: | ---: | ---: | ---: |
| Apple Silicon | 85% | 70% | 40% | 25% |
| Windows business/premium | 80% | 60% | 30% | 15% |
| Consumer/gaming/Intel Mac | 75% | 55% | 25% | 10% |

After five years, multiply remaining value by `0.8^(age−5)`. Beyond eight years,
or with an uncertain class, release timing, launch window, conflicting original
prices or incomplete configuration, show an indicative range only. Assume a
working used device, retain damage/repair exclusions, and display unknown battery
health/wear without invented monetary adjustments. Changes to assumptions require
a policy version change and source-backed additions to the reviewed price book.

All listing prices, monetary comparisons and price-budget inputs use VND in the
UI, storage and API. Saved budgets need no currency tag. AI usage costs retain
their native USD billing unit. Native VND prices and verdicts never depend on FX.
Only foreign retail and launch evidence is converted into VND, using current
exchange rates. Recalculate those references when rates change; do not freeze
conversion at import or reconstruct historical rates. Retain original amounts,
currencies, conversion dates and sources, without inventing import markups.

Cache current retail prices, catalog/search discovery and exchange-rate snapshots
for **seven days**, including across restarts. A cached product keeps its original
observation date: a later lookup does not extend its lifetime. Cache confirmed
absence for seven days; back off failures for 15 minutes. A failed, truncated or
unreadable lookup never establishes absence. A still-fresh verified new offer can
remain usable despite another source failing; otherwise historical evidence stays
indicative until a successful check. FX source dates must be recent when fetched;
the seven-day cache runs from fetch. When a rate expires and refresh fails, keep
foreign-price estimates using the last verified snapshot, visibly mark the rate
stale, and withhold deal badges. Without any usable rate, foreign evidence remains
unpriced. Native VND evidence remains usable independently of conversion failures.

For laptops, GPUs, desktops and partial component baselines, any asking price
**strictly below** the supported reference qualifies. Equality does not, and
rounding for display does not affect the comparison. The old `discountPercent`
setting remains a zero-valued compatibility field; it cannot restore the 10% gate.
Existing eligibility, freshness and suspicious-cash-price checks still apply.
Laptop labels distinguish “Good price vs new retail” from “Good price vs
depreciation estimate”. Partial component finds remain separate from whole PCs.

Free public sources are accessed directly with bounded response sizes, deadlines,
host-checked redirects and three shared HTTP slots. No paid API or marketplace
proxy is used for prices or FX. Collection/analysis warms the cache; ordinary
reads stay offline. Bounded background maintenance warms up to twelve retained
configurations and participates in deployment exclusion and shutdown draining.
Retail and exchange-rate caches persist in `source_runtime` across restarts.
