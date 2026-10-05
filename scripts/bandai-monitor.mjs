/**
 * Premium Bandai US — shipping product stock from PDP HTML.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function bandaiUrl(raw) {
  const s = String(raw || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return "https://p-bandai.com" + s;
  return `https://p-bandai.com/us/item/${s}`;
}

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
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return null;
}

async function fetchText(url, proxy) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 14000);
  let dispatcher;
  const u = proxyUrl(proxy);
  if (u) {
    try {
      const { ProxyAgent } = await import("undici");
      dispatcher = new ProxyAgent(u);
    } catch {
      /* */
    }
  }
  const { fetch: uf } = await import("undici").catch(() => ({ fetch: globalThis.fetch }));
  try {
    const r = await (uf || fetch)(url, {
      headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9", Referer: "https://p-bandai.com/us" },
      signal: ctrl.signal,
      redirect: "follow",
      ...(dispatcher ? { dispatcher } : {}),
    });
    return { status: r.status, text: await r.text(), url: r.url };
  } finally {
    clearTimeout(t);
  }
}

export async function checkBandaiStock({ url, product, sku, proxy } = {}) {
  const href = bandaiUrl(url || product || sku);
  const t0 = Date.now();
  try {
    const r = await fetchText(href, proxy);
    const html = r.text || "";
    const sold = /sold out|out of stock|currently unavailable|lottery closed/i.test(html);
    const atc = /add to (cart|bag)|pre[- ]?order|buy now/i.test(html);
    const price = (html.match(/(?:USD|\$)\s*[\d,.]+/) || [])[0];
    const title = (html.match(/<title>([^<]+)/i) || [])[1]?.replace(/\s+\|.*/, "").trim();
    const blocked = r.status === 403 || /captcha|access denied/i.test(html);
    const inStock = !blocked && atc && !sold;
    return {
      ok: true,
      inStock,
      blocked,
      price,
      title,
      availabilityStatus: blocked ? "BLOCKED" : inStock ? "IN_STOCK" : sold ? "OUT_OF_STOCK" : "UNKNOWN",
      ms: Date.now() - t0,
      via: "bandai-monitor",
      finalUrl: r.url,
      product: href,
    };
  } catch (e) {
    return { ok: false, inStock: false, error: e?.message || String(e), ms: Date.now() - t0, product: href };
  }
}
