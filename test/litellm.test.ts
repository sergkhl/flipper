import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AIReceipt, HardwareKind, RawListing } from '../shared/types.ts';
import { DECIDER_MODEL, EMPTY_PROFILE, MIMO_MODEL, liteLLMEndpoints } from '../server/config.ts';
import { BudgetExceededError, LiteLLMClient, RefreshBudget } from '../server/litellm.ts';

const raw: RawListing = {
  id: 'gpu-123', category: 'gpu', title: 'NVIDIA RTX 3060 12GB',
  description: 'Used desktop graphics card RTX 3060 12GB, working normally. Full price 4000000 VND.',
  price: 4_000_000, url: 'https://www.chotot.com/123.htm', images: [],
  sellerId: 'seller-1', sellerType: 'unknown', region: 'Đà Nẵng', district: 'Cẩm Lệ', ward: '',
  condition: 'used', params: {}, attributes: {}, observedAt: '2026-10-12T00:00:00Z', displayAge: 'Today',
};
const kinds: HardwareKind[] = ['laptop', 'desktop', 'gpu', 'ram', 'cpu', 'ssd', 'other', 'wanted'];

function decisions(kind: HardwareKind = 'gpu') {
  return {
    answers: {
      listing_type: { type: 'choice', choice: kind, confidence: 0.96,
        probabilities: Object.fromEntries(kinds.map(label => [label, label === kind ? 0.986 : 0.002])) },
      working_used: { type: 'noul', noul: 0.96 },
      damaged_or_repaired: { type: 'noul', noul: 0.01 },
      locked_or_parts: { type: 'noul', noul: 0.01 },
      ambiguous_price: { type: 'noul', noul: 0.01 },
      deposit_only: { type: 'noul', noul: 0.01 },
      conflicting_specs: { type: 'noul', noul: 0.01 },
    },
    id: 'dec-1', model: DECIDER_MODEL, provider: 'Fixture decider',
    usage: { input_tokens: 800, output_tokens: 0, cost: 0.00004 },
  };
}

function extraction() {
  return {
    kind: 'gpu', profile: { ...EMPTY_PROFILE, model: 'RTX 3060', gpu: 'RTX 3060', gpuClass: 'desktop', vramGb: 12, priceBasis: 'item' },
    flags: { damaged: false, repaired: false, locked: false, partsOnly: false, depositOnly: false, multiPrice: false },
    unknowns: [] as Array<{ field: string; reason: string }>, conflicts: [] as string[], confidence: 0.95,
    evidence: [
      { field: 'model', quote: 'RTX 3060' }, { field: 'gpu', quote: 'RTX 3060' },
      { field: 'gpuClass', quote: 'desktop graphics card' }, { field: 'vramGb', quote: 'RTX 3060 12GB' },
    ],
  };
}

function completion(value: unknown = extraction()) {
  return {
    id: 'mimo-1', model: `${MIMO_MODEL}-20260921`, provider: 'Fixture MiMo',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 1_500, completion_tokens: 500, cost: 0.0008 },
  };
}

function reply(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function mockClient(deciderResult: unknown = decisions(), mimoResult: unknown = completion(), chatHeaders: Record<string, string> = {}, decisionHeaders: Record<string, string> = {}) {
  const calls: Array<{ url: string; body: Record<string, any>; headers: Headers }> = [];
  const receipts: AIReceipt[] = [];
  const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return url.endsWith('/alpha/decisions') ? reply(deciderResult, 200, decisionHeaders) : reply(mimoResult, 200, chatHeaders);
  }) as typeof fetch;
  return { client: new LiteLLMClient({ key: 'secret-fixture-key', endpoints: liteLLMEndpoints({}), fetch: mockedFetch, onReceipt: receipt => receipts.push(receipt) }), calls, receipts };
}

interface Call { url: string; body: Record<string, any>; signal?: AbortSignal | null; }
function scriptedClient(steps: Array<Response | Error | ((call: Call) => Response | Promise<Response>)>) {
  const calls: Call[] = [], receipts: AIReceipt[] = [];
  const client = new LiteLLMClient({ key: 'hidden-fixture-key', endpoints: liteLLMEndpoints({}), onReceipt: receipt => receipts.push(receipt),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), body: JSON.parse(String(init?.body)), signal: init?.signal };
      calls.push(call);
      const step = steps[calls.length - 1];
      assert.ok(step, 'Unexpected extra AI request');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(call) : step;
    }) as typeof fetch });
  return { client, calls, receipts };
}

