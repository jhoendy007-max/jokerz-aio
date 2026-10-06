/**
 * Walmart shipping/online-only stock. Ignores pickup / store aisle.
 * DRAWING sku → collectibles draw board.
 */
import { fetchText, parseJsonLdProduct, extractImage, normalizeImageUrl } from "./monitor-common.mjs";
import { isDrawingProduct, scanWalmartDrawings } from "./walmart-drawing.mjs";

const SHIP_IN = /IN_STOCK|AVAILABLE|PREORDER|PRE_ORDER|LIMITED/i;
const SHIP_OUT = /OUT_OF_STOCK|NOT_AVAILABLE|UNAVAILABLE|SOLD_OUT/i;

export function parseWalmartId(raw) {
  const s = String(raw || "");
  return (
    (s.match(/\/ip\/(?:[^/]+\/)?(\d{5,})/i) || s.match(/\b(\d{5,12})\b/) || [])[1] || ""
  );
}



function walk(node, acc, depth = 0) {
  if (!node || depth > 10) return;
  if (Array.isArray(node)) {
    node.forEach((x) => walk(x, acc, depth + 1));
    return;
  }
  if (typeof node !== "object") return;
  const st = String(node.availabilityStatus || node.availability_status || "");
  const ft = String(node.fulfillmentType || node.fulfillment_type || node.type || "");
  if (st && /ship|online|delivery|fulfillment/i.test(ft + JSON.stringify(node.fulfillment || "").slice(0, 200))) {
    acc.statuses.push({ st, ft });
  }
  if (st && !ft) acc.statuses.push({ st, ft: "" });
  if (node.offerId && !acc.offerId) acc.offerId = String(node.offerId);
  const price = node.price ?? node.currentPrice?.price ?? node.priceInfo?.currentPrice?.price;
  if (price != null && !acc.price) acc.price = `$${price}`;
  const img = node.imageInfo?.thumbnailUrl || node.imageInfo?.allImages?.[0]?.url;
  if (img && !acc.image) acc.image = normalizeImageUrl(img);
  if ((node.name || node.productName) && !acc.title) acc.title = String(node.name || node.productName).slice(0, 120);
  for (const k of Object.keys(node)) walk(node[k], acc, depth + 1);
}

export function fromHtml(html) {
  const blocked = /px-captcha|perimeterx|_px3|access denied|error 456/i.test(html) && /blocked|press and hold|denied|456/i.test(html);
  const inQueue = /waiting room|high demand|we'll be with you|please wait while we|in line to shop/i.test(html);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  const acc = { statuses: [], offerId: "", price: "", title: "", image: undefined };
  if (m) {
    try {
      walk(JSON.parse(m[1]), acc);
    } catch {
      /* */
    }
  }
  const shipish = acc.statuses.filter(
    (x) => /ship|online|delivery/i.test(x.ft) && !/store|pickup|in.?store/i.test(x.ft)
  );
  const pool = shipish;
  const hit = pool.find((x) => SHIP_IN.test(x.st)) || pool.find((x) => SHIP_OUT.test(x.st)) || pool[0];
  let inStock = false;
  let status = "UNKNOWN";
  if (hit) {
    status = hit.st.toUpperCase();
    inStock = SHIP_IN.test(hit.st);
  } else {
    const add = /add to cart/i.test(html) && !/out of stock/i.test(html);
    const oos = /this item is out of stock|currently unavailable/i.test(html);
    if (add && !oos) {
      inStock = true;
      status = "IN_STOCK";
    } else if (oos) status = "OUT_OF_STOCK";
  }
  const ld = parseJsonLdProduct(html);
  if (status === "UNKNOWN" && ld?.availability) {
    status = ld.inStock ? "IN_STOCK" : ld.outOfStock ? "OUT_OF_STOCK" : status;
    inStock = Boolean(ld.inStock);
  }
  return {
    inStock,
    inQueue,
    availabilityStatus: inQueue ? "QUEUE" : status,
    offerId: acc.offerId,
    price: acc.price || ld?.price || "",
    title: acc.title || ld?.title || "",
    imageUrl: extractImage(html, "https://www.walmart.com/") || acc.image,
    blocked,
    source: m ? "next-data" : "html",
  };
}

export async function checkWalmartShipping({ sku, product, proxy } = {}) {
  if (isDrawingProduct(sku || product)) return scanWalmartDrawings({ proxy });
  const id = parseWalmartId(sku || product);
  const t0 = Date.now();
  if (!id) return { ok: false, inStock: false, error: "No Walmart item id", ms: 0 };
  const url = `https://www.walmart.com/ip/${id}`;
  try {
    const r = await fetchText(url, { proxy, timeoutMs: 12000, headers: { Accept: "text/html,application/xhtml+xml", Referer: "https://www.walmart.com/" } });
    if (r.status === 403 || r.status === 429) {
      return { ok: false, inStock: false, sku: id, blocked: r.status === 403, rateLimited: r.status === 429, retryAfterMs: r.retryAfterMs, proxyIgnored: r.proxyIgnored, error: `HTTP ${r.status}`, ms: Date.now() - t0, via: "http" };
    }
    const p = fromHtml(r.text || "");
    return {
      ok: true,
      ...p,
      sku: id,
      itemId: id,
      ms: Date.now() - t0,
      via: "walmart-monitor",
      finalUrl: r.url,
      proxyIgnored: r.proxyIgnored,
    };
  } catch (e) {
    return { ok: false, inStock: false, sku: id, error: e?.message || String(e), ms: Date.now() - t0 };
  }
}
