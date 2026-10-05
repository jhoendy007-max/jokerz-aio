/**
 * Chrome 110+ ClientHello extension permutation.
 * Wire-level shuffle needs tls-client/uTLS; this module:
 *  - builds a Chrome-like extension list (GREASE + shuffle + PSK last)
 *  - exposes tls-client options (withRandomTLSExtensionOrder)
 *  - never claims Node/undici shuffled the ClientHello
 */

const GREASE_VALUES = [
  0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a,
  0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa,
];

/** Chrome 131-era extension IDs (excluding GREASE and PSK). */
export const CHROME_CORE_EXTENSIONS = Object.freeze([
  0, // server_name
  5, // status_request
  10, // supported_groups
  11, // ec_point_formats
  13, // signature_algorithms
  16, // ALPN
  18, // signed_certificate_timestamp
  23, // extended_master_secret
  27, // compress_certificate
  35, // session_ticket
  43, // supported_versions
  45, // psk_key_exchange_modes
  50, // signature_algorithms_cert
  51, // key_share
  17513, // application_settings (ALPS)
  65037, // encrypted_client_hello (newer Chrome; 131 may omit)
  65281, // renegotiation_info
]);

const EXT_NAME = {
  0: "server_name",
  5: "status_request",
  10: "supported_groups",
  11: "ec_point_formats",
  13: "signature_algorithms",
  16: "ALPN",
  18: "signed_certificate_timestamp",
  23: "extended_master_secret",
  27: "compress_certificate",
  35: "session_ticket",
  41: "pre_shared_key",
  43: "supported_versions",
  45: "psk_key_exchange_modes",
  50: "signature_algorithms_cert",
  51: "key_share",
  17513: "application_settings",
  65037: "encrypted_client_hello",
  65281: "renegotiation_info",
};

function isGrease(id) {
  return GREASE_VALUES.includes(id);
}

function cryptoShuffle(arr) {
  const a = arr.slice();
  const buf = new Uint32Array(a.length);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(buf);
  else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = a.length - 1; i > 0; i--) {
    const j = buf[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickGrease(except = new Set()) {
  const pool = GREASE_VALUES.filter((g) => !except.has(g));
  return pool[Math.floor(Math.random() * pool.length)] || 0x0a0a;
}

export function nameOfExt(id) {
  if (isGrease(id)) return `GREASE(0x${id.toString(16)})`;
  return EXT_NAME[id] || `ext_${id}`;
}

/**
 * Chromium-style ClientHello extension order for one handshake.
 * PSK (41) always last. Two GREASE slots mixed into the shuffled list.
 */
export function permuteChromeExtensions({ psk = false, ech = true } = {}) {
  const used = new Set();
  const g1 = pickGrease(used);
  used.add(g1);
  const g2 = pickGrease(used);

  const core = CHROME_CORE_EXTENSIONS.filter((id) => ech || id !== 65037);
  const shuffled = cryptoShuffle(core);

  // GREASE injected at random indexes (not after PSK).
  const body = shuffled.slice();
  const i1 = Math.floor(Math.random() * (body.length + 1));
  body.splice(i1, 0, g1);
  const i2 = Math.floor(Math.random() * (body.length + 1));
  body.splice(i2, 0, g2);

  if (psk) body.push(41);
  return body;
}

export function describeHello(ids) {
  return ids.map((id) => ({ id, hex: "0x" + id.toString(16), name: nameOfExt(id) }));
}

export function ja3ExtensionsField(ids) {
  return ids.join("-");
}

/** Options for bogdanfinn/tls-client (Node wrapper). */
export function tlsClientShuffleOptions(identifier = "chrome_131") {
  return {
    tlsClientIdentifier: identifier,
    followRedirects: true,
    timeoutSeconds: 12,
    withRandomTLSExtensionOrder: true,
    catchPanics: true,
    insecureSkipVerify: false,
  };
}

export function curlCffiShuffleHint(identifier = "chrome131") {
  return {
    impersonate: identifier.replace("_", ""),
    // curl_cffi Chrome 110+ impersonate already permutes extensions
    ja3: null,
    note: "curl_cffi chrome110+ shuffles ClientHello like Chrome; do not pin a JA3 string",
  };
}

export function shuffleSamples(n = 3) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const ids = permuteChromeExtensions({ psk: false, ech: true });
    samples.push({
      order: ids,
      named: describeHello(ids).map((x) => x.name),
      ja3_ext_field: ja3ExtensionsField(ids),
    });
  }
  const unique = new Set(samples.map((s) => s.ja3_ext_field));
  return {
    shuffled: unique.size > 1 || n === 1,
    uniqueOrders: unique.size,
    samples,
    constraints: {
      psk_always_last: true,
      grease_slots: 2,
      algorithm: "chrome-110-permute",
    },
  };
}

export function nodeCannotShuffleNote() {
  return {
    wireShuffled: false,
    via: "undici/openssl",
    reason:
      "Node fetch/https uses OpenSSL ClientHello (fixed extension order, no GREASE). Enable tls-client withRandomTLSExtensionOrder or curl_cffi chrome impersonate on the PC server.",
  };
}
