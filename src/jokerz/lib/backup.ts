/**
 * Backup / restore of the app's localStorage data.
 *
 * - "safe" export (default): secrets are removed — card number / CVV, account
 *   passwords and TOTP seeds, API keys, IMAP password, encryption key. Webhook URLs
 *   are removed too (anyone with the URL can post to your channel).
 * - "full" export: everything, encrypted with a passphrase you type (AES-GCM, PBKDF2).
 *
 * On import, secrets missing from a safe backup are kept from the current data
 * (so importing a safe backup never wipes your saved cards/keys), and the current
 * state is saved first under `jokerz_aio_backup_before_import` so you can undo.
 */
export const BACKUP_APP = 'jokerz-aio';
export const BACKUP_VERSION = 1;
export const UNDO_KEY = 'jokerz_aio_backup_before_import';

/** What goes into a backup. Session jars, task logs and proxy scores are runtime state → excluded. */
export const BACKUP_KEYS = {
  tasks: 'jokerz_aio_tasks',
  profiles: 'jokerz_aio_profiles',
  proxies: 'jokerz_aio_proxies',
  settings: 'jokerz_aio_settings',
  checkouts: 'jokerz_aio_checkouts',
  dashboardStats: 'jokerz_aio_dashboard_stats',
  drops: 'jokerz_aio_drops',
  history: 'jokerz_aio_monitor_history',
} as const;
export type BackupSection = keyof typeof BACKUP_KEYS;

export interface BackupFile {
  app: typeof BACKUP_APP;
  version: number;
  createdAt: string;
  mode: 'safe' | 'full';
  encrypted: boolean;
  /** plain data (safe) */
  data?: Partial<Record<BackupSection, unknown>>;
  /** enc payload (full): base64 salt.iv.cipher */
  payload?: string;
}

const SECRET_KEY_RE =
  /^(cardNumber|cvv|cvc|pass|password|totp|totpSecret|imapPass|sessionEncryptionKey|sessionPassphrase|\w*(ApiKey|apiKey|Key|Token|token|Secret|secret)|\w*Webhook)$/;
/** Keys that look secret by name but are just settings. */
const NOT_SECRET = new Set(['fingerprintProfileId', 'monitorKey', 'proxyKey', 'storeKey', 'sortKey']);

export function isSecretKey(k: string) {
  return SECRET_KEY_RE.test(k) && !NOT_SECRET.has(k);
}

/** Deep copy with secret fields removed. */
export function stripSecrets<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripSecrets(x)) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isSecretKey(k) && x !== '' && x != null) continue;
      out[k] = stripSecrets(x);
    }
    return out as T;
  }
  return v;
}

/**
 * Put back secrets that the incoming (safe) data lacks, taken from current data.
 * Objects: recursive. Arrays of objects: matched by `id`, then `email`, else index.
 */
export function restoreSecrets<T>(incoming: T, current: unknown): T {
  if (Array.isArray(incoming)) {
    const cur = Array.isArray(current) ? current : [];
    const key = (o: any) => (o && typeof o === 'object' ? o.id ?? o.email ?? undefined : undefined);
    return incoming.map((item, i) => {
      const k = key(item);
      const match = k !== undefined ? cur.find((c) => key(c) === k) : cur[i];
      return restoreSecrets(item, match);
    }) as T;
  }
  if (incoming && typeof incoming === 'object') {
    const cur = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(incoming as Record<string, unknown>)) out[k] = restoreSecrets(x, cur[k]);
    for (const [k, x] of Object.entries(cur)) {
      if (isSecretKey(k) && !(k in out) && x !== '' && x != null) out[k] = x;
    }
    return out as T;
  }
  return incoming;
}

