/**
 * Proxy health test (maintenance only): is it alive, how fast, which exit IP / country.
 * Does not rotate or pick proxies for tasks.
 */
import { fetchText, proxyUrl } from "./monitor-common.mjs";
import { geoForProxy } from "./proxy-geo.mjs";

export function maskProxy(raw) {
  const s = String(raw || "").trim();
  const u = proxyUrl(s);
  if (!u) return s.slice(0, 40);
  try {
    const x = new URL(u);
    return `${x.hostname}:${x.port}${x.username ? " · user ***" : ""}`;
  } catch {
    return s.split(":").slice(0, 2).join(":");
  }
}

export async function testOneProxy(raw, { timeoutMs = 8000, deps = { fetchText, geoForProxy } } = {}) {
  const display = maskProxy(raw);
  if (!proxyUrl(String(raw || ""))) return { proxy: raw, display, ok: false, error: "Bad format (use host:port or host:port:user:pass)" };
  const t0 = Date.now();
  try {
    const r = await deps.fetchText("https://api.ipify.org?format=json", { proxy: raw, timeoutMs, headers: { Accept: "application/json" } });
    const ms = Date.now() - t0;
    if (r.proxyIgnored) return { proxy: raw, display, ok: false, ms, error: "undici missing — proxy not used (npm install undici)" };
    if (r.status === 407) return { proxy: raw, display, ok: false, ms, error: "Proxy auth failed (407) — check user/pass" };
    if (r.status >= 400) return { proxy: raw, display, ok: false, ms, error: `HTTP ${r.status}` };
    let exitIp = "";
    try {
      exitIp = JSON.parse(r.text).ip || "";
    } catch {
      /* */
    }
    const geo = await deps.geoForProxy(raw, { timeoutMs: 4000 }).catch(() => null);
    return { proxy: raw, display, ok: true, ms, exitIp, country: geo?.country || "", city: geo?.city || "", region: geo?.region || "", speed: ms < 800 ? "fast" : ms < 2000 ? "ok" : "slow" };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout" : e?.cause?.code || e?.message || String(e);
    return { proxy: raw, display, ok: false, ms: Date.now() - t0, error: msg };
  }
}

export async function testProxies(list, { concurrency = 6, timeoutMs = 8000, deps } = {}) {
  const items = [...new Set((list || []).map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 200);
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        results[k] = await testOneProxy(items[k], { timeoutMs, ...(deps ? { deps } : {}) });
      }
    }),
  );
  const passed = results.filter((r) => r.ok).length;
  const okMs = results.filter((r) => r.ok).map((r) => r.ms);
  return { ok: true, passed, failed: results.length - passed, avgMs: okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null, results };
}
