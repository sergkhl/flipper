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
