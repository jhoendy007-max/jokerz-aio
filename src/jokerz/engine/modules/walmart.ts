import { API_BASE } from '../apiBase';
import { StoreModule, EngineTaskConfig, EngineEvent } from '../types';
import { log, setStatus, sleep } from './base';
import { jitterDelay, playAlertSound, exponentialBackoff } from '../notify';
import { loadSettings, loadProfiles, resolveProfile } from '../../lib/storage';
import { httpRequest, isCorsOrNetworkError } from '../http';
import { createTickScope, isAbortError } from '../abort';
import { withRetry, isRetryableStockError } from '../retry';
import { resolveProxyFromGroup, resolveMonitorSharedProxy, getProxyGroupStats, markProxyFailed, releaseSticky, recordProxyResult, proxyRetryAfterMs, getGroupCooldownWaitMs, clearGroupProxyCooldowns , rotateIspProxy, isIspGroup, resolveIspModeForTask, logIspLatencySummary, maybeScheduleIspRotate } from '../proxy';
import { decideAntiDetect, applyAntiDetectRotation, describeGroupRotation } from '../antiDetect';
import { maybeAutoRotate } from '../autoRotate';
import { ensureSession, absorbSetCookies, cookieHeader, sessionStats } from '../session';
import { sendDiscordWebhook, sendAlert } from '../webhooks';
import { resolveTaskSettings, settingsLogLine } from '../taskSettings';
import { profileForStore } from '../moduleProfiles';
import { mergeModuleHeaders } from '../headerPresets';
import { getActiveProfileForStore } from '../fingerprintProfiles';

import { accountsForStore } from '../../lib/storeFolders';



/** Smart cookie rotation — prefer block-driven; soft proactive only when healthy long enough. */
const COOKIE_ROTATE_SOFT_EVERY = 25; // only if no recent errors (was 12 — burned bank)
const COOKIE_ROTATE_MIN_GAP_MS = 45_000; // don't rotate more than once per 45s per task
const COOKIE_ROTATE_AFTER_ERRORS = 2; // soft rotate after N consecutive soft fails

