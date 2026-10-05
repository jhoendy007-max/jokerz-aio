import test from "node:test";
import assert from "node:assert/strict";
import { proxyUrl, parseRetryAfter, parseJsonLdProduct, createChangeTracker } from "./monitor-common.mjs";
import { parsePokemonHtml } from "./pokemon-monitor.mjs";
import { parseBandaiHtml } from "./bandai-monitor.mjs";
import { fromHtml as walmartFromHtml, parseWalmartId } from "./walmart-monitor.mjs";

const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const prod = (availability, price = 49.99, name = "ETB") =>
  ld({ "@context": "https://schema.org", "@type": "Product", name, offers: { "@type": "Offer", price, availability: `https://schema.org/${availability}` } });

test("proxyUrl formats", () => {
  assert.equal(proxyUrl("1.2.3.4:8080"), "http://1.2.3.4:8080");
  assert.equal(proxyUrl("h:1:u:p:w"), "http://u:p%3Aw@h:1");
  assert.equal(proxyUrl("direct"), null);
  assert.equal(proxyUrl(""), null);
});

test("parseRetryAfter seconds/date/clamp", () => {
  assert.equal(parseRetryAfter("30"), 30000);
  assert.equal(parseRetryAfter("0"), 1000);
  assert.equal(parseRetryAfter("99999"), 600000);
  assert.equal(parseRetryAfter(new Date(10_000 + 5000).toUTCString(), 10_000) >= 1000, true);
  assert.equal(parseRetryAfter(null), undefined);
});

test("JSON-LD product parse incl @graph", () => {
  assert.deepEqual(parseJsonLdProduct(prod("InStock")), { title: "ETB", price: "$49.99", availability: "InStock", inStock: true, outOfStock: false });
  const g = ld({ "@graph": [{ "@type": "WebPage" }, { "@type": "Product", name: "X", offers: [{ price: "10", availability: "OutOfStock" }] }] });
  assert.equal(parseJsonLdProduct(g).outOfStock, true);
  assert.equal(parseJsonLdProduct("<p>none</p>"), null);
});

test("pokemon: footer 'sold out' text no longer hides an in-stock JSON-LD product", () => {
  const html = prod("InStock") + "<footer>Other items sold out</footer><button>Add to Cart</button>";
  const r = parsePokemonHtml(html);
  assert.equal(r.inStock, true);
  assert.equal(r.price, "$49.99");
  assert.equal(r.source, "json-ld");
});

test("pokemon: 'pre-order' banner doesn't fake stock when JSON-LD says OOS", () => {
  const r = parsePokemonHtml(prod("OutOfStock") + "<div>Pre-order the next set!</div>");
  assert.equal(r.inStock, false);
  assert.equal(r.availabilityStatus, "OUT_OF_STOCK");
});

test("pokemon: queue and 429 states", () => {
  assert.equal(parsePokemonHtml("x", { finalUrl: "https://queue-it.net/?c=pkc" }).availabilityStatus, "QUEUE");
  assert.equal(parsePokemonHtml("x", { status: 429 }).availabilityStatus, "RATE_LIMITED");
});

test("bandai: regex fallback still works without JSON-LD", () => {
  assert.equal(parseBandaiHtml("<button>Add to Cart</button> $12.00").inStock, true);
  assert.equal(parseBandaiHtml("<b>Sold Out</b>").availabilityStatus, "OUT_OF_STOCK");
  assert.equal(parseBandaiHtml(prod("PreOrder", 80)).inStock, true);
});

test("walmart: id + JSON-LD fallback for price/title", () => {
  assert.equal(parseWalmartId("https://www.walmart.com/ip/foo-bar/123456789"), "123456789");
  const r = walmartFromHtml(prod("OutOfStock", 19.5, "Item"));
  assert.equal(r.availabilityStatus, "OUT_OF_STOCK");
  assert.equal(r.price, "$19.50");
  assert.equal(r.title, "Item");
});

test("change tracker alerts only on transitions, with cooldown", () => {
  const s = createChangeTracker({ cooldownMs: 1000 });
  assert.equal(s("a", { inStock: false }, 0), null);
  assert.equal(s("a", { inStock: true, price: "$1" }, 10), "restock");
  assert.equal(s("a", { inStock: true, price: "$1" }, 20), null);
  assert.equal(s("a", { inStock: true, price: "$2" }, 30), "price");
  assert.equal(s("a", { inStock: false, price: "$2" }, 40), null);
  assert.equal(s("a", { inStock: true, price: "$2" }, 50), null); // cooldown
  s("a", { inStock: false, price: "$2" }, 1500);
  assert.equal(s("a", { inStock: true, price: "$2" }, 2000), "restock");
});
