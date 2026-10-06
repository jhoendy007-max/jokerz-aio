/** Pure aggregations for the Results page (checkout log → charts / tables). */
export interface CheckoutLike {
  t: number;
  ok: boolean;
  store: string;
  product: string;
  title?: string;
  price?: string;
  quantity?: number;
  dryRun?: boolean;
  account?: string;
  reason?: string;
}

export const priceOf = (p: unknown) => {
  const n = Number(String(p ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export interface Results {
  total: number;
  success: number;
  failed: number;
  successRate: number; // 0..100
  spend: number;
  items: number;
  byDay: { day: string; success: number; failed: number; spend: number }[];
  byStore: { store: string; success: number; failed: number; spend: number; rate: number }[];
  topProducts: { store: string; product: string; title?: string; success: number; failed: number; spend: number }[];
  topReasons: { reason: string; count: number }[];
}

export function buildResults(log: CheckoutLike[], { days = 30, now = Date.now(), includeDryRuns = false } = {}): Results {
  const from = now - days * 86400_000;
  const list = log.filter((e) => e.t >= from && e.t <= now && (includeDryRuns || !e.dryRun));
  const byDayMap = new Map<string, { day: string; success: number; failed: number; spend: number }>();
  for (let t = from; t <= now; t += 86400_000) byDayMap.set(dayKey(t), { day: dayKey(t), success: 0, failed: 0, spend: 0 });
  byDayMap.set(dayKey(now), byDayMap.get(dayKey(now)) || { day: dayKey(now), success: 0, failed: 0, spend: 0 });
  const stores = new Map<string, { store: string; success: number; failed: number; spend: number; rate: number }>();
  const prods = new Map<string, { store: string; product: string; title?: string; success: number; failed: number; spend: number }>();
  const reasons = new Map<string, number>();
  let success = 0;
  let spend = 0;
  let items = 0;
  for (const e of list) {
    const qty = Math.max(1, Number(e.quantity) || 1);
    const money = e.ok ? priceOf(e.price) * qty : 0;
    const d = byDayMap.get(dayKey(e.t)) || { day: dayKey(e.t), success: 0, failed: 0, spend: 0 };
    const s = stores.get(e.store) || { store: e.store, success: 0, failed: 0, spend: 0, rate: 0 };
    const pk = `${e.store}|${e.product}`;
    const p = prods.get(pk) || { store: e.store, product: e.product, title: e.title, success: 0, failed: 0, spend: 0 };
    if (e.ok) {
      success++;
      spend += money;
      items += qty;
      d.success++;
      s.success++;
      p.success++;
    } else {
      d.failed++;
      s.failed++;
      p.failed++;
      const r = String(e.reason || 'Unknown').replace(/\d{4,}/g, '#').slice(0, 80);
      reasons.set(r, (reasons.get(r) || 0) + 1);
    }
    d.spend += money;
    s.spend += money;
    p.spend += money;
    if (e.title && !p.title) p.title = e.title;
    byDayMap.set(d.day, d);
    stores.set(e.store, s);
    prods.set(pk, p);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    total: list.length,
    success,
    failed: list.length - success,
    successRate: list.length ? Math.round((success / list.length) * 1000) / 10 : 0,
    spend: round(spend),
    items,
    byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, spend: round(d.spend) })),
    byStore: [...stores.values()].map((s) => ({ ...s, spend: round(s.spend), rate: s.success + s.failed ? Math.round((s.success / (s.success + s.failed)) * 100) : 0 })).sort((a, b) => b.success + b.failed - (a.success + a.failed)),
    topProducts: [...prods.values()].map((p) => ({ ...p, spend: round(p.spend) })).sort((a, b) => b.success - a.success || b.failed - a.failed).slice(0, 10),
    topReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 6),
  };
}
