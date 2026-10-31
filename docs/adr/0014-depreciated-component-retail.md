# Depreciated retail estimates for GPUs and desktop parts

Keep nationwide used asking-price references and their deal verdicts separate
from a new comparison based on current factory-new parts. A depreciated retail
estimate is the lowest verified, currently purchasable, VAT-inclusive Vietnamese
cash price multiplied by **75%**. The 25% reduction is an explicit used-condition
policy assumption, using the consumer/gaming newly-used retention anchor; it is
not fitted depreciation, physical wear, model age or completed-sale evidence.
Do not apply the laptop launch-price age curve to current component prices.

Search the existing reviewed HACOM, An Phát, Phong Vũ and TNC sources during
bounded refreshes, individual analysis and background price-cache maintenance.
One verified shop is enough. Show source offers, observation dates, original new
prices, the reduction and the resulting estimate. Failed or truncated lookups
never establish market-wide absence. Missing current stock stays unpriced;
there is no launch-price or performance-substitute fallback.

Standalone GPUs match the exact chip variant, VRAM and memory generation across
board manufacturers. Desktops sum supported CPU, GPU, RAM and SSD estimates only.
CPU models match exactly. RAM matches total capacity, generation and form factor
across brands; stated speed, ECC and stick layout must not disagree. Unknown
speed or layout yields an indicative range; unknown RAM generation is unpriced.
SSDs match interface and capacity class across brands: 120/128, 240/250/256,
480/500/512 and 960/1000/1024 GB, with other capacities matching exactly. Unknown
SSD interface yields an indicative range. Incomplete matching specifications
never create a firm verdict. An indicative included component makes its combined
desktop estimate indicative. Unavailable components are omitted explicitly.
Motherboard, PSU, case, cooling, peripherals and assembly remain unpriced;
desktop totals are always partial, not whole-system market values.

Add separate "Below depreciated retail estimate" (GPU) and "Below depreciated
component estimate" (desktop) labels, with a separate filter. Asking must be
strictly below the estimate before display rounding. Retain working-used,
configuration, single-item cash-price, seller identity, full-description,
availability, 24-hour listing freshness and suspicious-price checks. Indicative
ranges receive no badge. These estimates never change used-market references,
normalization part pools, below-market badges or resale values.

Reuse seven-day persistent price/discovery caches, fifteen-minute failure
backoff, bounded responses, host-checked redirects and three shared HTTP slots.
Part identities and parser kinds have separate cache keys. Ordinary public and
private reads remain offline. Cache maintenance shares deployment exclusion,
cancellation and shutdown draining, and fairly rotates its twelve-configuration
bound across laptops, desktops and GPUs. No database reset or schema migration is
needed; caches use the existing source-runtime table.
