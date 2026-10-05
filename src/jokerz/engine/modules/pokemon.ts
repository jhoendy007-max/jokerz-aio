import { parseApi, MonitorResponseSchema, ApiResponseSchema, stockFromMonitor, rateLimitWaitMs, rlFields, type StockResult } from '../apiTypes';
type MonitorResult = StockResult;
import { recordMonitorHealth } from '../../lib/monitorHealth';
import { StoreModule, EngineTaskConfig, EngineEvent } from '../types';
import { log, setStatus, sleep } from './base';
import { jitterDelay, playAlertSound, exponentialBackoff } from '../notify';
import { loadSettings, loadProfiles, resolveProfile } from '../../lib/storage';
import { httpRequest, isCorsOrNetworkError } from '../http';
import { createTickScope, isAbortError } from '../abort';
import { resolveProxyFromGroup, resolveMonitorSharedProxy, getProxyGroupStats, markProxyFailed, releaseSticky, recordProxyResult, proxyRetryAfterMs, getGroupCooldownWaitMs, clearGroupProxyCooldowns , rotateIspProxy, isIspGroup, resolveIspModeForTask, logIspLatencySummary, maybeScheduleIspRotate } from '../proxy';
import { decideAntiDetect, applyAntiDetectRotation, describeGroupRotation } from '../antiDetect';
import { maybeAutoRotate } from '../autoRotate';
import { ensureSession, absorbSetCookies, cookieHeader, sessionStats } from '../session';
import { sendDiscordWebhook, sendAlert } from '../webhooks';
import { resolveTaskSettings, settingsLogLine } from '../taskSettings';
import { profileForStore } from '../moduleProfiles';
import { mergeModuleHeaders } from '../headerPresets';
import { getActiveProfileForStore } from '../fingerprintProfiles';

import { API_BASE } from '../apiBase';


/** host:port:user:pass → user:pass@host:port */
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

