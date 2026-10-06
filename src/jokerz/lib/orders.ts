/**
 * Order log: every real checkout (from the app) + orders found in your email
 * (confirmation / shipped / delivered / cancelled). Stored in localStorage.
 * Pure helpers take a Storage-like object so they can be tested.
 */
export type OrderStatus = 'placed' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
export const ORDER_STATUSES: OrderStatus[] = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const RANK: Record<OrderStatus, number> = { placed: 0, confirmed: 1, shipped: 2, delivered: 3, cancelled: 4 };

export interface Order {
  id: string;
  t: number;
  store: string;
  orderNumber: string;
  status: OrderStatus;
  account?: string;
  profile?: string;
  product?: string;
  title?: string;
  total?: string;
  quantity?: number;
  source: 'app' | 'email' | 'manual';
  emailSubject?: string;
  updatedAt: number;
  note?: string;
}

export const ORDERS_KEY = 'jokerz_aio_orders';
type St = Pick<Storage, 'getItem' | 'setItem'>;
const ls = (): St => localStorage;

const subs = new Set<() => void>();
let version = 0;
export const subscribeOrders = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
export const getOrdersVersion = () => version;

export function loadOrders(st: St = ls()): Order[] {
  try {
    const v = JSON.parse(st.getItem(ORDERS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((o) => o && o.orderNumber && Number.isFinite(o.t)) : [];
  } catch {
    return [];
  }
}

export function saveOrders(list: Order[], st: St = ls()) {
  try {
    st.setItem(ORDERS_KEY, JSON.stringify(list.sort((a, b) => b.t - a.t).slice(0, 3000)));
  } catch {
    /* quota */
  }
  version++;
  subs.forEach((f) => f());
}

const normNum = (n: string) => String(n || '').trim().toUpperCase().replace(/^#/, '');
const storeKey = (s: string) => String(s || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);
export const orderKey = (store: string, orderNumber: string) => `${storeKey(store)}|${normNum(orderNumber)}`;

/** Pure: merge an incoming order into the list (same store + number → update; status only moves forward, cancel wins). */
export function mergeOrder(list: Order[], incoming: Partial<Order> & { store: string; orderNumber: string }, now = Date.now()): { list: Order[]; added: boolean; changed: boolean } {
  const k = orderKey(incoming.store, incoming.orderNumber);
  const i = list.findIndex((o) => orderKey(o.store, o.orderNumber) === k);
  if (i < 0) {
    const o: Order = {
      id: `o_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      t: incoming.t ?? now,
      store: incoming.store,
      orderNumber: normNum(incoming.orderNumber),
      status: incoming.status || 'placed',
      source: incoming.source || 'app',
      updatedAt: now,
      ...Object.fromEntries(Object.entries(incoming).filter(([key, v]) => v !== undefined && !['store', 'orderNumber', 'status', 'source', 't'].includes(key))),
    };
    return { list: [o, ...list], added: true, changed: true };
  }
  const cur = list[i];
  const next: Order = { ...cur };
  let changed = false;
  if (incoming.status && RANK[incoming.status] > RANK[cur.status]) {
    next.status = incoming.status;
    changed = true;
  }
  for (const f of ['account', 'profile', 'product', 'title', 'total', 'quantity', 'emailSubject'] as const) {
    if (incoming[f] !== undefined && (next as any)[f] === undefined) {
      (next as any)[f] = incoming[f];
      changed = true;
    }
  }
  if (!changed) return { list, added: false, changed: false };
  next.updatedAt = now;
  const out = list.slice();
  out[i] = next;
  return { list: out, added: false, changed: true };
}

export function recordAppOrder(o: { store: string; orderNumber?: string; product?: string; total?: string; quantity?: number; account?: string; profile?: string }, st: St = ls()) {
  if (!o.orderNumber || /^(dry|test|sim)/i.test(o.orderNumber)) return;
  const { list } = mergeOrder(loadOrders(st), { ...o, orderNumber: o.orderNumber, status: 'placed', source: 'app' });
  saveOrders(list, st);
}

export function mergeEmailOrders(found: { store: string; orderNumber: string; status: OrderStatus; total?: string; t: number; subject?: string }[], st: St = ls()) {
  let list = loadOrders(st);
  let added = 0;
  let updated = 0;
  for (const f of found) {
    const r = mergeOrder(list, { store: f.store, orderNumber: f.orderNumber, status: f.status, total: f.total, t: f.t, emailSubject: f.subject, source: 'email' });
    list = r.list;
    if (r.added) added++;
    else if (r.changed) updated++;
  }
  saveOrders(list, st);
  return { added, updated };
}

export function setOrderStatus(id: string, status: OrderStatus, st: St = ls()) {
  saveOrders(
    loadOrders(st).map((o) => (o.id === id ? { ...o, status, updatedAt: Date.now() } : o)),
    st,
  );
}
export function removeOrder(id: string, st: St = ls()) {
  saveOrders(
    loadOrders(st).filter((o) => o.id !== id),
    st,
  );
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function ordersToCsv(list: Order[]) {
  const cols = ['date', 'store', 'orderNumber', 'status', 'total', 'quantity', 'account', 'profile', 'product', 'title', 'source'] as const;
  const rows = list.map((o) => [new Date(o.t).toISOString(), o.store, o.orderNumber, o.status, o.total, o.quantity, o.account, o.profile, o.product, o.title, o.source].map(csvCell).join(','));
  return [cols.join(','), ...rows].join('\n');
}
