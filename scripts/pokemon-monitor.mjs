/**
 * Pokémon Center monitor — stock + Queue-it. Guest region US.
 */
import { fetchText, parseJsonLdProduct, extractImage } from "./monitor-common.mjs";

export function pokemonUrl(raw, region = "US") {
  const s = String(raw || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  const host = String(region).toUpperCase() === "UK" ? "https://www.pokemoncenter.co.uk" : "https://www.pokemoncenter.com";
  if (s.startsWith("/")) return host + s;
  return `${host}/product/${s}`;
}



/** Pure parser — exported for tests. JSON-LD first, page-text regex as fallback. */
export function parsePokemonHtml(html, { status = 200, finalUrl = "" } = {}) {
  const inQueue = /queue-it|queueittoken|please wait while we verify/i.test(html + finalUrl);
  const dd = /captcha-delivery|datadome/i.test(html + finalUrl);
  const ld = parsePokemonLd(html);
  const sold = /sold out|out of stock|currently unavailable/i.test(html);
  const atc = /add to (bag|cart)|pre[- ]?order/i.test(html);
  let inStock;
  if (ld?.availability) inStock = Boolean(ld.inStock);
  else inStock = atc && !sold;
  inStock = inStock && !inQueue && !dd;
  const price = ld?.price || (html.match(/\$[\d,.]+/) || [])[0];
  const title = ld?.title || (html.match(/<title>([^<]+)/i) || [])[1]?.replace(/\s+\|.*/, "").trim();
  const oos = ld?.availability ? Boolean(ld.outOfStock) : sold;
  return {
    inStock,
    inQueue,
    queueProvider: inQueue ? "queue-it" : null,
    blocked: dd || status === 403,
    rateLimited: status === 429,
    price,
    title,
    imageUrl: extractImage(html, "https://www.pokemoncenter.com/"),
    source: ld?.availability ? "json-ld" : "html",
    availabilityStatus: inQueue ? "QUEUE" : dd ? "DATADOME" : status === 429 ? "RATE_LIMITED" : inStock ? "IN_STOCK" : oos ? "OUT_OF_STOCK" : "UNKNOWN",
  };
}
const parsePokemonLd = (h) => parseJsonLdProduct(h);

export async function checkPokemonStock({ url, product, region, proxy } = {}) {
  const href = pokemonUrl(url || product, region);
  const t0 = Date.now();
  try {
    const r = await fetchText(href, { proxy });
    const finalUrl = r.url || href;
    return {
      ok: r.status < 400,
      ...parsePokemonHtml(r.text || "", { status: r.status, finalUrl }),
      retryAfterMs: r.retryAfterMs,
      proxyIgnored: r.proxyIgnored,
      ms: Date.now() - t0,
      via: "pokemon-monitor",
      finalUrl,
      product: href,
    };
  } catch (e) {
    return { ok: false, inStock: false, error: e?.message || String(e), ms: Date.now() - t0, product: href };
  }
}
