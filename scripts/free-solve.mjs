/**
 * Free in-browser solvers (no CapMonster / 2Captcha).
 * Works: PX press&hold, recaptcha checkbox (headed+IP), Turnstile auto.
 * Does NOT solve DataDome hard images / hCaptcha grids.
 */
export async function pressHoldPx(page) {
  const loc = page
    .locator('#px-captcha, [id*="px-captcha"], button:has-text("Press & Hold"), button:has-text("Press and Hold"), button:has-text("Presiona")')
    .first();
  if (!(await loc.count().catch(() => 0))) return false;
  const box = await loc.boundingBox().catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3200 + Math.floor(Math.random() * 900));
  await page.mouse.up();
  await page.waitForTimeout(600);
  return true;
}

async function clickRecaptchaCheckbox(page) {
  for (const frame of page.frames()) {
    const u = frame.url() || "";
    if (!/recaptcha|anchor/i.test(u)) continue;
    try {
      const box = frame.locator("#recaptcha-anchor, .recaptcha-checkbox-border, [role='checkbox']").first();
      if (await box.count()) {
        await box.click({ timeout: 2500, delay: 40 });
        await page.waitForTimeout(1500);
        const checked = await frame
          .locator("[aria-checked='true'], .recaptcha-checkbox-checked")
          .count()
          .catch(() => 0);
        if (checked) return true;
      }
    } catch {
      /* */
    }
  }
  return false;
}

async function waitTurnstile(page, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const token = await page
      .evaluate(() => {
        const el = document.querySelector("[name='cf-turnstile-response'], input[name='cf-turnstile-response']");
        return el && el.value ? el.value : "";
      })
      .catch(() => "");
    if (token && token.length > 20) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

export function looksHardCaptcha(html, url) {
  const t = `${html || ""} ${url || ""}`.toLowerCase();
  return /captcha-delivery|geo\.captcha-delivery|datadome|hcaptcha\.com|hcaptcha|recaptcha\/api2\/bframe|px-captcha|cf-challenge/.test(
    t
  );
}

/** Headed Chrome stays open. You click the captcha. No CapMonster. */
export async function waitForHumanCaptcha(page, { timeoutMs = 180000 } = {}) {
  await solveInBrowser(page, { timeoutMs: 8000 }).catch(() => {});
  let html = await page.content().catch(() => "");
  if (!looksHardCaptcha(html, page.url())) {
    return { ok: true, via: "auto-or-none", needed: false };
  }
  await page.bringToFront().catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await solveInBrowser(page, { timeoutMs: 2500 }).catch(() => {});
    html = await page.content().catch(() => "");
    if (!looksHardCaptcha(html, page.url())) {
      return { ok: true, via: "human", needed: true, waitedMs: Date.now() - t0 };
    }
    await page.waitForTimeout(1200);
  }
  return { ok: false, via: "human-timeout", needed: true, waitedMs: timeoutMs };
}

export async function solveInBrowser(page, { timeoutMs = 12000 } = {}) {
  const t0 = Date.now();
  const did = { px: false, recaptcha: false, turnstile: false };
  did.px = await pressHoldPx(page).catch(() => false);
  did.recaptcha = await clickRecaptchaCheckbox(page).catch(() => false);
  did.turnstile = await waitTurnstile(page, 4000).catch(() => false);
  while (Date.now() - t0 < timeoutMs) {
    if (!did.px) did.px = await pressHoldPx(page).catch(() => false);
    if (!did.recaptcha) did.recaptcha = await clickRecaptchaCheckbox(page).catch(() => false);
    const html = await page.content().catch(() => "");
    if (!/px-captcha|recaptcha|captcha-delivery|cf-turnstile/i.test(html) && (did.px || did.recaptcha || did.turnstile)) {
      return { ok: true, via: "headed-free", ...did };
    }
    await page.waitForTimeout(700);
  }
  const ok = did.px || did.recaptcha || did.turnstile;
  return { ok, skip: !ok, via: "headed-free", ...did };
}
