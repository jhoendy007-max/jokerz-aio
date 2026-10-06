#!/usr/bin/env node
/**
 * One-click launcher: checks everything, installs what is missing, starts the engine server and
 * the UI in ONE window, restarts them if they crash, opens the browser. Ctrl+C stops everything.
 *   node scripts/launcher.mjs            (START-JOKERZ.bat calls this)
 *   node scripts/launcher.mjs --no-open  (don't open the browser)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";
const NPX = WIN ? "npx.cmd" : "npx";
const UI_PORT = Number(process.env.JOKERZ_UI_PORT) || 8080;
const API_PORT = Number(process.env.AIO_API_PORT) || 8787;
const OPEN = !process.argv.includes("--no-open");
const RESTART_CODE = 75;

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const say = (s) => console.log(`${c(35, "[jokerz]")} ${s}`);
const warn = (s) => console.log(`${c(33, "[jokerz]")} ${s}`);
const fail = (s) => {
  console.log(`${c(31, "[jokerz]")} ${s}`);
  process.exitCode = 1;
};

function portBusy(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
    setTimeout(() => (s.destroy(), res(false)), 800);
  });
}

function openBrowser(url) {
  if (!OPEN) return;
  const cmd = WIN ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* */
  }
}

function needsInstall() {
  const nm = join(ROOT, "node_modules");
  if (!existsSync(nm)) return "first run";
  const lock = join(ROOT, "package-lock.json");
  const stamp = join(nm, ".package-lock.json");
  if (existsSync(lock) && existsSync(stamp) && statSync(lock).mtimeMs > statSync(stamp).mtimeMs + 1000) return "dependencies changed";
  for (const dep of ["undici", "vite", "patchright"]) if (!existsSync(join(nm, dep))) return `${dep} missing`;
  return "";
}

async function hasBrowser() {
  const chrome = WIN
    ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe"))
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  if (chrome.some((p) => existsSync(p))) return "Google Chrome";
  try {
    const m = await import("patchright");
    const p = m.chromium.executablePath();
    if (p && existsSync(p)) return "bundled Chromium";
  } catch {
    /* */
  }
  return "";
}

async function preflight() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    fail(`Node ${process.versions.node} is too old — install Node 20 LTS or newer from https://nodejs.org`);
    return false;
  }
  say(`Node ${process.versions.node} OK`);
  const why = needsInstall();
  if (why) {
    say(`Installing dependencies (${why})… this can take a few minutes`);
    const r = spawnSync(NPM, ["install", "--no-fund", "--no-audit"], { stdio: "inherit", shell: WIN });
    if (r.status !== 0) {
      fail("npm install failed — check your internet connection and run INSTALL-JOKERZ.bat");
      return false;
    }
  } else say("Dependencies OK");
  const browser = await hasBrowser();
  if (!browser) {
    say("No browser for logins found — installing Chromium (one time)…");
    const r = spawnSync(NPX, ["patchright", "install", "chromium"], { stdio: "inherit", shell: WIN });
    if (r.status !== 0) warn("Could not install Chromium. Install Google Chrome to use logins.");
  } else say(`Browser OK (${browser})`);
  return true;
}

const procs = new Map();
let stopping = false;
const crashes = { server: [], ui: [] };

function startProc(name, args, env = {}) {
  const color = name === "server" ? 36 : 32;
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, JOKERZ_LAUNCHER: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(`${c(color, `[${name}]`)} ${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    procs.delete(name);
    if (stopping) return;
    if (code === RESTART_CODE) {
      say("Restart requested (update installed) — restarting everything…");
      restartAll();
      return;
    }
    const now = Date.now();
    crashes[name] = crashes[name].filter((t) => now - t < 10 * 60_000).concat(now);
    if (crashes[name].length > 5) {
      fail(`${name} crashed 5 times in 10 minutes — not restarting. Check logs/ and run Diagnostics.`);
      return;
    }
    const wait = Math.min(30, 2 ** crashes[name].length);
    warn(`${name} stopped (code ${code}) — restarting in ${wait}s`);
    setTimeout(() => !stopping && start(name), wait * 1000);
  });
  procs.set(name, child);
}

function start(name) {
  if (name === "server") startProc("server", ["scripts/aio-api.mjs"], { AIO_API_PORT: String(API_PORT) });
  else {
    const bin = join(ROOT, "node_modules", ".bin");
    const sep = WIN ? ";" : ":";
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    startProc("ui", ["scripts/with-app-env.mjs", "vite", "dev", "--host", "0.0.0.0", "--port", String(UI_PORT), "--strictPort"], { [pathKey]: `${bin}${sep}${process.env[pathKey] || ""}` });
  }
}

function killAll() {
  for (const [, p] of procs) {
    try {
      if (WIN) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
      else p.kill("SIGTERM");
    } catch {
      /* */
    }
  }
}

function restartAll() {
  stopping = true;
  killAll();
  setTimeout(async () => {
    stopping = false;
    await preflight();
    start("server");
    start("ui");
  }, 1500);
}

async function waitFor(port, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await portBusy(port)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function main() {
  console.log(c(35, "\n  JOKERZ AIO\n"));
  if (await portBusy(UI_PORT)) {
    say(`Already running on port ${UI_PORT} — opening it`);
    openBrowser(`http://127.0.0.1:${UI_PORT}/`);
    return;
  }
  if (!(await preflight())) return;
  if (await portBusy(API_PORT)) warn(`Port ${API_PORT} is busy — an old engine window may still be open (STOP-JOKERZ.bat closes it)`);
  else start("server");
  start("ui");
  if (await waitFor(UI_PORT)) {
    say(`Ready → http://127.0.0.1:${UI_PORT}/   (keep this window open · Ctrl+C to stop)`);
    openBrowser(`http://127.0.0.1:${UI_PORT}/`);
  } else warn("The UI did not start within 90 s — see the messages above");
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopping = true;
    say("Stopping…");
    killAll();
    setTimeout(() => process.exit(0), 800);
  });
}

main();
