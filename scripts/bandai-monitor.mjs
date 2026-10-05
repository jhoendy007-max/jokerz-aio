/**
 * Premium Bandai US — shipping product stock from PDP HTML.
 */
import { fetchText, parseJsonLdProduct } from "./monitor-common.mjs";

export function bandaiUrl(raw) {
  const s = String(raw || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return "https://p-bandai.com" + s;
  return `https://p-bandai.com/us/item/${s}`;
}



/** Pure parser — exported for tests. JSON-LD first, page-text regex as fallback. */
export function parseBandaiHtml(html, { status = 200 } = {}) {
  const ld = parseJsonLdProduct(html);
  const sold = /sold out|out of stock|currently unavailable|lottery closed/i.test(html);
  const atc = /add to (cart|bag)|pre[- ]?order|buy now/i.test(html);
  const blocked = status === 403 || /captcha|access denied/i.test(html);
  let inStock = ld?.availability ? Boolean(ld.inStock) : atc && !sold;
  inStock = inStock && !blocked;
  const oos = ld?.availability ? Boolean(ld.outOfStock) : sold;
  return {
    inStock,
    blocked,
    rateLimited: status === 429,
    price: ld?.price || (html.match(/(?:USD|\$)\s*[\d,.]+/) || [])[0],
    title: ld?.title || (html.match(/<title>([^<]+)/i) || [])[1]?.replace(/\s+\|.*/, "").trim(),
    source: ld?.availability ? "json-ld" : "html",
    availabilityStatus: blocked ? "BLOCKED" : status === 429 ? "RATE_LIMITED" : inStock ? "IN_STOCK" : oos ? "OUT_OF_STOCK" : "UNKNOWN",
  };
}

export async function checkBandaiStock({ url, product, sku, proxy } = {}) {
  const href = bandaiUrl(url || product || sku);
  const t0 = Date.now();
  try {
    const r = await fetchText(href, { proxy, headers: { Referer: "https://p-bandai.com/us" } });
    return {
      ok: r.status < 400,
      ...parseBandaiHtml(r.text || "", { status: r.status }),
      retryAfterMs: r.retryAfterMs,
      proxyIgnored: r.proxyIgnored,
      ms: Date.now() - t0,
      via: "bandai-monitor",
      finalUrl: r.url,
      product: href,
    };
  } catch (e) {
    return { ok: false, inStock: false, error: e?.message || String(e), ms: Date.now() - t0, product: href };
  }
}
