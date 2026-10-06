import test from "node:test";
import assert from "node:assert/strict";
import { extractImage, normalizeImageUrl, parseJsonLdProduct } from "./monitor-common.mjs";
import { productPage, lookupProductImage, _resetImageCache } from "./product-image.mjs";
import { parsePokemonHtml } from "./pokemon-monitor.mjs";
import { fromHtml as walmartFromHtml } from "./walmart-monitor.mjs";

const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

test("normalizeImageUrl: https only, fixes // and relative", () => {
  assert.equal(normalizeImageUrl("//cdn.x.com/a.jpg"), "https://cdn.x.com/a.jpg");
  assert.equal(normalizeImageUrl("http://cdn.x.com/a.jpg"), "https://cdn.x.com/a.jpg");
  assert.equal(normalizeImageUrl("/img/a.png", "https://www.pokemoncenter.com/p"), "https://www.pokemoncenter.com/img/a.png");
  assert.equal(normalizeImageUrl("javascript:alert(1)"), undefined);
  assert.equal(normalizeImageUrl("https://x.com/a b.jpg"), undefined);
  assert.equal(normalizeImageUrl(""), undefined);
});

test("extractImage: JSON-LD (string, array, ImageObject) then og:image", () => {
  assert.equal(extractImage(ld({ "@type": "Product", name: "A", image: "https://i.com/1.jpg" })), "https://i.com/1.jpg");
  assert.equal(extractImage(ld({ "@type": "Product", name: "A", image: ["https://i.com/2.jpg", "https://i.com/3.jpg"] })), "https://i.com/2.jpg");
  assert.equal(extractImage(ld({ "@type": "Product", name: "A", image: { "@type": "ImageObject", url: "https://i.com/4.jpg" } })), "https://i.com/4.jpg");
  assert.equal(extractImage('<meta property="og:image" content="https://i.com/og.jpg?w=1&amp;h=2">'), "https://i.com/og.jpg?w=1&h=2");
  assert.equal(extractImage('<meta content="//i.com/tw.jpg" name="twitter:image">'), "https://i.com/tw.jpg");
  assert.equal(extractImage("<p>none</p>"), undefined);
  // no image key when the product has none (keeps old shape)
  assert.equal("image" in parseJsonLdProduct(ld({ "@type": "Product", name: "A" })), false);
});

test("monitors return imageUrl", () => {
  const html = ld({ "@type": "Product", name: "ETB", image: "https://pc.com/etb.jpg", offers: { availability: "https://schema.org/InStock", price: 50 } });
  assert.equal(parsePokemonHtml(html).imageUrl, "https://pc.com/etb.jpg");
  const nd = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ p: { name: "X", imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/x.jpg" } } })}</script>`;
  assert.equal(walmartFromHtml(nd).imageUrl, "https://i5.walmartimages.com/x.jpg");
});

test("productPage per store", () => {
  assert.equal(productPage("Target", "93954446"), "https://www.target.com/p/-/A-93954446");
  assert.equal(productPage("Walmart", "https://www.walmart.com/ip/foo/123456789"), "https://www.walmart.com/ip/123456789");
  assert.equal(productPage("Pokemon Center", "10-10037-118"), "https://www.pokemoncenter.com/product/10-10037-118");
  assert.equal(productPage("Other", "abc"), null);
});

test("lookupProductImage caches hits and dedupes in-flight requests", async () => {
  _resetImageCache();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { status: 200, text: '<meta property="og:image" content="https://t.com/p.jpg">' };
  };
  const [a, b] = await Promise.all([
    lookupProductImage({ store: "Target", product: "123456", fetcher }),
    lookupProductImage({ store: "Target", product: "123456", fetcher }),
  ]);
  assert.equal(a.imageUrl, "https://t.com/p.jpg");
  assert.equal(b.imageUrl, "https://t.com/p.jpg");
  const c = await lookupProductImage({ store: "Target", product: "123456", fetcher });
  assert.equal(c.cached, true);
  assert.equal(calls, 1);
});
