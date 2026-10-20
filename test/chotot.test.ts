import assert from 'node:assert/strict';
import test from 'node:test';
import { ChototClient } from '../server/chotot.ts';
import type { RawListing } from '../shared/types.ts';

const ITEM_URL = 'https://www.chotot.com/mua-ban-laptop-quan-thanh-khe-da-nang/123.htm';
const IMAGE = 'https://cdn.chotot.com/preset:view/plain/item.jpg';

function ad(overrides: Record<string, unknown> = {}) {
  return {
    list_id: 123, ad_id: 987, category: 5030, type: 's',
    subject: 'Dell Latitude 5420 i5-1145G7 16GB/512GB',
    body: 'Máy đang dùng, RAM 16GB, SSD 512GB.', price: 7_500_000,
    account_id: 456, company_ad: true, elt_condition: 2,
    region_name: 'Đà Nẵng', area_name: 'Quận Thanh Khê', ward_name: 'Phường Thạc Gián',
    date: '2 giờ trước', images: [IMAGE], pc_cpu: 7, pc_ram: 7, pc_drive_capacity: 8,
    params: [
      { id: 'pc_cpu', label: 'Bộ vi xử lý', value: 'Intel Core i5' },
      { id: 'pc_ram', label: 'RAM', value: '16 GB' },
      { id: 'pc_drive_capacity', label: 'Ổ cứng', value: '512 GB' },
    ],
    ...overrides,
  };
}

function html(state: unknown, extra = '', secondary = false) {
  const props = secondary ? { pageProps: { initialState: {} }, initialState: state }
    : { pageProps: { initialState: state } };
  return `<!doctype html><html><head></head><body>${extra}<script type='application/json' id='__NEXT_DATA__'>${JSON.stringify({ props })}</script></body></html>`;
}

function feed(ads: unknown[] = [ad()], total: unknown = ads.length, extra = '', secondary = false) {
  const anchors = ads.map(value => {
    const id = (value as { list_id?: unknown }).list_id;
    return `<a data-testid='listing' href='/mua-ban-laptop-quan-thanh-khe-da-nang/${id}.htm?tracking=discarded&amp;source=feed'>Item</a>`;
  }).join('');
  return html({ adlisting: { data: { ads, total } } }, anchors + extra, secondary);
}

function detailHtml(raw = ad(), extra: Record<string, unknown> = {}, canonical = ITEM_URL) {
  return html({ adView: { adInfo: { ad: raw, ...extra } } }, `<link href='${canonical}' rel='canonical'>`);
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => handler(String(input), init);
}

function clientReturning(body: string) {
  return new ChototClient({ pauseMs: 0, fetch: mockFetch(() => new Response(body)) });
}

async function oneListing(): Promise<RawListing> {
  return (await clientReturning(feed()).search({ kind: 'laptop', location: 'danang' })).items[0];
}

