/**
 * Locked advanced TLS fingerprint per Chrome profile / store.
 * Shape (Akamai) + PX + DataDome look at this bundle, not just UA.
 */
import {
  getActiveProfileForStore,
  getFingerprintProfile,
  type FingerprintProfile,
  type FpProfileId,
  type ModuleFpKey,
  MODULE_FP_LOCK,
} from './fingerprintProfiles';
import { tlsClientShuffleOptions, permuteChromeExtensions } from './tlsShuffle';

export interface Http2Fingerprint {
  /** Akamai h2 fingerprint: settings|window_update|priority|pseudo */
  akamai: string;
  settings: Record<string, number>;
  windowUpdate: number;
  pseudoHeaderOrder: string[];
}

export interface TlsAdvancedSpec {
  profileId: FpProfileId;
  identifier: string;
  minVersion: '1.2';
  maxVersion: '1.3';
  alpn: string[];
  grease: boolean;
  shuffleExtensions: boolean;
  ech: boolean;
  alps: boolean;
  compressCertificate: boolean;
  pskLast: boolean;
  ciphers: string[];
  groups: string[];
  sigalgs: string[];
  h2: Http2Fingerprint;
  ja3Note: string;
  ja4Note: string;
  ja4hNote: string;
  tlsClient: ReturnType<typeof tlsClientShuffleOptions> & {
    forceHttp1: false;
    http2: true;
  };
}

const CHROME_CIPHERS = [
  'TLS_GREASE',
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA',
  'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
  'TLS_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_RSA_WITH_AES_128_CBC_SHA',
  'TLS_RSA_WITH_AES_256_CBC_SHA',
];

const CHROME_SIGALGS = [
  'ecdsa_secp256r1_sha256',
  'rsa_pss_rsae_sha256',
  'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384',
  'rsa_pss_rsae_sha384',
  'rsa_pkcs1_sha384',
  'rsa_pss_rsae_sha512',
  'rsa_pkcs1_sha512',
];

/** Chrome ~120–133 HTTP/2 / Akamai. */
const CHROME_H2: Http2Fingerprint = {
  akamai: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
  settings: {
    HEADER_TABLE_SIZE: 65536,
    ENABLE_PUSH: 0,
    INITIAL_WINDOW_SIZE: 6291456,
    MAX_HEADER_LIST_SIZE: 262144,
  },
  windowUpdate: 15663105,
  pseudoHeaderOrder: ['m', 'a', 's', 'p'],
};

function groupsFor(major: number): string[] {
  if (major >= 133) {
    return ['GREASE', 'X25519MLKEM768', 'x25519', 'secp256r1', 'secp384r1'];
  }
  return ['GREASE', 'x25519', 'secp256r1', 'secp384r1'];
}

export function buildTlsAdvanced(profile: FingerprintProfile): TlsAdvancedSpec {
  const ech = profile.chromeMajor >= 131;
  return {
    profileId: profile.id,
    identifier: profile.tlsClient,
    minVersion: '1.2',
    maxVersion: '1.3',
    alpn: ['h2', 'http/1.1'],
    grease: true,
    shuffleExtensions: profile.tlsShuffle !== false,
    ech,
    alps: true,
    compressCertificate: true,
    pskLast: true,
    ciphers: CHROME_CIPHERS,
    groups: groupsFor(profile.chromeMajor),
    sigalgs: CHROME_SIGALGS,
    h2: CHROME_H2,
    ja3Note: 'JA3 changes every hello (Chrome 110+ shuffle). Do not pin.',
    ja4Note: `t13d${CHROME_CIPHERS.length - 1}h2 · GREASE stripped · set-stable`,
    ja4hNote: 'Chrome document/xhr header order from headerPresets (JA4H).',
    tlsClient: {
      ...tlsClientShuffleOptions(profile.tlsClient),
      forceHttp1: false,
      http2: true,
    },
  };
}

export function getTlsAdvancedForStore(store?: string): {
  store: string;
  profile: FingerprintProfile;
  tls: TlsAdvancedSpec;
} {
  const profile = getActiveProfileForStore(store);
  return { store: store || 'target', profile, tls: buildTlsAdvanced(profile) };
}

export function getTlsAdvancedForProfile(id?: string | null): TlsAdvancedSpec {
  return buildTlsAdvanced(getFingerprintProfile(id));
}

export function lockedTlsMap(): { module: ModuleFpKey; profile: FingerprintProfile; tls: TlsAdvancedSpec }[] {
  return (Object.keys(MODULE_FP_LOCK) as ModuleFpKey[]).map((module) => {
    const profile = getFingerprintProfile(MODULE_FP_LOCK[module]);
    return { module, profile, tls: buildTlsAdvanced(profile) };
  });
}

export function tlsClientLaunchOptions(store?: string) {
  return getTlsAdvancedForStore(store).tls.tlsClient;
}

export function nextClientHelloPlan() {
  return permuteChromeExtensions(false);
}

export function tlsAlignmentWarnings(profile: FingerprintProfile): string[] {
  const w: string[] = [];
  const idMajor = Number(String(profile.tlsClient).replace(/\D/g, '').slice(0, 3));
  if (idMajor && idMajor !== profile.chromeMajor) {
    w.push(`TLS identifier ${profile.tlsClient} ≠ UA Chrome ${profile.chromeMajor}`);
  }
  if (!profile.tlsShuffle) w.push('Extension shuffle off — JA3 frozen = bot');
  return w;
}
