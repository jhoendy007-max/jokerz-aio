/**
 * True sliding-window rate limiter per proxy.
 *
 * Each request stores a timestamp. A proxy is allowed if:
 *   count(timestamps in (now - windowMs, now]) < maxReq
 *
 * Unlike fixed windows, bursts at window edges are not double-counted as free capacity.
 */

import { loadSettings } from '../lib/storage';

interface WindowState {
  /** Sorted ascending timestamps of requests */
  hits: number[];
}

const windows = new Map<string, WindowState>();

function keyOf(proxy: string): string {
  const t = proxy.trim();
  if (t.includes('@')) return t.split('@').pop() || t;
  return t;
}

function getLimits() {
  const s = loadSettings() as {
    proxyMaxReqPerWindow?: number;
    proxyRateWindowMs?: number;
  };
  return {
    // Default higher: 2 monitors * poll often; 30/min was too tight with 1 ISP
    maxReq: Math.max(0, s.proxyMaxReqPerWindow ?? 120),
    windowMs: Math.max(1000, s.proxyRateWindowMs ?? 60_000),
  };
}

/** Drop timestamps outside the sliding window (mutates array). */
function pruneSliding(hits: number[], now: number, windowMs: number) {
  const cutoff = now - windowMs;
  // hits are append-only chronological — fast path from the front
  let i = 0;
  while (i < hits.length && hits[i] <= cutoff) i++;
  if (i > 0) hits.splice(0, i);
}

function getState(proxy: string): WindowState {
  const k = keyOf(proxy);
  let st = windows.get(k);
  if (!st) {
    st = { hits: [] };
    windows.set(k, st);
  }
  return st;
}

/** How many hits fall inside the current sliding window */
export function slidingCount(proxy: string | undefined, now = Date.now()): number {
  if (!proxy) return 0;
  const { windowMs } = getLimits();
  const st = getState(proxy);
  pruneSliding(st.hits, now, windowMs);
  return st.hits.length;
}

/** True if proxy may send another request under the sliding window */
export function canUseProxy(proxy: string | undefined): boolean {
  if (!proxy) return true;
  const { maxReq, windowMs } = getLimits();
  if (maxReq <= 0) return true;
  const st = getState(proxy);
  const now = Date.now();
  pruneSliding(st.hits, now, windowMs);
  return st.hits.length < maxReq;
}

/** Record a request at `now` inside the sliding window */
export function recordProxyRequest(proxy: string | undefined, at = Date.now()) {
  if (!proxy) return;
  const { maxReq, windowMs } = getLimits();
  if (maxReq <= 0) return;
  const st = getState(proxy);
  pruneSliding(st.hits, at, windowMs);
  st.hits.push(at);
}

/**
 * Ms until the oldest hit in the window slides out enough to free a slot.
 * 0 if a slot is already free.
 */
export function proxyRetryAfterMs(proxy: string | undefined): number {
  if (!proxy) return 0;
  const { maxReq, windowMs } = getLimits();
  if (maxReq <= 0) return 0;
  const st = getState(proxy);
  const now = Date.now();
  pruneSliding(st.hits, now, windowMs);
  if (st.hits.length < maxReq) return 0;
  // When the oldest hit exits the window, one slot opens
  const oldest = st.hits[0];
  return Math.max(0, oldest + windowMs - now + 1);
}

/** Filter pool to proxies with remaining capacity in the sliding window */
export function filterRateLimited(pool: string[]): string[] {
  const { maxReq } = getLimits();
  if (maxReq <= 0) return pool;
  const open = pool.filter((p) => canUseProxy(p));
  return open.length ? open : pool;
}

export function getProxyRateStats(proxy: string): {
  used: number;
  max: number;
  windowMs: number;
  remaining: number;
  retryAfterMs: number;
  mode: 'sliding';
} {
  const { maxReq, windowMs } = getLimits();
  const used = slidingCount(proxy);
  return {
    used,
    max: maxReq,
    windowMs,
    remaining: maxReq > 0 ? Math.max(0, maxReq - used) : Infinity,
    retryAfterMs: proxyRetryAfterMs(proxy),
    mode: 'sliding',
  };
}

export function resetProxyRateLimits() {
  windows.clear();
}

/** Debug: snapshot all tracked proxies */
export function snapshotRateWindows(): {
  key: string;
  used: number;
  max: number;
  retryAfterMs: number;
}[] {
  const { maxReq, windowMs } = getLimits();
  const now = Date.now();
  const out: { key: string; used: number; max: number; retryAfterMs: number }[] = [];
  windows.forEach((st, k) => {
    pruneSliding(st.hits, now, windowMs);
    out.push({
      key: k,
      used: st.hits.length,
      max: maxReq,
      retryAfterMs:
        maxReq > 0 && st.hits.length >= maxReq
          ? Math.max(0, st.hits[0] + windowMs - now + 1)
          : 0,
    });
  });
  return out.sort((a, b) => b.used - a.used);
}


/** Optional: consult server Redis sliding window (falls back to local). */
export async function checkRateLimitRemote(
  proxy: string,
  opts?: { maxReq?: number; windowMs?: number; record?: boolean }
): Promise<{ allowed: boolean; retryAfterMs: number; backend?: string }> {
  const API_BASE = (import.meta as any).env?.VITE_API_URL || '/jokerz-api';
  try {
    const res = await fetch(`${API_BASE}/api/proxy/rate-limit/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy,
        maxReq: opts?.maxReq,
        windowMs: opts?.windowMs,
        record: opts?.record !== false,
      }),
    });
    const data = await res.json();
    return {
      allowed: !!data.allowed,
      retryAfterMs: data.retryAfterMs || 0,
      backend: data.backend,
    };
  } catch {
    // local fallback already applied by caller
    return { allowed: canUseProxy(proxy), retryAfterMs: proxyRetryAfterMs(proxy), backend: 'memory-fallback' };
  }
}
