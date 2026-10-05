import { parseApi, MonitorResponseSchema, ApiResponseSchema, stockFromMonitor, rateLimitWaitMs, rlFields, type StockResult } from '../apiTypes';
import { recordMonitorHealth } from '../../lib/monitorHealth';
import { StoreModule, EngineTaskConfig, EngineEvent } from '../types';
import { log, setStatus, sleep } from './base';
import { jitterDelay, playAlertSound, exponentialBackoff } from '../notify';
import { loadSettings, loadProfiles, resolveProfile } from '../../lib/storage';
import { httpRequest, isCorsOrNetworkError } from '../http';
import { createTickScope, isAbortError } from '../abort';
import { resolveProxyFromGroup, resolveMonitorSharedProxy, getProxyGroupStats, markProxyFailed, releaseSticky, recordProxyResult, proxyRetryAfterMs, getGroupCooldownWaitMs, clearGroupProxyCooldowns, rotateIspProxy, isIspGroup, resolveIspModeForTask, logIspLatencySummary, maybeScheduleIspRotate } from '../proxy';
import { decideAntiDetect, applyAntiDetectRotation, describeGroupRotation } from '../antiDetect';
import { maybeAutoRotate } from '../autoRotate';
import { ensureSession, absorbSetCookies, cookieHeader, sessionStats } from '../session';
import { sendDiscordWebhook, sendAlert } from '../webhooks';
import { resolveTaskSettings, settingsLogLine } from '../taskSettings';
import { profileForStore } from '../moduleProfiles';
import { mergeModuleHeaders } from '../headerPresets';
import { getActiveProfileForStore } from '../fingerprintProfiles';

import { API_BASE } from '../apiBase';


