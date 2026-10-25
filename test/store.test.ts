import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { Store, assessmentHash } from '../server/store.ts';
import { raw, assessment } from './helpers.ts';
import { buildReference } from '../server/pricing.ts';
import { enrichComputerAssessment } from '../server/computer.ts';
import { assessWithRules } from '../server/hardware.ts';
import { DEFAULT_SETTINGS } from '../server/config.ts';

test('the former 100-listing default upgrades once while explicit later defaults and worker counts persist', () => {
  const Database = ('Database' in sqlite ? sqlite.Database : sqlite.DatabaseSync) as typeof sqlite.DatabaseSync;
  for (const [previous, expected] of [[100, 200], [80, 80]]) {
    const directory = mkdtempSync(join(tmpdir(), 'flipper-default-upgrade-'));
    const original = { ...DEFAULT_SETTINGS, scanLimit: previous!, marketplaceWorkers: 8, aiWorkers: 8, aiBudgetUsd: .15 };
    const db = new Database(join(directory, 'flipper.sqlite'));
    db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY, json TEXT NOT NULL)');
    db.prepare('INSERT INTO settings(id,json) VALUES(1,?)').run(JSON.stringify(original));
    db.close();
    let store = new Store(directory);
    try {
      assert.deepEqual(store.getSettings(), { ...original, scanLimit: expected });
      store.saveSettings({ ...store.getSettings(), scanLimit: 100 });
      store.close(); store = new Store(directory);
      assert.deepEqual(store.getSettings(), { ...original, scanLimit: 100 });
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('history records price changes, query snapshots and saved state survive restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-store-'));
  try {
    let store = new Store(directory);
    store.putListing(raw('one', 5_000_000), assessment(), true);
    store.setCollection('gpu', 'rtx 3060', ['one']);
    store.setState('one', { saved: true, costReserve: 300_000 });
    store.putListing(raw('one', 5_000_000), assessment(), true);
    store.putListing(raw('one', 4_000_000), assessment(), true);
    assert.equal(store.history('one').length, 2); store.close();
    store = new Store(directory);
    assert.equal(store.getListing('one')?.state.saved, true);
    assert.equal(store.getListing('one')?.state.costReserve, 300_000);
    assert.equal(store.localListings('gpu', 'rtx 3060').length, 1);
    assert.equal(store.localListings('gpu', 'uncollected').length, 0);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('memory defaults and saved-search selections survive restart independently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-memory-settings-'));
  let store = new Store(directory);
  try {
    assert.equal(store.getSettings().minRamGb, 16);
    assert.equal(store.getSettings().minVramGb, 8);
    assert.equal(store.getSettings().includeUnknownMemory, true);
    store.saveSettings({ ...store.getSettings(), minRamGb: 32, minVramGb: 12, includeUnknownMemory: false });
    const search = store.saveSearch({ name: 'Broad search', category: 'desktop', query: '', district: '', mode: 'buy',
      minRamGb: 0, minVramGb: 0, includeUnknownMemory: true });
    store.close();
    store = new Store(directory);
    assert.equal(store.getSettings().minRamGb, 32);
    assert.equal(store.getSettings().minVramGb, 12);
    assert.equal(store.getSettings().includeUnknownMemory, false);
    const restored = store.searches().find((item) => item.id === search.id)!;
    assert.equal(restored.minRamGb, 0);
    assert.equal(restored.minVramGb, 0);
    assert.equal(restored.includeUnknownMemory, true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('updated assessment contracts bypass old cached interpretations and retain listing state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-assessment-cache-'));
  let store = new Store(directory);
  try {
    const listing = raw('cached', 3_200_000);
    const old = { ...assessment(), method: 'ai' as const, eligibility: 'review' as const,
      unknowns: ['No CPU model stated for a standalone GPU'] };
    store.putListing(listing, old, true);
    store.setState(listing.id, { saved: true, costReserve: 300_000 });
    store.close();
    const Database = ('Database' in sqlite ? sqlite.Database : sqlite.DatabaseSync) as typeof sqlite.DatabaseSync;
    const db = new Database(join(directory, 'flipper.sqlite'));
    try {
      db.prepare('INSERT INTO assessments(hash,json,at) VALUES(?,?,?)')
        .run(assessmentHash(listing), JSON.stringify(old), new Date().toISOString());
    } finally { db.close(); }
    store = new Store(directory);
    assert.equal(store.cachedAssessment(listing), null);
    assert.equal(store.getListing(listing.id)?.state.saved, true);
    assert.equal(store.getListing(listing.id)?.state.costReserve, 300_000);
    const current = { ...assessment(), method: 'ai' as const };
    store.cacheAssessment(listing, current);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.cachedAssessment(listing), current);
    assert.equal(store.cachedAssessment({ ...listing, price: listing.price + 1 }), null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('base hardware interpretation changes invalidate prices without changing history or user state', () => {
  const store = new Store('', true);
  const listing = raw('base-metadata', 10_000_000, { category: 'desktop',
    title: 'PC i5-12400 RAM32GB DDR4 RTX3070 8GB SSD512GB NVMe', description: 'Máy hoạt động tốt, chưa sửa chữa' });
  const interpreted = enrichComputerAssessment(listing, assessWithRules(listing));
  try {
    store.putListing(listing, interpreted, true);
    store.setState(listing.id, { saved: true, costReserve: 300_000 });
    const peers = Array.from({ length: 5 }, (_, i) => ({ raw: { ...listing, id: `peer-${i}`, sellerId: `peer-seller-${i}` }, assessment: interpreted }));
    const reference = buildReference(listing, interpreted, peers, store.getSettings()).reference;
    assert.ok(reference);
    store.setReference(listing.id, reference, 'Five comparable PCs');
    const changed = { ...interpreted, computer: { ...interpreted.computer!, psu: 'Seller-sourced 650W PSU',
      missing: interpreted.computer!.missing.filter((field) => !/PSU/i.test(field)) } };
    const updated = store.putListing(listing, changed, true);
    assert.equal(updated.reference, null);
    assert.equal(updated.state.saved, true);
    assert.equal(updated.state.costReserve, 300_000);
    assert.equal(store.history(listing.id).length, 1);
  } finally { store.close(); }
});

test('a memory-type catalog revision invalidates prices without changing the stated profile, history or saved state', () => {
  const store = new Store('', true);
  const listing = raw('memory-catalog-revision', 4_000_000);
  const interpreted = assessment({ gpuMemoryType: 'GDDR6' }, { method: 'ai', memoryTypeSources: [{
    field: 'gpuMemoryType', value: 'GDDR6', part: 'NVIDIA GeForce RTX 3060',
    url: 'https://www.nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3060-3060ti/', catalogVersion: 'fixture-v1',
  }] });
  try {
    store.putListing(listing, interpreted, true);
    store.setState(listing.id, { saved: true });
    const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`catalog-peer-${i}`, 6_000_000), assessment: interpreted }));
    const reference = buildReference(listing, interpreted, peers, store.getSettings()).reference;
    assert.ok(reference);
    store.setReference(listing.id, reference, 'Five comparable GPUs');
    const changed = { ...interpreted, memoryTypeSources: interpreted.memoryTypeSources!.map((source) => ({ ...source, catalogVersion: 'fixture-v2' })) };
    const updated = store.putListing(listing, changed, true);
    assert.deepEqual(updated.assessment.profile, interpreted.profile);
    assert.equal(updated.reference, null);
    assert.equal(updated.state.saved, true);
    assert.equal(store.history(listing.id).length, 1);
  } finally { store.close(); }
});

