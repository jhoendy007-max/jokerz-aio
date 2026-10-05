/**
 * Locked Chrome fingerprint per store.
 * Users do not configure this — each module always uses the recommended Chrome.
 */
export type FpProfileId = 'chrome-131-win' | 'chrome-133-win' | 'chrome-124-win';
export type ModuleFpKey = 'target' | 'walmart' | 'pokemon' | 'bandai';

export interface FingerprintProfile {
  id: FpProfileId;
  label: string;
  chromeMajor: number;
  fullVersion: string;
  ua: string;
  secChUa: string;
  secChUaFullVersionList: string;
  platform: 'Windows';
  secChUaPlatform: string;
  platformVersion: string;
  tlsClient: string;
  tlsShuffle: boolean;
  notes: string;
  bestFor: string[];
}

export const FP_PROFILES: FingerprintProfile[] = [
  {
    id: 'chrome-131-win',
    label: 'Chrome 131 · Windows',
    chromeMajor: 131,
    fullVersion: '131.0.6778.139',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaFullVersionList:
      '"Google Chrome";v="131.0.6778.139", "Chromium";v="131.0.6778.139", "Not_A Brand";v="10.0.2.3"',
    platform: 'Windows',
    secChUaPlatform: '"Windows"',
    platformVersion: '15.0.0',
    tlsClient: 'chrome_131',
    tlsShuffle: true,
    notes: 'Shape / PerimeterX — ClientHello permute (Chrome 110+).',
    bestFor: ['Target', 'Walmart', 'Bandai'],
  },
  {
    id: 'chrome-133-win',
    label: 'Chrome 133 · Windows',
    chromeMajor: 133,
    fullVersion: '133.0.6943.98',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="133", "Chromium";v="133", "Not_A Brand";v="24"',
    secChUaFullVersionList:
      '"Google Chrome";v="133.0.6943.98", "Chromium";v="133.0.6943.98", "Not_A Brand";v="10.0.2.3"',
    platform: 'Windows',
    secChUaPlatform: '"Windows"',
    platformVersion: '15.0.0',
    tlsClient: 'chrome_133',
    tlsShuffle: true,
    notes: 'DataDome / Queue-it — JA4 set + shuffled extension order.',
    bestFor: ['Pokemon Center'],
  },
  {
    id: 'chrome-124-win',
    label: 'Chrome 124 · Windows',
    chromeMajor: 124,
    fullVersion: '124.0.6367.118',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    secChUaFullVersionList:
      '"Chromium";v="124.0.6367.118", "Google Chrome";v="124.0.6367.118", "Not-A.Brand";v="10.0.1.4"',
    platform: 'Windows',
    secChUaPlatform: '"Windows"',
    platformVersion: '15.0.0',
    tlsClient: 'chrome_124',
    tlsShuffle: true,
    notes: 'Legacy only — not assigned to any live module.',
    bestFor: [],
  },
];

/** Hard lock — do not read Settings. */
export const MODULE_FP_LOCK: Record<ModuleFpKey, FpProfileId> = {
  target: 'chrome-131-win',
  walmart: 'chrome-131-win',
  pokemon: 'chrome-133-win',
  bandai: 'chrome-131-win',
};

export function listFingerprintProfiles(): FingerprintProfile[] {
  return FP_PROFILES;
}

export function getFingerprintProfile(id?: string | null): FingerprintProfile {
  return FP_PROFILES.find((p) => p.id === id) || FP_PROFILES[0];
}

export function storeToFpModule(store?: string): ModuleFpKey {
  const s = (store || '').toLowerCase();
  if (s.includes('walmart')) return 'walmart';
  if (s.includes('pokemon') || s.includes('pkc')) return 'pokemon';
  if (s.includes('bandai')) return 'bandai';
  return 'target';
}

/** Always the locked recommended profile for that store. */
export function getActiveProfileForStore(store?: string): FingerprintProfile {
  const mod = storeToFpModule(store);
  return getFingerprintProfile(MODULE_FP_LOCK[mod]);
}

export function chromeClientHints(profile: FingerprintProfile): Record<string, string> {
  return {
    'User-Agent': profile.ua,
    'sec-ch-ua': profile.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': profile.secChUaPlatform,
    'sec-ch-ua-platform-version': `"${profile.platformVersion}"`,
    'sec-ch-ua-full-version-list': profile.secChUaFullVersionList,
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-wow64': '?0',
  };
}

export function fingerprintSummary(store?: string): string {
  const p = getActiveProfileForStore(store);
  return `${p.label} · TLS ${p.tlsClient} (locked)`;
}
