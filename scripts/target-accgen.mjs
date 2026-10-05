/**
 * Target account gen — headed Chrome.
 * Desktop first. If passkey wall → iPhone UA fallback, then desktop login to re-device.
 * B: IMAP email. C: SMS API.
 */
import { launchBrowser } from "./headless-browser.mjs";
import { persistCookies } from "./cookie-persist.mjs";
import { pollEmailOtp } from "./otp-inbox.mjs";
import { rentNumber, pollSms, finishSms } from "./sms-rent.mjs";

async function clickFirst(page, sels, timeout = 2500) {
  for (const sel of sels) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count()) || !(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await loc.click({ timeout, delay: 40 });
      return sel;
    } catch {
      /* */
    }
  }
  return null;
}

async function fillFirst(page, sels, value) {
  const v = String(value || "");
  if (!v) return false;
  for (const sel of sels) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count()) || !(await loc.isVisible({ timeout: 600 }).catch(() => false))) continue;
      await loc.click({ timeout: 800 }).catch(() => {});
      await loc.fill("");
      await loc.pressSequentially(v, { delay: 22 });
      return true;
    } catch {
      /* */
    }
  }
  return false;
}

function looksCreated(html, url) {
  const t = `${html} ${url}`.toLowerCase();
  return /circle|account created|welcome to target|your account/.test(t) && !/create.?account/.test(url);
}

function looksEmailVerify(html) {
  return /enter (the )?(code|passcode)|we (sent|emailed)|verification code|check your email/i.test(html);
}

function looksSms(html) {
  return /text (you )?a code|sms|mobile number|phone number|enter.*phone|verify your phone/i.test(html);
}

function looksPasskey(html) {
  return /passkey|use your face|touch id|create a passkey|passwordless/i.test(html || "");
}

async function waitImapCode(imap, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await pollEmailOtp(imap).catch(() => ({ ok: false }));
    if (r?.ok && r.code) return r;
    await new Promise((x) => setTimeout(x, 4000));
  }
  return { ok: false, error: "IMAP timeout" };
}

async function fillSignup(page, { firstName, lastName, email, password }) {
  await clickFirst(page, [
    'a:has-text("Create your Target account")',
    'button:has-text("Create your Target account")',
    'a:has-text("Create account")',
    'a:has-text("Create Account")',
    '[data-test="createAccount"]',
  ]);
  await page.waitForTimeout(700);
  await fillFirst(page, ['input[name="firstname"], input[id*="first" i], input[autocomplete="given-name"]'], firstName);
  await fillFirst(page, ['input[name="lastname"], input[id*="last" i], input[autocomplete="family-name"]'], lastName);
  await fillFirst(page, ['input[type="email"], input[name="username"], input[autocomplete="email"]'], email);
  await clickFirst(page, [
    'button:has-text("Create a password")',
    'a:has-text("Create a password")',
    'button:has-text("Use password")',
    'a:has-text("password instead")',
    'button:has-text("password")',
  ]);
  const pw = await fillFirst(
    page,
    ['input[type="password"], input[name="password"], input[autocomplete="new-password"]'],
    password
  );
  await clickFirst(page, [
    'button:has-text("Create account")',
    'button:has-text("Create Account")',
    'button[type="submit"]',
    '[data-test="createAccountButton"]',
  ]);
  await page.waitForTimeout(1400);
  return { pwOk: pw, html: await page.content().catch(() => ""), url: page.url() };
}

async function handleVerify(page, body, email, password, smsMode, t0) {
  let html = await page.content().catch(() => "");
  let keepOpen = false;
  let stage = null;
  let message = "";

  if (looksEmailVerify(html)) {
    const imap = body.imap || {};
    const mail = await waitImapCode(imap, Number(body.waitVerifySec || 90) * 1000);
    if (mail.ok && mail.code) {
      await fillFirst(page, ['input[name*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"]'], mail.code);
      await clickFirst(page, ['button:has-text("Verify")', 'button:has-text("Continue")', 'button[type="submit"]']);
      await page.waitForTimeout(1200);
    } else {
      keepOpen = true;
      stage = "needs_verification";
      message = imap.user ? mail.error || "IMAP no code — Chrome open" : "Email code · IMAP in Settings or paste in Chrome";
      return { keepOpen, halt: { ok: false, stage, message, email, password, keepOpen: true, ms: Date.now() - t0 } };
    }
  }

  html = await page.content().catch(() => "");
  if (looksSms(html) || /phone/i.test(page.url())) {
    if (smsMode !== "api") {
      keepOpen = true;
      return {
        keepOpen,
        halt: {
          ok: false,
          stage: "needs_sms",
          message: "B · Target asked for SMS · paste the code in Chrome (or use C = SMS API)",
          email,
          password,
          keepOpen: true,
          ms: Date.now() - t0,
        },
      };
    }
    const rental = await rentNumber({
      provider: body.smsProvider,
      smspoolKey: body.smspoolKey,
      smsActivateKey: body.smsActivateKey,
      country: body.smsCountry,
      service: body.smsService,
    });
    if (!rental.ok) {
      keepOpen = true;
      return {
        keepOpen,
        halt: {
          ok: false,
          stage: "needs_sms",
          message: `SMS API: ${rental.error} · Chrome open`,
          email,
          password,
          keepOpen: true,
          ms: Date.now() - t0,
        },
      };
    }
    await fillFirst(page, ['input[type="tel"], input[name*="phone" i], input[autocomplete="tel"]'], rental.phone);
    await clickFirst(page, ['button:has-text("Send")', 'button:has-text("Continue")', 'button:has-text("Text me")']);
    const sms = await pollSms(rental, body, 90000);
    if (sms.ok && sms.code) {
      await fillFirst(page, ['input[name*="code" i], input[autocomplete="one-time-code"]'], sms.code);
      await clickFirst(page, ['button:has-text("Verify")', 'button[type="submit"]']);
      await finishSms(rental, body);
      await page.waitForTimeout(800);
    } else {
      keepOpen = true;
      return {
        keepOpen,
        halt: {
          ok: false,
          stage: "needs_sms",
          message: `SMS timeout · ${rental.phone}`,
          email,
          password,
          phone: rental.phone,
          keepOpen: true,
          ms: Date.now() - t0,
        },
      };
    }
  }
  return { keepOpen: false, halt: null };
}

