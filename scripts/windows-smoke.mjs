#!/usr/bin/env node
/**
 * End-to-end smoke test of a RUNNING Jokerz AIO (started with START-JOKERZ.bat or the launcher).
 * Checks the UI, every API route, the log files, the restart path and every sidebar tab in a real browser.
 *   node scripts/windows-smoke.mjs [--out smoke-out] [--wait 240]
 * Writes <out>/report.json + screenshots. Exit code 1 if anything failed.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const OUT = arg("--out", "smoke-out");
const WAIT = Number(arg("--wait", 240)) * 1000;
const UI = "http://127.0.0.1:8080";
const API = `${UI}/jokerz-api`;
mkdirSync(OUT, { recursive: true });

const results = [];
const add = (name, ok, detail = "") => {
  results.push({ name, ok, detail: String(detail).slice(0, 500) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(path.startsWith("http") ? path : `${API}${path}`, { ...opts, signal: ctrl.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    let body = null;
    try {
      body = JSON.parse(buf.toString("utf8"));
    } catch {
      /* not json */
    }
    return { status: r.status, headers: r.headers, buf, body };
  } finally {
    clearTimeout(t);
  }
}
const post = (path, data, timeout) => get(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data), timeout });

async function waitUp(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await get(url, { timeout: 5000 });
      if (r.status < 500) return Date.now() - t0;
    } catch {
      /* not yet */
    }
    await sleep(2000);
  }
  return -1;
}

async function step(name, fn) {
  try {
    const r = await fn();
    if (r === false) add(name, false);
    else add(name, true, typeof r === "string" ? r : "");
  } catch (e) {
    add(name, false, e?.stack || e?.message || e);
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const upMs = await waitUp(`${UI}/`, WAIT);
add("UI answers on :8080", upMs >= 0, upMs >= 0 ? `${Math.round(upMs / 1000)} s` : `not up after ${WAIT / 1000} s`);
if (upMs < 0) {
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ ok: false, results }, null, 2));
  process.exit(1);
}

await step("Engine server answers on :8787", async () => {
  const r = await get("http://127.0.0.1:8787/health");
  must(r.status === 200, `HTTP ${r.status}`);
});
await step("Home page HTML", async () => {
  const r = await get(`${UI}/`);
  must(r.status === 200 && /<html/i.test(r.buf.toString()), `HTTP ${r.status}`);
});
await step("GET /api/version (started by launcher)", async () => {
  const r = await get("/api/version");
  must(r.body?.ok, JSON.stringify(r.body));
  must(r.body.launcher === true, "JOKERZ_LAUNCHER not set — not started through launcher");
  return `sha ${r.body.sha || "-"}`;
});
let diag = null;
await step("GET /api/diagnostics", async () => {
  const r = await get("/api/diagnostics", { timeout: 60000 });
  must(r.body?.checks?.length, JSON.stringify(r.body).slice(0, 200));
  diag = r.body;
  writeFileSync(join(OUT, "diagnostics.json"), JSON.stringify(r.body, null, 2));
  const fails = r.body.checks.filter((c) => c.status === "fail");
  must(!fails.length, fails.map((c) => `${c.label}: ${c.detail}`).join(" | "));
  for (const c of r.body.checks.filter((x) => x.status !== "ok")) console.log(`      ${c.status.toUpperCase()} ${c.label}: ${c.detail}${c.fix ? ` → ${c.fix}` : ""}`);
  return `${r.body.summary.ok} ok · ${r.body.summary.warn} warn`;
});
await step("POST /api/logs/client + search", async () => {
  const marker = `smoke-${Date.now()}`;
  const w = await post("/api/logs/client", { entries: [{ level: "warn", source: "task", msg: `${marker} password=hunter2 https://discord.com/api/webhooks/1/secretpart` }] });
  must(w.body?.ok, JSON.stringify(w.body));
  const s = await get(`/api/logs?q=${marker}`);
  const row = s.body?.rows?.[0];
  must(row, "line not found");
  must(!row.msg.includes("hunter2") && !row.msg.includes("secretpart"), `not redacted: ${row.msg}`);
});
await step("Log file exists in logs\\", async () => {
  const dir = join(process.cwd(), "logs");
  must(existsSync(dir), "no logs folder");
  const f = readdirSync(dir).filter((x) => /^jokerz-\d{4}-\d{2}-\d{2}\.log$/.test(x));
  must(f.length, "no log file");
  const txt = readFileSync(join(dir, f[0]), "utf8");
  must(!txt.includes("hunter2"), "secret in file");
  return f.join(", ");
});
await step("GET /api/logs/export (ZIP)", async () => {
  const r = await get("/api/logs/export");
  must(r.status === 200, `HTTP ${r.status}`);
  must(r.buf.readUInt32LE(0) === 0x04034b50, "not a zip");
  writeFileSync(join(OUT, "logs-export.zip"), r.buf);
  return `${r.buf.length} bytes`;
});
await step("POST /api/proxy/test (bad + unreachable)", async () => {
  const r = await post("/api/proxy/test", { proxies: ["nonsense", "127.0.0.1:9:u:p"], timeoutMs: 4000 });
  must(r.body?.ok && r.body.failed === 2, JSON.stringify(r.body).slice(0, 300));
});
await step("GET /api/accounts/history", async () => {
  const r = await get("/api/accounts/history");
  must(r.body?.ok && Array.isArray(r.body.events), JSON.stringify(r.body).slice(0, 200));
});
await step("GET /api/accounts/status", async () => {
  const r = await get("/api/accounts/status");
  must(r.status === 200 && r.body, `HTTP ${r.status}`);
});
await step("POST /api/drops/import-url blocks local", async () => {
  const r = await post("/api/drops/import-url", { url: "http://127.0.0.1:8787/health" });
  must(r.body && r.body.ok === false, JSON.stringify(r.body));
});
await step("POST /api/drops/import-url real ICS link", async () => {
  const r = await post("/api/drops/import-url", { url: "https://www.officeholidays.com/ics/usa" }, 30000);
  must(r.body?.ok && /BEGIN:VCALENDAR/.test(r.body.text || ""), JSON.stringify(r.body).slice(0, 200));
});
await step("GET /api/update/config", async () => {
  const r = await get("/api/update/config");
  must(r.body?.ok && r.body.repo, JSON.stringify(r.body));
  return `mode ${r.body.mode}`;
});
await step("GET /api/remote/status + pending", async () => {
  const a = await get("/api/remote/status");
  const b = await get("/api/remote/pending");
  must(a.body?.ok && b.body?.ok && Array.isArray(b.body.commands), JSON.stringify([a.body, b.body]));
});
await step("POST /api/notify/telegram rejects bad token", async () => {
  const r = await post("/api/notify/telegram", { token: "1:bad", chatId: "1", title: "x", lines: [] });
  must(r.body && r.body.ok === false, JSON.stringify(r.body));
});
await step("POST /api/orders/scan-email without login fails cleanly", async () => {
  const r = await post("/api/orders/scan-email", { user: "", pass: "" });
  must(r.body && r.body.ok === false, JSON.stringify(r.body));
});

