/**
 * Walmart checkout — HUMAN/PX + Akamai, headed Chrome.
 * Sept 2026: ISP/resi, 1 account = 1 IP, shipping ATC only, live skips /cart.
 */
import { launchBrowser } from "./headless-browser.mjs";
import { persistCookies, loadCookies, playwrightCookies } from "./cookie-persist.mjs";
import { parseWalmartId } from "./walmart-monitor.mjs";
import { injectShape, harvestShapeOnce } from "./shape-bank.mjs";
import { waitForHumanCaptcha } from "./free-solve.mjs";

const QUEUE_HOLD_MS = 3 * 60 * 60 * 1000;

const ATC = [
  '[data-testid="add-to-cart-button"]',
  'button[data-testid="add-to-cart"]',
  'button[data-automation-id="add-to-cart"]',
  'button:has-text("Add to cart")',
  'button:has-text("Add to Cart")',
  'button:has-text("Preorder")',
  'button:has-text("Pre-order")',
];

const SHIP = [
  '[data-testid="fulfillment-shipping"]',
  'button:has-text("Shipping")',
  'label:has-text("Shipping")',
  '[data-automation-id="fulfillment-shipping"]',
];

async function clickFirst(page, sels) {
  for (const sel of sels) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && (await loc.isVisible({ timeout: 700 }).catch(() => false))) {
        await loc.click({ timeout: 2500, delay: 40 });
        return sel;
      }
    } catch {
      /* */
    }
  }
  return null;
}

async function holdPx(page) {
  const loc = page.locator("#px-captcha, button:has-text('Press & Hold'), button:has-text('Press and Hold')").first();
  if (!(await loc.count().catch(() => 0))) return false;
  const box = await loc.boundingBox().catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3300 + Math.floor(Math.random() * 400));
  await page.mouse.up();
  return true;
}

function looksQueue(html, url) {
  const t = `${html || ""} ${url || ""}`.toLowerCase();
  return /queue-it|waiting room|high demand|we'll be with you|please wait while we|in line|estimated wait|you're in line|you are in line/.test(
    t
  );
}

function queueEta(html) {
  const t = String(html || "");
  return (
    (t.match(/(\d{1,3}:\d{2})\s*(?:min|minutes|hrs|hours)?/i) ||
      t.match(/estimated wait[^0-9]{0,12}(\d+\s*(?:min|minutes|hours))/i) ||
      t.match(/position[^0-9]{0,8}(\d{1,7})/i) ||
      [])[1] || ""
  );
}

function looksDenied(html, url) {
  const t = `${html || ""} ${url || ""}`.toLowerCase();
  return /access denied|error 456|\b456\b|blocked by walmart|robot or automated|px-captcha/.test(t) &&
    /denied|blocked|hold|captcha/.test(t);
}

function looksSms(html) {
  return /verify (your )?phone|sms (code|verification)|text (you )?a code|enter the code we (texted|sent)/i.test(
    String(html || "")
  );
}

async function holdNativeQueue(page, { maxMs = QUEUE_HOLD_MS, onTick } = {}) {
  const t0 = Date.now();
  let last = "";
  let ticks = 0;
  while (Date.now() - t0 < maxMs) {
    const html = await page.content().catch(() => "");
    if (looksSms(html)) return { passed: false, sms: true, waitedMs: Date.now() - t0, eta: last };
    if (!looksQueue(html, page.url()) && !looksDenied(html, page.url())) {
      return { passed: true, waitedMs: Date.now() - t0, eta: last };
    }
    last = queueEta(html) || last;
    ticks++;
    if (onTick && ticks % 15 === 0) await onTick({ eta: last, waitedMs: Date.now() - t0 }).catch(() => {});
    await page.waitForTimeout(8000);
  }
  return { passed: false, waitedMs: maxMs, eta: last };
}

function looksOosAfterCart(html) {
  const t = String(html || "").toLowerCase();
  return /no longer available|out of stock|removed from (your )?cart|unable to fulfill|sold out/.test(t);
}

async function fillVisible(page, selectors, value) {
  const v = String(value || "").trim();
  if (!v) return false;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count()) || !(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await loc.click({ timeout: 1200 }).catch(() => {});
      await loc.fill("");
      await loc.pressSequentially(v, { delay: 16 });
      return true;
    } catch {
      /* */
    }
  }
  return false;
}

