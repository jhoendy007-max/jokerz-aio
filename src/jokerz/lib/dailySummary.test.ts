import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, summaryToDiscord, dueSummary, lastSlotDay, slotToday, logCheckout, loadCheckoutLog, isEmpty } from './dailySummary.ts';

const H = 3600_000;
const T0 = new Date(2026, 9, 6, 21, 0, 0).getTime(); // Oct 6 21:00 local
const from = T0 - 24 * H;

const history = {
  'Target:1': {
    store: 'Target', product: '1', title: 'ETB',
    points: [
      { t: from - H, price: 49.99, inStock: false },
      { t: from + 2 * H, price: 49.99, inStock: true }, // restock
      { t: from + 2 * H + 30 * 60_000, price: 49.99, inStock: false }, // lasted 30 min
      { t: from + 5 * H, price: 39.99, inStock: false }, // price drop
    ],
  },
  'Walmart:2': {
    store: 'Walmart', product: '2',
    points: [
      { t: from - 3 * H, price: 20, inStock: false }, // before window
      { t: from + 20 * H, price: 22, inStock: true }, // restock + rise, still in stock
    ],
  },
  'Old:3': { store: 'Bandai', product: '3', points: [{ t: from - 50 * H, inStock: false }, { t: from - 40 * H, inStock: true }] },
};
const log = [
  { t: from + H, ok: true, store: 'Target', product: '1', price: '$49.99', quantity: 2, orderNumber: '9001' },
  { t: from + 2 * H, ok: true, store: 'Target', product: '1', price: '$49.99', dryRun: true },
  { t: from + 3 * H, ok: false, store: 'Walmart', product: '2', reason: 'Payment failed' },
  { t: from - H, ok: true, store: 'Target', product: '1', price: '$10' }, // outside
];

test('buildSummary: restocks, price changes, checkouts', () => {
  const s = buildSummary(history as any, log as any, from, T0);
  assert.equal(s.restocks.length, 2);
  assert.equal(s.restocks[0].minutesInStock, 30);
  assert.equal(s.restocks[1].minutesInStock, undefined);
  assert.equal(s.priceChanges.length, 2);
  assert.deepEqual([s.priceChanges[0].from, s.priceChanges[0].to, s.priceChanges[0].pct], [49.99, 39.99, -20]);
  assert.equal(s.priceChanges[1].pct, 10);
  assert.equal(s.checkouts.ok.length, 1);
  assert.equal(s.checkouts.failed.length, 1);
  assert.equal(s.checkouts.dryRuns, 1);
  assert.equal(s.checkouts.units, 2);
  assert.equal(Math.round(s.checkouts.spent * 100), 9998);
  assert.equal(s.productsWatched, 2);
});

test('summaryToDiscord: one embed, sections present, within limits', () => {
  const body = summaryToDiscord(buildSummary(history as any, log as any, from, T0));
  const e = body.embeds[0];
  const names = e.fields.map((f) => f.name);
  for (const n of ['🟢 Restocks', '💲 Price changes', '✅ Checkouts', '❌ Failed checkouts']) assert.ok(names.includes(n), n);
  assert.ok(e.fields.every((f) => f.value.length <= 1024));
  assert.ok(JSON.stringify(body).includes('$49.99 → $39.99 (-20%)'));
  assert.ok(JSON.stringify(body).includes('lasted 30 min'));
  assert.deepEqual(body.allowed_mentions.parse, []);
});

test('empty day', () => {
  const s = buildSummary({}, [], from, T0);
  assert.equal(isEmpty(s), true);
  assert.match(summaryToDiscord(s).embeds[0].description, /Quiet day/);
});

test('dueSummary: once per day, catch-up, first-run guard', () => {
  const day = lastSlotDay('21:00', T0 + 1000);
  assert.equal(slotToday('21:00', T0 - 5 * H), T0);
  const d = dueSummary('21:00', 'x', T0 + 1000)!;
  assert.deepEqual([d.from, d.to, d.day], [from, T0, day]);
  assert.equal(dueSummary('21:00', day, T0 + 2 * H), null); // already sent
  assert.equal(dueSummary('21:00', null, T0 + 3 * H), null); // first run, long after slot
  assert.ok(dueSummary('21:00', null, T0 + 10 * 60_000)); // first run, just after slot
  // app opened next morning before 21:00 → yesterday's slot still sent once
  const late = dueSummary('21:00', 'older', T0 + 12 * H)!;
  assert.equal(late.to, T0);
});

test('checkout log keeps 90 days', () => {
  const m = new Map<string, string>();
  const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  logCheckout({ ok: true, store: 'T', product: 'a', t: 0 }, st);
  logCheckout({ ok: true, store: 'T', product: 'b', t: 91 * 24 * H }, st);
  assert.deepEqual(loadCheckoutLog(st).map((e) => e.product), ['b']);
});
