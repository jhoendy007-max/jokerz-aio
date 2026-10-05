/**
 * Intelligent proxy scoring & selection.
 * Stats persist to localStorage (jokerz_aio_proxy_scores) and survive reloads.
 * Hard bans (Imperva Error 15, Shape critical) store banUntil so IPs are not reused.
 */

import { loadProxyScores, saveProxyScores } from '../lib/storage';
import { notifyProxyBan } from './webhooks';

export interface ProxyStats {
  key: string;
  success: number;
  fail: number;
  blocked: number;
  totalMs: number;
  samples: number;
  lastUsed: number;
  lastResult: 'success' | 'fail' | 'blocked' | 'unknown';
  /** Latency monitoring */
  lastMs?: number;
  minMs?: number;
  maxMs?: number;
  latencySamples?: number;
  /** Soft cooldown (ms epoch) — also mirrored from markProxyFailed */
  cooldownUntil?: number;
  /** Hard ban until epoch (Imperva 15, repeated Shape, etc.) */
  banUntil?: number;
  /** Last antibot / failure reason */
  lastProvider?: string;
  lastReason?: string;
  consecutiveBlocks?: number;
  /** Daily-ish block stamps for soft decay */
  blockHistory?: number[];
}

const stats = new Map<string, ProxyStats>();
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function keyOf(proxy: string): string {
  const t = proxy.trim();
  if (t.includes('@')) return t.split('@').pop() || t;
  return t;
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const data = loadProxyScores<Record<string, ProxyStats>>();
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && (v as ProxyStats).key) {
          stats.set(k, v as ProxyStats);
        } else if (v && typeof v === 'object') {
          stats.set(k, {
            key: k,
            success: 0,
            fail: 0,
            blocked: 0,
            totalMs: 0,
            samples: 0,
            lastUsed: 0,
            lastResult: 'unknown',
            ...(v as Partial<ProxyStats>),
          });
        }
      }
    }
    console.log('[proxyIntel] hydrated', stats.size, 'proxy score(s) from disk/localStorage');
  } catch (e) {
    console.warn('[proxyIntel] hydrate failed', e);
  }
}

function flushPersist() {
  try {
    const out: Record<string, ProxyStats> = {};
    const now = Date.now();
    const maxAge = 14 * 24 * 60 * 60 * 1000;
    stats.forEach((v, k) => {
      // Drop idle entries older than 14d unless still banned
      if (v.lastUsed && now - v.lastUsed > maxAge && !(v.banUntil && v.banUntil > now)) {
        return;
      }
      out[k] = v;
    });
    saveProxyScores(out);
    dirty = false;
  } catch (e) {
    console.warn('[proxyIntel] persist failed', e);
  }
}

function schedulePersist(immediate = false) {
  dirty = true;
  if (immediate) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    flushPersist();
    return;
  }
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => flushPersist(), 400);
}

function ensure(proxy: string): ProxyStats {
  hydrate();
  const k = keyOf(proxy);
  let s = stats.get(k);
  if (!s) {
    s = {
      key: k,
      success: 0,
      fail: 0,
      blocked: 0,
      totalMs: 0,
      samples: 0,
      lastUsed: 0,
      lastResult: 'unknown',
      consecutiveBlocks: 0,
      blockHistory: [],
    };
    stats.set(k, s);
  }
  return s;
}

/**
 * Hard-ban durations by provider (ms).
 * Tuned for drop day: long enough to stop re-burn, short enough to recycle pool.
 */
function banMsForProvider(provider?: string): number {
  const p = (provider || '').toLowerCase();
  // Imperva Error 15 = real IP edge ban — keep out of pool most of the session
  if (p === 'imperva') return 4 * 60 * 60_000; // 4h (was 6h)
  // Shape / Kasada: session + IP heat — 20–25m is enough between waves
  if (p === 'shape' || p === 'kasada') return 25 * 60_000; // 25m (was 45m)
  // PerimeterX: sticky reputation — still aggressive
  if (p === 'perimeterx' || p === 'px') return 60 * 60_000; // 60m (was 90m)
  // DataDome: often clears faster with browser pass
  if (p === 'datadome') return 20 * 60_000; // 20m (was 30m)
  if (p === 'akamai' || p === 'cloudflare') return 20 * 60_000;
  return 12 * 60_000; // generic hard block
}

