import { recordMonitorHealth } from '../../lib/monitorHealth';
import { parseApi, MonitorResponseSchema, ApiResponseSchema, stockFromMonitor, rateLimitWaitMs, rlFields, type StockResult } from '../apiTypes';
import { API_BASE } from '../apiBase';
import { StoreModule, EngineTaskConfig, EngineEvent } from '../types';
import { log, setStatus, sleep } from './base';
import { jitterDelay, playAlertSound, exponentialBackoff } from '../notify';
import { loadSettings, resolveProfile } from '../../lib/storage';
import { httpRequest, isCorsOrNetworkError } from '../http';
import { createTickScope, isAbortError } from '../abort';
import { withRetry, isRetryableStockError } from '../retry';
import { resolveProxyFromGroup, resolveMonitorSharedProxy, getProxyGroupStats, markProxyFailed, releaseSticky, recordProxyResult, proxyRetryAfterMs, getGroupCooldownWaitMs, clearGroupProxyCooldowns, peekProxiesFromGroup, rotateIspProxy, isIspGroup, resolveIspModeForTask, getIspLatencyForGroup, logIspLatencySummary, maybeScheduleIspRotate, getIspRotationState, resolveRoleProxy, proxyBindMode, proxyRoleGroup, harvestSameAsCheckout } from '../proxy';
import { decideAntiDetect, applyAntiDetectRotation, describeGroupRotation } from '../antiDetect';
import { maybeAutoRotate } from '../autoRotate';
import { ensureSession, absorbSetCookies, absorbPlaywrightCookies, cookieHeader, sessionStats } from '../session';
import { sendDiscordWebhook, sendAlert } from '../webhooks';
import { resolveTaskSettings, settingsLogLine } from '../taskSettings';
import { profileForStore } from '../moduleProfiles';
import { mergeModuleHeaders } from '../headerPresets';
import { getActiveProfileForStore } from '../fingerprintProfiles';
import { accountsForStore } from '../../lib/storeFolders';



/** Smart cookie rotation — block-driven + settings-driven auto */
function cookieRotateConfig() {
  try {
    const s = loadSettings() as any;
    return {
      softEvery: Math.max(0, Number(s.cookieAutoRotateEvery ?? s.autoRotateEvery ?? 12) || 12),
      minGapMs: Math.max(8_000, Number(s.cookieRotateMinGapMs ?? 12_000) || 12_000),
      slotGapMs: Math.max(1_500, Number(s.cookieSlotGapMs ?? 2_500) || 2_500),
      afterErrors: Math.max(1, Number(s.cookieRotateAfterErrors ?? 2) || 2),
      /** minutes on same cookie jar before soft rotate (0 = off) */
      softMinutes: Math.max(0, Number(s.cookieAutoRotateMinutes ?? 0) || 0),
    };
  } catch {
    return { softEvery: 12, minGapMs: 12_000, slotGapMs: 2_500, afterErrors: 2, softMinutes: 0 };
  }
}

type CookieRotState = {
  lastRotateAt: number;
  softFails: number;
  hasBankCookies: boolean;
  bankId?: string;
};

const cookieRotState = new Map<string, CookieRotState>();

function getRotState(taskId: string): CookieRotState {
  let s = cookieRotState.get(taskId);
  if (!s) {
    s = { lastRotateAt: 0, softFails: 0, hasBankCookies: false };
    cookieRotState.set(taskId, s);
  }
  return s;
}


/** Per-TCIN stock alert cooldown (ms). Override: TARGET_STOCK_ALERT_COOLDOWN_MS */
const stockAlertLast = new Map<string, number>();
function stockAlertCooldownMs(): number {
  const n = Number((globalThis as any).process?.env?.TARGET_STOCK_ALERT_COOLDOWN_MS);
  // Vite/browser: default 3 minutes
  return Number.isFinite(n) && n > 0 ? n : 180_000;
}
function shouldSendStockAlert(
  tcin: string,
  taskCooldownMs?: number,
  taskId?: string
): boolean {
  const key = `${taskId || 'global'}:${String(tcin || '').trim()}`;
  if (!String(tcin || '').trim()) return true;
  const now = Date.now();
  const last = stockAlertLast.get(key) || 0;
  const cd =
    typeof taskCooldownMs === 'number' && !Number.isNaN(taskCooldownMs)
      ? Math.max(0, taskCooldownMs)
      : stockAlertCooldownMs();
  if (cd > 0 && now - last < cd) return false;
  stockAlertLast.set(key, now);
  return true;
}

async function injectBankCookies(
  taskId: string,
  module: string,
  proxy: string | undefined,
  emit: (e: EngineEvent) => void,
  signal?: AbortSignal,
  opts?: { rotate?: boolean; requireSameProxy?: boolean }
): Promise<boolean> {
  try {
    if (opts?.rotate) {
      try {
        await httpRequest(`${API_BASE}/api/browser/session/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { sessionId: taskId },
          signal,
        });
      } catch {
        /* optional */
      }
    }
    const res = await httpRequest(`${API_BASE}/api/harvest/bank/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        sessionId: taskId,
        taskId,
        module,
        proxy,
        // Automatic rotation: keep in bank + cooldown (do NOT consume)
        consume: false,
        rotate: true,
        resetSession: !!opts?.rotate,
        cooldownMs: cookieRotateConfig().slotGapMs,
        requireSameProxy: opts?.requireSameProxy !== false,
      },
      signal,
    });
    const data = parseApi(ApiResponseSchema, res);
    const st = getRotState(taskId);
    if (data.ok && data.injected > 0) {
      if (opts?.requireSameProxy !== false && proxy && data.sameProxy === false) {
        st.hasBankCookies = false;
        log(emit, taskId, 'warn', 'Shape+PX not same ISP · skip ATC · harvest this proxy');
        return false;
      }
      st.lastRotateAt = Date.now();
      st.softFails = 0;
      st.hasBankCookies = true;
      st.bankId = data.bankId;
      log(
        emit,
        taskId,
        'info',
        `${opts?.rotate ? 'Auto cookie rotate' : 'Shape+PX LIVE'} → session · _abck ~${data.abckFlag || '-'} PX=${data.pxValid ? 'yes' : 'no'} · ${data.injected} ck · sameIP=${data.sameProxy ? 'yes' : 'no'} · bank ${data.bank?.valid ?? data.bank?.count ?? '?'}`
      );
      return true;
    }
    if (res.status === 404) {
      st.hasBankCookies = false;
      log(
        emit,
        taskId,
        opts?.rotate ? 'warn' : 'info',
        opts?.rotate
          ? 'Cookie rotate skipped — bank empty (keeping current session)'
          : data.error || 'Cookie bank empty / no same-ISP · skip ATC'
      );
      return false;
    }
    log(emit, taskId, 'warn', data.error || 'Bank inject failed');
    return false;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    log(emit, taskId, 'warn', `Bank inject skip: ${e?.message || e}`);
    return false;
  }
}

/**
 * Rotate when:
 *  - hard block (always, if gap ok)
 *  - soft fails streak
 *  - soft interval only if already using bank cookies and gap ok
 * Never rotate if bank empty (inject no-ops without clearing working session on soft path).
 */
