/**
 * Target checkout — Playwright, shipping-only ATC.
 * Default: dry-run (cart verify, no Place Order).
 * Cookies restored from disk jar (taskId / email) with original flags.
 */
import { persistCookies, loadCookies, playwrightCookies } from "./cookie-persist.mjs";
import { solvePageCaptcha, injectCaptchaToken } from "./captcha-solve.mjs";
import { totpNow, hasTotpSecret } from "./totp.mjs";
import { pollEmailOtp } from "./otp-inbox.mjs";
import { solveInBrowser } from "./free-solve.mjs";
import { injectShape, harvestShapeOnce, ensureBank } from "./shape-bank.mjs";

/** Select shipping fulfillment — never pickup / addToCart generic. */
const SHIP_FULFILLMENT = [
  '[data-test="fulfillment-cell-shipping"]',
  'button[data-test="fulfillment-cell-shipping"]',
  '[data-test="fulfillment-shipping"]',
  '[data-test="shippingButton"]',
  'button[data-test="fulfillment-cell-shipping"] span',
  '[data-test*="fulfillment"][data-test*="ship" i]',
  'button:has-text("Shipping")',
  'label:has-text("Shipping")',
  '[aria-label*="Shipping" i]',
];

/** ATC only after shipping is selected. No addToCartButton (that's often pickup). */
const SHIP_ATC = [
  '[data-test="shipItButton"]',
  'button[data-test="shipItButton"]',
  '[data-test*="shipIt" i]',
  '[id*="shipIt" i]',
  'button:has-text("Ship it")',
  'button:has-text("Ship It")',
  'button:has-text("Ship it for")',
  'button:has-text("Preorder it")',
  'button:has-text("Pre-order it")',
  'button:has-text("Preorder")',
  'button:has-text("Pre-order")',
  'button:has-text("Deliver it")',
  'button:has-text("Deliver to")',
  '[data-test="preorderButton"]',
  '[data-test="shippingButton"]',
  'button[data-test="orderPickupButton"] + button',
];

const PICKUP_SELECTORS = [
  '[data-test="orderPickupButton"]',
  '[data-test="storePickupButton"]',
  'button:has-text("Order Pickup")',
  'button:has-text("Pick up")',
];

const CHECKOUT_SELECTORS = [
  '[data-test="checkout-button"]',
  'button[data-test="checkout-button"]',
  'a[data-test="checkout-button"]',
  'button:has-text("Check out")',
  'button:has-text("Checkout")',
  'a:has-text("Check out")',
];

function parseExp(exp) {
  const s = String(exp || "").replace(/\s/g, "");
  const m = s.match(/^(\d{1,2})\D?(\d{2,4})$/);
  if (!m) return { mm: "", yy: "", yyyy: "", slash: "" };
  const mm = m[1].padStart(2, "0");
  let yyyy = m[2];
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  const yy = yyyy.slice(-2);
  return { mm, yy, yyyy, slash: `${mm}/${yy}` };
}

async function humanType(locator, text) {
  const delay = 45 + Math.floor(Math.random() * 50);
  await locator.click({ timeout: 800, delay: 25 }).catch(() => {});
  const tag = await locator.evaluate((el) => el.tagName).catch(() => "INPUT");
  if (String(tag).toUpperCase() === "SELECT") {
    await locator.selectOption(String(text)).catch(async () => {
      await locator.fill(String(text));
    });
    return;
  }
  await locator.fill("").catch(() => {});
  if (typeof locator.pressSequentially === "function") {
    await locator.pressSequentially(String(text), { delay });
  } else {
    await locator.type(String(text), { delay });
  }
}

async function fillFirst(scope, selectors, value) {
  if (value == null || value === "") return false;
  for (const sel of selectors) {
    try {
      const loc = scope.locator(sel).first();
      if (!(await loc.count())) continue;
      if (!(await loc.isVisible({ timeout: 600 }).catch(() => false))) continue;
      await humanType(loc, value);
      return true;
    } catch {
      /* */
    }
  }
  return false;
}

async function classifyPayFrame(frame) {
  let title = "";
  try {
    title = await frame.title();
  } catch {
    /* */
  }
  const s = `${frame.url()} ${frame.name()} ${title}`.toLowerCase();
  if (/cvc|cvv|security|encryptedsecurity|cid/.test(s)) return "cvv";
  if (/expir|encryptedexpiry|expirydate|exp-date/.test(s)) return "exp";
  if (/card.?number|encryptedcard|cardnumber|pan/.test(s)) return "pan";
  if (/holder|cardholder|name on/.test(s)) return "name";
  return null;
}

async function typeFrameInput(frame, value) {
  if (value == null || value === "") return false;
  const box = frame
    .locator(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), input[type="tel"], input[type="text"], input[type="password"]'
    )
    .first();
  try {
    if (!(await box.count())) return false;
    await box.click({ timeout: 1200, delay: 30 });
    await humanType(box, value);
    return true;
  } catch {
    return false;
  }
}

