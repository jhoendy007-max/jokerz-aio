/**
 * Walmart Collectibles Drawing — lottery board, not a restock.
 * Board: https://www.walmart.com/shop/collectibles/draw
 * Need account + saved address/card. 1 entry per item.
 */
import { launchBrowser } from "./headless-browser.mjs";
import { persistCookies, loadCookies, playwrightCookies } from "./cookie-persist.mjs";
import { waitForHumanCaptcha } from "./free-solve.mjs";

export const DRAW_URL = "https://www.walmart.com/shop/collectibles/draw";

function proxyUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p || p === "direct") return null;
  if (/^https?:\/\//i.test(p)) return p;
  if (p.includes("@")) return `http://${p}`;
  const parts = p.split(":");
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}`;
  }
  return null;
}

export function isDrawingProduct(raw) {
  const s = String(raw || "").trim();
  return /draw|lottery|collectibles\/draw/i.test(s);
}

export async function scanWalmartDrawings({ proxy } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 14000);
  let dispatcher;
  const u = proxyUrl(proxy);
  try {
    if (u) {
      const { ProxyAgent } = await import("undici");
      dispatcher = new ProxyAgent(u);
    }
    const { fetch: uf } = await import("undici").catch(() => ({ fetch: globalThis.fetch }));
    const r = await (uf || fetch)(DRAW_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
      redirect: "follow",
      ...(dispatcher ? { dispatcher } : {}),
    });
    const html = await r.text();
    const live = /enter drawing|drawing open|entries? (are )?open|submit your entry/i.test(html);
    const closed = /drawing closed|entry period (has )?ended|no (current|open) drawing/i.test(html);
    const titles = [...html.matchAll(/pokemon[^<]{0,80}/gi)].slice(0, 6).map((m) => m[0].replace(/\s+/g, " ").slice(0, 80));
    return {
      ok: true,
      inStock: live,
      inQueue: false,
      drawing: true,
      drawingLive: live,
      drawingClosed: closed && !live,
      title: titles[0] || (live ? "Collectibles Drawing LIVE" : "Drawing board"),
      availabilityStatus: live ? "DRAWING_LIVE" : closed ? "DRAWING_CLOSED" : "DRAWING_IDLE",
      ms: Date.now() - t0,
      via: "walmart-drawing",
      finalUrl: DRAW_URL,
      titles,
    };
  } catch (e) {
    return { ok: false, inStock: false, drawing: true, error: e?.message || String(e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

export async function runWalmartDrawing(body = {}) {
  const t0 = Date.now();
  let keepChrome = true;
  const session = await launchBrowser({
    headed: true,
    proxy: body.proxy,
    taskId: body.sessionId || body.taskId || "wm-draw",
  });
  try {
    const { page, context } = session;
    const jar = loadCookies({ taskId: body.sessionId || body.taskId, email: body.accountEmail, store: "Walmart" });
    if (jar?.cookies?.length) await context.addCookies(playwrightCookies(jar.cookies)).catch(() => {});
    await page.goto(DRAW_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await waitForHumanCaptcha(page, { timeoutMs: 120000 }).catch(() => {});
    const html = await page.content().catch(() => "");
    if (/sign in|account\/login/i.test(page.url() + html) && !/enter drawing/i.test(html)) {
      return { ok: false, stage: "login_required", message: "Drawing needs Walmart login first", ms: Date.now() - t0 };
    }
    const btns = page.locator('button:has-text("Enter Drawing"), a:has-text("Enter Drawing"), button:has-text("Enter drawing")');
    const n = await btns.count().catch(() => 0);
    if (!n) {
      const live = /enter drawing|entries? open/i.test(html);
      return {
        ok: false,
        stage: live ? "atc_failed" : "idle",
        message: live ? "Enter Drawing button not found" : "No live drawing on board",
        ms: Date.now() - t0,
        finalUrl: page.url(),
      };
    }
    const want = String(body.product || body.sku || "").replace(/drawing|draw|lottery/gi, "").trim();
    let clicked = 0;
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      const card = b.locator("xpath=ancestor::*[self::article or self::div][1]");
      const txt = ((await card.innerText().catch(() => "")) + " " + (await b.innerText().catch(() => ""))).toLowerCase();
      if (want && want.length > 4 && !txt.includes(want.toLowerCase()) && !/pokemon|tcg/.test(txt)) continue;
      await b.click({ timeout: 4000, delay: 40 }).catch(() => {});
      clicked++;
      await page.waitForTimeout(800);
      await page
        .locator('button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Enter")')
        .first()
        .click({ timeout: 2500 })
        .catch(() => {});
      await page.waitForTimeout(600);
    }
    persistCookies({
      taskId: body.sessionId || body.taskId,
      email: body.accountEmail,
      cookies: await context.cookies(),
      proxy: body.proxy,
      store: "Walmart",
    });
    const after = await page.content().catch(() => "");
    const entered = /you.?re entered|entry (received|submitted|confirmed)|thanks for entering/i.test(after);
    if (entered) keepChrome = false;
    return {
      ok: entered || clicked > 0,
      stage: entered ? "ordered" : clicked ? "checkout" : "idle",
      message: entered
        ? `Drawing entered · ${clicked} click(s) · Walmart picks later (no charge if lose)`
        : clicked
          ? `Clicked Enter Drawing ×${clicked} · confirm in Chrome`
          : "No matching drawing",
      clicks: clicked,
      keepOpen: !entered,
      ms: Date.now() - t0,
      finalUrl: page.url(),
    };
  } catch (e) {
    return { ok: false, stage: "error", message: e?.message || String(e), ms: Date.now() - t0 };
  } finally {
    if (!keepChrome) await session.close?.().catch(() => {});
  }
}