async function maybeRotateCookies(opts: {
  taskId: string;
  module: string;
  proxy?: string;
  emit: (e: EngineEvent) => void;
  signal: AbortSignal;
  ticks: number;
  blocked: boolean;
  softFail?: boolean;
  force?: boolean;
}): Promise<boolean> {
  const st = getRotState(opts.taskId);
  const now = Date.now();
  const cfg = cookieRotateConfig();

  if (opts.softFail) st.softFails++;
  else if (!opts.blocked) st.softFails = 0;

  const hard = opts.force || opts.blocked;
  const gapOk = now - st.lastRotateAt >= (hard ? Math.min(cfg.minGapMs, 4_000) : cfg.minGapMs);
  const softStreak = st.softFails >= cfg.afterErrors;
  const softInterval =
    st.hasBankCookies &&
    cfg.softEvery > 0 &&
    opts.ticks > 0 &&
    opts.ticks % cfg.softEvery === 0;
  const softTtl =
    st.hasBankCookies &&
    cfg.softMinutes > 0 &&
    st.lastRotateAt > 0 &&
    now - st.lastRotateAt >= cfg.softMinutes * 60_000;

  let reason: string | null = null;
  if (hard && gapOk) reason = opts.blocked ? 'blocked' : 'forced';
  else if (hard && !gapOk) {
    log(
      opts.emit,
      opts.taskId,
      'info',
      `Cookie rotate deferred (${Math.round((cfg.minGapMs - (now - st.lastRotateAt)) / 1000)}s cooldown)`
    );
    return false;
  } else if (softStreak && gapOk) reason = `soft-fails×${st.softFails}`;
  else if (softTtl && gapOk) reason = `cookie TTL ${cfg.softMinutes}m`;
  else if (softInterval && gapOk) reason = `every ${cfg.softEvery} ticks`;

  if (!reason) return false;

  log(opts.emit, opts.taskId, 'info', `Auto cookie rotation (${reason})…`);
  const ok = await injectBankCookies(opts.taskId, opts.module, opts.proxy, opts.emit, opts.signal, {
    rotate: true,
  });
  if (!ok && hard) st.softFails = 0;
  return ok;
}



