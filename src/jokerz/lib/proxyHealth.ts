/**
 * Proxy health from the "Test" button: consecutive failures per proxy line.
 * 3 failed tests in a row → marked dead, shown in the Proxies tab; you decide whether to remove them.
 */
export const PROXY_HEALTH_KEY = 'jokerz_aio_proxy_health';
export const DEAD_AFTER = 3;

export interface ProxyHealthEntry {
  fails: number; // consecutive
  okCount: number;
  failCount: number;
  lastMs?: number;
  lastOkAt?: number;
  lastTestAt: number;
  lastError?: string;
  country?: string;
  city?: string;
  exitIp?: string;
}
type St = Pick<Storage, 'getItem' | 'setItem'>;
const ls = (): St => localStorage;

export function loadProxyHealth(st: St = ls()): Record<string, ProxyHealthEntry> {
  try {
    return JSON.parse(st.getItem(PROXY_HEALTH_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function applyTestResults(
  map: Record<string, ProxyHealthEntry>,
  results: { proxy?: string; ok: boolean; ms?: number; error?: string; country?: string; city?: string; exitIp?: string }[],
  now = Date.now(),
) {
  const next = { ...map };
  for (const r of results) {
    if (!r.proxy) continue;
    const k = r.proxy.trim();
    const p = next[k] || { fails: 0, okCount: 0, failCount: 0, lastTestAt: now };
    next[k] = r.ok
      ? { ...p, fails: 0, okCount: p.okCount + 1, lastMs: r.ms, lastOkAt: now, lastTestAt: now, lastError: undefined, country: r.country || p.country, city: r.city || p.city, exitIp: r.exitIp || p.exitIp }
      : { ...p, fails: p.fails + 1, failCount: p.failCount + 1, lastTestAt: now, lastError: r.error };
  }
  return next;
}

export function saveProxyHealth(map: Record<string, ProxyHealthEntry>, st: St = ls()) {
  const entries = Object.entries(map).sort((a, b) => b[1].lastTestAt - a[1].lastTestAt).slice(0, 3000);
  try {
    st.setItem(PROXY_HEALTH_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* */
  }
}

export const isDead = (e?: ProxyHealthEntry) => Boolean(e && e.fails >= DEAD_AFTER);
export function deadProxies(lines: string[], map: Record<string, ProxyHealthEntry>) {
  return lines.filter((l) => isDead(map[l.trim()]));
}