test('LiteLLM credentials use environment precedence and never reuse an old upstream OpenRouter key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'flipper-credentials-'));
  const originalGatewayKey = process.env.LITELLM_API_KEY;
  const originalUpstreamKey = process.env.OPENROUTER_API_KEY;
  const store = new Store(directory);
  try {
    delete process.env.LITELLM_API_KEY;
    process.env.OPENROUTER_API_KEY = 'legacy-upstream-env';
    writeFileSync(join(directory, 'secrets.json'), JSON.stringify({ openRouterKey: 'legacy-upstream-saved' }));
    assert.equal(store.getKey(), '');
    store.saveKey(' local-gateway-key ');
    assert.equal(store.getKey(), 'local-gateway-key');
    assert.equal(JSON.parse(readFileSync(join(directory, 'secrets.json'), 'utf8')).openRouterKey, 'legacy-upstream-saved');
    assert.equal(statSync(join(directory, 'secrets.json')).mode & 0o777, 0o600);
    process.env.LITELLM_API_KEY = ' environment-gateway-key ';
    assert.equal(store.getKey(), 'environment-gateway-key');
    store.saveKey('');
    assert.equal(store.getKey(), 'environment-gateway-key');
    delete process.env.LITELLM_API_KEY;
    assert.equal(store.getKey(), '');
  } finally {
    if (originalGatewayKey === undefined) delete process.env.LITELLM_API_KEY; else process.env.LITELLM_API_KEY = originalGatewayKey;
    if (originalUpstreamKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalUpstreamKey;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
