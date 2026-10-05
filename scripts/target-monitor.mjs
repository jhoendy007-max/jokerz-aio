/**
 * Target shipping-only stock check.
 * Never uses pickup / in-store. RedSky if key is on the PDP, else HTML signals.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tlsClientShuffleOptions } from "./tls-shuffle.mjs";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const KEYS = [
  "9f36aeafbe60771e321a7cc95a78140772ab3e96",
  "ff457966e64d5e877fdbad070f276d18ecec4a01",
  "eb2551e4accc14f38cc42d32fbc2b2ea",
];

const SHIP_IN = new Set([
  "IN_STOCK",
  "LIMITED_STOCK",
  "PRE_ORDER",
  "PREORDER",
  "AVAILABLE",
  "PRE_ORDER_SELLABLE",
]);
const SHIP_OUT = new Set([
  "OUT_OF_STOCK",
  "UNAVAILABLE",
  "NOT_SOLD",
  "SOLD_OUT",
  "NOT_AVAILABLE",
]);

function headers(referer) {
  return {
    "User-Agent": CHROME_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": referer ? "empty" : "document",
    "Sec-Fetch-Mode": referer ? "cors" : "navigate",
    "Sec-Fetch-Site": referer ? "same-site" : "none",
    Referer: referer || "https://www.target.com/",
  };
}

function shippingFromFulfillment(f) {
  if (!f || typeof f !== "object") return null;
  const ship =
    f.shipping_options ||
    f.shipping ||
    f.scheduled_delivery ||
    (f.fulfillment && (f.fulfillment.shipping_options || f.fulfillment.shipping));
  if (!ship) return null;
  const status = String(ship.availability_status || ship.availabilityStatus || "").toUpperCase();
  if (!status) return null;
  const qty =
    ship.available_to_promise_quantity ??
    ship.available_to_promise_quantity_all ??
    ship.quantity ??
    null;
  return {
    status,
    inStock: SHIP_IN.has(status),
    oos: SHIP_OUT.has(status),
    quantity: typeof qty === "number" ? qty : undefined,
  };
}

function walkShipping(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const h = walkShipping(x, depth + 1);
      if (h) return h;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const direct = shippingFromFulfillment(node);
  if (direct && (direct.inStock || direct.oos || direct.status)) return direct;
  if (node.fulfillment) {
    const f = shippingFromFulfillment(node.fulfillment) || shippingFromFulfillment(node);
    if (f) return f;
  }
  for (const k of ["product", "data", "pdp", "item", "product_summary"]) {
    if (node[k]) {
      const h = walkShipping(node[k], depth + 1);
      if (h) return h;
    }
  }
  return null;
}

function priceFrom(obj) {
  const p =
    obj?.price?.current_retail ??
    obj?.price?.formatted_current_price ??
    obj?.price?.reg_retail ??
    obj?.current_retail;
  if (p == null) return undefined;
  if (typeof p === "number") return `$${p.toFixed(2)}`;
  const s = String(p);
  return s.startsWith("$") ? s : `$${s}`;
}

function titleFrom(obj) {
  return (
    obj?.item?.product_description?.title ||
    obj?.product_description?.title ||
    obj?.title ||
    obj?.item?.title ||
    undefined
  );
}

function extractKey(html) {
  if (!html) return null;
  const pats = [
    /redsky\.target\.com\/[^"'?\s<>]+[?&]key=([a-f0-9]{32,40})/i,
    /apiKey["']?\s*[:=]\s*["']([a-f0-9]{32,40})["']/i,
    /["']api_key["']\s*:\s*["']([a-f0-9]{32,40})["']/i,
    /["']key["']\s*:\s*["']([a-f0-9]{32,40})["']/i,
    /key=([a-f0-9]{32,40})/,
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

const KEY_FILE = join(process.cwd(), "server", ".redsky-key.json");
function loadPersistedKey() {
  try {
    const j = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    if (j?.key && /^[a-f0-9]{32,40}$/i.test(j.key)) return j.key;
  } catch {
    /* */
  }
  return null;
}
function saveKey(k) {
  if (!k || !/^[a-f0-9]{32,40}$/i.test(k)) return;
  lastGoodKey = k;
  try {
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, JSON.stringify({ key: k, at: Date.now() }));
  } catch {
    /* */
  }
}

