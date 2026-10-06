import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidResult, stallCheck, adaptiveDelay, isNearDrop, sameProduct, sessionAlertsDue } from './monitorPolicy.ts';

const MIN = 60_000;

test('isValidResult', () => {
  assert.equal(isValidResult({ inStock: false, state: 'OUT_OF_STOCK' }), true);
  assert.equal(isValidResult({ inStock: true }), true);
  assert.equal(isValidResult({ state: 'BLOCKED' }), false);
  assert.equal(isValidResult({ rateLimited: true }), false);
  assert.equal(isValidResult({ inStock: false, error: 'HTTP 500' }), false);
  assert.equal(isValidResult(null), false);
});

test('stallCheck: errors in a row, no valid response, stopped tasks ignored', () => {
  const o = { stallMinutes: 5, maxErrorStreak: 10 };
  const now = 100 * MIN;
  assert.equal(stallCheck({ at: now, lastOkAt: now - MIN, firstSeenAt: 0, errorStreak: 0 }, now, o).stalled, false);
  assert.equal(stallCheck({ at: now, lastOkAt: now - MIN, firstSeenAt: 0, errorStreak: 10 }, now, o).stalled, true);
  const r = stallCheck({ at: now, lastOkAt: now - 7 * MIN, firstSeenAt: 0, errorStreak: 3 }, now, o);
  assert.equal(r.stalled, true);
  assert.match(r.why!, /7 min/);
  // never got a valid response since it started 6 min ago
  assert.equal(stallCheck({ at: now, firstSeenAt: now - 6 * MIN, errorStreak: 4 }, now, o).stalled, true);
  // task stopped 20 min ago → not stalled
  assert.equal(stallCheck({ at: now - 20 * MIN, lastOkAt: now - 40 * MIN, firstSeenAt: 0, errorStreak: 50 }, now, o).stalled, false);
});

test('adaptiveDelay: never faster than base, slower when stable, base near a drop', () => {
  const now = 1000 * MIN;
  assert.equal(adaptiveDelay(4000, { now, lastChangeAt: now - MIN }), 4000);
  assert.equal(adaptiveDelay(4000, { now, lastChangeAt: now - 15 * MIN }), 6000);
  assert.equal(adaptiveDelay(4000, { now, lastChangeAt: now - 45 * MIN }), 8000);
  assert.equal(adaptiveDelay(4000, { now, lastChangeAt: now - 300 * MIN }), 12000);
  assert.equal(adaptiveDelay(60000, { now, lastChangeAt: now - 300 * MIN }), 120000); // capped
  assert.equal(adaptiveDelay(200000, { now, lastChangeAt: now - 300 * MIN }), 200000); // never below base
  assert.equal(adaptiveDelay(4000, { now, lastChangeAt: now - 300 * MIN, nearDrop: true }), 4000);
  assert.equal(adaptiveDelay(4000, { now, lastChangeAt: now - 300 * MIN, enabled: false }), 4000);
});

test('isNearDrop matches store + product loosely', () => {
  const now = 500 * MIN;
  const drops = [{ store: 'Target', product: 'https://www.target.com/p/x/-/A-93954446', at: now + 20 * MIN }];
  assert.equal(isNearDrop(drops, 'Target', '93954446', now), true);
  assert.equal(isNearDrop(drops, 'Walmart', '93954446', now), false);
  assert.equal(isNearDrop(drops, 'Target', '93954446', now - 20 * MIN), false); // 40 min before
  assert.equal(sameProduct('10-10037-118', '10-10037-118'), true);
  assert.equal(sameProduct('abc', 'xyz'), false);
});

test('sessionAlertsDue: once per state', () => {
  const list = [
    { store: 'Target', email: 'a', state: 'expiring' },
    { store: 'Target', email: 'b', state: 'expired' },
    { store: 'Target', email: 'c', state: 'active' },
  ];
  assert.deepEqual(sessionAlertsDue(list, {}).map((x) => x.email), ['a', 'b']);
  assert.deepEqual(sessionAlertsDue(list, { 'Target|a': 'expiring' }).map((x) => x.email), ['b']);
  assert.deepEqual(sessionAlertsDue(list, { 'Target|a': 'expiring', 'Target|b': 'expiring' }).map((x) => x.email), ['b']);
});
