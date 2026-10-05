
/**
 * Automatic IP rotation policies (proactive, not only on block).
 */
import { loadSettings } from '../lib/storage';
import {
  resolveProxyFromGroup,
  releaseSticky,
  markProxyFailed,
  type ProxyRotationMode,
} from './proxy';
import { clearSession } from './session';

export interface AutoRotateState {
  checksOnIp: number;
  boundProxy?: string;
  boundAt: number;
}

const state = new Map<string, AutoRotateState>();

function getState(taskId: string): AutoRotateState {
  let s = state.get(taskId);
  if (!s) {
    s = { checksOnIp: 0, boundAt: Date.now() };
    state.set(taskId, s);
  }
  return s;
}

export function clearAutoRotateState(taskId: string) {
  state.delete(taskId);
}

export interface AutoRotateDecision {
  shouldRotate: boolean;
  reason?: string;
  nextProxy?: string;
}

/**
 * Call after each successful/failed check (not only blocks).
 * Returns a new proxy if policy says rotate.
 */
export function maybeAutoRotate(opts: {
  taskId: string;
  proxyGroup?: string;
  currentProxy?: string;
  /** true if AntiDetect already rotated this tick */
  alreadyRotated?: boolean;
}): AutoRotateDecision {
  if (opts.alreadyRotated) {
    // sync state to new IP
    const s = getState(opts.taskId);
    s.checksOnIp = 0;
    s.boundProxy = opts.currentProxy;
    s.boundAt = Date.now();
    return { shouldRotate: false };
  }

  const settings = loadSettings() as {
    autoRotateEvery?: number;
    autoRotateMinutes?: number;
    proxyRotation?: string;
  };

  const every = settings.autoRotateEvery ?? 0;
  const minutes = settings.autoRotateMinutes ?? 0;
  if ((!every || every <= 0) && (!minutes || minutes <= 0)) {
    // still track binding
    const s = getState(opts.taskId);
    if (opts.currentProxy && opts.currentProxy !== s.boundProxy) {
      s.boundProxy = opts.currentProxy;
      s.boundAt = Date.now();
      s.checksOnIp = 1;
    } else {
      s.checksOnIp++;
    }
    return { shouldRotate: false };
  }

  const s = getState(opts.taskId);
  const now = Date.now();

  if (opts.currentProxy && opts.currentProxy !== s.boundProxy) {
    s.boundProxy = opts.currentProxy;
    s.boundAt = now;
    s.checksOnIp = 1;
    return { shouldRotate: false };
  }

  s.checksOnIp++;

  let reason: string | undefined;
  if (every > 0 && s.checksOnIp >= every) {
    reason = `every ${every} checks`;
  }
  if (minutes > 0 && now - s.boundAt >= minutes * 60_000) {
    reason = reason ? `${reason} + ${minutes}m TTL` : `IP TTL ${minutes}m`;
  }

  if (!reason || !opts.proxyGroup) {
    return { shouldRotate: false };
  }

  // Soft-cooldown current so intelligent/least-used prefers others briefly
  if (opts.currentProxy) {
    markProxyFailed(opts.currentProxy, 15_000);
  }
  releaseSticky(opts.taskId);
  clearSession(opts.taskId);

  const mode = (settings.proxyRotation as ProxyRotationMode) || 'intelligent';
  const nextProxy = resolveProxyFromGroup(opts.proxyGroup, {
    taskId: opts.taskId,
    mode: mode === 'sticky' ? 'intelligent' : mode,
  });

  s.checksOnIp = 0;
  s.boundProxy = nextProxy;
  s.boundAt = now;

  return {
    shouldRotate: true,
    reason,
    nextProxy,
  };
}
