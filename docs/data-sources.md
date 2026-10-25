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

## Laptop prices and currency conversion

The implemented free sources are:

| Source | Use | Evidence boundary |
| --- | --- | --- |
| [HACOM catalog](https://hacom.vn/sitemap.xml) and product pages | Discover matching laptops, then read JSON-LD Product/Offer data | Require a factory-new, in-stock cash offer, exact configuration, VAT and known Vietnam shipping cost. Sitemap coverage and a twelve-product bound limit the checked universe. |
| [An Phát](https://www.anphatpc.com.vn/) public search and product pages | A second retail lookup | Ignore script templates; reject expired prices and unknown stock/cost evidence. A failed or truncated search cannot establish absence. |
| [Frankfurter v2](https://frankfurter.dev/) | Current USD-base exchange rates, including VND | No API key. Preserve rate date and fetch date; unsupported/stale currency rows are rejected. |
| [FPT launch retail report](https://fptshop.com.vn/tin-tuc/tin-khuyen-mai/fpt-shop-ve-day-ke-macbook-m1-mua-ngay-khong-can-cho-doi-130379) | Reviewed original Vietnamese prices | Initial coverage is Air/Pro 13-inch M1, 8 GB RAM, 256/512 GB storage. The report describes prices offered on 8 January 2021, within 90 days of release. |
| [Apple release announcement](https://www.apple.com/newsroom/2020/11/introducing-the-next-generation-of-mac/) and [dated configuration list](https://www.apple.com/education/pricelists/pdfs/Apple_US_Education_Institution_Price_List-11-10-2020.pdf) | Release/order date and original base configurations | The education list supplies specifications only; its restricted education prices are not retail evidence. |

`server/laptop-launch-prices.ts` is the reviewed historical price book. It stores
facts and citations, not downloaded articles. Extend it only with explicit
configuration, date, currency, cash-price and release evidence. There is no
complete free historical laptop-price database integrated here. TechAPI remains
a specifications catalog; its MSRP must be independently corroborated before
entering the price book. Original prices do not expire like current offers.

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