test('the two requested models use their own APIs and deterministic hardware evidence', async () => {
  const { client, calls, receipts } = mockClient();
  const budget = new RefreshBudget(0.25);
  const result = await client.assess(raw, budget);
  assert.equal(result.eligibility, 'eligible');
  assert.equal(result.profile.gpu, 'RTX 3060');
  assert.equal(result.profile.vramGb, 12);
  assert.equal(result.method, 'ai');
  assert.equal(calls[0].url, 'http://localhost:4000/openrouter/api/alpha/decisions');
  assert.equal(calls[0].body.model, DECIDER_MODEL);
  assert.equal(calls[0].body.questions.listing_type.type, 'choice');
  assert.equal(calls[0].body.questions.deposit_only.type, 'noul');
  assert.equal(calls[1].url, 'http://localhost:4000/v1/chat/completions');
  assert.equal(calls[1].body.model, MIMO_MODEL);
  assert.deepEqual(calls[1].body.response_format, { type: 'json_object' });
  assert.equal(calls[1].body.extra_body.thinking.type, 'disabled');
  assert.equal('provider' in calls[1].body, false);
  assert.equal('reasoning' in calls[1].body, false);
  assert.equal(calls[1].body.max_tokens, 4_096);
  assert.equal(calls[0].body.provider.max_price.prompt, 0.05);
  assert.ok(calls.every(call => call.headers.get('Authorization') === 'Bearer secret-fixture-key'));
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].provider, 'Fixture decider');
  assert.equal(receipts[0].inputTokens, 800);
  assert.equal(receipts[0].outputTokens, 0);
  assert.equal(receipts[1].inputTokens, 1_500);
  assert.equal(receipts[1].outputTokens, 500);
  assert.ok(Math.abs(budget.spent - 0.00084) < 1e-12);
  assert.ok(Math.abs(budget.remaining - (0.25 - 0.00084)) < 1e-12);
  assert.ok(!JSON.stringify({ result, receipts }).includes('secret-fixture-key'));
  assert.ok(!('average' in result) && !('marketPrice' in result));
});

test('hallucinated quotes or unsupported variant values cannot become comparable configuration', async () => {
  const value = extraction();
  value.profile.gpu = 'RTX 3060 Ti';
  value.profile.vramGb = 8;
  value.evidence = value.evidence.filter(item => item.field !== 'gpu' && item.field !== 'vramGb');
  value.evidence.push({ field: 'gpu', quote: 'RTX 3060' }, { field: 'vramGb', quote: 'RTX 3060 Ti 8GB' });
  const { client } = mockClient(decisions(), completion(value));
  const result = await client.assess(raw, new RefreshBudget(0.25));
  assert.equal(result.profile.gpu, null);
  assert.equal(result.profile.vramGb, null);
  assert.equal(result.eligibility, 'review');
  assert.ok(result.unknowns.some(message => message.includes('gpu')));
  assert.ok(result.evidence.every(item => item.quote !== 'RTX 3060 Ti 8GB'));
});

test('GPU comparison ignores optional computer/board/count caveats while required uncertainties still need review', async () => {
  const value = extraction();
  value.unknowns = [
    { field: 'cpu', reason: 'No CPU model stated' },
    { field: 'ramGb', reason: 'No system RAM stated' },
    { field: 'storageGb', reason: 'No storage stated' },
    { field: 'model', reason: 'Manufacturer cooler/OC variant not stated' },
    { field: 'quantity', reason: 'No explicit item count' },
  ];
  value.profile.quantity = 1;
  value.evidence.push({ field: 'quantity', quote: 'desktop graphics card' });
  const result = await mockClient(decisions(), completion(value)).client.assess(raw, new RefreshBudget(0.25));
  assert.equal(result.eligibility, 'eligible');
  assert.equal(result.profile.quantity, null);
  assert.deepEqual(result.unknowns, []);

  for (const field of ['vramGb', 'condition', 'configuration', 'priceBasis']) {
    const uncertain = { ...value, unknowns: [{ field, reason: `${field} is uncertain` }] };
    const reviewed = await mockClient(decisions(), completion(uncertain)).client.assess(raw, new RefreshBudget(0.25));
    assert.equal(reviewed.eligibility, 'review', field);
    assert.ok(reviewed.unknowns.includes(`${field} is uncertain`));
  }
  const bundle = { ...value, profile: { ...value.profile, priceBasis: 'bundle' as const },
    evidence: [...value.evidence, { field: 'priceBasis', quote: 'Full price 4000000 VND.' }] };
  assert.equal((await mockClient(decisions(), completion(bundle)).client.assess(raw, new RefreshBudget(0.25))).eligibility, 'review');
});

test('verbose uncertainty and conflict explanations stay bounded without losing their review gate', async () => {
  const value = extraction();
  value.unknowns = [{ field: 'condition', reason: `Condition is uncertain. ${'More context. '.repeat(25)}` }];
  value.conflicts = [`Configuration conflicts. ${'More context. '.repeat(25)}`];
  const result = await mockClient(decisions(), completion(value)).client.assess(raw, new RefreshBudget(0.25));
  assert.equal(result.method, 'ai');
  assert.equal(result.eligibility, 'review');
  assert.equal(result.unknowns[0]?.length, 220);
  assert.equal(result.conflicts[0]?.length, 220);
  assert.ok(result.unknowns[0]?.startsWith('Condition is uncertain.'));
  assert.ok(result.conflicts[0]?.startsWith('Configuration conflicts.'));
});

test('multi-model prices go to review while generic shop financing does not imply a deposit', async () => {
  const boilerplate = { ...raw, description: `${raw.description} Cửa hàng thu mua máy hỏng, hỗ trợ trả góp. Shop buys broken devices; installments available.` };
  const clean = mockClient();
  const result = await clean.client.assess(boilerplate, new RefreshBudget(0.25));
  assert.equal(result.eligibility, 'eligible');
  assert.deepEqual(result.risks, []);
  assert.match(clean.calls[0].body.questions.deposit_only.instructions, /Optional installments/);

  const multiple = { ...raw, description: `${raw.description} RTX 3060 12GB 4 triệu; RTX 3060 Ti 8GB 6 triệu.` };
  const classified = decisions();
  classified.answers.ambiguous_price.noul = 0.98;
  const extracted = extraction();
  extracted.flags.multiPrice = true;
  extracted.evidence.push({ field: 'multiPrice', quote: 'RTX 3060 12GB 4 triệu; RTX 3060 Ti 8GB 6 triệu.' });
  const ambiguous = await mockClient(classified, completion(extracted)).client.assess(multiple, new RefreshBudget(0.25));
  assert.equal(ambiguous.eligibility, 'review');
  assert.ok(ambiguous.conflicts.some(message => message.includes('price is ambiguous')));
});

