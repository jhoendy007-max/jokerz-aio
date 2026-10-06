/**
 * One-off product check for "Check product" (task form) and "Test monitor".
 * Runs the same monitor the tasks use, exactly once, and returns:
 *   { ok, store, product, state, reason, title, price, imageUrl, inStock, ms, raw }
 * `raw` is the monitor's own response (trimmed) so you can see why stock is or isn't detected.
 */
import { checkTargetShipping } from "./target-monitor.mjs";
import { checkWalmartShipping, parseWalmartId } from "./walmart-monitor.mjs";
import { checkPokemonStock } from "./pokemon-monitor.mjs";
import { checkBandaiStock } from "./bandai-monitor.mjs";
import { withMonitorState } from "./monitor-status.mjs";
import { lookupProductImage } from "./product-image.mjs";
import { storeKey } from "./manual-login.mjs";

/** Validates the product id format before hitting the store. */
export function validateProductInput(store, product) {
  const p = String(product || "").trim();
  const k = storeKey(store);
  if (!k) return { ok: false, reason: "Pick a store (Target, Walmart, Pokemon Center, Bandai)" };
  if (!p) return { ok: false, reason: "Enter a SKU / TCIN / product URL" };
  if (k === "target") {
    const tcin = (p.match(/A-(\d{6,})/) || [])[1] || (/^\d{6,10}$/.test(p) ? p : "");
    return tcin ? { ok: true, id: tcin } : { ok: false, reason: "Target needs a TCIN (8 digits) or a target.com/p/…/A-12345678 URL" };
  }
  if (k === "walmart") {
    if (/^drawing$/i.test(p)) return { ok: true, id: "DRAWING" };
    const id = parseWalmartId(p);
    return id ? { ok: true, id } : { ok: false, reason: "Walmart needs an item id or a walmart.com/ip/… URL" };
  }
  if (k === "pokemon") {
    if (/^https?:\/\//i.test(p) && !/pokemoncenter\.com/i.test(p)) return { ok: false, reason: "That URL is not pokemoncenter.com" };
    return { ok: true, id: p };
  }
  if (/^https?:\/\//i.test(p) && !/bandai/i.test(p)) return { ok: false, reason: "That URL is not a Bandai store URL" };
  return { ok: true, id: p };
}

function trimRaw(r) {
  const out = {};
  for (const [k, v] of Object.entries(r || {})) {
    if (typeof v === "string") out[k] = v.length > 400 ? v.slice(0, 400) + "…" : v;
    else if (v && typeof v === "object") {
      const s = JSON.stringify(v);
      out[k] = s.length > 600 ? s.slice(0, 600) + "…" : v;
    } else out[k] = v;
  }
  return out;
}

export async function probeProduct({ store, product, proxy, zip } = {}, deps = {}) {
  const v = validateProductInput(store, product);
  const k = storeKey(store);
  const name = { target: "Target", walmart: "Walmart", pokemon: "Pokemon Center", bandai: "Bandai" }[k] || String(store || "");
  if (!v.ok) return { ok: false, store: name, product, state: "NOT_FOUND", reason: v.reason };
  const run = deps.run || {
    target: () => checkTargetShipping({ tcin: v.id, zip, proxy }),
    walmart: () => checkWalmartShipping({ sku: v.id, proxy }),
    pokemon: () => checkPokemonStock({ product: v.id, proxy }),
    bandai: () => checkBandaiStock({ product: v.id, proxy }),
  }[k];
  const t0 = Date.now();
  let raw;
  try {
    raw = await run();
  } catch (e) {
    raw = { ok: false, inStock: false, error: e?.message || String(e) };
  }
  const r = withMonitorState(name, raw);
  let imageUrl = r.imageUrl;
  if (!imageUrl && r.state !== "NOT_FOUND" && !deps.noImage) {
    imageUrl = (await lookupProductImage({ store: name, product: v.id }).catch(() => null))?.imageUrl;
  }
  return {
    ok: !["ERROR", "NOT_FOUND"].includes(r.state),
    store: name,
    product: v.id,
    state: r.state,
    reason: r.reason,
    title: r.title || undefined,
    price: r.price || undefined,
    imageUrl,
    inStock: Boolean(r.inStock),
    ms: r.ms ?? Date.now() - t0,
    raw: trimRaw(raw),
  };
}
