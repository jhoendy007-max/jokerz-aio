/**
 * Daily log files: everything the server prints (console.log / warn / error) plus the
 * app's task logs (POST /api/logs/client) goes to logs/jokerz-YYYY-MM-DD.log.
 * Files older than KEEP_DAYS are deleted. Search + ZIP export for the Logs window.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createZip } from "./zip-lite.mjs";

export const LOG_DIR = process.env.JOKERZ_LOG_DIR || join(process.cwd(), "logs");
export const KEEP_DAYS = Number(process.env.JOKERZ_LOG_DAYS) || 14;
const FILE_RE = /^jokerz-(\d{4}-\d{2}-\d{2})\.log$/;

const pad = (n) => String(n).padStart(2, "0");
export const dayOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fileFor = (day) => join(LOG_DIR, `jokerz-${day}.log`);

/** Hide secrets that should never land in a log file. */
export function redact(s) {
  return String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi, "$1***")
    .replace(/(hooks\.slack\.com\/services\/)[\w/]+/gi, "$1***")
    .replace(/(bot)\d{6,}:[\w-]{20,}/gi, "$1***")
    .replace(/("?\b(?:password|passwd|pass|\w*Pass|token|\w*Token|apiKey|secret|cvv|cvc|cardNumber)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"')
    .replace(/(\b(?:password|passwd|pass|\w*Pass|token|\w*Token|apiKey|secret|cvv|cvc)\s*[:=]\s*)(?!"|\*\*\*)[^\s,;&"']+/gi, "$1***")
    .replace(/([?&](?:token|key|apikey|access_token|password)=)[^&\s]+/gi, "$1***")
    .replace(/\b(\d{4})[ -]?\d{4}[ -]?\d{4}[ -]?(\d{4})\b/g, "$1********$2")
    .replace(/(\/\/[^:\s/]+:)[^@\s/]+@/g, "$1***@");
}

let lastCleanDay = "";
function cleanup(now = new Date()) {
  const day = dayOf(now);
  if (day === lastCleanDay) return;
  lastCleanDay = day;
  const cutoff = now.getTime() - KEEP_DAYS * 86400_000;
  for (const f of listLogFiles()) if (Date.parse(`${f.day}T00:00:00`) < cutoff) unlinkSync(join(LOG_DIR, f.name));
}

export function writeLog(level, source, msg, now = new Date()) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    cleanup(now);
    const line = `${now.toISOString()} ${String(level).toUpperCase().padEnd(5)} [${source}] ${redact(msg).replace(/\r?\n/g, " ⏎ ")}\n`;
    appendFileSync(fileFor(dayOf(now)), line);
  } catch {
    /* never break the app because of logging */
  }
}

const fmt = (args) => args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : safeJson(a))).join(" ");
function safeJson(a) {
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

let installed = false;
export function installFileLogger() {
  if (installed) return;
  installed = true;
  for (const [m, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]]) {
    const orig = console[m].bind(console);
    console[m] = (...args) => {
      orig(...args);
      writeLog(level, "server", fmt(args));
    };
  }
  process.on("uncaughtException", (e) => writeLog("error", "server", `uncaught: ${e?.stack || e}`));
  process.on("unhandledRejection", (e) => writeLog("error", "server", `unhandled rejection: ${e?.stack || e}`));
}

export function listLogFiles() {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .map((name) => ({ name, m: name.match(FILE_RE) }))
    .filter((x) => x.m)
    .map(({ name, m }) => ({ name, day: m[1], size: statSync(join(LOG_DIR, name)).size }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

/** Parse + filter one day. */
export function searchLogs({ day = dayOf(), q = "", level = "", source = "", limit = 500 } = {}) {
  const f = fileFor(day);
  if (!existsSync(f)) return [];
  const needle = String(q || "").toLowerCase();
  const out = [];
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i];
    if (!l) continue;
    const m = l.match(/^(\S+) (\w+)\s+\[([^\]]+)\] (.*)$/);
    if (!m) continue;
    const row = { t: m[1], level: m[2].toLowerCase(), source: m[3], msg: m[4] };
    if (level && row.level !== level) continue;
    if (source && row.source !== source) continue;
    if (needle && !l.toLowerCase().includes(needle)) continue;
    out.push(row);
  }
  return out;
}

export function exportLogsZip(days) {
  const files = listLogFiles().filter((f) => !days || days.includes(f.day));
  return createZip(files.map((f) => ({ name: f.name, data: readFileSync(join(LOG_DIR, f.name)) })));
}
