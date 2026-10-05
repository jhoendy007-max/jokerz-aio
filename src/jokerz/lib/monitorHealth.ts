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
};

import { recordHistory } from './monitorHistory';

const state = new Map<string, MonitorHealth>();
const subs = new Set<() => void>();
let version = 0;

export function recordMonitorHealth(store: string, product: string, data: any) {
  if (!data || typeof data !== 'object') return;
  const key = `${store}:${product}`;
  const prev = state.get(key);
  const status = String(data.availabilityStatus || (data.inStock ? 'IN_STOCK' : data.error ? 'ERROR' : 'UNKNOWN'));
  const rateLimited = Boolean(data.rateLimited) || status === 'RATE_LIMITED' || /\b429\b/.test(String(data.error || ''));
  const proxyIgnored = Boolean(data.proxyIgnored);
  state.set(key, {
    key,
    store,
    product: String(product).slice(0, 80),
    status: rateLimited ? 'RATE_LIMITED' : status,
    rateLimited,
    retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
    proxyIgnored,
    blocked: Boolean(data.blocked),
    at: Date.now(),
    rateLimitedCount: (prev?.rateLimitedCount || 0) + (rateLimited ? 1 : 0),
    proxyIgnoredCount: (prev?.proxyIgnoredCount || 0) + (proxyIgnored ? 1 : 0),
  });
  if (!rateLimited && !data.blocked && !(data.error && !data.inStock)) {
    recordHistory({ store, product: String(product), title: data.title, price: data.price, inStock: Boolean(data.inStock), status });
  }
  version++;
  subs.forEach((fn) => fn());
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
