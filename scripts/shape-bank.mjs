/**
 * Shape cookie bank — Shikari-style.
 * Only bank a LIVE set: _abck ~-1 + bm_sz from the SAME harvest + same ISP.
 * Dead ~0 cookies are discarded. Inject merges Shape sensors only (login tokens stay).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchBrowser } from "./headless-browser.mjs";
import { mergeCookies } from "./cookie-persist.mjs";
import { storeKey, harvestPdp, harvestLogin, harvestHome, persistStoreName } from "./store-modules.mjs";
import { waitForHumanCaptcha } from "./free-solve.mjs";

const ROOT = process.env.JOKERZ_DATA || join(process.cwd(), "server");
const FILE = process.env.JOKERZ_SHAPE_BANK || join(ROOT, ".shape-bank.json");

const ATC_TCINS = ["14753310", "12953964", "76130492", "54362597", "81827799", "13329207", "76130312"];
const SHAPE_RE = /_abck|bm_sz|bm_sv|bm_so|bm_mi|ak_bmsc|akavpau|akaalb|bm_ss|abck/i;
const PX_RE = /^_px3$|^_pxhd$|^_pxvid$|^_pxde$|^pxcts$|^_px$|^_pxff$/i;
const SENSOR_RE = /_abck|bm_sz|bm_sv|bm_so|bm_mi|ak_bmsc|akavpau|akaalb|bm_ss|abck|^_px|^pxcts$/i;
const MAX_USES = 2;

const SHIP_FULFILLMENT = [
  '[data-test="fulfillment-cell-shipping"]',
  'button[data-test="fulfillment-cell-shipping"]',
  '[data-test="shippingButton"]',
  'button:has-text("Shipping")',
];
const SHIP = [
  '[data-test="shipItButton"]',
  'button[data-test="shipItButton"]',
  '[data-test*="shipIt" i]',
  'button:has-text("Ship it")',
  'button:has-text("Ship It")',
  'button:has-text("Preorder it")',
  'button:has-text("Pre-order it")',
  'button:has-text("Deliver it")',
];

function empty() {
  return { v: 2, slots: [], targetSize: 20, ttlMinutes: 15 };
}

let cache = null;
function load() {
  if (cache) return cache;
  try {
    if (existsSync(FILE)) {
      cache = { ...empty(), ...JSON.parse(readFileSync(FILE, "utf8") || "{}") };
      cache.slots = Array.isArray(cache.slots) ? cache.slots : [];
      return cache;
    }
  } catch {
    /* */
  }
  cache = empty();
  return cache;
}

function save() {
  const s = load();
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, FILE);
}

function ttlMs() {
  return Math.max(5, Number(load().ttlMinutes) || 15) * 60 * 1000;
}

export function gradeAbck(cookies) {
  const list = cookies || [];
  const abck = list.find((c) => String(c.name).toLowerCase() === "_abck");
  const bmSz = list.find((c) => String(c.name).toLowerCase() === "bm_sz");
  if (!abck?.value) return { valid: false, flag: null, reason: "no _abck" };
  let v = String(abck.value);
  try {
    v = decodeURIComponent(v);
  } catch {
    /* */
  }
  const flag = /~(-1|0|1)(?:~|$)/.exec(v)?.[1] ?? null;
  if (flag === "0") return { valid: false, flag: "0", reason: "dead ~0" };
  if (flag === "-1" || flag === "1") {
    if (!bmSz?.value) return { valid: false, flag, reason: "no bm_sz" };
    return { valid: true, flag, reason: "live" };
  }
  return { valid: false, flag, reason: "unknown flag" };
}

export function gradePx(cookies) {
  const list = cookies || [];
  const px3 = list.find((c) => String(c.name).toLowerCase() === "_px3");
  const pxvid = list.find((c) => String(c.name).toLowerCase() === "_pxvid");
  const pxhd = list.find((c) => String(c.name).toLowerCase() === "_pxhd");
  if (!px3?.value || String(px3.value).length < 24) {
    return { valid: false, reason: "no _px3", hasVid: !!pxvid, hasHd: !!pxhd };
  }
  return { valid: true, reason: "live", hasVid: !!pxvid, hasHd: !!pxhd };
}

