/**
 * Share identical monitor requests: when several tasks watch the same product through the
 * same proxy at the same moment, the store gets ONE request and every task gets the answer.
 * In-flight requests are shared, and a finished result is reused for `ttlMs` (default 1 s,
 * always shorter than any real poll delay). Fewer requests → fewer 429s for you.
 */
const inflight = new Map();
const recent = new Map(); // key → { at, result }
const stats = { requests: 0, shared: 0 };

export function monitorKey(store, body = {}) {
  const product = String(body.tcin || body.sku || body.product || body.url || "").trim().toLowerCase();
  const extra = [body.proxy || "", body.zip || body.postal || "", body.region || "", body.cookie ? String(body.cookie).length + String(body.cookie).slice(-12) : ""];
  return `${store}|${product}|${extra.join("|")}`;
}

export async function coalesceMonitor(key, fn, { ttlMs = Number(process.env.JOKERZ_MONITOR_SHARE_MS) || 1000, now = () => Date.now() } = {}) {
  stats.requests++;
  const r = recent.get(key);
  if (r && now() - r.at < ttlMs) {
    stats.shared++;
    return { ...r.result, shared: true };
  }
  if (inflight.has(key)) {
    stats.shared++;
    return { ...(await inflight.get(key)), shared: true };
  }
  const p = (async () => fn())();
  inflight.set(key, p);
  try {
    const result = await p;
    recent.set(key, { at: now(), result });
    if (recent.size > 500) for (const [k, v] of recent) if (now() - v.at > 60_000) recent.delete(k);
    return result;
  } finally {
    inflight.delete(key);
  }
}

export function monitorCoalesceStats() {
  return { ...stats };
}
export function _resetCoalesce() {
  inflight.clear();
  recent.clear();
  stats.requests = 0;
  stats.shared = 0;
}
