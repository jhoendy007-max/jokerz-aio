import { loadSettings, loadProxies, ProxyGroup } from '../lib/storage';
import {
  markProxyFailed,
  releaseSticky,
  resolveProxyFromGroup,
  getProxyGroupStats,
  getGroupCooldownWaitMs,
  type ProxyRotationMode,
} from './proxy';
import { clearSession } from './session';
import { exponentialBackoff } from './notify';
import { profileForStore } from './moduleProfiles';

export type ThreatLevel = 'none' | 'low' | 'elevated' | 'high' | 'critical';

export interface AntiDetectDecision {
  threat: ThreatLevel;
  provider?: string | null;
  extraDelayMs: number;
  cooldownProxy: boolean;
  cooldownMs: number;
  softPause: boolean;
  rotateNow: boolean;
  forceMode?: ProxyRotationMode;
  action: string;
  recommendations: string[];
  /** Prefer waiting over burning more IPs */
  preferWait: boolean;
}

export interface AntiDetectApplyResult {
  decision: AntiDetectDecision;
  nextProxy?: string;
  rotated: boolean;
}

const defaultGroups: ProxyGroup[] = [];

/** Per-task recent block history (browser memory) */
const recentBlocks = new Map<
  string,
  { ts: number; provider: string; proxy?: string }[]
>();

function pushBlock(taskId: string, provider: string, proxy?: string) {
  const now = Date.now();
  const list = (recentBlocks.get(taskId) || []).filter((x) => now - x.ts < 15 * 60_000);
  list.push({ ts: now, provider, proxy });
  recentBlocks.set(taskId, list.slice(-30));
  return list;
}

function blocksInWindow(taskId: string, ms: number, provider?: string) {
  const now = Date.now();
  return (recentBlocks.get(taskId) || []).filter(
    (x) => now - x.ts <= ms && (!provider || x.provider === provider)
  ).length;
}

function threatFromFingerprint(
  provider?: string | null,
  confidence?: string,
  status?: number,
  browserFp?: boolean
): ThreatLevel {
  if (status === 429) return 'critical';
  if (!provider) return browserFp ? 'elevated' : 'none';
  const p = provider.toLowerCase();
  if (p === 'queue-it') return 'low';
  if (p === 'browser-fp') return confidence === 'high' ? 'high' : 'elevated';
  if (p === 'imperva') {
    return confidence === 'high' || confidence === 'medium' ? 'critical' : 'high';
  }
  if (p === 'shape' || p === 'kasada' || p === 'datadome') {
    return confidence === 'high' ? 'critical' : 'high';
  }
  // PerimeterX / Akamai: treat high conf as critical — DC dies fast
  if (p === 'perimeterx' || p === 'akamai') {
    if (confidence === 'high') return 'critical';
    if (confidence === 'medium') return 'high';
    return 'elevated';
  }
  if (p === 'cloudflare') {
    return confidence === 'high' ? 'high' : 'elevated';
  }
  if (p === 'recaptcha' || p === 'hcaptcha') return 'elevated';
  if (p === 'generic') return 'elevated';
  return 'low';
}

function groupMeta(groupName?: string): {
  cooldownMs?: number;
  type?: string;
  total: number;
  cooling: number;
  available: number;
} {
  if (!groupName) return { total: 0, cooling: 0, available: 0 };
  try {
    const stats = getProxyGroupStats(groupName);
    const groups = loadProxies(defaultGroups);
    const lower = groupName.toLowerCase();
    const g =
      groups.find((x) => x.name.toLowerCase() === lower) ||
      groups.find(
        (x) => lower.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(lower)
      );
    return {
      cooldownMs: g?.cooldownMs,
      type: (g?.type || stats.type || '').toLowerCase(),
      total: stats.total,
      cooling: stats.cooling,
      available: Math.max(0, (stats as any).available ?? stats.total - stats.cooling),
    };
  } catch {
    return { total: 0, cooling: 0, available: 0 };
  }
}

function aggressivenessMult(): number {
  const s = loadSettings() as { antiDetectAggressiveness?: number };
  const a = s.antiDetectAggressiveness ?? 2;
  // 1 soft, 2 balanced, 3 strict
  return a === 1 ? 0.75 : a === 3 ? 1.4 : 1;
}

