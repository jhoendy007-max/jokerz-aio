import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlertDedupe, normalizeProduct } from './alertDedupe.ts';

const P = { store: 'Walmart', product: 'https://www.walmart.com/ip/foo/123456789' };

test('same product from many tasks → one stock alert', () => {
  const d = createAlertDedupe({ cooldownMs: 60_000 });
  assert.equal(d.check('stock', P, 0).send, true);
  assert.equal(d.check('stock', { ...P, product: '123456789' }, 1000).send, false);
  assert.equal(d.check('stock', P, 2000).send, false);
  assert.equal(d.stats().suppressed, 2);
});

test('stock re-alerts after cooldown', () => {
  const d = createAlertDedupe({ cooldownMs: 60_000 });
  d.check('stock', P, 0);
  assert.equal(d.check('stock', P, 61_000).send, true);
});

test('price alerts dedupe on same price, pass on new price', () => {
  const d = createAlertDedupe({ cooldownMs: 60_000 });
  assert.equal(d.check('price', { ...P, price: '$10 → $8' }, 0).send, true);
  assert.equal(d.check('price', { ...P, price: '$10 → $8' }, 10).send, false);
  assert.equal(d.check('price', { ...P, price: '$8 → $9' }, 20).send, true);
});

test('success / ban never suppressed; cooldown 0 disables', () => {
  const d = createAlertDedupe({ cooldownMs: 60_000 });
  assert.equal(d.check('success', P, 0).send, true);
  assert.equal(d.check('success', P, 1).send, true);
  assert.equal(d.check('ban', P, 1).send, true);
  d.check('stock', P, 0, 0);
  assert.equal(d.check('stock', P, 1, 0).send, true);
});

test('different stores / products are independent', () => {
  const d = createAlertDedupe();
  assert.equal(d.check('stock', P, 0).send, true);
  assert.equal(d.check('stock', { store: 'Target', product: 'https://www.target.com/p/x/-/A-12345678' }, 0).send, true);
  assert.equal(normalizeProduct('Target', 'https://www.target.com/p/x/-/A-12345678'), 'target:12345678');
});
