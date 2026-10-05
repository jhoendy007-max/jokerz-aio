import { loadProxies, ProxyGroup, loadSettings } from '../lib/storage';
import {
  pickIntelligent,
  recordProxyResult,
  recordProxyCooldown,
  getIspLatencyReport,
  formatIspLatencyLine,
  filterByMaxLatency,
  pickFastest,
  filterByProxyScores,
  isProxyScoreBlocked,
  getProxyBanRemaining,
  scoreProxy,
  type IspLatencyRow,
} from './proxyIntelligence';
import { filterRateLimited, recordProxyRequest, canUseProxy, proxyRetryAfterMs, getProxyRateStats, resetProxyRateLimits, snapshotRateWindows } from './proxyRateLimit';

export type ProxyRotationMode = 'round-robin' | 'random' | 'sticky' | 'least-used' | 'intelligent' | 'fastest';

const defaultGroups: ProxyGroup[] = [
  {
    id: '1',
    name: 'DC-Resi',
    count: 0,
    type: 'Residential',
    status: 'Online',
    proxies: [],
    rotation: 'random',
    cooldownMs: 45_000,
    stickyMinutes: 5,
  },
  {
    id: '2',
    name: 'ISPs-VA',
    count: 0,
    type: 'ISP',
    status: 'Online',
    proxies: [],
    rotation: 'least-used',
    cooldownMs: 120000,
    stickyMinutes: 10,
  },
  { id: '3', name: 'Localhost', count: 1, type: 'Local', status: 'Online', proxies: [] },
];

const rrIndex = new Map<string, number>();
const stickyMap = new Map<string, { proxy: string; expires: number }>();
/** All monitor tasks in a group share one IP (speed + warm session). */
const monitorGroupSticky = new Map<string, { proxy: string; expires: number }>();

const useCount = new Map<string, number>();
const cooldownUntil = new Map<string, number>();

function findGroup(groupName: string): ProxyGroup | undefined {
  const groups = loadProxies(defaultGroups);
  const lower = groupName.toLowerCase();
  return (
    groups.find((g) => g.name.toLowerCase() === lower) ||
    groups.find((g) => lower.includes(g.name.toLowerCase()) || g.name.toLowerCase().includes(lower))
  );
}

function listProxies(group: ProxyGroup): string[] {
  return (group.proxies || []).map((p) => p.trim()).filter(Boolean);
}

function isAvailable(proxy: string, now = Date.now()): boolean {
  if ((cooldownUntil.get(proxy) || 0) > now) return false;
  // Persistent scores (Imperva ban, etc.) survive page reload
  if (isProxyScoreBlocked(proxy, now)) return false;
  return true;
}

function availableList(list: string[]): string[] {
  const now = Date.now();
  // Never return cooling / score-banned IPs — empty pool means "wait"
  return list.filter((p) => isAvailable(p, now));
}

/** Global fallback from settings */
export function getRotationMode(): ProxyRotationMode {
  try {
    const s = loadSettings() as { proxyRotation?: ProxyRotationMode };
    return s.proxyRotation || 'round-robin';
  } catch {
    return 'round-robin';
  }
}

/** Prefer group.rotation → type defaults → global */
export function resolveModeForGroup(group?: ProxyGroup): ProxyRotationMode {
  if (group?.rotation) return group.rotation;
  const t = (group?.type || '').toLowerCase();
  if (t === 'isp') return 'least-used';
  // Residential rotating gateways: random IP each request is normal;
  // sticky only when the provider supports session IDs in the username.
  if (t === 'residential' || t === 'resi' || t === 'mobile') return 'random';
  if (t === 'datacenter' || t === 'dc') return 'round-robin';
  return getRotationMode();
}