/** Consecutive blocks before auto hard-ban (provider-agnostic streak) */
const STREAK_HARD_BAN = 3; // was 4 — ban earlier on repeated failures
const STREAK_HARD_BAN_COOLDOWN = 2; // was 3 for recordProxyCooldown path

export function recordProxyResult(
  proxy: string | undefined,
  result: {
    ok?: boolean;
    blocked?: boolean;
    ms?: number;
    provider?: string;
    reason?: string;
  }
) {
  if (!proxy) return;
  const s = ensure(proxy);
  s.lastUsed = Date.now();
  s.samples++;
  if (typeof result.ms === 'number' && result.ms > 0) {
    s.totalMs += result.ms;
    s.lastMs = result.ms;
    s.latencySamples = (s.latencySamples || 0) + 1;
    s.minMs = s.minMs == null ? result.ms : Math.min(s.minMs, result.ms);
    s.maxMs = s.maxMs == null ? result.ms : Math.max(s.maxMs, result.ms);
  }
  if (result.provider) s.lastProvider = result.provider;
  if (result.reason) s.lastReason = result.reason;

  if (result.blocked) {
    s.blocked++;
    s.lastResult = 'blocked';
    s.consecutiveBlocks = (s.consecutiveBlocks || 0) + 1;
    s.blockHistory = [...(s.blockHistory || []).filter((t) => Date.now() - t < 24 * 60 * 60_000), Date.now()].slice(
      -20
    );
    // Auto hard-ban on Imperva or streak of blocks
    const prov = (result.provider || '').toLowerCase();
    if (prov === 'imperva' || s.consecutiveBlocks >= STREAK_HARD_BAN) {
      const banMs = banMsForProvider(result.provider);
      const until = Date.now() + banMs;
      const wasBanned = (s.banUntil || 0) > Date.now();
      s.banUntil = Math.max(s.banUntil || 0, until);
      schedulePersist(true);
      if (!wasBanned || prov === 'imperva') {
        void notifyProxyBan({
          proxy,
          provider: result.provider || prov || 'generic',
          reason: result.reason || `blocked · streak ${s.consecutiveBlocks}`,
          banMs,
        });
      }
      return;
    }
  } else if (result.ok === false) {
    s.fail++;
    s.lastResult = 'fail';
  } else {
    s.success++;
    s.lastResult = 'success';
    s.consecutiveBlocks = 0;
  }
  schedulePersist();
}

/**
 * Mirror markProxyFailed into persistent scores.
 * provider: 'imperva' | 'shape' | … for hard ban length.
 */
export function recordProxyCooldown(
  proxy: string | undefined,
  cooldownMs: number,
  meta?: { provider?: string; reason?: string; hardBan?: boolean }
) {
  if (!proxy) return;
  const s = ensure(proxy);
  const until = Date.now() + Math.max(1000, cooldownMs);
  s.cooldownUntil = Math.max(s.cooldownUntil || 0, until);
  s.lastUsed = Date.now();
  if (meta?.provider) s.lastProvider = meta.provider;
  if (meta?.reason) s.lastReason = meta.reason;

  const prov = (meta?.provider || '').toLowerCase();
  const hard =
    meta?.hardBan ||
    prov === 'imperva' ||
    (s.consecutiveBlocks || 0) >= STREAK_HARD_BAN_COOLDOWN;
  if (hard) {
    const banMs = banMsForProvider(meta?.provider);
    const banUntil = Date.now() + banMs;
    const wasBanned = (s.banUntil || 0) > Date.now();
    s.banUntil = Math.max(s.banUntil || 0, banUntil, until);
    s.blocked = (s.blocked || 0) + 1;
    s.lastResult = 'blocked';
    s.consecutiveBlocks = (s.consecutiveBlocks || 0) + 1;
    schedulePersist(true);
    if (!wasBanned) {
      void notifyProxyBan({
        proxy,
        provider: meta?.provider || 'generic',
        reason: meta?.reason || 'hard ban via cooldown',
        banMs: Math.max(banMs, cooldownMs),
      });
    }
  } else {
    schedulePersist();
  }
}