test('source repair condition is excluded without paid calls', async () => {
  const { client, calls } = mockClient();
  const result = await client.assess({ ...raw, condition: 'repaired' }, new RefreshBudget(0));
  assert.equal(result.eligibility, 'excluded');
  assert.equal(result.method, 'rules');
  assert.deepEqual(result.risks, ['repaired']);
  assert.equal(calls.length, 0);
});

test('typed probability validation rejects malformed or inconsistent decisions before MiMo', async () => {
  const malformed = decisions();
  malformed.answers.listing_type.probabilities.gpu = 0.1;
  const { client, calls, receipts } = mockClient(malformed);
  await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /inconsistent listing-type probabilities/);
  assert.equal(calls.length, 2);
  assert.equal(receipts.length, 2); // Both rejected responses consumed reported provider cost.
});

test('unsolicited AI price estimates are rejected by the extraction schema', async () => {
  const estimated = { ...extraction(), nationwideAverageVnd: 8_000_000 };
  const { client } = mockClient(decisions(), completion(estimated));
  await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /unsupported or invalid hardware fields/);
});

test('laptop graphics cannot be accepted as a standalone desktop card', async () => {
  const listing = { ...raw, category: 'laptop' as const, title: 'Laptop RTX 3060 12GB', description: `${raw.description} Laptop i7-11800H, RAM 16GB, SSD 512GB.` };
  const extracted = extraction();
  extracted.kind = 'laptop';
  const result = await mockClient(decisions('laptop'), completion(extracted)).client.assess(listing, new RefreshBudget(0.25));
  assert.equal(result.profile.gpuClass, null);
  assert.equal(result.eligibility, 'review');
  assert.ok(result.conflicts.some(message => message.includes('standalone desktop GPU')));
});

test('reservations exclude in-flight spending and reconcile to actual cost exactly once', () => {
  const budget = new RefreshBudget(0.01);
  const reservation = budget.reserve(0.008);
  assert.ok(Math.abs(budget.remaining - 0.002) < 1e-12);
  assert.throws(() => budget.reserve(0.003), BudgetExceededError);
  reservation.settle(0.001);
  reservation.release();
  reservation.settle(0.008);
  assert.equal(budget.spent, 0.001);
  assert.ok(Math.abs(budget.remaining - 0.009) < 1e-12);
  const second = budget.reserve(0.005);
  second.release();
  assert.equal(budget.spent, 0.001);
});

test('insufficient budget stops before any authenticated fetch', async () => {
  const { client, calls } = mockClient();
  await assert.rejects(client.assess(raw, new RefreshBudget(0)), BudgetExceededError);
  assert.equal(calls.length, 0);
});

test('failed or unreported billing retains a conservative budget charge and never exposes a key', async () => {
  const budget = new RefreshBudget(0.25);
  const client = new LiteLLMClient({ key: 'hidden-key', fetch: (async () => { throw new Error('Request leaked hidden-key'); }) as typeof fetch });
  await assert.rejects(client.assess(raw, budget), error => error instanceof Error && !error.message.includes('hidden-key') && /could not be reached/.test(error.message));
  assert.ok(budget.spent > 0 && budget.spent < 0.25);

  const metadataBudget = new RefreshBudget(0.25);
  const withoutUsage = { ...decisions(), usage: { input_tokens: 800, output_tokens: 0 } };
  const unreported = mockClient(withoutUsage);
  await assert.rejects(unreported.client.assess(raw, metadataBudget), /invalid billing metadata/);
  assert.ok(metadataBudget.spent > 0);
  assert.equal(unreported.receipts.length, 0);
});

test('cost above the routing estimate is recorded and stops any further AI requests', async () => {
  const expensive = decisions();
  expensive.usage.cost = 0.1;
  const { client, calls, receipts } = mockClient(expensive);
  const budget = new RefreshBudget(0.25);
  await assert.rejects(client.assess(raw, budget), /above the reserved ceiling/);
  assert.equal(budget.spent, 0.1);
  assert.equal(budget.remaining, 0);
  await assert.rejects(client.assess(raw, budget), BudgetExceededError);
  assert.equal(calls.length, 1);
  assert.equal(receipts[0].costUsd, 0.1);
});

test('provider probes report each model independently and redact provider error content', async () => {
  const calls: string[] = [];
  const client = new LiteLLMClient({ key: 'never-return-this', fetch: (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return String(input).endsWith('/alpha/decisions')
      ? reply({ error: { message: 'Bad key never-return-this' } }, 401) : reply(completion());
  }) as typeof fetch });
  const results = await client.test(new RefreshBudget(0.25));
  assert.equal(results[0].model, DECIDER_MODEL);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /authentication rejected/);
  assert.equal(results[1].model, MIMO_MODEL);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].costUsd, 0.0008);
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(results).includes('never-return-this'));
});

test('long listing input is bounded and account/contact attributes are omitted', async () => {
  const { client, calls } = mockClient();
  await client.assess({ ...raw, description: `${raw.description}${' Đ'.repeat(20_000)}`, attributes: { phone: 'unnecessary-phone', account_name: 'private-name' } }, new RefreshBudget(0.25));
  assert.ok(Buffer.byteLength(calls[0].body.state.description) <= 12_000);
  assert.ok(!JSON.stringify(calls[0].body).includes('unnecessary-phone'));
  assert.ok(!JSON.stringify(calls[0].body).includes('private-name'));
});