test('public feed preserves literal specs and enum attributes without retaining account/contact payloads', async () => {
  const raw = ad({
    body: 'RAM 16GB, SSD 512GB; giá 7.500.000. Call 0911•235•333 or person@example.com.',
    phone: 'fixture-phone', authorization: 'fixture-credential',
    seller_info: { full_name: 'Private fixture', phone: 'fixture-phone' },
    params: [
      { id: 'pc_ram', value: '16 GB' }, { id: 'pc_drive_capacity', value: '512 GB' },
      { id: 'phone', value: 'fixture-phone' },
    ],
  });
  const result = await clientReturning(feed([raw], 42)).search({ kind: 'laptop', location: 'danang' });
  assert.equal(result.total, 42);
  const item = result.items[0];
  assert.equal(item.id, '123');
  assert.equal(item.url, ITEM_URL);
  assert.equal(item.category, 'laptop');
  assert.equal(item.price, 7_500_000);
  assert.equal(item.params.pc_ram, '16 GB');
  assert.equal(item.attributes.pc_ram, 7);
  assert.deepEqual(item.images, [IMAGE]);
  assert.equal(item.sellerId, '456');
  assert.equal(item.sellerType, 'business');
  assert.equal(item.condition, 'used');
  assert.equal(item.region, 'Đà Nẵng');
  assert.equal(item.district, 'Quận Thanh Khê');
  assert.equal(item.ward, 'Phường Thạc Gián');
  assert.equal(item.displayAge, '2 giờ trước');
  assert.match(item.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(item.description, /7\.500\.000/);
  assert.doesNotMatch(JSON.stringify(item), /0911|235•333|person@example|fixture-phone|fixture-credential|Private fixture/);
});

test('duplicate state location is supported and repeated listing IDs are deduplicated', async () => {
  const result = await clientReturning(feed([ad(), ad()], 2, '', true))
    .search({ kind: 'laptop', location: 'danang' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, '123');
});

test('a readable deleted advertisement is marked unavailable even when HTTP succeeds', async () => {
  const listing = await oneListing();
  const deleted = await clientReturning(detailHtml(ad({status:'deleted'}))).detail(listing);
  assert.equal(deleted.attributes.status, 'deleted');
  assert.equal(deleted.attributes._sourceUnavailable, true);
  const active = await clientReturning(detailHtml(ad({status:'active'}))).detail(deleted);
  assert.equal(active.attributes._sourceUnavailable, undefined);
});

test('a successful full detail retry clears a transient failure while preserving unrelated source metadata', async () => {
  const listing = await oneListing();
  const retry = { ...listing, attributes: { ...listing.attributes, _detailError: 'Upstream HTTP 503', _detailedAt: '2026-10-12T01:00:00.000Z' } };
  const result = await clientReturning(detailHtml()).detail(retry);
  assert.equal(result.attributes._detailError, undefined);
  assert.equal(result.attributes._detailedAt, retry.attributes._detailedAt);
  assert.equal(result.description, 'Máy đang dùng, RAM 16GB, SSD 512GB.');
});

test('only the actual NEXT_DATA script is parsed, not a data-id attribute', async () => {
  const impostor = '<script data-id="__NEXT_DATA__">{"broken":true}</script>';
  const result = await clientReturning(feed([ad()], 1, impostor))
    .search({ kind: 'laptop', location: 'nationwide' });
  assert.equal(result.items.length, 1);
});

test('all supported searches use verified routes and component filters with escaped keywords and paging', async () => {
  const cases = [
    ['laptop', 'laptop', undefined], ['desktop', 'may-tinh-de-ban', undefined],
    ['gpu', 'linh-kien', '2'], ['ram', 'linh-kien', '1'],
    ['cpu', 'linh-kien', '13'], ['ssd', 'linh-kien', '16'],
  ] as const;
  for (const [kind, route, componentType] of cases) {
    const calls: URL[] = [];
    const client = new ChototClient({ pauseMs: 0, fetch: mockFetch((url, init) => {
      calls.push(new URL(url));
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(new Headers(init?.headers).get('cookie'), null);
      return new Response(feed([]));
    }) });
    await client.search({ kind, location: 'danang', query: ' RTX 3060 & 12GB ', page: 2 });
    await client.search({ kind, location: 'nationwide' });
    assert.equal(calls[0].pathname, `/mua-ban-${route}-da-nang`);
    assert.equal(calls[0].searchParams.get('q'), 'RTX 3060 & 12GB');
    assert.equal(calls[0].searchParams.get('page'), '2');
    assert.equal(calls[1].pathname, `/mua-ban-${route}`);
    assert.equal(calls[1].searchParams.get('q'), null);
    assert.equal(calls[0].searchParams.get('component_type'), componentType ?? null);
    assert.equal(calls[0].searchParams.get('component_class'), componentType ? '1' : null);
  }
});

test('actual source category and condition take precedence over the requested feed', async () => {
  const rows = [
    ad({ list_id: 1, category: 5080, component_class: 1, component_type: 2, elt_condition: 1, company_ad: false }),
    ad({ list_id: 2, category: 5080, component_class: 1, component_type: 13, elt_condition: 3, company_ad: undefined }),
    ad({ list_id: 3, category: 5080, component_class: 1, component_type: 16 }),
    ad({ list_id: 4, category: 5080, component_class: 2, component_type: 2 }),
    ad({ list_id: 5, category: 5070, type: 'b' }),
  ];
  const { items } = await clientReturning(feed(rows)).search({ kind: 'gpu', location: 'nationwide' });
  assert.deepEqual(items.map(i => i.category), ['gpu', 'cpu', 'ssd', 'other', 'wanted']);
  assert.deepEqual(items.slice(0, 2).map(i => i.condition), ['new', 'repaired']);
  assert.deepEqual(items.slice(0, 2).map(i => i.sellerType), ['private', 'unknown']);
});

test('detail refresh reads full product labels, updates price, and preserves missing public fields', async () => {
  const listing = await oneListing();
  const raw = ad({ price: 7_000_000, images: [], account_id: undefined, company_ad: undefined, body: 'SSD 512GB nguyên bản.' });
  const result = await clientReturning(detailHtml(raw, {
    ad_params: {
      pc_model: { id: 'pc_model', value: 'Latitude 5420' },
      elt_warranty: { id: 'elt_warranty', value: '3 tháng' },
      phone: { id: 'phone', value: 'fixture-phone' },
      address: { id: 'address', value: 'fixture-address' },
    },
    parameters: [{ id: 'pc_screen_size', value: '13 - 14.9 inch' }],
    headers: { 'set-cookie': 'fixture-credential' },
  })).detail(listing);
  assert.equal(result.price, 7_000_000);
  assert.equal(result.params.pc_model, 'Latitude 5420');
  assert.equal(result.params.elt_warranty, '3 tháng');
  assert.equal(result.params.pc_screen_size, '13 - 14.9 inch');
  assert.deepEqual(result.images, listing.images);
  assert.equal(result.sellerId, listing.sellerId);
  assert.equal(result.sellerType, listing.sellerType);
  assert.doesNotMatch(JSON.stringify(result), /fixture-phone|fixture-address|fixture-credential/);
});

test('a detail response for another item fails instead of overwriting the original listing', async () => {
  const listing = await oneListing();
  await assert.rejects(clientReturning(detailHtml(ad({ list_id: 999 }))).detail(listing), /different item/);
});

test('untrusted item URLs are rejected before a request and unsafe image URLs are omitted', async () => {
  const listing = await oneListing();
  let calls = 0;
  const client = new ChototClient({ fetch: mockFetch(() => { calls++; return new Response(feed()); }) });
  await assert.rejects(client.detail({ ...listing, url: 'https://other.invalid/123.htm' }), /valid public Chợ Tốt URL/);
  await assert.rejects(client.detail({ ...listing, url: 'https://www.chotot.com/999.htm' }), /valid public Chợ Tốt URL/);
  assert.equal(calls, 0);
  const result = await clientReturning(feed([ad({ images: ['javascript:alert(1)', 'https://other.invalid/image.jpg', IMAGE, IMAGE] })]))
    .search({ kind: 'laptop', location: 'danang' });
  assert.deepEqual(result.items[0].images, [IMAGE]);
});

test('missing actual listing links fail visibly rather than inventing a canonical URL', async () => {
  const body = html({ adlisting: { data: { ads: [ad()], total: 1 } } });
  await assert.rejects(clientReturning(body).search({ kind: 'laptop', location: 'danang' }), /usable listing links/);
});

test('a valid empty feed is different from a challenge or unsupported source schema', async () => {
  assert.deepEqual(await clientReturning(feed([], 0)).search({ kind: 'gpu', location: 'danang' }), { items: [], total: 0 });
  await assert.rejects(clientReturning('<html>Please verify your browser</html>').search({ kind: 'gpu', location: 'danang' }), /did not provide listing data/);
  await assert.rejects(clientReturning(html({ adlisting: { data: { total: 3 } } })).search({ kind: 'gpu', location: 'danang' }), /unsupported structure/);
  await assert.rejects(clientReturning('<script id="__NEXT_DATA__">not JSON</script>').search({ kind: 'gpu', location: 'danang' }), /invalid embedded/);
  assert.equal((await clientReturning(feed([ad()], 'unreliable count')).search({ kind: 'laptop', location: 'danang' })).total, null);
});

test('429 and 5xx responses may be retried twice, with a bounded final failure', async () => {
  let calls = 0;
  const client = new ChototClient({ pauseMs: 0, fetch: mockFetch(() => {
    calls++;
    return calls < 3 ? new Response('fixture-secret', { status: calls === 1 ? 429 : 503, headers: { 'retry-after': '0' } })
      : new Response(feed());
  }) });
  assert.equal((await client.search({ kind: 'laptop', location: 'danang' })).items.length, 1);
  assert.equal(calls, 3);
  calls = 0;
  const failed = new ChototClient({ pauseMs: 0, fetch: mockFetch(() => {
    calls++;
    return new Response('fixture-secret', { status: 500, headers: { 'retry-after': '0' } });
  }) });
  await assert.rejects(failed.search({ kind: 'laptop', location: 'danang' }), error => {
    assert.match((error as Error).message, /temporarily unavailable \(HTTP 500\)/);
    assert.doesNotMatch((error as Error).message, /fixture-secret/);
    return true;
  });
  assert.equal(calls, 3);
});

test('long server backoff, non-retryable HTTP status, and network failures are not looped', async () => {
  for (const status of [403, 404, 410]) {
    let calls = 0;
    const client = new ChototClient({ pauseMs: 0, fetch: mockFetch(() => {
      calls++;
      return new Response('fixture-secret', { status });
    }) });
    await assert.rejects(client.search({ kind: 'laptop', location: 'danang' }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const rateLimited = new ChototClient({ pauseMs: 0, fetch: mockFetch(() => {
    calls++;
    return new Response('', { status: 429, headers: { 'retry-after': '120' } });
  }) });
  await assert.rejects(rateLimited.search({ kind: 'gpu', location: 'danang' }), /longer rate-limit wait/);
  assert.equal(calls, 1);
  const offline = new ChototClient({ pauseMs: 0, fetch: mockFetch(() => {
    calls++;
    throw new Error('fixture-sensitive-network-detail');
  }) });
  await assert.rejects(offline.search({ kind: 'gpu', location: 'danang' }), /Could not read Chợ Tốt/);
  assert.equal(calls, 2);
});

test('request pacing applies to concurrent calls on the same client', async () => {
  const starts: number[] = [];
  const client = new ChototClient({ pauseMs: 30, fetch: mockFetch(() => {
    starts.push(Date.now());
    return new Response(feed([]));
  }) });
  const requests = Promise.all([
    client.search({ kind: 'gpu', location: 'danang' }),
    client.search({ kind: 'gpu', location: 'nationwide' }),
    client.search({ kind: 'ram', location: 'nationwide' }),
  ]);
  // Expire multiple pre-reserved timer slots together, as can happen under load.
  await new Promise(resolve => setTimeout(resolve, 10));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
  await requests;
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 27);
  assert.ok(starts[2] - starts[1] >= 27);
});

test('cancellation before a queued request prevents that request from being sent', async () => {
  let calls = 0;
  const client = new ChototClient({ pauseMs: 100, fetch: mockFetch(() => { calls++; return new Response(feed([])); }) });
  await client.search({ kind: 'gpu', location: 'danang' });
  const controller = new AbortController();
  const pending = client.search({ kind: 'gpu', location: 'nationwide', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(client.search({ kind: 'gpu', location: 'danang', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('cancellation reaches an in-flight fetch and is not retried', async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = new ChototClient({ pauseMs: 0, fetch: mockFetch((_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      controller.abort();
    });
  }) });
  await assert.rejects(client.search({ kind: 'gpu', location: 'danang', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('oversized source responses fail before parsing or retaining source data', async () => {
  const client = new ChototClient({ pauseMs: 0, fetch: mockFetch(() => new Response('fixture-secret', {
    headers: { 'content-length': String(9 * 1024 * 1024) },
  })) });
  await assert.rejects(client.search({ kind: 'gpu', location: 'danang' }), /unexpectedly large page/);
});

test('unsupported searches and invalid paging fail without sending a request', async () => {
  let calls = 0;
  const client = new ChototClient({ fetch: mockFetch(() => { calls++; return new Response(feed()); }) });
  await assert.rejects(client.search({ kind: 'other', location: 'nationwide' }), /does not support hardware kind/);
  await assert.rejects(client.search({ kind: 'wanted', location: 'nationwide' }), /does not support hardware kind/);
  await assert.rejects(client.search({ kind: 'gpu', location: 'nationwide', page: 0 }), /page must be/);
  await assert.rejects(client.search({ kind: 'gpu', location: 'nationwide', query: 'x'.repeat(201) }), /no longer than 200/);
  assert.equal(calls, 0);
});
