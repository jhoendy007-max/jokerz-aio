/**
 * Price / stock history per product, fed by every monitor response
 * (Target, Walmart, Pokémon Center, Bandai). Stored in localStorage.
 *
 * A point is stored only when something changes (price or in/out of stock)
 * or every HEARTBEAT_MS, so a monitor polling every 2 s doesn't fill storage.
 */
export const HISTORY_KEY = 'jokerz_aio_monitor_history';
export const MAX_POINTS = 300;
export const MAX_PRODUCTS = 60;
export const HEARTBEAT_MS = 15 * 60_000;

export interface HistoryPoint {
  t: number;
  price?: number;
  inStock: boolean;
  status: string;
}
export interface ProductHistory {
  key: string;
  store: string;
  product: string;
  title?: string;
  points: HistoryPoint[];
  restocks: number;
  lastSeen: number;
}
export type HistoryMap = Record<string, ProductHistory>;

export function parsePrice(p: unknown): number | undefined {
  if (typeof p === 'number') return Number.isFinite(p) && p > 0 ? p : undefined;
  const m = String(p ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Pure: add one observation to a history map. Returns the same map (mutated) and whether it changed. */
export function addObservation(
  map: HistoryMap,
  o: { store: string; product: string; title?: string; price?: unknown; inStock: boolean; status?: string },
  now = Date.now(),
): boolean {
  const status = String(o.status || (o.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK'));
  // errors / blocks / rate limits say nothing about stock or price
  if (/RATE_LIMITED|BLOCKED|ERROR|DATADOME|UNKNOWN/.test(status) && !o.inStock) return false;
  const key = `${o.store}:${o.product}`;
  let h = map[key];
  if (!h) {
    h = map[key] = { key, store: o.store, product: String(o.product).slice(0, 200), points: [], restocks: 0, lastSeen: now };
  }
  if (o.title) h.title = String(o.title).slice(0, 120);
  h.lastSeen = now;
  const price = parsePrice(o.price);
  const last = h.points[h.points.length - 1];
  const changed = !last || last.inStock !== o.inStock || (price !== undefined && last.price !== price);
  if (!changed && now - last.t < HEARTBEAT_MS) return false;
  if (last && !last.inStock && o.inStock) h.restocks++;
  h.points.push({ t: now, price: price ?? last?.price, inStock: o.inStock, status });
  if (h.points.length > MAX_POINTS) h.points.splice(0, h.points.length - MAX_POINTS);
  // cap number of products (drop least recently seen)
  const keys = Object.keys(map);
  if (keys.length > MAX_PRODUCTS) {
    keys.sort((a, b) => map[a].lastSeen - map[b].lastSeen);
    for (const k of keys.slice(0, keys.length - MAX_PRODUCTS)) delete map[k];
  }
  return true;
}

export function priceStats(h: ProductHistory) {
  const ps = h.points.map((p) => p.price).filter((x): x is number => typeof x === 'number');
  if (!ps.length) return null;
  return { min: Math.min(...ps), max: Math.max(...ps), last: ps[ps.length - 1], first: ps[0] };
}

// ─── storage + subscribe ───
let cache: HistoryMap | null = null;
let version = 0;
const subs = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function loadHistory(): HistoryMap {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(cache || {}));
    } catch {
      /* quota */
    }
  }, 2000);
}

export function recordHistory(o: Parameters<typeof addObservation>[1]) {
  const map = loadHistory();
  if (addObservation(map, o)) {
    version++;
    subs.forEach((f) => f());
    persistSoon();
  }
}

export function clearHistory(key?: string) {
  const map = loadHistory();
  if (key) delete map[key];
  else for (const k of Object.keys(map)) delete map[k];
  version++;
  subs.forEach((f) => f());
  persistSoon();
}

/** Call after a backup import so the in-memory cache re-reads storage. */
export function reloadHistory() {
  cache = null;
  version++;
  subs.forEach((f) => f());
}

export const subscribeHistory = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
export const getHistoryVersion = () => version;
