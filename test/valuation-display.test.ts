import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceLabel } from '../client/valuation.ts';
import { valueListing, buildReference } from '../server/pricing.ts';
import { DEFAULT_SETTINGS } from '../server/config.ts';
import { EMPTY_STATE } from '../server/store.ts';
import { assessment, raw } from './helpers.ts';

test('uncompared, sparse, stale and unverified prices have different user-facing explanations', () => {
  const item = raw('display', 4_000_000), a = assessment();
  const peers = Array.from({ length: 5 }, (_, i) => ({ raw: raw(`display-peer-${i}`, 6_000_000), assessment: a }));
  const ref = buildReference(item, a, peers, DEFAULT_SETTINGS).reference!;
  assert.equal(evidenceLabel(valueListing(item, a, null, DEFAULT_SETTINGS, EMPTY_STATE)), 'Not compared yet');
  assert.equal(evidenceLabel(valueListing(item, a, null, DEFAULT_SETTINGS, EMPTY_STATE,
    'Only 1 independent matching offers after filtering')), 'Too few matching offers');
  assert.equal(evidenceLabel(valueListing({ ...item, observedAt: '2020-01-01T00:00:00Z' }, a, ref, DEFAULT_SETTINGS, EMPTY_STATE)), 'Asking price out of date');
  assert.equal(evidenceLabel(valueListing(item, a, { ...ref, policyVersion: 0 }, DEFAULT_SETTINGS, EMPTY_STATE)), 'Comparison needs refreshing');
  const stale = { ...ref, offers: ref.offers.map(offer => ({ ...offer, observedAt: '2020-01-01T00:00:00Z' })) };
  assert.equal(evidenceLabel(valueListing(item, a, stale, DEFAULT_SETTINGS, EMPTY_STATE)), 'Comparison out of date');
  assert.equal(evidenceLabel(valueListing({ ...item, price: 10_000 }, a, ref, DEFAULT_SETTINGS, EMPTY_STATE)), 'Verify the asking price');
  assert.equal(evidenceLabel(valueListing(item, a, { ...ref, sampleCount: 3 }, DEFAULT_SETTINGS, EMPTY_STATE)), 'Indicative only');
});
