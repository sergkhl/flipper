import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_ASSESSMENT_VERSION, DECIDER_MODEL, EMPTY_PROFILE, MIMO_MODEL } from '../server/config.ts';
import { cachedAIAssessment, LiteLLMClient, RefreshBudget, type AIOutputCache, type CachedExtraction, type Decisions } from '../server/litellm.ts';
import { Store } from '../server/store.ts';
import { FlipperService } from '../server/service.ts';
import { assessWithRules } from '../server/hardware.ts';
import type { HardwareKind, RawListing } from '../shared/types.ts';
import type { ChototClient } from '../server/chotot.ts';
import { raw } from './helpers.ts';

type SearchInput = Parameters<ChototClient['search']>[0];
const kinds: HardwareKind[] = ['laptop', 'desktop', 'gpu', 'ram', 'cpu', 'ssd', 'other', 'wanted'];
function decided(kind: HardwareKind, workingUsed = .96) {
  return { answers: {
    listing_type: { type: 'choice', choice: kind, confidence: .96,
      probabilities: Object.fromEntries(kinds.map(label => [label, label === kind ? .986 : .002])) },
    working_used: { type: 'noul', noul: workingUsed }, damaged_or_repaired: { type: 'noul', noul: .01 },
    locked_or_parts: { type: 'noul', noul: .01 }, ambiguous_price: { type: 'noul', noul: .01 },
    deposit_only: { type: 'noul', noul: .01 }, conflicting_specs: { type: 'noul', noul: .01 },
  }, id: 'decision', model: DECIDER_MODEL, provider: 'Fixture', usage: { input_tokens: 900, output_tokens: 7, cost: .00002 } };
}
const emptyExtraction = { kind: 'laptop', profile: { ...EMPTY_PROFILE },
  flags: { damaged: false, repaired: false, locked: false, partsOnly: false, depositOnly: false, multiPrice: false },
  unknowns: [], conflicts: [], evidence: [], confidence: .9 };
const completion = { id: 'extraction', model: `${MIMO_MODEL}-fixture`, provider: 'Fixture',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(emptyExtraction) } }],
  usage: { prompt_tokens: 2_300, completion_tokens: 400, cost: .00018 } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function gateway(classify: (title: string) => unknown = () => decided('laptop')) {
  const calls = { decider: [] as string[], extraction: [] as string[] };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith('/alpha/decisions')) { calls.decider.push(body.state.title); return json(classify(body.state.title)); }
    calls.extraction.push(JSON.parse(body.messages[1].content).title); return json(completion);
  }) as typeof fetch;
  return { calls, fetcher };
}
function memoryCache(): AIOutputCache & { size(): number } {
  const decisions = new Map<string, Decisions>(), extractions = new Map<string, CachedExtraction>();
  return { decisions: item => decisions.get(item.id) ?? null, saveDecisions: (item, value) => { decisions.set(item.id, value); },
    extraction: item => extractions.get(item.id) ?? null, saveExtraction: (item, value) => { extractions.set(item.id, value); },
    size: () => decisions.size + extractions.size };
}

test('classification always runs, extraction is skipped by policy, and cached outputs repeat no request', async () => {
  const { calls, fetcher } = gateway(), cache = memoryCache();
  const client = new LiteLLMClient({ key: 'fixture-key', fetch: fetcher });
  const item = raw('policy', 9_000_000, { category: 'laptop', title: 'Dell Latitude 5420 i5-1145G7 16GB 256GB SSD',
    description: 'Máy hoạt động tốt. RAM 16GB, SSD 256GB, Intel Iris Xe Graphics.' });
  const rules = assessWithRules(item);
  const skipped = await client.assess(item, new RefreshBudget(1), undefined, { cache, rules, skipExtraction: () => 'rules hold the key' });
  assert.deepEqual([calls.decider.length, calls.extraction.length], [1, 0]);
  assert.equal(skipped.method, 'ai'); assert.deepEqual(skipped.profile, rules.profile);
  assert.match(skipped.status, /extraction skipped because rules hold the key/);
  await client.assess(item, new RefreshBudget(1), undefined, { cache, rules });
  assert.deepEqual([calls.decider.length, calls.extraction.length], [1, 1], 'cached classification is reused; extraction runs once');
  await client.assess(item, new RefreshBudget(1), undefined, { cache, rules });
  assert.deepEqual([calls.decider.length, calls.extraction.length], [1, 1]);
  assert.equal(cachedAIAssessment(item, { cache, rules })?.method, 'ai');
  assert.equal(cachedAIAssessment({ ...item, id: 'never-classified' }, { cache, rules }), null);
});

