/**
 * PKC guest checkout — headed. Queue-it hold on same IP. Default dry-run (ATC).
 * Sept 2026: Imperva + Queue-it on hyped drops + DataDome/hCaptcha.
 * Same proxy that entered the room MUST checkout.
 */
import { launchBrowser } from "./headless-browser.mjs";
import { persistCookies, loadCookies, playwrightCookies } from "./cookie-persist.mjs";
import { pokemonUrl } from "./pokemon-monitor.mjs";
import { solvePageCaptcha } from "./captcha-solve.mjs";
import { solveInBrowser, waitForHumanCaptcha } from "./free-solve.mjs";

const QUEUE_HOLD_MS = 15 * 60 * 1000;

async function clickFirst(page, sels) {
  for (const sel of sels) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && (await loc.isVisible({ timeout: 800 }).catch(() => false))) {
        await loc.click({ timeout: 2500, delay: 50 });
        return sel;
      }
    } catch {
      /* */
    }
  }
  return null;
}

function inQueue(page, html) {
  const u = `${page.url()} ${html || ""}`.toLowerCase();
  return /queue-it|queueittoken|waiting room|please wait while we verify/.test(u);
}

function isPlaceholder(product) {
  const s = String(product || "").trim().toUpperCase();
  return !s || s === "PLACEHOLDER" || s === "QUEUE" || s === "NEW";
}

async function fillVisible(page, selectors, value) {
  const v = String(value || "").trim();
  if (!v) return false;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count()) || !(await loc.isVisible({ timeout: 600 }).catch(() => false))) continue;
      await loc.click({ timeout: 1500 }).catch(() => {});
      await loc.fill("");
      await loc.pressSequentially(v, { delay: 18 });
      return true;
    } catch {
      /* */
    }
  }
  return false;
}

async function fillGuest(page, profile = {}) {
  const filled = [];
  const email = profile.email || "";
  if (await fillVisible(page, ['input[type="email"]', 'input[name*="email" i]', 'input[autocomplete="email"]'], email)) {
    filled.push("email");
  }
  if (await fillVisible(page, ['input[autocomplete="given-name"]', 'input[name*="first" i]', 'input[id*="firstName" i]'], profile.firstName)) {
    filled.push("first");
  }
  if (await fillVisible(page, ['input[autocomplete="family-name"]', 'input[name*="last" i]', 'input[id*="lastName" i]'], profile.lastName)) {
    filled.push("last");
  }
  if (await fillVisible(page, ['input[autocomplete="address-line1"]', 'input[name*="address" i]', 'input[id*="address" i]'], profile.address1)) {
    filled.push("addr");
  }
  if (await fillVisible(page, ['input[autocomplete="address-level2"]', 'input[name*="city" i]'], profile.city)) filled.push("city");
  if (await fillVisible(page, ['input[autocomplete="address-level1"]', 'select[name*="state" i]', 'select[id*="state" i]'], profile.state)) {
    filled.push("state");
  }
  if (await fillVisible(page, ['input[autocomplete="postal-code"]', 'input[name*="zip" i]', 'input[name*="postal" i]'], profile.zip)) {
    filled.push("zip");
  }
  if (await fillVisible(page, ['input[type="tel"]', 'input[autocomplete="tel"]', 'input[name*="phone" i]'], profile.phone)) {
    filled.push("phone");
  }

  const pan = String(profile.cardNumber || "").replace(/\s/g, "");
  const exp = String(profile.exp || "");
  const cvv = String(profile.cvv || "");
  for (const frame of page.frames()) {
    const u = frame.url() || "";
    if (!/card|pay|stripe|adyen|cybersource|braintree|spreedly/i.test(u) && frame === page.mainFrame()) continue;
    try {
      if (pan.length >= 13) {
        const n = frame.locator('input[name*="number" i], input[autocomplete="cc-number"], input[id*="card" i]').first();
        if (await n.count()) {
          await n.fill(pan, { timeout: 2000 });
          filled.push("card");
        }
      }
      if (exp) {
        const e = frame.locator('input[autocomplete="cc-exp"], input[name*="exp" i]').first();
        if (await e.count()) await e.fill(exp.replace(/\s/g, ""), { timeout: 1500 });
      }
      if (cvv) {
        const c = frame.locator('input[autocomplete="cc-csc"], input[name*="cvv" i], input[name*="cvc" i]').first();
        if (await c.count()) await c.fill(cvv, { timeout: 1500 });
      }
    } catch {
      /* iframe locked */
    }
  }
  await clickFirst(page, [
    'button:has-text("Place Order")',
    'button:has-text("Pay now")',
    'button:has-text("Submit")',
    'button[type="submit"]',
  ]);
  return filled;
}

