/**
 * Live health of stock monitors (per store + product), fed by engine modules
 * from the server's /api/monitor/* responses. In-memory + subscribe for the Dashboard.
 */
export type MonitorHealth = {
  key: string;
  store: string;
  product: string;
  status: string; // availabilityStatus from server (IN_STOCK, OUT_OF_STOCK, RATE_LIMITED, …)
  rateLimited: boolean;
  retryAfterMs?: number;
  proxyIgnored: boolean;
  blocked: boolean;
  at: number;
  rateLimitedCount: number;
  proxyIgnoredCount: number;
  /** Normalized state (IN_STOCK, OUT_OF_STOCK, QUEUE, BLOCKED, RATE_LIMITED, NOT_FOUND, ERROR, UNKNOWN) */
  state: string;
  /** Human explanation of the state */
  reason?: string;
  title?: string;
  price?: string;
  inStock: boolean;
  firstSeenAt: number;
  /** last result that was not an error / block / rate limit */
  lastOkAt?: number;
  /** last time stock or price changed */
  lastChangeAt?: number;
  errorStreak: number;
  lastError?: string;
  /** set by the watchdog */
  stalled?: boolean;
  stalledWhy?: string;
};

import { recordHistory } from './monitorHistory';
import { rememberImage } from './productImages';
import { isValidResult, adaptiveDelay, isNearDrop } from './monitorPolicy';
import { loadDrops } from './drops';

const state = new Map<string, MonitorHealth>();
const subs = new Set<() => void>();
let version = 0;

export function recordMonitorHealth(store: string, product: string, data: any) {
  if (!data || typeof data !== 'object') return;
  if (data.imageUrl) rememberImage(store, String(product), data.imageUrl);
  const key = `${store}:${product}`;
  const prev = state.get(key);
  const status = String(data.availabilityStatus || (data.inStock ? 'IN_STOCK' : data.error ? 'ERROR' : 'UNKNOWN'));
  const rateLimited = Boolean(data.rateLimited) || status === 'RATE_LIMITED' || /\b429\b/.test(String(data.error || ''));
  const proxyIgnored = Boolean(data.proxyIgnored);
  const now = Date.now();
  const ok = isValidResult(data);
  const inStock = Boolean(data.inStock);
  const price = data.price ? String(data.price) : prev?.price;
  const changed = !prev || prev.inStock !== inStock || (data.price && prev.price && String(data.price) !== prev.price);
  const normState = String(
    data.state ||
      (rateLimited ? 'RATE_LIMITED' : data.blocked ? 'BLOCKED' : data.error && !inStock ? 'ERROR' : inStock ? 'IN_STOCK' : data.inQueue ? 'QUEUE' : status),
  );
  state.set(key, {
    key,
    store,
    product: String(product).slice(0, 80),
    status: rateLimited ? 'RATE_LIMITED' : status,
    rateLimited,
    retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
    proxyIgnored,
    blocked: Boolean(data.blocked),
    at: now,
    rateLimitedCount: (prev?.rateLimitedCount || 0) + (rateLimited ? 1 : 0),
    proxyIgnoredCount: (prev?.proxyIgnoredCount || 0) + (proxyIgnored ? 1 : 0),
    state: normState,
    reason: data.reason || (data.error ? String(data.error).slice(0, 160) : prev && ok ? undefined : prev?.reason),
    title: data.title || prev?.title,
    price,
    inStock: ok ? inStock : Boolean(prev?.inStock),
    firstSeenAt: prev?.firstSeenAt ?? now,
    lastOkAt: ok ? now : prev?.lastOkAt,
    lastChangeAt: ok && changed ? now : prev?.lastChangeAt ?? now,
    errorStreak: ok ? 0 : (prev?.errorStreak || 0) + 1,
    lastError: ok ? prev?.lastError : String(data.error || data.reason || normState).slice(0, 200),
    stalled: ok ? false : prev?.stalled,
    stalledWhy: ok ? undefined : prev?.stalledWhy,
  });
  if (!rateLimited && !data.blocked && !(data.error && !data.inStock)) {
    recordHistory({ store, product: String(product), title: data.title, price: data.price, inStock: Boolean(data.inStock), status });
  }
  version++;
  subs.forEach((fn) => fn());
}

/** Watchdog flags. */
export function setMonitorStalled(key: string, stalled: boolean, why?: string) {
  const e = state.get(key);
  if (!e || (e.stalled === stalled && e.stalledWhy === why)) return;
  state.set(key, { ...e, stalled, stalledWhy: why });
  version++;
  subs.forEach((fn) => fn());
}

/**
 * Poll delay for the next monitor tick: your delay when things are changing or a
 * scheduled drop is close, slower when the product has been stable for a while.
 * Never faster than your configured delay. Off with Settings → adaptivePolling = false.
 */
export function adaptivePollDelay(store: string, product: string, base: number): number {
  let enabled = true;
  try {
    const s = JSON.parse(localStorage.getItem('jokerz_aio_settings') || '{}');
    enabled = s.adaptivePolling !== false;
  } catch {
    /* */
  }
  const e = state.get(`${store}:${product}`);
  const now = Date.now();
  let near = false;
  try {
    near = isNearDrop(loadDrops(), store, String(product), now);
  } catch {
    /* */
  }
  return adaptiveDelay(base, { lastChangeAt: e?.lastChangeAt, now, nearDrop: near, enabled });
}

export function getMonitorHealth(): MonitorHealth[] {
  return [...state.values()].sort((a, b) => b.at - a.at);
}
export function getMonitorHealthVersion() {
  return version;
}
export function subscribeMonitorHealth(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
export function clearMonitorHealth() {
  state.clear();
  version++;
  subs.forEach((fn) => fn());
}