/** True if proxy should not be selected (hard ban or active cooldown from scores). */
export function isProxyScoreBlocked(proxy: string, now = Date.now()): boolean {
  hydrate();
  const s = stats.get(keyOf(proxy));
  if (!s) return false;
  if (s.banUntil && s.banUntil > now) return true;
  if (s.cooldownUntil && s.cooldownUntil > now) return true;
  return false;
}

export function getProxyBanRemaining(proxy: string, now = Date.now()): number {
  hydrate();
  const s = stats.get(keyOf(proxy));
  if (!s) return 0;
  const ban = s.banUntil ? Math.max(0, s.banUntil - now) : 0;
  const cd = s.cooldownUntil ? Math.max(0, s.cooldownUntil - now) : 0;
  return Math.max(ban, cd);
}

/** Filter pool removing banned / cooling scored IPs. Falls back to full pool if all banned. */
export function filterByProxyScores(pool: string[], now = Date.now()): string[] {
  if (!pool.length) return pool;
  hydrate();
  const open = pool.filter((p) => !isProxyScoreBlocked(p, now));
  return open.length ? open : pool;
}

export function scoreProxy(proxy: string, now = Date.now()): number {
  hydrate();
  const s = stats.get(keyOf(proxy));
  if (!s || s.samples === 0) return 50;

  // Hard banned → bottom of ranking
  if (s.banUntil && s.banUntil > now) return -200;
  if (s.cooldownUntil && s.cooldownUntil > now) return -50;

  const total = s.success + s.fail + s.blocked;
  const successRate = total ? s.success / total : 0.5;
  const blockRate = total ? s.blocked / total : 0;
  const latN = s.latencySamples || s.samples;
  const avgMs = latN ? s.totalMs / Math.max(1, latN) : s.lastMs || 2000;
  let latencyScore = 0;
  if (avgMs <= 800) latencyScore = 25;
  else if (avgMs <= 1500) latencyScore = 18;
  else if (avgMs <= 2500) latencyScore = 8;
  else if (avgMs <= 4000) latencyScore = -5;
  else if (avgMs <= 6000) latencyScore = -18;
  else latencyScore = -35;
  if (s.lastMs && s.lastMs > 8000) latencyScore -= 15;
  const since = now - s.lastUsed;
  const recencyPenalty = since < 3000 ? -15 : since < 8000 ? -5 : 0;
  const lastPenalty =
    s.lastResult === 'blocked' ? -25 : s.lastResult === 'fail' ? -10 : 0;
  const streakPenalty = Math.min(40, (s.consecutiveBlocks || 0) * 8);

  return (
    successRate * 80 -
    blockRate * 100 +
    latencyScore +
    recencyPenalty +
    lastPenalty -
    streakPenalty +
    Math.min(10, s.success)
  );
}

export function pickIntelligent(
  pool: string[],
  opts?: { epsilon?: number; exclude?: Set<string> }
): string {
  hydrate();
  if (pool.length === 0) throw new Error('empty pool');
  if (pool.length === 1) return pool[0];

  const epsilon = opts?.epsilon ?? 0.15;
  let candidates = opts?.exclude
    ? pool.filter((p) => !opts.exclude!.has(keyOf(p)) && !opts.exclude!.has(p))
    : pool;
  candidates = filterByProxyScores(candidates);
  const list = candidates.length ? candidates : pool;

  if (Math.random() < epsilon) {
    return list[Math.floor(Math.random() * list.length)];
  }

  let best = list[0];
  let bestScore = scoreProxy(best);
  for (let i = 1; i < list.length; i++) {
    const sc = scoreProxy(list[i]);
    if (sc > bestScore) {
      best = list[i];
      bestScore = sc;
    }
  }
  return best;
}