async function checkPokemon(
  product: string,
  signal: AbortSignal,
  opts: { proxy?: string; region?: string; cookie?: string; sessionId?: string } = {}
): Promise<MonitorResult> {
  try {
    const res = await httpRequest(`${API_BASE}/api/monitor/pokemon`, {
      method: 'POST',
      signal,
      timeoutMs: 28000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: {
        url: product,
        region: opts.region || 'US',
        proxy: normalizeProxyClient(opts.proxy),
        // monitors: cookies optional — server peeks bank if empty
        cookie: opts.cookie || undefined,
        taskId: opts.sessionId,
        sessionId: opts.sessionId,
        preferTls: true,
        allowBrowser: true,
        fingerprintProfile: getActiveProfileForStore('pokemon').id,
        tlsClient: getActiveProfileForStore('pokemon').tlsClient,
        randomTLSExtensionOrder: true,
      },
    });

    let data: any = {};
    try {
      data = parseApi(MonitorResponseSchema, res);
      recordMonitorHealth('Pokemon Center', product, data);
    } catch {
      return {
        ...rlFields(data),
        inStock: false,
        error: `Bad JSON from API (${res.status}) — restart npm run server after update`,
      };
    }

    if (res.status === 0 || (res.status >= 500 && !data?.ok && !data?.availabilityStatus)) {
      return {
        ...rlFields(data),
        inStock: false,
        error:
          data?.error ||
          `API HTTP ${res.status} — check server terminal for [monitor/pokemon]`,
      };
    }

    if (!data.ok && data.error) {
      return {
        ...rlFields(data),
        inStock: false,
        inQueue: !!data.inQueue,
        error: data.error,
        ms: data.ms,
        blocked: data.blocked,
        fingerprint: data.fingerprint,
        setCookie: data.setCookie,
        availabilityStatus: data.availabilityStatus,
        source: data.source,
      };
    }

    return {
      ...rlFields(data),
      inStock: !!data.inStock,
      inQueue: !!data.inQueue,
      queueProvider: data.queueProvider,
      queuePosition: data.queuePosition,
      price: data.price,
      title: data.title,
      ms: data.ms,
      availabilityStatus: data.availabilityStatus,
      source: data.source || data.via,
      confidence: data.confidence,
      parseSignals: Array.isArray(data.signals) ? data.signals : undefined,
      blocked: data.blocked,
      fingerprint: data.fingerprint,
      setCookie: data.setCookie,
      finalUrl: data.finalUrl,
      via: data.via,
      error: data.error,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (isAbortError(err)) throw err;
    if (isCorsOrNetworkError(err)) {
      return { inStock: false, error: 'Backend offline — start with: npm run server' };
    }
    return { inStock: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export const PokemonModule: StoreModule = {
  name: 'Pokemon Center',
  supportedModes: ['monitor', 'guest', 'checkout'],

  validate(task) {
    const p = String(task.product || '').trim();
    if (!p) return 'URL, PID o PLACEHOLDER';
    if (!task.profileId && task.mode !== 'monitor') return 'Profile is required';
    return null;
  },

  async run(task: EngineTaskConfig, signal: AbortSignal, emit: (e: EngineEvent) => void) {
    const id = task.id;
    const mode = task.mode || 'guest';
    const region = resolveTaskSettings(task).region || 'US';
    const rawProduct = task.product.trim();
    const product = /^(PLACEHOLDER|QUEUE|NEW)$/i.test(rawProduct)
      ? 'https://www.pokemoncenter.com/category/new-releases'
      : rawProduct;

    // ── MONITOR + QUEUE DETECTOR ──────────────────────────────────
    if (mode === 'monitor') {
      setStatus(emit, id, 'running', 'Monitoring Pokemon Center...');
      log(emit, id, 'info', `PKC monitor · ${product.slice(0, 90)}${/new-releases/i.test(product) ? ' · QUEUE PING' : ''}`);
      
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


      log(emit, id, 'info', `Region: ${region} · API: ${API_BASE} · ${settingsLogLine(ts)}`);
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
        log(emit, id, 'info', `Proxy group "${proxyStats.name}" · ${proxyStats.total} proxies · mode ${proxyStats.mode}${(proxyStats as any).cooling ? ` · ${proxyStats.cooling} cooling` : ''}`);
      } else {
        log(emit, id, 'info', 'No proxy / direct connection');
      }

      let ticks = 0;
      let consecutiveErrors = 0;
      let checksOnIp = 0;
      let lastInStock = false;
      let lastPrice: string | undefined;
      let lastInQueue = false;
      let lastWasError = false;
      let wasInQueue = false;
      
      const maxErrors = Math.max(1, settings.maxRetries || 3) + 5; // soft cap before fail

      let tickScope: ReturnType<typeof createTickScope> | null = null;

      while (!signal.aborted) {
        ticks++;
        if (ticks % 10 === 0 && task.proxyGroup) {
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

        let proxy = resolveMonitorSharedProxy(task.proxyGroup);
          if (!proxy && task.proxyGroup && task.proxyGroup !== 'Localhost') {
            const waitCd = getGroupCooldownWaitMs(task.proxyGroup);
            const wait = Math.min(Math.max(waitCd, 1000), 120_000);
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
            log(emit, id, 'info', `Rate limit · wait ${waitRl}ms before ${proxy?.split('@').pop() || 'proxy'}`);
            await sleep(waitRl, signal);
            proxy = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
          }

        try {
          ensureSession(id, {
            proxy,
            proxyGroup: task.proxyGroup,
            store: 'Pokemon Center',
            kind: 'monitor',
            touchExpiry: true,
          });
          const proxyHint = proxy ? proxy.split('@').pop() || proxy : 'direct';
          log(emit, id, 'info', `Checking ${product.slice(0, 60)} via ${proxyHint}…`);
          // Per-task session id (no shared sticky browser forced)
          const result = await checkPokemon(product, tickSignal, {
            proxy,
            region,
            // prefer empty cookie on monitor — bank peek on server; session jar only if already warm
            cookie: cookieHeader(id) || undefined,
            sessionId: id,
          });
          // Honor server 429 / Retry-After: pause this task instead of retrying immediately.
          const rlWait = rateLimitWaitMs(result, pollDelay);
          if (rlWait > 0) {
            log(emit, id, 'warn', `RATE LIMITED (429) · pausing ${Math.round(rlWait / 1000)}s${result.retryAfterMs ? ' (Retry-After)' : ''}`);
            setStatus(emit, id, 'running', `Rate limited · retry in ${Math.round(rlWait / 1000)}s`);
            await sleep(rlWait, signal);
            continue;
          }
          recordProxyResult(proxy, {
            ok: !result.error && !result.blocked,
            blocked:
              !!result.blocked ||
              /blocked|429|imperva|error\s*15/i.test(result.error || ''),
            ms: result.ms,
            provider:
              (result as any).fingerprint?.provider ||
              (/imperva|error\s*15/i.test(result.error || '') ? 'imperva' : undefined),
            reason: result.error,
          });
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
          if (result.blocked || /datadome|403|blocked/i.test(result.error || '')) {
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
          }
          if (result.setCookie) absorbSetCookies(id, result.setCookie, proxy);
          const ms = result.ms ?? 0;
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

          if (result.error && !result.inQueue && !result.inStock) {
            consecutiveErrors++;
            lastWasError = true;
            log(
              emit,
              id,
              consecutiveErrors >= 3 ? 'warn' : 'info',
              `Check #${ticks}${ms ? ` (${ms}ms)` : ''} — ${result.error}${proxyTag}${fpTag}`
            );
            
            // Adaptive anti-detection ↔ proxy rotation (skip when in queue)
            if (!result.inQueue) {
              const decision = decideAntiDetect({
                taskId: id,
                store: String(task.store || ''),
                proxy,
                blocked:
                  !!result.blocked && !/queue|waiting room/i.test(result.error || ''),
                fingerprint: result.fingerprint,
                consecutiveErrors,
                proxyGroup: task.proxyGroup,
                error: result.error,
              });
              if (decision.threat !== 'none') {
                log(
                  emit,
                  id,
                  decision.threat === 'critical' ? 'error' : 'warn',
                  `AntiDetect: ${decision.action}`
                );
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
                  log(
                    emit,
                    id,
                    'info',
                    `Rotation: sticky released · ${describeGroupRotation(task.proxyGroup)}`
                  );
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
              await sleep(exponentialBackoff(consecutiveErrors - 1, Math.max(resetDelayMs, errorBase || 2000), 2, 60000), signal);
              continue;
            }
            if (consecutiveErrors >= maxErrors) {
              setStatus(emit, id, 'failed', 'Too many monitor errors');
              log(emit, id, 'error', `Stopped after ${maxErrors} errors`);
              // monitor stop — do not emit CHECKOUT_FAILED (would look like checkout decline)
              return;
            }
          } else if (result.inQueue) {
            consecutiveErrors = 0;
            lastWasError = false;
            const justEntered = !wasInQueue && !lastInQueue;
            wasInQueue = true;
            lastInQueue = true;
            const pos =
              result.queuePosition != null ? ` · pos ${result.queuePosition}` : '';
            const provider = result.queueProvider ? ` · ${result.queueProvider}` : '';
            log(
              emit,
              id,
              'warn',
              `Check #${ticks}${ms ? ` (${ms}ms)` : ''} — IN QUEUE${provider}${pos}${proxyTag}`
            );
            setStatus(emit, id, 'running', `In queue${pos}`);
            if (justEntered) {
              void sendAlert('queue', {
                store: 'Pokemon Center',
                product,
                title: result.title,
                status: 'IN_QUEUE',
                taskId: id,
                extra: [result.queueProvider, result.queuePosition != null ? `position ${result.queuePosition}` : '']
                  .filter(Boolean)
                  .join(' · '),
              });
              log(emit, id, 'info', 'Alert: queue → Discord/Slack');
              try { playAlertSound('queue'); } catch {}
            }
          } else if (result.inStock) {
            consecutiveErrors = 0;
            lastWasError = false;
            if (wasInQueue) {
              log(emit, id, 'success', `Queue passed — product page open`);
            }
            const extra = [
              result.price,
              result.source,
              result.confidence ? `conf:${result.confidence}` : '',
              result.parseSignals?.length ? result.parseSignals.slice(0, 3).join('+') : '',
            ]
              .filter(Boolean)
              .join(' · ');
            log(
              emit,
              id,
              'success',
              `Check #${ticks}${ms ? ` (${ms}ms)` : ''} — IN_STOCK${extra ? ` · ${extra}` : ''}`
            );
            if (result.title) log(emit, id, 'info', result.title.slice(0, 80));
            const normP = (x?: string) => String(x || '').replace(/[^0-9.]/g, '');
              if (result.price && lastPrice && normP(result.price) && normP(result.price) !== normP(lastPrice)) {
                const dir = parseFloat(normP(result.price)) < parseFloat(normP(lastPrice)) ? 'DROP' : 'RISE';
                log(emit, id, 'warn', `PRICE ${dir}: ${lastPrice} → ${result.price}`);
                void sendAlert('price', {
                  store: 'Pokemon Center',
                  product: task.product,
                  title: result.title,
                  price: `${lastPrice} → ${result.price}`,
                  status: `PRICE_${dir}`,
                  taskId: id,
                });
                playAlertSound();
              }
              if (result.price) lastPrice = result.price;
              setStatus(emit, id, 'instock', result.price ? `IN STOCK · ${result.price}` : 'IN STOCK');
            if (!lastInStock) {
              log(emit, id, 'success', 'IN STOCK — monitor only · Discord stock + ping checkout tasks');
              void sendAlert('stock', {
                store: 'Pokemon Center',
                product,
                title: result.title,
                price: result.price,
                status: 'IN_STOCK',
                taskId: id,
                extra: wasInQueue ? 'Came out of queue' : undefined,
              });
              log(emit, id, 'info', 'Stock info → Discord/Slack');
              try { playAlertSound('stock'); } catch {}
              emit({
                type: 'STOCK_DETECTED',
                taskId: id,
                store: 'Pokemon Center',
                product: String(product),
                title: result.title,
                price: result.price,
              });
            }
            lastInStock = true;
            lastInQueue = false;
            wasInQueue = false;
          } else {
            lastInStock = false;
            consecutiveErrors = 0;
            lastWasError = false;
            // Left queue but OOS, or never queued
            if (wasInQueue) {
              log(emit, id, 'info', `Queue cleared but OOS`);
              wasInQueue = false;
            }
            const label = [
              result.availabilityStatus || 'OOS',
              result.source,
              result.confidence ? `conf:${result.confidence}` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            log(
              emit,
              id,
              'info',
              `Check #${ticks}${ms ? ` (${ms}ms)` : ''} — ${label}${proxyTag}`
            );
            setStatus(emit, id, 'oos', result.price ? `OOS · ${result.price}` : 'OUT OF STOCK');
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

        await sleep(jitterDelay(pollDelay, settings?.jitterPercent ?? 20), signal);
        }
      }

      return;
    }

    // ── REAL guest checkout ───────────────────────────────────────
    setStatus(emit, id, 'running', 'PKC guest checkout…');
    log(emit, id, 'info', `Guest checkout · ${task.product} · ${region}`);
    const proxy = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
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
    try {
      setStatus(emit, id, 'carting', 'ATC…');
      const res = await httpRequest(`${API_BASE}/api/checkout/pokemon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          product: task.product,
          proxy,
          sessionId: id,
          taskId: id,
          quantity: task.quantity || 1,
          region,
          placeOrder: !!(task as any).liveCheckout || (task as any).placeOrder === true,
          wait3dsSec: Number((task as any).wait3dsSec) || 120,
          captcha: {
            provider: (loadSettings() as any).captchaProvider,
            capmonsterKey: (loadSettings() as any).capmonsterKey,
            capmonsterHost: (loadSettings() as any).capmonsterHost,
            twocaptchaKey: (loadSettings() as any).twocaptchaKey,
            twocaptchaHost: (loadSettings() as any).twocaptchaHost,
          },
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
      const data = parseApi(ApiResponseSchema, res);
      if (data.stage === 'ordered' && data.ok) {
        setStatus(emit, id, 'success', 'Order placed');
        log(emit, id, 'success', data.orderNumber ? `Order ${data.orderNumber}` : data.message || '');
        emit({
          type: 'CHECKOUT_SUCCESS',
          taskId: id,
          data: {
            orderNumber: data.orderNumber || `PKC-${Date.now()}`,
            product: task.product,
            store: 'Pokemon Center',
            profile: task.profileId,
            price: data.price || '—',
            quantity: task.quantity,
          },
        });
        return;
      }
      if (data.stage === 'cart') {
        setStatus(emit, id, 'carted', 'In cart');
        log(emit, id, 'success', data.message || 'Guest ATC');
        if (!(task as any).liveCheckout) {
          emit({ type: 'CHECKOUT_SUCCESS', taskId: id, data: { orderNumber: data.orderNumber || 'DRY-RUN', product: task.product, store: 'Pokemon Center', profile: task.profileId, price: data.price || '—', quantity: task.quantity, dryRun: true } });
        }
        return;
      }
      if (data.stage === 'checkout') {
        setStatus(emit, id, 'checkout', 'Guest checkout');
        log(emit, id, 'info', data.message || 'Filled guest form');
        return;
      }
      if (data.stage === 'queue' || data.stage === 'queue_ready') {
        setStatus(emit, id, 'queued', 'Queue-it');
        log(
          emit,
          id,
          'warn',
          data.message ||
            'In Queue-it · SAME proxy — do not rotate · wait then Start again or leave Chrome'
        );
        return;
      }
      setStatus(emit, id, 'failed', data.stage || 'failed');
      log(emit, id, 'error', data.message || data.stage || 'Checkout failed');
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || data.stage || 'failed' });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      setStatus(emit, id, 'failed', 'Checkout error');
      log(emit, id, 'error', e?.message || String(e));
      emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: e?.message || 'error' });
    }
  },
};