async function fillWalmartPay(page, profile = {}) {
  const filled = [];
  if (await fillVisible(page, ['input[type="email"]', 'input[autocomplete="email"]'], profile.email)) filled.push("email");
  if (await fillVisible(page, ['input[autocomplete="given-name"]', 'input[name*="first" i]'], profile.firstName)) filled.push("first");
  if (await fillVisible(page, ['input[autocomplete="family-name"]', 'input[name*="last" i]'], profile.lastName)) filled.push("last");
  if (await fillVisible(page, ['input[autocomplete="address-line1"]', 'input[name*="address" i]'], profile.address1)) filled.push("addr");
  if (await fillVisible(page, ['input[autocomplete="address-level2"]', 'input[name*="city" i]'], profile.city)) filled.push("city");
  if (await fillVisible(page, ['input[autocomplete="postal-code"]', 'input[name*="zip" i]'], profile.zip)) filled.push("zip");
  if (await fillVisible(page, ['input[type="tel"]', 'input[autocomplete="tel"]'], profile.phone)) filled.push("phone");
  const pan = String(profile.cardNumber || "").replace(/\s/g, "");
  for (const frame of page.frames()) {
    try {
      if (pan.length >= 13) {
        const n = frame.locator('input[autocomplete="cc-number"], input[name*="number" i]').first();
        if (await n.count()) {
          await n.fill(pan, { timeout: 2000 });
          filled.push("card");
        }
      }
      if (profile.exp) {
        const e = frame.locator('input[autocomplete="cc-exp"], input[name*="exp" i]').first();
        if (await e.count()) await e.fill(String(profile.exp).replace(/\s/g, ""), { timeout: 1500 });
      }
      if (profile.cvv) {
        const c = frame.locator('input[autocomplete="cc-csc"], input[name*="cvv" i]').first();
        if (await c.count()) await c.fill(String(profile.cvv), { timeout: 1500 });
      }
    } catch {
      /* */
    }
  }
  await clickFirst(page, [
    'button:has-text("Place order")',
    'button:has-text("Place Order")',
    'button:has-text("Pay")',
    '[data-testid="place-order"]',
  ]);
  return filled;
}

export async function runWalmartLogin(body = {}) {
  const email = String(body.email || "").trim();
  const password = String(body.password || body.pass || "");
  if (!email || !password) return { ok: false, error: "email/password required" };
  const jar = loadCookies({ taskId: body.sessionId, email, store: "Walmart" });
  if (jar?.cookies?.length && !body.forceLogin) {
    return { ok: true, fromCache: true, message: `Sticky Walmart · ${email}`, cookieCount: jar.cookies.length };
  }
  const session = await launchBrowser({
    headed: true,
    proxy: body.proxy,
    taskId: body.sessionId || email,
  });
  try {
    const { page, context } = session;
    if (jar?.cookies?.length) await context.addCookies(playwrightCookies(jar.cookies)).catch(() => {});
    await page.goto("https://www.walmart.com/account/signin", { waitUntil: "domcontentloaded", timeout: 40000 });
    await holdPx(page);
    await waitForHumanCaptcha(page, { timeoutMs: 120000 }).catch(() => {});
    const emailBox = page.locator('input[type="email"], input[name="email"]').first();
    await emailBox.click({ timeout: 8000 });
    await emailBox.pressSequentially(email, { delay: 45 });
    await page.waitForTimeout(280);
    await clickFirst(page, ['button:has-text("Continue")', 'button[type="submit"]']);
    await page.waitForTimeout(700);
    const passBox = page.locator('input[type="password"]').first();
    await passBox.click({ timeout: 8000 });
    await passBox.pressSequentially(password, { delay: 40 });
    await clickFirst(page, ['button:has-text("Sign in")', 'button[type="submit"]']);
    await page.waitForTimeout(2200);
    await waitForHumanCaptcha(page, { timeoutMs: 90000 }).catch(() => {});
    const cookies = await context.cookies();
    persistCookies({ taskId: body.sessionId, email, cookies, proxy: body.proxy, store: "Walmart" });
    const html = await page.content();
    const ok = /sign out|account overview|hi,/i.test(html) || cookies.some((c) => /auth|SID|ACID/i.test(c.name));
    return { ok, message: ok ? "Walmart login saved" : "Login unclear — cookies saved", cookieCount: cookies.length };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    await session.close?.().catch(() => {});
  }
}