// ─── crypto (own passphrase, independent of the session-jar key) ───
const ITER = 150_000;
const b64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
async function keyFrom(pass: string, salt: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function encryptWith(pass: string, plain: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(pass, salt), new TextEncoder().encode(plain));
  return `${b64(salt)}.${b64(iv)}.${b64(c)}`;
}
export async function decryptWith(pass: string, payload: string) {
  const [s, i, c] = String(payload).split('.');
  if (!s || !i || !c) throw new Error('Corrupt backup');
  try {
    const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(i) }, await keyFrom(pass, unb64(s)), unb64(c));
    return new TextDecoder().decode(p);
  } catch {
    throw new Error('Wrong passphrase');
  }
}

// ─── read / write storage ───
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const st = (): Store => localStorage;

export function readSections(store: Store = st()): Partial<Record<BackupSection, unknown>> {
  const out: Partial<Record<BackupSection, unknown>> = {};
  for (const [sec, key] of Object.entries(BACKUP_KEYS) as [BackupSection, string][]) {
    const raw = store.getItem(key);
    if (raw == null) continue;
    try {
      out[sec] = JSON.parse(raw);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export async function createBackup(opts: { mode: 'safe' | 'full'; passphrase?: string }, store: Store = st()): Promise<BackupFile> {
  const data = readSections(store);
  const base = { app: BACKUP_APP, version: BACKUP_VERSION, createdAt: new Date().toISOString(), mode: opts.mode } as const;
  if (opts.mode === 'full') {
    if (!opts.passphrase || opts.passphrase.length < 8) throw new Error('Passphrase must be at least 8 characters');
    return { ...base, encrypted: true, payload: await encryptWith(opts.passphrase, JSON.stringify(data)) };
  }
  return { ...base, encrypted: false, data: stripSecrets(data) };
}

export function parseBackupFile(text: string): BackupFile {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file');
  }
  if (!j || j.app !== BACKUP_APP) throw new Error('Not a Jokerz AIO backup');
  if (typeof j.version !== 'number' || j.version > BACKUP_VERSION) throw new Error(`Unsupported backup version ${j.version}`);
  if (j.encrypted ? typeof j.payload !== 'string' : !j.data || typeof j.data !== 'object') throw new Error('Backup is empty or corrupt');
  return j as BackupFile;
}

export async function backupData(file: BackupFile, passphrase?: string): Promise<Partial<Record<BackupSection, unknown>>> {
  if (!file.encrypted) return file.data || {};
  if (!passphrase) throw new Error('This backup is encrypted — enter its passphrase');
  return JSON.parse(await decryptWith(passphrase, file.payload || ''));
}

export function summarize(data: Partial<Record<BackupSection, unknown>>) {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);
  return Object.fromEntries((Object.keys(BACKUP_KEYS) as BackupSection[]).filter((k) => k in data).map((k) => [k, n(data[k])])) as Partial<
    Record<BackupSection, number>
  >;
}

/** Apply a backup. Saves current state to UNDO_KEY first. Returns sections written. */
export function applyBackup(data: Partial<Record<BackupSection, unknown>>, sections: BackupSection[], store: Store = st()) {
  const current = readSections(store);
  store.setItem(UNDO_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data: current }));
  const written: BackupSection[] = [];
  for (const sec of sections) {
    if (!(sec in data)) continue;
    const merged = restoreSecrets(data[sec], current[sec]);
    store.setItem(BACKUP_KEYS[sec], JSON.stringify(merged));
    written.push(sec);
  }
  return written;
}

export function hasUndo(store: Store = st()) {
  return store.getItem(UNDO_KEY) != null;
}

export function undoImport(store: Store = st()) {
  const raw = store.getItem(UNDO_KEY);
  if (!raw) throw new Error('Nothing to undo');
  const { data } = JSON.parse(raw) as { data: Partial<Record<BackupSection, unknown>> };
  for (const [sec, key] of Object.entries(BACKUP_KEYS) as [BackupSection, string][]) {
    if (sec in data) store.setItem(key, JSON.stringify(data[sec]));
    else store.removeItem(key);
  }
  store.removeItem(UNDO_KEY);
}

export function downloadJson(name: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}
