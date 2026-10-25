# Laptop retail references and USD prices

Accepted 25 October 2026 following the pricing interview. Supersedes the laptop
used-peer comparison and configurable discount gate in ADRs 0002 and 0003.
Desktop and GPU reference construction, physical-condition exclusions and the
24-hour freshness requirement for Chợ Tốt observations remain in force.

Compare a used laptop with the lowest verified, currently purchasable factory-new
cash price for its exact configuration. Include known VAT and mandatory delivery
to Vietnam. Do not deduct its age depreciation from a current new price again.
Match model/generation, CPU, GPU/bin, RAM and storage; MacBooks also need family,
screen and explicit CPU/GPU core counts. Known disagreements never match;
incomplete identities can support an indicative range, without a deal badge.
One direct credible price source supports medium confidence; a used-peer quorum
is not required for laptop retail evidence.

Only after a successful bounded current-price lookup finds no suitable new price,
use original new retail evidence from the first 90 days after model release.
Prefer Vietnamese launch retail; exact-configuration launch MSRP is an explicitly
labeled fallback. Foreign prices lacking a known complete Vietnam purchase cost
are indicative and do not displace local history. Source URLs, native amounts,
currency, configuration, price date, release provenance and observation date stay
with the evidence. TechAPI MSRP and verification flags are never accepted on
their own. Initial reviewed history covers four M1 MacBook base configurations;
unsupported configurations remain unpriced, rather than receiving invented prices.

Historical retained-value policy v1 uses linear interpolation between these
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

All displayed monetary comparisons and budget inputs use USD and one current FX
snapshot. Keep native marketplace amounts unchanged in storage and the API, with
explicit `priceCurrency=USD` for USD filters and currency-tagged saved searches.
Historical prices use current FX too; do not reconstruct historical exchange rates
or invent import markups. Label the rate date and retain original currency values.

Cache current retail prices, catalog/search discovery and exchange-rate snapshots
for **seven days**, including across restarts. A cached product keeps its original
observation date: a later lookup does not extend its lifetime. Cache confirmed
absence for seven days; back off failures for 15 minutes. A failed, truncated or
unreadable lookup never establishes absence. A still-fresh verified new offer can
remain usable despite another source failing; otherwise historical evidence stays
indicative until a successful check. Expired FX cannot support fresh USD verdicts.
FX source dates must be recent when fetched; the seven-day cache runs from fetch.

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
The release uses additive `source_runtime` entries, with no destructive data
migration. Earlier images do not implement this valuation policy.
