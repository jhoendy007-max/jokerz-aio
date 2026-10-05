/** RFC 6238 TOTP (6 digits, 30s). Secret: base32 or otpauth:// URI. */
import { createHmac } from "node:crypto";

function base32ToBuf(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(s || "")
    .replace(/otpauth:\/\/[^?]*\?[^]*secret=/i, "")
    .replace(/&.*$/, "")
    .replace(/[\s=-]/g, "")
    .toUpperCase();
  let bits = "";
  for (const c of clean) {
    const i = alphabet.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpNow(secret, { digits = 6, period = 30, t = Date.now() } = {}) {
  const key = base32ToBuf(secret);
  if (!key.length) return "";
  const counter = Math.floor(t / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export function hasTotpSecret(s) {
  return String(s || "").replace(/\s/g, "").length >= 10;
}

export function inspectTotp(secret, t = Date.now()) {
  const raw = String(secret || "").trim();
  if (raw.replace(/\s/g, "").length < 10) return { ok: false, code: "", remaining: 0, reason: "empty" };
  const code = totpNow(raw, { t });
  if (!code) return { ok: false, code: "", remaining: 0, reason: "bad-base32" };
  const remaining = 30 - (Math.floor(t / 1000) % 30);
  return { ok: true, code, remaining, reason: "ok" };
}
