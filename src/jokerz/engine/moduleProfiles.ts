/**
 * Hybrid per-module profiles — each store runs at its recommended stack + anti-detect.
 */
export type ModuleId = 'Target' | 'Walmart' | 'Pokemon Center' | 'Bandai Collectables' | string;

export interface ModuleProfile {
  id: ModuleId;
  /** Primary antibot expected */
  antibot: 'shape' | 'perimeterx' | 'datadome' | 'imperva' | 'queue-it' | 'light' | 'mixed';
  /** Prefer browser for product checks */
  forceBrowser: boolean;
  /** Prefer TLS-client/curl_cffi when no session */
  preferTls: boolean;
  /** Recommended poll delay ms */
  pollDelayMs: number;
  /** Recommended reset delay ms */
  resetDelayMs: number;
  /** IP cooldown after PX/Shape block ms */
  blockCooldownMs: number;
  /** Anti-detect strictness multiplier (on top of settings) */
  antiDetectMult: number;
  /** Proxy type hint */
  proxyHint: 'isp' | 'resi' | 'mixed';
  /** Threat floor when provider matches */
  escalateProviders: string[];
  notes: string;
}

export const MODULE_PROFILES: Record<string, ModuleProfile> = {
  Target: {
    id: 'Target',
    antibot: 'mixed',
    forceBrowser: true,
    preferTls: false,
    pollDelayMs: 5000,
    resetDelayMs: 6000,
    blockCooldownMs: 180_000,
    antiDetectMult: 1.3,
    proxyHint: 'isp',
    escalateProviders: ['shape', 'akamai', 'kasada', 'perimeterx', 'px', 'human'],
    notes: '2026 dual-stack Shape+PX · testing-ready ~70% · dry-run ATC first, 3DS waits 180s headed',
  },
  Walmart: {
    id: 'Walmart',
    antibot: 'perimeterx',
    forceBrowser: true,
    preferTls: false,
    pollDelayMs: 10000,
    resetDelayMs: 15000,
    blockCooldownMs: 240_000, // PX burns DC fast — longer rest
    antiDetectMult: 1.45, // strictest recommended for PX
    proxyHint: 'isp',
    escalateProviders: ['perimeterx', 'px', 'human'],
    notes: 'PerimeterX — ISP/residential sticky, longer cooldown, browser stealth',
  },
  'Pokemon Center': {
    id: 'Pokemon Center',
    antibot: 'queue-it',
    forceBrowser: true,
    preferTls: true,
    pollDelayMs: 8000,
    resetDelayMs: 10000,
    blockCooldownMs: 90_000,
    antiDetectMult: 1.1,
    proxyHint: 'isp',
    escalateProviders: ['imperva', 'datadome', 'queue-it', 'cloudflare'],
    notes: 'Queue-it + Imperva Error15 + DataDome — clean ISP, don’t thrash',
  },
  'Bandai Collectables': {
    id: 'Bandai Collectables',
    antibot: 'light',
    forceBrowser: true,
    preferTls: true,
    pollDelayMs: 9000,
    resetDelayMs: 8000,
    blockCooldownMs: 120_000,
    antiDetectMult: 1.0,
    proxyHint: 'mixed',
    escalateProviders: ['shape', 'cloudflare'],
    notes: 'Lighter antibot — browser + moderate delay',
  },
};

export function profileForStore(store: string): ModuleProfile {
  const key = Object.keys(MODULE_PROFILES).find(
    (k) => k.toLowerCase() === (store || '').toLowerCase()
  );
  return key
    ? MODULE_PROFILES[key]
    : {
        id: store,
        antibot: 'mixed',
        forceBrowser: true,
        preferTls: true,
        pollDelayMs: 10000,
        resetDelayMs: 10000,
        blockCooldownMs: 120_000,
        antiDetectMult: 1.15,
        proxyHint: 'isp',
        escalateProviders: ['shape', 'perimeterx', 'datadome'],
        notes: 'Generic hybrid profile',
      };
}