test('an unexpected fallback model cannot be reported as the requested provider integration', async () => {
  const different = { ...completion(), model: 'some-other-model' };
  const { client } = mockClient(decisions(), different);
  await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /unexpected model/);
  const wrongGroup = mockClient(decisions(), { ...completion(), model: 'mimo-v2.6-flash' }, { 'x-litellm-model-group': 'some-other-route' });
  await assert.rejects(wrongGroup.client.assess(raw, new RefreshBudget(0.25)), /unexpected model/);
});

test('LiteLLM accepts a base URL or a full chat path and keeps Decisions on its dedicated URL', () => {
  for (const base of ['http://localhost:4000/v1', 'http://localhost:4000/v1/', 'http://localhost:4000/v1/chat/completions/']) {
    const endpoints = liteLLMEndpoints({ LITELLM_BASE_URL: base });
    assert.equal(endpoints.chatCompletionsUrl, 'http://localhost:4000/v1/chat/completions');
    assert.equal(endpoints.decisionsUrl, 'http://localhost:4000/openrouter/api/alpha/decisions');
  }
  assert.deepEqual(liteLLMEndpoints({ LITELLM_BASE_URL: 'http://127.0.0.1:4100/v1', LITELLM_DECISIONS_URL: 'http://127.0.0.1:4100/openrouter/api/alpha/decisions' }), {
    chatCompletionsUrl: 'http://127.0.0.1:4100/v1/chat/completions', decisionsUrl: 'http://127.0.0.1:4100/openrouter/api/alpha/decisions',
  });
});

test('native MiMo responses retain the requested route and reconcile LiteLLM header billing', async () => {
  const native = { ...completion(), model: 'mimo-v2.6-flash', provider: undefined,
    usage: { prompt_tokens: 1500, completion_tokens: 500 } };
  for (const cost of [0, 0.00035]) {
    const { client, receipts } = mockClient(decisions(), native, { 'x-litellm-response-cost': String(cost), 'x-litellm-model-group': MIMO_MODEL });
    const budget = new RefreshBudget(0.25);
    assert.equal((await client.assess(raw, budget)).eligibility, 'eligible');
    assert.equal(receipts[1].model, MIMO_MODEL);
    assert.equal(receipts[1].costUsd, cost);
    assert.equal(receipts[1].inputTokens, 1500);
    assert.equal(receipts[1].outputTokens, 500);
    assert.equal(budget.spent, 0.00004 + cost);
  }
  const proxyCost = mockClient(decisions(), completion(), { 'x-litellm-response-cost': '0.00035' });
  await proxyCost.client.assess(raw, new RefreshBudget(0.25));
  assert.equal(proxyCost.receipts[1].costUsd, 0.00035);
  const passthroughCost = mockClient(decisions(), completion(), {}, { 'x-litellm-response-cost': '0' });
  await passthroughCost.client.assess(raw, new RefreshBudget(0.25));
  assert.equal(passthroughCost.receipts[0].costUsd, 0.00004);
});

test('missing or invalid LiteLLM header billing retains the reservation instead of reporting zero cost', async () => {
  for (const header of [undefined, '', 'unknown', '-0.1', 'Infinity']) {
    const native = { ...completion(), model: 'mimo-v2.6-flash', usage: { prompt_tokens: 1500, completion_tokens: 500 } };
    const { client, receipts } = mockClient(decisions(), native, header === undefined ? {} : { 'x-litellm-response-cost': header });
    const budget = new RefreshBudget(0.25);
    await assert.rejects(client.assess(raw, budget), /invalid billing metadata/);
    assert.ok(budget.spent > 0.00004);
    assert.equal(receipts.length, 1);
  }
});

test('a LiteLLM chat cost above the reservation is recorded and seals the remaining refresh budget', async () => {
  const { client, calls, receipts } = mockClient(decisions(), completion(), { 'x-litellm-response-cost': '0.1' });
  const budget = new RefreshBudget(0.25);
  await assert.rejects(client.assess(raw, budget), /above the reserved ceiling/);
  assert.equal(receipts[1].costUsd, 0.1);
  assert.equal(budget.spent, 0.10004);
  assert.equal(budget.remaining, 0);
  await assert.rejects(client.assess(raw, budget), BudgetExceededError);
  assert.equal(calls.length, 2);
});

test('chat usage must follow its own token contract and routing metadata preserves selected provider', async () => {
  const metadataOnly = { ...completion(), provider: undefined,
    openrouter_metadata: { endpoints: { available: [{ provider: 'Unselected provider', selected: false }, { provider: 'Selected provider', selected: true }] } } };
  const selected = mockClient(decisions(), metadataOnly);
  await selected.client.assess(raw, new RefreshBudget(0.25));
  assert.equal(selected.receipts[1].provider, 'Selected provider');

  const wrongTokens = { ...completion(), usage: { input_tokens: 1500, output_tokens: 500, cost: 0.0008 } };
  await assert.rejects(mockClient(decisions(), wrongTokens).client.assess(raw, new RefreshBudget(0.25)), /invalid billing metadata/);
});