/** Adyen / Target hosted fields live in cross-origin iframes (closed shadow on the host). */
async function fillHostedCard(page, profile) {
  const p = profile || {};
  const exp = parseExp(p.exp || p.expiry || p.cardExp);
  const pan = String(p.cardNumber || "").replace(/\s/g, "");
  const cvv = String(p.cvv || p.cid || "");
  const name = p.cardholder || `${p.firstName || ""} ${p.lastName || ""}`.trim();
  await page
    .waitForSelector(
      'iframe[src*="adyen"], iframe[src*="checkoutshopper"], iframe[src*="payment"], iframe[title*="card" i], iframe[id*="encrypted"]',
      { timeout: 8000 }
    )
    .catch(() => {});
  await page.waitForTimeout(400);

  let hits = 0;
  const want = { pan, exp: exp.slash, cvv, name };
  for (const frame of page.frames()) {
    const kind = await classifyPayFrame(frame);
    if (!kind) continue;
    const val = kind === "pan" ? want.pan : kind === "exp" ? want.exp : kind === "cvv" ? want.cvv : want.name;
    if (await typeFrameInput(frame, val)) hits += 1;
  }
  if (hits) return hits;

  // Fallback: first 4 payment iframes = pan / exp / cvv / name
  const payFrames = page.frames().filter((f) => {
    const u = f.url();
    return /adyen|checkoutshopper|tokenex|spreedly|braintree|payment|cardinal/i.test(u);
  });
  const order = [want.pan, want.exp, want.cvv, want.name];
  for (let i = 0; i < Math.min(payFrames.length, order.length); i++) {
    if (await typeFrameInput(payFrames[i], order[i])) hits += 1;
  }
  return hits;
}

async function fillShadowInputs(page, selectors, value) {
  if (value == null || value === "") return false;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click({ timeout: 600, delay: 20 }).catch(() => {});
        await humanType(loc, value);
        return true;
      }
    } catch {
      /* Playwright pierces open shadow; closed lives in iframes */
    }
  }
  return false;
}

async function fillPierce(scope, hints, value) {
  if (value == null || value === "") return false;
  try {
    return await scope.evaluate(
      ({ hints, val }) => {
        const needle = (hints || []).map((h) => String(h).toLowerCase());
        const seen = [];
        const walk = (root) => {
          if (!root) return;
          root.querySelectorAll("input, select, textarea").forEach((el) => seen.push(el));
          root.querySelectorAll("*").forEach((el) => {
            if (el.shadowRoot) walk(el.shadowRoot);
          });
        };
        walk(document);
        const hit = seen.find((el) => {
          const blob = [
            el.name,
            el.id,
            el.autocomplete,
            el.placeholder,
            el.getAttribute("data-test"),
            el.getAttribute("aria-label"),
            el.type,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return needle.some((h) => h && blob.includes(h));
        });
        if (!hit) return false;
        hit.focus();
        const proto = Object.getPrototypeOf(hit);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(hit, val);
        else hit.value = val;
        hit.dispatchEvent(new Event("input", { bubbles: true }));
        hit.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      { hints, val: String(value) }
    );
  } catch {
    return false;
  }
}

async function fillEverywhere(page, selectors, value) {
  if (value == null || value === "") return false;
  if (await fillFirst(page, selectors, value)) return true;
  if (await fillShadowInputs(page, selectors, value)) return true;
  const hints = selectors
    .join(" ")
    .toLowerCase()
    .match(/firstname|lastname|address|city|state|zip|phone|email|cardnumber|card|cvv|expir|holder|cc-number|cc-exp|cc-csc|given-name|family-name|postal|tel/g) || [];
  if (await fillPierce(page, hints, value)) return true;
  for (const frame of page.frames()) {
    try {
      if (await fillFirst(frame, selectors, value)) return true;
      if (await fillPierce(frame, hints, value)) return true;
    } catch {
      /* */
    }
  }
  return false;
}

async function fillTargetPayment(page, profile) {
  if (!profile) return { shipping: 0, card: 0 };
  const p = profile;
  const exp = parseExp(p.exp || p.expiry || p.cardExp);
  let shipping = 0;
  let card = 0;
  const hit = async (sels, val) => {
    if (await fillEverywhere(page, sels, val)) shipping += 1;
  };
  const hitCard = async (sels, val) => {
    if (await fillEverywhere(page, sels, val)) card += 1;
  };

  await hit(
    ['[data-test="firstName"]', 'input[name="firstName"]', 'input[autocomplete="given-name"]', "#firstName"],
    p.firstName
  );
  await hit(
    ['[data-test="lastName"]', 'input[name="lastName"]', 'input[autocomplete="family-name"]', "#lastName"],
    p.lastName
  );
  await hit(
    [
      '[data-test="addressLine1"]',
      'input[name="addressLine1"]',
      'input[autocomplete="address-line1"]',
      "#addressLine1",
    ],
    p.address1 || p.address
  );
  await hit(
    ['[data-test="addressLine2"]', 'input[name="addressLine2"]', 'input[autocomplete="address-line2"]'],
    p.address2
  );
  await hit(['[data-test="city"]', 'input[name="city"]', 'input[autocomplete="address-level2"]', "#city"], p.city);
  await hit(
    ['[data-test="state"]', 'select[name="state"]', 'select[autocomplete="address-level1"]', "#state"],
    p.state
  );
  await hit(
    ['[data-test="zipCode"]', 'input[name="zipCode"]', 'input[autocomplete="postal-code"]', "#zipCode", 'input[name="zip"]'],
    p.zip
  );
  await hit(
    ['[data-test="phone"]', 'input[name="phone"]', 'input[autocomplete="tel"]', 'input[type="tel"]'],
    p.phone
  );
  await hit(
    ['[data-test="email"]', 'input[name="email"]', 'input[autocomplete="email"]', 'input[type="email"]'],
    p.email
  );

    await clickFirst(page, [
    'button:has-text("Credit or debit")',
    'button:has-text("Credit / debit")',
    '[data-test="credit-card-radio"]',
    'label:has-text("Credit")',
  ], 1500);

  await hitCard(
    [
      'input[name="cardNumber"]',
      'input[autocomplete="cc-number"]',
      'input[id*="cardNumber"]',
      'input[id*="encryptedCard"]',
      'input[placeholder*="card number" i]',
      '[data-test="credit-card-number"]',
      "#encryptedCardNumber",
      'input[name="encryptedCardNumber"]',
    ],
    String(p.cardNumber || "").replace(/\s/g, "")
  );
  await hitCard(
    ['input[name="cardholder"]', 'input[autocomplete="cc-name"]', 'input[name="nameOnCard"]', '[data-test="name-on-card"]'],
    p.cardholder || `${p.firstName || ""} ${p.lastName || ""}`.trim()
  );
  await hitCard(
    ['input[name="expiration"]', 'input[autocomplete="cc-exp"]', 'input[name="expiry"]', '[data-test="expiration"]'],
    exp.slash
  );
  await hitCard(['input[name="expiryMonth"]', 'select[name="expMonth"]', 'select[autocomplete="cc-exp-month"]'], exp.mm);
  await hitCard(['input[name="expiryYear"]', 'select[name="expYear"]', 'select[autocomplete="cc-exp-year"]'], exp.yyyy || exp.yy);
  await hitCard(
    ['input[name="cvv"]', 'input[autocomplete="cc-csc"]', 'input[name="cid"]', '[data-test="cvv"]', 'input[id*="cvv"]'],
    p.cvv
  );

  const hosted = await fillHostedCard(page, p);
  if (hosted) card += hosted;

  await clickFirst(page, [
    'button:has-text("Save and continue")',
    'button:has-text("Save & continue")',
    '[data-test="saveAndContinue"]',
    'button:has-text("Continue")',
  ], 2000);

  return { shipping, card };
}

async function clickFirst(page, selectors, timeout = 3500) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) continue;
      if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const disabled = await loc.isDisabled().catch(() => false);
      if (disabled) continue;
      await loc.click({ timeout, delay: 40 });
      return sel;
    } catch {
      /* next */
    }
  }
  return null;
}

