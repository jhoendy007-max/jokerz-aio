/** RFC 6238 TOTP for the Accounts UI (browser). */
function base32ToBytes(s: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '')
    .replace(/otpauth:\/\/[^?]*\?[^]*secret=/i, '')
    .replace(/&.*$/, '')
    .replace(/[\s=-]/g, '')
    .toUpperCase();
  let bits = '';
  for (const c of clean) {
    const i = alphabet.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Uint8Array.from(bytes);
}

export function inspectTotp(secret?: string, t = Date.now()) {
  const raw = String(secret || '').trim();
  if (raw.replace(/\s/g, '').length < 10) {
    return { ok: false, code: '', remaining: 0, reason: 'empty' as const };
  }
  const key = base32ToBytes(raw);
  if (key.length < 10) {
    return { ok: false, code: '', remaining: 0, reason: 'bad-base32' as const };
  }
  const period = 30;
  const counter = Math.floor(t / 1000 / period);
  const remaining = period - (Math.floor(t / 1000) % period);
  return { ok: true, code: '', remaining, reason: 'ok' as const, counter, key };
}

/** Sync TOTP using a tiny HMAC via a precomputed table is not available — use SubtleCrypto. */
export async function totpCode(secret: string, t = Date.now()): Promise<string> {
  const inf = inspectTotp(secret, t);
  if (!inf.ok || !('key' in inf) || !inf.key) return '';
  const counter = inf.counter as number;
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const cryptoKey = await crypto.subtle.importKey('raw', inf.key as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export function totpRemaining(t = Date.now()) {
  return 30 - (Math.floor(t / 1000) % 30);
}
