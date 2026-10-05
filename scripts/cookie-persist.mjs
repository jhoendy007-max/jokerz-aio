/**
 * Durable cookie jars on disk (Refract-style).
 * Indexed by taskId and account email. Survives restart (not /tmp).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = process.env.JOKERZ_DATA || join(process.cwd(), "server");
export const COOKIE_JAR_FILE = process.env.JOKERZ_COOKIE_FILE || join(ROOT, ".cookie-jars.json");
const LEGACY_TMP = process.env.JOKERZ_LOGIN_FILE || "/tmp/jokerz-target-sessions.json";

/** Login cookies last up to 12h; Shape sensors shorter — we still keep the jar. */
const MAX_AGE_MS = Number(process.env.JOKERZ_COOKIE_TTL_MS) || 12 * 60 * 60 * 1000;
const STICKY_MS = Number(process.env.JOKERZ_COOKIE_STICKY_MS) || 25 * 60 * 1000;

function emptyStore() {
  return { v: 1, byTask: {}, byEmail: {} };
}

function loadStore() {
  try {
    if (existsSync(COOKIE_JAR_FILE)) {
      const j = JSON.parse(readFileSync(COOKIE_JAR_FILE, "utf8") || "{}");
      if (j && typeof j === "object") {
        return {
          v: 1,
          byTask: j.byTask && typeof j.byTask === "object" ? j.byTask : {},
          byEmail: j.byEmail && typeof j.byEmail === "object" ? j.byEmail : {},
        };
      }
    }
  } catch {
    /* */
  }
  const store = emptyStore();
  try {
    if (existsSync(LEGACY_TMP)) {
      const old = JSON.parse(readFileSync(LEGACY_TMP, "utf8") || "{}");
      for (const [email, s] of Object.entries(old || {})) {
        if (!s) continue;
        putJar(store, {
          email,
          taskId: s.sessionId,
          cookies: s.cookies || [],
          proxy: s.proxy || "",
          store: "Target",
          at: s.at || Date.now(),
        });
      }
      saveStore(store);
    }
  } catch {
    /* */
  }
  return store;
}

function saveStore(store) {
  try {
    mkdirSync(dirname(COOKIE_JAR_FILE), { recursive: true });
    const tmp = COOKIE_JAR_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 0));
    renameSync(tmp, COOKIE_JAR_FILE);
  } catch (e) {
    try {
      writeFileSync(COOKIE_JAR_FILE, JSON.stringify(store, null, 0));
    } catch {
      console.warn("[cookies] persist failed", e?.message || e);
    }
  }
}

function emailKey(email) {
  return String(email || "").trim().toLowerCase();
}

function cookieAlive(c, now = Date.now()) {
  if (!c || !c.name) return false;
  if (!c.value || /deleted/i.test(String(c.value))) return false;
  const exp = Number(c.expires);
  if (!Number.isFinite(exp) || exp <= 0) return true;
  const expMs = exp > 1e12 ? exp : exp * 1000;
  return expMs > now;
}

function pruneJar(jar, now = Date.now()) {
  if (!jar) return null;
  if (jar.expiresAt && jar.expiresAt < now) return null;
  if (now - (jar.at || 0) > MAX_AGE_MS) return null;
  const cookies = (jar.cookies || []).filter((c) => cookieAlive(c, now));
  if (!cookies.length) return null;
  return { ...jar, cookies };
}

function putJar(store, rec) {
  const now = Date.now();
  const jar = {
    taskId: rec.taskId || "",
    email: emailKey(rec.email),
    store: rec.store || "Target",
    proxy: rec.proxy || "",
    cookies: Array.isArray(rec.cookies) ? rec.cookies.filter((c) => cookieAlive(c, now)) : [],
    at: rec.at || now,
    expiresAt: rec.expiresAt || now + MAX_AGE_MS,
  };
  if (jar.taskId) store.byTask[jar.taskId] = jar;
  if (jar.email) store.byEmail[jar.email] = { ...jar, lastTaskId: jar.taskId };
  return jar;
}

