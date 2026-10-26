import * as sqlite from 'node:sqlite';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { enrichComputerAssessment } from '../server/computer.ts';
import { normalize } from '../server/hardware.ts';
import { PART_VALUES, laptopPartsKey } from '../server/laptop-parts.ts';
import { offerFrom, removeOutliers, sellerIdentities } from '../server/pricing.ts';
import type { Assessment, RawListing } from '../shared/types.ts';

// Recomputes the evidence behind the reviewed RAM/SSD per-GB values in server/laptop-parts.ts.
// Offline and read-only: it opens a stored database without writing to it and contacts no service.
// Review the output, then update PART_VALUES and docs/data-sources.md by hand.
const { values } = parseArgs({ options: { data: { type: 'string', default: '.data' } } });
const db = new sqlite.DatabaseSync(join(values.data!, 'flipper.sqlite'), { readOnly: true });
type Stored = { raw: RawListing; assessment: Assessment };
const listings = (category: string): Stored[] => (db.prepare('SELECT raw, assessment FROM listings WHERE category = ?')
  .all(category) as Array<{ raw: string; assessment: string }>).map((row) => ({ raw: JSON.parse(row.raw), assessment: JSON.parse(row.assessment) }));
const laptops = listings('laptop'), ssds = listings('ssd');
db.close();

const now = Date.now(), at = new Date(now).toISOString();
// Link accounts by shared contacts regardless of observation age; the app applies its 24-hour rule only to live comparisons.
const identities = sellerIdentities([...laptops, ...ssds].map(({ raw }) => ({ ...raw, observedAt: at })), now);
const quantile = (sorted: number[], q: number) => {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};
const vnd = (value: number) => `${Math.round(value).toLocaleString('en-US')} ₫`;
function describe(label: string, slopes: number[], detail: string) {
  if (!slopes.length) return console.log(`${label}: no evidence`);
  const sorted = [...slopes].sort((a, b) => a - b);
  console.log(`${label}: ${vnd(quantile(sorted, .5))}/GB (IQR ${vnd(quantile(sorted, .25))} to ${vnd(quantile(sorted, .75))}; ${detail})`);
}
const days = (observedAt: string) => (now - Date.parse(observedAt)) / 86_400_000;

// Laptop pairs: same processor and graphics, different independent sellers, differing only in RAM (or only in SSD).
interface Point { seller: string; cpu: string; gpu: string; ram: number; ssd: number; price: number; observedAt: string }
const latest = new Map<string, Point>();
for (const { raw, assessment: stored } of laptops) {
  if (raw.condition !== 'used' || !raw.sellerId || !(raw.price > 0)) continue;
  const assessment = enrichComputerAssessment(raw, stored);
  if (assessment.eligibility !== 'eligible' || assessment.conflicts.length || assessment.profile.priceBasis !== 'item') continue;
  const key = laptopPartsKey(raw, assessment).key;
  if (!key || key.hdd) continue;
  const point = { seller: identities.key(raw), cpu: key.cpu, gpu: key.gpu, ram: key.ramGb, ssd: key.storageGb, price: raw.price, observedAt: raw.observedAt };
  const id = [point.seller, point.cpu, point.gpu, point.ram, point.ssd].join('|'), previous = latest.get(id);
  if (!previous || previous.observedAt < point.observedAt) latest.set(id, point);
}
function laptopSlopes(vary: 'ram' | 'ssd') {
  const groups = new Map<string, Point[]>();
  for (const point of latest.values()) {
    const id = [point.cpu, point.gpu, vary === 'ram' ? point.ssd : point.ram].join('|');
    groups.set(id, [...(groups.get(id) ?? []), point]);
  }
  const slopes: number[] = [];
  let used = 0;
  for (const items of groups.values()) {
    const before = slopes.length;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      if (a[vary] === b[vary] || a.seller === b.seller) continue;
      const [low, high] = a[vary] < b[vary] ? [a, b] : [b, a];
      slopes.push((high.price - low.price) / (high[vary] - low[vary]));
    }
    if (slopes.length > before) used++;
  }
  return { slopes, detail: `${slopes.length} pairs in ${used} processor and graphics groups` };
}

