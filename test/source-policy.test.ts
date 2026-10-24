import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { SourceDeferredError, SOURCE_WINDOW_MS } from '../server/source-policy.ts';
import { raw } from './helpers.ts';

test('rolling marketplace allowance reserves fifty manual attempts and bounds each automatic category', () => {
  const store = new Store('', true), now = new Date('2026-10-24T07:00:00Z');
  try {
    for (const category of ['laptop', 'desktop', 'gpu'] as const) {
      for (let i = 0; i < 150; i++) assert.equal(store.reserveSourceRequest(category, true, now, 0), null);
      assert.throws(() => store.reserveSourceRequest(category, true, now, 0), error =>
        error instanceof SourceDeferredError && error.until === '2026-10-25T07:00:00.000Z');
    }
    assert.equal(store.sourceBudgetStatus(now).remaining, 50);
    for (let i = 0; i < 50; i++) store.reserveSourceRequest('desktop', false, now, 0);
    assert.throws(() => store.reserveSourceRequest('gpu', false, now, 0), SourceDeferredError);
    assert.deepEqual(store.sourceBudgetStatus(now).categoryUsed, { laptop: 150, desktop: 150, gpu: 150 });
    assert.equal(store.sourceBudgetStatus(now).used, 500);
    assert.equal(store.sourceBudgetStatus(now).manualUsed, 50);
    assert.equal(store.reserveSourceRequest('gpu', true, new Date(now.getTime() + SOURCE_WINDOW_MS), 0), null);
    assert.equal(store.sourceBudgetStatus(new Date(now.getTime() + SOURCE_WINDOW_MS)).used, 1);
  } finally { store.close(); }
});

test('actual attempts and pacing survive restart and are shared by SQLite connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-source-ledger-'));
  let store = new Store(directory), other: Store | undefined;
  const now = new Date('2026-10-24T07:00:00Z');
  try {
    assert.equal(store.reserveSourceRequest('gpu', false, now), null);
    store.close(); store = new Store(directory); other = new Store(directory);
    assert.equal(other.reserveSourceRequest('laptop', true, new Date(now.getTime() + 2_999)), '2026-10-24T07:00:03.000Z');
    assert.equal(store.sourceBudgetStatus(now).used, 1, 'waiting for dispatch consumes no attempt');
    assert.equal(other.reserveSourceRequest('laptop', true, new Date(now.getTime() + 3_000)), null);
    for (let i = 0; i < 498; i++) (i % 2 ? store : other).reserveSourceRequest('desktop', false, new Date(now.getTime() + 6_000), 0);
    assert.throws(() => store.reserveSourceRequest('gpu', false, new Date(now.getTime() + 6_000), 0), SourceDeferredError);
    assert.equal(other.sourceBudgetStatus(now).used, 500, 'failed or abandoned dispatch reservations stay charged');
  } finally { other?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('saving cached pool progress cannot renew the original observations', () => {
  const store = new Store('', true), old = raw('stale-pool', 6_000_000, { observedAt: new Date(Date.now() - SOURCE_WINDOW_MS - 1).toISOString() });
  try {
    store.putPool('stale', [old]);
    store.savePoolProgress('stale', { raws: [old], nextPage: 2, exhausted: false, detailedIds: [] });
    assert.equal(store.getPool('stale', SOURCE_WINDOW_MS), null);
    assert.equal(store.poolProgress('stale', SOURCE_WINDOW_MS), null);
  } finally { store.close(); }
});