export async function runWalmartCheckout(body = {}) {
  const t0 = Date.now();
  const itemId = parseWalmartId(body.itemId || body.sku || body.product);
  if (!itemId) return { ok: false, stage: "error", message: "No Walmart item id" };
  const placeOrder = body.placeOrder === true || body.liveCheckout === true;
  let keepChrome = !!placeOrder;
  const fail = (stage, message, extra = {}) => ({
    ok: false,
    stage,
    message,
    itemId,
    ms: Date.now() - t0,
    ...extra,
  });

  let inj = injectShape({
    sessionId: body.sessionId || body.taskId,
    email: body.accountEmail,
    module: "walmart",
    proxy: body.proxy,
    requireSameProxy: !!body.proxy,
  });
  if (!inj.ok && !placeOrder) {
    await harvestShapeOnce({
      kind: "atc",
      proxy: body.proxy,
      headed: true,
      module: "walmart",
      taskId: body.sessionId || body.taskId,
    }).catch(() => {});
    inj = injectShape({
      sessionId: body.sessionId || body.taskId,
      email: body.accountEmail,
      module: "walmart",
      proxy: body.proxy,
      requireSameProxy: false,
    });
  }

  const session = await launchBrowser({
    headed: true,
    proxy: body.proxy,
    taskId: body.sessionId || body.taskId || itemId,
  });
  try {
    const { page, context } = session;
    const jar = loadCookies({
      taskId: body.sessionId || body.taskId,
      email: body.accountEmail,
      store: "Walmart",
    });
    if (jar?.cookies?.length) await context.addCookies(playwrightCookies(jar.cookies)).catch(() => {});
    await page.goto(`https://www.walmart.com/ip/${itemId}`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await holdPx(page);
    const human = await waitForHumanCaptcha(page, { timeoutMs: 180000 }).catch(() => ({ ok: true }));
    if (human?.needed && !human.ok) return fail("blocked", "PX/HUMAN captcha — resuelve en Chrome (3 min)");

    let html = await page.content().catch(() => "");
    if (looksQueue(html, page.url())) {
      const hold = await holdNativeQueue(page, {
        maxMs: Number(body.queueHoldMs || QUEUE_HOLD_MS),
        onTick: async () => {
          persistCookies({
            taskId: body.sessionId || body.taskId,
            email: body.accountEmail,
            cookies: await context.cookies(),
            proxy: body.proxy,
            store: "Walmart",
          });
        },
      });
      persistCookies({
        taskId: body.sessionId || body.taskId,
        email: body.accountEmail,
        cookies: await context.cookies(),
        proxy: body.proxy,
        store: "Walmart",
      });
      if (hold.sms) {
        keepChrome = true;
        return fail("sms", "SMS verify on account — code in Chrome, then Start again (same IP)", {
          keepOpen: true,
          finalUrl: page.url(),
        });
      }
      if (!hold.passed) {
        keepChrome = true;
        return fail("queue", `Queue hold ${Math.round(hold.waitedMs / 60000)}m · ETA ${hold.eta || "?"} · same IP · Chrome stays`, {
          keepOpen: true,
          eta: hold.eta,
          finalUrl: page.url(),
        });
      }
    }

    await clickFirst(page, SHIP);
    await page.waitForTimeout(250);
    const atc = await clickFirst(page, ATC);
    if (!atc) {
      html = await page.content();
      if (looksSms(html)) {
        keepChrome = true;
        return fail("sms", "SMS at ATC — verify in Chrome", { keepOpen: true });
      }
      if (/access denied|error 456/i.test(html)) return fail("blocked", "Access Denied 456 · rotate resi (not while in queue)");
      if (/out of stock|unavailable/i.test(html)) return fail("oos", "OOS shipping ATC");
      if (/px-captcha|press and hold/i.test(html)) return fail("blocked", "PX blocked at ATC");
      return fail("atc_failed", "Add to cart (shipping) not found");
    }

    await Promise.race([
      page.getByText(/added to cart|in your cart/i).first().waitFor({ timeout: 2500 }).catch(() => {}),
      page.waitForTimeout(placeOrder ? 400 : 900),
    ]);

    persistCookies({
      taskId: body.sessionId || body.taskId,
      email: body.accountEmail,
      cookies: await context.cookies(),
      proxy: body.proxy,
      store: "Walmart",
    });

    if (placeOrder) {
      await page.goto("https://www.walmart.com/checkout", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      await holdPx(page);
      html = await page.content().catch(() => "");
      if (looksOosAfterCart(html)) return fail("oos_after_cart", "CART OK · PX passed · OOS at checkout");
      const filled = await fillWalmartPay(page, body.profile || {});
      html = `${await page.content().catch(() => "")} ${page.url()}`;
      if (/thank you|order confirmation|thanks for your order/i.test(html)) {
        const on = (html.match(/#?\d{8,}/) || [])[0];
        return {
          ok: true,
          stage: "ordered",
          message: on ? `Order ${on}` : "Walmart ordered",
          orderNumber: on,
          filled,
          itemId,
          ms: Date.now() - t0,
          finalUrl: page.url(),
        };
      }
      return {
        ok: true,
        stage: "checkout",
        message: `Checkout filled ${filled.join(",") || "—"} · confirm in Chrome`,
        filled,
        itemId,
        keepOpen: true,
        ms: Date.now() - t0,
        finalUrl: page.url(),
      };
    }

    await page.goto("https://www.walmart.com/cart", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    return {
      ok: true,
      stage: "cart",
      message: "Dry-run · cart · Place order OFF",
      itemId,
      ms: Date.now() - t0,
      finalUrl: page.url(),
    };
  } catch (e) {
    return fail("error", e?.message || String(e));
  } finally {
    if (!keepChrome) await session.close?.().catch(() => {});
  }
}
