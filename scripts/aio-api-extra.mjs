/** Extra API routes: diagnostics, logs, proxy test, updates, account history, orders, channels, remote control, drop import. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runDiagnostics } from "./diagnostics.mjs";
import { listLogFiles, searchLogs, exportLogsZip, writeLog, dayOf } from "./file-log.mjs";
import { testProxies } from "./proxy-test.mjs";
import { checkForUpdate, applyUpdate, saveUpdateConfig, publicConfig } from "./updater.mjs";
import { loginHistory } from "./login-history.mjs";
import { scanOrderEmails } from "./order-email.mjs";
import { sendTelegram, sendEmail } from "./notify-channels.mjs";
import { setRemoteConfig, remotePublic, takePending, remoteReply } from "./remote-control.mjs";

let applying = false;

export async function fetchImportText(url, { maxBytes = 1024 * 1024 } = {}) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "Only http(s) links" };
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname)) return { ok: false, error: "Local addresses are not allowed" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(u, { signal: ctrl.signal, headers: { Accept: "text/calendar, text/csv, application/json, text/plain, */*" } });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, error: "File too large (max 1 MB)" };
    return { ok: true, text: buf.toString("utf8"), contentType: r.headers.get("content-type") || "" };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "Timeout" : e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

export async function handleExtraApi(req, res, { path, method, url, json, readBody }) {
  const q = (k) => url.searchParams.get(k) || "";

  if (path === "/api/version" && method === "GET") {
    let version = "";
    try {
      version = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version || "";
    } catch {
      /* */
    }
    let sha = "";
    try {
      sha = JSON.parse(readFileSync(join(process.cwd(), ".jokerz-version"), "utf8")).sha?.slice(0, 7) || "";
    } catch {
      /* */
    }
    if (!sha) {
      try {
        const head = readFileSync(join(process.cwd(), ".git", "HEAD"), "utf8").trim();
        sha = (head.startsWith("ref:") ? readFileSync(join(process.cwd(), ".git", head.slice(5).trim()), "utf8") : head).trim().slice(0, 7);
      } catch {
        /* */
      }
    }
    json(res, 200, { ok: true, version, sha, launcher: process.env.JOKERZ_LAUNCHER === "1" });
    return true;
  }

  if (path === "/api/restart" && method === "POST") {
    if (process.env.JOKERZ_LAUNCHER !== "1") {
      json(res, 200, { ok: false, error: "Close the AIO windows and start it again with START-JOKERZ.bat" });
      return true;
    }
    json(res, 200, { ok: true, restarting: true });
    setTimeout(() => process.exit(75), 300);
    return true;
  }

  if (path === "/api/diagnostics" && method === "GET") {
    json(res, 200, await runDiagnostics());
    return true;
  }

  // ─── logs ───
  if (path === "/api/logs/files" && method === "GET") {
    json(res, 200, { ok: true, files: listLogFiles(), today: dayOf() });
    return true;
  }
  if (path === "/api/logs" && method === "GET") {
    json(res, 200, { ok: true, rows: searchLogs({ day: q("day") || dayOf(), q: q("q"), level: q("level"), source: q("source"), limit: Math.min(2000, Number(q("limit")) || 500) }) });
    return true;
  }
  if (path === "/api/logs/export" && method === "GET") {
    const days = q("days") ? q("days").split(",") : null;
    const zip = exportLogsZip(days);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="jokerz-logs-${dayOf()}.zip"`,
      "access-control-allow-origin": "*",
      "content-length": zip.length,
    });
    res.end(zip);
    return true;
  }
  if (path === "/api/logs/client" && method === "POST") {
    const body = await readBody(req);
    const list = Array.isArray(body.entries) ? body.entries.slice(0, 500) : [];
    for (const e of list) writeLog(e.level || "info", String(e.source || "app").slice(0, 40), String(e.msg || "").slice(0, 2000), e.t ? new Date(e.t) : new Date());
    json(res, 200, { ok: true, written: list.length });
    return true;
  }

  // ─── proxies ───
  if (path === "/api/proxy/test" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, await testProxies(body.proxies || [], { timeoutMs: Math.min(20000, Number(body.timeoutMs) || 8000) }));
    return true;
  }

  // ─── updates ───
  if (path === "/api/update/config" && method === "GET") {
    json(res, 200, { ok: true, ...publicConfig() });
    return true;
  }
  if (path === "/api/update/config" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, { ok: true, ...saveUpdateConfig({ token: body.token, repo: body.repo, branch: body.branch }) });
    return true;
  }
  if (path === "/api/update/check" && method === "GET") {
    json(res, 200, await checkForUpdate());
    return true;
  }
  if (path === "/api/update/apply" && method === "POST") {
    if (applying) {
      json(res, 200, { ok: false, error: "An update is already running" });
      return true;
    }
    applying = true;
    try {
      const r = await applyUpdate();
      console.log(`[update] ${r.ok ? `applied ${r.to} · ${r.changed} file(s)` : `failed: ${r.error}`}`);
      json(res, 200, r);
    } finally {
      applying = false;
    }
    return true;
  }

  // ─── accounts ───
  if (path === "/api/accounts/history" && method === "GET") {
    const days = Math.min(365, Number(q("days")) || 90);
    json(res, 200, { ok: true, events: loginHistory({ sinceMs: Date.now() - days * 86400_000 }) });
    return true;
  }

  // ─── orders ───
  if (path === "/api/orders/scan-email" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, await scanOrderEmails({ user: body.user, pass: body.pass, host: body.host, days: Math.min(120, Number(body.days) || 30) }));
    return true;
  }

  // ─── channels ───
  if (path === "/api/notify/telegram" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, await sendTelegram(body));
    return true;
  }
  if (path === "/api/notify/email" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, await sendEmail(body));
    return true;
  }

  // ─── remote control ───
  if (path === "/api/remote/status" && method === "GET") {
    json(res, 200, { ok: true, ...remotePublic() });
    return true;
  }
  if (path === "/api/remote/config" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, { ok: true, ...setRemoteConfig({ enabled: Boolean(body.enabled), token: body.token, chatId: body.chatId }) });
    return true;
  }
  if (path === "/api/remote/pending" && method === "GET") {
    json(res, 200, { ok: true, commands: takePending() });
    return true;
  }
  if (path === "/api/remote/reply" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, await remoteReply(body.chatId, body.text));
    return true;
  }

  // ─── drops ───
  if (path === "/api/drops/import-url" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, await fetchImportText(body.url));
    return true;
  }

  return false;
}
