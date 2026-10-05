/** Chrome 110+ TLS extension permutation (ClientHello). */
const GREASE = [
  0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a, 0xaaaa, 0xbaba,
  0xcaca, 0xdada, 0xeaea, 0xfafa,
];

const CORE = [0, 5, 10, 11, 13, 16, 18, 23, 27, 35, 43, 45, 50, 51, 17513, 65037, 65281];

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function permuteChromeExtensions(psk = false): number[] {
  const g1 = GREASE[Math.floor(Math.random() * GREASE.length)];
  let g2 = GREASE[Math.floor(Math.random() * GREASE.length)];
  if (g2 === g1) g2 = GREASE[(GREASE.indexOf(g1) + 3) % GREASE.length];
  const body = shuffle(CORE);
  body.splice(Math.floor(Math.random() * (body.length + 1)), 0, g1);
  body.splice(Math.floor(Math.random() * (body.length + 1)), 0, g2);
  if (psk) body.push(41);
  return body;
}

export function tlsClientShuffleOptions(identifier = 'chrome_131') {
  return {
    tlsClientIdentifier: identifier,
    withRandomTLSExtensionOrder: true,
    followRedirects: true,
    timeoutSeconds: 12,
  };
}
