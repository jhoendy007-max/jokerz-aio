/**
 * Login guard — wraps the automatic Target / Walmart logins so they are safer for the account:
 *  1. A saved manual session (Settings → Accounts → Log in manually) is used first, until it expires.
 *  2. One login at a time per store + account: tasks that share an account wait for the same login.
 *  3. After a wrong password / locked account / 2FA request / block, automatic logins for that
 *     account pause for a while instead of retrying (protects the account from lockouts).
 *  4. Remembers the last result per account for the accounts panel.
 * No anti-bot handling here — only fewer and better-timed attempts.
 */
import { loadCookies } from "./cookie-persist.mjs";
import { withLoginError } from "./monitor-status.mjs";
import { recordLogin as defaultRecord } from "./login-history.mjs";
import { storeKey, manualJarId } from "./manual-login.mjs";

export const PAUSE_MIN = { WRONG_PASSWORD: 30, ACCOUNT_LOCKED: 60, NEEDS_2FA: 10, BLOCKED: 15, RATE_LIMITED: 5 };

const inflight = new Map();
const pauses = new Map(); // key → { until, errorCode, friendlyError }
const last = new Map();
const lastManualRec = new Map(); // key → { at, ok, errorCode?, friendlyError?, manual? }

const keyOf = (store, email) => `${storeKey(store) || "x"}|${String(email || "").trim().toLowerCase()}`;

export function manualSession(store, email, deps = { loadCookies }, now = Date.now()) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const jar = deps.loadCookies({ taskId: manualJarId(store, e) });
  if (!jar || jar.source !== "manual" || storeKey(jar.store) !== storeKey(store)) return null;
  if (!jar.cookies?.length || (jar.expiresAt && jar.expiresAt <= now + 60_000)) return null;
  return jar;
}

export function pauseFor(errorCode) {
  return PAUSE_MIN[errorCode] || 0;
}

/**
 * @param {string} store "Target" | "Walmart"
 * @param {object} body login request body ({ email, password, forceLogin, … })
 * @param {(body:object)=>Promise<object>} run the real login function
 */
export async function guardedLogin(store, body = {}, run, deps = { loadCookies }, now = () => Date.now()) {
  const record = deps.recordLogin || (deps.loadCookies === loadCookies ? defaultRecord : () => {});
  const email = String(body.email || "").trim();
  const k = keyOf(store, email);

  if (!body.forceLogin) {
    const jar = manualSession(store, email, deps, now());
    if (jar) {
      last.set(k, { at: now(), ok: true, manual: true });
      if (!(lastManualRec.get(k) > now() - 10 * 60_000)) {
        lastManualRec.set(k, now());
        record({ store: storeKey(store), email, ok: true, manual: true });
      }
      return {
        ok: true,
        fromCache: true,
        manual: true,
        sessionId: body.sessionId,
        cookies: jar.cookies,
        cookieCount: jar.cookies.length,
        message: `Using your saved manual session · ${email}`,
      };
    }
  }

  const p = pauses.get(k);
  if (p && p.until > now() && !body.forceLogin) {
    const min = Math.ceil((p.until - now()) / 60_000);
    return {
      ok: false,
      paused: true,
      pausedUntil: p.until,
      errorCode: "LOGIN_PAUSED",
      friendlyError: `Automatic login paused ${min} min for ${email}: ${p.friendlyError}. Use "Log in manually" or wait.`,
      error: `login paused (${p.errorCode})`,
    };
  }

  if (inflight.has(k)) {
    const r = await inflight.get(k);
    return { ...r, sharedLogin: true };
  }

  const job = (async () => {
    let r;
    try {
      r = await run(body);
    } catch (e) {
      r = { ok: false, error: e?.message || String(e) };
    }
    if (r && r.ok === false && !r.errorCode) r = withLoginError(r);
    const at = now();
    record({ store: storeKey(store), email, ok: Boolean(r?.ok), fromCache: Boolean(r?.fromCache), errorCode: r?.errorCode, friendlyError: r?.friendlyError });
    if (r?.ok) {
      pauses.delete(k);
      last.set(k, { at, ok: true });
    } else {
      last.set(k, { at, ok: false, errorCode: r?.errorCode, friendlyError: r?.friendlyError });
      const min = pauseFor(r?.errorCode);
      if (min) {
        pauses.set(k, { until: at + min * 60_000, errorCode: r.errorCode, friendlyError: r.friendlyError });
        r = { ...r, pausedUntil: at + min * 60_000 };
      }
    }
    return r;
  })();
  inflight.set(k, job);
  try {
    return await job;
  } finally {
    inflight.delete(k);
  }
}

export function clearLoginPause(store, email) {
  return pauses.delete(keyOf(store, email));
}

/** Per account: last result + pause (for /api/accounts/status). */
export function loginGuardStatus(now = Date.now()) {
  const out = {};
  for (const [k, v] of last) out[k] = { ...v };
  for (const [k, p] of pauses) {
    if (p.until <= now) continue;
    out[k] = { ...(out[k] || {}), pausedUntil: p.until, pausedMin: Math.ceil((p.until - now) / 60_000), errorCode: p.errorCode, friendlyError: p.friendlyError };
  }
  for (const [k] of inflight) out[k] = { ...(out[k] || {}), loggingIn: true };
  return out;
}

export function _resetLoginGuard() {
  inflight.clear();
  pauses.clear();
  last.clear();
  lastManualRec.clear();
}
