/**
 * Assisted manual login: opens a normal visible browser window on the store's
 * sign-in page, YOU sign in (password, 2FA, whatever the store asks), then the
 * app saves that browser's cookies as the account session for tasks.
 * No automation of the login form, no captcha handling.
 *
 * Also: account/session status for the UI (#7) and expiry info (#8).
 */
import { persistCookies, listCookieJars, loadCookies } from "./cookie-persist.mjs";
import { classifyLoginError } from "./monitor-status.mjs";

export const LOGIN_PAGES = {
  target: "https://www.target.com/account",
  walmart: "https://www.walmart.com/account/login",
  pokemon: "https://www.pokemoncenter.com/account/login",
  bandai: "https://p-bandai.com/us/login",
};
const STORE_NAME = { target: "Target", walmart: "Walmart", pokemon: "Pokemon Center", bandai: "Bandai" };
const MAX_OPEN_MS = 15 * 60_000;

/** Jar id of a manual session for one store + email. */
export function manualJarId(store, email) {
  return `manual:${storeKey(store) || "x"}:${String(email || "").trim().toLowerCase()}`;
}

/**
 * Manual sessions live until the store's own auth cookies expire, capped at 3 days,
 * default 12 h when the store does not say.
 */
export function manualExpiry(cookies = [], now = Date.now()) {
  const auth = cookies.filter((c) => /auth|token|session|sid|login|idToken|acid|customer/i.test(String(c?.name || "")));
  const exps = auth
    .map((c) => Number(c.expires))
    .filter((e) => Number.isFinite(e) && e > 0)
    .map((e) => (e > 1e12 ? e : e * 1000))
    .filter((e) => e > now);
  const cap = now + 3 * 24 * 3600_000;
  if (!exps.length) return now + 12 * 3600_000;
  return Math.min(cap, Math.max(...exps));
}

export function storeKey(s) {
  const v = String(s || "").toLowerCase();
  if (v.includes("target")) return "target";
  if (v.includes("walmart")) return "walmart";
  if (v.includes("pokemon")) return "pokemon";
  if (v.includes("bandai")) return "bandai";
  return null;
}

const jobs = new Map(); // id → { id, store, email, status, startedAt, browser, context, error, cookieCount }

function publicJob(j) {
  if (!j) return null;
  const { browser, context, timer, ...rest } = j;
  return rest;
}

async function openBrowser() {
  const { chromium } = await import("playwright");
  // Prefer the installed Google Chrome; fall back to Playwright's Chromium.
  try {
    return await chromium.launch({ headless: false, channel: "chrome" });
  } catch {
    return chromium.launch({ headless: false });
  }
}

