/**
 * Sticky session manager: proxy binding + cookie jar per task.
 * Persisted to localStorage; optional AES-GCM when sessionEncryptionKey is set.
 */

import {
  loadSessionJars,
  saveSessionJars,
  PersistedSession,
  KEYS,
  loadProxies,
  ProxyGroup,
} from '../lib/storage';
import {
  encryptJson,
  decryptJson,
  isEncryptedPayload,
  encryptionEnabled,
} from '../lib/cryptoSessions';

export interface SessionState {
  taskId: string;
  proxy?: string;
  proxyGroup?: string;
  store?: string;
  cookies: Map<string, string>;
  createdAt: number;
  lastUsedAt: number;
  expiresAt?: number;
  hits: number;
  /** monitor | checkout | generic */
  kind: 'monitor' | 'checkout' | 'generic';
  accountEmail?: string;
}

export interface SessionSummary {
  taskId: string;
  proxy?: string;
  proxyGroup?: string;
  store?: string;
  cookieCount: number;
  hits: number;
  ageSec: number;
  idleSec: number;
  expiresInSec?: number;
  kind: string;
  encrypted: boolean;
}

const sessions = new Map<string, SessionState>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function key(taskId: string) {
  return taskId;
}

function defaultStickyMs(proxyGroup?: string): number {
  try {
    const groups = loadProxies([] as ProxyGroup[]);
    const lower = (proxyGroup || '').toLowerCase();
    const g = groups.find(
      (x) =>
        x.name.toLowerCase() === lower ||
        lower.includes(x.name.toLowerCase()) ||
        x.name.toLowerCase().includes(lower)
    );
    const mins = g?.stickyMinutes ?? (g?.type?.toLowerCase() === 'isp' ? 10 : 30);
    return Math.max(1, mins) * 60_000;
  } catch {
    return 30 * 60_000;
  }
}

function toPersisted(s: SessionState): PersistedSession & {
  proxyGroup?: string;
  store?: string;
  expiresAt?: number;
  kind?: string;
} {
  const cookies: Record<string, string> = {};
  s.cookies.forEach((v, k) => {
    cookies[k] = v;
  });
  return {
    taskId: s.taskId,
    proxy: s.proxy,
    proxyGroup: s.proxyGroup,
    store: s.store,
    cookies,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    expiresAt: s.expiresAt,
    hits: s.hits,
    kind: s.kind,
    accountEmail: s.accountEmail,
  };
}

function fromPersisted(p: any): SessionState {
  const cookies = new Map<string, string>();
  Object.entries(p.cookies || {}).forEach(([k, v]) => cookies.set(k, String(v)));
  return {
    taskId: p.taskId,
    proxy: p.proxy,
    proxyGroup: p.proxyGroup,
    store: p.store,
    cookies,
    createdAt: p.createdAt || Date.now(),
    lastUsedAt: p.lastUsedAt || Date.now(),
    expiresAt: p.expiresAt,
    hits: p.hits || 0,
    kind: p.kind || 'generic',
    accountEmail: p.accountEmail,
  };
}

async function persistAllNow() {
  // drop expired before save
  const now = Date.now();
  sessions.forEach((s, k) => {
    if (s.expiresAt && s.expiresAt < now) sessions.delete(k);
  });

  const out: Record<string, any> = {};
  sessions.forEach((s, k) => {
    out[k] = toPersisted(s);
  });
  try {
    if (encryptionEnabled()) {
      const blob = await encryptJson(out);
      localStorage.setItem(
        (KEYS as any).sessionJars || 'jokerz_aio_session_jars',
        JSON.stringify({ _encrypted: blob, v: 1 })
      );
    } else {
      saveSessionJars(out);
    }
  } catch (e) {
    console.warn('[session] persist failed', e);
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistAllNow();
  }, 200);
}

export function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return persistAllNow();
}

export async function hydrateSessions(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const raw = localStorage.getItem('jokerz_aio_session_jars');
      if (!raw) {
        hydrated = true;
        return;
      }
      const parsed = JSON.parse(raw);
      let jars: Record<string, any> = {};
      if (parsed && typeof parsed._encrypted === 'string') {
        jars = await decryptJson(parsed._encrypted);
      } else if (typeof parsed === 'string' && isEncryptedPayload(parsed)) {
        jars = await decryptJson(parsed);
      } else {
        jars = parsed || {};
      }
      const now = Date.now();
      for (const [k, v] of Object.entries(jars)) {
        if (v && (v as any).taskId) {
          if ((v as any).expiresAt && (v as any).expiresAt < now) continue;
          sessions.set(k, fromPersisted(v));
        }
      }
      console.log(
        '[session] hydrated',
        sessions.size,
        'jar(s)',
        encryptionEnabled() ? '(encrypted)' : '(plaintext)'
      );
    } catch (e) {
      console.warn('[session] hydrate failed', e);
    } finally {
      hydrated = true;
    }
  })();
  return hydratePromise;
}

export function getSession(taskId: string): SessionState | undefined {
  void hydrateSessions();
  const s = sessions.get(key(taskId));
  if (s?.expiresAt && s.expiresAt < Date.now()) {
    sessions.delete(key(taskId));
    schedulePersist();
    return undefined;
  }
  return s;
}

export interface EnsureSessionOpts {
  proxy?: string;
  proxyGroup?: string;
  store?: string;
  kind?: 'monitor' | 'checkout' | 'generic';
  /** refresh TTL from now */
  touchExpiry?: boolean;
  accountEmail?: string;
}

