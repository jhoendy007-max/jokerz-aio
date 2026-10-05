/**
 * Target login — Refract-style or better.
 * Account menu → Sign in (never newsletter) → human type → persist session.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectCaptcha } from "./captcha-detect.mjs";
import {
  persistCookies,
  loadCookies,
  cookiesFresh,
  clearCookies as clearPersistedCookies,
  listCookieJars,
  playwrightCookies,
  toCookieHeader,
} from "./cookie-persist.mjs";
import { launchBrowser, parseProxy } from "./headless-browser.mjs";
import { totpNow, hasTotpSecret } from "./totp.mjs";
import { isRateLimitText, loginBackoffMs } from "./rate-limit.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const STICKY_MS = 90 * 60 * 1000;
const jobs = new Map();

function emailKey(email) {
  return String(email || "").trim().toLowerCase();
}

function pushStep(id, level, message) {
  const j = jobs.get(id) || { id, steps: [], status: "running" };
  j.steps.unshift({ ts: Date.now(), level, message });
  j.steps = j.steps.slice(0, 80);
  j.last = message;
  jobs.set(id, j);
}

export function getLoginJob(id) {
  return jobs.get(id) || null;
}

export function listLoginSessions() {
  return listCookieJars().map((j) => ({
    email: j.email,
    sessionId: j.taskId,
    cookieCount: j.cookieCount,
    hasAccessToken: true,
    hasRefreshToken: false,
    flow: "refract-login",
    ageMin: j.ageMin,
    stale: !j.sticky,
    proxy: j.proxy || "",
  }));
}

async function humanType(page, locator, text) {
  await locator.click({ delay: 40 });
  await page.waitForTimeout(180 + Math.floor(Math.random() * 220));
  await locator.fill("");
  const delay = 45 + Math.floor(Math.random() * 50);
  if (typeof locator.pressSequentially === "function") {
    await locator.pressSequentially(text, { delay });
  } else {
    await locator.type(text, { delay });
  }
  await page.waitForTimeout(120 + Math.floor(Math.random() * 200));
}

async function clickFirst(page, selectors, timeout = 4000) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
          await loc.click({ timeout, delay: 30 });
          return sel;
        }
      }
    } catch {
      /* next */
    }
  }
  return null;
}

async function detectLoginForm(page) {
  const emailSels = [
    'input[type="email"]:not([name*="news" i]):not([id*="news" i]):not([id*="footer" i])',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[name="email"]:not([id*="news" i])',
    '#username',
    'input[id*="username" i]',
  ];
  const passSels = ['input[type="password"]', 'input[name="password"]', '#password'];
  const scopes = [page, ...page.frames()];
  for (const scope of scopes) {
    for (const es of emailSels) {
      try {
        const email = scope.locator(es).first();
        if (!(await email.count())) continue;
        if (!(await email.isVisible({ timeout: 400 }).catch(() => false))) continue;
        const box = await email.boundingBox().catch(() => null);
        if (box && box.y > 900) continue; // footer newsletter
        const password = scope.locator(passSels.join(", ")).first();
        if (!(await password.count())) continue;
        if (!(await password.isVisible({ timeout: 400 }).catch(() => false))) continue;
        const submit = scope
          .locator(
            'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'
          )
          .first();
        return { scope, email, password, submit };
      } catch {
        /* next */
      }
    }
  }
  return null;
}

async function pageLooksLoggedIn(page) {
  const url = page.url();
  if (/\/account(?!\/login)/i.test(url) && !/login|signin/i.test(url)) return true;
  const txt = await page.locator("body").innerText().catch(() => "");
  if (/sign out|log out|hi,\s+\w+/i.test(txt) && !/sign in to/i.test(txt.slice(0, 200))) return true;
  const signOut = await page.locator('a:has-text("Sign out"), button:has-text("Sign out")').count();
  return signOut > 0;
}

async function bannerError(page) {
  const t = await page.locator("body").innerText().catch(() => "");
  return /something went wrong on our end|we.re having trouble|try again later/i.test(t);
}

