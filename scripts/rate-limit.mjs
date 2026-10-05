/** Target/Walmart drop-window rate limit (usually ~1h before Pokémon/collectibles). */

export function isRateLimitText(html = "", url = "") {
  const t = `${html} ${url}`.toLowerCase();
  return /too many requests|rate.?limit|try again later|temporarily (blocked|unavailable)|access denied|please wait( a moment)?|slow down|429/.test(
    t
  );
}

export function retryAfterMs(headers = {}, html = "", attempt = 1) {
  const h = headers["retry-after"] || headers["Retry-After"];
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0) return Math.min(180_000, Math.max(5_000, n * 1000));
    const when = Date.parse(String(h));
    if (!Number.isNaN(when)) return Math.min(180_000, Math.max(5_000, when - Date.now()));
  }
  const m = String(html || "").match(/try again in (\d+)\s*(second|minute)/i);
  if (m) {
    const n = Number(m[1]);
    return /min/i.test(m[2]) ? n * 60_000 : n * 1000;
  }
  const base = 25_000 * 2 ** Math.min(4, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 12_000);
  return Math.min(180_000, base + jitter);
}

export function loginBackoffMs(attempt, rateLimited) {
  if (rateLimited) return retryAfterMs({}, "", attempt);
  return 3000 * attempt + Math.floor(Math.random() * 2000);
}