let cache = null;
function store() {
  if (!cache) cache = loadStore();
  return cache;
}

export function persistCookies({ taskId, email, cookies, proxy, store: shop, expiresAt } = {}) {
  const s = store();
  const jar = putJar(s, { taskId, email, cookies, proxy, store: shop, expiresAt, at: Date.now() });
  saveStore(s);
  return jar;
}

function cookieKey(c) {
  return `${c.name}|${c.domain || ""}|${c.path || "/"}`;
}

/** Merge incoming cookies into the task/email jar (incoming wins on same name+domain). */
export function mergeCookies({ taskId, email, cookies, proxy, store: shop } = {}) {
  const existing = loadCookies({ taskId, email });
  const map = new Map();
  for (const c of existing?.cookies || []) {
    if (c?.name) map.set(cookieKey(c), c);
  }
  let added = 0;
  for (const c of cookies || []) {
    if (!c?.name || !c?.value) continue;
    const k = cookieKey(c);
    if (!map.has(k)) added += 1;
    map.set(k, c);
  }
  const jar = persistCookies({
    taskId: taskId || existing?.taskId,
    email: email || existing?.email,
    cookies: [...map.values()],
    proxy: proxy || existing?.proxy || "",
    store: shop || existing?.store || "Target",
  });
  return { jar, added, total: jar.cookies.length };
}

export function loadCookies({ taskId, email } = {}) {
  const s = store();
  const now = Date.now();
  let jar = null;
  if (taskId && s.byTask[taskId]) jar = pruneJar(s.byTask[taskId], now);
  if (!jar && email) jar = pruneJar(s.byEmail[emailKey(email)], now);
  return jar;
}

export function cookiesFresh(jar, stickyMs = STICKY_MS) {
  if (!jar) return false;
  return Date.now() - (jar.at || 0) < stickyMs && (jar.cookies || []).length > 0;
}

export function clearCookies({ taskId, email } = {}) {
  const s = store();
  if (taskId) delete s.byTask[taskId];
  if (email) delete s.byEmail[emailKey(email)];
  if (!taskId && !email) {
    s.byTask = {};
    s.byEmail = {};
  }
  saveStore(s);
}

export function listCookieJars() {
  const s = store();
  const now = Date.now();
  const out = [];
  const seen = new Set();
  for (const jar of [...Object.values(s.byTask), ...Object.values(s.byEmail)]) {
    const p = pruneJar(jar, now);
    if (!p) continue;
    const k = `${p.email}|${p.taskId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      email: p.email,
      taskId: p.taskId,
      store: p.store,
      cookieCount: (p.cookies || []).length,
      ageMin: Math.round((now - (p.at || 0)) / 60000),
      sticky: cookiesFresh(p),
      proxy: p.proxy || "",
    });
  }
  return out;
}

export function toCookieHeader(cookies = []) {
  return cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export function playwrightCookies(jar) {
  if (!jar?.cookies) return [];
  return jar.cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => {
      const raw = String(c.sameSite || c.same_site || "").toLowerCase();
      let sameSite = "Lax";
      if (raw === "strict") sameSite = "Strict";
      else if (raw === "none" || raw === "no_restriction") sameSite = "None";
      else if (raw === "lax") sameSite = "Lax";
      else if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") sameSite = c.sameSite;
      const secure = sameSite === "None" ? true : c.secure !== false;
      return {
        name: c.name,
        value: String(c.value),
        domain: c.domain || undefined,
        url: c.domain ? undefined : "https://www.target.com/",
        path: c.path || "/",
        expires: typeof c.expires === "number" ? c.expires : -1,
        httpOnly: !!c.httpOnly,
        secure,
        sameSite,
      };
    })
    .map((c) => {
      const out = { ...c };
      if (!out.domain) delete out.domain;
      else delete out.url;
      return out;
    });
}
