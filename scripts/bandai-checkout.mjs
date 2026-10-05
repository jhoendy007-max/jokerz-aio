/**
 * Bandai guest checkout — headed. Default dry-run ATC.
 */
import { launchBrowser } from "./headless-browser.mjs";
import { persistCookies, loadCookies, playwrightCookies } from "./cookie-persist.mjs";
import { bandaiUrl } from "./bandai-monitor.mjs";

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

export async function runBandaiCheckout(body = {}) {
  const t0 = Date.now();
  const href = bandaiUrl(body.product || body.url || body.sku);
  const placeOrder = body.placeOrder === true;
  const session = await launchBrowser({
    headed: true,
    proxy: body.proxy,
    taskId: body.sessionId || body.taskId || "bandai",
  });
  try {
    const { page, context } = session;
    const jar = loadCookies({ taskId: body.sessionId || body.taskId, store: "Bandai" });
    if (jar?.cookies?.length) await context.addCookies(playwrightCookies(jar.cookies)).catch(() => {});
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 40000 });
    const atc = await clickFirst(page, [
      'button:has-text("Add to Cart")',
      'button:has-text("Add to Bag")',
      'button:has-text("Pre-Order")',
      'button:has-text("Buy")',
      "button.btn-cart",
    ]);
    if (!atc) {
      const html = await page.content();
      return {
        ok: false,
        stage: /sold out|lottery/i.test(html) ? "oos" : "atc_failed",
        message: "ATC not found — selectors need a live item",
        ms: Date.now() - t0,
      };
    }
    persistCookies({
      taskId: body.sessionId || body.taskId,
      cookies: await context.cookies(),
      proxy: body.proxy,
      store: "Bandai",
    });
    if (!placeOrder) {
      return { ok: true, stage: "cart", message: "Dry-run · ATC · Place order OFF", ms: Date.now() - t0, finalUrl: page.url() };
    }
    await clickFirst(page, ['a:has-text("Checkout")', 'button:has-text("Checkout")']);
    return { ok: true, stage: "checkout", message: "Checkout gate", ms: Date.now() - t0, finalUrl: page.url() };
  } catch (e) {
    return { ok: false, stage: "error", message: e?.message || String(e), ms: Date.now() - t0 };
  } finally {
    if (!placeOrder) await session.close?.().catch(() => {});
  }
}