// ─── real browser: every tab, console errors ───
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (e) {
  add("Playwright available", false, e?.message);
}
if (chromium) {
  await step("All tabs render without errors", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon|Failed to load resource.*404|DevTools/i.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await page.goto(`${UI}/`, { waitUntil: "load", timeout: 120000 });
    await page.waitForTimeout(3000);
    const tabs = ["Dashboard", "Tasks", "Profiles", "Proxies", "Results", "Account Gen", "Settings"];
    const bad = [];
    for (const t of tabs) {
      const before = errors.length;
      const btn = page.getByRole("button", { name: t, exact: true }).first();
      if (!(await btn.count())) {
        bad.push(`${t}: no sidebar button`);
        continue;
      }
      await btn.click();
      await page.waitForTimeout(1500);
      const crashed = await page.locator("text=/Something went wrong|Application error/i").count();
      if (crashed) bad.push(`${t}: error screen`);
      await page.screenshot({ path: join(OUT, `tab-${t.toLowerCase().replace(/\s+/g, "-")}.png`) });
      if (errors.length > before) bad.push(`${t}: ${errors.slice(before).join(" | ")}`);
    }
    // dialogs on the dashboard
    await page.getByRole("button", { name: "Dashboard", exact: true }).first().click();
    await page.waitForTimeout(800);
    for (const d of ["Diagnostics", "Logs", "Backup"]) {
      const b = page.getByRole("button", { name: d }).first();
      if (!(await b.count())) {
        bad.push(`${d}: button missing`);
        continue;
      }
      await b.click();
      await page.waitForTimeout(d === "Diagnostics" ? 6000 : 1500);
      await page.screenshot({ path: join(OUT, `dialog-${d.toLowerCase()}.png`) });
      const close = page.getByLabel("Close").first();
      if (await close.count()) await close.click();
      await page.waitForTimeout(400);
    }
    // settings sub-tabs
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    for (const s of ["Accounts", "Webhooks", "General"]) {
      const b = page.getByRole("button", { name: new RegExp(`^\\s*${s}\\s*$`, "i") }).first();
      if (await b.count()) {
        await b.click();
        await page.waitForTimeout(1200);
        await page.screenshot({ path: join(OUT, `settings-${s.toLowerCase()}.png`), fullPage: true });
      }
    }
    await browser.close();
    writeFileSync(join(OUT, "browser-errors.txt"), errors.join("\n"));
    for (const e of errors.slice(0, 30)) console.log(`      ${e.slice(0, 300)}`);
    must(!bad.length, bad.join(" || "));
    return errors.length ? `${errors.length} console message(s) logged` : "";
  });
}

// ─── restart through the launcher (what "Restart now" after an update does) ───
await step("POST /api/restart → app comes back", async () => {
  const r = await post("/api/restart", {});
  must(r.body?.ok, JSON.stringify(r.body));
  await sleep(4000);
  const back = await waitUp(`${UI}/`, 120000);
  must(back >= 0, "UI did not come back after restart");
  const v = await get("/api/version");
  must(v.body?.ok, "API not back");
  const s = await waitUp("http://127.0.0.1:8787/health", 60000);
  must(s >= 0, "engine server did not come back");
  return `back in ${Math.round((back + 4000) / 1000)} s`;
});

const ok = results.every((r) => r.ok);
writeFileSync(join(OUT, "report.json"), JSON.stringify({ ok, platform: process.platform, node: process.version, at: new Date().toISOString(), diagnostics: diag?.summary, results }, null, 2));
console.log(`\n${ok ? "ALL PASSED" : "FAILURES"} · ${results.filter((r) => r.ok).length}/${results.length}`);
process.exit(ok ? 0 : 1);
