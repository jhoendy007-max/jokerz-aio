/**
 * Shared helpers for stock monitors (walmart / pokemon / bandai).
 * - one proxy-string parser instead of 4 copies
 * - ProxyAgent cached per proxy (avoids leaking a new connection pool per request)
 * - honest reporting when a proxy was requested but could not be used
 * - Retry-After parsing so 429s back off instead of hammering
 * - JSON-LD Product parsing (price / availability / name) before regex fallbacks
 */
export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function proxyUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  const p = raw.trim();
  if (!p || p === "direct" || p === "localhost") return null;
  if (/^https?:\/\//i.test(p) || /^socks/i.test(p)) return p;
  if (p.includes("@")) return `http://${p}`;
  const parts = p.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return null;
}

let undiciMod; // undefined = not tried, null = unavailable
async function undici() {
  if (undiciMod === undefined) undiciMod = await import("undici").catch(() => null);
  return undiciMod;
}

const agents = new Map();
const MAX_AGENTS = 200;
async function agentFor(url) {
  const mod = await undici();
  if (!mod?.ProxyAgent) return null;
  let a = agents.get(url);
  if (!a) {
    if (agents.size >= MAX_AGENTS) {
      const [k, old] = agents.entries().next().value;
      agents.delete(k);
      old.close?.().catch?.(() => {});
    }
    a = new mod.ProxyAgent(url);
    agents.set(url, a);
  }
  return a;
}

/** Parse Retry-After (seconds or HTTP date) → ms, clamped 1s..10min. */
export function parseRetryAfter(v, now = Date.now()) {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  let ms = Number.isFinite(n) ? n * 1000 : Date.parse(String(v)) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 1000), 600000);
}

export async function fetchText(url, { proxy, headers = {}, timeoutMs = 14000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const pu = proxyUrl(proxy);
  const dispatcher = pu ? await agentFor(pu) : null;
  const mod = await undici();
  const f = mod?.fetch || globalThis.fetch;
  try {
    const r = await f(url, {
      headers: { "User-Agent": DEFAULT_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9", ...headers },
      signal: ctrl.signal,
      redirect: "follow",
      ...(dispatcher ? { dispatcher } : {}),
    });
    return {
      status: r.status,
      text: await r.text(),
      url: r.url,
      retryAfterMs: parseRetryAfter(r.headers.get("retry-after")),
      proxyIgnored: Boolean(pu && !dispatcher),
    };
  } finally {
    clearTimeout(t);
  }
}

const IN_RE = /InStock|PreOrder|LimitedAvailability|OnlineOnly|BackOrder/i;
const OUT_RE = /OutOfStock|SoldOut|Discontinued|InStoreOnly/i;

/** Extract the first schema.org Product from JSON-LD blocks. */
export function parseJsonLdProduct(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack = [data];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n)) { stack.push(...n); continue; }
      if (n["@graph"]) stack.push(n["@graph"]);
      const type = [].concat(n["@type"] || []).join(",");
      if (/Product/i.test(type)) {
        const offers = [].concat(n.offers?.offers || n.offers || []);
        const o = offers.find((x) => x && IN_RE.test(String(x.availability || ""))) || offers[0] || {};
        const avail = String(o.availability || "");
        const price = o.price ?? o.lowPrice ?? o.priceSpecification?.price;
        return {
          title: n.name ? String(n.name).slice(0, 120) : undefined,
          price: price != null && price !== "" ? `$${Number(price).toFixed(2)}` : undefined,
          availability: avail.replace(/^https?:\/\/schema\.org\//i, "") || undefined,
          inStock: avail ? IN_RE.test(avail) : undefined,
          outOfStock: avail ? OUT_RE.test(avail) : undefined,
        };
      }
    }
  }
  return null;
}

/** Tracks state per key and says whether an alert should fire (only on transitions). */
export function createChangeTracker({ cooldownMs = 5 * 60_000 } = {}) {
  const last = new Map();
  return function shouldAlert(key, { inStock, price }, now = Date.now()) {
    const prev = last.get(key);
    last.set(key, { inStock, price, at: prev && prev.inStock === inStock && prev.price === price ? prev.at : now, alerted: prev?.alerted ?? -Infinity });
    const cur = last.get(key);
    let reason = null;
    if (!prev) reason = inStock ? "restock" : null;
    else if (inStock && !prev.inStock) reason = "restock";
    else if (price && prev.price && price !== prev.price) reason = "price";
    if (!reason) return null;
    if (reason === "restock" && now - cur.alerted < cooldownMs) return null;
    if (reason === "restock") cur.alerted = now;
    return reason;
  };
}