test('a laptop with unstated graphics stays in review even when the other essential specs are known', async () => {
  const listing = { ...raw, category: 'laptop' as const, title: 'Dell Inspiron 5510',
    description: 'Dell Inspiron 5510 i7-11800H RAM 16GB SSD 512GB. Used laptop, working normally.' };
  const value = { ...extraction(), kind: 'laptop',
    profile: { ...EMPTY_PROFILE, model: 'Dell Inspiron 5510', cpu: 'i7-11800H', ramGb: 16, storageGb: 512, storageType: 'SSD', priceBasis: 'item' },
    evidence: [
      { field: 'model', quote: 'Dell Inspiron 5510' }, { field: 'cpu', quote: 'i7-11800H' },
      { field: 'ramGb', quote: 'RAM 16GB' }, { field: 'storageGb', quote: 'SSD 512GB' }, { field: 'storageType', quote: 'SSD 512GB' },
    ],
  };
  const result = await mockClient(decisions('laptop'), completion(value)).client.assess(listing, new RefreshBudget(0.25));
  assert.equal(result.eligibility, 'review');
  assert.ok(result.unknowns.some(message => message.startsWith('gpu ')));
  assert.ok(result.unknowns.some(message => message.startsWith('gpuClass ')));
});

test('RAM comparables require explicit per-stick capacity and quantity before price normalization', async () => {
  const listing = { ...raw, category: 'ram' as const, title: 'RAM DDR4 16GB 3200 DIMM',
    description: 'RAM DDR4 16GB 3200 DIMM used, working normally.' };
  const value = { ...extraction(), kind: 'ram',
    profile: { ...EMPTY_PROFILE, ramGb: 16, ramType: 'DDR4', ramSpeedMhz: 3200, ramFormFactor: 'DIMM', priceBasis: 'item' },
    evidence: [
      { field: 'ramGb', quote: 'RAM DDR4 16GB' }, { field: 'ramType', quote: 'DDR4' },
      { field: 'ramSpeedMhz', quote: '3200' }, { field: 'ramFormFactor', quote: 'DIMM' },
    ],
  };
  const result = await mockClient(decisions('ram'), completion(value)).client.assess(listing, new RefreshBudget(0.25));
  assert.equal(result.eligibility, 'review');
  assert.ok(result.unknowns.some(message => message.startsWith('quantity ')));
  assert.ok(result.unknowns.some(message => message.startsWith('perUnitGb ')));
});

test('GT 730 memory-generation variants require quoted GPU memory type before comparison', async () => {
  const listing = { ...raw, title: 'ASUS GT730 2GB', description: 'Used desktop graphics card ASUS GT730 2GB, working normally.' };
  const value = { ...extraction(),
    profile: { ...EMPTY_PROFILE, model: 'ASUS GT730', gpu: 'NVIDIA GT730', gpuClass: 'desktop', vramGb: 2, priceBasis: 'item' },
    evidence: [
      { field: 'model', quote: 'ASUS GT730' }, { field: 'gpu', quote: 'ASUS GT730' },
      { field: 'gpuClass', quote: 'desktop graphics card' }, { field: 'vramGb', quote: 'GT730 2GB' },
    ],
  };
  // Keep the GPU label verbatim; a provider must not manufacture a vendor prefix.
  value.profile.gpu = 'GT730';
  const missing = await mockClient(decisions(), completion(value)).client.assess(listing, new RefreshBudget(0.25));
  assert.equal(missing.eligibility, 'review');
  assert.ok(missing.unknowns.some(message => message.startsWith('gpuMemoryType ')));

  const invented = { ...value, profile: { ...value.profile, gpuMemoryType: 'GDDR5' },
    evidence: [...value.evidence, { field: 'gpuMemoryType', quote: 'GT730 2GB' }] };
  const unsupported = await mockClient(decisions(), completion(invented)).client.assess(listing, new RefreshBudget(0.25));
  assert.equal(unsupported.profile.gpuMemoryType, null);
  assert.equal(unsupported.eligibility, 'review');

  const stated = { ...listing, description: `${listing.description} GT730 2GB GDDR5.` };
  const proven = { ...value, profile: { ...value.profile, gpuMemoryType: 'GDDR5' },
    evidence: [...value.evidence, { field: 'gpuMemoryType', quote: 'GT730 2GB GDDR5' }] };
  const eligible = await mockClient(decisions(), completion(proven)).client.assess(stated, new RefreshBudget(0.25));
  assert.equal(eligible.profile.gpuMemoryType, 'GDDR5');
  assert.equal(eligible.eligibility, 'eligible');
});

