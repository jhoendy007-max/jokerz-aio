/** Dry-run ATC test — never place order. */
import { runTargetCheckout } from "./target-checkout.mjs";
import { runWalmartCheckout } from "./walmart-checkout.mjs";
import { runPokemonCheckout } from "./pokemon-checkout.mjs";
import { runBandaiCheckout } from "./bandai-checkout.mjs";
import { checkTargetShipping } from "./target-monitor.mjs";
import { checkWalmartShipping } from "./walmart-monitor.mjs";
import { checkPokemonStock } from "./pokemon-monitor.mjs";
import { checkBandaiStock } from "./bandai-monitor.mjs";

export async function runCheckoutSelfTest(body = {}) {
  const store = String(body.store || "target").toLowerCase();
  const sku = body.sku || body.tcin || body.product || body.itemId;
  const proxy = body.proxy;
  const dry = { ...body, placeOrder: false, liveCheckout: false, proxy, sku };

  let monitor = null;
  try {
    if (store.includes("walmart")) monitor = await checkWalmartShipping({ sku, proxy });
    else if (store.includes("pokemon") || store.includes("pkc"))
      monitor = await checkPokemonStock({ product: sku, proxy, region: body.region });
    else if (store.includes("bandai")) monitor = await checkBandaiStock({ product: sku, proxy });
    else monitor = await checkTargetShipping({ tcin: String(sku || "").replace(/\D/g, ""), zip: body.zip, proxy });
  } catch (e) {
    monitor = { ok: false, error: e?.message || String(e) };
  }

  let checkout;
  try {
    if (store.includes("walmart")) checkout = await runWalmartCheckout({ ...dry, itemId: sku });
    else if (store.includes("pokemon") || store.includes("pkc"))
      checkout = await runPokemonCheckout({ ...dry, product: sku });
    else if (store.includes("bandai")) checkout = await runBandaiCheckout({ ...dry, product: sku });
    else checkout = await runTargetCheckout({ ...dry, tcin: sku });
  } catch (e) {
    checkout = { ok: false, stage: "error", message: e?.message || String(e) };
  }

  const pass =
    monitor?.inStock === true &&
    checkout &&
    (checkout.stage === "cart" || checkout.stage === "checkout" || checkout.ok);

  return {
    ok: true,
    pass: !!pass,
    store,
    sku,
    monitor: {
      inStock: monitor?.inStock,
      status: monitor?.availabilityStatus,
      error: monitor?.error,
      ms: monitor?.ms,
      via: monitor?.via,
    },
    checkout: {
      stage: checkout?.stage,
      message: checkout?.message || checkout?.error,
      ms: checkout?.ms,
    },
    note: pass
      ? "PASS · monitor IN STOCK + dry-run ATC"
      : "FAIL or incomplete · check login cookies / harvest / SKU",
  };
}