type CookieRotState = {
  lastRotateAt: number;
  softFails: number;
  hasBankCookies: boolean;
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

async function injectBankCookies(
  taskId: string,
  module: string,
  proxy: string | undefined,
  emit: (e: EngineEvent) => void,
  signal?: AbortSignal,
  opts?: { rotate?: boolean }
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
        consume: false,
        rotate: true,
        resetSession: !!opts?.rotate,
        cooldownMs: 45_000,
      },
      signal,
    });
    const data = await res.json();
    const st = getRotState(taskId);
    if (data.ok && data.injected > 0) {
      st.lastRotateAt = Date.now();
      st.softFails = 0;
      st.hasBankCookies = true;
      log(
        emit,
        taskId,
        'info',
        `${opts?.rotate ? 'Auto cookie rotate' : 'Cookie bank'} → session · ${data.injected} ck (${data.module || module}) · uses=${data.useCount ?? '?'} · bank ${data.bank?.count ?? '?'}`
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
          : 'Cookie bank empty — continuing without bank cookies'
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

  if (opts.softFail) st.softFails++;
  else if (!opts.blocked) st.softFails = 0;

  const gapOk = now - st.lastRotateAt >= COOKIE_ROTATE_MIN_GAP_MS;
  const hard = opts.force || opts.blocked;
  const softStreak = st.softFails >= COOKIE_ROTATE_AFTER_ERRORS;
  const softInterval =
    st.hasBankCookies &&
    COOKIE_ROTATE_SOFT_EVERY > 0 &&
    opts.ticks > 0 &&
    opts.ticks % COOKIE_ROTATE_SOFT_EVERY === 0;

  let reason: string | null = null;
  if (hard && gapOk) reason = opts.blocked ? 'blocked' : 'forced';
  else if (hard && !gapOk) {
    log(opts.emit, opts.taskId, 'info', `Cookie rotate deferred (${Math.round((COOKIE_ROTATE_MIN_GAP_MS - (now - st.lastRotateAt)) / 1000)}s cooldown)`);
    return false;
  } else if (softStreak && gapOk) reason = `soft-fails×${st.softFails}`;
  else if (softInterval && gapOk) reason = `soft every ${COOKIE_ROTATE_SOFT_EVERY} ticks`;

  if (!reason) return false;

  log(opts.emit, opts.taskId, 'info', `Auto cookie rotation (${reason})…`);
  const ok = await injectBankCookies(opts.taskId, opts.module, opts.proxy, opts.emit, opts.signal, {
    rotate: true,
  });
  // On hard block: if bank empty, still clear soft fail accounting
  if (!ok && hard) st.softFails = 0;
  return ok;
}


interface StockResult {
  inStock: boolean;
  finalUrl?: string;
  inQueue?: boolean;
  price?: string;
  title?: string;
  ms?: number;
  error?: string;
  availabilityStatus?: string;
  offerId?: string;
  source?: string;
  blocked?: boolean;
  fingerprint?: any;
  setCookie?: string[];
}

async function checkWalmartStock(
  sku: string,
  signal: AbortSignal,
  proxy?: string,
  cookie?: string,
  sessionId?: string
): Promise<StockResult> {
  try {
    return await withRetry(
      async () => {
        const res = await httpRequest(`${API_BASE}/api/monitor/walmart`, {
          method: 'POST',
          signal,
          timeoutMs: 20000,
          headers: mergeModuleHeaders('Walmart', {
            kind: 'document',
            headers: { 'Content-Type': 'application/json' },
          }),
          body: {
            store: 'Walmart',
            sku,
            proxy,
            cookie,
            taskId: sessionId,
            sessionId,
            fingerprintProfile: getActiveProfileForStore('walmart').id,
            tlsClient: getActiveProfileForStore('walmart').tlsClient,
            randomTLSExtensionOrder: true,
          },
        });

        let data: any;
        try {
          data = res.json();
        } catch {
          if (res.status >= 500 || res.status === 429) {
            throw Object.assign(new Error(`Bad response (${res.status})`), { status: res.status });
          }
          return { inStock: false, error: `Bad response (${res.status})` };
        }

        if (res.status >= 500 || res.status === 429) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        }

        if (!data.ok && data.error) {
          const soft = {
            inStock: false as const,
            error: data.error as string,
            ms: data.ms,
            blocked: data.blocked,
          };
          if (isRetryableStockError(soft.error, soft.blocked)) {
            throw Object.assign(new Error(soft.error), { stockResult: soft, status: 503 });
          }
          return soft;
        }

        return {
          inStock: !!data.inStock,
          inQueue: !!data.inQueue,
          price: data.price,
          title: data.title,
          ms: data.ms,
          error: data.error,
          availabilityStatus: data.availabilityStatus,
          offerId: data.offerId,
          source: data.source,
          blocked: data.blocked,
          fingerprint: data.fingerprint,
          setCookie: data.setCookie,
        };
      },
      {
        attempts: 3,
        baseMs: 400,
        maxMs: 5000,
        signal,
        shouldRetry: (err) => {
          if (isAbortError(err)) return false;
          if (isCorsOrNetworkError(err)) return true;
          const msg = err instanceof Error ? err.message : String(err);
          return isRetryableStockError(msg, false);
        },
      }
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (isAbortError(err)) throw err;
    if (err && typeof err === 'object' && (err as any).stockResult) {
      return (err as any).stockResult as StockResult;
    }
    if (isCorsOrNetworkError(err)) {
      return {
        inStock: false,
        error: 'Backend offline — start with: npm run server',
      };
    }
    return {
      inStock: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}


/** Parse product field: newline / comma / space separated IDs */
function parseSkus(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const parts = String(raw)
    .split(/[\n,;|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const ip = s.match(/\/ip\/(?:[^/]+\/)?(\d{5,})/i);
      if (ip) return ip[1];
      const q = s.match(/[?&]id=(\d{5,})/i);
      if (q) return q[1];
      const n = s.match(/\b(\d{5,12})\b/);
      if (n) return n[1];
      return s.replace(/^https?:\/\/\S+/i, '').trim() || s;
    })
    .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter((s) => s.length >= 5);
  return [...new Set(parts)];
}

export const WalmartModule: StoreModule = {
  name: 'Walmart',
  supportedModes: ['checkout', 'monitor'],

  validate(task) {
    if (!task.product) return 'SKU / product is required';
    if (task.mode !== 'monitor' && !task.profileId) return 'Profile is required';
    return null;
  },

  async login(task, signal, emit) {
    const id = task.id;
    const settingsWm = loadSettings();
    const wmAccounts = accountsForStore(settingsWm, 'Walmart');
    const email = String((task as any).accountEmail || (task.extras as any)?.accountEmail || '').trim();
    const account =
      wmAccounts.find((a: any) => a.email && a.email.toLowerCase() === email.toLowerCase()) ||
      wmAccounts.find((a: any) => a.email) ||
      null;
    if (!account?.email || !account?.pass) {
      log(emit, id, 'warn', 'No Walmart account on task — guest ATC (login skipped)');
      return;
    }
    const proxy = resolveProxyFromGroup(task.proxyGroup, { taskId: id });
    setStatus(emit, id, 'running', `Login ${account.email}…`);
    const lr = await httpRequest(`${API_BASE}/api/walmart/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        email: account.email,
        password: account.pass,
        proxy,
        sessionId: id,
      },
      signal,
      timeoutMs: 180000,
    });
    const ld: any = await lr.json();
    if (!ld.ok && !ld.fromCache) throw new Error(ld.error || ld.message || 'Walmart login failed');
    log(emit, id, 'success', ld.fromCache ? `Sticky · ${account.email}` : `Logged in · ${account.email}`);
    try {
      await httpRequest(`${API_BASE}/api/harvest/task-bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { taskId: id, proxy, name: `WM ${account.email.split('@')[0]}`, module: 'walmart' },
        signal,
        timeoutMs: 15000,
      });
    } catch {
      /* */
    }
    setStatus(emit, id, 'queued', 'Logged in · waiting SKU');
  },

  async run(task: EngineTaskConfig, signal: AbortSignal, emit: (e: EngineEvent) => void) {
    const id = task.id;
    const skus = parseSkus(task.product);
    if (!skus.length) {
      setStatus(emit, id, 'failed', 'No SKU');
      log(emit, id, 'error', 'No SKU parsed from product field');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: 'No SKU' });
      return;
    }
    const sku = skus[0] || task.product.trim();

    if (task.mode === 'monitor') {
      setStatus(emit, id, 'running', 'Monitoring...');
      log(emit, id, 'info', `Walmart monitor · SKU(s): ${skus.join(', ')}`);
      log(emit, id, 'info', `Sticky session jar enabled`);
      {
        const p = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
        await injectBankCookies(id, 'walmart', p, emit, signal);
      }
      
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


      log(emit, id, 'info', `API: ${API_BASE} · ${settingsLogLine(ts)}`);
      log(emit, id, 'info', `Module profile: ${modProfile.antibot} · ${modProfile.notes}`);

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
        log(emit, id, 'info', `SHARED monitor IP mode · all monitors on this group use 1 proxy`);
      log(emit, id, 'info', `Proxy group "${proxyStats.name}" · ${proxyStats.total} proxies · mode ${proxyStats.mode}${(proxyStats as any).cooling ? ` · ${proxyStats.cooling} cooling` : ''}`);
      } else if (task.proxyGroup && task.proxyGroup !== 'Localhost') {
        log(emit, id, 'warn', `Proxy group "${task.proxyGroup}" has 0 proxies — using direct connection`);
        log(emit, id, 'info', 'Add proxies in Proxies tab (one per line: host:port or user:pass@host:port)');
      } else {
        log(emit, id, 'info', 'No proxy group · direct connection');
      }

      let ticks = 0;
      let consecutiveErrors = 0;
      let lastInStock = false;
      let lastInQueue = false;
      let lastDrawing = false;
      let lastPrice: string | undefined;
      let checksOnIp = 0;
      let lastWasError = false;
      
      const maxErrors = Math.max(1, settings.maxRetries || 3) + 5; // soft cap before fail
      let skuIndex = 0;

      let tickScope: ReturnType<typeof createTickScope> | null = null;

      while (!signal.aborted) {
        ticks++;
        if (task.mode === 'monitor' && ticks % 10 === 0 && task.proxyGroup) {
          try {
            const lines = logIspLatencySummary(task.proxyGroup);
            if (lines.length) {
              log(emit, id, 'info', `ISP latency · ${task.proxyGroup}`);
              for (const line of lines.slice(0, 5)) log(emit, id, 'info', `  ${line}`);
            }
          } catch { /* */ }
        }

        tickScope?.abort('next-tick');
        tickScope = createTickScope(signal);
        const tickSignal = tickScope.signal;

        const currentSku = skus[skuIndex % skus.length];
        skuIndex++;
        let proxy = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
          if (!proxy && task.proxyGroup && task.proxyGroup !== 'Localhost') {
            const waitCd = getGroupCooldownWaitMs(task.proxyGroup);
            const waitBase = Math.min(Math.max(waitCd, 1000), 120_000);
            const wait = jitterDelay(waitBase, settings?.jitterPercent ?? 20, 500);
            log(
              emit,
              id,
              'warn',
              `All proxies cooling · wait ${Math.round(wait / 1000)}s before next IP`
            );
            await sleep(wait, signal);
            proxy = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
          }
          const waitRl = proxyRetryAfterMs(proxy);
          if (waitRl > 0) {
            const waitRlJ = jitterDelay(waitRl, Math.min(15, settings?.jitterPercent ?? 15), 50);
            log(emit, id, 'info', `Rate limit · wait ${waitRlJ}ms before ${proxy?.split('@').pop() || 'proxy'}`);
            await sleep(waitRlJ, signal);
            proxy = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
          }

        try {
          ensureSession(id, { proxy, proxyGroup: task.proxyGroup, store: 'Walmart', kind: 'monitor', touchExpiry: true });
          // Isolated session per task+SKU (Target pattern)
          const monitorSessionId = `${id}__${String(currentSku).replace(/\D/g, '').slice(0, 16)}`;
          const result = await checkWalmartStock(
            currentSku,
            tickSignal,
            proxy,
            cookieHeader(id),
            monitorSessionId
          );
          recordProxyResult(proxy, {
            ok: !result.error && !result.blocked,
            blocked: !!result.blocked || /blocked|429/i.test(result.error || ''),
            ms: result.ms,
          });
          // ISP schedule / latency rotate
          if (task.mode === 'monitor' && isIspGroup(task.proxyGroup) && !result.error && !result.inQueue) {
            checksOnIp++;
            const rot = maybeScheduleIspRotate(task.proxyGroup, {
              checksOnIp,
              everyN: Number((loadSettings() as any).ispRotateEveryN) || 8,
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
          if (result.blocked || /blocked|429|challenge|px-captcha|shape/i.test(result.error || '')) {
            if (proxy) markProxyFailed(proxy);
            if (isIspGroup(task.proxyGroup)) {
              const next = rotateIspProxy(task.proxyGroup, {
                taskId: id,
                reason: 'block',
                monitorShared: true,
              });
              if (next && next !== proxy) {
                log(emit, id, 'warn', `ISP block rotate → ${next.split('@').pop() || next}`);
              }
            }
            await maybeRotateCookies({
              taskId: id,
              module: 'walmart',
              proxy,
              emit,
              signal,
              ticks,
              blocked: true,
            });
          } else if (result.error) {
            await maybeRotateCookies({
              taskId: id,
              module: 'walmart',
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

          if (result.error && !result.inStock && !result.inQueue) {
            consecutiveErrors++;
            lastWasError = true;
            const proxyTag = proxy ? ` · via ${proxy.split('@').pop()}` : '';
            const fpTag = result.fingerprint?.provider
              ? ` · fp:${result.fingerprint.provider}/${result.fingerprint.confidence || '?'}`
              : '';
            if (result.fingerprint?.signalDetails?.length) {
              const top = result.fingerprint.signalDetails.slice(0, 3)
                .map((s) => s.what)
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
              `Check #${ticks} [${currentSku}]${ms ? ` (${ms}ms)` : ''} — ${result.error}${proxyTag}${fpTag}`
            );

            
            // Adaptive anti-detection ↔ proxy rotation
            {
              const decision = decideAntiDetect({ taskId: id, store: String(task.store || ''), proxy,
                blocked: result.blocked || /blocked|429|challenge/i.test(result.error || ''),
                fingerprint: result.fingerprint,
                consecutiveErrors,
                proxyGroup: task.proxyGroup,
              });
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
              await sleep(exponentialBackoff(consecutiveErrors - 1, Math.max(resetDelayMs, errorBase || 2000), 2, 60000, settings?.jitterPercent ?? 20), signal);
              continue;
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
            const label = result.inQueue
              ? 'QUEUE'
              : result.availabilityStatus || (result.inStock ? 'IN_STOCK' : 'OOS');
            const extra = [result.price, result.offerId ? `offer:${result.offerId.slice(0, 12)}` : '', result.source]
              .filter(Boolean)
              .join(' · ');
            log(
              emit,
              id,
              result.inStock ? 'success' : 'info',
              `Check #${ticks} [${currentSku}]${ms ? ` (${ms}ms)` : ''} — ${label}${extra ? ` · ${extra}` : ''}`
            );
            if (result.title) {
              log(emit, id, 'info', result.title.slice(0, 80));
            }

            if (result.inQueue) {
              setStatus(emit, id, 'queued', 'Queue');
              log(emit, id, 'warn', `IN QUEUE · same IP · no rotate`);
              if (!lastInQueue) {
                void sendAlert('queue', {
                  store: 'Walmart',
                  product: currentSku,
                  title: result.title,
                  status: 'IN_QUEUE',
                  taskId: id,
                });
              }
              lastInQueue = true;
            } else if (/DRAWING_LIVE/i.test(String(result.availabilityStatus || '')) || (result as any).drawingLive) {
              lastInQueue = false;
              setStatus(emit, id, 'instock', 'DRAWING LIVE');
              log(emit, id, 'success', result.title || 'Collectibles Drawing LIVE');
              if (!lastDrawing) {
                lastDrawing = true;
                void sendAlert('stock', {
                  store: 'Walmart',
                  product: 'DRAWING',
                  title: result.title || 'Collectibles Drawing',
                  status: 'DRAWING_LIVE',
                  taskId: id,
                  extra: 'Enter on walmart.com/shop/collectibles/draw',
                });
              }
            } else if (result.inStock) {
              lastInQueue = false;
              
            // Price change alert
            const normP = (x?: string) => String(x || '').replace(/[^0-9.]/g, '');
            if (result.price && lastPrice && normP(result.price) && normP(result.price) !== normP(lastPrice)) {
              const dir = parseFloat(normP(result.price)) < parseFloat(normP(lastPrice)) ? 'DROP' : 'RISE';
              log(emit, id, 'warn', `PRICE ${dir}: ${lastPrice} → ${result.price} · ${task.product || id}`);
              void sendAlert('price', {
                store: 'Walmart',
                product: task.product || id,
                title: result.title,
                price: `${lastPrice} → ${result.price}`,
                status: `PRICE_${dir}`,
                taskId: id,
                extra: 'Walmart price change',
              });
              playAlertSound();
            }
            if (result.price) lastPrice = result.price;

              setStatus(emit, id, 'instock', result.price ? `IN STOCK · ${result.price}` : 'IN STOCK');
              const productId = task.product || id;
              if (!lastInStock) {
                log(emit, id, 'success', `${productId} IN STOCK — monitor only · ping Discord + checkout tasks`);
                void sendAlert('stock', {
                  store: task.store || 'Walmart',
                  product: String(productId),
                  title: result.title,
                  price: result.price,
                  status: 'IN_STOCK',
                  taskId: id,
                  ms: result.ms,
                  productUrl: result.finalUrl || undefined,
                });
                log(emit, id, 'info', 'Stock info → Discord/Slack');
                try { playAlertSound('stock'); } catch {}
                emit({
                  type: 'STOCK_DETECTED',
                  taskId: id,
                  store: String(task.store || "Walmart"),
                  product: String(productId),
                  title: result.title,
                  price: result.price,
                  productUrl: result.finalUrl || undefined,
                });
              } else {
                log(emit, id, 'info', `${productId} still in stock (monitor)`);
              }
              lastInStock = true;
            } else {
              lastInQueue = false;
              lastDrawing = false;
              if (lastInStock) log(emit, id, 'info', 'Back to OOS');
              lastInStock = false;
              setStatus(emit, id, 'oos', result.price ? `OOS · ${result.price}` : 'OUT OF STOCK');
            }
          }
        } catch (err: any) {
          if (isAbortError(err)) { if (signal.aborted) throw err; continue; }
          if (err?.name === 'AbortError') throw err;
          consecutiveErrors++;
            lastWasError = true;
          log(emit, id, 'error', `Check #${ticks} failed: ${err?.message || err}`);
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

        await maybeRotateCookies({ taskId: id, module: 'walmart', proxy, emit, signal, ticks, blocked: false });
        await sleep(jitterDelay(pollDelay, settings?.jitterPercent ?? 20), signal);
        }
      }

      return;
    }

    // ── Real Walmart checkout (browser ATC) ─────────────────────────
    const itemId = String(task.product || '').trim();
    if (!itemId) {
      setStatus(emit, id, 'failed', 'No item id');
      log(emit, id, 'error', 'No Walmart item id / URL');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: 'No item id' });
      return;
    }

    setStatus(emit, id, 'running', 'Real Walmart checkout…');
    log(emit, id, 'info', `Real checkout · item ${itemId}`);
    const isDraw = /draw|lottery|collectibles\/draw/i.test(itemId);
    log(
      emit,
      id,
      'info',
      isDraw
        ? 'DRAWING · board collectibles/draw · 1 entry · saved address/card'
        : 'Queue hold ≤3h same IP · no refresh · shipping ATC'
    );

    let proxy = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
    await injectBankCookies(id, 'walmart', proxy, emit, signal);
    const settingsWm = loadSettings();
    const wmAccounts = accountsForStore(settingsWm, 'Walmart');
    const account =
      wmAccounts.find((a: any) => a.email && a.email === (task as any).accountEmail) ||
      wmAccounts[0];
    if (account?.email && account?.pass) {
      log(emit, id, 'info', `Walmart account login · ${account.email}`);
      setStatus(emit, id, 'running', 'Account login…');
      try {
        const lr = await httpRequest(`${API_BASE}/api/walmart/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            email: account.email,
            password: account.pass,
            proxy,
            sessionId: id,
          },
          signal,
        });
        const ld = await lr.json();
        if (ld.ok) log(emit, id, 'success', ld.message || 'Login OK');
        else log(emit, id, 'warn', ld.message || ld.error || 'Login soft-fail');
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        log(emit, id, 'warn', `Login skip: ${e?.message || e}`);
      }
    }
    const profile = resolveProfile(task.profileId, {
      taskId: id,
      rotate: !!(task as any).rotateProfiles,
    });
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

    setStatus(emit, id, 'carting', isDraw ? 'Enter drawing…' : 'Add to cart…');
    try {
      const res = await httpRequest(`${API_BASE}${isDraw ? '/api/walmart/drawing' : '/api/checkout/walmart'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: isDraw ? 180000 : 4 * 60 * 60 * 1000,
        body: {
          itemId,
          proxy,
          sessionId: id,
          taskId: id,
          quantity: task.quantity || 1,
          zip: (task as any).zip || profile?.zip,
          placeOrder: !!(task as any).liveCheckout || (task as any).placeOrder === true,
          accountEmail: (account as any)?.email,
          accountPassword: (account as any)?.pass,
          wait3dsSec: Number((task as any).wait3dsSec) || 90,
          profile: profile
            ? {
                email: profile.email,
                phone: profile.phone,
                firstName: profile.firstName,
                lastName: profile.lastName,
                address1: profile.address1,
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
      const data = await res.json();

      if (data.stage === 'blocked') {
        setStatus(emit, id, 'failed', 'Blocked');
        log(emit, id, 'error', data.message || 'PX blocked');
        if (proxy) markProxyFailed(proxy);
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'Blocked' });
        return;
      }
      if (data.stage === 'oos' || data.stage === 'oos_after_cart') {
        setStatus(emit, id, 'oos', data.stage === 'oos_after_cart' ? 'OOS after cart' : 'OOS');
        log(emit, id, 'warn', data.message || 'OOS');
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'OOS' });
        return;
      }
      if (data.stage === 'sms') {
        setStatus(emit, id, 'checkout', 'SMS');
        log(emit, id, 'warn', data.message || 'SMS verify in Chrome · same IP');
        return;
      }
      if (data.stage === 'queue') {
        setStatus(emit, id, 'queued', 'Queue');
        log(emit, id, 'warn', data.message || 'Walmart queue · same IP');
        return;
      }
      if (data.stage === 'atc_failed' || data.stage === 'error' || data.stage === 'login_required') {
        setStatus(emit, id, 'failed', data.stage);
        log(emit, id, 'error', data.message || data.stage);
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || data.stage });
        return;
      }

      if (data.stage === 'ordered') {
        const orderNo = data.orderNumber || `WM-CONFIRMED-${itemId}`;
        setStatus(emit, id, 'success', 'Order placed');
        log(emit, id, 'success', data.orderNumber ? `Order ${data.orderNumber}` : data.message);
        emit({
          type: 'CHECKOUT_SUCCESS',
          taskId: id,
          data: {
            orderNumber: orderNo,
            product: itemId,
            store: 'Walmart',
            profile: task.profileId,
            price: '—',
            quantity: task.quantity,
          },
        });
        return;
      }
      if (data.stage === 'needs_3ds') {
        setStatus(emit, id, 'checkout', '3DS required');
        log(emit, id, 'warn', data.message || '3DS');
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'needs_3ds' });
        return;
      }
      if (data.stage === 'payment_failed') {
        setStatus(emit, id, 'failed', 'Payment failed');
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'payment_failed' });
        return;
      }
      if (data.stage === 'checkout') {
        setStatus(emit, id, 'checkout', 'Checkout gate');
        log(emit, id, 'info', data.message || 'Checkout gate — not paid');
        if (data.finalUrl) log(emit, id, 'info', data.finalUrl);
        return;
      }
      if (data.stage === 'cart') {
        setStatus(emit, id, 'carted', 'In cart');
        if (!(task as any).liveCheckout) {
          log(emit, id, 'success', data.message || 'Dry-run cart');
          emit({ type: 'CHECKOUT_SUCCESS', taskId: id, data: { ...data, dryRun: true } });
        } else {
          log(emit, id, 'warn', 'LIVE ended IN CART — payment did not run');
        }
        return;
      }
      if (data.ok && data.stage !== 'ordered') {
        setStatus(emit, id, 'checkout', data.stage || 'checkout');
        log(emit, id, 'info', data.message || data.stage);
        return;
      }

      setStatus(emit, id, 'failed', 'incomplete');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'Checkout incomplete' });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      setStatus(emit, id, 'failed', 'Checkout error');
      log(emit, id, 'error', err?.message || String(err));
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: err?.message || 'Checkout error' });
    }
  },
};