export async function startManualLogin({ store, email } = {}) {
  const key = storeKey(store);
  if (!key) return { ok: false, error: "Unknown store" };
  const mail = String(email || "").trim().toLowerCase();
  if (!mail) return { ok: false, error: "Email required (to know which account this session belongs to)" };
  for (const j of jobs.values()) {
    if (j.email === mail && j.store === key && j.status === "waiting") return { ok: true, id: j.id, already: true, job: publicJob(j) };
  }
  const id = `ml-${Date.now().toString(36)}`;
  const job = { id, store: key, storeName: STORE_NAME[key], email: mail, status: "opening", startedAt: Date.now() };
  jobs.set(id, job);
  try {
    job.browser = await openBrowser();
    job.context = await job.browser.newContext({ viewport: null });
    // Reuse the existing session if there is one, so a still-valid login stays valid.
    const prev = loadCookies({ email: mail });
    if (prev?.cookies?.length) {
      await job.context
        .addCookies(prev.cookies.filter((c) => c?.name && c?.domain).map((c) => ({ ...c, sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax" })))
        .catch(() => {});
    }
    const page = await job.context.newPage();
    job.browser.on("disconnected", () => {
      if (job.status === "waiting" || job.status === "opening") job.status = "closed";
    });
    await page.goto(LOGIN_PAGES[key], { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    job.status = "waiting";
    job.timer = setTimeout(() => {
      if (job.status === "waiting") {
        job.status = "timeout";
        job.browser?.close().catch(() => {});
      }
    }, MAX_OPEN_MS);
    return { ok: true, id, job: publicJob(job) };
  } catch (e) {
    job.status = "error";
    job.error = /Executable doesn't exist|browserType\.launch/i.test(String(e?.message))
      ? "No browser available — run: npx playwright install chromium"
      : e?.message || String(e);
    return { ok: false, id, error: job.error, ...classifyLoginError(job.error) };
  }
}

export function manualLoginStatus(id) {
  return publicJob(jobs.get(id));
}

export async function saveManualLogin(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "Login window not found (it may have expired)" };
  if (job.status !== "waiting") return { ok: false, error: `Window is ${job.status}` };
  try {
    const cookies = await job.context.cookies();
    if (!cookies.length) return { ok: false, error: "No cookies yet — finish signing in first" };
    const expiresAt = manualExpiry(cookies);
    // store-specific copy (an email can have sessions on several stores) + the email jar tasks already read
    persistCookies({ taskId: manualJarId(job.store, job.email), email: job.email, cookies, store: job.storeName, source: "manual", expiresAt });
    persistCookies({ taskId: job.email, email: job.email, cookies, store: job.storeName, source: "manual", expiresAt });
    job.cookieCount = cookies.length;
    job.status = "saved";
    clearTimeout(job.timer);
    await job.browser.close().catch(() => {});
    return { ok: true, id, cookieCount: cookies.length, job: publicJob(job) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function cancelManualLogin(id) {
  const job = jobs.get(id);
  if (!job) return { ok: true };
  if (job.status === "waiting" || job.status === "opening") job.status = "cancelled";
  clearTimeout(job.timer);
  await job.browser?.close().catch(() => {});
  return { ok: true, job: publicJob(job) };
}

/** Session state per saved account jar. */
export function sessionState(jar, now = Date.now()) {
  const exp = Number(jar.expiresAt) || 0;
  if (!jar.cookieCount) return { state: "expired", minutesLeft: 0 };
  if (exp && now >= exp) return { state: "expired", minutesLeft: 0 };
  const left = exp ? Math.round((exp - now) / 60000) : null;
  if (left != null && left <= 60) return { state: "expiring", minutesLeft: left };
  return { state: "active", minutesLeft: left };
}

export function accountsStatus({ loginJobs = [] } = {}) {
  const now = Date.now();
  const jars = listCookieJars();
  const out = [];
  const seen = new Set();
  for (const j of jars) {
    const email = String(j.email || "").toLowerCase();
    const k = `${email}|${j.store}`;
    if (!email || seen.has(k)) continue;
    seen.add(k);
    const full = loadCookies({ email });
    const st = sessionState({ ...j, expiresAt: full?.expiresAt }, now);
    out.push({
      email,
      store: j.store || "Target",
      cookieCount: j.cookieCount,
      lastLoginMin: j.ageMin,
      expiresAt: full?.expiresAt || null,
      manual: full?.source === "manual",
      ...st,
    });
  }
  for (const m of jobs.values()) {
    if (m.status !== "waiting") continue;
    const row = out.find((r) => r.email === m.email && storeKey(r.store) === m.store);
    if (row) row.pending = "manual_login";
    else out.push({ email: m.email, store: m.storeName, cookieCount: 0, state: "pending", pending: "manual_login" });
  }
  // automatic logins waiting for a 2FA code
  for (const lj of loginJobs) {
    if (!lj || lj.status !== "running") continue;
    if (!/2fa|code|otp|verify/i.test(String(lj.last || ""))) continue;
    const email = String(lj.email || "").toLowerCase();
    const row = out.find((r) => r.email === email);
    if (row) row.pending = "2fa";
    else out.push({ email, store: "Target", cookieCount: 0, state: "pending", pending: "2fa" });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}
