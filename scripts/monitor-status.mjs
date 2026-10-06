/**
 * One result shape for every store monitor + readable login errors.
 *
 * state: IN_STOCK | OUT_OF_STOCK | QUEUE | BLOCKED | RATE_LIMITED | NOT_FOUND | ERROR | UNKNOWN
 * reason: short human sentence explaining the state.
 * Existing fields are kept as they are (additive only).
 */

export const MONITOR_STATES = ["IN_STOCK", "OUT_OF_STOCK", "QUEUE", "BLOCKED", "RATE_LIMITED", "NOT_FOUND", "ERROR", "UNKNOWN"];

export function monitorState(store, r) {
  if (!r || typeof r !== "object") return { state: "ERROR", reason: "Empty response from monitor" };
  const st = String(r.availabilityStatus || "").toUpperCase();
  const err = String(r.error || "");
  const s = String(store || "Store");
  if (r.rateLimited || st === "RATE_LIMITED" || /\b429\b|too many requests/i.test(err)) {
    const sec = r.retryAfterMs ? Math.round(r.retryAfterMs / 1000) : null;
    return { state: "RATE_LIMITED", reason: `${s} is asking to slow down${sec ? ` — waiting ${sec}s` : ""}` };
  }
  if (r.blocked || /BLOCKED|DATADOME|CAPTCHA/.test(st) || /\b403\b|blocked|captcha|access denied|forbidden/i.test(err)) {
    return { state: "BLOCKED", reason: `${s} blocked this connection (anti-bot page). Try later or from another network` };
  }
  if (r.inQueue || st === "QUEUE") return { state: "QUEUE", reason: `${s} waiting room / queue is active` };
  if (st === "NOT_FOUND" || /\b404\b|not found|no .*item id|invalid (sku|tcin|product)|unknown product/i.test(err)) {
    return { state: "NOT_FOUND", reason: "Product not found — check the SKU / TCIN / URL" };
  }
  if (err && !r.inStock) {
    if (/abort|timeout|timed out/i.test(err)) return { state: "ERROR", reason: `${s} did not answer in time (timeout)` };
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network/i.test(err)) {
      return { state: "ERROR", reason: "Network error — check your internet / proxy" };
    }
    return { state: "ERROR", reason: err.slice(0, 160) };
  }
  if (r.inStock) return { state: "IN_STOCK", reason: `In stock${r.price ? ` at ${r.price}` : ""}` };
  if (/OUT|SOLD|UNAVAILABLE/.test(st) || r.outOfStock) return { state: "OUT_OF_STOCK", reason: "Out of stock" };
  if (st === "UNKNOWN" || !st) return { state: "UNKNOWN", reason: "Page loaded but stock could not be read" };
  return { state: "OUT_OF_STOCK", reason: `Not available (${st})` };
}

/** Adds { state, reason } (never overwrites an existing state). */
export function withMonitorState(store, r) {
  if (!r || typeof r !== "object") return { ok: false, inStock: false, ...monitorState(store, r) };
  if (r.state && MONITOR_STATES.includes(r.state)) return r;
  return { ...r, ...monitorState(store, r) };
}

/**
 * Login errors → { errorCode, friendlyError }.
 * Codes: WRONG_PASSWORD | NEEDS_2FA | ACCOUNT_LOCKED | BLOCKED | RATE_LIMITED | MISSING_CREDENTIALS | TIMEOUT | NETWORK | UNKNOWN
 */
export function classifyLoginError(text) {
  const t = String(text || "");
  const rules = [
    ["MISSING_CREDENTIALS", /missing email|email\/password required|no password/i, "Email or password missing in the account settings"],
    ["WRONG_PASSWORD", /wrong password|incorrect password|password (is )?incorrect|invalid (email or )?password|credentials (are )?invalid|doesn.t match|sign.?in failed.*password/i, "Wrong email or password"],
    ["NEEDS_2FA", /2fa|two.?factor|verification code|one.?time code|\botp\b|enter (the )?code|totp|security code|verify it.s you/i, "The store is asking for a 2FA / verification code"],
    ["ACCOUNT_LOCKED", /locked|suspended|disabled|too many (failed )?attempts|reset your password/i, "Account locked or needs a password reset on the store's site"],
    ["RATE_LIMITED", /\b429\b|rate.?limit|too many requests|try again later/i, "Too many login attempts — wait a few minutes"],
    ["BLOCKED", /\b403\b|blocked|captcha|access denied|perimeterx|px-captcha|shape|datadome|forbidden|bot/i, "The store blocked this login (anti-bot check). Use \"Log in manually\""],
    ["TIMEOUT", /timeout|timed out|abort/i, "The store's login page did not respond in time"],
    ["NETWORK", /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|net::|proxy/i, "Network or proxy error"],
  ];
  for (const [code, re, msg] of rules) if (re.test(t)) return { errorCode: code, friendlyError: msg };
  return { errorCode: "UNKNOWN", friendlyError: t ? t.slice(0, 160) : "Login failed" };
}

/** Adds errorCode / friendlyError to a failed login result. */
export function withLoginError(r) {
  if (!r || typeof r !== "object" || r.ok !== false || r.errorCode) return r;
  const lastSteps = Array.isArray(r.steps) ? r.steps.slice(0, 5).map((s) => s?.message || "").join(" | ") : "";
  return { ...r, ...classifyLoginError(`${r.error || r.message || ""} ${lastSteps}`) };
}