async function checkBandaiStock(
  sku: string,
  signal: AbortSignal,
  proxy?: string,
  cookie?: string,
  sessionId?: string
): Promise<StockResult> {
  try {
    const res = await httpRequest(`${API_BASE}/api/monitor/bandai`, {
      method: 'POST',
      signal,
      timeoutMs: 20000,
      headers: { 'Content-Type': 'application/json' },
      body: {
        sku,
        proxy,
        cookie,
        taskId: sessionId,
        sessionId,
        fingerprintProfile: getActiveProfileForStore('bandai').id,
        tlsClient: getActiveProfileForStore('bandai').tlsClient,
        randomTLSExtensionOrder: true,
      },
    });

    let data: any;
    try {
      data = parseApi(MonitorResponseSchema, res);
      recordMonitorHealth('Bandai', sku, data);
    } catch {
      return { inStock: false, error: `Bad response (${res.status})` };
    }

    if (!data.ok && data.error) {
      return {
        ...rlFields(data),
        inStock: false,
        error: data.error,
        ms: data.ms,
        blocked: data.blocked,
      fingerprint: data.fingerprint,
      setCookie: data.setCookie,
      };
    }

    return {
      ...rlFields(data),
      inStock: !!data.inStock,
      price: data.price,
      title: data.title,
      ms: data.ms,
      error: data.error,
      availabilityStatus: data.availabilityStatus,
      source: data.source,
      blocked: data.blocked,
      fingerprint: data.fingerprint,
      setCookie: data.setCookie,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (isCorsOrNetworkError(err)) {
      return { inStock: false, error: 'Backend offline — start with: npm run server' };
    }
    return { inStock: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export const BandaiModule: StoreModule = {
  name: 'Bandai Collectables',
  supportedModes: ['normal', 'monitor'],

  validate(task) {
    if (!task.product) return 'SKU / product URL is required';
    if (!task.profileId && task.mode !== 'monitor') return 'Profile is required';
    return null;
  },

  async run(task: EngineTaskConfig, signal: AbortSignal, emit: (e: EngineEvent) => void) {
    const id = task.id;
    const sku = task.product.trim();
    const mode = task.mode || 'normal';

    if (mode === 'monitor') {
      setStatus(emit, id, 'running', 'Monitoring Bandai...');
      log(emit, id, 'info', `Bandai monitor · ${sku.slice(0, 80)}`);
      
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
        log(emit, id, 'warn', `Proxy group "${task.proxyGroup}" has 0 proxies — direct connection`);
      } else {
        log(emit, id, 'info', 'No proxy group · direct connection');
      }

      let ticks = 0;
      let consecutiveErrors = 0;
      let checksOnIp = 0;
      let lastInStock = false;
      let lastPrice: string | undefined;
      let lastWasError = false;
      
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

        let proxy = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
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
          ensureSession(id, { proxy, proxyGroup: task.proxyGroup, store: 'Bandai Collectables', kind: 'monitor', touchExpiry: true });
          // Isolated session per task+sku (same pattern as Target)
          const monitorSessionId = `${id}__${sku.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
          const result = await checkBandaiStock(
            sku,
            tickSignal,
            proxy,
            cookieHeader(id),
            monitorSessionId
          );
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
            blocked: !!result.blocked || /blocked|429/i.test(result.error || ''),
            ms: result.ms,
          });
          if (task.mode === 'monitor' && isIspGroup(task.proxyGroup) && !result.error) {
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
          if (result.blocked || /blocked|429|captcha/i.test(result.error || '')) {
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
              `Check #${ticks}${ms ? ` (${ms}ms)` : ''} — ${result.error}${proxyTag}${fpTag}`
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
              await sleep(exponentialBackoff(consecutiveErrors - 1, Math.max(resetDelayMs, errorBase || 2000), 2, 60000), signal);
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
            const label = result.availabilityStatus || (result.inStock ? 'IN_STOCK' : 'OOS');
            const extra = [result.price, result.source].filter(Boolean).join(' · ');
            log(
              emit,
              id,
              result.inStock ? 'success' : 'info',
              `Check #${ticks}${ms ? ` (${ms}ms)` : ''} — ${label}${extra ? ` · ${extra}` : ''}`
            );
            if (result.title) log(emit, id, 'info', result.title.slice(0, 80));

            if (result.inStock) {
              const normP = (x?: string) => String(x || '').replace(/[^0-9.]/g, '');
              if (result.price && lastPrice && normP(result.price) !== normP(lastPrice) && normP(result.price)) {
                const dir = parseFloat(normP(result.price)) < parseFloat(normP(lastPrice)) ? 'DROP' : 'RISE';
                log(emit, id, 'warn', `PRICE ${dir}: ${lastPrice} → ${result.price}`);
                void sendAlert('price', {
                  store: 'Bandai Collectables',
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
              // Stable key: digits from item_XXXX or full product string
              const rawProduct = String(sku || task.product || id);
              const digitKey = rawProduct.replace(/\D/g, '');
              const productId =
                digitKey.length >= 4
                  ? digitKey
                  : rawProduct
                      .replace(/^https?:\/\/[^/]+/i, '')
                      .replace(/\/+$/, '')
                      .toLowerCase() || rawProduct;
              if (!lastInStock) {
                log(
                  emit,
                  id,
                  'success',
                  `${productId} IN STOCK — monitor only · ping Discord + checkout tasks`
                );
                void sendAlert('stock', {
                  store: task.store || 'Bandai Collectables',
                  product: String(productId),
                  title: result.title,
                  price: result.price,
                  status: 'IN_STOCK',
                  taskId: id,
                  ms: result.ms,
                  productUrl: (result as any).finalUrl || undefined,
                });
                log(emit, id, 'info', 'Stock info → Discord/Slack');
                try {
                  playAlertSound('stock');
                } catch {}
                emit({
                  type: 'STOCK_DETECTED',
                  taskId: id,
                  store: String(task.store || 'Bandai Collectables'),
                  product: String(productId),
                  title: result.title,
                  price: result.price,
                  productUrl: (result as any).finalUrl || undefined,
                });
              } else {
                log(emit, id, 'info', `${productId} still in stock (monitor)`);
              }
              lastInStock = true;
            } else {
              if (lastInStock) log(emit, id, 'info', `[${sku}] Back to OOS`);
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

        await sleep(jitterDelay(pollDelay, settings?.jitterPercent ?? 20), signal);
        }
      }

      return;
    }

    // Real Bandai checkout
    setStatus(emit, id, 'running', 'Bandai checkout…');
    log(emit, id, 'info', `Checkout · ${task.product}`);
    const proxyCo = (task.mode === 'monitor' ? resolveMonitorSharedProxy(task.proxyGroup) : resolveProxyFromGroup(task.proxyGroup, { taskId: id }));
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
      const res = await httpRequest(`${API_BASE}/api/checkout/bandai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          sku: task.product,
          proxy: proxyCo,
          sessionId: id,
          taskId: id,
          quantity: task.quantity || 1,
          placeOrder: !!(task as any).liveCheckout || (task as any).placeOrder === true,
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
      const data = parseApi(ApiResponseSchema, res);
      log(
        emit,
        id,
        data.ok ? 'success' : 'info',
        `[bandai-status] stage=${data.stage || '?'} ok=${!!data.ok} ms=${data.ms || '?'} · ${data.message || ''}`
      );

      if (data.stage === 'ordered' && data.ok) {
        setStatus(emit, id, 'success', data.orderNumber ? `Order ${data.orderNumber}` : 'Ordered');
        log(emit, id, 'success', data.orderNumber || data.message || 'Ordered');
        emit({
          type: 'CHECKOUT_SUCCESS',
          taskId: id,
          data: {
            orderNumber: data.orderNumber || `BC-${Date.now()}`,
            product: task.product,
            store: 'Bandai Collectables',
            profile: task.profileId,
            price: '—',
            quantity: task.quantity,
          },
        });
        return;
      }
      if (data.stage === 'cart' || data.stage === 'checkout') {
        setStatus(emit, id, data.stage === 'cart' ? 'carted' : 'checkout', data.message || data.stage || '');
        if (!data.ok) {
          emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || data.stage });
        }
        return;
      }
      if (data.stage === 'needs_3ds') {
        setStatus(emit, id, 'checkout', 'Needs 3DS');
        log(emit, id, 'warn', data.message || '3DS / confirm timeout');
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'needs_3ds' });
        return;
      }
      if (data.stage === 'oos') {
        setStatus(emit, id, 'oos', 'OOS');
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: 'OOS' });
        return;
      }
      if (data.stage === 'blocked') {
        setStatus(emit, id, 'failed', 'Blocked');
        if (proxyCo) markProxyFailed(proxyCo);
        emit({ type: 'CHECKOUT_FAILED', taskId: id, reason: data.message || 'Blocked' });
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