async function settled(service: FlipperService) {
  for (let i = 0; i < 400 && service.activeJob(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.activeJob(), null);
}

test('MacBooks, classifier rejections and fully stated laptops need no extraction; result changes reuse paid outputs', async t => {
  const store = new Store('', true);
  store.saveSettings({ ...store.getSettings(), aiEnabled: true, minRamGb: 0, minVramGb: 0 });
  t.mock.method(store, 'getKey', () => 'fixture-key');
  const { calls, fetcher } = gateway(title => decided('laptop', title.includes('Thinkpad') ? .3 : .96));
  t.mock.method(globalThis, 'fetch', fetcher);
  const working = 'Máy hoạt động tốt, chưa sửa chữa.';
  const items = [
    raw('macbook', 15_000_000, { category: 'laptop', title: 'MacBook Air M1 2020 8GB 256GB', description: `${working} MacBook Air M1 8CPU 7GPU, RAM 8GB, SSD 256GB.` }),
    raw('stated', 9_000_000, { category: 'laptop', title: 'Dell Latitude 5420 i5-1145G7 16GB 256GB SSD',
      description: `${working} Dell Latitude 5420, CPU i5-1145G7, RAM 16GB, SSD 256GB NVMe, Intel Iris Xe Graphics.` }),
    raw('uncertain', 6_000_000, { category: 'laptop', title: 'Thinkpad T480 i5-8350U 8GB',
      description: 'Laptop Thinkpad T480 i5-8350U RAM 8GB SSD 256GB.' }),
    raw('vague', 12_000_000, { category: 'laptop', title: 'Laptop gaming i7 RTX 3060', description: `${working} RAM 16GB, SSD 512GB.` }),
  ];
  const service = new FlipperService(store, { search: async (_input: SearchInput) => ({ items, total: items.length }),
    detail: async (item: RawListing) => item });
  try {
    service.refresh('laptop', '', items.length); await settled(service);
    assert.equal(calls.decider.length, 4, 'every ad is classified');
    assert.deepEqual(calls.extraction, ['Laptop gaming i7 RTX 3060'], 'only the vague ad needs extraction');
    assert.equal(service.detail('stated')?.assessment.method, 'ai');
    assert.equal(service.detail('uncertain')?.assessment.eligibility, 'review');
    // A result-handling version change discards final assessments, never the paid model outputs.
    (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare('DELETE FROM assessments WHERE hash LIKE ?').run(`${AI_ASSESSMENT_VERSION}:%`);
    store.saveSettings({ ...store.getSettings(), aiEnabled: false });
    service.refresh('laptop', '', items.length); await settled(service);
    assert.equal(calls.decider.length + calls.extraction.length, 5, 'no further paid request');
    assert.equal(service.detail('vague')?.assessment.method, 'ai', 'AI-off runs still rebuild from cached outputs');
  } finally { await service.shutdown(); store.close(); }
});

test('nationwide offers whose own text names another processor are compared without AI', async t => {
  const store = new Store('', true), assessed: string[] = [];
  store.saveSettings({ ...store.getSettings(), aiEnabled: true, minRamGb: 0, minVramGb: 0 });
  t.mock.method(store, 'getKey', () => 'fixture-key');
  t.mock.method(LiteLLMClient.prototype, 'assess', async (item: RawListing) => { assessed.push(item.id); return assessWithRules(item); });
  const desktop = (id: string, cpu: string, price = 8_000_000) => raw(id, price, { category: 'desktop', title: `PC ${cpu} RAM 16GB SSD 512GB`,
    description: `Máy hoạt động tốt, chưa sửa chữa. CPU ${cpu}, RAM 16GB DDR4, SSD 512GB NVMe, không card rời.` });
  const local = desktop('local-pc', 'i5-12400F');
  const national = [desktop('same-1', 'i5-12400F', 8_100_000), desktop('same-2', 'Core i5 12400F'), desktop('other', 'i5-12400'),
    desktop('several', 'i5-12400F / i5-13400F')];
  // Only the CPU-keyed desktop pool returns offers; component pools have their own identities.
  const offers = (input: SearchInput) => input.location !== 'nationwide' ? [local] : input.kind === 'desktop' ? national : [];
  const service = new FlipperService(store, { search: async (input: SearchInput) => ({ items: offers(input), total: offers(input).length }),
    detail: async (item: RawListing) => item });
  try {
    service.refresh('desktop', '', 1); await settled(service);
    assert.ok(assessed.includes('same-1') && assessed.includes('same-2'));
    assert.equal(assessed.includes('other'), false); assert.equal(assessed.includes('several'), false);
  } finally { await service.shutdown(); store.close(); }
});
