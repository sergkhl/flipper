# Data-source boundaries

Chợ Tốt provides the public listing pages used by the collection adapter. Seller
descriptions and hardware claims are evidence supplied by sellers. Asking prices
are not completed-sale prices. An HTTP success does not establish availability:
deleted/sold/unavailable ads cannot supply current comparisons or opportunities.
Source access can change and a blocked refresh retains timestamped observations.

Manufacturer rules and source links in `server/memory-types.ts` support specific
hardware memory types. They never establish installed capacity. Exact model
suffixes, desktop/mobile variants, ambiguous type alternatives and contradictions
remain distinct.

Optional [TechAPI](https://github.com/GetTechAPI/TechAPI) public JSON supplies
CPU/GPU and laptop specification hints, cached separately from code. Its
[data license](https://github.com/GetTechAPI/TechAPI/blob/develop/data/LICENSE.md)
is CC BY-SA 4.0. Flipper retains attribution, links, license metadata and dates;
derived caches retain that boundary. Provider MSRP and verification flags are
not price evidence or manufacturer verification. Laptop catalog configurations
do not fill unstated installed capacities, screen sizes, core counts or bins.

Collection warms bounded batches; ordinary reads make no catalog/provider calls.
A 30-day lifetime and last-good fallback support offline use. External hints can
show possible types; only sufficiently reviewed unique manufacturer types may
refine matching. A changed interpretation invalidates affected price references.

No downloaded catalog, marketplace database or listing photograph is distributed
with this source repository. See `NOTICE.md` for third-party notices.

## Laptop prices and foreign currency conversion

The implemented free sources are:

| Source | Use | Evidence boundary |
| --- | --- | --- |
| [HACOM catalog](https://hacom.vn/sitemap.xml) and product pages | Discover matching laptops, then read JSON-LD Product/Offer data | Require a factory-new, in-stock cash offer, exact configuration, VAT and known Vietnam shipping cost. Sitemap coverage and a twelve-product bound limit the checked universe. |
| [An Phát](https://www.anphatpc.com.vn/) public search and product pages | A second retail lookup | Ignore script templates; reject expired prices and unknown stock/cost evidence. A failed or truncated search cannot establish absence. |
| [Frankfurter v2](https://frankfurter.dev/) | Current rates for converting foreign reference prices into VND | No API key. Preserve rate date and fetch date; reject unsupported or already-stale provider rows when fetching. Retain previously verified snapshots for stale indicative estimates if refresh fails. |
| [FPT M1 launch retail report](https://fptshop.com.vn/tin-tuc/tin-khuyen-mai/fpt-shop-ve-day-ke-macbook-m1-mua-ngay-khong-can-cho-doi-130379) | Reviewed original Vietnamese prices | Air/Pro 13-inch M1, 8 GB RAM, 256/512 GB storage. Prices offered on 8 January 2021, within 90 days of release. |
| [Apple release announcement](https://www.apple.com/newsroom/2020/11/introducing-the-next-generation-of-mac/) and [dated configuration list](https://www.apple.com/education/pricelists/pdfs/Apple_US_Education_Institution_Price_List-11-10-2020.pdf) | Release/order date and original base configurations | The education list supplies specifications only; its restricted education prices are not retail evidence. |
| [FPT M2 launch retail report](https://fptshop.com.vn/tin-tuc/tin-khuyen-mai/fpt-shop-lai-bat-ngo-mo-ban-macbook-air-m2-chinh-hang-som-nhat-viet-nam-148204) and [configuration description](https://fptshop.com.vn/tin-tuc/danh-gia/danh-gia-macbook-air-m2-2022-146863/) | Air 13 M2, 8/256 GB with 8 GPU cores and 8/512 GB with 10 GPU cores | Unconditional listed prices on 28 July 2022: VND 32,990,000 and 39,990,000. Do not deduct conditional payment/student promotions or use these amounts for 16 GB upgrades. |
| [Apple Vietnam Air M4 announcement](https://www.apple.com/vn/newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/) and [base specifications](https://support.apple.com/en-ie/122209) | Original local MSRP for the 13- and 15-inch 16/256 GB base configurations | 5 March 2025: VND 26,999,000 and 31,999,000, respectively. The specification's battery-test footnote identifies 10 CPU / 8 GPU and 10 CPU / 10 GPU base configurations. These starting prices cannot price a 512 GB upgrade. |
| [Apple Vietnam Pro M4 announcement](https://www.apple.com/vn/newsroom/2024/10/new-macbook-pro-features-m4-family-of-chips-and-apple-intelligence/) and [specifications](https://support.apple.com/vi-vn/121552) | Original local MSRP for Pro 14 M4, 10 CPU / 10 GPU, 16/512 GB, standard display | 30 October 2024: VND 39,999,000. Only the base configuration; exclude education pricing and upgrades. |
| [Microsoft Singapore Surface launch table](https://news.microsoft.com/source/asia/2019/11/13/new-surface-line-up-more-versatile-more-adaptable-more-personal/) and [Pro 7 specifications](https://support.microsoft.com/en-gb/surface/models/surface-pro-7-specs-and-features) | Five Surface Pro 7 launch MSRP observations in SGD | 13 November 2019: exact i5/i7, RAM and SSD rows, GST included. Type Cover is separate. Known LPDDR4 versus LPDDR4X conflicts must not match. |
| [Microsoft Hong Kong Surface Pro 7+ launch table and specifications](https://news.microsoft.com/en-hk/2021/01/12/introducing-surface-pro-7-for-business-and-surface-hub-2s-85-purpose-built-to-empower-people-teams-and-classrooms-in-the-new-digital-age/) | Eleven commercial launch MSRP observations in HKD | 12 January 2021: eight Wi-Fi and three LTE rows. Exclude the restricted EDU price. Connectivity is not extracted from listings, so retain both possible prices as a range. |

`server/laptop-launch-prices.ts` is the reviewed historical price book. It stores
facts and citations, not downloaded articles. Extend it only with explicit
configuration, date, currency, cash-price and release evidence. There is no
complete free historical laptop-price database integrated here. TechAPI remains
a specifications catalog; its MSRP must be independently corroborated before
entering the price book. Original prices do not expire like current offers.

The reviewed book now contains 25 observations: nine MacBook and sixteen Surface
rows, including connectivity variants. Global first-order dates come from Apple's
[M2 Air order announcement](https://www.apple.com/newsroom/2022/07/all-new-macbook-air-with-m2-available-to-order-starting-friday-july-8/)
(8 July 2022), [M4 Air announcement](https://www.apple.com/newsroom/2025/03/apple-introduces-the-new-macbook-air-with-the-m4-chip-and-a-sky-blue-color/)
(5 March 2025), [M4 Pro announcement](https://www.apple.com/newsroom/2024/10/new-macbook-pro-features-m4-family-of-chips-and-apple-intelligence/)
(30 October 2024), and Microsoft's [Pro 7 announcement](https://blogs.windows.com/devices/2019/10/02/surface-reveals-new-holiday-lineup-and-introduces-a-new-category-of-dual-screen-devices-built-for-mobile-productivity/)
(2 October 2019) and [Pro 7+ announcement](https://blogs.windows.com/devices/2021/01/11/introducing-surface-pro-7-for-business-purpose-built-to-empower-people-teams-and-classrooms-in-the-new-digital-age/)
(11 January 2021). Regional availability must not reset model age. Foreign Surface
MSRP uses current FX and remains indicative because Vietnam import costs are
unknown. Tablet prices exclude separately sold keyboards and pens.

The [20-configuration benchmark](laptop-price-benchmark.md) records the 25 October
coverage expansion and remaining gaps. SerpAPI was explicitly excluded; no new
discovery service was adopted. The two current adapters produced no usable exact
current prices in that sample. Historical coverage improved, but that does not
establish sufficient retail coverage or firm verdicts for those listings.

Live checks on 25 October 2026 confirmed a usable HACOM factory-new offer and a
successful no-current-offer lookup for an M1 configuration. An Phát also returned
expired structured prices, which were rejected. FPT current-page requests were
blocked, a Thế Giới Di Động probe timed out, CellphoneS search required client-side
data, and Phong Vũ's accessible M1 page explicitly reported out of stock. These
are access/coverage observations, not evidence that every retailer lacks stock.
Those sites are not silently counted as successful searches by the adapters.

Current prices, discovery indexes/searches and FX cache for seven days in SQLite
`source_runtime`; failures back off for fifteen minutes. Product observation
times survive lookup reuse. Requests stay on allowlisted HTTPS hosts, with a
12-second deadline, bounded bodies and three shared slots. Cache warming is
separate from Chợ Tốt request allowances. Reads never call external sources.
Only matching foreign evidence warms exchange rates; native VND prices have no
FX dependency. Foreign references are recalculated when rates refresh. Expired
snapshots remain available for explicitly stale estimates without deal badges.
The lowest **verified** price means the lowest eligible offer in checked sources,
not a claim to exhaustive market coverage. See ADR 0012 for fallback/FX policy.

Marketplace HTTPS routing loads bounded runtime plaintext proxy lists from
[monosans](https://github.com/monosans/proxy-list) and
[Proxifly](https://github.com/proxifly/free-proxy-list). Both can contribute
credential-free public HTTP, HTTPS and SOCKS5 candidates. Lists are untrusted
discovery inputs; a listed proxy is not proof of availability. HTTPS certificate
verification remains enabled, and only public marketplace requests use those
routes. Source cooldowns and the shared 700-attempt rolling allowance apply
across routes. Unavailable proxies queue work without a direct fallback.
Catalog downloads, LiteLLM and administrator traffic do not use these proxies.
Downloaded lists and cached endpoint/health state remain private runtime data.
Four workers by default retain distinct proxy IPs, each with at least three seconds
between request starts. Bounded HTTPS checks select routes; their success does
not establish marketplace access. Fewer working routes reduce concurrency rather
than stopping healthy workers. AI processing defaults to four separate direct
gateway slots and the original shared job budget. Both worker limits are
independently configurable from 1 to 20. A job checks at most twelve new proxy
candidates, so larger marketplace pools also depend on cached verified routes.
See ADRs 0010 and 0011.