async function playwrightLogin(opts) {
  // Always headed — same Chrome path as harvest + ATC (headless leaks vs Shape).
  const headed = true;
  const restore = playwrightCookies({ cookies: opts.cookies || [] });
  let session;
  try {
    session = await launchBrowser({
      headed,
      proxy: opts.proxy,
      cookies: restore,
      taskId: opts.sessionId || opts.email,
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  const { context, page, close, identityHint } = session;
  const step = (m) => opts.onStep && opts.onStep("info", m);
  if (identityHint) step(`Browser identity · ${identityHint} · ${session.via || "chrome"} · WebRTC off`);

  try {
    if (restore.length) step(`Restored ${restore.length} cookies from disk`);
    step(headed ? "Open /login (headed Chrome)" : "Open /login (headless Chrome 131)");
    await page.goto("https://www.target.com/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(700);
    await clickFirst(page, [
      "#onetrust-accept-btn-handler",
      'button:has-text("Accept all")',
      'button:has-text("No thanks")',
      '[data-test="modal-close"]',
      'button[aria-label="close"]',
    ]);

    if (await pageLooksLoggedIn(page)) {
      step("Already signed in");
      const cookies = await context.cookies();
      return { ok: true, cookies, already: true };
    }

    const html0 = await page.content().catch(() => "");
    if (isRateLimitText(html0, page.url())) {
      step("RATE LIMIT on login page — do not hammer Sign in");
      return { ok: false, error: "RATE LIMIT login", rateLimited: true, retry: true, waitMs: loginBackoffMs(2, true) };
    }

    let form = await detectLoginForm(page);
    for (let i = 0; i < 12 && !form; i++) {
      await page.waitForTimeout(500);
      form = await detectLoginForm(page);
    }
    if (!form) {
      step("Form still missing — Account → Sign in");
      await page.goto("https://www.target.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await clickFirst(page, [
        '[data-test="@web/AccountLink"]',
        '[data-test="accountNavButton"]',
        'button:has-text("Account")',
      ]);
      await page.waitForTimeout(400);
      await clickFirst(page, [
        '[data-test="accountNav-signIn"]',
        'a[href*="/login"]',
        'button:has-text("Sign in")',
        'a:has-text("Sign in")',
      ]);
      await page.waitForTimeout(800);
      for (let i = 0; i < 8 && !form; i++) {
        form = await detectLoginForm(page);
        if (!form) await page.waitForTimeout(400);
      }
    }
    if (!form) {
      const html = await page.content().catch(() => "");
      if (isRateLimitText(html, page.url())) {
        return { ok: false, error: "RATE LIMIT · no login form", rateLimited: true, retry: true, waitMs: loginBackoffMs(2, true) };
      }
      return { ok: false, error: "Login form not found (Shape/newsletter trap)", retry: !headed, retryHeaded: true };
    }
    step("Login form OK · human type");

    await humanType(page, form.email, opts.email);
    await humanType(page, form.password, opts.password);
    step("Click Sign in");
    if ((await form.submit.count().catch(() => 0)) > 0) await form.submit.click({ delay: 40 });
    else await page.keyboard.press("Enter");

    await page.waitForTimeout(1800);

    if (await bannerError(page)) {
      return { ok: false, error: "Something went wrong banner — retry with fresh session", retry: true };
    }

    const body = await page.locator("body").innerText().catch(() => "");
    if (/verify|enter the code|two.step|2-step|one.time|authenticator/i.test(body)) {
      if (hasTotpSecret(opts.totp)) {
        let ok2fa = false;
        for (let i = 0; i < 2 && !ok2fa; i++) {
          const code = totpNow(opts.totp);
          step(`2FA TOTP auto · ${code}${i ? " · retry" : ""}`);
          const box = page
            .locator(
              'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="otp" i], input[inputmode="numeric"], input[maxlength="6"]'
            )
            .first();
          if (await box.count()) {
            await box.fill("").catch(() => {});
            await humanType(page, box, code).catch(() => box.fill(code));
            await page.keyboard.press("Enter").catch(() => {});
            await page.waitForTimeout(2800);
            const still = /verify|enter the code|authenticator/i.test(
              await page.locator("body").innerText().catch(() => "")
            );
            ok2fa = !still;
            if (!ok2fa && i === 0) {
              const wait = (30 - (Math.floor(Date.now() / 1000) % 30) + 1) * 1000;
              step(`2FA code rejected/expired · wait ${Math.round(wait / 1000)}s`);
              await page.waitForTimeout(wait);
            }
          } else {
            step("2FA box not found — 90s in Chrome");
            await page.waitForTimeout(90000);
            break;
          }
        }
      } else {
        step("2FA — paste the code in Chrome (2 min) or set TOTP in Accounts");
        await page.waitForTimeout(120000);
      }
    }
    if (/incorrect|doesn.t match|we can.t find your account|password you entered/i.test(body)) {
      return { ok: false, error: "Bad email/password" };
    }
    const html = await page.content().catch(() => "");
    const det = detectCaptcha({
      html,
      url: page.url(),
      cookies: await context.cookies(),
    });
    if (det.detected && det.challenge !== "none") {
      step(`Captcha ${det.provider} · ${det.challenge} · ${det.note}`);
      if (det.solver === "headed" || det.provider === "shape" || det.provider === "perimeterx") {
        step("Solve in Chrome (90s) — press & hold / PX");
        await page.waitForTimeout(90000);
      } else if (det.solver === "queue-wait") {
        step("Queue-it — holding 2 min");
        await page.waitForTimeout(120000);
      } else {
        step(`Auto-solver path ${det.solver} · sitekey ${det.sitekey || "n/a"}`);
        await page.waitForTimeout(20000);
      }
    }

    const logged = await pageLooksLoggedIn(page);
    const cookies = await context.cookies("https://www.target.com");
    if (!logged && cookies.length < 4) {
      return { ok: false, error: "Not logged in · cookies thin" };
    }
    return { ok: true, cookies, url: page.url(), headed };
  } finally {
    if (!opts.keepOpen) await close();
  }
}

export async function runTargetLogin(body = {}) {
  const email = String(body.email || "").trim();
  const password = String(body.password || body.pass || "");
  const id = String(body.sessionId || email || `login-${Date.now()}`);
  const key = emailKey(email);
  jobs.set(id, { id, email, status: "running", steps: [], started: Date.now() });

  const onStep = (level, message) => pushStep(id, level, message);

  if (!email || !password) {
    onStep("error", "Missing email/password");
    jobs.get(id).status = "error";
    return { ok: false, error: "Missing email/password", sessionId: id };
  }

  const cached = loadCookies({ taskId: id, email });
  if (!body.forceLogin && cookiesFresh(cached, STICKY_MS)) {
    onStep("success", `Sticky cookies · ${email} · ${Math.round((Date.now() - cached.at) / 60000)}m old · ${cached.cookies.length} ck`);
    jobs.get(id).status = "ok";
    return {
      ok: true,
      fromCache: true,
      sessionId: id,
      cookies: cached.cookies,
      message: "sticky cookies (disk)",
    };
  }
  if (cached?.cookies?.length && !body.forceLogin) {
    onStep("info", `Rehydrating ${cached.cookies.length} cookies into Chrome`);
  }

  onStep("info", `Login ${email} · ${body.proxy ? "ISP" : "local IP"} · drop-RL safe`);
  let lastErr = "login failed";
  for (let attempt = 1; attempt <= 5; attempt++) {
    onStep("info", `Attempt ${attempt}/5 · Account → Sign in`);
    try {
      const r = await playwrightLogin({
        email,
        password,
        proxy: body.proxy,
        headed: true,
        cookies: cached?.cookies,
        totp: body.totp || body.totpSecret || "",
        sessionId: id,
        onStep,
      });
      if (r.ok) {
        persistCookies({
          taskId: id,
          email,
          cookies: r.cookies || [],
          proxy: body.proxy || "",
          store: "Target",
        });
        onStep("success", `Cookies SAVED to disk · ${(r.cookies || []).length} · task ${id.slice(0, 8)}`);
        jobs.get(id).status = "ok";
        return {
          ok: true,
          fromCache: false,
          sessionId: id,
          cookies: r.cookies,
          already: r.already,
          message: r.already ? "already signed in" : "login ok · cookies persisted",
        };
      }
      lastErr = r.error || lastErr;
      onStep("warn", r.error || "fail");
      if (r.rateLimited && cached?.cookies?.length) {
        onStep("success", "RATE LIMIT · keeping sticky session (no more Sign in)");
        jobs.get(id).status = "ok";
        return {
          ok: true,
          fromCache: true,
          rateLimited: true,
          sessionId: id,
          cookies: cached.cookies,
          message: "rate limit · sticky cookies kept",
        };
      }
      if (r.rateLimited) {
        const wait = r.waitMs || loginBackoffMs(attempt, true);
        onStep("warn", `RATE LIMIT · wait ${Math.round(wait / 1000)}s (do not rotate ISP)`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      if (!r.retry && !r.retryHeaded) break;
      await new Promise((res) => setTimeout(res, loginBackoffMs(attempt, false)));
    } catch (e) {
      lastErr = e?.message || String(e);
      onStep("error", lastErr);
      await new Promise((res) => setTimeout(res, loginBackoffMs(attempt, /429|rate/i.test(lastErr))));
    }
  }

  jobs.get(id).status = "error";
  return { ok: false, error: lastErr, sessionId: id, steps: jobs.get(id).steps };
}

export function clearLoginSession(email) {
  clearPersistedCookies({ email });
}

/** Touch the disk jar so sticky TTL doesn't die while armed waiting for stock.
 * MUST use the same ISP as login/checkout — home IP burns Shape/PX session.
 */
export async function runTargetKeepAlive(body = {}) {
  const email = String(body.email || "").trim();
  const id = String(body.sessionId || body.taskId || email || "");
  const jar = loadCookies({ taskId: id, email });
  if (!jar?.cookies?.length) return { ok: false, error: "no session jar" };
  const cookie = toCookieHeader(jar.cookies);
  const proxyLine = jar.proxy || body.proxy || "";
  const proxyHint = proxyLine ? String(proxyLine).split("@").pop() || "isp" : "LOCAL";

  let dispatcher;
  try {
    const u = proxyUrl(proxyLine);
    if (u) {
      const { ProxyAgent } = await import("undici").catch(() => ({ ProxyAgent: null }));
      if (ProxyAgent) dispatcher = new ProxyAgent(u);
    }
  } catch {
    dispatcher = undefined;
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const { fetch: ufetch } = await import("undici").catch(() => ({ fetch: globalThis.fetch }));
    const r = await (ufetch || fetch)("https://www.target.com/", {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookie,
        Referer: "https://www.target.com/",
      },
      signal: ctrl.signal,
      redirect: "follow",
      ...(dispatcher ? { dispatcher } : {}),
    });
    clearTimeout(t);
    persistCookies({
      taskId: id,
      email: email || jar.email,
      cookies: jar.cookies,
      proxy: proxyLine,
      store: "Target",
    });
    const via = dispatcher ? `ISP ${proxyHint}` : "LOCAL IP (set proxy on task)";
    const rl = r.status === 429 || r.status === 403;
    return {
      ok: r.status < 500,
      status: r.status,
      rateLimited: rl,
      cookies: jar.cookies.length,
      proxy: proxyHint,
      message: rl
        ? `keepalive RATE LIMIT HTTP ${r.status} · sticky kept · no Sign in`
        : `keepalive HTTP ${r.status} · ${via} · sticky refreshed`,
    };
  } catch (e) {
    persistCookies({
      taskId: id,
      email: email || jar.email,
      cookies: jar.cookies,
      proxy: proxyLine,
      store: "Target",
    });
    return {
      ok: true,
      soft: true,
      proxy: proxyHint,
      error: e?.message || String(e),
      message: `jar touched · ${proxyHint} fetch failed`,
    };
  }
}

function proxyUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p || p === "direct" || p === "localhost") return null;
  if (/^https?:\/\//i.test(p) || /^socks/i.test(p)) return p;
  if (p.includes("@")) return `http://${p}`;
  const parts = p.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return null;
}
