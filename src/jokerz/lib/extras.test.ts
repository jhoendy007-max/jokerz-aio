import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeOrder, ordersToCsv, recordAppOrder, mergeEmailOrders, loadOrders } from './orders.ts';
import { buildResults, priceOf } from './analytics.ts';
import { parseIcs, parseCsv, parseJsonDrops, parseDropsText, dedupeDrops, dueAutoStarts, splitCsvLine } from './dropImport.ts';
import { applyTestResults, isDead, deadProxies } from './proxyHealth.ts';
import { buildAccountHealth } from './accountHealth.ts';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const D = 86400_000;

test('orders: merge by store + number, status only moves forward', () => {
  let { list, added } = mergeOrder([], { store: 'Target', orderNumber: '#9120', status: 'placed', total: '$35' }, 1);
  assert.equal(added, true);
  assert.equal(list[0].orderNumber, '9120');
  ({ list } = mergeOrder(list, { store: 'target', orderNumber: '9120', status: 'shipped' }, 2));
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'shipped');
  const r = mergeOrder(list, { store: 'Target', orderNumber: '9120', status: 'confirmed' }, 3);
  assert.equal(r.changed, false);
  assert.equal(r.list[0].status, 'shipped');
  ({ list } = mergeOrder(list, { store: 'Target', orderNumber: '9120', status: 'cancelled' }, 4));
  assert.equal(list[0].status, 'cancelled');
  assert.match(ordersToCsv(list), /^date,store,orderNumber/);
});

test('orders: app + email flows, dry runs ignored', () => {
  const st = mem();
  recordAppOrder({ store: 'Walmart', orderNumber: '2000123-45678901', total: '$20', account: 'a@b.com' }, st);
  recordAppOrder({ store: 'Walmart', orderNumber: 'DRYRUN-1' }, st);
  const r = mergeEmailOrders([{ store: 'Walmart', orderNumber: '2000123-45678901', status: 'delivered', t: 5 }, { store: 'Target', orderNumber: '777777', status: 'confirmed', t: 6 }], st);
  assert.deepEqual(r, { added: 1, updated: 1 });
  const all = loadOrders(st);
  assert.equal(all.length, 2);
  assert.equal(all.find((o) => o.store === 'Walmart')!.status, 'delivered');
  assert.equal(all.find((o) => o.store === 'Walmart')!.account, 'a@b.com');
});

test('results: totals, rate, spend, by day/store, dry runs excluded', () => {
  const now = 100 * D;
  const log = [
    { t: now - D, ok: true, store: 'Target', product: 'a', price: '$35.00', quantity: 2 },
    { t: now - D, ok: false, store: 'Target', product: 'a', reason: 'Card declined 1234' },
    { t: now - 2 * D, ok: true, store: 'Walmart', product: 'b', price: '20' },
    { t: now - 2 * D, ok: true, store: 'Walmart', product: 'b', price: '20', dryRun: true },
    { t: now - 40 * D, ok: true, store: 'Walmart', product: 'old', price: '99' },
  ];
  const r = buildResults(log, { days: 30, now });
  assert.equal(r.total, 3);
  assert.equal(r.success, 2);
  assert.equal(r.successRate, 66.7);
  assert.equal(r.spend, 90);
  assert.equal(r.items, 3);
  assert.equal(r.byStore[0].store, 'Target');
  assert.equal(r.byStore[0].rate, 50);
  assert.equal(r.topReasons[0].reason, 'Card declined #');
  assert.ok(r.byDay.length >= 30);
  assert.equal(r.byDay.reduce((s, d) => s + d.success, 0), 2);
  assert.equal(buildResults(log, { days: 30, now, includeDryRuns: true }).total, 4);
  assert.equal(priceOf('$1,234.50'), 1234.5);
});

