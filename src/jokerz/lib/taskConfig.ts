/** Task (UI) → engine config. Shared by Tasks view, remote commands and drop auto-start. */
import type { Task } from '../types';
import type { EngineTaskConfig } from '../engine';

export function priorityToNumber(p?: string, mode?: string): number {
  if (p === 'critical') return 3;
  if (p === 'high') return 2;
  if (p === 'low') return 0;
  if (p === 'normal') return 1;
  // auto from mode
  if (mode === 'monitor' || (mode || '').includes('monitor')) return 2;
  return 1;
}

export function taskToEngineConfig(t: Task): EngineTaskConfig {
  const product = String(t.product || t.sku || '').trim();
  return {
    id: t.id,
    store: t.store,
    mode: t.mode || 'checkout',
    product,
    // Always concrete profile name/id on the task (never group: after expand)
    profileId: t.profile,
    proxyGroup: t.proxy,
    quantity: Number(t.quantity) || 1,
    delay: t.delay || 4000,
    priority: priorityToNumber(t.priority, t.mode),
    extras: {
      sku: t.sku || (t.store === 'Target' ? product : t.sku),
      offerId: t.offerId,
      monitoringDelay: (t as any).monitoringDelay,
      resetDelay: (t as any).resetDelay,
      moduleUnlockDelay: (t as any).moduleUnlockDelay,
      monitorHighStock: !!(t as any).monitorHighStock,
      stockAlertCooldownMs: Number((t as any).stockAlertCooldownMs) || undefined,
      region: (t as any).region,
      storeId: (t as any).storeId,
      zip: (t as any).zip,
      accountEmail: (t as any).accountEmail,
      placeOrder: !!(t as any).liveCheckout || !!(t as any).placeOrder,
      liveCheckout: !!(t as any).liveCheckout || !!(t as any).placeOrder,
      solve3ds: (t as any).solve3ds !== false,
      proxyBind: (t as any).proxyBind === 'split' ? 'split' : 'same',
      loginProxy: (t as any).loginProxy || t.proxy,
      harvestProxy: (t as any).harvestProxy || t.proxy,
      checkoutProxy: (t as any).checkoutProxy || t.proxy,
      // fingerprint so engine always sees latest edit
      _updatedAt: Date.now(),
      _productKey: product,
    },
  };
}