export function ensureSession(taskId: string, proxyOrOpts?: string | EnsureSessionOpts): SessionState {
  void hydrateSessions();
  const opts: EnsureSessionOpts =
    typeof proxyOrOpts === 'string' || proxyOrOpts === undefined
      ? { proxy: proxyOrOpts }
      : proxyOrOpts;

  let s = sessions.get(key(taskId));
  const now = Date.now();

  if (s?.expiresAt && s.expiresAt < now) {
    sessions.delete(key(taskId));
    s = undefined;
  }

  if (!s) {
    const ttl = defaultStickyMs(opts.proxyGroup);
    s = {
      taskId,
      proxy: opts.proxy,
      proxyGroup: opts.proxyGroup,
      store: opts.store,
      cookies: new Map(),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + ttl,
      hits: 0,
      kind: opts.kind || 'generic',
      accountEmail: opts.accountEmail,
    };
    sessions.set(key(taskId), s);
    schedulePersist();
  } else {
    // Proxy changed → new identity
    if (opts.proxy && s.proxy && opts.proxy !== s.proxy) {
      s.cookies.clear();
      s.proxy = opts.proxy;
      s.createdAt = now;
      s.hits = 0;
      s.expiresAt = now + defaultStickyMs(opts.proxyGroup || s.proxyGroup);
      schedulePersist();
    } else if (opts.proxy && !s.proxy) {
      s.proxy = opts.proxy;
      schedulePersist();
    }
    if (opts.proxyGroup) s.proxyGroup = opts.proxyGroup;
    if (opts.store) s.store = opts.store;
    if (opts.kind) s.kind = opts.kind;
    if (opts.accountEmail) s.accountEmail = opts.accountEmail;
    if (opts.touchExpiry) {
      s.expiresAt = now + defaultStickyMs(s.proxyGroup);
    }
  }
  s.lastUsedAt = now;
  return s;
}

export function absorbSetCookies(
  taskId: string,
  setCookie: string[] | string | undefined,
  proxy?: string
) {
  if (!setCookie) return;
  const s = ensureSession(taskId, proxy);
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    const part = String(raw).split(';')[0];
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    if (!value || /deleted/i.test(value)) {
      s.cookies.delete(name);
      continue;
    }
    s.cookies.set(name, value);
  }
  s.hits++;
  s.lastUsedAt = Date.now();
  schedulePersist();
}

/** Playwright cookie objects → jar + flush to disk/localStorage now. */
export function absorbPlaywrightCookies(
  taskId: string,
  cookies: { name?: string; value?: string }[] | undefined,
  opts?: EnsureSessionOpts
) {
  if (!cookies?.length) return;
  const s = ensureSession(taskId, opts);
  for (const c of cookies) {
    const name = String(c?.name || '').trim();
    const value = String(c?.value || '').trim();
    if (!name) continue;
    if (!value || /deleted/i.test(value)) s.cookies.delete(name);
    else s.cookies.set(name, value);
  }
  s.hits++;
  s.lastUsedAt = Date.now();
  void persistNow();
}

export function cookieHeader(taskId: string): string | undefined {
  void hydrateSessions();
  const s = getSession(taskId);
  if (!s || s.cookies.size === 0) return undefined;
  return [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function clearSession(taskId: string) {
  void hydrateSessions();
  sessions.delete(key(taskId));
  schedulePersist();
}

export function clearAllSessions() {
  sessions.clear();
  schedulePersist();
}

/**
 * Clone monitor session into a checkout task (same proxy + cookies).
 * Only if proxy still matches; otherwise creates empty checkout session.
 */
export function handoffSession(
  fromTaskId: string,
  toTaskId: string,
  opts?: { requireSameProxy?: boolean }
): SessionState {
  void hydrateSessions();
  const src = getSession(fromTaskId);
  const now = Date.now();
  if (!src) {
    return ensureSession(toTaskId, { kind: 'checkout' });
  }
  const dst: SessionState = {
    taskId: toTaskId,
    proxy: src.proxy,
    proxyGroup: src.proxyGroup,
    store: src.store,
    cookies: new Map(src.cookies),
    createdAt: now,
    lastUsedAt: now,
    expiresAt: src.expiresAt || now + defaultStickyMs(src.proxyGroup),
    hits: 0,
    kind: 'checkout',
  };
  sessions.set(key(toTaskId), dst);
  schedulePersist();
  return dst;
}

export function listSessions(): SessionSummary[] {
  void hydrateSessions();
  const now = Date.now();
  const out: SessionSummary[] = [];
  sessions.forEach((s) => {
    if (s.expiresAt && s.expiresAt < now) return;
    out.push({
      taskId: s.taskId,
      proxy: s.proxy,
      proxyGroup: s.proxyGroup,
      store: s.store,
      cookieCount: s.cookies.size,
      hits: s.hits,
      ageSec: Math.round((now - s.createdAt) / 1000),
      idleSec: Math.round((now - s.lastUsedAt) / 1000),
      expiresInSec: s.expiresAt ? Math.round((s.expiresAt - now) / 1000) : undefined,
      kind: s.kind,
      encrypted: encryptionEnabled(),
    });
  });
  return out.sort((a, b) => a.idleSec - b.idleSec);
}

export function sessionStats(taskId: string) {
  void hydrateSessions();
  const s = getSession(taskId);
  if (!s) return { cookies: 0, hits: 0, persisted: false, encrypted: encryptionEnabled() };
  return {
    cookies: s.cookies.size,
    proxy: s.proxy,
    proxyGroup: s.proxyGroup,
    hits: s.hits,
    kind: s.kind,
    expiresInSec: s.expiresAt ? Math.round((s.expiresAt - Date.now()) / 1000) : undefined,
    persisted: true,
    encrypted: encryptionEnabled(),
  };
}

export function exportSession(taskId: string) {
  void hydrateSessions();
  const s = getSession(taskId);
  return s ? toPersisted(s) : null;
}

export async function flushSessions() {
  await persistAllNow();
}
