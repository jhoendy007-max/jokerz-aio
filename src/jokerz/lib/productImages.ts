/**
 * Product image cache for alerts and the dashboard.
 * Filled from monitor responses (imageUrl) and, when missing, from the local
 * API (/api/product-image), which reads the product page once a day.
 */
import { API_BASE } from '../engine/apiBase';
import { safeImageUrl } from './alertImage';

export { safeImageUrl };

export const IMAGES_KEY = 'jokerz_aio_product_images';
const MAX = 300;
const MISS_RETRY_MS = 30 * 60_000;

type Entry = { url?: string; at: number };
let cache: Record<string, Entry> | null = null;

export const imageKey = (store: string, product: string) =>
  `${String(store || '').toLowerCase().replace(/\s+/g, '')}:${String(product || '').trim().toLowerCase()}`;

function load(): Record<string, Entry> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(IMAGES_KEY) || '{}');
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    cache = {};
  }
  return cache!;
}
function save() {
  const c = load();
  const keys = Object.keys(c);
  if (keys.length > MAX) {
    keys.sort((a, b) => c[a].at - c[b].at);
    for (const k of keys.slice(0, keys.length - MAX)) delete c[k];
  }
  try {
    localStorage.setItem(IMAGES_KEY, JSON.stringify(c));
  } catch {
    /* quota */
  }
}

export function rememberImage(store: string, product: string, url: unknown) {
  const u = safeImageUrl(url);
  if (!u || !product) return;
  const c = load();
  const k = imageKey(store, product);
  if (c[k]?.url === u) return;
  c[k] = { url: u, at: Date.now() };
  save();
}

export function getCachedImage(store: string, product: string): string | undefined {
  return load()[imageKey(store, product)]?.url;
}

const inflight = new Map<string, Promise<string | undefined>>();

/** Cached image, else ask the local API (bounded by timeoutMs). Never throws. */
export async function resolveImage(store: string, product: string, timeoutMs = 4000): Promise<string | undefined> {
  if (!store || !product) return undefined;
  const k = imageKey(store, product);
  const hit = load()[k];
  if (hit?.url) return hit.url;
  if (hit && Date.now() - hit.at < MISS_RETRY_MS) return undefined;
  if (inflight.has(k)) return inflight.get(k);
  const job = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const qs = new URLSearchParams({ store, product });
      const r = await fetch(`${API_BASE}/api/product-image?${qs}`, { signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      const u = safeImageUrl(j?.imageUrl);
      load()[k] = { url: u, at: Date.now() };
      save();
      return u;
    } catch {
      return undefined;
    } finally {
      clearTimeout(t);
      inflight.delete(k);
    }
  })();
  inflight.set(k, job);
  return job;
}
