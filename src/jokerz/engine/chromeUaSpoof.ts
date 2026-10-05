/**
 * Chrome UA spoofing tools.
 * Keeps User-Agent, Client Hints, userAgentData and TLS impersonation on the
 * same Chrome major so Shape / PX / DataDome see one browser — not 122+131 mixed.
 */
import {
  chromeClientHints,
  getActiveProfileForStore,
  getFingerprintProfile,
  type FingerprintProfile,
  type ModuleFpKey,
  MODULE_FP_LOCK,
} from './fingerprintProfiles';

export interface ChromeSpoofPack {
  store: string;
  profile: FingerprintProfile;
  headers: Record<string, string>;
  extraHTTPHeaders: Record<string, string>;
  userAgent: string;
  tlsClient: string;
  playwright: {
    userAgent: string;
    locale: string;
    timezoneId: string;
    viewport: { width: number; height: number };
    extraHTTPHeaders: Record<string, string>;
    args: string[];
  };
  initScript: string;
}

const PLAYWRIGHT_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
];

function brandsFor(profile: FingerprintProfile) {
  const major = String(profile.chromeMajor);
  return [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: 'Not_A Brand', version: '24' },
  ];
}

/** JS injected in Playwright/Puppeteer BEFORE any page script. */
export function buildChromeSpoofInitScript(profile: FingerprintProfile): string {
  const brands = JSON.stringify(brandsFor(profile));
  const ua = JSON.stringify(profile.ua);
  const full = JSON.stringify(profile.fullVersion);
  const platformVer = JSON.stringify(profile.platformVersion);
  return `(() => {
    const ua = ${ua};
    const brands = ${brands};
    const fullVersion = ${full};
    const platformVersion = ${platformVer};
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    } catch (e) {}
    try {
      Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
      Object.defineProperty(navigator, 'appVersion', {
        get: () => ua.replace('Mozilla/', ''),
        configurable: true,
      });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
      Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
      Object.defineProperty(navigator, 'language', { get: () => 'en-US', configurable: true });
      Object.defineProperty(navigator, 'languages', { get: () => Object.freeze(['en-US', 'en']), configurable: true });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
    } catch (e) {}
    try {
      const uad = {
        brands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async (hints) => {
          const all = {
            brands,
            mobile: false,
            platform: 'Windows',
            platformVersion,
            architecture: 'x86',
            bitness: '64',
            model: '',
            uaFullVersion: fullVersion,
            fullVersionList: brands.map((b) => ({
              brand: b.brand,
              version: b.brand.includes('Not') ? '10.0.2.3' : fullVersion,
            })),
            wow64: false,
          };
          const out = {};
          for (const h of hints || []) if (h in all) out[h] = all[h];
          return out;
        },
        toJSON() { return { brands, mobile: false, platform: 'Windows' }; },
      };
      Object.defineProperty(navigator, 'userAgentData', { get: () => uad, configurable: true });
    } catch (e) {}
    try {
      window.chrome = window.chrome || { runtime: {}, loadTimes: function () {}, csi: function () {} };
    } catch (e) {}
    try {
      const orig = navigator.permissions && navigator.permissions.query
        ? navigator.permissions.query.bind(navigator.permissions)
        : null;
      if (orig) {
        navigator.permissions.query = (p) =>
          p && p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission, onchange: null })
            : orig(p);
      }
    } catch (e) {}
  })();`;
}

export function spoofPackForStore(store?: string): ChromeSpoofPack {
  const profile = getActiveProfileForStore(store);
  const headers = chromeClientHints(profile);
  return {
    store: store || 'target',
    profile,
    headers,
    extraHTTPHeaders: headers,
    userAgent: profile.ua,
    tlsClient: profile.tlsClient,
    playwright: {
      userAgent: profile.ua,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: headers,
      args: PLAYWRIGHT_ARGS,
    },
    initScript: buildChromeSpoofInitScript(profile),
  };
}

export function spoofPackForModule(mod: ModuleFpKey): ChromeSpoofPack {
  return spoofPackForStore(mod);
}

/** Apply to a Playwright Page/Context (dynamic import safe). */
export async function applyChromeSpoofToContext(
  context: { setExtraHTTPHeaders?: (h: Record<string, string>) => Promise<void>; addInitScript?: (s: string | (() => void) | { content?: string }) => Promise<void> },
  store?: string
): Promise<ChromeSpoofPack> {
  const pack = spoofPackForStore(store);
  if (typeof context.setExtraHTTPHeaders === 'function') {
    await context.setExtraHTTPHeaders(pack.extraHTTPHeaders);
  }
  if (typeof context.addInitScript === 'function') {
    await context.addInitScript({ content: pack.initScript });
  }
  return pack;
}

export function lockedChromeMap(): { module: ModuleFpKey; profile: FingerprintProfile }[] {
  return (Object.keys(MODULE_FP_LOCK) as ModuleFpKey[]).map((module) => ({
    module,
    profile: getFingerprintProfile(MODULE_FP_LOCK[module]),
  }));
}

export { MODULE_FP_LOCK, getActiveProfileForStore, chromeClientHints };