async function diagnoseAtc(page) {
  try {
    return await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("button, a[data-test], [data-test*='ship'], [data-test*='cart']")];
      const buttons = nodes
        .slice(0, 50)
        .map((el) => ({
          test: el.getAttribute("data-test") || "",
          text: String(el.innerText || el.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 90),
          disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
        }))
        .filter((b) => b.text || /ship|cart|fulfill|order/i.test(b.test));
      return { url: location.href, title: document.title, buttons: buttons.slice(0, 18) };
    });
  } catch {
    return { url: page.url(), buttons: [] };
  }
}

async function selectShippingThenAtc(page) {
  await clickFirst(page, SHIP_FULFILLMENT, 2000);
  await page.waitForTimeout(280);
  let ship = await clickFirst(page, SHIP_ATC, 5000);
  if (!ship) {
    const role = page.getByRole("button", { name: /ship it|pre-?order it|deliver it|add to cart/i }).first();
    if (await role.count().catch(() => 0)) {
      await role.click({ timeout: 4000, delay: 40 }).catch(() => {});
      ship = "role:ship-it";
    }
  }
  if (!ship) {
    await clickFirst(page, SHIP_FULFILLMENT, 1500);
    await page.waitForTimeout(200);
    ship = await clickFirst(page, SHIP_ATC, 4000);
  }
  // After shipping cell is selected, Target A/B often shows Add to cart (not Ship it).
  if (!ship) {
    ship = await clickFirst(
      page,
      [
        '[data-test="addToCartButton"]:visible',
        'button[data-test="addToCartButton"]',
        'button:has-text("Add to cart")',
        'button:has-text("Add to Cart")',
      ],
      3500
    );
  }
  return ship;
}

async function ensureShippingZip(page, zip) {
  const z = String(zip || "").replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(z)) return false;
  const inputs = [
    '[data-test="zip-code-text-field"]',
    '[data-test="zipCode"]',
    'input[name="zipCode"]',
    'input[name="zip"]',
    'input[autocomplete="postal-code"]',
    'input[id*="zip" i]',
    'input[placeholder*="ZIP" i]',
    'input[placeholder*="zip" i]',
  ];
  const locBtn = [
    '[data-test="update-location"]',
    'button:has-text("Update")',
    'button:has-text("Apply")',
    'button:has-text("Deliver to")',
    'button:has-text("Set location")',
  ];
  await clickFirst(
    page,
    [
      '[data-test="store-location"]',
      'button:has-text("Deliver to")',
      'button:has-text("Ship to")',
      '[data-test*="location" i]',
    ],
    1200
  ).catch(() => {});
  for (const sel of inputs) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count()) || !(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
      await loc.fill(z, { timeout: 1500 });
      await clickFirst(page, locBtn, 1500);
      await page.waitForTimeout(400);
      return true;
    } catch {
      /* */
    }
  }
  return false;
}

