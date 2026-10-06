/** Persistent login history per account (last 2000 events) for the account health panel. */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

const FILE = process.env.JOKERZ_LOGIN_HISTORY || join(process.env.JOKERZ_DATA || join(process.cwd(), "server"), ".login-history.json");
const MAX = 2000;
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(cache)) cache = [];
  } catch {
    cache = [];
  }
  return cache;
}

export function recordLogin(e) {
  const list = load();
  list.push({ t: Date.now(), ...e, email: String(e.email || "").toLowerCase() });
  if (list.length > MAX) list.splice(0, list.length - MAX);
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE + ".tmp", JSON.stringify(list));
    renameSync(FILE + ".tmp", FILE);
  } catch {
    /* */
  }
}

export function loginHistory({ email, store, sinceMs } = {}) {
  return load().filter((e) => (!email || e.email === String(email).toLowerCase()) && (!store || e.store === store) && (!sinceMs || e.t >= sinceMs));
}

export function _setLoginHistory(list) {
  cache = list;
}