export function markProxyFailed(
  proxy: string,
  cooldownMs?: number,
  groupName?: string,
  meta?: { provider?: string; reason?: string; hardBan?: boolean }
) {
  if (!proxy) return;
  const settings = loadSettings() as { proxyCooldownMs?: number };
  let ms = cooldownMs ?? settings.proxyCooldownMs ?? 60_000;
  if (groupName) {
    const g = findGroup(groupName);
    if (g?.cooldownMs && g.cooldownMs > 0) {
      // Prefer explicit decision when provided; else group default
      if (cooldownMs == null) ms = g.cooldownMs;
      else ms = Math.max(cooldownMs, Math.min(g.cooldownMs, cooldownMs * 2));
    }
  }
  // Imperva / explicit hard ban → longer floor
  if (meta?.hardBan || (meta?.provider || '').toLowerCase() === 'imperva') {
    ms = Math.max(ms, 180_000);
  }
  const until = Date.now() + Math.max(1_000, ms);
  const prev = cooldownUntil.get(proxy) || 0;
  // Extend, don't shorten an existing longer cooldown
  cooldownUntil.set(proxy, Math.max(prev, until));
  // Persist to scores (survives reload)
  try {
    recordProxyCooldown(proxy, ms, meta);
  } catch {
    /* */
  }
}

/** Ms remaining before this proxy can be used (0 if ready) */
export function getProxyCooldownRemaining(proxy?: string): number {
  if (!proxy) return 0;
  return Math.max(0, (cooldownUntil.get(proxy) || 0) - Date.now());
}

/** Earliest time any proxy in the group becomes available; 0 if at least one is free */
export function getGroupCooldownWaitMs(groupName?: string): number {
  if (!groupName) return 0;
  const group = findGroup(groupName);
  if (!group) return 0;
  const list = listProxies(group);
  if (!list.length) return 0;
  const now = Date.now();
  const open = list.filter((p) => isAvailable(p, now));
  if (open.length) return 0;
  let minWait = Number.POSITIVE_INFINITY;
  for (const p of list) {
    const w = (cooldownUntil.get(p) || 0) - now;
    if (w < minWait) minWait = w;
  }
  return Number.isFinite(minWait) ? Math.max(0, minWait) : 0;
}


export function clearProxyCooldown(proxy?: string) {
  if (!proxy) cooldownUntil.clear();
  else cooldownUntil.delete(proxy);
}

/** Clear cooldown for every proxy in a named group (e.g. after manual Start). */
export function clearGroupProxyCooldowns(groupName?: string): number {
  if (!groupName) return 0;
  const group = findGroup(groupName);
  if (!group) return 0;
  let n = 0;
  for (const proxy of listProxies(group)) {
    if (cooldownUntil.has(proxy)) {
      cooldownUntil.delete(proxy);
      n++;
    }
  }
  return n;
}


export function releaseSticky(taskId: string) {
  stickyMap.delete(taskId);
  for (const k of [...stickyMap.keys()]) {
    if (k === taskId || k.startsWith(`${taskId}::`)) stickyMap.delete(k);
  }
}

/**
 * One IP per task+group until Stop. ISP or resi — first pick sticks (not least-used each call).
 */
export function resolveTaskStickyProxy(taskId: string, groupName?: string): string | undefined {
  if (!groupName || groupName === 'Localhost' || groupName === 'localhost') return undefined;
  const key = `${taskId}::${String(groupName).toLowerCase()}`;
  const now = Date.now();
  const stuck = stickyMap.get(key);
  if (stuck && !isProxyScoreBlocked(stuck.proxy)) {
    stuck.expires = now + 24 * 60 * 60 * 1000;
    return stuck.proxy;
  }
  const picked = resolveProxyFromGroup(groupName, { taskId, mode: 'least-used' });
  if (picked) {
    stickyMap.set(key, { proxy: picked, expires: now + 24 * 60 * 60 * 1000 });
    stickyMap.set(taskId, { proxy: picked, expires: now + 24 * 60 * 60 * 1000 });
  }
  return picked;
}

export type ProxyRole = 'login' | 'harvest' | 'checkout' | 'monitor';