async function setQty(page, qty) {
  const n = Math.max(1, Math.min(10, Number(qty) || 1));
  if (n <= 1) return;
  const input = page.locator('[data-test="qty"], input[name="quantity"], input[data-test="item-quantity"]').first();
  if (await input.count()) {
    await input.fill(String(n)).catch(() => {});
    return;
  }
  const inc = page.locator('[data-test="quantity-increase"], button[aria-label*="increase" i]').first();
  for (let i = 1; i < n; i++) {
    if (await inc.count()) await inc.click({ delay: 40 }).catch(() => {});
  }
}

async function tryHoldPx(page) {
  const loc = page
    .locator('#px-captcha, [id*="px-captcha"], button:has-text("Press & Hold"), button:has-text("Press and Hold")')
    .first();
  if (!(await loc.count().catch(() => 0))) return false;
  const box = await loc.boundingBox().catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3200 + Math.floor(Math.random() * 800));
  await page.mouse.up();
  await page.waitForTimeout(800);
  return true;
}

function looksBlocked(html, url) {
  const t = String(html || "").toLowerCase();
  const u = String(url || "").toLowerCase();
  return (
    /access denied|forbidden|akamai|attention required|px-captcha|shape.?security|blocked/i.test(t) ||
    /challenges\.cloudflare|_sec|_abck/i.test(u) && /denied|captcha/i.test(t)
  );
}

function looksOosShipping(html) {
  const t = String(html || "");
  if (/data-test=["']shipItButton["']/i.test(t)) return false;
  if (/\bship it\b/i.test(t) && !/ship it[\s\S]{0,80}unavailable/i.test(t.toLowerCase())) return false;
  const low = t.toLowerCase();
  return (
    /not available for shipping/i.test(low) ||
    /this item isn't available to ship/i.test(low) ||
    /unavailable to ship/i.test(low) ||
    /out of stock[\s\S]{0,80}ship/i.test(low) ||
    /shipping[\s\S]{0,50}unavailable/i.test(low)
  );
}

function looksOosAfterCart(html, text) {
  const t = `${html || ""} ${text || ""}`.toLowerCase();
  return (
    /no longer available/i.test(t) ||
    /item(?:s)? (?:is|are) (?:now )?out of stock/i.test(t) ||
    /this item isn't available/i.test(t) ||
    /sold out/i.test(t) ||
    /unable to fulfill/i.test(t) ||
    /removed from your cart/i.test(t) ||
    /not available to ship/i.test(t)
  );
}

function looksLoggedOut(html, url) {
  return /\/login/i.test(url) || /sign in to your target account/i.test(html);
}

function frameUrls(page) {
  try {
    return page.frames().map((f) => f.url() || "").join(" ");
  } catch {
    return "";
  }
}

function classify3ds(page, html = "", url = "", text = "") {
  const frames = frameUrls(page);
  const blob = `${url}\n${frames}\n${text}\n${String(html || "").slice(0, 18000)}`.toLowerCase();
  if (/recaptcha|hcaptcha|turnstile|px-captcha|press and hold/.test(blob)) return "captcha";
  if (
    /open (the )?app|approve in (the )?app|banking app|face id|touch id|biometric|push notification|we've sent a notification|sent you a notification|approve this purchase|use your (bank )?app/.test(
      blob
    )
  )
    return "app";
  if (
    /push|notification to your (phone|device)|approve on your (phone|device)|sent a push/.test(blob)
  )
    return "push";
  if (
    /one[- ]time|otp|passcode|enter (the )?code|sms|text message|we (emailed|texted)|verification code|6-digit|six.digit/.test(
      blob
    )
  )
    return "otp";
  if (/password|pin code|enter your pin/.test(blob)) return "pin";
  if (is3dsChallenge(page, html, url)) return "unknown";
  return null;
}

function is3dsChallenge(page, html = "", url = "") {
  const frames = frameUrls(page);
  const blob = `${url} ${frames} ${String(html || "").slice(0, 14000)}`;
  if (
    /cardinalcommerce|songbird|cardinal-cca|threedsmethod|creq=|3dsecure|3ds-acs|acs\.|securecode|step-up|stepup|visa\.com\/emv|mastercard\.|amex\.|discover\.|netcetera|cybersource|adyen\.com\/hpp|authentication\.cardinal|challengeWindow|threeDS2|BankID|one-time|otp|passcode/i.test(
      blob
    )
  )
    return true;
  try {
    if (
      page
        .frames()
        .some((f) =>
          /cardinal|3ds|acs|emv3ds|securecode|songbird|netcetera|cybersource|visa|mastercard/i.test(f.url() || "")
        )
    )
      return true;
  } catch {
    /* */
  }
  return /id=["']Cardinal-CCA|CardinalCruise|threeDS2|challengeWindow/i.test(String(html || ""));
}

async function clickInAnyFrame(page, selectors, timeout = 1500) {
  if (await clickFirst(page, selectors, timeout)) return true;
  for (const frame of page.frames()) {
    try {
      for (const sel of selectors) {
        const loc = frame.locator(sel).first();
        if (!(await loc.count())) continue;
        if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
        await loc.click({ timeout, delay: 30 });
        return true;
      }
    } catch {
      /* */
    }
  }
  return false;
}

async function fillDigitBoxes(scope, code) {
  const digits = String(code || "").replace(/\D/g, "");
  if (digits.length < 4) return false;
  try {
    const boxes = scope.locator(
      'input[maxlength="1"], input[aria-label*="digit" i], input[name*="otpDigit" i], input[autocomplete="one-time-code"]'
    );
    const n = await boxes.count();
    if (n >= 4 && n <= 8) {
      for (let i = 0; i < Math.min(n, digits.length); i++) {
        await boxes.nth(i).fill(digits[i]).catch(() => {});
      }
      return true;
    }
  } catch {
    /* */
  }
  return false;
}

async function fillOtpAnywhere(page, code) {
  if (!code) return false;
  const sels = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="passcode" i]',
    'input[name*="sms" i]',
    'input[id*="otp" i]',
    'input[id*="passcode" i]',
    'input[placeholder*="code" i]',
    'input[aria-label*="code" i]',
    'input[type="tel"]',
    'input[type="password"]',
    'input[inputmode="numeric"]',
    'input[maxlength="6"]',
    'input[maxlength="8"]',
  ];
  const scopes = [page, ...page.frames()];
  for (const scope of scopes) {
    try {
      if (await fillDigitBoxes(scope, code)) {
        await clickInAnyFrame(page, [
          'button[type="submit"]',
          'button:has-text("Submit")',
          'button:has-text("Verify")',
          'button:has-text("Continue")',
          'button:has-text("Confirm")',
          'button:has-text("Next")',
          'button:has-text("Validate")',
          'input[type="submit"]',
        ], 2000);
        return true;
      }
      if (await fillFirst(scope, sels, code)) {
        await clickInAnyFrame(page, [
          'button[type="submit"]',
          'button:has-text("Submit")',
          'button:has-text("Verify")',
          'button:has-text("Continue")',
          'button:has-text("Confirm")',
          'button:has-text("Next")',
          'button:has-text("Validate")',
          'input[type="submit"]',
        ], 2000);
        return true;
      }
    } catch {
      /* */
    }
  }
  return false;
}