// Used SSD listings: one median per seller and capacity tier, then the Theil–Sen slope of price against capacity.
const tiers: Array<[number, number]> = [[128, 110], [256, 240], [512, 480], [1024, 960], [2048, 1900], [4096, 3800]];
const placeholder = (price: number) => {
  const digits = String(Math.trunc(price));
  return ['123456', '1234567', '12345678', '123456789', '12356789'].includes(digits)
    || digits.length >= 6 && new Set(digits).size <= 2 && !digits.endsWith('00000');
};
function ssdSlopes(interfaceType: 'NVME SSD' | 'SATA SSD') {
  const cells = new Map<number, Stored[]>();
  for (const item of ssds) {
    const { raw, assessment: a } = item, p = a.profile;
    if (a.kind !== 'ssd' || raw.condition !== 'used' || !raw.sellerId || a.eligibility !== 'eligible' || a.conflicts.length) continue;
    if (p.storageType !== interfaceType || (p.quantity ?? 1) !== 1 || (p.priceBasis ?? 'item') !== 'item') continue;
    if (/^(?:can tim|can mua|tim mua|thu mua)/.test(normalize(raw.title)) || raw.price < 50_000 || placeholder(raw.price)) continue;
    const tier = tiers.find(([size, min]) => p.storageGb !== null && p.storageGb >= min && p.storageGb <= size)?.[0];
    if (tier && tier <= 1024) cells.set(tier, [...(cells.get(tier) ?? []), item]);
  }
  const points: Array<{ tier: number; price: number }> = [], sellers = new Set<string>(), ages: number[] = [];
  for (const [tier, items] of cells) {
    const kept = new Set(removeOutliers(items.map(({ raw }) => offerFrom(raw)), []).map((offer) => offer.id));
    const bySeller = new Map<string, number[]>();
    for (const { raw } of items) if (kept.has(raw.id)) {
      const seller = identities.key(raw);
      bySeller.set(seller, [...(bySeller.get(seller) ?? []), raw.price]); ages.push(days(raw.observedAt));
    }
    for (const [seller, prices] of bySeller) {
      const sorted = prices.sort((a, b) => a - b);
      points.push({ tier, price: quantile(sorted, .5) }); sellers.add(seller);
    }
  }
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i]!, b = points[j]!;
    if (a.tier !== b.tier) slopes.push((b.price - a.price) / (b.tier - a.tier));
  }
  const age = ages.sort((a, b) => a - b);
  return { slopes, detail: `${sellers.size} sellers, ${points.length} seller and capacity points, 128 GB to 1 TB; median age ${age.length ? quantile(age, .5).toFixed(1) : '-'} days` };
}

console.log(`Reviewed values (${PART_VALUES.reviewedAt}): RAM ${vnd(PART_VALUES.ramPerGb)}/GB; NVMe or unstated SSD ${vnd(PART_VALUES.nvmePerGb)}/GB; SATA SSD ${vnd(PART_VALUES.sataPerGb)}/GB`);
const pointAges = [...latest.values()].map((point) => days(point.observedAt)).sort((a, b) => a - b);
console.log(`Laptop evidence: ${latest.size} eligible used non-MacBook laptop configurations with known parts; median age ${pointAges.length ? quantile(pointAges, .5).toFixed(1) : '-'} days`);
const ram = laptopSlopes('ram');
describe('RAM, from laptop pairs', ram.slopes, ram.detail);
const nvme = ssdSlopes('NVME SSD'), sata = ssdSlopes('SATA SSD'), laptopSsd = laptopSlopes('ssd');
describe('NVMe SSD, from used SSD listings', nvme.slopes, nvme.detail);
describe('SATA SSD, from used SSD listings', sata.slopes, sata.detail);
describe('SSD cross-check, from laptop pairs', laptopSsd.slopes, laptopSsd.detail);
console.log('Asking prices, not completed sales. Round to reviewed values, then update PART_VALUES and docs/data-sources.md by hand.');
