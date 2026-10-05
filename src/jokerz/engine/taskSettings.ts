/**
 * Independent per-task settings read from EngineTaskConfig.
 * Never cross-link delay ↔ reset ↔ monitoring ↔ highStock.
 */
import type { EngineTaskConfig } from './types';

export interface ResolvedTaskSettings {
  /** Checkout / general delay */
  delayMs: number;
  /** Monitor poll interval (independent) */
  pollDelayMs: number;
  /** Error / reset backoff base (independent) */
  resetDelayMs: number;
  /** Pokemon module unlock delay (independent) */
  moduleUnlockDelayMs: number;
  /** Target high stock 10+ filter */
  monitorHighStock: boolean;
  region: string;
  sku?: string;
  offerId?: string;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveTaskSettings(
  task: EngineTaskConfig,
  defaults?: { delay?: number; poll?: number; reset?: number }
): ResolvedTaskSettings {
  const ex = (task.extras || {}) as Record<string, unknown>;
  const baseDelay = num(task.delay, defaults?.delay ?? 4000);

  // monitoringDelay is independent — do NOT fall back to task.delay unless missing
  const pollDelayMs =
    ex.monitoringDelay != null && String(ex.monitoringDelay) !== ''
      ? num(ex.monitoringDelay, baseDelay)
      : baseDelay;

  // resetDelay is independent — default 7500 if unset
  const resetDelayMs =
    ex.resetDelay != null && String(ex.resetDelay) !== ''
      ? num(ex.resetDelay, defaults?.reset ?? 7500)
      : defaults?.reset ?? 7500;

  const moduleUnlockDelayMs = num(ex.moduleUnlockDelay, 12222);

  return {
    delayMs: baseDelay,
    pollDelayMs,
    resetDelayMs,
    moduleUnlockDelayMs,
    monitorHighStock: !!ex.monitorHighStock,
    region: String(ex.region || 'US'),
    sku: ex.sku != null ? String(ex.sku) : undefined,
    offerId: ex.offerId != null ? String(ex.offerId) : undefined,
  };
}

export function settingsLogLine(s: ResolvedTaskSettings): string {
  return `poll ${s.pollDelayMs}ms · reset ${s.resetDelayMs}ms · delay ${s.delayMs}ms${
    s.monitorHighStock ? ' · highStock10+' : ''
  }`;
}