async function desktopRelogin(body, email, password) {
  const session = await launchBrowser({
    headed: true,
    proxy: body.proxy,
    taskId: `acc-desk-${String(email).split("@")[0]}`,
    mobile: false,
  });
  try {
    const { page, context } = session;
    await page.goto("https://www.target.com/login", { waitUntil: "domcontentloaded", timeout: 40000 });
    await fillFirst(page, ['input[type="email"], input[name="username"]'], email);
    await clickFirst(page, ['button:has-text("Continue")', 'button[type="submit"]']);
    await page.waitForTimeout(600);
    await fillFirst(page, ['input[type="password"]'], password);
    await clickFirst(page, ['button:has-text("Sign in")', 'button[type="submit"]']);
    await page.waitForTimeout(1500);
    persistCookies({
      taskId: `acc-${email}`,
      email,
      cookies: await context.cookies(),
      proxy: body.proxy || "",
      store: "Target",
    });
    return { ok: !/\/login/i.test(page.url()), url: page.url() };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    await session.close?.().catch(() => {});
  }
}

export async function runTargetAccGen(body = {}) {
  const t0 = Date.now();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const firstName = body.firstName || "Alex";
  const lastName = body.lastName || "Rivera";
  const smsMode = String(body.smsMode || body.mode || "manual").toLowerCase();
  const kind = `${body.proxyKind || ""} ${body.proxyGroupType || ""} ${body.proxyGroup || ""}`.toLowerCase();
  if (!body.proxy || !/resi|residential|mobile/.test(kind) || (/\bisp\b/.test(kind) && !/resi/.test(kind))) {
    return {
      ok: false,
      stage: "error",
      message: "Acc gen is RESI only — no ISP, DC, or local (burns the drop pool)",
      email,
      ms: 0,
    };
  }
  if (!email || password.length < 8) {
    return { ok: false, stage: "error", message: "email + password (8+) required", ms: 0 };
  }

  const profile = { firstName, lastName, email, password };
  let via = "desktop";
  let session = await launchBrowser({
    headed: true,
    proxy: body.proxy,
    taskId: body.sessionId || `accgen-${email.split("@")[0]}`,
    mobile: false,
  });
  let keepOpen = false;

  try {
    let { page, context } = session;
    await page.goto("https://www.target.com/login", { waitUntil: "domcontentloaded", timeout: 45000 });
    let signed = await fillSignup(page, profile);
    const passkeyStuck = looksPasskey(signed.html) && !signed.pwOk;

    if (passkeyStuck) {
      await session.close?.().catch(() => {});
      via = "mobile-fallback";
      session = await launchBrowser({
        headed: true,
        proxy: body.proxy,
        taskId: `${body.sessionId || "accgen"}-mobi`,
        mobile: true,
      });
      page = session.page;
      context = session.context;
      await page.goto("https://www.target.com/login", { waitUntil: "domcontentloaded", timeout: 45000 });
      signed = await fillSignup(page, profile);
    }

    if (/px-captcha|access denied|forbidden/i.test(signed.html + signed.url)) {
      return { ok: false, stage: "blocked", message: "Shape/PX on signup", email, via, ms: Date.now() - t0 };
    }

    const ver = await handleVerify(page, body, email, password, smsMode, t0);
    if (ver.halt) {
      keepOpen = true;
      return { ...ver.halt, via };
    }

    persistCookies({
      taskId: `acc-${email}`,
      email,
      cookies: await context.cookies(),
      proxy: body.proxy || "",
      store: "Target",
    });

    const html = await page.content().catch(() => "");
    const created = looksCreated(html, page.url()) || !/create-account|login/i.test(page.url());
    await session.close?.().catch(() => {});
    session = null;

    let desk = { ok: false };
    if (created) {
      desk = await desktopRelogin(body, email, password);
    }

    return {
      ok: created,
      stage: created ? "created" : "form_filled",
      message: created
        ? `Target account OK · ${via}${desk.ok ? " · desktop login sticky" : " · desktop login skip"}`
        : `Form submitted · ${via}`,
      email,
      password,
      via,
      desktopLogin: desk.ok,
      ms: Date.now() - t0,
      finalUrl: desk.url || signed.url,
    };
  } catch (e) {
    return { ok: false, stage: "error", message: e?.message || String(e), email, via, ms: Date.now() - t0 };
  } finally {
    if (session && !keepOpen) await session.close?.().catch(() => {});
  }
}
