/**
 * Product image lookup for alerts: reads the product page once and takes the
 * JSON-LD / og:image picture. Cached in memory (24 h hits, 30 min misses) so a
 * product is fetched at most once per day no matter how many alerts fire.
 */
import { fetchText, extractImage } from "./monitor-common.mjs";
import { parseWalmartId } from "./walmart-monitor.mjs";
import { pokemonUrl } from "./pokemon-monitor.mjs";
import { bandaiUrl } from "./bandai-monitor.mjs";

const HIT_TTL = 24 * 3600_000;
const MISS_TTL = 30 * 60_000;
const MAX = 500;
const cache = new Map(); // key → { url, at }
const inflight = new Map();

export function productPage(store, product) {
  const s = String(store || "").toLowerCase();
  const p = String(product || "").trim();
  if (!p) return null;
  if (s.includes("target")) {
    const tcin = (p.match(/A-(\d{6,})/) || [])[1] || p.replace(/\D/g, "");
    return tcin ? `https://www.target.com/p/-/A-${tcin}` : null;
  }
  if (s.includes("walmart")) {
    const id = parseWalmartId(p);
    return id ? `https://www.walmart.com/ip/${id}` : null;
  }
  if (s.includes("pokemon")) return pokemonUrl(p);
  if (s.includes("bandai")) return bandaiUrl(p);
  return /^https:\/\//i.test(p) ? p : null;
}

export async function lookupProductImage({ store, product, proxy, now = Date.now(), fetcher = fetchText } = {}) {
  const page = productPage(store, product);
  if (!page) return { ok: false, error: "Unknown product" };
  const hit = cache.get(page);
  if (hit && now - hit.at < (hit.url ? HIT_TTL : MISS_TTL)) return { ok: Boolean(hit.url), imageUrl: hit.url, cached: true, page };
  if (inflight.has(page)) return inflight.get(page);
  const job = (async () => {
    let url;
    try {
      const r = await fetcher(page, { proxy, timeoutMs: 8000, headers: { Accept: "text/html,application/xhtml+xml" } });
      if (r.status < 400) url = extractImage(r.text, page);
    } catch {
      /* miss */
    }
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(page, { url, at: now });
    return { ok: Boolean(url), imageUrl: url, cached: false, page };
  })();
  inflight.set(page, job);
  try {
    return await job;
  } finally {
    inflight.delete(page);
  }
}

export function _resetImageCache() {
  cache.clear();
}