function extractPreload(html) {
  const blobs = [];
  const re =
    /<script[^>]*>(?:window\.)?(?:__TGT_DATA__|__PRELOADED_STATE__|__PRELOADED_QUERIES__)\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      blobs.push(JSON.parse(m[1]));
    } catch {
      /* */
    }
  }
  const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLd) {
    try {
      const inner = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
      blobs.push(JSON.parse(inner));
    } catch {
      /* */
    }
  }
  return blobs;
}

function htmlShippingSignals(html) {
  const low = html.toLowerCase();
  const shipItLive =
    /data-test=["']shipItButton["']/i.test(html) ||
    (/\bship it\b/i.test(html) && !/ship it[\s\S]{0,80}unavailable/i.test(low)) ||
    /data-test=["']shipItButton["'][^>]*>(?![\s\S]{0,40}disabled)/i.test(html);
  const shipBlock =
    html.match(/data-test=["'](?:shipping|fulfillmentShipping|fulfillment-cell-shipping|shipItButton)[^"']*["'][\s\S]{0,800}/i) ||
    html.match(/Shipping[\s\S]{0,400}(?:Sold out|Out of stock|Not available|Ship it|Get it)/i);
  const shipSoldOut =
    /not available for shipping/i.test(html) ||
    /unavailable to ship/i.test(html) ||
    /this item isn't available to ship/i.test(html) ||
    /data-test="[^"]*shipping[^"]*"[\s\S]{0,300}(sold out|out of stock|unavailable)/i.test(html);
  const shipAvail =
    shipItLive ||
    /data-test="[^"]*shipping[^"]*"[\s\S]{0,400}(ship it|ships to|get it by|delivery)/i.test(html);
  const pickupOnly =
    /pickup[\s\S]{0,80}in stock/i.test(low) &&
    !shipAvail &&
    (shipSoldOut || /shipping[\s\S]{0,200}(sold out|out of stock)/i.test(low));
  return { shipSoldOut, shipAvail, pickupOnly, shipItLive };
}

const agentCache = new Map();
let undiciMod = null;

async function loadUndici() {
  if (undiciMod) return undiciMod;
  try {
    undiciMod = await import("undici");
  } catch {
    undiciMod = { fetch: globalThis.fetch, ProxyAgent: null };
  }
  return undiciMod;
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

async function dispatcherFor(raw) {
  const u = proxyUrl(raw);
  if (!u) return undefined;
  const { ProxyAgent } = await loadUndici();
  if (!ProxyAgent) return undefined;
  let a = agentCache.get(u);
  if (!a) {
    a = new ProxyAgent(u);
    agentCache.set(u, a);
  }
  return a;
}

async function fetchText(url, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), extra.timeoutMs || 9000);
  try {
    const { fetch: ufetch } = await loadUndici();
    const r = await (ufetch || fetch)(url, {
      headers: extra.headers || headers(),
      signal: ctrl.signal,
      redirect: "follow",
      ...(extra.dispatcher ? { dispatcher: extra.dispatcher } : {}),
    });
    const text = await r.text();
    return { status: r.status, text, url: r.url };
  } finally {
    clearTimeout(t);
  }
}

let lastGoodKey = loadPersistedKey();

function zip5(z) {
  const d = String(z || "").replace(/\D/g, "").slice(0, 5);
  return d.length === 5 ? d : "";
}

function stateFromZip(z) {
  const n = parseInt(String(z || "").slice(0, 3), 10);
  if (n >= 320 && n <= 349) return "FL";
  return "FL";
}

async function redsky(tcin, key, zip, dispatcher) {
  const visitor = Array.from({ length: 32 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("");
  const endpoints = [
    "pdp_client_v1",
    "pdp_fulfillment_v1",
    "product_summary_with_fulfillment_v1",
  ];
  let last = { error: "no redsky", status: 0 };
  for (const ep of endpoints) {
    const u = new URL(`https://redsky.target.com/redsky_aggregations/v1/web/${ep}`);
    u.searchParams.set("key", key);
    u.searchParams.set("tcin", tcin);
    u.searchParams.set("tcins", tcin);
    u.searchParams.set("is_bot", "false");
    u.searchParams.set("channel", "WEB");
    u.searchParams.set("page", `/p/A-${tcin}`);
    u.searchParams.set("visitor_id", visitor);
    if (zip) {
      u.searchParams.set("zip", zip);
      u.searchParams.set("state", stateFromZip(zip));
    }
    const r = await fetchText(u.toString(), {
      headers: { ...headers("https://www.target.com/"), Accept: "application/json" },
      timeoutMs: 8000,
      dispatcher,
    });
    if (r.status === 403 || r.status === 429) {
      last = { blocked: true, status: r.status, text: r.text, via: ep };
      continue;
    }
    if (r.status === 410 || r.status === 400) {
      last = { error: `RedSky HTTP ${r.status}`, status: r.status, via: ep };
      continue;
    }
    if (r.status >= 400) {
      last = { error: `RedSky HTTP ${r.status}`, status: r.status, via: ep };
      continue;
    }
    try {
      return { json: JSON.parse(r.text), status: r.status, via: ep };
    } catch {
      last = { error: "RedSky bad JSON", status: r.status, via: ep };
    }
  }
  return last;
}

export async function checkTargetShipping({ tcin, zip = "", proxy } = {}) {
  const started = Date.now();
  const id = String(tcin || "").replace(/\D/g, "");
  if (id.length < 8) {
    return { ok: false, inStock: false, error: "Bad TCIN", tcin: id, ms: 0 };
  }
  const zipCode = zip5(zip) || "33703";
  const dispatcher = await dispatcherFor(proxy);

  const pack = (st, extra = {}) => {
    const inSet = SHIP_IN.has(st);
    const outSet = SHIP_OUT.has(st);
    return {
      ok: true,
      inStock: inSet && !outSet,
      unknown: !inSet && !outSet,
      availabilityStatus: st,
      quantity: extra.quantity,
      price: extra.price,
      title: extra.title,
      tcin: id,
      zip: zipCode,
      ms: Date.now() - started,
      channel: "SHIPPING",
      blocked: false,
      ...extra,
    };
  };

  async function probeRedsky(extraKeys = []) {
    let blocked = false;
    let ship = null;
    let title;
    let price;
    const keysTry = [...extraKeys, lastGoodKey, ...KEYS].filter((k, i, a) => k && a.indexOf(k) === i);
    for (const k of keysTry.slice(0, 4)) {
      try {
        const rs = await redsky(id, k, zipCode, dispatcher);
        if (rs.blocked) {
          blocked = true;
          continue;
        }
        if (rs.json) {
          const product = rs.json?.data?.product || rs.json?.product;
          const s = walkShipping(product) || walkShipping(rs.json);
          if (s) ship = s;
          title = title || titleFrom(product);
          price = price || priceFrom(product);
          if (ship) {
            lastGoodKey = k;
            saveKey(k);
            break;
          }
        }
      } catch {
        /* next */
      }
    }
    return { ship, title, price, blocked };
  }

  // Fast path: reuse last good RedSky key — skip PDP (1–3s vs 10–35s)
  if (lastGoodKey) {
    const fast = await probeRedsky([]);
    const st = String(fast.ship?.status || "").toUpperCase();
    if (st && (SHIP_IN.has(st) || SHIP_OUT.has(st))) {
      return pack(st, {
        quantity: fast.ship.quantity,
        price: fast.price,
        title: fast.title,
        via: "redsky-fast",
        tlsShuffle: tlsClientShuffleOptions("chrome_131"),
      });
    }
  }

  const pdpUrl = `https://www.target.com/p/-/A-${id}`;
  let html;
  let htmlStatus = 0;
  try {
    const page = await fetchText(pdpUrl, { timeoutMs: 10000, dispatcher });
    htmlStatus = page.status;
    html = page.text;
    if (page.status === 403 || page.status === 429) {
      return {
        ok: false,
        inStock: false,
        blocked: true,
        rateLimited: page.status === 429,
        retryAfterMs: page.status === 429 ? 45000 + Math.floor(Math.random() * 25000) : 15000,
        error: page.status === 429 ? "RATE LIMIT" : "BAD PROXY / blocked",
        tcin: id,
        ms: Date.now() - started,
        via: "pdp",
      };
    }
  } catch (e) {
    html = null;
    if (/abort/i.test(String(e))) {
      return { ok: false, inStock: false, error: "TIMEOUT", tcin: id, ms: Date.now() - started };
    }
  }

  let key = html ? extractKey(html) : null;
  let title;
  let price;
  let ship = null;

  if (html) {
    for (const blob of extractPreload(html)) {
      ship = ship || walkShipping(blob);
      title = title || titleFrom(blob) || titleFrom(blob?.product) || blob?.name;
      price = price || priceFrom(blob) || priceFrom(blob?.product) || blob?.offers?.price;
      if (typeof price === "number") price = `$${price}`;
      if (price && !String(price).startsWith("$")) price = `$${price}`;
    }
    const h1 = html.match(/<h1[^>]*>([^<]{4,120})<\/h1>/i);
    if (!title && h1) title = h1[1].trim();
    const og = html.match(/property="og:title"[^>]*content="([^"]+)"/i) || html.match(/content="([^"]+)"[^>]*property="og:title"/i);
    if (!title && og) title = og[1].trim();
    const priceM = html.match(/\$\d{1,4}(?:\.\d{2})?/);
    if (!price && priceM) price = priceM[0];
  }

  const keysTry = [key, lastGoodKey, ...KEYS].filter((k, i, a) => k && a.indexOf(k) === i);
  let blocked = false;
  for (const k of keysTry.slice(0, 4)) {
    try {
      const rs = await redsky(id, k, zipCode, dispatcher);
      if (rs.blocked) {
        blocked = true;
        continue;
      }
      if (rs.json) {
        const product = rs.json?.data?.product || rs.json?.product;
        const s = walkShipping(product) || walkShipping(rs.json);
        if (s) ship = s;
        title = title || titleFrom(product);
        price = price || priceFrom(product);
        if (ship) {
          lastGoodKey = k;
          saveKey(k);
          break;
        }
      }
    } catch {
      /* next key */
    }
  }

  if (ship && ship.status) {
    const st = String(ship.status).toUpperCase();
    if (SHIP_IN.has(st) && !SHIP_OUT.has(st)) {
      return {
        ok: true,
        inStock: true,
        availabilityStatus: st,
        quantity: ship.quantity,
        price,
        title,
        tcin: id,
        zip: zipCode,
        ms: Date.now() - started,
        via: "redsky-shipping",
        channel: "SHIPPING",
        blocked: false,
        tlsShuffle: tlsClientShuffleOptions("chrome_131"),
      };
    }
    if (SHIP_OUT.has(st)) {
      return {
        ok: true,
        inStock: false,
        availabilityStatus: st,
        quantity: ship.quantity,
        price,
        title,
        tcin: id,
        zip: zipCode,
        ms: Date.now() - started,
        via: "redsky-shipping",
        channel: "SHIPPING",
        blocked: false,
      };
    }
    return {
      ok: true,
      inStock: false,
      unknown: true,
      availabilityStatus: st || "UNKNOWN",
      quantity: ship.quantity,
      price,
      title,
      tcin: id,
      zip: zipCode,
      ms: Date.now() - started,
      via: "redsky-unknown",
      channel: "SHIPPING",
    };
  }

  if (html) {
    const sig = htmlShippingSignals(html);
    if (sig.shipAvail || sig.shipItLive) {
      return {
        ok: true,
        inStock: true,
        availabilityStatus: "IN_STOCK",
        price,
        title,
        tcin: id,
        zip: zipCode,
        ms: Date.now() - started,
        via: "pdp-ship-it",
        channel: "SHIPPING",
      };
    }
    if (sig.pickupOnly || sig.shipSoldOut) {
      return {
        ok: true,
        inStock: false,
        availabilityStatus: "OUT_OF_STOCK",
        price,
        title,
        tcin: id,
        zip: zipCode,
        ms: Date.now() - started,
        via: "pdp-shipping-html",
        channel: "SHIPPING",
      };
    }
  }

  if (blocked || htmlStatus === 403) {
    return {
      ok: false,
      inStock: false,
      blocked: true,
      error: "BAD PROXY / blocked",
      tcin: id,
      zip: zipCode,
      ms: Date.now() - started,
      via: "block",
    };
  }

  return {
    ok: true,
    inStock: false,
    unknown: true,
    availabilityStatus: "UNKNOWN",
    price,
    title,
    tcin: id,
    zip: zipCode,
    ms: Date.now() - started,
    via: html ? "pdp-unknown-shipping" : "no-page",
    channel: "SHIPPING",
    error: html ? undefined : "Could not load Target PDP",
  };
}