async function nudge3ds(page) {
  return clickInAnyFrame(
    page,
    [
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'button:has-text("Verify")',
      'button:has-text("Yes")',
      'button:has-text("Approve")',
      'button:has-text("Authenticate")',
      'button:has-text("I authorize")',
      'input[type="submit"]',
      'button[type="submit"]',
    ],
    1200
  );
}

async function useSavedCard(page) {
  return !!(await clickFirst(
    page,
    [
      '[data-test*="saved"][data-test*="card"]',
      'button:has-text("ending in")',
      'label:has-text("ending in")',
      '[aria-label*="ending in"]',
      'input[name*="savedCard"]',
      '[data-test="credit-card-radio"]:checked',
    ],
    1800
  ));
}

function parseOrderNumber(text) {
  const t = String(text || "");
  const m =
    t.match(/order\s*(number|#)\s*[:#]?\s*([A-Z0-9-]{8,})/i) ||
    t.match(/\b(W-\d{6,})\b/) ||
    t.match(/\b(\d{10,})\b/);
  return m ? m[2] || m[1] : undefined;
}

function paymentOutcome(text) {
  const t = String(text || "");
  if (/thanks for (your )?order|order confirmed|we.ve received your order|order number/i.test(t)) {
    return { kind: "ordered", orderNumber: parseOrderNumber(t) };
  }
  if (/declined|do not honor|insufficient|payment (failed|was declined)|card was declined|cannot process/i.test(t)) {
    return { kind: "declined" };
  }
  if (/canceled|cancelled|session timed out/i.test(t)) {
    return { kind: "canceled" };
  }
  return { kind: "pending" };
}

async function trySolveAcsCaptcha(page, cfg) {
  if (!cfg || (!cfg.capmonsterKey && !cfg.twocaptchaKey)) {
    return { ok: false, skip: true, reason: "no solver key" };
  }
  const frames = page.frames();
  for (const frame of frames) {
    let html = "";
    let url = "";
    try {
      url = frame.url();
      html = await frame.content();
    } catch {
      continue;
    }
    if (!/recaptcha|hcaptcha|turnstile|captcha-delivery/i.test(html + url)) continue;
    const det = await solvePageCaptcha({
      html,
      url,
      cfg,
      timeoutMs: 90_000,
    });
    if (det.skip) continue;
    if (det.ok && det.token) {
      const injected = await injectCaptchaToken(frame, det.token, det.kind);
      return { ...det, injected, url };
    }
    if (det.error) return det;
  }
  return { ok: false, skip: true, reason: "ACS is bank OTP, not captcha" };
}

async function waitAfterPlace(page, ms = 10000) {
  const t0 = Date.now();
  let html = "";
  let url = page.url();
  let text = "";
  while (Date.now() - t0 < ms) {
    html = await page.content().catch(() => "");
    url = page.url();
    text = await page.locator("body").innerText().catch(() => "");
    const out = paymentOutcome(text + "\n" + html);
    if (out.kind === "ordered" || out.kind === "declined" || out.kind === "canceled") {
      return { out, html, url, text };
    }
    if (is3dsChallenge(page, html, url)) {
      return { out: { kind: "3ds" }, html, url, text };
    }
    await page.waitForTimeout(700);
  }
  return { out: { kind: "pending" }, html, url, text };
}

async function waitFor3ds(page, waitMs, cfg, totpSecret = "", imap = {}) {
  const deadline = Date.now() + Math.max(20_000, waitMs);
  let solved = false;
  let lastOtpAt = 0;
  let otpVia = "";
  let nudged = false;
  let lastImap = 0;
  let challenge = null;
  while (Date.now() < deadline) {
    const pages = page.context().pages();
    for (const p of pages) {
      const html = await p.content().catch(() => "");
      const url = p.url();
      const text = await p.locator("body").innerText().catch(() => "");
      const kind = classify3ds(p, html, url, text);
      if (kind && kind !== challenge) challenge = kind;
      const out = paymentOutcome(text + "\n" + html);
      if (out.kind === "ordered") {
        return { stage: "ordered", orderNumber: out.orderNumber, url, captcha: solved, otpVia, challenge };
      }
      if (out.kind === "declined") {
        return { stage: "payment_failed", message: "Card declined / 3DS rejected", url, challenge };
      }
      if (out.kind === "canceled") {
        return { stage: "payment_failed", message: "3DS canceled or timed out at bank", url, challenge };
      }
      if (is3dsChallenge(p, html, url) || kind) {
        if (!nudged) nudged = await nudge3ds(p);
        if (kind === "captcha" && !solved) {
          const free = await solveInBrowser(p, { timeoutMs: 8000 }).catch(() => null);
          if (free?.ok) solved = true;
          if (!solved) {
            const cap = await trySolveAcsCaptcha(p, cfg);
            if (cap.ok && cap.token) solved = true;
          }
        } else if (!solved && kind !== "push" && kind !== "app") {
          const free = await solveInBrowser(p, { timeoutMs: 4000 }).catch(() => null);
          if (free?.ok) solved = true;
          if (!solved) {
            const cap = await trySolveAcsCaptcha(p, cfg);
            if (cap.ok && cap.token) solved = true;
          }
        }
        if (kind === "otp" || kind === "pin" || !kind) {
          if (hasTotpSecret(totpSecret) && Date.now() - lastOtpAt > 20000) {
            const code = totpNow(totpSecret);
            if (code) {
              const ok = await fillOtpAnywhere(p, code);
              if (ok) {
                lastOtpAt = Date.now();
                otpVia = "totp";
              }
            }
          }
          if (kind === "otp" && imap?.user && imap?.pass && Date.now() - lastImap > 4000) {
            lastImap = Date.now();
            const mail = await pollEmailOtp(imap).catch(() => ({ ok: false }));
            if (mail?.ok && mail.code) {
              const ok = await fillOtpAnywhere(p, mail.code);
              if (ok) {
                lastOtpAt = Date.now();
                otpVia = "imap";
              }
            }
          }
        }
      }
    }
    await page.waitForTimeout(1200);
  }
  const otpTried = !!otpVia || lastOtpAt > 0;
  const hint =
    challenge === "push" || challenge === "app"
      ? `3DS ${challenge.toUpperCase()} · aprueba en el celular · Chrome abierto`
      : challenge === "otp"
        ? otpTried
          ? `OTP ${otpVia} enviado · si pide otro, mira el mail/SMS`
          : "3DS OTP · IMAP/TOTP missed · paste the bank code"
        : challenge === "captcha"
          ? solved
            ? "ACS captcha inyectado · espera OTP/push"
            : "ACS captcha · pon CapMonster key"
          : otpTried
            ? `OTP ${otpVia} enviado · Chrome abierto · confirma push si pide`
            : `3DS ${challenge || "open"} · paste the bank code (${Math.round(waitMs / 1000)}s)`;
  return {
    stage: "needs_3ds",
    message: hint,
    url: page.url(),
    captcha: solved,
    totp: otpTried,
    otpVia,
    challenge: challenge || "unknown",
  };
}

export async function runTargetCheckout(body = {}) {
  const t0 = Date.now();
  const tcin = String(body.tcin || body.sku || "").replace(/\D/g, "");
  const sessionId = String(body.sessionId || body.taskId || "");
  const email = String(body.accountEmail || body.email || "").trim();
  const placeOrder = body.placeOrder === true || body.liveCheckout === true;
  const wait3dsSec = Math.max(30, Math.min(300, Number(body.wait3dsSec) || 240));
  const solve3ds = body.solve3ds !== false;
  const captchaCfg = body.captcha || {};
  const totpSecret = body.totp || body.totpSecret || "";
  const imapCfg = body.imap || {};
  const qty = Math.max(1, Math.min(10, Number(body.quantity) || 1));
  const zip = String(body.zip || body.profile?.zip || "").replace(/\D/g, "").slice(0, 5);

  const fail = (stage, message, extra = {}) => ({
    ok: false,
    stage,
    message,
    tcin,
    ms: Date.now() - t0,
    ...extra,
  });

  if (!tcin || tcin.length < 5) return fail("error", "No TCIN");

  let shape = injectShape({
    sessionId,
    email,
    module: "target-shape",
    proxy: body.proxy,
    requireSameProxy: !!body.proxy,
  });
  if (!shape.ok && !placeOrder) {
    await ensureBank({
      module: "target-shape",
      min: 3,
      proxy: body.proxy,
      taskId: sessionId || `ck-${tcin}`,
    }).catch(() => ({}));
    shape = injectShape({
      sessionId,
      email,
      module: "target-shape",
      proxy: body.proxy,
      requireSameProxy: false,
    });
  }
  if (!shape.ok && !placeOrder) {
    const h = await harvestShapeOnce({
      kind: "atc",
      proxy: body.proxy,
      headed: true,
      module: "target-shape",
      taskId: sessionId || `ck-${tcin}`,
    }).catch(() => ({ ok: false }));
    shape = injectShape({
      sessionId,
      email,
      module: "target-shape",
      proxy: body.proxy,
      requireSameProxy: false,
    });
    shape.harvested = !!h?.ok;
  }

  const jar = loadCookies({ taskId: sessionId, email });
  const cookies = playwrightCookies(jar || { cookies: body.cookies || [] });
  if (!cookies.length) {
    return fail("login_required", "No persisted cookies on this task — Start checkout login first");
  }
  if (!shape.ok) {
    /* still try ATC — login cookies may carry Shape; log via message later */
  }

  // ATC always headed — same Chrome path as harvest (headless=new leaks vs Shape/PX).
  const headed = true;
  let session;
  let keepOpen = false;
  try {
    session = await launchBrowser({ headed, proxy: body.proxy, cookies, taskId: sessionId });
    const { context, page, close } = session;
    const pdp = `https://www.target.com/p/-/A-${tcin}`;
    await page.goto(pdp, { waitUntil: "domcontentloaded", timeout: 25000 });
    await tryHoldPx(page).catch(() => {});
    if (zip) await ensureShippingZip(page, zip).catch(() => {});
    await page
      .locator('[data-test="shipItButton"], [data-test="fulfillment-cell-shipping"], [data-test="addToCartButton"]')
      .first()
      .waitFor({ state: "visible", timeout: placeOrder ? 5000 : 10000 })
      .catch(() => {});

    let html = await page.content().catch(() => "");
    let url = page.url();
    if (looksBlocked(html, url)) {
      const held = await tryHoldPx(page).catch(() => false);
      if (held) {
        html = await page.content().catch(() => "");
        url = page.url();
      }
      if (looksBlocked(html, url)) return fail("blocked", "Blocked on PDP (Shape/PX)");
    }
    if (looksLoggedOut(html, url) && /login/i.test(url)) {
      return fail("login_required", "Login wall — session cookies stale");
    }
    if (looksOosShipping(html)) {
      return fail("oos", "OOS for shipping on PDP");
    }

    await setQty(page, placeOrder ? Math.min(qty, 1) : qty);
    const ship = await selectShippingThenAtc(page);
    if (!ship) {
      await tryHoldPx(page).catch(() => {});
      const ship2 = await selectShippingThenAtc(page);
      if (!ship2) {
        html = await page.content().catch(() => "");
        if (looksOosShipping(html)) return fail("oos", "OOS — no Ship it button");
        if (looksBlocked(html, page.url())) return fail("blocked", "Shape/PX before ATC");
        const diag = await diagnoseAtc(page);
        return fail("atc_failed", `Ship it not found · ${diag.buttons?.map((b) => b.text || b.test).filter(Boolean).slice(0, 6).join(" | ") || "no buttons"}`, diag);
      }
    }

    await Promise.race([
      page.getByText(/added to cart|now in your cart/i).first().waitFor({ timeout: 2500 }).catch(() => {}),
      page.waitForTimeout(placeOrder ? 350 : 900),
    ]);
    html = await page.content().catch(() => "");
    url = page.url();
    if (looksBlocked(html, url)) return fail("blocked", "Blocked after ATC");

    const dumpEarly = await context.cookies();
    persistCookies({
      taskId: sessionId,
      email,
      cookies: dumpEarly,
      proxy: body.proxy || "",
      store: "Target",
    });

    const base = {
      ok: true,
      tcin,
      ms: Date.now() - t0,
      url,
      qty: placeOrder ? Math.min(qty, 1) : qty,
      cookies: dumpEarly.length,
      shipSelector: ship,
    };

    // LIVE: skip /cart (that extra 2–4s is how tiny TCG restocks die after ATC).
    if (placeOrder) {
      await page.goto("https://www.target.com/checkout", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await tryHoldPx(page).catch(() => {});
      html = await page.content().catch(() => "");
      url = page.url();
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (looksLoggedOut(html, url) && /login/i.test(url)) {
        return fail("login_required", "Login wall on checkout — session died after ATC");
      }
      if (looksOosAfterCart(html, bodyText)) {
        return fail("oos_after_cart", "CART OK · Shape passed · OOS at checkout (tiny restock)");
      }
    } else {
      await page.goto("https://www.target.com/cart", { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(400);
      html = await page.content().catch(() => "");
      url = page.url();
      if (looksLoggedOut(html, url) && /login/i.test(url)) {
        return fail("login_required", "Login wall on cart");
      }
      const cartText = await page.locator("body").innerText().catch(() => "");
      const empty = /cart is empty|your cart is empty|0 items/i.test(cartText);
      const hasTcin = cartText.includes(tcin) || html.includes(tcin);
      const hasItem =
        (await page.locator('[data-test="cartItem"], [data-test="cart-item"], [data-test="cartItem-title"]').count()) >
        0;
      if (empty || (!hasItem && !hasTcin)) {
        return fail("atc_failed", "ATC clicked but cart empty");
      }
    }

    if (!placeOrder) {
      keepOpen = true;
      const cartTitle = await page
        .locator('[data-test="cartItem-title"], [data-test="item-title"], a[data-test*="cart"]')
        .first()
        .innerText()
        .catch(() => "");
      return {
        ...base,
        stage: "cart",
        message: `DRY-RUN · CART VISIBLE · ${cartTitle || "A-" + tcin} · Chrome open on /cart`,
        cartTitle,
        keepOpen: true,
      };
    }

    // Already on /checkout from the fast path. Don't reload (loses the hold).
    if (!/checkout/i.test(page.url())) {
      await clickFirst(page, CHECKOUT_SELECTORS, 2000);
      await page.goto("https://www.target.com/checkout", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    }
    await tryHoldPx(page).catch(() => {});
    const chk = `${await page.content().catch(() => "")} ${await page.locator("body").innerText().catch(() => "")}`;
    if (looksOosAfterCart(chk, chk)) {
      return fail("oos_after_cart", "CART OK · Shape passed · OOS at payment (tiny restock)");
    }

    const saved = await useSavedCard(page);
    const filled = saved
      ? { shipping: 0, card: 1, saved: true }
      : await fillTargetPayment(page, body.profile || {});
    if (!saved && !(filled.card > 0)) {
      await page.waitForTimeout(1200);
      const again = await fillTargetPayment(page, body.profile || {});
      filled.card += again.card || 0;
      filled.shipping += again.shipping || 0;
    }
    await page.waitForTimeout(500);
    keepOpen = true;

    const placed = await clickFirst(
      page,
      [
        '[data-test="placeOrderButton"]',
        "button:has-text('Place order')",
        "button:has-text('Place Order')",
        "button:has-text('Submit order')",
        '[data-test="pay-button"]',
      ],
      6000
    );
    if (!placed) {
      return fail("payment_failed", "Place order button not found / disabled", { url: page.url(), filled, saved });
    }

    const after = await waitAfterPlace(page, 14000);
    html = after.html;
    url = after.url;
    const immediate = after.out;
    if (immediate.kind === "ordered") {
      keepOpen = false;
      return {
        ...base,
        stage: "ordered",
        message: immediate.orderNumber ? `Order ${immediate.orderNumber}` : "Order confirmed",
        orderNumber: immediate.orderNumber,
        filled,
        url,
      };
    }
    if (immediate.kind === "declined") {
      keepOpen = false;
      return fail("payment_failed", "Card declined at place order", { url, filled });
    }
    if (immediate.kind === "canceled") {
      keepOpen = false;
      return fail("payment_failed", "Payment canceled", { url, filled });
    }

    const waited = await waitFor3ds(page, wait3dsSec * 1000, solve3ds ? captchaCfg : {}, totpSecret, imapCfg);
    const dump2 = await context.cookies().catch(() => []);
    persistCookies({
      taskId: sessionId,
      email,
      cookies: dump2,
      proxy: body.proxy || "",
      store: "Target",
    });
    if (waited.stage === "ordered") {
      keepOpen = false;
      return {
        ...base,
        stage: "ordered",
        message: waited.orderNumber ? `Order ${waited.orderNumber} · 3DS ok` : "Order confirmed after 3DS",
        orderNumber: waited.orderNumber,
        url: waited.url,
        headed: true,
        filled,
        challenge: waited.challenge,
      };
    }
    if (waited.stage === "payment_failed") {
      keepOpen = false;
      return fail(waited.stage, waited.message, { url: waited.url, headed: true, filled, challenge: waited.challenge });
    }
    keepOpen = true;
    return {
      ...base,
      ok: true,
      stage: "needs_3ds",
      message: waited.message || "Waiting 3DS · Chrome open · bank OTP",
      url: waited.url || url,
      headed: true,
      filled,
      challenge: waited.challenge || "unknown",
      otpVia: waited.otpVia,
    };
  } catch (e) {
    return fail("error", e?.message || String(e));
  } finally {
    if (!keepOpen) await session?.close?.().catch(() => {});
  }
}