export function getProxyIntelligenceSummary(proxies: string[]) {
  hydrate();
  const now = Date.now();
  return proxies
    .map((p) => {
      const s = stats.get(keyOf(p));
      return {
        key: keyOf(p),
        score: Math.round(scoreProxy(p) * 10) / 10,
        success: s?.success || 0,
        blocked: s?.blocked || 0,
        fail: s?.fail || 0,
        avgMs: s && s.samples ? Math.round(s.totalMs / s.samples) : 0,
        lastResult: s?.lastResult || 'unknown',
        lastProvider: s?.lastProvider,
        banRemainingMs: getProxyBanRemaining(p, now),
        consecutiveBlocks: s?.consecutiveBlocks || 0,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function resetProxyIntelligence() {
  stats.clear();
  schedulePersist(true);
}

/** Clear ban/cooldown for one proxy (manual recovery) */
export function clearProxyScoreBan(proxy: string) {
  const s = ensure(proxy);
  s.banUntil = 0;
  s.cooldownUntil = 0;
  s.consecutiveBlocks = 0;
  schedulePersist(true);
}

/** Call on engine start */
export function hydrateProxyIntelligence() {
  hydrate();
}

/** Force flush to localStorage now */
export function persistProxyScoresNow() {
  flushPersist();
}

export type IspLatencyRow = {
  proxy: string;
  avgMs: number;
  lastMs: number;
  minMs: number;
  maxMs: number;
  samples: number;
  success: number;
  fail: number;
  blocked: number;
  lastResult: string;
  banRemainingMs?: number;
};

/** Per-IP latency table for an ISP/proxy group (or all if no filter). */
export function getIspLatencyReport(opts?: {
  groupProxies?: string[];
  limit?: number;
}): IspLatencyRow[] {
  hydrate();
  const limit = opts?.limit ?? 50;
  const allow = opts?.groupProxies?.length
    ? new Set(opts.groupProxies.map((p) => keyOf(p)))
    : null;
  const now = Date.now();

  const rows: IspLatencyRow[] = [];
  for (const s of stats.values()) {
    if (allow && !allow.has(keyOf(s.key))) continue;
    const n = s.latencySamples || (s.totalMs > 0 ? s.samples : 0);
    if (!n && !s.lastMs && !(s.banUntil && s.banUntil > now)) continue;
    const avg =
      n > 0 ? Math.round(s.totalMs / Math.max(1, s.latencySamples || s.samples)) : s.lastMs || 0;
    rows.push({
      proxy: s.key,
      avgMs: avg,
      lastMs: s.lastMs || 0,
      minMs: s.minMs || 0,
      maxMs: s.maxMs || 0,
      samples: s.latencySamples || s.samples,
      success: s.success,
      fail: s.fail,
      blocked: s.blocked,
      lastResult: s.lastResult,
      banRemainingMs: getProxyBanRemaining(s.key, now),
    });
  }
  rows.sort((a, b) => a.avgMs - b.avgMs);
  return rows.slice(0, limit);
}

export function formatIspLatencyLine(row: IspLatencyRow): string {
  const ban =
    row.banRemainingMs && row.banRemainingMs > 0
      ? ` · BAN ${Math.ceil(row.banRemainingMs / 60000)}m`
      : '';
  return `${row.proxy} · avg ${row.avgMs}ms · last ${row.lastMs}ms · min ${row.minMs} · max ${row.maxMs} · n=${row.samples} · ${row.lastResult}${ban}`;
}

/** Drop proxies slower than maxAvgMs (when we have samples). Keep unknowns. */
export function filterByMaxLatency(pool: string[], maxAvgMs: number): string[] {
  if (!maxAvgMs || maxAvgMs <= 0 || pool.length <= 1) return pool;
  hydrate();
  const fast: string[] = [];
  const unknown: string[] = [];
  for (const p of pool) {
    if (isProxyScoreBlocked(p)) continue;
    const s = stats.get(keyOf(p));
    const n = s?.latencySamples || 0;
    if (!s || n < 2) {
      unknown.push(p);
      continue;
    }
    const avg = s.totalMs / Math.max(1, n);
    if (avg <= maxAvgMs) fast.push(p);
  }
  if (fast.length) return fast.length >= 2 ? fast : [...fast, ...unknown].slice(0, Math.max(2, fast.length));
  return filterByProxyScores(pool);
}

export function pickFastest(pool: string[]): string {
  hydrate();
  const list = filterByProxyScores(pool);
  const use = list.length ? list : pool;
  if (use.length <= 1) return use[0];
  let best = use[0];
  let bestAvg = Number.POSITIVE_INFINITY;
  for (const p of use) {
    const s = stats.get(keyOf(p));
    const n = s?.latencySamples || 0;
    const avg = n ? s!.totalMs / n : (s?.lastMs ?? 99999);
    if (avg < bestAvg) {
      bestAvg = avg;
      best = p;
    }
  }
  return best;
}