export function proxyBindMode(task: { extras?: Record<string, unknown>; proxyGroup?: string }): 'same' | 'split' {
  return (task.extras as any)?.proxyBind === 'split' ? 'split' : 'same';
}

export function proxyRoleGroup(
  task: { extras?: Record<string, unknown>; proxyGroup?: string },
  role: ProxyRole
): string {
  const x = (task.extras || {}) as any;
  const base = String(task.proxyGroup || '').trim();
  if (role === 'monitor' || proxyBindMode(task) === 'same') return base;
  if (role === 'login') return String(x.loginProxy || base).trim() || base;
  if (role === 'harvest') return String(x.harvestProxy || x.loginProxy || base).trim() || base;
  return String(x.checkoutProxy || base).trim() || base;
}

export function resolveRoleProxy(
  task: { extras?: Record<string, unknown>; proxyGroup?: string },
  role: ProxyRole,
  taskId: string
): string | undefined {
  const group = proxyRoleGroup(task, role);
  if (role === 'monitor') return resolveMonitorSharedProxy(group);
  return resolveTaskStickyProxy(taskId, group);
}

export function harvestSameAsCheckout(task: { extras?: Record<string, unknown>; proxyGroup?: string }): boolean {
  return proxyRoleGroup(task, 'harvest').toLowerCase() === proxyRoleGroup(task, 'checkout').toLowerCase();
}

function pickLeastUsed(pool: string[]): string {
  let best = pool[0];
  let bestN = useCount.get(best) || 0;
  for (const p of pool) {
    const n = useCount.get(p) || 0;
    if (n < bestN) {
      best = p;
      bestN = n;
    }
  }
  return best;
}


/** Last ISP rotation event per group (for logs / UI) */
const lastIspRotate = new Map<
  string,
  { at: number; from?: string; to?: string; reason?: string }
>();

/**
 * Pick next ISP IP from pool: skip `exclude`, prefer score-aware least-used / intelligent.
 * Score-banned IPs are filtered first so we don't bounce back to Imperva-burned lines.
 */
