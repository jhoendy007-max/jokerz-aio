/**
 * Pure monitor policies (no imports → unit-testable):
 *  - which results count as "valid"
 *  - stall detection (monitor stuck / chaining errors)
 *  - adaptive poll delay (slower when stable, back to normal near a drop; never faster than your delay)
 */
export const BAD_STATES = new Set(['ERROR', 'BLOCKED', 'RATE_LIMITED', 'NOT_FOUND']);

export function isValidResult(d: any): boolean {
  if (!d || typeof d !== 'object') return false;
  if (d.state && BAD_STATES.has(String(d.state))) return false;
  if (d.rateLimited || d.blocked) return false;
  if (d.error && !d.inStock) return false;
  return true;
}

export interface StallInput {
  at: number; // last result of any kind
  lastOkAt?: number;
  firstSeenAt: number;
  errorStreak: number;
}
export interface StallOpts {
  stallMinutes: number; // no valid result for this long → stalled
  maxErrorStreak: number; // this many errors in a row → stalled
  /** a monitor that sent nothing for this long is considered stopped, not stalled */
  inactiveMinutes?: number;
}

export function stallCheck(e: StallInput, now: number, o: StallOpts): { stalled: boolean; why?: string } {
  const inactiveMs = (o.inactiveMinutes ?? Math.max(10, o.stallMinutes * 3)) * 60_000;
  if (now - e.at > inactiveMs) return { stalled: false }; // task stopped
  if (e.errorStreak >= o.maxErrorStreak) return { stalled: true, why: `${e.errorStreak} errors in a row` };
  const since = e.lastOkAt ?? e.firstSeenAt;
  const mins = Math.floor((now - since) / 60_000);
  if (mins >= o.stallMinutes) return { stalled: true, why: `no valid response for ${mins} min` };
  return { stalled: false };
}

/** Steps: stable 10 min → ×1.5, 30 min → ×2, 2 h → ×3; capped at max(base, 2 min). */
export function adaptiveDelay(base: number, o: { lastChangeAt?: number; now: number; nearDrop?: boolean; enabled?: boolean }): number {
  const b = Math.max(250, Number(base) || 4000);
  if (o.enabled === false || o.nearDrop || !o.lastChangeAt) return b;
  const stable = o.now - o.lastChangeAt;
  const f = stable > 2 * 3600_000 ? 3 : stable > 30 * 60_000 ? 2 : stable > 10 * 60_000 ? 1.5 : 1;
  return Math.round(Math.min(b * f, Math.max(b, 120_000)));
}

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = (s: string) => (String(s || '').match(/\d{5,}/g) || []).join(',');

export function sameStore(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}
export function sameProduct(a: string, b: string) {
  if (!a || !b) return false;
  const da = digits(a);
  const db = digits(b);
  if (da && db) return da.split(',').some((d) => db.split(',').includes(d));
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length > 6 && y.length > 6 && (x.includes(y) || y.includes(x)));
}

/** A scheduled drop for this product starts within -30 min … +15 min of now. */
export function isNearDrop(drops: { store: string; product?: string; at: number }[], store: string, product: string, now: number) {
  return drops.some((d) => d.product && sameStore(d.store, store) && sameProduct(d.product, product) && now >= d.at - 30 * 60_000 && now <= d.at + 15 * 60_000);
}

/** Which account sessions need an alert now (state not alerted yet). `sent` maps "store|email" → last alerted state. */
export function sessionAlertsDue<T extends { store: string; email: string; state: string }>(list: T[], sent: Record<string, string>): T[] {
  return list.filter((a) => (a.state === 'expiring' || a.state === 'expired') && sent[`${a.store}|${a.email}`] !== a.state);
}
