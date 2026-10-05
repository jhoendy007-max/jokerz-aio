/**
 * Timezone/GPS from the proxy EXIT IP (cached).
 * Lookup goes through the same proxy so Shape sees tz matching ASN.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

function parseProxy(line) {
  if (!line) return undefined;
  let s = String(line).trim();
  if (!s) return undefined;
  s = s.replace(/^https?:\/\//i, "");
  if (s.includes("@")) {
    const [auth, host] = s.split("@");
    const [username, ...p] = auth.split(":");
    const [hostname, port] = host.split(":");
    return { server: `http://${hostname}:${port}`, username, password: p.join(":") };
  }
  const parts = s.split(":");
  if (parts.length >= 4) {
    const [host, port, username, ...rest] = parts;
    return { server: `http://${host}:${port}`, username, password: rest.join(":") };
  }
  if (parts.length === 2) return { server: `http://${parts[0]}:${parts[1]}` };
  return undefined;
}

const ROOT = process.env.JOKERZ_DATA || join(process.cwd(), "server");
const FILE = process.env.JOKERZ_PROXY_GEO || join(ROOT, ".proxy-geo.json");
const TTL = 7 * 24 * 3600 * 1000;

function hostKey(raw) {
  const p = parseProxy(raw);
  if (!p?.server) return "";
  return p.server.replace(/^https?:\/\//, "").toLowerCase();
}

function load() {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8") || "{}");
  } catch {
    /* */
  }
  return {};
}

function save(obj) {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, FILE);
}

function hashLine(raw) {
  return createHash("sha256").update(String(raw || "")).digest("hex").slice(0, 12);
}

export async function geoForProxy(raw, { timeoutMs = 4000 } = {}) {
  const key = hostKey(raw);
  if (!key) return null;
  const all = load();
  const id = hashLine(key);
  const hit = all[id];
  if (hit?.tz && Date.now() - (hit.at || 0) < TTL) return hit;

  const p = parseProxy(raw);
  let dispatcher;
  try {
    const { ProxyAgent } = await import("undici");
    const u = new URL(p.server);
    if (p.username) {
      u.username = p.username;
      u.password = p.password || "";
    }
    dispatcher = new ProxyAgent(u.toString());
  } catch {
    dispatcher = undefined;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { fetch: ufetch } = await import("undici").catch(() => ({ fetch: globalThis.fetch }));
    const r = await (ufetch || fetch)(
      "http://ip-api.com/json/?fields=status,country,region,regionName,city,lat,lon,timezone,query",
      { signal: ctrl.signal, ...(dispatcher ? { dispatcher } : {}) }
    );
    const j = await r.json().catch(() => ({}));
    if (j.status !== "success" || !j.timezone) return hit || null;
    const geo = {
      tz: j.timezone,
      lat: Number(j.lat),
      lon: Number(j.lon),
      city: j.city || "",
      region: j.regionName || j.region || "",
      country: j.country || "",
      ip: j.query || "",
      at: Date.now(),
    };
    all[id] = geo;
    save(all);
    return geo;
  } catch {
    return hit || null;
  } finally {
    clearTimeout(t);
  }
}

export function geoHint(geo) {
  if (!geo?.tz) return "";
  const place = [geo.city, geo.region].filter(Boolean).join(", ");
  return place ? `${place} · ${geo.tz}` : geo.tz;
}