function pickNextIspProxy(
  pool: string[],
  exclude?: string,
  mode: ProxyRotationMode = 'least-used'
): string {
  let candidates = exclude && pool.length > 1 ? pool.filter((p) => p !== exclude) : pool.slice();
  if (!candidates.length) candidates = pool.slice();
  // Prefer non-banned from persistent scores; fall back if pool would empty
  try {
    const scored = filterByProxyScores(candidates);
    if (scored.length) candidates = scored;
  } catch {
    /* scores optional */
  }
  try {
    if (mode === 'fastest' || mode === 'intelligent') {
      return mode === 'intelligent'
        ? pickIntelligent(candidates, { epsilon: 0.08 })
        : pickFastest(candidates);
    }
  } catch {
    /* fall through */
  }
  if (mode === 'random') {
    // Bias random toward better scores when we have data (70% pick top half)
    try {
      if (candidates.length >= 4 && Math.random() < 0.7) {
        const ranked = [...candidates].sort((a, b) => scoreProxy(b) - scoreProxy(a));
        const top = ranked.slice(0, Math.max(2, Math.ceil(ranked.length / 2)));
        return top[Math.floor(Math.random() * top.length)];
      }
    } catch {
      /* */
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  if (mode === 'round-robin') {
    const key = `isp-rr:${candidates[0] || 'x'}`;
    const idx = rrIndex.get(key) ?? 0;
    const p = candidates[idx % candidates.length];
    rrIndex.set(key, idx + 1);
    return p;
  }
  // least-used: break ties with score (prefer healthier IP among equal use counts)
  return pickLeastUsedScored(candidates);
}

/** Least-used with score tie-break (avoids always picking pool[0] after equal use). */
function pickLeastUsedScored(pool: string[]): string {
  if (pool.length <= 1) return pool[0];
  let best = pool[0];
  let bestN = useCount.get(best) || 0;
  let bestScore = 0;
  try {
    bestScore = scoreProxy(best);
  } catch {
    /* */
  }
  for (let i = 1; i < pool.length; i++) {
    const p = pool[i];
    const n = useCount.get(p) || 0;
    let sc = 0;
    try {
      sc = scoreProxy(p);
    } catch {
      /* */
    }
    if (n < bestN || (n === bestN && sc > bestScore)) {
      best = p;
      bestN = n;
      bestScore = sc;
    }
  }
  return best;
}

/**
 * Shared sticky IP for ALL monitor tasks on the same proxy group — Stellar-style.
 *
 * - 1 ISP line → every Target / Walmart / PKC / Bandai monitor on that group uses it
 * - Soft cooldown does NOT kick other monitors off the IP (only hard score-ban does)
 * - Rate limit is NOT counted on every tick while sticky is held
 * - Rotate only on forceRotate / sticky expiry / hard ban
 */
export function resolveMonitorSharedProxy(
  groupName?: string,
  opts?: { forceRotate?: boolean; reason?: string }
): string | undefined {
  if (!groupName || groupName === 'Localhost' || groupName === 'localhost') {
    return undefined;
  }
  const group = findGroup(groupName);
  if (!group) return undefined;
  const list = listProxies(group);
  if (!list.length) return undefined;

  const key = group.name.toLowerCase();
  const now = Date.now();
  const isIsp = /isp/i.test(String(group.type || '')) || /isp/i.test(group.name);
  // Long sticky: 1 IP stays shared across all monitor modules until rotate
  const stickyMs = Math.max(
    isIsp ? 15 * 60_000 : 10 * 60_000,
    (group.stickyMinutes ?? (isIsp ? 20 : 30)) * 60_000
  );

  if (!opts?.forceRotate) {
    const cur = monitorGroupSticky.get(key);
    // Soft cooldown ignored — only hard score ban drops the sticky (Stellar 1-IP share)
    if (
      cur &&
      cur.expires > now &&
      list.includes(cur.proxy) &&
      !isProxyScoreBlocked(cur.proxy, now)
    ) {
      return cur.proxy.trim();
    }
    // Sticky expired or cleared but IP still in list and not hard-banned → re-pin same IP
    if (cur && list.includes(cur.proxy) && !isProxyScoreBlocked(cur.proxy, now) && !opts?.forceRotate) {
      monitorGroupSticky.set(key, { proxy: cur.proxy, expires: now + stickyMs });
      return cur.proxy.trim();
    }
  }

  // Prefer non-banned; if only 1 line, always use it unless hard-banned
  let pool = list.filter((p) => !isProxyScoreBlocked(p, now));
  if (!pool.length) {
    // Everything hard-banned — nothing to share
    return undefined;
  }
  // Prefer soft-available, but fall back to full non-banned pool (1-IP case)
  const open = availableList(pool);
  if (open.length) pool = open;

  try {
    const maxLat = Number((loadSettings() as any).maxProxyLatencyMs) || 4500;
    const filtered = filterByMaxLatency(pool, maxLat);
    // Only apply latency filter if it doesn't empty a tiny pool
    if (filtered.length || pool.length > 1) {
      if (filtered.length) pool = filtered;
    }
  } catch {
    /* */
  }

  const prev = monitorGroupSticky.get(key)?.proxy;
  const mode = resolveModeForGroup(group);
  const pickMode: ProxyRotationMode = isIsp
    ? mode === 'sticky' || mode === 'random'
      ? 'least-used'
      : mode
    : mode;
  const proxy = pickNextIspProxy(pool, opts?.forceRotate ? prev : undefined, pickMode);

  monitorGroupSticky.set(key, { proxy, expires: now + stickyMs });
  useCount.set(proxy, (useCount.get(proxy) || 0) + 1);
  // Only record rate-limit window when assigning/rotating — not every shared tick
  recordProxyRequest(proxy);

  if (opts?.forceRotate || (prev && prev !== proxy)) {
    lastIspRotate.set(key, {
      at: now,
      from: prev,
      to: proxy,
      reason: opts?.reason || (opts?.forceRotate ? 'force' : 'sticky_expired'),
    });
  }

  return proxy.trim();
}

export function releaseMonitorSharedProxy(groupName?: string) {
  if (!groupName) {
    monitorGroupSticky.clear();
    return;
  }
  monitorGroupSticky.delete(groupName.toLowerCase());
}

/** Snapshot of shared monitor IP + last rotation for a group */
export function getIspRotationState(groupName?: string): {
  group?: string;
  current?: string;
  expiresInMs?: number;
  last?: { at: number; from?: string; to?: string; reason?: string };
  available: number;
  cooling: number;
  total: number;
} {
  if (!groupName) return { available: 0, cooling: 0, total: 0 };
  const group = findGroup(groupName);
  const list = group ? listProxies(group) : [];
  const key = groupName.toLowerCase();
  const cur = monitorGroupSticky.get(key);
  const now = Date.now();
  const cooling = list.filter((p) => !isAvailable(p, now)).length;
  return {
    group: group?.name || groupName,
    current: cur?.proxy,
    expiresInMs: cur ? Math.max(0, cur.expires - now) : undefined,
    last: lastIspRotate.get(key),
    available: list.length - cooling,
    cooling,
    total: list.length,
  };
}


/**
 * Resolve next proxy.
 * ISP groups default to least-used + longer sticky/cooldown when configured on the group.
 */
export function resolveProxyFromGroup(
  groupName?: string,
  opts?: { taskId?: string; mode?: ProxyRotationMode; /** Monitors may share last IP when pool is 1 */ allowMonitorShare?: boolean }
): string | undefined {
  if (!groupName || groupName === 'Localhost' || groupName === 'localhost') {
    return undefined;
  }

  const group = findGroup(groupName);
  if (!group) return undefined;

  const list = listProxies(group);
  if (list.length === 0) return undefined;

  const mode = opts?.mode || resolveModeForGroup(group);
  const open = availableList(list);
  let pool = filterRateLimited(open);
  // Latency gate: drop slow IPs (settings.maxProxyLatencyMs, default 4500)
  try {
    const maxLat = Number((loadSettings() as any).maxProxyLatencyMs);
    const cap = Number.isFinite(maxLat) && maxLat > 0 ? maxLat : 4500;
    const filtered = filterByMaxLatency(pool, cap);
    if (filtered.length) pool = filtered;
  } catch {
    /* keep pool */
  }
  const stickyMs = (group.stickyMinutes ?? (group.type?.toLowerCase() === 'isp' ? 10 : 0)) * 60_000;

  // All IPs cooling or rate-limited
  if (!pool.length) {
    // Monitor multi-task: with 1 ISP line, Stellar-style shares the same IP across SKUs.
    // Soft-reuse anything not hard-banned (Imperva/score ban still blocked).
    if (opts?.allowMonitorShare || mode === 'round-robin') {
      const soft = list.filter((p) => !isProxyScoreBlocked(p));
      if (soft.length) {
        pool = soft;
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  let proxy: string;

  switch (mode) {
    case 'random':
      // Bias toward healthier IPs when scores exist
      proxy = pickNextIspProxy(pool, undefined, 'random');
      break;
    case 'sticky': {
      const tid = opts?.taskId;
      const now = Date.now();
      if (tid && stickyMap.has(tid)) {
        const stuck = stickyMap.get(tid)!;
        if (stuck.expires > now && isAvailable(stuck.proxy)) {
          return stuck.proxy;
        }
      }
      proxy = pickLeastUsedScored(pool);
      if (tid) {
        stickyMap.set(tid, {
          proxy,
          expires: now + (stickyMs || 10 * 60_000),
        });
      }
      break;
    }
    case 'least-used':
      proxy = pickLeastUsedScored(pool);
      break;
    case 'intelligent':
      proxy = pickIntelligent(pool, { epsilon: 0.08 });
      break;
    case 'fastest':
      proxy = pickFastest(pool);
      break;
    case 'round-robin':
    default: {
      const key = group.name;
      const idx = rrIndex.get(key) ?? 0;
      let chosen = pool[0];
      for (let i = 0; i < list.length; i++) {
        const candidate = list[(idx + i) % list.length];
        if (pool.includes(candidate)) {
          chosen = candidate;
          rrIndex.set(key, idx + i + 1);
          break;
        }
      }
      proxy = chosen;
      break;
    }
  }

  useCount.set(proxy, (useCount.get(proxy) || 0) + 1);
  recordProxyRequest(proxy);
  return proxy.trim();
}

export function getProxyGroupStats(groupName?: string): {
  total: number;
  name: string;
  cooling: number;
  available: number;
  nextAvailableMs?: number;
  mode: ProxyRotationMode;
  type?: string;
} {
  if (!groupName) return { total: 0, name: '', cooling: 0, available: 0, mode: getRotationMode() };
  const group = findGroup(groupName);
  const list = group ? listProxies(group) : [];
  const now = Date.now();
  const cooling = list.filter((p) => !isAvailable(p, now)).length;
  let nextAvailableMs = 0;
  if (cooling === list.length && list.length > 0) {
    nextAvailableMs = getGroupCooldownWaitMs(groupName);
  }
  return {
    name: group?.name || groupName,
    total: list.length,
    cooling,
    available: list.length - cooling,
    nextAvailableMs,
    mode: resolveModeForGroup(group),
    type: group?.type,
  };
}

/** ISP-oriented defaults when creating groups from UI */
export function ispGroupDefaults(): Partial<ProxyGroup> {
  return {
    type: 'ISP',
    rotation: 'least-used',
    cooldownMs: 120_000,
    stickyMinutes: 10,
  };
}

/** Residential / rotating gateway defaults (Decodo, Aurum, Bright, Oxylabs-style) */
export function residentialGroupDefaults(): Partial<ProxyGroup> {
  return {
    type: 'Residential',
    // Random: each line is often a sticky-session user OR a rotating gateway endpoint.
    // "intelligent" is better when you paste many static resi endpoints.
    rotation: 'random',
    // Soft rest — resi IPs are abundant; don't over-cool the whole pool
    cooldownMs: 45_000,
    // Short sticky if provider embeds session- in username; engine still can sticky by task
    stickyMinutes: 5,
  };
}

/** True if group is residential / mobile rotating pool */
export function isResidentialGroup(groupName?: string): boolean {
  if (!groupName) return false;
  const g = findGroup(groupName);
  if (!g) return /resi|residential|mobile|bright|oxylabs|decodo|aurum|stellar|hype/i.test(groupName);
  const t = String(g.type || '').toLowerCase();
  return (
    t === 'residential' ||
    t === 'resi' ||
    t === 'mobile' ||
    /resi|residential|mobile/i.test(g.name)
  );
}

/**
 * Residential policy:
 * - monitor → random (or intelligent if many static lines)
 * - checkout → sticky short session when possible
 */
export function resolveResidentialModeForTask(
  groupName?: string,
  taskMode?: string
): ProxyRotationMode | undefined {
  if (!isResidentialGroup(groupName)) return undefined;
  const m = String(taskMode || '').toLowerCase();
  if (m === 'monitor' || m === 'shipping' || m === 'watch') {
    const g = findGroup(groupName!);
    const n = g ? listProxies(g).length : 0;
    // Many discrete endpoints → intelligent; single rotating gateway → random is fine
    return n >= 8 ? 'intelligent' : 'random';
  }
  return 'sticky';
}

export {
  recordProxyResult,
  recordProxyCooldown,
  getProxyIntelligenceSummary,
  resetProxyIntelligence,
  scoreProxy,
  filterByProxyScores,
  isProxyScoreBlocked,
  getProxyBanRemaining,
  clearProxyScoreBan,
  hydrateProxyIntelligence,
  persistProxyScoresNow,
} from './proxyIntelligence';


export { canUseProxy, proxyRetryAfterMs, getProxyRateStats, resetProxyRateLimits, snapshotRateWindows };


/** Peek up to N proxies from group for one-shot multi-try (RedSky). */
export function peekProxiesFromGroup(groupName?: string, n = 3): string[] {
  if (!groupName || groupName === 'Localhost') return [];
  const group = findGroup(groupName);
  if (!group) return [];
  const list = listProxies(group);
  const open = availableList(list);
  const pool = filterRateLimited(open);
  if (!pool.length) return [];
  const out: string[] = [];
  const key = group.name + ':peek';
  let idx = rrIndex.get(key) ?? 0;
  for (let i = 0; i < pool.length && out.length < n; i++) {
    const p = pool[(idx + i) % pool.length];
    if (!out.includes(p)) out.push(p);
  }
  rrIndex.set(key, idx + out.length);
  return out;
}


/**
 * Force next ISP/proxy in group.
 * - monitorShared (default true): rotate the SHARED monitor IP for the group
 * - monitorShared false: per-task sticky rotate (checkout)
 * Puts the previous IP on cooldown so we don't bounce back immediately.
 */
export function rotateIspProxy(
  groupName?: string,
  opts?: {
    taskId?: string;
    reason?: string;
    monitorShared?: boolean;
    /** Cooldown ms for the IP we are leaving (default: group cooldown or 45s) */
    cooldownPrevMs?: number;
  }
): string | undefined {
  if (!groupName || groupName === 'Localhost') return undefined;
  const group = findGroup(groupName);
  const key = groupName.toLowerCase();
  const prevShared = monitorGroupSticky.get(key)?.proxy;
  const prevTask = opts?.taskId ? stickyMap.get(opts.taskId)?.proxy : undefined;
  const prev = opts?.monitorShared === false ? prevTask : prevShared;

  if (opts?.taskId) {
    try {
      releaseSticky(opts.taskId);
    } catch {
      /* ignore */
    }
  }

  // Cool down the IP we leave (blocks / schedule) so pool advances
  if (prev) {
    const gCd = group?.cooldownMs && group.cooldownMs > 0 ? group.cooldownMs : 45_000;
    const soft =
      opts?.reason === 'schedule' || opts?.reason === 'latency'
        ? Math.min(gCd, opts?.cooldownPrevMs ?? 30_000)
        : opts?.cooldownPrevMs ?? gCd;
    markProxyFailed(prev, soft, groupName);
  }

  // Monitor fleet: rotate SHARED group IP
  if (opts?.monitorShared !== false) {
    const next = resolveMonitorSharedProxy(groupName, {
      forceRotate: true,
      reason: opts?.reason || 'manual',
    });
    lastIspRotate.set(key, {
      at: Date.now(),
      from: prev,
      to: next,
      reason: opts?.reason || 'manual',
    });
    return next;
  }

  // Checkout / per-task: pick next least-used excluding prev
  const list = group ? listProxies(group) : [];
  const open = availableList(list);
  let pool = filterRateLimited(open.length ? open : list);
  try {
    pool = filterByMaxLatency(pool, Number((loadSettings() as any).maxProxyLatencyMs) || 4500);
  } catch {
    /* */
  }
  if (!pool.length) pool = list;
  const next = pickNextIspProxy(pool, prev, 'least-used');
  if (opts?.taskId && next) {
    const stickyMs = (group?.stickyMinutes ?? 10) * 60_000;
    stickyMap.set(opts.taskId, {
      proxy: next,
      expires: Date.now() + Math.max(60_000, stickyMs),
    });
  }
  if (next) {
    useCount.set(next, (useCount.get(next) || 0) + 1);
    recordProxyRequest(next);
  }
  lastIspRotate.set(key, {
    at: Date.now(),
    from: prev,
    to: next,
    reason: opts?.reason || 'task_rotate',
  });
  return next;
}

/**
 * Scheduled ISP rotation helper for monitor loops.
 * Returns next proxy if rotation happened, else undefined.
 */
/** Min ms between schedule/latency rotates on same group (anti-thrash) */
const MIN_SCHEDULE_ROTATE_GAP_MS = 25_000;

export function maybeScheduleIspRotate(
  groupName: string | undefined,
  opts: {
    checksOnIp: number;
    everyN?: number;
    taskId?: string;
    lastMs?: number;
    maxLatencyMs?: number;
  }
): { rotated: boolean; proxy?: string; reason?: string; checksOnIp: number } {
  if (!groupName || !isIspGroup(groupName)) {
    return { rotated: false, checksOnIp: opts.checksOnIp };
  }
  const settings = loadSettings() as any;
  const stats = getProxyGroupStats(groupName);
  const availRatio = stats.total > 0 ? stats.available / stats.total : 1;

  // Adaptive schedule: slow down when pool is heating up
  let every = Math.max(
    0,
    Number(opts.everyN) || Number(settings.ispRotateEveryN) || 12
  );
  if (availRatio < 0.35) {
    // <35% free → stretch schedule (don't thrash last IPs)
    every = every > 0 ? Math.max(every * 2, every + 8) : 0;
  } else if (availRatio < 0.55) {
    every = every > 0 ? Math.max(every + 4, Math.ceil(every * 1.4)) : 0;
  }

  const maxLat =
    Number(opts.maxLatencyMs) ||
    Number(settings.maxProxyLatencyMs) ||
    8000;

  const key = groupName.toLowerCase();
  const lastRot = lastIspRotate.get(key);
  const gapOk = !lastRot || Date.now() - lastRot.at >= MIN_SCHEDULE_ROTATE_GAP_MS;

  // Latency rotate: only if pool has spare capacity
  if (opts.lastMs && opts.lastMs > maxLat && opts.checksOnIp >= 2 && gapOk && stats.available > 1) {
    const proxy = rotateIspProxy(groupName, {
      taskId: opts.taskId,
      reason: 'latency',
      monitorShared: true,
    });
    return { rotated: true, proxy, reason: 'latency', checksOnIp: 0 };
  }

  // Scheduled rotate: skip if pool almost empty
  if (every > 0 && opts.checksOnIp >= every && gapOk && stats.available > 1) {
    const proxy = rotateIspProxy(groupName, {
      taskId: opts.taskId,
      reason: 'schedule',
      monitorShared: true,
    });
    return { rotated: true, proxy, reason: 'schedule', checksOnIp: 0 };
  }

  return { rotated: false, checksOnIp: opts.checksOnIp };
}

/** True if group is ISP-typed (or name looks like ISP). */
export function isIspGroup(groupName?: string): boolean {
  if (!groupName) return false;
  const g = findGroup(groupName);
  if (!g) return /isp/i.test(groupName);
  return /isp/i.test(String(g.type || '')) || /isp/i.test(g.name);
}

/**
 * ISP policy for a task mode:
 * - monitor → shared pool sticky (resolveMonitorSharedProxy) + schedule rotate
 * - checkout → per-task sticky least-used
 */
export function resolveIspModeForTask(
  groupName?: string,
  taskMode?: string
): ProxyRotationMode | undefined {
  if (!isIspGroup(groupName)) return undefined;
  const m = String(taskMode || '').toLowerCase();
  if (m === 'monitor' || m === 'shipping' || m === 'watch') {
    return 'least-used';
  }
  return 'sticky';
}


/** Latency monitor for a named proxy group (ISP). */
export function getIspLatencyForGroup(groupName?: string, limit = 20): IspLatencyRow[] {
  if (!groupName) return getIspLatencyReport({ limit });
  const group = findGroup(groupName);
  const list = group ? listProxies(group) : [];
  return getIspLatencyReport({ groupProxies: list.length ? list : undefined, limit });
}

export function logIspLatencySummary(groupName?: string): string[] {
  const rows = getIspLatencyForGroup(groupName, 10);
  return rows.map(formatIspLatencyLine);
}

export { formatIspLatencyLine, type IspLatencyRow };