function shapeOnly(cookies) {
  return (cookies || []).filter((c) => SENSOR_RE.test(c.name || "") || PX_RE.test(c.name || ""));
}

function proxyKey(line) {
  if (!line) return "";
  let s = String(line).trim().replace(/^https?:\/\//i, "");
  if (s.includes("@")) s = s.split("@").pop();
  const [host, port] = s.split(":");
  return host && port ? `${host}:${port}` : s;
}

function cookiesForStore(store, cookies) {
  const list = cookies || [];
  if (store === "target") return shapeOnly(list);
  return list.filter((c) => {
    const d = String(c.domain || "");
    const n = String(c.name || "");
    if (store === "walmart") return /walmart/i.test(d) || PX_RE.test(n);
    if (store === "pokemon") return /pokemon/i.test(d) || /datadome/i.test(n);
    if (store === "bandai") return /bandai/i.test(d);
    return true;
  });
}

function harvestOk(store, grade, px, cookies) {
  if (store === "walmart") return !!px?.valid;
  if (store === "pokemon" || store === "bandai") return (cookies || []).length >= 3;
  return !!(grade?.valid || px?.valid);
}

function alive(slot, now = Date.now()) {
  if (!slot?.cookies?.length) return false;
  const store = slot.store || storeKey(slot.module);
  if (store === "target" && !slot.abckValid && !slot.pxValid) return false;
  if (store === "walmart" && !slot.pxValid) return false;
  if (slot.expiresAt && slot.expiresAt < now) return false;
  if ((slot.useCount || 0) >= MAX_USES) return false;
  return now - (slot.at || 0) < ttlMs();
}

function prune() {
  const s = load();
  const now = Date.now();
  s.slots = s.slots.filter((x) => alive(x, now));
  save();
  return s;
}

export function configureBank({ targetSize, ttlMinutes } = {}) {
  const s = load();
  if (targetSize) s.targetSize = Number(targetSize) || s.targetSize;
  if (ttlMinutes) s.ttlMinutes = Number(ttlMinutes) || s.ttlMinutes;
  save();
  return publicShapeBank();
}

export function publicShapeBank() {
  prune();
  const s = load();
  const atc = s.slots.filter((x) => x.kind !== "login").length;
  const login = s.slots.filter((x) => x.kind === "login").length;
  const valid = s.slots.filter((x) => x.abckValid || x.pxValid).length;
  const px = s.slots.filter((x) => x.pxValid).length;
  const shape = s.slots.filter((x) => x.abckValid).length;
  return {
    count: s.slots.length,
    valid,
    px,
    shape,
    deadDiscarded: s.deadDiscarded || 0,
    targetSize: s.targetSize,
    ttlMinutes: s.ttlMinutes,
    file: FILE,
    mode: "per-store",
    byStore: {
      target: s.slots.filter((x) => (x.store || storeKey(x.module)) === "target").length,
      walmart: s.slots.filter((x) => (x.store || storeKey(x.module)) === "walmart").length,
      pokemon: s.slots.filter((x) => (x.store || storeKey(x.module)) === "pokemon").length,
      bandai: s.slots.filter((x) => (x.store || storeKey(x.module)) === "bandai").length,
    },
    separation: { targetShapeAtc: atc, targetShapeLogin: login, targetPx: px },
  };
}

export function resetShapeBank() {
  cache = empty();
  save();
  return publicShapeBank();
}

function shapeCookieCount(cookies) {
  return shapeOnly(cookies).length;
}

function putSlot({ kind, cookies, proxy, module, grade, px }) {
  const store = storeKey(module);
  const s = load();
  const now = Date.now();
  const kept = cookiesForStore(store, cookies);
  const slot = {
    id: `sh-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: kind === "login" ? "login" : "atc",
    module: module || `${store}-shape`,
    store,
    proxy: proxy || "",
    proxyKey: proxyKey(proxy),
    cookies: kept.length ? kept : shapeOnly(cookies),
    shapeCount: kept.length,
    abckValid: !!grade?.valid,
    abckFlag: grade?.flag || null,
    pxValid: !!px?.valid,
    pxReason: px?.reason || null,
    at: now,
    expiresAt: now + ttlMs(),
    usedAt: 0,
    useCount: 0,
  };
  s.slots.push(slot);
  while (s.slots.length > (s.targetSize || 20)) s.slots.shift();
  save();
  return slot;
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
          await loc.click({ timeout: 2500, delay: 40 });
          return sel;
        }
      }
    } catch {
      /* */
    }
  }
  return null;
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
  await page.waitForTimeout(3200 + Math.floor(Math.random() * 900));
  await page.mouse.up();
  return true;
}

async function warmSensor(page, context, maxMs = 10000) {
  const t0 = Date.now();
  let last = { cookies: [], q: gradeAbck([]), px: gradePx([]) };
  let held = false;
  while (Date.now() - t0 < maxMs) {
    if (!held) held = await tryHoldPx(page).catch(() => false);
    await page.mouse.move(80 + Math.random() * 700, 120 + Math.random() * 400).catch(() => {});
    await page.mouse.wheel(0, 180 + Math.floor(Math.random() * 240)).catch(() => {});
    await page.waitForTimeout(450);
    const cookies = await context.cookies();
    const q = gradeAbck(cookies);
    const px = gradePx(cookies);
    last = { cookies, q, px };
    if (q.valid && px.valid) return last;
    if (q.valid && Date.now() - t0 > 6000) return last;
    if (px.valid && Date.now() - t0 > 7000 && q.flag === "0") return last;
  }
  return last;
}

async function seedHome(page, store = "target", short = false) {
  await page.goto(harvestHome(store), { waitUntil: "domcontentloaded", timeout: 30000 });
  const hold = short ? 1800 + Math.floor(Math.random() * 900) : 5000 + Math.floor(Math.random() * 3000);
  try {
    await page.mouse.move(140 + Math.random() * 220, 160 + Math.random() * 90, { steps: 10 });
    await page.waitForTimeout(350 + Math.floor(Math.random() * 250));
    await page.mouse.wheel(0, 380 + Math.floor(Math.random() * 420));
    await page.waitForTimeout(Math.min(hold, short ? 1200 : 2800));
    await page.mouse.move(420 + Math.random() * 280, 280 + Math.random() * 140, { steps: 8 });
    await page.locator('a[href*="/c/"], nav a, [data-test="nav"]').first().hover({ timeout: 1200 }).catch(() => {});
    await page.mouse.wheel(0, 180 + Math.floor(Math.random() * 220));
    await page.waitForTimeout(Math.max(400, hold - (short ? 1200 : 2800)));
  } catch {
    await page.waitForTimeout(hold);
  }
}

const harvestSessions = new Map();

function harvestKey(opts) {
  const store = storeKey(opts.module);
  return `${opts.taskId || "h"}|${store}|${opts.kind || "atc"}|${proxyKey(opts.proxy)}`;
}

async function dropHarvestSession(key) {
  const rec = harvestSessions.get(key);
  if (!rec) return;
  harvestSessions.delete(key);
  await rec.session.close().catch(() => {});
}

export async function closeHarvestSessionsFor(id) {
  const needle = String(id || "");
  for (const key of [...harvestSessions.keys()]) {
    if (key.includes(needle) || key.startsWith(`${needle}|`) || key.includes(`|${needle}|`)) {
      await dropHarvestSession(key);
    }
  }
}

export async function closeAllHarvestSessions() {
  await Promise.all([...harvestSessions.keys()].map((k) => dropHarvestSession(k)));
}

async function getHarvestSession(opts) {
  const key = harvestKey(opts);
  let rec = harvestSessions.get(key);
  if (rec?.session) {
    try {
      if (rec.session.page && !rec.session.page.isClosed?.()) return rec;
    } catch {
      /* dead */
    }
    await dropHarvestSession(key);
  }
  const session = await launchBrowser({
    headed: opts.headed !== false,
    proxy: opts.proxy,
    taskId: opts.taskId || `harvest-${storeKey(opts.module)}-${opts.kind || "atc"}`,
  });
  rec = { session, seeded: false, uses: 0, key };
  harvestSessions.set(key, rec);
  return rec;
}

export async function harvestShapeOnce({ kind = "atc", proxy, headed = true, module = "target-shape", taskId } = {}) {
  const store = storeKey(module);
  const rec = await getHarvestSession({ kind, proxy, headed, taskId, module });
  const key = rec.key;
  try {
    const { page, context } = rec.session;
    if (!rec.seeded) {
      await seedHome(page, store, false);
      rec.seeded = true;
    } else {
      await context.clearCookies().catch(() => {});
      await seedHome(page, store, true);
    }
    if (kind === "login") {
      await page.goto(harvestLogin(store), { waitUntil: "domcontentloaded", timeout: 35000 });
      await page.waitForTimeout(900);
      const email = `harvest${Math.floor(100000 + Math.random() * 900000)}@gmail.com`;
      const box = page.locator('input[type="email"], input[name="username"], input[name="email"]').first();
      if (await box.count()) {
        await box.fill(email).catch(() => {});
        await page.waitForTimeout(400);
        await page
          .locator('button:has-text("Continue"), button:has-text("Sign in"), button[type="submit"]')
          .first()
          .click({ timeout: 2500 })
          .catch(() => {});
      }
    } else if (store === "target") {
      await page.goto(harvestPdp("target"), { waitUntil: "domcontentloaded", timeout: 35000 });
      await page.waitForTimeout(500);
      await clickFirst(page, SHIP_FULFILLMENT);
      await page.waitForTimeout(220);
      await clickFirst(page, SHIP);
    } else if (store === "walmart") {
      await page.goto(harvestPdp("walmart"), { waitUntil: "domcontentloaded", timeout: 35000 });
      await page.waitForTimeout(700);
      await clickFirst(page, [
        '[data-testid="add-to-cart-button"]',
        'button[data-testid="add-to-cart"]',
        'button:has-text("Add to cart")',
        'button:has-text("Add to Cart")',
      ]);
    } else {
      await page.goto(harvestPdp(store), { waitUntil: "domcontentloaded", timeout: 35000 });
      await page.waitForTimeout(1200);
    }
    const human = await waitForHumanCaptcha(page, { timeoutMs: 180000 }).catch(() => ({ ok: true, needed: false }));
    if (human?.needed && !human.ok) {
      await dropHarvestSession(key);
      return { ok: false, error: "Captcha · solve it in Chrome (3 min) or harvest dies", store };
    }
    const warmMs = rec.uses === 0 ? 8000 : 5000;
    const warmed = await warmSensor(page, context, warmMs);
    const cookies = warmed.cookies.length ? warmed.cookies : await context.cookies();
    const grade = warmed.q?.valid ? warmed.q : gradeAbck(cookies);
    const px = warmed.px?.valid ? warmed.px : gradePx(cookies);
    const kept = cookiesForStore(store, cookies);
    if (!harvestOk(store, grade, px, kept.length ? kept : cookies)) {
      const s = load();
      s.deadDiscarded = (s.deadDiscarded || 0) + 1;
      save();
      await dropHarvestSession(key);
      return {
        ok: false,
        error: `${store} harvest dead · shape ${grade.reason} · px ${px.reason} · not banked`,
        store,
        grade,
        px,
        cookies: cookies.length,
      };
    }
    const slot = putSlot({ kind, cookies, proxy, module: module || `${store}-${kind}`, grade, px });
    rec.uses += 1;
    if (rec.uses >= 6) await dropHarvestSession(key);
    return {
      ok: true,
      slotId: slot.id,
      cookies: slot.cookies.length,
      shapeCount: slot.shapeCount,
      kind,
      store,
      abckFlag: grade.flag,
      pxValid: !!px.valid,
      reused: rec.uses > 1,
      grade: grade.valid && px.valid ? "shape+px" : grade.valid ? "shape" : px.valid ? "px" : store,
    };
  } catch (e) {
    await dropHarvestSession(key);
    return { ok: false, error: e?.message || String(e) };
  }
}

export function pickSlot({ module, kind, minGapMs = 2500, proxy, requireSameProxy = true } = {}) {
  prune();
  const s = load();
  const now = Date.now();
  const want = kind === "login" ? "login" : "atc";
  const wantStore = storeKey(module);
  const wantKey = proxyKey(proxy);
  const list = s.slots.filter((x) => {
    if (!alive(x, now)) return false;
    if ((x.store || storeKey(x.module)) !== wantStore) return false;
    if (!x.abckValid && !x.pxValid && wantStore === "target") return false;
    if (kind && x.kind !== want && !(want === "atc" && x.kind !== "login")) return false;
    if (x.usedAt && now - x.usedAt < minGapMs) return false;
    return true;
  });
  list.sort((a, b) => {
    const ap = wantKey && a.proxyKey === wantKey ? 1 : 0;
    const bp = wantKey && b.proxyKey === wantKey ? 1 : 0;
    if (bp !== ap) return bp - ap;
    return (b.at || 0) - (a.at || 0);
  });
  if (requireSameProxy && wantKey) {
    const same = list.filter((x) => x.proxyKey === wantKey);
    return same[0] || null;
  }
  if (requireSameProxy && !wantKey) {
    const local = list.filter((x) => !x.proxyKey);
    return local[0] || null;
  }
  return list[0] || null;
}

export function injectShape({
  sessionId,
  email,
  module = "target-shape",
  consume = false,
  cooldownMs = 8000,
  proxy,
  requireSameProxy = true,
} = {}) {
  const store = storeKey(module);
  const kind = String(module).toLowerCase().includes("login") ? "login" : "atc";
  const slot = pickSlot({ module, kind, minGapMs: cooldownMs, proxy, requireSameProxy });
  if (!slot) {
    const why = proxy
      ? `no same-ISP ${store} cookie (harvest that store+IP)`
      : `bank empty for ${store}`;
    return { ok: false, injected: 0, sameProxy: false, store, error: why, bank: publicShapeBank() };
  }
  const merged = mergeCookies({
    taskId: sessionId,
    email,
    cookies: slot.cookies?.length ? slot.cookies : shapeOnly(slot.cookies),
    proxy: proxy || slot.proxy || "",
    store: persistStoreName(store),
  });
  slot.usedAt = Date.now();
  slot.useCount = (slot.useCount || 0) + 1;
  const burn = consume || slot.useCount >= MAX_USES;
  if (burn) {
    const s = load();
    s.slots = s.slots.filter((x) => x.id !== slot.id);
    save();
  } else {
    save();
  }
  return {
    ok: true,
    injected: merged.added || slot.shapeCount || slot.cookies.length,
    total: merged.total,
    module,
    bankId: slot.id,
    useCount: slot.useCount,
    kind: slot.kind,
    abckFlag: slot.abckFlag,
    pxValid: !!slot.pxValid,
    sameProxy: !!(proxy && proxyKey(proxy) === slot.proxyKey),
    bank: publicShapeBank(),
  };
}

let harvestActive = 0;
const harvestWaiters = [];
const HARVEST_CONCURRENCY = 3;

export async function ensureBank({ module = "target-shape", min = 3, proxy, taskId, kind = "atc" } = {}) {
  const store = storeKey(module);
  const minN = Math.max(2, Number(min) || 3);
  const count = () => publicShapeBank().byStore?.[store] || 0;
  let harvested = 0;
  while (count() < minN && harvested < 4) {
    harvested += 1;
    await harvestShapeOnce({ kind, proxy, headed: true, module, taskId }).catch(() => {});
  }
  const n = count();
  return { ok: n >= 1, count: n, harvested, store, min: minN };
}

export function enqueueHarvest(opts) {
  return new Promise((resolve, reject) => {
    const start = () => {
      harvestActive += 1;
      harvestShapeOnce(opts)
        .then(resolve, reject)
        .finally(() => {
          harvestActive -= 1;
          const next = harvestWaiters.shift();
          if (next) next();
        });
    };
    if (harvestActive < HARVEST_CONCURRENCY) start();
    else harvestWaiters.push(start);
  });
}