test('drop import: ics, csv, json, dedupe', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Prismatic ETB restock\r\nDTSTART:20261010T140000Z\r\nURL:https://www.target.com/p/x/-/A-93954446\r\nBEGIN:VALARM\r\nTRIGGER:-PT30M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const a = parseIcs(ics);
  assert.equal(a.length, 1);
  assert.equal(a[0].store, 'Target');
  assert.equal(a[0].at, Date.UTC(2026, 9, 10, 14, 0, 0));
  assert.equal(a[0].remindMin, 30);
  const csv = 'store,title,product,date,time,remind\nWalmart,"Booster, box",5056010573,2026-10-12,09:30,10\nPKC,ETB,,2026-10-13,,\nbad,,x,,';
  const b = parseCsv(csv);
  assert.equal(b.length, 2);
  assert.equal(b[0].title, 'Booster, box');
  assert.equal(b[0].at, new Date(2026, 9, 12, 9, 30).getTime());
  assert.equal(b[0].remindMin, 10);
  assert.equal(b[1].store, 'Pokemon Center');
  assert.equal(b[1].remindMin, 15);
  const c = parseJsonDrops('[{"store":"bandai","title":"Figure","at":1790000000000}]');
  assert.equal(c[0].store, 'Bandai');
  assert.equal(parseDropsText(ics).format, 'ics');
  assert.equal(parseDropsText('[]').format, 'json');
  assert.equal(parseDropsText('nope').format, 'unknown');
  assert.equal(dedupeDrops([{ store: 'Target', title: 'prismatic etb restock', at: a[0].at }], [...a, ...b]).length, 2);
  assert.deepEqual(splitCsvLine('a;"b ""c""";d'), ['a', 'b "c"', 'd']);
});

test('drop auto-start timing', () => {
  const at = 1000 * 60_000;
  const list = [
    { id: '1', at, autoStartTaskIds: ['t1'], autoStartMin: 10 },
    { id: '2', at, autoStartTaskIds: ['t2'], autoStartMin: 10, autoStarted: true },
    { id: '3', at, autoStartTaskIds: [] },
  ];
  assert.deepEqual(dueAutoStarts(list, at - 11 * 60_000).map((d) => d.id), []);
  assert.deepEqual(dueAutoStarts(list, at - 9 * 60_000).map((d) => d.id), ['1']);
  assert.deepEqual(dueAutoStarts(list, at + 31 * 60_000).map((d) => d.id), []);
});

test('proxy health: dead after 3 fails in a row, ok resets', () => {
  let m = {};
  for (let i = 0; i < 3; i++) m = applyTestResults(m, [{ proxy: 'p1', ok: false, error: 'Timeout' }, { proxy: 'p2', ok: true, ms: 300, country: 'US' }], i);
  assert.equal(isDead((m as any).p1), true);
  assert.equal(isDead((m as any).p2), false);
  assert.deepEqual(deadProxies(['p1 ', 'p2', 'p3'], m), ['p1 ']);
  m = applyTestResults(m, [{ proxy: 'p1', ok: true, ms: 100 }]);
  assert.equal(isDead((m as any).p1), false);
  assert.equal((m as any).p2.country, 'US');
});

test('account health warnings', () => {
  const now = 100 * D;
  const h = buildAccountHealth(
    [
      { email: 'A@b.com', store: 'Target' },
      { email: 'c@d.com', store: 'Walmart' },
      { email: 'old@x.com', store: 'Target' },
    ],
    [
      { t: now - 5 * D, store: 'target', email: 'a@b.com', ok: true },
      { t: now - D, store: 'target', email: 'a@b.com', ok: false, errorCode: 'WRONG_PASSWORD', friendlyError: 'Wrong email or password' },
      { t: now - 50 * D, store: 'target', email: 'old@x.com', ok: true },
    ],
    [{ t: now - 2 * D, ok: true, store: 'Walmart', account: 'c@d.com' }],
    { now },
  );
  assert.equal(h[0].score, 'bad');
  assert.match(h[0].warnings[0], /out of date/);
  assert.equal(h[1].score, 'good');
  assert.equal(h[1].checkouts, 1);
  assert.match(h[2].warnings[0], /Not used in 50 days/);
});
