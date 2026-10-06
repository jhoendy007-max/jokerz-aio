/**
 * One-click diagnostics: everything the AIO needs to work, checked in one go.
 * Each check → { id, label, status: "ok" | "warn" | "fail", detail, fix? }.
 */
import { existsSync, statfsSync, accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { listCookieJars } from "./cookie-persist.mjs";
import { listLogFiles, LOG_DIR } from "./file-log.mjs";

const startedAt = Date.now();
const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

function chromeCandidates() {
  const p = process.platform;
  if (p === "win32") {
    const pf = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    return pf.map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe"));
  }
  if (p === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
}

async function bundledBrowser() {
  for (const mod of ["patchright", "playwright"]) {
    try {
      const m = await import(mod);
      const p = m.chromium?.executablePath?.();
      if (p && existsSync(p)) return { mod, path: p };
    } catch {
      /* */
    }
  }
  return null;
}

async function reach(url, timeoutMs = 5000) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : e?.message || String(e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(tm);
  }
}

export async function runDiagnostics({ root = process.cwd() } = {}) {
  const checks = [];
  const add = (id, label, status, detail, fix) => checks.push({ id, label, status, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", "Node.js", major >= 20 ? "ok" : "fail", `v${process.versions.node}`, major >= 20 ? undefined : "Install Node 20 LTS or newer from nodejs.org");
  add("server", "Engine server", "ok", `running ${Math.round((Date.now() - startedAt) / 60000)} min · ${os.platform()} ${os.arch()}`);

  add("deps", "Dependencies", existsSync(join(root, "node_modules")) ? "ok" : "fail", existsSync(join(root, "node_modules")) ? "node_modules present" : "node_modules missing", "Run INSTALL-JOKERZ.bat (or npm install)");
  let undiciOk = false;
  try {
    await import("undici");
    undiciOk = true;
  } catch {
    /* */
  }
  add("undici", "Proxy support (undici)", undiciOk ? "ok" : "fail", undiciOk ? "installed" : "missing — proxies are ignored", "npm install undici");

  const chrome = chromeCandidates().find((p) => existsSync(p));
  const bundled = await bundledBrowser();
  add(
    "chrome",
    "Browser for logins",
    chrome || bundled ? "ok" : "fail",
    chrome ? `Google Chrome · ${chrome}` : bundled ? `bundled ${bundled.mod} Chromium` : "no Chrome and no bundled Chromium",
    chrome || bundled ? undefined : "Install Google Chrome, or run: npx patchright install chromium",
  );

  try {
    const s = statfsSync(root);
    const free = s.bavail * s.bsize;
    add("disk", "Disk space", free > 2 * 1024 ** 3 ? "ok" : free > 500 * 1024 ** 2 ? "warn" : "fail", `${gb(free)} free`, free > 2 * 1024 ** 3 ? undefined : "Free up disk space (browsers and logs need room)");
  } catch {
    add("disk", "Disk space", "warn", "could not read");
  }

  const dataDir = process.env.JOKERZ_DATA || join(root, "server");
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
    add("data", "Data folder", "ok", `${dataDir} is writable`);
  } catch {
    add("data", "Data folder", "fail", `${dataDir} is not writable`, "Move the AIO out of a read-only / synced-offline folder");
  }
  if (/google drive|my drive|onedrive|dropbox/i.test(root)) {
    add("sync", "Install location", "warn", "The AIO runs inside a cloud-synced folder", "Sync can lock files while the app writes. Copy the folder to e.g. C:\\JokerzAIO for best results");
  }

  const mem = process.memoryUsage().rss;
  add("memory", "Memory", "ok", `server ${Math.round(mem / 1024 ** 2)} MB · system ${gb(os.freemem())} free of ${gb(os.totalmem())}`);

  const files = listLogFiles();
  add("logs", "Log files", "ok", files.length ? `${files.length} day(s) in ${LOG_DIR}` : `none yet (${LOG_DIR})`);

  const jars = listCookieJars();
  add("sessions", "Saved sessions", "ok", `${jars.length} saved session(s)`);

  const [net, tg, wm, pk] = await Promise.all([
    reach("https://www.google.com/generate_204"),
    reach("https://www.target.com/robots.txt"),
    reach("https://www.walmart.com/robots.txt"),
    reach("https://www.pokemoncenter.com/robots.txt"),
  ]);
  add("internet", "Internet", net.ok ? "ok" : "fail", net.ok ? `${net.ms} ms` : net.error, net.ok ? undefined : "Check your connection / firewall");
  const stores = [
    ["Target", tg],
    ["Walmart", wm],
    ["Pokémon Center", pk],
  ];
  for (const [name, r] of stores) {
    add(`store-${name}`, `${name} reachable`, r.ok ? "ok" : "warn", r.ok ? `HTTP ${r.status} · ${r.ms} ms` : r.error || `HTTP ${r.status}`);
  }

  const summary = { ok: checks.filter((c) => c.status === "ok").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length };
  return { ok: summary.fail === 0, at: Date.now(), summary, checks };
}