async function pingTargetMetric(event: string, tcin?: string, message?: string) {
  try {
    await fetch(`${API_BASE}/api/target/metrics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, tcin, message }),
    });
  } catch {
    /* */
  }
}

/** host:port:user:pass → user:pass@host:port for API */
function normalizeProxyClient(proxy?: string): string | undefined {
  if (!proxy || !proxy.trim()) return undefined;
  const p = proxy.trim();
  if (/^https?:\/\//i.test(p) || p.includes('@')) return p;
  const parts = p.split(':');
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return `${user}:${rest.join(':')}@${host}:${port}`;
  }
  return p;
}


async function checkTargetStock(

  tcin: string,
  signal: AbortSignal,
  proxy?: string,
  cookie?: string,
  sessionId?: string,
  extra?: { storeId?: string; zip?: string; proxies?: string[] }
): Promise<StockResult> {
  try {
    const res = await httpRequest(`${API_BASE}/api/monitor/target`, {
      method: 'POST',
      signal,
      timeoutMs: 18000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: {
        tcin,
        proxy: normalizeProxyClient(proxy) || undefined,
        cookie: cookie || undefined,
        storeId: extra?.storeId,
        zip: extra?.zip,
        // Stable session per task — shared with checkout when same taskId / ping starts checkout task
        // taskId for logs; sessionId only if provided (per-task+tcin isolation)
        taskId: sessionId || undefined,
        sessionId: sessionId || undefined,
        preferTls: true,
        allowBrowser: true,
        useCookies: false,
        debug: false,
        fingerprintProfile: getActiveProfileForStore('target').id,
        tlsClient: getActiveProfileForStore('target').tlsClient,
      },
    });

    let data: any = {};
    try {
      data = parseApi(MonitorResponseSchema, res);
      recordMonitorHealth('Target', tcin, data);
    } catch {
      return {
        ...rlFields(data),
        inStock: false,
        error: `Bad JSON from API (${res.status}) — restart npm run server after update`,
        tcin,
      };
    }

    if (res.status === 0 || (res.status >= 500 && !data?.ok)) {
      return {
        ...rlFields(data),
        inStock: false,
        error:
          data?.error ||
          `API HTTP ${res.status} — check server terminal for [monitor/target] error`,
        tcin,
      };
    }

    // CORS / network often status 0
    if (!res.ok && !data.ok && !data.availabilityStatus && data.error) {
      return {
        ...rlFields(data),
        inStock: false,
        error: data.error,
        blocked: !!data.blocked,
        ms: data.ms,
        tcin,
        fingerprint: data.fingerprint,
      };
    }

    return {
      ...rlFields(data),
      inStock: !!data.inStock,
      quantity: typeof data.quantity === 'number' ? data.quantity : undefined,
      price: data.price,
      title: data.title,
      ms: data.ms,
      error: data.error,
      availabilityStatus: data.availabilityStatus,
      source: data.source || data.via,
      via: data.via,
      blocked: data.blocked,
      unknown: !!data.unknown,
      fingerprint: data.fingerprint,
      setCookie: data.setCookie,
      tcin: data.tcin || tcin,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (isAbortError(err)) throw err;
    if (isCorsOrNetworkError(err)) {
      return {
        inStock: false,
        error: 'Cannot reach API (/api/monitor/target). Run: npm run server',
        tcin,
      };
    }
    return {
      inStock: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      tcin,
    };
  }
}


/** Parse product field: newline / comma / space separated TCINs or Target URLs */
function parseTcins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const parts = String(raw)
    .split(/[\n,;|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/\/A-(\d{8,})/i) || s.match(/[?&]tcin=(\d+)/i) || s.match(/\b(\d{8,9})\b/);
      if (m) return m[1];
      return s.replace(/^https?:\/\/\S+/i, '').trim() || s;
    })
    .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter((s) => s.length >= 4);
  return [...new Set(parts)];
}

function resolveTargetAccount(task: EngineTaskConfig) {
  const profile = resolveProfile(task.profileId, {
    taskId: task.id,
    rotate: !!(task as any).rotateProfiles,
  });
  const settings = loadSettings();
  const targetAccounts = accountsForStore(settings, 'Target');
  const linkedEmail = String(
    (task.extras as any)?.accountEmail || (task as any).accountEmail || profile?.email || ''
  ).trim();
  const account =
    targetAccounts.find(
      (a: any) =>
        a.email &&
        linkedEmail &&
        String(a.email).trim().toLowerCase() === linkedEmail.toLowerCase()
    ) ||
    targetAccounts.find(
      (a: any) =>
        a.email &&
        profile?.email &&
        String(a.email).trim().toLowerCase() === String(profile.email).trim().toLowerCase()
    );
  const loginEmail = String(account?.email || linkedEmail || '').trim();
  const loginPass = String((account as any)?.pass || (account as any)?.password || '').trim();
  const totp = String((account as any)?.totp || (account as any)?.totpSecret || '').trim();
  return { profile, account, loginEmail, loginPass, totp };
}

async function loginTargetOnTask(
  task: EngineTaskConfig,
  signal: AbortSignal,
  emit: (e: EngineEvent) => void
): Promise<{ loginEmail: string; loginPass: string; proxy?: string; profile: any; account: any }> {
  const id = task.id;
  const { loginEmail, loginPass, profile, account, totp } = resolveTargetAccount(task);
  if (!loginEmail || !loginPass) {
    throw new Error(
      !loginEmail
        ? 'Pick an account on the task (Settings → Accounts = email + password)'
        : `No password for ${loginEmail} in Settings → Accounts`
    );
  }
  const proxy = resolveRoleProxy(task, 'login', id);
  const harvestProxy = resolveRoleProxy(task, 'harvest', id);
  const bind = proxyBindMode(task);
  log(
    emit,
    id,
    'info',
    bind === 'split'
      ? `Proxy SPLIT · login ${proxyRoleGroup(task, 'login')} · harvest ${proxyRoleGroup(task, 'harvest')} · checkout ${proxyRoleGroup(task, 'checkout')}`
      : `Proxy SAME · sticky ${proxyRoleGroup(task, 'login')} · login=harvest=ATC`
  );
  log(emit, id, 'info', `Login → /login · ${loginEmail}`);
  setStatus(emit, id, 'running', `Login ${loginEmail}…`);
  const lr = await httpRequest(`${API_BASE}/api/target/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      email: loginEmail,
      password: loginPass,
      proxy,
      sessionId: id,
      totp: totp || undefined,
      headed: true,
      forceLogin: !!(task as any).forceLogin,
    },
    signal,
    timeoutMs: 180000,
  });
  const ld = parseApi(ApiResponseSchema, lr);
  if (!ld.ok) throw new Error(ld.message || ld.error || 'Login failed');
  absorbPlaywrightCookies(id, ld.cookies, {
    proxy,
    proxyGroup: task.proxyGroup,
    store: 'Target',
    kind: 'checkout',
    accountEmail: loginEmail,
  });
  ensureSession(id, {
    proxy,
    proxyGroup: task.proxyGroup,
    store: 'Target',
    kind: 'checkout',
    accountEmail: loginEmail,
  });
  log(
    emit,
    id,
    'success',
    ld.fromCache
      ? `Sticky session · ${loginEmail} · saved on this task`
      : `Logged in · ${loginEmail} · session saved on this task`
  );
  const isp = proxy ? String(proxy).split('@').pop() || proxy : 'local';
  try {
    const hr = await httpRequest(`${API_BASE}/api/harvest/task-bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        taskId: id,
        proxy: harvestProxy || proxy,
        name: `Task ${loginEmail.split('@')[0] || id.slice(0, 6)}`,
        module: 'target-shape',
      },
      signal,
      timeoutMs: 15000,
    });
    const hd: any = parseApi(ApiResponseSchema, hr);
    log(
      emit,
      id,
      hd.ok ? 'success' : 'warn',
      hd.message || `harvest bind · ${isp}`
    );
  } catch (e: any) {
    log(emit, id, 'warn', `harvest bind skip: ${e?.message || e}`);
  }
  setStatus(emit, id, 'queued', `Logged in · harvest on ${isp}`);
  return { loginEmail, loginPass, proxy, profile, account };
}

export const TargetModule: StoreModule = {
  name: 'Target',
  supportedModes: ['shipping', 'pickup', 'monitor'],

  validate(task) {
    if (!task.product) return 'TCIN / Input List is required';
    if (!task.profileId && task.mode !== 'monitor') return 'Profile is required';
    if (task.mode !== 'monitor' && !String((task.extras as any)?.accountEmail || '').trim()) {
      return 'Pick an account on the checkout task';
    }
    return null;
  },

  async login(task, signal, emit) {
    await loginTargetOnTask(task, signal, emit);
  },

  async keepAlive(task, signal, emit) {
    const id = task.id;
    const { loginEmail } = resolveTargetAccount(task);
    const proxy = resolveProxyFromGroup(task.proxyGroup, { taskId: id });
    const res = await httpRequest(`${API_BASE}/api/target/keepalive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { sessionId: id, taskId: id, email: loginEmail, proxy },
      signal,
      timeoutMs: 20000,
    });
    const data: any = parseApi(ApiResponseSchema, res);
    log(emit, id, data.ok ? 'info' : 'warn', data.message || data.error || `keepalive HTTP ${res.status}`);
  },

  async run(task: EngineTaskConfig, signal: AbortSignal, emit: (e: EngineEvent) => void) {
    const id = task.id;
    const mode = task.mode || 'shipping';
    const tcins = parseTcins(task.product);
    if (!tcins.length) {
      setStatus(emit, id, 'failed', 'No TCIN');
      log(emit, id, 'error', 'No TCIN parsed from product field');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: 'No TCIN' });
      return;
    }
    // highStockOnly resolved via resolveTaskSettings in monitor loop

    if (mode === 'monitor') {
      setStatus(emit, id, 'running', 'Monitoring Target...');
      log(emit, id, 'info', `Target monitor · TCIN(s): ${tcins.join(', ')}`);
      log(emit, id, 'info', 'Shipping ONLY · no pickup/in-store · no cookies · 1 SKU = 1 status');
      
      const settings = loadSettings();
      const errorBase = settings.errorDelay || 2000;
      const ts = resolveTaskSettings(task, {
        delay: task.delay || 4000,
        reset: settings.retryDelay || 7500,
      });
      const pollDelay = ts.pollDelayMs;
      const resetDelayMs = ts.resetDelayMs;
      const highStockOnly = ts.monitorHighStock;
      const modProfile = profileForStore(String(task.store || ''));


      log(emit, id, 'info', `API: ${API_BASE || '(vite /api proxy)'} · ${settingsLogLine(ts)}`);
      log(emit, id, 'info', `Module profile: ${modProfile.antibot} · ${modProfile.notes}`);
      // Preflight API so user sees failure immediately
      try {
        const hr = await httpRequest(`${API_BASE}/health`, { method: 'GET', signal, timeoutMs: 4000 });
        if (!hr.ok && hr.status !== 200) {
          log(emit, id, 'warn', `API health HTTP ${hr.status} — monitor may fail`);
        } else {
          log(emit, id, 'success', 'API health OK');
        }
      } catch {
        try {
          const hr2 = await httpRequest(`${API_BASE}/api/health`, { method: 'GET', signal, timeoutMs: 4000 });
          log(emit, id, hr2.ok ? 'success' : 'warn', `API /api/health ${hr2.status}`);
        } catch (e: any) {
          log(
            emit,
            id,
            'error',
            `API unreachable from UI — start npm run server (vite proxies /api → 8787). ${e?.message || e}`
          );
        }
      }
      if (ts.monitorHighStock) log(emit, id, 'info', 'High stock filter enabled (10+)');

      // Fresh Start: release sticky + clear IP cooldowns for this group
      // (previous PerimeterX blocks should not force a 2min wait after manual Start)
      if (task.proxyGroup) {
        releaseSticky(id);
        const cleared = clearGroupProxyCooldowns(task.proxyGroup);
        if (cleared > 0) {
          log(emit, id, 'info', `Cleared cooldown on ${cleared} proxy IP(s) for fresh start`);
        }
      }
      const proxyStats = getProxyGroupStats(task.proxyGroup);
      if (proxyStats.total > 0) {
        // Stellar-style: ALL monitors on this group share 1 sticky IP (even across modules)
        const shared = resolveMonitorSharedProxy(task.proxyGroup);
        const tip = shared ? shared.split('@').pop() || shared : 'pending';
        log(
          emit,
          id,
          'info',
          `Shared monitor IP · group "${proxyStats.name}" · ${proxyStats.total} line(s) · sticky ${tip} · mode ${proxyStats.mode}`
        );
      } else if (task.proxyGroup && task.proxyGroup !== 'Localhost') {
        log(emit, id, 'warn', `Proxy group "${task.proxyGroup}" has 0 proxies — direct connection`);
      } else {
        log(emit, id, 'info', 'No proxy group · direct connection');
      }

      let ticks = 0;
      let consecutiveErrors = 0;
      /** Per-TCIN stock edge — never share OOS/IN STOCK across different SKUs on same task */
      const lastInStockByTcin = new Map<string, boolean>();
      let lastWasError = false;
      const lastPriceByTcin = new Map<string, string>();
      let checksOnIp = 0;
      
      const maxErrors = Math.max(1, settings.maxRetries || 3) + 5; // soft cap before fail
      let tcinIndex = 0;
      

      let tickScope: ReturnType<typeof createTickScope> | null = null;

      while (!signal.aborted) {
        ticks++;
        // Cancel any in-flight request from the previous tick (overlap protection)
        tickScope?.abort('next-tick');
        tickScope = createTickScope(signal);
        const tickSignal = tickScope.signal;

        const tcin = tcins[tcinIndex % tcins.length];
        tcinIndex++;
        // Stellar-style: every monitor on this group reuses the SAME sticky IP
        // (Target + Walmart + PKC + Bandai). 1 ISP is enough for many monitor tasks.
        let proxy = resolveMonitorSharedProxy(task.proxyGroup);
        if (!proxy && task.proxyGroup && task.proxyGroup !== 'Localhost') {
          const waitCd = getGroupCooldownWaitMs(task.proxyGroup);
          const waitBase = Math.min(Math.max(waitCd, 500), 15_000);
          const wait = jitterDelay(waitBase, settings?.jitterPercent ?? 20, 200);
          log(
            emit,
            id,
            'warn',
            `Shared monitor IP unavailable (hard-ban?) · wait ${Math.round(wait / 1000)}s · task ${id.slice(0, 6)} · TCIN ${tcin}`
          );
          await sleep(wait, signal);
          proxy = resolveMonitorSharedProxy(task.proxyGroup);
        }
        const waitRl = Math.min(proxyRetryAfterMs(proxy), task.mode === 'monitor' ? 3000 : proxyRetryAfterMs(proxy));
        if (waitRl > 0) {
          const waitRlJ = jitterDelay(waitRl, Math.min(15, settings?.jitterPercent ?? 15), 50);
          log(emit, id, 'info', `Rate limit · wait ${waitRlJ}ms before ${proxy?.split('@').pop() || 'proxy'}`);
          await sleep(waitRlJ, signal);
          proxy = resolveProxyFromGroup(task.proxyGroup, { taskId: id });
        }

        try {
          ensureSession(id, { proxy, proxyGroup: task.proxyGroup, store: 'Target', kind: 'monitor', touchExpiry: true });
          const proxyHint = proxy ? proxy.split('@').pop() || proxy : 'direct';
          log(emit, id, 'info', `Checking ${tcin} via ${proxyHint}… · task ${id.slice(0, 6)}`);
          if (!proxy && task.proxyGroup && task.proxyGroup !== 'Localhost') {
            log(emit, id, 'error', `No proxy available for ${tcin} — add more IPs or Unban in Proxies scores`);
            consecutiveErrors++;
            await sleep(jitterDelay(2000, 20), signal);
            continue;
          }
          const moreProxies =
            task.mode === 'monitor'
              ? peekProxiesFromGroup(task.proxyGroup, 3)
              : [];
          // sessionId unique per task+TCIN so server never mixes two monitor SKUs
          const monitorSessionId = `${id}__${tcin}`;
          const profileZip = resolveProfile(task.profileId, { taskId: id })?.zip;
          const result = await checkTargetStock(
            tcin,
            tickSignal,
            proxy,
            cookieHeader(id),
            monitorSessionId,
            {
              storeId: (task as any).storeId,
              zip:
                String((task as any).zip || (task as any).profileZip || profileZip || '')
                  .replace(/\D/g, '')
                  .slice(0, 5) || undefined,
              proxies: moreProxies,
            }
          );
          // Honor server 429 / Retry-After: pause this task instead of retrying immediately.
          const rlWait = rateLimitWaitMs(result, pollDelay);
          if (rlWait > 0) {
            log(emit, id, 'warn', `RATE LIMITED (429) · pausing ${Math.round(rlWait / 1000)}s${result.retryAfterMs ? ' (Retry-After)' : ''}`);
            setStatus(emit, id, 'running', `Rate limited · retry in ${Math.round(rlWait / 1000)}s`);
            await sleep(rlWait, signal);
            continue;
          }
          // Hard reject if API returned a different tcin
          if (result.tcin && String(result.tcin).replace(/\D/g, '') !== String(tcin).replace(/\D/g, '')) {
            log(
              emit,
              id,
              'warn',
              `TCIN mismatch from API · asked ${tcin} got ${result.tcin} — ignoring`
            );
            continue;
          }
          recordProxyResult(proxy, {
            ok: !result.error && !result.blocked,
            blocked: !!result.blocked || /blocked|429/i.test(result.error || ''),
            ms: result.ms,
            provider: (result as any).fingerprint?.provider || undefined,
            reason: result.error,
          });

          // ISP latency monitor (every 10 ticks)
          if (task.mode === 'monitor' && ticks % 10 === 0 && task.proxyGroup) {
            const lines = logIspLatencySummary(task.proxyGroup);
            if (lines.length) {
              log(emit, id, 'info', `ISP latency · ${task.proxyGroup}`);
              for (const line of lines.slice(0, 5)) {
                log(emit, id, 'info', `  ${line}`);
              }
            }
          }

          // Proactive ISP rotation: every N checks or high latency
          if (task.mode === 'monitor' && isIspGroup(task.proxyGroup) && !result.error) {
            checksOnIp++;
            const rot = maybeScheduleIspRotate(task.proxyGroup, {
              checksOnIp,
              everyN:
                Number((task.extras as any)?.ispRotateEveryN) ||
                Number((loadSettings() as any).ispRotateEveryN) ||
                8,
              taskId: id,
              lastMs: result.ms,
            });
            checksOnIp = rot.checksOnIp;
            if (rot.rotated && rot.proxy) {
              log(
                emit,
                id,
                'info',
                `ISP ${rot.reason} rotate → ${rot.proxy.split('@').pop() || rot.proxy}`
              );
            }
          }
          // Only hard blocks (server blocked:true) — ignore "PerimeterX script present"
          if (result.blocked || /BAD PROXY|HTTP 403|RedSky failed/i.test(result.error || '') || result.fingerprint?.detected) {
            setStatus(
              emit,
              id,
              'failed',
              /BAD PROXY/i.test(result.error || '')
                ? 'BAD PROXY'
                : result.fingerprint?.detected
                  ? `FP:${result.fingerprint.provider || 'block'}`
                  : 'BLOCKED'
            );
            if (proxy) markProxyFailed(proxy);
            const next = rotateIspProxy(task.proxyGroup, { taskId: id, reason: 'block', monitorShared: true });
            if (next && next !== proxy) {
              log(emit, id, 'warn', `ISP rotate → ${next.split('@').pop() || next}`);
            }
            await maybeRotateCookies({
              taskId: id,
              module: 'target-shape',
              proxy,
              emit,
              signal,
              ticks,
              blocked: true,
            });
          } else if (result.error) {
            await maybeRotateCookies({
              taskId: id,
              module: 'target-shape',
              proxy,
              emit,
              signal,
              ticks,
              blocked: false,
              softFail: true,
            });
          }
          if (result.setCookie) absorbSetCookies(id, result.setCookie, proxy);
          const ms = result.ms ?? 0;

          if (result.blocked) void pingTargetMetric('monitor_blocked', String(tcin), result.error);
          else if (!result.error) void pingTargetMetric('monitor_ok', String(tcin));
          if (result.error && !result.inStock) {
            consecutiveErrors++;
            lastWasError = true;
            const proxyTag = proxy ? ` · via ${proxy.split('@').pop()}` : '';
            const fpTag = result.fingerprint?.provider
              ? ` · fp:${result.fingerprint.provider}/${result.fingerprint.confidence || '?'}`
              : '';
            if (result.fingerprint?.signalDetails?.length) {
              const top = result.fingerprint.signalDetails.slice(0, 3)
                .map((s: { what: string }) => s.what)
                .join(' | ');
              log(emit, id, 'warn', `FP signals: ${top}`);
              if ((result.fingerprint as any)?.browserFingerprint) {
                const bfs = ((result.fingerprint as any).browserFpSignals || []).slice(0, 5).join(', ');
                log(
                  emit,
                  id,
                  'error',
                  `Browser fingerprint block · ${bfs || 'environment/sensor signals'} — use real browser profile / residential ISP`
                );
              }
            }
            log(
              emit,
              id,
              consecutiveErrors >= 3 ? 'warn' : 'info',
              `Check #${ticks} [${tcin}]${ms ? ` (${ms}ms)` : ''} — ${result.error}${proxyTag}${fpTag}`
            );
            if (result.rateLimited || /RATE LIMIT/i.test(result.error || '')) {
              const wait = Number(result.retryAfterMs) || 45000 + Math.floor(Math.random() * 20000);
              log(emit, id, 'warn', `Drop RL · sit on sticky ISP ${Math.round(wait / 1000)}s (no rotate)`);
              await sleep(wait, signal);
            }

            
            // Adaptive anti-detection ↔ proxy rotation
            {
              const decision = decideAntiDetect({ taskId: id, store: String(task.store || ''), proxy,
                blocked: result.blocked || /blocked|429|challenge/i.test(result.error || ''),
                fingerprint: result.fingerprint,
                consecutiveErrors,
                proxyGroup: task.proxyGroup,
              });
              if (decision.threat === 'critical' && (decision.provider === 'shape' || decision.provider === 'perimeterx')) {
                try {
                  void fetch(`${API_BASE}/api/browser/session/clear`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: id, taskId: id }),
                  });
                  log(emit, id, 'info', 'Browser session cleared after critical block');
                } catch { /* ignore */ }
              }
              if (decision.threat !== 'none') {
                log(emit, id, decision.threat === 'critical' ? 'error' : 'warn', `AntiDetect: ${decision.action}`);
                const applied = applyAntiDetectRotation(decision, {
                  proxy,
                  taskId: id,
                  proxyGroup: task.proxyGroup,
                });
                if (applied.rotated && applied.nextProxy) {
                  log(
                    emit,
                    id,
                    'info',
                    `Rotation: switched → ${applied.nextProxy.split('@').pop()} · ${describeGroupRotation(task.proxyGroup)}`
                  );
                } else if (decision.rotateNow) {
                  log(emit, id, 'info', `Rotation: sticky released · ${describeGroupRotation(task.proxyGroup)}`);
                }
                if (decision.extraDelayMs > 0) {
                  log(emit, id, 'info', `AntiDetect wait ${Math.round(decision.extraDelayMs)}ms`);
                  await sleep(decision.extraDelayMs, signal);
                }
                for (const r of decision.recommendations.slice(0, 2)) {
                  log(emit, id, 'info', `→ ${r}`);
                }
              }
            }

            if (result.error.includes('Backend offline')) {
              setStatus(emit, id, 'running', 'API offline');
              await sleep(exponentialBackoff(consecutiveErrors - 1, Math.max(resetDelayMs, errorBase || 2000), 2, 60000, settings?.jitterPercent ?? 20), signal);
              continue;
            }
            if (result.blocked) {
              setStatus(emit, id, 'running', 'BLOCKED');
            }

            if (consecutiveErrors >= maxErrors) {
              setStatus(emit, id, 'failed', 'Too many monitor errors');
              log(emit, id, 'error', `Stopped after ${maxErrors} errors`);
              // monitor stop — do not emit CHECKOUT_FAILED (would look like checkout decline)
              return;
            }
          } else {
            consecutiveErrors = 0;
            lastWasError = false;
            // High stock 10+ filter
            let effectiveInStock = !!result.inStock;
            let effectiveStatus = result.availabilityStatus;
            if (highStockOnly && result.inStock) {
              const qty = result.quantity;
              if (qty == null) {
                log(emit, id, 'warn', `High stock filter ON but qty unknown — not alerting`);
                effectiveInStock = false;
                effectiveStatus = 'QTY_UNKNOWN';
              } else if (qty < 10) {
                log(emit, id, 'info', `Stock qty ${qty} < 10 — ignored (high stock 10+ filter)`);
                effectiveInStock = false;
                effectiveStatus = `LOW_STOCK_${qty}`;
              } else {
                log(emit, id, 'success', `High stock qty ${qty} (≥10) — alert allowed`);
                effectiveStatus = `HIGH_STOCK_${qty}`;
              }
            }
            const label = effectiveStatus || (effectiveInStock ? 'IN_STOCK' : 'OOS');
            const unknownShip =
              !!(result as any).unknown ||
              (/UNKNOWN|COMING_SOON|BACKORDER/i.test(String(label)) && !effectiveInStock);
            if (unknownShip && !effectiveInStock) {
              setStatus(emit, id, 'running', result.price ? `UNKNOWN · ${result.price}` : 'UNKNOWN shipping');
              log(
                emit,
                id,
                'warn',
                `[${tcin}] shipping UNKNOWN · no OOS, no alert · ${(result as any).via || ''} ${result.price || ''}`
              );
              continue;
            }
            const via = (result as any).via || result.source;
            const lat =
              typeof result.ms === 'number' && result.ms > 0
                ? `${result.ms}ms`
                : '';
            const extra = [result.price, lat, via || result.source].filter(Boolean).join(' · ');

            // Price change alert (only when we have a real new price vs previous)
            const norm = (p?: string) =>
              String(p || '')
                .replace(/[^0-9.]/g, '')
                .replace(/(\..*)\./g, '$1');
            const lastPrice = lastPriceByTcin.get(String(tcin));
            if (result.price && lastPrice && norm(result.price) && norm(lastPrice) && norm(result.price) !== norm(lastPrice)) {
              const oldP = lastPrice;
              const newP = result.price;
              const oldN = parseFloat(norm(oldP));
              const newN = parseFloat(norm(newP));
              const dir =
                !Number.isNaN(oldN) && !Number.isNaN(newN)
                  ? newN < oldN
                    ? 'DROP'
                    : newN > oldN
                      ? 'RISE'
                      : 'CHANGE'
                  : 'CHANGE';
              log(
                emit,
                id,
                'warn',
                `PRICE ${dir}: ${oldP} → ${newP} · ${tcin}${result.title ? ` · ${result.title}` : ''}`
              );
              void sendAlert('price', {
                store: 'Target',
                product: String(tcin),
                title: result.title,
                imageUrl: (result as any).imageUrl,
                price: `${oldP} → ${newP}`,
                status: `PRICE_${dir}`,
                taskId: id,
                extra: `Price ${dir.toLowerCase()} · shipping monitor`,
                productUrl: `https://www.target.com/p/-/A-${String(tcin).replace(/\D/g, '')}`,
                ms: result.ms,
              }).then(() => log(emit, id, 'info', 'Price change → Discord/Slack'));
              playAlertSound();
            }
            if (result.price) lastPriceByTcin.set(String(tcin), result.price);
            const lastInStock = !!lastInStockByTcin.get(String(tcin));
            log(
              emit,
              id,
              effectiveInStock ? 'success' : 'info',
              `Check #${ticks} [${tcin}]${ms ? ` (${ms}ms)` : ''} — ${label}${extra ? ` · ${extra}` : ''}${
                result.quantity != null ? ` · qty ${result.quantity}` : ''
              }`
            );
            if (result.title) log(emit, id, 'info', `[${tcin}] ${result.title.slice(0, 80)}`);

            if (effectiveInStock) {
              void pingTargetMetric(lastInStock ? 'monitor_ok' : 'monitor_instock', String(tcin));
              const isPreorder = /PRE_?ORDER|PREORDER/i.test(String(effectiveStatus || label || ''));
              const stockLabel = isPreorder
                ? result.price
                  ? `PRE-ORDER · ${result.price}`
                  : 'PRE-ORDER OPEN'
                : result.price
                  ? `IN STOCK · ${result.price}`
                  : 'IN STOCK';
              setStatus(emit, id, 'instock', stockLabel);
              const productId = typeof tcin !== 'undefined' ? tcin : (task.product || id);
              if (!lastInStock) {
                log(
                  emit,
                  id,
                  'success',
                  isPreorder
                    ? `${productId} PRE-ORDER OPEN — monitor only · ping Discord + checkout tasks`
                    : `${productId} IN STOCK — monitor only · ping Discord + checkout tasks`
                );
                emit({
                  type: 'STOCK_DETECTED',
                  taskId: id,
                  store: String(task.store || "Target"),
                  product: String(productId),
                  title: result.title,
                  price: result.price,
                  productUrl: result.finalUrl || undefined,
                });
                if (shouldSendStockAlert(String(productId), Number((task as any).stockAlertCooldownMs), id)) {
                  void sendAlert('stock', {
                    store: task.store || 'Target',
                    product: String(productId),
                    title: result.title,
                    imageUrl: (result as any).imageUrl,
                    price: result.price,
                    status: isPreorder ? 'PRE_ORDER' : 'IN_STOCK',
                    taskId: id,
                    ms: result.ms,
                    productUrl: result.finalUrl || undefined,
                  });
                  log(emit, id, 'info', `[${productId}] ${isPreorder ? 'Pre-order' : 'Stock'} info → Discord/Slack`);
                  try { playAlertSound('stock'); } catch {}
                } else {
                  log(emit, id, 'info', `${productId} alert suppressed (stock cooldown)`);
                }
              } else {
                log(emit, id, 'info', `${productId} still in stock (monitor)`);
              }
              lastInStockByTcin.set(String(tcin), true);
            } else {
              if (lastInStock) log(emit, id, 'info', `[${tcin}] Back to OOS`);
              lastInStockByTcin.set(String(tcin), false);
              setStatus(
                emit,
                id,
                'oos',
                result.price ? `OOS · ${result.price}` : 'OUT OF STOCK'
              );
            }
          }
        } catch (err: any) {
          if (signal.aborted) throw err;
          // Only skip pure tick-overlap cancels — NOT request timeouts
          const msg = String(err?.message || err || '');
          const isTimeout = /timeout|Timeout/i.test(msg);
          if (isAbortError(err) && !isTimeout && tickScope?.isAborted() && !signal.aborted) {
            log(emit, id, 'info', `Check #${ticks} superseded by next tick`);
            continue;
          }
          consecutiveErrors++;
          lastWasError = true;
          log(emit, id, 'error', `Check #${ticks} failed: ${msg}`);
          setStatus(emit, id, 'running', isTimeout ? 'TIMEOUT' : 'CHECK FAIL');
        }

        if (lastWasError) {
          const backoff = exponentialBackoff(
            Math.max(0, consecutiveErrors - 1),
            errorBase || settings?.errorDelay || 2000,
            2,
            60000,
            settings?.jitterPercent ?? 20
          );
          log(emit, id, 'info', `Backoff ${Math.round(backoff)}ms (attempt ${consecutiveErrors})`);
          await sleep(backoff, signal);
          lastWasError = false;
        } else {
          
            // Proactive IP rotation (settings autoRotateEvery / autoRotateMinutes)
            {
              const rot = maybeAutoRotate({
                taskId: id,
                proxyGroup: task.proxyGroup,
                currentProxy: proxy,
                alreadyRotated: false,
              });
              if (rot.shouldRotate) {
                log(
                  emit,
                  id,
                  'info',
                  `AutoRotate: ${rot.reason}${rot.nextProxy ? ` → ${rot.nextProxy.split('@').pop()}` : ''}`
                );
              }
            }

        await maybeRotateCookies({ taskId: id, module: 'target-shape', proxy, emit, signal, ticks, blocked: false });
        await sleep(jitterDelay(pollDelay, settings?.jitterPercent ?? 20), signal);
        }
      }

      return;
    }

    // ── Real checkout (browser ATC → cart → checkout) ───────────────
    const tcin = tcins[0];
    if (!tcin) {
      setStatus(emit, id, 'failed', 'No TCIN');
      log(emit, id, 'error', 'No TCIN for checkout');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: 'No TCIN' });
      return;
    }

    // Dry-run by default: ATC → cart → checkout page. No Place Order unless explicit.
    const wantPlaceOrder =
      (task as any).placeOrder === true ||
      (task as any).liveCheckout === true ||
      (task.extras as any)?.placeOrder === true ||
      (task.extras as any)?.liveCheckout === true;
    setStatus(emit, id, 'running', wantPlaceOrder ? 'Live Target checkout…' : 'Dry-run checkout…');
    log(
      emit,
      id,
      'info',
      wantPlaceOrder
        ? `LIVE checkout · TCIN ${tcin} · mode ${mode}`
        : `DRY-RUN · TCIN ${tcin} · mode ${mode} · ATC→cart only (no place order)`
    );
    log(emit, id, 'info', 'Stack: login sticky → Shape+PX inject → ATC headed Chrome (same FP as harvest)');
    log(
      emit,
      id,
      'info',
      wantPlaceOrder
        ? 'Flow: ATC → cart → payment → place order (+3DS wait)'
        : 'Flow: ATC → cart → stop (dry-run). Live checkout OFF = no place order.'
    );

    let proxy = resolveRoleProxy(task, 'checkout', id) || resolveProxyFromGroup(task.proxyGroup, { taskId: id });
    const { profile, account, loginEmail, loginPass, totp } = resolveTargetAccount(task);
    if (wantPlaceOrder) {
      const pan = String(profile?.cardNumber || '').replace(/\s/g, '');
      log(
        emit,
        id,
        'warn',
        pan.length >= 13
          ? `LIVE ON · Place order · card ****${pan.slice(-4)} · 3DS Chrome 4 min`
          : 'LIVE ON · Place order · using saved Target card if present · 3DS Chrome 4 min'
      );
    }
    if (String(task.profileId || '').startsWith('group:')) {
      log(
        emit,
        id,
        'info',
        `Profile group → ${profile?.name || '?'} (${profile?.group || ''})${
          (task as any).rotateProfiles ? ' · rotate on decline' : ''
        }`
      );
    }
    const storeId = String((task as any).storeId || (task as any).store_id || '').trim() || undefined;
    const fulfillment =
      (task as any).fulfillment === 'pickup' || String(mode).toLowerCase().includes('pickup')
        ? 'pickup'
        : 'shipping';

    // 1) Reuse Start session (sticky). Don't open Chrome again unless cookies died.
    try {
      const sess = await loginTargetOnTask(task, signal, emit);
      proxy = sess.proxy || proxy;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      setStatus(emit, id, 'failed', 'Login failed');
      log(emit, id, 'error', e?.message || 'Login failed — checkout stopped');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: e?.message || 'Login failed' });
      return;
    }

    // 2) Shape+PX on TOP of login jar. Empty bank → skip ATC, stay armed.
    const bankOk = await injectBankCookies(id, 'target-shape', proxy, emit, signal, {
      requireSameProxy: harvestSameAsCheckout(task),
    });
    if (!bankOk) {
      if (wantPlaceOrder) {
        log(
          emit,
          id,
          'warn',
          'Shape bank empty · LIVE still ATCs with login cookies (harvest before 2AM next time)'
        );
      } else {
        setStatus(emit, id, 'queued', 'Bank empty · skip ATC');
        log(emit, id, 'warn', 'Shape+PX bank empty · no ATC this ping · harvest more · task stays armed');
        return;
      }
    }

    setStatus(emit, id, 'carting', 'Add to cart…');
    try {
      const res = await httpRequest(`${API_BASE}/api/checkout/target`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 300000,
        body: {
          tcin,
          proxy,
          sessionId: id,
          taskId: id,
          quantity: task.quantity || 1,
          placeOrder: wantPlaceOrder,
          headed: true,
          zip: (task as any).zip || profile?.zip,
          storeId,
          fulfillment,
          accountEmail: loginEmail,
          accountPassword: loginPass,
          wait3dsSec: Number((task as any).wait3dsSec) || 240,
          solve3ds: (task as any).solve3ds !== false,
          totp: totp || (account as any)?.totp || (account as any)?.totpSecret || '',
          imap: {
            user: (loadSettings() as any).imapUser,
            pass: (loadSettings() as any).imapPass,
          },
          captcha: {
            provider: (loadSettings() as any).captchaProvider,
            capmonsterKey: (loadSettings() as any).capmonsterKey,
            capmonsterHost: (loadSettings() as any).capmonsterHost,
            twocaptchaKey: (loadSettings() as any).twocaptchaKey,
            twocaptchaHost: (loadSettings() as any).twocaptchaHost,
          },
          email: profile?.email || account?.email,
          profile: profile
            ? {
                email: profile.email,
                phone: profile.phone,
                firstName: profile.firstName,
                lastName: profile.lastName,
                address1: profile.address1,
                address2: profile.address2,
                city: profile.city,
                state: profile.state,
                zip: profile.zip,
                cardholder: profile.cardholder,
                cardNumber: profile.cardNumber,
                exp: profile.exp,
                cvv: profile.cvv,
              }
            : undefined,
        },
        signal,
      });
      let data = parseApi(ApiResponseSchema, res);

      // Unified stage → UI status (matches server [target-status] logs)
      const stage = String(data.stage || '');
      log(
        emit,
        id,
        data.ok ? 'success' : 'info',
        `[target-status] stage=${stage || '?'} ok=${!!data.ok} ms=${data.ms || '?'} · ${data.message || ''}`
      );

      if (data.stage === 'blocked') {
        setStatus(emit, id, 'failed', 'Blocked');
        log(emit, id, 'error', data.message || 'Blocked at checkout');
        if (proxy) markProxyFailed(proxy);
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'Blocked' });
        return;
      }
      if (data.stage === 'oos_after_cart') {
        setStatus(emit, id, 'oos', 'OOS after cart');
        log(
          emit,
          id,
          'warn',
          `${data.message || 'OOS at checkout'} · Shape passed · inventory gone (same as Refract)`
        );
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'OOS after cart' });
        return;
      }
      if (data.stage === 'cart' || data.stage === 'atc_ok') {
        setStatus(emit, id, 'carted', data.message || 'In cart');
        if (!wantPlaceOrder) {
          log(emit, id, 'success', `DRY-RUN PASS · CART VISIBLE · Chrome stays on /cart · ${data.cartTitle || data.message || ''}`);
          emit({ type: 'CHECKOUT_SUCCESS', taskId: id, data: { orderNumber: data.orderNumber || 'DRY-RUN', product: task.product, store: 'Target', profile: task.profileId, price: data.price || '—', quantity: task.quantity, dryRun: true } });
          return;
        }
      }
      if (data.stage === 'checkout' || data.stage === 'needs_3ds' || data.stage === 'waiting_3ds') {
        setStatus(emit, id, 'checkout', data.stage === 'needs_3ds' || data.stage === 'waiting_3ds' ? 'Waiting 3DS' : 'Checkout');
        if (!wantPlaceOrder && data.stage === 'checkout') {
          log(emit, id, 'success', `DRY-RUN PASS · reached checkout page · no place order`);
          emit({ type: 'CHECKOUT_SUCCESS', taskId: id, data: { orderNumber: data.orderNumber || 'DRY-RUN', product: task.product, store: 'Target', profile: task.profileId, price: data.price || '—', quantity: task.quantity, dryRun: true } });
          return;
        }
        if (data.stage === 'needs_3ds' || data.stage === 'waiting_3ds') {
          log(
            emit,
            id,
            'warn',
            `3DS type=${data.challenge || '?'} · ${data.message || 'Chrome open'}`
          );
          return;
        }
      }
      if (data.stage === 'ordered') {
        setStatus(emit, id, 'success', data.orderNumber ? `Order ${data.orderNumber}` : 'Ordered');
        emit({
          type: 'CHECKOUT_SUCCESS',
          taskId: id,
          data: {
            orderNumber: data.orderNumber || `TGT-${Date.now()}`,
            product: task.product,
            store: 'Target',
            profile: task.profileId,
            price: data.price || '—',
            quantity: task.quantity,
          },
        });
        return;
      }

      // One automatic recovery on empty-cart ATC fail (new session cookies)
      if (data.stage === 'atc_failed' && !(task as any).__atcRetried) {
        log(emit, id, 'warn', `ATC failed · one recovery attempt · ${data.message || ''}`);
        (task as any).__atcRetried = true;
        try {
          await httpRequest(`${API_BASE}/api/browser/session/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { sessionId: id },
            signal,
          }).catch(() => {});
          await injectBankCookies(id, 'target-shape', proxy, emit, signal);
          // fall through by re-posting checkout - recursive-ish: re-assign res
          const res2 = await httpRequest(`${API_BASE}/api/checkout/target`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 300000,
            body: {
              tcin,
              proxy,
              sessionId: id,
              taskId: id,
              quantity: task.quantity || 1,
              placeOrder: wantPlaceOrder,
              zip: (task as any).zip || profile?.zip,
              storeId,
              fulfillment,
              accountEmail: account?.email,
              accountPassword: account?.pass,
              wait3dsSec: Number((task as any).wait3dsSec) || 240,
          solve3ds: (task as any).solve3ds !== false,
          totp: totp || (account as any)?.totp || (account as any)?.totpSecret || '',
          imap: {
            user: (loadSettings() as any).imapUser,
            pass: (loadSettings() as any).imapPass,
          },
          captcha: {
            provider: (loadSettings() as any).captchaProvider,
            capmonsterKey: (loadSettings() as any).capmonsterKey,
            capmonsterHost: (loadSettings() as any).capmonsterHost,
            twocaptchaKey: (loadSettings() as any).twocaptchaKey,
            twocaptchaHost: (loadSettings() as any).twocaptchaHost,
          },
              email: profile?.email || account?.email,
              profile: profile
                ? {
                    email: profile.email,
                    phone: profile.phone,
                    firstName: profile.firstName,
                    lastName: profile.lastName,
                    address1: profile.address1,
                    address2: profile.address2,
                    city: profile.city,
                    state: profile.state,
                    zip: profile.zip,
                    cardholder: profile.cardholder,
                    cardNumber: profile.cardNumber,
                    exp: profile.exp,
                    cvv: profile.cvv,
                  }
                : undefined,
            },
            signal,
          });
          data = parseApi(ApiResponseSchema, res2);
          log(emit, id, 'info', `ATC recovery stage: ${data.stage || 'unknown'}`);
        } catch (e: any) {
          if (e?.name === 'AbortError') throw e;
          log(emit, id, 'warn', `ATC recovery error: ${e?.message || e}`);
        }
      }
      if (data.stage === 'oos' || data.stage === 'oos_after_cart') {
        setStatus(emit, id, 'failed', data.stage === 'oos_after_cart' ? 'OOS after cart' : 'OOS');
        log(
          emit,
          id,
          data.stage === 'oos_after_cart' ? 'warn' : 'error',
          data.stage === 'oos_after_cart'
            ? `${data.message} · Shape OK · lost at payment`
            : 'OOS at ATC'
        );
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'OOS' });
        return;
      }
      if (data.stage === 'atc_failed' || data.stage === 'error') {
        setStatus(emit, id, 'failed', data.stage);
        log(emit, id, 'error', data.message || 'ATC failed');
        if (Array.isArray(data.buttons) && data.buttons.length) {
          log(
            emit,
            id,
            'info',
            `ATC page buttons: ${data.buttons
              .map((b: any) => b.text || b.test)
              .filter(Boolean)
              .slice(0, 8)
              .join(' · ')}`
          );
        }
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'ATC failed' });
        return;
      }

      if (data.stage === 'login_required') {
        setStatus(emit, id, 'failed', 'Login required');
        log(emit, id, 'warn', data.message || 'Login wall');
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: 'Login required' });
        return;
      }

      // Honest stages — only ordered = real CHECKOUT_SUCCESS
      if (data.stage === 'ordered') {
        const orderNo = data.orderNumber || `TG-CONFIRMED-${tcin}-${Date.now().toString(36).toUpperCase()}`;
        setStatus(emit, id, 'success', 'Order placed');
        log(emit, id, 'success', data.orderNumber ? `Order ${data.orderNumber}` : data.message || 'Order confirmed');
        emit({
          type: 'CHECKOUT_SUCCESS',
          taskId: id,
          data: {
            orderNumber: orderNo,
            product: tcin,
            store: 'Target',
            profile: task.profileId,
            price: data.price || '—',
            quantity: task.quantity,
          },
        });
        void sendAlert('success', {
          store: 'Target',
          product: tcin,
          status: 'ORDERED',
          taskId: id,
          productUrl: data.finalUrl,
          extra: orderNo,
        });
        return;
      }

      if (data.stage === 'needs_3ds' || data.stage === 'waiting_3ds') {
        setStatus(emit, id, 'checkout', `3DS ${String(data.challenge || '').toUpperCase() || 'WAIT'}`);
        log(emit, id, 'warn', `3DS type=${data.challenge || '?'} · ${data.message || 'enter the code / approve push'}`);
        return;
      }

      if (data.stage === 'payment_failed') {
        setStatus(emit, id, 'failed', 'Payment failed');
        log(emit, id, 'error', data.message || 'Payment failed');
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'Payment failed' });
        void sendAlert('decline', {
          store: 'Target',
          product: tcin,
          status: data.message || 'payment_failed',
          taskId: id,
        });
        return;
      }

      if (data.stage === 'checkout') {
        setStatus(emit, id, 'checkout', 'Checkout gate');
        log(emit, id, 'info', data.message || 'Reached checkout — not paid yet');
        if (data.finalUrl) log(emit, id, 'info', data.finalUrl);
        if (data.filled?.length) log(emit, id, 'info', `Filled: ${data.filled.join(', ')}`);
        // Do NOT emit CHECKOUT_SUCCESS without a real order id
        void sendAlert('info' as any, {
          store: 'Target',
          product: tcin,
          status: 'CHECKOUT_GATE',
          taskId: id,
          productUrl: data.finalUrl,
          extra: data.message,
        }).catch(() => {});
        return;
      }

      if (data.stage === 'cart') {
        setStatus(emit, id, 'carted', 'In cart');
        if (!wantPlaceOrder) {
          log(emit, id, 'success', data.message || 'Item in cart — dry-run stop');
          return;
        }
        log(
          emit,
          id,
          'warn',
          'LIVE ended IN CART (no Place order) — same as Refract 21 cart / 0 check. Payment did not run.'
        );
        return;
      }

      if (data.ok && data.stage !== 'ordered') {
        setStatus(emit, id, 'checkout', data.stage || 'checkout');
        log(emit, id, 'info', data.message || data.stage || 'Checkout incomplete');
        return;
      }

      setStatus(emit, id, 'failed', data.stage || 'unknown');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'Checkout incomplete' });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      setStatus(emit, id, 'failed', 'Checkout error');
      log(emit, id, 'error', err?.message || String(err));
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: err?.message || 'Checkout error' });
    }
  },
};
