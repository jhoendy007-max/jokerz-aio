/**
 * Daily summary: restocks, price changes and checkouts over a time window.
 * Pure builders (no imports) so they can be unit-tested; the scheduler and
 * Discord sending live in dailySummaryRunner.ts.
 */

// ─── checkout log (fed by Engine CHECKOUT_SUCCESS / CHECKOUT_FAILED) ───
export const CHECKOUT_LOG_KEY = 'jokerz_aio_checkout_log';
export const LAST_SUMMARY_KEY = 'jokerz_aio_last_summary';
const LOG_MAX = 500;
const LOG_DAYS = 14;

export interface CheckoutEvent {
  t: number;
  ok: boolean;
  store: string;
  product: string;
  title?: string;
  price?: string;
  quantity?: number;
  orderNumber?: string;
  reason?: string;
  dryRun?: boolean;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const ls = (): Store => localStorage;

export function loadCheckoutLog(store: Store = ls()): CheckoutEvent[] {
  try {
    const v = JSON.parse(store.getItem(CHECKOUT_LOG_KEY) || '[]');
    return Array.isArray(v) ? v.filter((e) => e && Number.isFinite(e.t)) : [];
  } catch {
    return [];
  }
}

export function logCheckout(e: Omit<CheckoutEvent, 't'> & { t?: number }, store: Store = ls()) {
  const now = e.t ?? Date.now();
  const cutoff = now - LOG_DAYS * 86400_000;
  const list = [...loadCheckoutLog(store).filter((x) => x.t >= cutoff), { ...e, t: now }].slice(-LOG_MAX);
  try {
    store.setItem(CHECKOUT_LOG_KEY, JSON.stringify(list));
  } catch {
    /* quota */
  }
}

// ─── summary ───
interface HPoint {
  t: number;
  price?: number;
  inStock: boolean;
}
interface HProduct {
  store: string;
  product: string;
  title?: string;
  points: HPoint[];
}

export interface Restock {
  store: string;
  product: string;
  title?: string;
  at: number;
  price?: number;
  /** minutes it stayed in stock (undefined = still in stock at end of window) */
  minutesInStock?: number;
}
export interface PriceChange {
  store: string;
  product: string;
  title?: string;
  at: number;
  from: number;
  to: number;
  pct: number;
}
export interface Summary {
  from: number;
  to: number;
  restocks: Restock[];
  priceChanges: PriceChange[];
  checkouts: { ok: CheckoutEvent[]; failed: CheckoutEvent[]; dryRuns: number; spent: number; units: number };
  productsWatched: number;
}

export function money(n: number) {
  return `$${n.toFixed(2)}`;
}

export function priceNum(p: unknown): number {
  const m = String(p ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

export function buildSummary(
  history: Record<string, HProduct>,
  log: CheckoutEvent[],
  from: number,
  to: number,
): Summary {
  const restocks: Restock[] = [];
  const priceChanges: PriceChange[] = [];
  let watched = 0;
  for (const h of Object.values(history || {})) {
    const pts = (h.points || []).slice().sort((a, b) => a.t - b.t);
    if (pts.some((p) => p.t >= from && p.t < to)) watched++;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const p = pts[i];
      if (p.t < from || p.t >= to) continue;
      if (!prev.inStock && p.inStock) {
        const out = pts.slice(i + 1).find((x) => !x.inStock);
        restocks.push({
          store: h.store,
          product: h.product,
          title: h.title,
          at: p.t,
          price: p.price,
          minutesInStock: out && out.t < to ? Math.max(1, Math.round((out.t - p.t) / 60_000)) : undefined,
        });
      }
      if (typeof p.price === 'number' && typeof prev.price === 'number' && p.price !== prev.price) {
        priceChanges.push({
          store: h.store,
          product: h.product,
          title: h.title,
          at: p.t,
          from: prev.price,
          to: p.price,
          pct: Math.round(((p.price - prev.price) / prev.price) * 1000) / 10,
        });
      }
    }
  }
  const inWin = (log || []).filter((e) => e.t >= from && e.t < to);
  const ok = inWin.filter((e) => e.ok && !e.dryRun);
  const failed = inWin.filter((e) => !e.ok);
  const dryRuns = inWin.filter((e) => e.ok && e.dryRun).length;
  const units = ok.reduce((s, e) => s + (Number(e.quantity) || 1), 0);
  const spent = ok.reduce((s, e) => s + priceNum(e.price) * (Number(e.quantity) || 1), 0);
  restocks.sort((a, b) => a.at - b.at);
  // biggest drops first, then rises
  priceChanges.sort((a, b) => a.pct - b.pct);
  return { from, to, restocks, priceChanges, checkouts: { ok, failed, dryRuns, spent, units }, productsWatched: watched };
}

export function isEmpty(s: Summary) {
  return !s.restocks.length && !s.priceChanges.length && !s.checkouts.ok.length && !s.checkouts.failed.length && !s.checkouts.dryRuns;
}

// ─── Discord formatting ───
const name = (x: { title?: string; product: string }) => trunc(x.title || x.product, 60);
function trunc(s: string, n: number) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const hhmm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function listBlock<T>(items: T[], line: (x: T) => string, max = 12) {
  const lines = items.slice(0, max).map(line);
  if (items.length > max) lines.push(`…and ${items.length - max} more`);
  let out = lines.join('\n');
  if (out.length > 1000) out = out.slice(0, 990) + '\n…';
  return out || '—';
}

/** Discord webhook body (embeds) for a summary. */
export function summaryToDiscord(s: Summary, opts: { label?: string } = {}) {
  const c = s.checkouts;
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Restocks', value: String(s.restocks.length), inline: true },
    { name: 'Price changes', value: String(s.priceChanges.length), inline: true },
    { name: 'Checkouts', value: `${c.ok.length} ok · ${c.failed.length} failed`, inline: true },
  ];
  if (c.ok.length) fields.push({ name: 'Spent', value: `${money(c.spent)} · ${c.units} unit${c.units === 1 ? '' : 's'}`, inline: true });
  if (c.dryRuns) fields.push({ name: 'Dry runs', value: String(c.dryRuns), inline: true });
  fields.push({ name: 'Products watched', value: String(s.productsWatched), inline: true });

  if (s.restocks.length) {
    fields.push({
      name: '🟢 Restocks',
      value: listBlock(
        s.restocks,
        (r) =>
          `\`${hhmm(r.at)}\` **${name(r)}** · ${r.store}${typeof r.price === 'number' ? ` · ${money(r.price)}` : ''}${
            r.minutesInStock ? ` · lasted ${r.minutesInStock < 60 ? `${r.minutesInStock} min` : `${Math.round(r.minutesInStock / 6) / 10} h`}` : ' · still in stock'
          }`,
      ),
    });
  }
  if (s.priceChanges.length) {
    fields.push({
      name: '💲 Price changes',
      value: listBlock(
        s.priceChanges,
        (p) => `${p.to < p.from ? '🔻' : '🔺'} **${name(p)}** · ${p.store} · ${money(p.from)} → ${money(p.to)} (${p.pct > 0 ? '+' : ''}${p.pct}%)`,
      ),
    });
  }
  if (c.ok.length) {
    fields.push({
      name: '✅ Checkouts',
      value: listBlock(
        c.ok,
        (e) => `\`${hhmm(e.t)}\` **${name(e)}** · ${e.store}${e.price ? ` · ${e.price}` : ''}${(e.quantity || 1) > 1 ? ` ×${e.quantity}` : ''}${
          e.orderNumber && e.orderNumber !== '—' ? ` · #${trunc(e.orderNumber, 24)}` : ''
        }`,
      ),
    });
  }
  if (c.failed.length) {
    fields.push({
      name: '❌ Failed checkouts',
      value: listBlock(c.failed, (e) => `\`${hhmm(e.t)}\` **${name(e)}** · ${e.store}${e.reason ? ` · ${trunc(e.reason, 60)}` : ''}`, 8),
    });
  }
  const day = new Date(s.to - 1).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  return {
    username: 'JOKERZ AIO',
    embeds: [
      {
        title: `📊 Daily summary · ${opts.label || day}`,
        description: isEmpty(s)
          ? 'Quiet day — no restocks, price changes or checkouts.'
          : `${new Date(s.from).toLocaleString()} → ${new Date(s.to).toLocaleString()}`,
        color: c.ok.length ? 0x00ff41 : s.restocks.length ? 0x7b2cbf : 0x555555,
        fields: fields.slice(0, 25),
        footer: { text: 'JOKERZ AIO · daily summary' },
        timestamp: new Date(s.to).toISOString(),
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };
}

// ─── schedule math ───
/** "21:00" → today's timestamp at that local time. */
export function slotToday(time: string, now = Date.now()) {
  const [h, m] = String(time || '21:00').split(':').map((x) => Number(x));
  const d = new Date(now);
  d.setHours(Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 21, Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0, 0, 0);
  return d.getTime();
}
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Which summary is due now, if any. Sends today's once the time has passed;
 * if the app was closed at that time, it is sent the next time the app is open
 * (up to ~24 h late) instead of being skipped.
 */
/** Day key of the most recent slot that has already passed. */
export function lastSlotDay(time: string, now = Date.now()) {
  const today = slotToday(time, now);
  return dayKey(now >= today ? today : today - 86400_000);
}

export function dueSummary(time: string, lastSentDay: string | null, now = Date.now()): { from: number; to: number; day: string } | null {
  const today = slotToday(time, now);
  const slot = now >= today ? today : today - 86400_000; // most recent slot that has passed
  const day = dayKey(slot);
  if (lastSentDay === day) return null;
  // first run ever: don't fire for a slot that passed long ago
  if (!lastSentDay && now - slot > 60 * 60_000) return null;
  return { from: slot - 86400_000, to: slot, day };
}