/**
 * Adaptive anti-bot decision after a monitor/check result.
 * PerimeterX-aware: longer IP rest, avoid torching whole DC pools, escalate on streaks.
 */
export function decideAntiDetect(opts: {
  blocked?: boolean;
  fingerprint?: {
    provider?: string | null;
    confidence?: string;
    signals?: string[];
    browserFingerprint?: boolean;
    browserFpSignals?: string[];
  };
  status?: number;
  consecutiveErrors?: number;
  proxyGroup?: string;
  taskId?: string;
  proxy?: string;
  store?: string;
  error?: string;
}): AntiDetectDecision {
  let provider = opts.fingerprint?.provider || null;
  const confidence = opts.fingerprint?.confidence;
  const browserFp = !!(opts.fingerprint as any)?.browserFingerprint;
  const ce = opts.consecutiveErrors || 0;
  const profile = profileForStore(opts.store || '');
  const mult = aggressivenessMult() * (profile.antiDetectMult || 1);

  const meta = groupMeta(opts.proxyGroup);
  const isDc =
    meta.type.includes('dc') ||
    meta.type.includes('data') ||
    (opts.proxyGroup || '').toLowerCase().includes('dc');
  const isIsp =
    meta.type.includes('isp') ||
    meta.type.includes('resi') ||
    meta.type.includes('residential');

  // PKC: never treat as Shape (false positives burn pool 180s)
  let effectiveProvider = provider;
  const storeL = String(opts.store || '').toLowerCase();
  const isPkcStore = /pokemon|pkc/.test(storeL);
  if (isPkcStore && (provider === 'shape' || provider === 'kasada')) {
    effectiveProvider = 'datadome';
  }
  // Queue-it is not a block — soft info only
  if (provider === 'queue-it' || /in queue|queue-it|waiting room/i.test(opts.error || '')) {
    return {
      threat: 'none',
      provider: 'queue-it',
      extraDelayMs: 0,
      cooldownProxy: false,
      cooldownMs: 0,
      softPause: false,
      rotateNow: false,
      action: 'queue-it · hold position · no rotate',
      recommendations: ['Stay on same IP while in queue when possible'],
      preferWait: false,
    };
  }

  let threat = threatFromFingerprint(effectiveProvider, confidence, opts.status, browserFp);
  if (opts.blocked && threat === 'none') threat = 'elevated';
  // Module-specific escalation (Walmart→PX critical, Target→Shape, …)
  if (
    effectiveProvider &&
    profile.escalateProviders.some(
      (p) => effectiveProvider === p || (effectiveProvider || '').includes(p)
    )
  ) {
    if (threat === 'elevated') threat = 'high';
    if (threat === 'high' && (confidence === 'high' || opts.blocked)) threat = 'critical';
  }
  // Walmart PerimeterX: treat any medium+ PX as high minimum
  if (
    (profile.antibot === 'perimeterx' || profile.antibot === 'mixed') &&
    (effectiveProvider === 'perimeterx' || /px[_-]?captcha|perimeter/i.test(opts.error || ''))
  ) {
    if (threat === 'none' || threat === 'low') threat = 'elevated';
    if (threat === 'elevated' && opts.blocked) threat = 'high';
  }
  // Remap for rest of decision (shape→datadome on PKC)
  provider = effectiveProvider || provider;


  // Streak escalation
  const tid = opts.taskId || '_';
  if (opts.blocked || threat !== 'none') {
    if (provider) pushBlock(tid, provider, opts.proxy);
  }
  const pxRecent = blocksInWindow(tid, 5 * 60_000, 'perimeterx');
  const shapeRecent = blocksInWindow(tid, 5 * 60_000, 'shape');
  const anyRecent = blocksInWindow(tid, 3 * 60_000);
  if (pxRecent >= 4 && threat !== 'critical') threat = 'critical';
  else if (pxRecent >= 2 && threat === 'elevated') threat = 'high';
  if (shapeRecent >= 2) threat = 'critical';
  else if (shapeRecent >= 1 && (provider === 'shape' || opts.blocked)) threat = threat === 'critical' ? 'critical' : 'high';
  if (anyRecent >= 6) threat = 'critical';

  const settings = loadSettings() as { errorDelay?: number; proxyCooldownMs?: number };
  const errorBase = settings.errorDelay || 2000;
  const settingsCd = settings.proxyCooldownMs || 60_000;

  let extraDelayMs = 0;
  let cooldownProxy = false;
  let softPause = false;
  let rotateNow = false;
  let forceMode: ProxyRotationMode | undefined;
  let preferWait = false;
  const recommendations: string[] = [];
  let action = 'ok';

  // Pool health — don't rotate into empty
  const poolAlmostEmpty = meta.total > 0 && meta.available <= 1;
  const poolEmpty = meta.total > 0 && meta.available <= 0;

  if (threat === 'none' && !opts.blocked) {
    return {
      threat: 'none',
      provider,
      extraDelayMs: 0,
      cooldownProxy: false,
      cooldownMs: 0,
      softPause: false,
      rotateNow: false,
      action: 'ok',
      recommendations: [],
      preferWait: false,
    };
  }

  // ── Base by threat ─────────────────────────────────────────────
  if (threat === 'low') {
    extraDelayMs = Math.floor(jitter(2500, 0.35) * mult);
    action = 'low threat · mild delay';
  } else if (threat === 'elevated') {
    extraDelayMs = Math.floor(jitter(7000, 0.4) * mult);
    cooldownProxy = true;
    rotateNow = !poolEmpty;
    action = `${provider || 'block'} elevated · backoff + ${rotateNow ? 'rotate' : 'wait'}`;
    recommendations.push('Watch error rate; keep concurrency modest');
  } else if (threat === 'high') {
    extraDelayMs = Math.floor(jitter(14000, 0.4) * mult);
    cooldownProxy = true;
    rotateNow = !poolEmpty;
    softPause = ce >= 3;
    forceMode = isDc ? 'intelligent' : 'least-used';
    action = `${provider || 'block'} high · long backoff + rotate`;
    recommendations.push('Prefer ISP/residential over pure DC for this store');
    recommendations.push('Increase task delay to 6–10s');
    if (profile.antibot === 'perimeterx' || profile.id === 'Target') {
      recommendations.push('PX: ISP sticky + headed harvest _px3 + same IP on ATC');
    }
    if (profile.antibot === 'shape' || profile.id === 'Target') {
      recommendations.push('Target Shape: harvest _abck ~-1 + Chrome, do not mix IPs');
    }
  } else {
    // critical
    extraDelayMs = Math.floor(jitter(28_000, 0.45) * mult);
    cooldownProxy = true;
    softPause = true;
    rotateNow = meta.available > 2; // only rotate if pool has spare IPs
    preferWait = !rotateNow;
    forceMode = 'intelligent';
    action = `${provider || 'block'} critical · ${rotateNow ? 'rotate + long rest' : 'hold pool · long rest'}`;
    recommendations.push('Target/PX sees non-browser TLS (Node JA3) — ISP helps IP score, not JA3');
    recommendations.push('Lower maxConcurrent to 1–2');
    if (isDc) recommendations.push('Switch monitor proxy group to ISP/residential');
  }

  // ── Provider-specific tuning ───────────────────────────────────
  let baseCooldown = meta.cooldownMs || settingsCd;

  if (provider === 'perimeterx' || provider === 'akamai') {
    // PX: rest IP longer on DC; medium on ISP
    baseCooldown = isDc
      ? Math.max(baseCooldown, 180_000) // 3 min DC
      : Math.max(baseCooldown, 90_000);
    extraDelayMs = Math.max(extraDelayMs, Math.floor(8000 * mult));
    if (pxRecent >= 3) {
      extraDelayMs = Math.max(extraDelayMs, 25_000);
      preferWait = true;
      if (meta.available < 5) rotateNow = false; // stop torching
      action += ' · PX streak → slow mode';
      recommendations.push('PX streak: pause mass rotates; wait out cooldown');
    }
  }

  if (provider === 'shape' || provider === 'kasada') {
    // Target Shape: Node TLS + missing sensor_data cannot pass like Chrome.
    // Goal = stop IP burn + clear bad session, not "bypass Shape".
    const shapeHits = blocksInWindow(tid, 10 * 60_000, 'shape');
    baseCooldown = Math.max(baseCooldown, isDc ? 240_000 : 120_000); // 4 min DC / 2 min ISP (was 5/3)
    extraDelayMs = Math.max(extraDelayMs, Math.floor((shapeHits >= 2 ? 22_000 : 12_000) * mult));
    softPause = shapeHits >= 1;
    // Hold pool earlier when heat is high
    if (meta.available < 4 || shapeHits >= 2) {
      rotateNow = false;
      preferWait = true;
      action = `shape critical · hold pool (${shapeHits} hits/10m) · long rest`;
    } else {
      rotateNow = true;
      forceMode = 'intelligent';
      action = `shape · burn session + rotate · rest IP ${Math.round(baseCooldown / 1000)}s`;
    }
    recommendations.push(
      'Target uses Shape (+ Akamai). Node fetch JA3 ≠ Chrome — Shape scores automation high'
    );
    recommendations.push(
      'Mitigation: ISP/residential, 1 concurrent, long delay — real bypass needs browser (Playwright) + valid sensor'
    );
    recommendations.push('Do not hammer same product with thousands of DC IPs — Shape links velocity');
  }

  // Imperva (PKC Error 15): IP banned at edge — rotate clean ISP, browser won't help
  if (provider === 'imperva') {
    const invHits = blocksInWindow(tid, 10 * 60_000, 'imperva');
    // Match score ban floor: ISP 3–4 min soft CD; hard ban lives in proxyIntelligence (4h)
    baseCooldown = Math.max(baseCooldown, isDc ? 240_000 : 150_000);
    extraDelayMs = Math.max(extraDelayMs, Math.floor((invHits >= 2 ? 15_000 : 6_000) * mult));
    rotateNow = meta.available > 1;
    softPause = invHits >= 2; // pause earlier (was 3)
    forceMode = 'intelligent';
    action = `imperva Error15 · rotate clean ISP · rest ${Math.round(baseCooldown / 1000)}s`;
    recommendations.push('PKC Imperva Error 15 = IP blocked at edge — use unused residential/ISP');
    recommendations.push('Do not retry same IP; headed browser will not bypass IP ban');
    if (invHits >= 1) preferWait = meta.available < 4;
  }

  // DataDome (Pokemon Center): rotate ISP, shorter rest than Shape — browser pass may help
  if (provider === 'datadome') {
    const ddHits = blocksInWindow(tid, 10 * 60_000, 'datadome');
    baseCooldown = Math.max(baseCooldown, isDc ? 90_000 : 45_000); // 90s DC / 45s ISP (was 2m/1m)
    extraDelayMs = Math.max(
      extraDelayMs,
      Math.floor((ddHits >= 3 ? 10_000 : ddHits >= 1 ? 4000 : 2000) * mult)
    );
    rotateNow = meta.available > 1;
    softPause = ddHits >= 5; // slightly more tolerant before soft-pause
    forceMode = 'intelligent';
    action = `datadome · rotate ISP · rest ${Math.round(baseCooldown / 1000)}s`;
    recommendations.push('PKC DataDome: prefer clean ISP; TLS chrome136 (curl_cffi)');
    recommendations.push('If hard captcha: browser pass / CapMonster DataDome task');
    if (ddHits >= 3) {
      recommendations.push('DD streak: slow poll to 8–12s; stop burning pool');
      preferWait = meta.available < 3;
    }
  }

  // Low-confidence generic "tiny HTML" should not torch the pool
  if (
    (provider === 'generic' || !provider) &&
    confidence === 'low' &&
    opts.blocked
  ) {
    extraDelayMs = Math.min(extraDelayMs, Math.floor(4000 * mult));
    baseCooldown = Math.min(Math.max(baseCooldown, 20_000), 45_000);
    rotateNow = meta.available > 1;
    softPause = false;
    action = 'soft block · short rotate (low confidence)';
    recommendations.push('Low-confidence block — rotate once; avoid long Shape-style rests');
  }

  if (browserFp) {
    extraDelayMs = Math.max(extraDelayMs, 6000);
    recommendations.push('Browser FP signals — Node stack cannot fully spoof Chrome sensors');
  }

  if (opts.status === 429) {
    baseCooldown = Math.max(baseCooldown, 120_000);
    extraDelayMs = Math.max(extraDelayMs, exponentialBackoff(ce, 5000, 2, 120_000));
    rotateNow = meta.available > 0;
    action = '429 rate limit · cooldown IP';
  }

  // Consecutive errors escalate delay
  if (ce >= 2) {
    extraDelayMs = Math.max(
      extraDelayMs,
      exponentialBackoff(ce - 1, errorBase, 2, 90_000)
    );
  }

  // Pool empty → must wait
  if (poolEmpty || (poolAlmostEmpty && threat === 'critical')) {
    rotateNow = false;
    preferWait = true;
    const wait = getGroupCooldownWaitMs(opts.proxyGroup) || baseCooldown;
    extraDelayMs = Math.max(extraDelayMs, Math.min(wait, 120_000));
    action += ' · pool exhausted · wait';
    recommendations.push('Add more proxies or wait for cooldowns to expire');
  }

  // Soft aggressiveness=1: less rotate
  if ((loadSettings() as any).antiDetectAggressiveness === 1) {
    if (threat === 'elevated') rotateNow = false;
  }

  return {
    threat,
    provider,
    extraDelayMs: Math.floor(extraDelayMs),
    cooldownProxy,
    cooldownMs: Math.floor(
      (profile.blockCooldownMs || baseCooldown) * (threat === 'critical' ? 1.25 * mult : threat === 'high' ? 1.1 * mult : mult)
    ),
    softPause,
    rotateNow,
    forceMode,
    action,
    recommendations: [...new Set(recommendations)].slice(0, 5),
    preferWait,
  };
}