export async function runPokemonCheckout(body = {}) {
  const t0 = Date.now();
  const region = body.region || "US";
  const product = body.product || body.url || "";
  const placeholder = isPlaceholder(product);
  const href = placeholder
    ? pokemonUrl("/category/new-releases", region)
    : pokemonUrl(product, region);
  const placeOrder = body.placeOrder === true;
  const session = await launchBrowser({
    headed: true,
    proxy: body.proxy,
    taskId: body.sessionId || body.taskId || "pkc",
  });
  try {
    const { page, context } = session;
    const jar = loadCookies({ taskId: body.sessionId || body.taskId, store: "Pokemon Center" });
    if (jar?.cookies?.length) await context.addCookies(playwrightCookies(jar.cookies)).catch(() => {});
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45000 });
    const human = await waitForHumanCaptcha(page, { timeoutMs: 180000 }).catch(() => ({ ok: true }));
    if (human && human.needed && !human.ok) {
      return {
        ok: false,
        stage: "blocked",
        message: "DataDome · Chrome abierto 3 min — resuelve el captcha a mano (sin CapMonster)",
        ms: Date.now() - t0,
      };
    }

    let html = await page.content().catch(() => "");
    if (/captcha-delivery|datadome/i.test(html + page.url()) && body.captcha) {
      const cap = await solvePageCaptcha({ html, url: page.url(), cfg: body.captcha || {} });
      if (cap.ok && cap.token) {
        await page
          .evaluate((t) => {
            document.cookie = `datadome=${t}; path=/`;
          }, cap.token)
          .catch(() => {});
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        html = await page.content().catch(() => "");
      }
    }

    if (inQueue(page, html)) {
      const until = Date.now() + Number(body.queueHoldMs || QUEUE_HOLD_MS);
      while (Date.now() < until) {
        html = await page.content().catch(() => "");
        if (!inQueue(page, html)) break;
        await page.waitForTimeout(4000);
      }
      html = await page.content().catch(() => "");
      if (inQueue(page, html)) {
        persistCookies({
          taskId: body.sessionId || body.taskId,
          cookies: await context.cookies(),
          proxy: body.proxy,
          store: "Pokemon Center",
        });
        return {
          ok: false,
          stage: "queue",
          message: "Queue-it · still in room · same IP kept · retry this task (do NOT rotate proxy)",
          finalUrl: page.url(),
          ms: Date.now() - t0,
          keepOpen: true,
        };
      }
    }

    if (placeholder) {
      persistCookies({
        taskId: body.sessionId || body.taskId,
        cookies: await context.cookies(),
        proxy: body.proxy,
        store: "Pokemon Center",
      });
      return {
        ok: true,
        stage: "queue_ready",
        message: "PLACEHOLDER · passed queue / new-releases · edit task with SKU then Start again (same proxy)",
        finalUrl: page.url(),
        ms: Date.now() - t0,
      };
    }

    const atc = await clickFirst(page, [
      'button:has-text("Add to Cart")',
      'button:has-text("Add to Bag")',
      'button:has-text("Pre-Order")',
      'button[id*="add-to-cart"]',
    ]);
    if (!atc) {
      const bodyHtml = await page.content();
      return {
        ok: false,
        stage: /sold out/i.test(bodyHtml) ? "oos" : "atc_failed",
        message: "ATC not found",
        ms: Date.now() - t0,
      };
    }
    persistCookies({
      taskId: body.sessionId || body.taskId,
      cookies: await context.cookies(),
      proxy: body.proxy,
      store: "Pokemon Center",
    });
    if (!placeOrder) {
      return {
        ok: true,
        stage: "cart",
        message: "Dry-run · ATC guest · Place order OFF",
        ms: Date.now() - t0,
        finalUrl: page.url(),
      };
    }
    await clickFirst(page, [
      'a:has-text("Checkout")',
      'button:has-text("Checkout")',
      'a:has-text("Guest")',
      'button:has-text("Guest")',
      'a:has-text("Continue as guest")',
    ]);
    await page.waitForTimeout(900);
    const filled = await fillGuest(page, body.profile || {});
    persistCookies({
      taskId: body.sessionId || body.taskId,
      cookies: await context.cookies(),
      proxy: body.proxy,
      store: "Pokemon Center",
    });
    const htmlPay = `${await page.content().catch(() => "")} ${page.url()}`;
    if (/thank you|order confirmation|order number/i.test(htmlPay)) {
      const on = (htmlPay.match(/#?\d{8,}/) || [])[0];
      return {
        ok: true,
        stage: "ordered",
        message: on ? `Order ${on}` : "PKC guest ordered",
        orderNumber: on,
        filled,
        ms: Date.now() - t0,
        finalUrl: page.url(),
      };
    }
    return {
      ok: true,
      stage: "checkout",
      message: `Guest filled ${filled.join(",") || "—"} · confirm in Chrome`,
      filled,
      keepOpen: true,
      ms: Date.now() - t0,
      finalUrl: page.url(),
    };
  } catch (e) {
    return { ok: false, stage: "error", message: e?.message || String(e), ms: Date.now() - t0 };
  } finally {
    if (!placeOrder && !body.keepQueueChrome) await session.close?.().catch(() => {});
  }
}
