import test from 'node:test';
import assert from 'node:assert/strict';
import { addObservation, parsePrice, priceStats, HEARTBEAT_MS, type HistoryMap } from './monitorHistory.ts';

test('parsePrice', () => {
  assert.equal(parsePrice('$1,299.99'), 1299.99);
  assert.equal(parsePrice(49.5), 49.5);
  assert.equal(parsePrice(''), undefined);
  assert.equal(parsePrice('N/A'), undefined);
});

test('stores only changes or heartbeat, counts restocks', () => {
  const m: HistoryMap = {};
  const o = { store: 'Target', product: '123', price: '$49.99', inStock: false };
  assert.equal(addObservation(m, o, 0), true);
  assert.equal(addObservation(m, o, 2000), false); // same
  assert.equal(addObservation(m, { ...o, inStock: true }, 4000), true); // restock
  assert.equal(addObservation(m, { ...o, inStock: true, price: '$44.99' }, 6000), true); // price drop
  assert.equal(addObservation(m, { ...o, inStock: true, price: '$44.99' }, 6000 + HEARTBEAT_MS), true); // heartbeat
  const h = m['Target:123'];
  assert.equal(h.points.length, 4);
  assert.equal(h.restocks, 1);
  assert.deepEqual(priceStats(h), { min: 44.99, max: 49.99, last: 44.99, first: 49.99 });
});

test('ignores rate-limit / error observations', () => {
  const m: HistoryMap = {};
  assert.equal(addObservation(m, { store: 'Walmart', product: 'x', inStock: false, status: 'RATE_LIMITED' }, 0), false);
  assert.equal(Object.keys(m).length, 0);
});