function jitter(base: number, pct: number) {
  const d = base * pct;
  return base - d + Math.random() * 2 * d;
}

/**
 * Apply decision: cooldown IP, maybe rotate, clear sticky session.
 */
export function applyAntiDetectRotation(
  decision: AntiDetectDecision,
  opts: {
    proxy?: string;
    taskId: string;
    proxyGroup?: string;
  }
): AntiDetectApplyResult {
  const failMeta = {
    provider: decision.provider || undefined,
    reason: decision.action,
    hardBan: (decision.provider || '').toLowerCase() === 'imperva',
  };
  if (decision.cooldownProxy && opts.proxy) {
    markProxyFailed(opts.proxy, decision.cooldownMs, opts.proxyGroup, failMeta);
  }

  let rotated = false;
  let nextProxy: string | undefined;

  if (decision.preferWait && !decision.rotateNow) {
    // Hold sticky release only if we still rotate later
    return { decision, nextProxy: undefined, rotated: false };
  }

  if (decision.rotateNow && opts.proxyGroup) {
    releaseSticky(opts.taskId);
    clearSession(opts.taskId);
    nextProxy = resolveProxyFromGroup(opts.proxyGroup, {
      taskId: opts.taskId,
      mode: decision.forceMode || 'intelligent',
    });
    if (nextProxy && opts.proxy && nextProxy === opts.proxy) {
      markProxyFailed(opts.proxy, decision.cooldownMs, opts.proxyGroup, failMeta);
      nextProxy = resolveProxyFromGroup(opts.proxyGroup, {
        taskId: opts.taskId,
        mode: 'least-used',
      });
    }
    rotated = !!(nextProxy && nextProxy !== opts.proxy);
  } else if (decision.rotateNow) {
    releaseSticky(opts.taskId);
    clearSession(opts.taskId);
  }

  return { decision, nextProxy, rotated };
}

/** @deprecated */
export function applyAntiDetectProxy(decision: AntiDetectDecision, proxy?: string) {
  if (decision.cooldownProxy && proxy) {
    markProxyFailed(proxy, decision.cooldownMs);
  }
}

export function antiDetectProfileLabel(): string {
  const s = loadSettings() as { antiDetectAggressiveness?: number; proxyRotation?: string };
  const a = s.antiDetectAggressiveness ?? 2;
  const names = ['', 'Soft', 'Balanced', 'Strict'];
  return `${names[a] || 'Balanced'} · rotation ${s.proxyRotation || 'round-robin'}`;
}

export function describeGroupRotation(proxyGroup?: string): string {
  if (!proxyGroup) return 'no group';
  const stats = getProxyGroupStats(proxyGroup);
  return `${stats.name} · ${stats.mode} · ${stats.total} proxies · ${stats.cooling} cooling`;
}