test('Apple integrated graphics require an explicit source-supported GPU core-count variant', async () => {
  const listing = { ...raw, category: 'laptop' as const, title: 'MacBook Air M1',
    description: 'MacBook Air M1, RAM 8GB SSD 256GB. Used laptop, working normally. Integrated M1 GPU.' };
  const value = { ...extraction(), kind: 'laptop',
    profile: { ...EMPTY_PROFILE, model: 'MacBook Air M1', cpu: 'M1', gpu: 'M1 GPU', gpuClass: 'integrated', ramGb: 8, storageGb: 256, storageType: 'SSD', priceBasis: 'item' },
    evidence: [
      { field: 'model', quote: 'MacBook Air M1' }, { field: 'cpu', quote: 'M1' },
      { field: 'gpu', quote: 'M1 GPU' }, { field: 'gpuClass', quote: 'Integrated M1 GPU' },
      { field: 'ramGb', quote: 'RAM 8GB' }, { field: 'storageGb', quote: 'SSD 256GB' }, { field: 'storageType', quote: 'SSD 256GB' },
    ],
  };
  const missing = await mockClient(decisions('laptop'), completion(value)).client.assess(listing, new RefreshBudget(0.25));
  assert.equal(missing.eligibility, 'review');
  assert.ok(missing.unknowns.some(message => message.includes('Apple GPU core-count')));

  const invented = { ...value, profile: { ...value.profile, gpu: 'M1 8-core GPU' },
    evidence: value.evidence.map(item => item.field === 'gpu' ? { field: 'gpu', quote: 'M1 GPU' } : item) };
  const unproved = await mockClient(decisions('laptop'), completion(invented)).client.assess(listing, new RefreshBudget(0.25));
  assert.equal(unproved.profile.gpu, null);
  assert.equal(unproved.eligibility, 'review');

  const stated = { ...listing, description: `${listing.description} M1 7-core GPU.` };
  const proven = { ...value, profile: { ...value.profile, gpu: 'M1 7-core GPU' },
    evidence: value.evidence.map(item => item.field === 'gpu' ? { field: 'gpu', quote: 'M1 7-core GPU' } : item) };
  const eligible = await mockClient(decisions('laptop'), completion(proven)).client.assess(stated, new RefreshBudget(0.25));
  assert.equal(eligible.eligibility, 'eligible');
  assert.equal(eligible.profile.gpu, 'M1 7-core GPU');
  assert.ok(eligible.evidence.some(item => item.field === 'gpu' && item.quote === 'M1 7-core GPU'));
});

test('MiMo receives numeric limits, null rules and a complete example in JSON-object mode', async () => {
  const { client, calls } = mockClient();
  await client.assess(raw, new RefreshBudget(0.25));
  const prompt: string = calls[1]!.body.messages[0].content;
  const contract = JSON.parse(prompt.split('Match this JSON Schema, which is also enforced by the application:\n')[1]!.split('\nValid example')[0]!);
  const fields = contract.properties.profile.properties;
  assert.deepEqual(fields.vramGb.anyOf, [{ type: 'number', exclusiveMinimum: 0, maximum: 65_536 }, { type: 'null' }]);
  assert.equal(fields.ramSpeedMhz.anyOf[0].type, 'integer');
  assert.equal(fields.ramSpeedMhz.anyOf[0].minimum, 100);
  assert.equal(fields.quantity.anyOf[0].maximum, 64);
  assert.deepEqual(contract.properties.confidence, { type: 'number', minimum: 0, maximum: 1 });
  assert.equal(contract.additionalProperties, false);
  assert.ok(contract.properties.profile.required.includes('ramGb'));
  assert.match(prompt, /never use zero/);
  assert.match(prompt, /"ramGb":null/);
});

test('a corrected zero capacity retries only extraction and preserves both paid receipts', async () => {
  const invalid = extraction(); invalid.profile.ramGb = 0;
  const { client, calls, receipts } = scriptedClient([reply(decisions()), reply(completion(invalid)), reply(completion())]);
  const budget = new RefreshBudget(0.25);
  assert.equal((await client.assess(raw, budget)).eligibility, 'eligible');
  assert.deepEqual(calls.map(call => call.body.model), [DECIDER_MODEL, MIMO_MODEL, MIMO_MODEL]);
  assert.match(calls[2]!.body.messages[0].content, /Previous extraction failed local validation: profile.ramGb \(too_small\)/);
  assert.equal(calls[1]!.body.messages[1].content, calls[2]!.body.messages[1].content);
  assert.equal(receipts.length, 3);
  assert.ok(Math.abs(budget.spent - 0.00164) < 1e-12);
});

test('an out-of-range RAM speed leaves supported hardware intact without guessing a zero correction', async () => {
  const listing = { ...raw, category: 'desktop' as const,
    description: `${raw.description} RAM DDR4 16GB 32000MHz.` };
  const value = { ...extraction(), kind: 'desktop', profile: { ...extraction().profile, ramGb: 16, ramType: 'DDR4', ramSpeedMhz: 32_000 },
    evidence: [...extraction().evidence, { field: 'ramGb', quote: '16GB' }, { field: 'ramType', quote: 'DDR4' }, { field: 'ramSpeedMhz', quote: '32000MHz' }] };
  const { client, calls, receipts } = scriptedClient([reply(decisions('desktop')), reply(completion(value)), reply(completion(value))]);
  const budget = new RefreshBudget(0.25), result = await client.assess(listing, budget);
  assert.equal(result.method, 'ai'); assert.equal(result.profile.ramSpeedMhz, null);
  assert.equal(result.profile.ramGb, 16); assert.equal(result.profile.ramType, 'DDR4'); assert.equal(result.profile.gpu, 'RTX 3060');
  assert.match(result.status, /RAM speed.*outside.*range.*unknown/i);
  assert.equal(calls.length, 2); assert.equal(receipts.length, 2); assert.ok(Math.abs(budget.spent - 0.00084) < 1e-12);
  assert.ok(!result.evidence.some(item => item.field === 'ramSpeedMhz'), 'a rejected speed is not accepted evidence');
});

