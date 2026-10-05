/**
 * AES-GCM encryption for sticky session jars at rest.
 * Key is derived from a passphrase in Settings (PBKDF2).
 * If no passphrase is set, jars are stored as plaintext (compat).
 */

const ENC_PREFIX = 'enc:v1:';
const PBKDF2_ITERATIONS = 100_000;

function getPassphrase(): string {
  try {
    const raw = localStorage.getItem('jokerz_aio_settings');
    if (!raw) return '';
    const s = JSON.parse(raw);
    return (s.sessionEncryptionKey || s.sessionPassphrase || '').trim();
  } catch {
    return '';
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt UTF-8 string → enc:v1:salt.iv.cipher (base64 parts) */
export async function encryptString(plain: string): Promise<string> {
  const pass = getPassphrase();
  if (!pass || !crypto?.subtle) return plain;

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plain)
  );
  return `${ENC_PREFIX}${b64encode(salt)}.${b64encode(iv)}.${b64encode(cipher)}`;
}

export async function decryptString(payload: string): Promise<string> {
  if (!payload.startsWith(ENC_PREFIX)) return payload;
  const pass = getPassphrase();
  if (!pass || !crypto?.subtle) {
    throw new Error('Encrypted session jar but no passphrase in Settings');
  }
  const body = payload.slice(ENC_PREFIX.length);
  const [saltB64, ivB64, cipherB64] = body.split('.');
  if (!saltB64 || !ivB64 || !cipherB64) throw new Error('Corrupt encrypted payload');
  const salt = b64decode(saltB64);
  const iv = b64decode(ivB64);
  const cipher = b64decode(cipherB64);
  const key = await deriveKey(pass, salt);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

export function isEncryptedPayload(s: string): boolean {
  return typeof s === 'string' && s.startsWith(ENC_PREFIX);
}

export async function encryptJson(obj: unknown): Promise<string> {
  return encryptString(JSON.stringify(obj));
}

export async function decryptJson<T = unknown>(payload: string): Promise<T> {
  const plain = await decryptString(payload);
  return JSON.parse(plain) as T;
}

export function encryptionEnabled(): boolean {
  return getPassphrase().length > 0;
}
