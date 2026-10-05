import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleDrops, dueReminders, formatCountdown, type Drop } from './drops.ts';

const mk = (id: string, at: number, extra: Partial<Drop> = {}): Drop => ({
  id, store: 'Target', title: id, at, remindMin: 10, createdAt: 0, ...extra,
});
const MIN = 60_000;

test('visibleDrops: soonest first, hides drops older than 1h', () => {
  const now = 10 * 60 * MIN;
  const v = visibleDrops([mk('b', now + 5 * MIN), mk('old', now - 61 * MIN), mk('a', now + MIN), mk('live', now - 30 * MIN)], now);
  assert.deepEqual(v.map((d) => d.id), ['live', 'a', 'b']);
});

test('dueReminders: fires inside the window once', () => {
  const now = 1_000 * MIN;
  const list = [
    mk('due', now + 9 * MIN),
    mk('early', now + 11 * MIN),
    mk('done', now + 5 * MIN, { reminded: true }),
    mk('off', now + 1 * MIN, { remindMin: 0 }),
    mk('stale', now - 10 * MIN),
  ];
  assert.deepEqual(dueReminders(list, now).map((d) => d.id), ['due']);
});

test('formatCountdown', () => {
  assert.equal(formatCountdown(0), 'LIVE');
  assert.equal(formatCountdown(65_000), '1m 05s');
  assert.equal(formatCountdown(2 * 3600_000 + 5 * MIN), '2h 5m');
  assert.equal(formatCountdown(26 * 3600_000), '1d 2h 0m');
});