test('a standalone RAM offer still needs review when its invalid speed is discarded', async () => {
  const listing = { ...raw, category: 'ram' as const, title: 'RAM DDR4 DIMM 16GB', description: 'Used RAM DDR4 DIMM 16GB 32000MHz, working normally.' };
  const value = { ...extraction(), kind: 'ram', profile: { ...EMPTY_PROFILE, ramGb: 16, ramType: 'DDR4', ramFormFactor: 'DIMM', ramSpeedMhz: 32_000, priceBasis: 'item' },
    evidence: [{ field: 'ramGb', quote: '16GB' }, { field: 'ramType', quote: 'DDR4' }, { field: 'ramFormFactor', quote: 'DIMM' }, { field: 'ramSpeedMhz', quote: '32000MHz' }] };
  const { client } = mockClient(decisions('ram'), completion(value));
  const result = await client.assess(listing, new RefreshBudget(0.25));
  assert.equal(result.profile.ramSpeedMhz, null); assert.equal(result.eligibility, 'review');
  assert.ok(result.unknowns.some(note => note.includes('ramSpeedMhz')));
});

test('a null speed retains its explanation and a guessed zero correction cannot pass source quotes', async () => {
  const listing = { ...raw, category: 'desktop' as const, description: `${raw.description} RAM DDR4 16GB 32000MHz.` };
  for (const speed of [null, 3200]) {
    const value = { ...extraction(), kind: 'desktop', profile: { ...extraction().profile, ramSpeedMhz: speed },
      unknowns: [{ field: 'ramSpeedMhz', reason: 'Seller-stated RAM speed is outside the supported range.' }],
      evidence: [...extraction().evidence, { field: 'ramSpeedMhz', quote: '32000MHz' }] };
    const result = await mockClient(decisions('desktop'), completion(value)).client.assess(listing, new RefreshBudget(0.25));
    assert.equal(result.profile.ramSpeedMhz, null); assert.equal(result.profile.gpu, 'RTX 3060');
    if (speed === null) assert.match(result.status, /RAM speed remains unknown: Seller-stated/);
  }
});

test('RAM speed recovery cannot hide another schema violation or accept a wrong field type', async () => {
  for (const profile of [ { ramSpeedMhz: 32_000, ramGb: 0 }, { ramSpeedMhz: '32000' }, { ramSpeedMhz: 3200.5 } ]) {
    const value = { ...extraction(), profile: { ...extraction().profile, ...profile } };
    const { client, calls } = scriptedClient([reply(decisions()), reply(completion(value)), reply(completion(value))]);
    await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /unsupported or invalid hardware fields/);
    assert.equal(calls.length, 3);
  }
});

test('invalid fields stay invalid after the single retry, with safe field diagnostics', async () => {
  const invalid = { ...extraction(), profile: { ...extraction().profile, ramGb: 0, quantity: 0, storageGb: 100_000 },
    confidence: 95, 'hidden-fixture-key': 'sensitive-provider-text' };
  const { client, calls } = scriptedClient([reply(decisions()), reply(completion(invalid)), reply(completion(invalid))]);
  await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /profile.ramGb \(too_small\)/);
    assert.match(error.message, /confidence \(too_big\)/);
    assert.ok(!error.message.includes('hidden-fixture-key') && !error.message.includes('sensitive-provider-text'));
    return true;
  });
  assert.equal(calls.length, 3);
  const feedback: string = calls[2]!.body.messages[0].content;
  assert.ok(!feedback.includes('hidden-fixture-key') && !feedback.includes('sensitive-provider-text'));
});

test('invalid hardware JSON gets one corrective retry without replaying its untrusted text', async () => {
  const invalid = completion(); invalid.choices[0]!.message.content = 'hidden-fixture-key: not JSON';
  const { client, calls } = scriptedClient([reply(decisions()), reply(invalid), reply(completion())]);
  assert.equal((await client.assess(raw, new RefreshBudget(0.25))).method, 'ai');
  assert.match(calls[2]!.body.messages[0].content, /invalid JSON syntax/);
  assert.ok(!JSON.stringify(calls[2]!.body).includes('hidden-fixture-key'));
});

test('the observed native MiMo parameter trailer preserves validated facts without another paid call', async () => {
  const marked = completion(); marked.choices[0]!.message.content += 'parameter\n';
  const { client, calls } = scriptedClient([reply(decisions()), reply(marked)]);
  assert.equal((await client.assess(raw, new RefreshBudget(0.25))).method, 'ai');
  assert.equal(calls.length, 2);
});

test('trailer handling never accepts arbitrary prose, multiple objects or invalid hardware fields', async () => {
  for (const suffix of ['parameters', ' explanation', '{}', 'parameterparameter']) {
    const marked = completion(); marked.choices[0]!.message.content += suffix;
    const { client } = scriptedClient([reply(decisions()), reply(marked), reply(marked)]);
    await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /invalid hardware JSON/);
  }
  const invalid = extraction(); invalid.profile.ramGb = 0;
  const marked = completion(invalid); marked.choices[0]!.message.content += 'parameter';
  const { client } = scriptedClient([reply(decisions()), reply(marked), reply(marked)]);
  await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /profile.ramGb \(too_small\)/);
});

test('truncated extraction increases only its retry output ceiling and still refuses partial output', async () => {
  const truncated = completion(); truncated.choices[0]!.finish_reason = 'length';
  const recovered = scriptedClient([reply(decisions()), reply(truncated), reply(completion())]);
  assert.equal((await recovered.client.assess(raw, new RefreshBudget(0.25))).method, 'ai');
  assert.deepEqual(recovered.calls.slice(1).map(call => call.body.max_tokens), [4_096, 8_192]);
  const failed = scriptedClient([reply(decisions()), reply(truncated), reply(truncated)]);
  await assert.rejects(failed.client.assess(raw, new RefreshBudget(0.25)), /truncated at the output token limit/);
  assert.equal(failed.calls.length, 3);
});

