/**
 * Pokémon Center monitor — stock + Queue-it. Guest region US.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function pokemonUrl(raw, region = "US") {
  const s = String(raw || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  const host = String(region).toUpperCase() === "UK" ? "https://www.pokemoncenter.co.uk" : "https://www.pokemoncenter.com";
  if (s.startsWith("/")) return host + s;
  return `${host}/product/${s}`;
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
      headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
      signal: ctrl.signal,
      redirect: "follow",
      ...(dispatcher ? { dispatcher } : {}),
    });
    return { status: r.status, text: await r.text(), url: r.url };
  } finally {
    clearTimeout(t);
  }
}

export async function checkPokemonStock({ url, product, region, proxy } = {}) {
  const href = pokemonUrl(url || product, region);
  const t0 = Date.now();
  try {
    const r = await fetchText(href, proxy);
    const html = r.text || "";
    const finalUrl = r.url || href;
    const inQueue = /queue-it|queueittoken|please wait while we verify/i.test(html + finalUrl);
    const dd = /captcha-delivery|datadome/i.test(html + finalUrl);
    const sold = /sold out|out of stock|currently unavailable|notify me/i.test(html);
    const atc = /add to (bag|cart)|pre[- ]?order/i.test(html);
    const price = (html.match(/\$[\d,.]+/) || [])[0];
    const title = (html.match(/<title>([^<]+)/i) || [])[1]?.replace(/\s+\|.*/, "").trim();
    const inStock = !inQueue && !dd && atc && !sold;
    return {
      ok: true,
      inStock,
      inQueue,
      queueProvider: inQueue ? "queue-it" : null,
      blocked: dd || r.status === 403,
      price,
      title,
      availabilityStatus: inQueue ? "QUEUE" : dd ? "DATADOME" : inStock ? "IN_STOCK" : sold ? "OUT_OF_STOCK" : "UNKNOWN",
      ms: Date.now() - t0,
      via: "pokemon-monitor",
      finalUrl,
      product: href,
    };
  } catch (e) {
    return { ok: false, inStock: false, error: e?.message || String(e), ms: Date.now() - t0, product: href };
  }
}
