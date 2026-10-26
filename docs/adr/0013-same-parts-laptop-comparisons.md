# Same-parts laptop comparisons

Laptops other than MacBooks are compared with nationwide used Chợ Tốt laptops of
any brand that have the same parts. Most used laptops are models no shop sells new
any more, so retail and launch evidence (ADR 0012) priced few of them. Two laptops
with the same processor and graphics are worth about the same whatever their brand,
model line, year or screen, and RAM/SSD differences can be priced per GB. MacBooks
keep the retail and launch references of ADR 0012. The policy is version 1.

**Same parts** means one exact processor model and the same graphics: for a
discrete GPU, the same model and video memory; otherwise integrated graphics. A
family or generation ("Core i5", "i5 gen 11") is not a model. A low-power processor
(Intel U, G, P and Y parts, Core and Core Ultra U/V parts, Ryzen U parts) is assumed
to use integrated graphics when the ad names no discrete GPU anywhere; H, HS and HX
processors need stated graphics. HDD-only laptops compare only with HDD laptops of
the same capacity. The processor model, RAM capacity and storage capacity are
required. A missing model name, assumed integrated graphics, RAM generation or SSD
interface is shown as a missing detail and lowers confidence; it does not block a
verdict. Condition, price, classification and configuration conflicts still do.

Comparison offers follow the GPU/desktop evidence rules: used, eligible, fully
described, observed within 24 hours, priced per item, one offer per seller after
contact-based account linking, candidate and same-seller offers excluded, and the
same robust outlier filter. When at least five independent sellers (or the higher
configured minimum) offer the same RAM and storage, only they are used. Otherwise
other offers are adjusted to the candidate's RAM and storage with a reviewed per-GB
table, whether or not the parts are soldered:

| Part | Value per GB |
| --- | ---: |
| RAM, any generation | VND 100,000 |
| NVMe or unstated SSD | VND 2,500 |
| SATA SSD | VND 2,000 |

An offer whose total adjustment exceeds 25% of its asking price is rejected. The
table was reviewed on 26 October 2026 from stored used listings (evidence in
[data sources](../data-sources.md)); `npm run laptop:part-values` recalculates the
evidence offline, and the table is updated by hand. The data cannot separate RAM
generations. Three sellers give an indicative average; five (or the configured
minimum) are needed for a verdict. Confidence is high from ten sellers with no
missing details, and low with any missing detail.

The same-parts average decides the verdict, and a firm current new retail price
(ADR 0012 sources) caps it: when both are firm, the lower one governs. A launch-price
depreciation estimate is shown for context only and never decides or caps a
non-MacBook verdict. Its retention curve is an assumption, not fitted resale data:
on 26 October 2026 it put an Acer Nitro V 15 at VND 6.58 million while used ones
were advertised at VND 19.5–25.9 million. Without a firm reference, retail and launch
evidence remain indicative. Any asking price strictly below the governing reference
is a "Good price vs same-parts laptops" (or "vs new retail" when retail governs).

A laptop refresh groups its collection by processor. One nationwide search per
processor, querying the processor model, serves every listing with it and stops
once each has a verdict-sized sample, or at the national offer limit. Every
processor is searched, most-listed first, within the automatic per-category request
allowance; the owner raised that allowance to 1,000 requests a day so that each
processor can be searched daily. Laptop specifications are extracted only when the
rules cannot already state the processor, graphics, RAM and storage.

## Considered options

- **Processor twins.** Treating nine Intel-verified near-identical pairs (such as
  i5-8250U/8350U) as one processor brought five or six more of 118 candidates to a
  verdict-sized sample, beyond the 18–27 that exact models reached. Exact models
  were kept; the pairs are worth re-measuring once processor searches have built
  deeper pools.
- **Depreciation as a cap.** Rejected because the retention curve undervalued used
  gaming laptops by about two thirds, which would have suppressed every verdict.
- **Matching model lines.** Rejected: the owner wants laptops of different brands
  with the same parts to be comparable.
