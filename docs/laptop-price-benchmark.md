# Laptop price coverage benchmark

Measured on 25 October 2026. The reviewed launch book grew from four to 25 price
observations. On a fixed 20-configuration sample, historical estimate coverage
increased from **1/20 to 6/20**. All six estimates are indicative. There are
**zero usable current retail matches and zero firm references** in this sample.
This expands evidence coverage; it does not establish reliable deal coverage.

## Method

The cases were selected before measuring coverage from the retained 200-laptop
scan: all nine configurations with an eligible persisted assessment, six further
Windows configurations and five MacBooks with known CPU/RAM/storage. The sample
contains fifteen Windows laptops and five MacBooks. It deliberately includes
missing specifications and conflicts; it is a diagnostic sample, not a random
market-wide coverage estimate. Selection does not depend on a known launch price.

The [fixture](../scripts/fixtures/laptop-price-benchmark.json) contains only
configuration fields and assessment eligibility. It omits listing IDs, seller
information, descriptions, URLs and asking prices. Missing screen/core details,
the XPS's stated 500 GB capacity, and the Surface i7's stated LPDDR4 are preserved.
No catalog configuration is copied into a seller profile to improve a match.

The [runner](../scripts/benchmark-laptop-prices.ts) uses the production
`LaptopPriceBook`, HACOM/An Phát adapters, matching rules and FX cache. Baseline
code was `92c437c`, with four M1 launch rows. The live baseline reused the existing
seven-day public-price cache and made 18 additional retail HTTP requests. It made
no Chợ Tốt, AI, paid API or SerpAPI requests. FX was reused from the 25 October
snapshot fetched at 13:07:20.103Z (25,818 VND per USD).

All twenty cases had a completed lookup attempt: fifteen completed successfully
within the adapters' bounds, five reported failures. These are coverage checks
of the two configured sources, not proof of market-wide absence. Rejected
expired structured prices and timeouts remain failures, not empty results.

After the catalog and matcher changes, the benchmark replayed the same cache,
profiles, FX and evaluation date (`2026-10-25T14:01:45.703Z`) with zero requests.
Both reports have input digest
`0dacdb0c16e3c00f63cac99e50baa00c633367eb2baca9b332bcb6a63cc52db1`.
The raw public-price cache and operational reports remain private; the aggregate
results and configuration-only fixture are published here.

## Results

| Measure | Before | After |
| --- | ---: | ---: |
| Reviewed launch price observations | 4 | 25 |
| Complete current lookups | 15/20 | 15/20 |
| Failed current lookups | 5/20 | 5/20 |
| Verified current exact prices | 0/20 | 0/20 |
| Firm historical references | 0/20 | 0/20 |
| Indicative historical references | 1/20 | 6/20 |
| Unpriced configurations | 19/20 | 14/20 |
| Windows configurations with any reference | 0/15 | 2/15 |
| MacBook configurations with any reference | 1/5 | 4/5 |

RAM/storage below are in GB. Every row except Air M1 was unpriced before the
change. “Missing launch evidence” means no reviewed exact price was established
in this investigation, not that no such record exists anywhere.

