import {
  shuffleSamples,
  tlsClientShuffleOptions,
  nodeCannotShuffleNote,
  permuteChromeExtensions,
  describeHello,
} from "./tls-shuffle.mjs";

const CIPHERS = [
  "TLS_GREASE",
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
  "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
  "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
  "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
  "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
  "TLS_RSA_WITH_AES_128_GCM_SHA256",
  "TLS_RSA_WITH_AES_256_GCM_SHA384",
  "TLS_RSA_WITH_AES_128_CBC_SHA",
  "TLS_RSA_WITH_AES_256_CBC_SHA",
];

const H2 = {
  akamai: "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
  settings: {
    HEADER_TABLE_SIZE: 65536,
    ENABLE_PUSH: 0,
    INITIAL_WINDOW_SIZE: 6291456,
    MAX_HEADER_LIST_SIZE: 262144,
  },
  windowUpdate: 15663105,
  pseudoHeaderOrder: ["m", "a", "s", "p"],
};

const LOCK = {
  target: { id: "chrome-131-win", tlsClient: "chrome_131", major: 131 },
  walmart: { id: "chrome-131-win", tlsClient: "chrome_131", major: 131 },
  bandai: { id: "chrome-131-win", tlsClient: "chrome_131", major: 131 },
  pokemon: { id: "chrome-133-win", tlsClient: "chrome_133", major: 133 },
};

function specFor(mod) {
  const lock = LOCK[mod] || LOCK.target;
  const pq = lock.major >= 133;
  return {
    module: mod,
    profileId: lock.id,
    identifier: lock.tlsClient,
    minVersion: "1.2",
    maxVersion: "1.3",
    alpn: ["h2", "http/1.1"],
    grease: true,
    shuffleExtensions: true,
    ech: true,
    alps: true,
    compressCertificate: true,
    pskLast: true,
    ciphers: CIPHERS,
    groups: pq
      ? ["GREASE", "X25519MLKEM768", "x25519", "secp256r1", "secp384r1"]
      : ["GREASE", "x25519", "secp256r1", "secp384r1"],
    h2: H2,
    ja3: "unpinned — Chrome 110+ permutes extensions",
    ja4: `t13d${CIPHERS.length - 1}h2 · GREASE stripped`,
    ja4h: "Chrome header order (document vs xhr)",
    tlsClient: {
      ...tlsClientShuffleOptions(lock.tlsClient),
      forceHttp1: false,
      http2: true,
    },
  };
}

export function lockedAdvancedTls() {
  return Object.keys(LOCK).map((m) => specFor(m));
}

export function probeAdvancedTls(profileHint) {
  const samples = shuffleSamples(4);
  const plan = permuteChromeExtensions({ psk: false, ech: true });
  const mod =
    /pokemon|pkc/i.test(String(profileHint || ""))
      ? "pokemon"
      : /walmart/i.test(String(profileHint || ""))
        ? "walmart"
        : /bandai/i.test(String(profileHint || ""))
          ? "bandai"
          : "target";
  const spec = specFor(mod);
  return {
    ok: true,
    via: "preview-advanced-tls",
    module: mod,
    spec,
    shuffle: {
      enabled: true,
      ...samples,
      nextHello: describeHello(plan),
      wire: nodeCannotShuffleNote(),
    },
    tls: {
      via: "advanced-plan",
      identifier: spec.identifier,
      alpn: spec.alpn.join(","),
      h2Akamai: spec.h2.akamai,
      grease: true,
      randomTLSExtensionOrder: true,
      pskLast: true,
      ech: spec.ech,
      alps: spec.alps,
      ja3: spec.ja3,
      ja4: spec.ja4,
      groups: spec.groups,
      note: samples.shuffled
        ? `${samples.uniqueOrders} unique ClientHello orders · H2 ${spec.h2.akamai.slice(0, 24)}…`
        : "shuffle degenerated",
    },
    browser: {
      via: "preview",
      webdriver: false,
      pluginsLength: 5,
      userAgent: `Chrome/${spec.identifier.replace("chrome_", "")}`,
      tlsShuffle: true,
    },
  };
}
