/**
 * Per-module HTTP header presets (Chrome-like) for monitors / API calls.
 * UA + client hints come from fingerprintProfiles so they stay aligned.
 */
import { chromeClientHints, getActiveProfileForStore } from './fingerprintProfiles';

export type HeaderPresetKind = 'document' | 'xhr' | 'api';

function baseChromeDocument(
  extra?: Record<string, string>,
  store?: string
): Record<string, string> {
  const hints = chromeClientHints(getActiveProfileForStore(store));
  return {
    ...hints,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Cache-Control': 'max-age=0',
    ...extra,
  };
}

function baseChromeXhr(
  hostOrigin: string,
  extra?: Record<string, string>,
  store?: string
): Record<string, string> {
  const hints = chromeClientHints(getActiveProfileForStore(store));
  return {
    ...hints,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Origin: hostOrigin,
    Referer: `${hostOrigin}/`,
    ...extra,
  };
}

type StoreKey = 'target' | 'walmart' | 'pokemon' | 'bandai' | 'generic';

function normalizeStore(store?: string): StoreKey {
  const s = (store || '').toLowerCase();
  if (s.includes('target')) return 'target';
  if (s.includes('walmart')) return 'walmart';
  if (s.includes('pokemon') || s.includes('pkc')) return 'pokemon';
  if (s.includes('bandai')) return 'bandai';
  return 'generic';
}

function presetsFor(store: string): Record<HeaderPresetKind, Record<string, string>> {
  const key = normalizeStore(store);
  if (key === 'target') {
    return {
      document: baseChromeDocument({ Referer: 'https://www.target.com/' }, 'target'),
      xhr: baseChromeXhr('https://www.target.com', {
        Accept: 'application/json',
        Referer: 'https://www.target.com/',
        Origin: 'https://www.target.com',
      }, 'target'),
      api: baseChromeXhr('https://www.target.com', {
        Accept: 'application/json',
        Referer: 'https://www.target.com/',
        Origin: 'https://www.target.com',
      }, 'target'),
    };
  }
  if (key === 'walmart') {
    return {
      document: baseChromeDocument({ Referer: 'https://www.walmart.com/' }, 'walmart'),
      xhr: baseChromeXhr('https://www.walmart.com', {
        Accept: 'application/json',
        Referer: 'https://www.walmart.com/',
        Origin: 'https://www.walmart.com',
        'x-o-platform': 'rweb',
        'x-o-segment': 'oaoh',
      }, 'walmart'),
      api: baseChromeXhr('https://www.walmart.com', {
        Accept: 'application/json',
        Referer: 'https://www.walmart.com/',
        Origin: 'https://www.walmart.com',
        'x-o-platform': 'rweb',
        'x-o-segment': 'oaoh',
      }, 'walmart'),
    };
  }
  if (key === 'pokemon') {
    return {
      document: baseChromeDocument({ Referer: 'https://www.pokemoncenter.com/' }, 'pokemon'),
      xhr: baseChromeXhr('https://www.pokemoncenter.com', {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.pokemoncenter.com/',
        Origin: 'https://www.pokemoncenter.com',
      }, 'pokemon'),
      api: baseChromeXhr('https://www.pokemoncenter.com', {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.pokemoncenter.com/',
        Origin: 'https://www.pokemoncenter.com',
      }, 'pokemon'),
    };
  }
  if (key === 'bandai') {
    return {
      document: baseChromeDocument({ Referer: 'https://www.bandai.com/' }, 'bandai'),
      xhr: baseChromeXhr('https://www.bandai.com', {
        Referer: 'https://www.bandai.com/',
        Origin: 'https://www.bandai.com',
      }, 'bandai'),
      api: baseChromeXhr('https://www.bandai.com', {
        Referer: 'https://www.bandai.com/',
        Origin: 'https://www.bandai.com',
      }, 'bandai'),
    };
  }
  return {
    document: baseChromeDocument(undefined, 'generic'),
    xhr: baseChromeXhr('https://www.google.com', undefined, 'generic'),
    api: baseChromeXhr('https://www.google.com', undefined, 'generic'),
  };
}

export function getModuleHeaders(
  store: string,
  kind: HeaderPresetKind = 'document'
): Record<string, string> {
  return { ...presetsFor(store)[kind] };
}

export function mergeModuleHeaders(
  store: string,
  opts?: {
    kind?: HeaderPresetKind;
    headers?: Record<string, string>;
    cookie?: string;
    referer?: string;
    origin?: string;
  }
): Record<string, string> {
  const base = getModuleHeaders(store, opts?.kind || 'document');
  const out: Record<string, string> = { ...base, ...(opts?.headers || {}) };
  if (opts?.cookie) out['Cookie'] = opts.cookie;
  if (opts?.referer) out['Referer'] = opts.referer;
  if (opts?.origin) out['Origin'] = opts.origin;
  return out;
}

export function listHeaderPresets(): { store: string; kinds: HeaderPresetKind[] }[] {
  return (['target', 'walmart', 'pokemon', 'bandai', 'generic'] as StoreKey[]).map((store) => ({
    store,
    kinds: ['document', 'xhr', 'api'],
  }));
}