| Configuration | Current lookup | Reference after change / remaining limitation |
| --- | --- | --- |
| ThinkPad T480, i5-8350U, UHD 620, 16/256 | Complete | Unpriced; missing launch evidence |
| Dell Inspiron 3593, i5-1035G1, MX230 2 GB, 8/256 | Complete | Unpriced; missing launch evidence |
| HP EliteBook 630 G9, i5-1235U, Iris Xe, 16/256 | Complete | Unpriced; missing launch evidence |
| Surface Pro 7+, i5-1135G7, Iris Xe, 8/256 | Complete | Indicative; HK MSRP, unknown Vietnam costs and Wi-Fi/LTE price range |
| Lenovo Xiaoxin Pro 16 IRH8, i5-13500H, Iris Xe, 16/1024 | Complete | Unpriced; missing launch evidence |
| Dell XPS 9315, i7-1250U, Iris Xe, 16/500 | Complete | Unpriced; missing launch evidence; 500 GB cannot match 512 GB |
| Legion Slim 7, i9-13900H, RTX4060 8 GB, 16/1024 | Failed | Unpriced; expired An Phát structured price, no launch evidence |
| Acer Nitro V 15 ANV15-51, i5-13420H, RTX4050 6 GB, 16/512 | Failed | Unpriced; expired An Phát price/HACOM timeout, no launch evidence |
| Lenovo LOQ 15ARP9, Ryzen 7 7435HS, RTX4060 8 GB, 16/512 | Failed | Unpriced; expired An Phát price/HACOM timeout, no launch evidence |
| Dell Latitude 5420, i5-1145G7, Iris Xe, 8/256 | Complete | Unpriced; missing launch evidence |
| HP EliteBook 630 G9, i5-1235U, unknown GPU, 8/256 | Complete | Unpriced; missing launch evidence and incomplete GPU |
| Surface Pro 7, i5-1035G4, unknown GPU, 8/256 | Complete | Indicative; Singapore MSRP, unknown Vietnam costs and incomplete GPU |
| Surface Pro 7, i7-1065G7, unknown GPU, 16/256 | Complete | Unpriced; stated LPDDR4 conflicts with manufacturer's LPDDR4X |
| Surface Pro 6, i5-8250U, UHD 620, 8/256 | Complete | Unpriced; no admitted first-90-day launch price |
| MSI GF63 Thin 11SC, i5-11400H, GTX1650 4 GB, 8/512 | Complete | Unpriced; missing launch evidence |
| MacBook Air M1, 8/256 | Complete | Indicative; missing screen/core counts (unchanged) |
| MacBook Air 13 M2, 8/256 | Complete | Indicative; missing CPU/GPU core counts |
| MacBook Air M4, 16/256 | Failed | Indicative; missing screen/core counts and HACOM timeout |
| MacBook Air 13 M4, 10 CPU/10 GPU, 16/512 | Failed | Unpriced; base 256 GB MSRP is not the 512 GB price; HACOM timeout |
| MacBook Pro 14 M4, 16/512 | Complete | Indicative; missing CPU/GPU core counts |

One added Surface reference matches the stated CPU/GPU/RAM/SSD fields, but its
foreign price and unresolved connectivity still prevent a firm verdict. Other
new estimates require missing configuration evidence. Listing condition,
assessment eligibility, asking-price freshness and the strict below-reference
comparison remain separate gates; this benchmark does not measure good deals.

## Source decision

Keep the existing free current adapters while preserving explicit failure and
coverage limits. The sample demonstrates poor current coverage; it does not
justify describing either adapter as a comprehensive pricing service. SerpAPI
discovery was explicitly skipped and no replacement service was adopted.
The verified historical additions and source/date boundaries are recorded in
[data sources](data-sources.md). Foreign MSRP is always indicative, current
verified retail still wins directly, and the seven-day price/FX caches remain.

A future proposed provider must be evaluated against these same twenty cases.
Count exact, purchasable, unconditional prices with known VAT and Vietnam
delivery separately from search hits, out-of-stock pages, partial configurations
and historical estimates. Adopt it based on demonstrated additional usable
matches, cost and request reliability. Improving source coverage and resolving
seller specifications are both needed before these examples can get firm badges.

## Reproduction

Requires Node 26 and installed project dependencies. The cache is an isolated JSON
object of public `prices:*` runtime entries, never the production SQLite file.
`--live` can start a new file or reuse an existing one; production cache lifetime,
failure backoff, response bounds and HTTP concurrency still apply. Each live run
has a five-minute deadline. Re-running live later can observe different stock.

```sh
npm run benchmark:laptop-prices -- --live \
  --cache /tmp/flipper-price-benchmark-cache.json \
  --output /tmp/flipper-price-benchmark-before.json

# Use evaluatedAt from that report for an offline before/after replay.
npm run benchmark:laptop-prices -- \
  --cache /tmp/flipper-price-benchmark-cache.json \
  --at 2026-10-25T14:01:45.703Z \
  --output /tmp/flipper-price-benchmark-after.json
```

Without `--live`, the runner never warms sources or modifies the cache. It rejects
a missing cache or stale FX instead of reporting misleading zero coverage.
Compare `caseDigest` and `inputDigest` before attributing changes to the price
book or matcher; `historyDigest` identifies the reviewed price data separately.
The checked-in fixture can be used against future services without exposing ads.