test('transport and invalid-output recovery share one extra attempt per stage', async () => {
  const invalid = extraction(); invalid.profile.vramGb = 0;
  const { client, calls } = scriptedClient([reply(decisions()), new TypeError('hidden-fixture-key'), reply(completion(invalid))]);
  await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /profile.vramGb \(too_small\)/);
  assert.equal(calls.length, 3);
});

test('classification can recover once before extraction without replaying the full assessment', async () => {
  const { client, calls } = scriptedClient([new TypeError('hidden-fixture-key'), reply(decisions()), reply(completion())]);
  const budget = new RefreshBudget(0.25);
  assert.equal((await client.assess(raw, budget)).method, 'ai');
  assert.deepEqual(calls.map(call => call.body.model), [DECIDER_MODEL, DECIDER_MODEL, MIMO_MODEL]);
  assert.ok(budget.spent > 0.00084, 'unknown billing from the failed call remains charged');
});

test('transient HTTP failures retry within the allowance while long Retry-After waits are respected', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const { client, calls } = scriptedClient([reply({ error: 'hidden-fixture-key' }, status, { 'Retry-After': '0' }), reply(decisions()), reply(completion())]);
    assert.equal((await client.assess(raw, new RefreshBudget(0.25))).method, 'ai', String(status));
    assert.equal(calls.length, 3);
  }
  for (const header of ['600', new Date(Date.now() + 60_000).toUTCString()]) {
    const { client, calls } = scriptedClient([reply({}, 429, { 'Retry-After': header })]);
    await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), /HTTP 429/);
    assert.equal(calls.length, 1, 'do not retry before a long provider cooldown expires');
  }
});

test('authentication and input rejections do not retry or disclose response bodies', async () => {
  for (const status of [400, 401, 402, 403, 404, 413]) {
    const { client, calls } = scriptedClient([reply({ error: 'hidden-fixture-key' }, status)]);
    const budget = new RefreshBudget(0.25);
    await assert.rejects(client.assess(raw, budget), error => error instanceof Error && error.message.includes(`HTTP ${status}`) && !error.message.includes('hidden-fixture-key'));
    assert.equal(calls.length, 1);
    assert.equal(budget.spent, 0);
  }
});

test('an uncertain first call can exhaust the allowance before a retry is dispatched', async () => {
  const { client, calls } = scriptedClient([new TypeError('connection failed')]);
  const budget = new RefreshBudget(0.002);
  await assert.rejects(client.assess(raw, budget), BudgetExceededError);
  assert.equal(calls.length, 1);
  assert.ok(budget.spent > 0 && budget.spent < budget.limit);
});

test('cancellation during backoff prevents the extra provider call', async () => {
  const controller = new AbortController();
  const { client, calls } = scriptedClient([() => {
    setTimeout(() => controller.abort(), 20);
    throw new TypeError('connection failed');
  }]);
  const budget = new RefreshBudget(0.25);
  await assert.rejects(client.assess(raw, budget, controller.signal), /abort/i);
  assert.equal(calls.length, 1);
  assert.ok(budget.spent > 0);
});

test('a stalled response body obeys the request deadline, cancels its reader and retries only extraction', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal), deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { deadlines.push(milliseconds); return timeout(20); });
  let cancelled = 0;
  const { client, calls } = scriptedClient([reply(decisions()), new Response(new ReadableStream({ cancel() { cancelled++; } })), reply(completion())]);
  const budget = new RefreshBudget(0.25);
  assert.equal((await client.assess(raw, budget)).method, 'ai');
  assert.deepEqual(deadlines, [45_000, 120_000, 120_000]);
  assert.equal(cancelled, 1);
  assert.equal(calls.length, 3);
  assert.ok(budget.spent > 0.00084, 'a timed-out generation retains its reserved charge');
});

test('caller cancellation drains a stalled body without retrying', async () => {
  const controller = new AbortController();
  let started!: () => void, cancelled = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { client, calls } = scriptedClient([reply(decisions()), () => new Response(new ReadableStream({ pull() { started(); }, cancel() { cancelled++; } }))]);
  const budget = new RefreshBudget(0.25);
  const rejected = assert.rejects(client.assess(raw, budget, controller.signal), /cancelled/);
  await ready; controller.abort(); await rejected;
  assert.equal(cancelled, 1);
  assert.equal(calls.length, 2);
  assert.ok(budget.spent > 0.00004);
});

test('deadline and connection errors identify the route without leaking provider text', async () => {
  for (const failure of [new DOMException('hidden-fixture-key', 'TimeoutError'), new TypeError('hidden-fixture-key', { cause: { code: 'ECONNRESET' } })]) {
    const { client, calls } = scriptedClient([failure, failure]);
    await assert.rejects(client.assess(raw, new RefreshBudget(0.25)), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(DECIDER_MODEL) && !error.message.includes('hidden-fixture-key'));
      assert.match(error.message, failure.name === 'TimeoutError' ? /timed out after 45 seconds/ : /connection failed \(ECONNRESET\)/);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test('provider probes report all retry spending for each model', async () => {
  const invalid = extraction(); invalid.profile.ramGb = 0;
  const { client } = scriptedClient([reply(decisions()), reply(completion(invalid)), reply(completion())]);
  const results = await client.test(new RefreshBudget(0.25));
  assert.equal(results[1]!.ok, true);
  assert.ok(Math.abs(results[1]!.costUsd! - 0.0016) < 1e-12);
});
