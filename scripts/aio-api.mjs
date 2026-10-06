#!/usr/bin/env node
/**
 * Lightweight AIO API for the Grok preview.
 * Served in-process on :8080 (/api and /jokerz-api) AND optionally :8787.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { checkTargetShipping } from "./target-monitor.mjs";
import { checkWalmartShipping } from "./walmart-monitor.mjs";
import { checkPokemonStock } from "./pokemon-monitor.mjs";
import { checkBandaiStock } from "./bandai-monitor.mjs";
import { lookupProductImage } from "./product-image.mjs";
import { runWalmartCheckout, runWalmartLogin } from "./walmart-checkout.mjs";
import { runWalmartDrawing } from "./walmart-drawing.mjs";
import { runPokemonCheckout } from "./pokemon-checkout.mjs";
import { runBandaiCheckout } from "./bandai-checkout.mjs";
import { detectCaptcha } from "./captcha-detect.mjs";
import {
  runTargetLogin,
  getLoginJob,
  listLoginSessions,
  clearLoginSession,
  runTargetKeepAlive,
} from "./target-login.mjs";
import { runTargetCheckout } from "./target-checkout.mjs";
import { runTargetAccGen } from "./target-accgen.mjs";
import { runCheckoutSelfTest } from "./checkout-test.mjs";
import { testImapLogin } from "./otp-inbox.mjs";
import { lockedAdvancedTls, probeAdvancedTls } from "./tls-advanced.mjs";
import {
  persistCookies,
  loadCookies,
  clearCookies,
  listCookieJars,
  toCookieHeader,
} from "./cookie-persist.mjs";
import {
  enqueueHarvest,
  injectShape,
  resetShapeBank,
  configureBank,
  publicShapeBank,
  closeHarvestSessionsFor,
  closeAllHarvestSessions,
} from "./shape-bank.mjs";

const PORT = Number(process.env.AIO_API_PORT || 8787);
const HOST = process.env.AIO_API_HOST || "127.0.0.1";

const TARGET_TCINS = [
  "14753310",
  "12953964",
  "76130492",
  "54362597",
  "81827799",
  "13329207",
];

const bank = {
  count: 0,
  targetSize: 20,
  ttlMinutes: 30,
  harvesting: false,
  continuous: false,
  activity: [],
  separation: { targetShapeLogin: 0, targetShapeAtc: 0 },
  workers: {},
};

function publicBank() {
  const sh = publicShapeBank();
  bank.count = sh.count;
  bank.targetSize = sh.targetSize || bank.targetSize;
  bank.ttlMinutes = sh.ttlMinutes || bank.ttlMinutes;
  bank.separation = sh.separation;
  return {
    count: bank.count,
    targetSize: bank.targetSize,
    ttlMinutes: bank.ttlMinutes,
    harvesting: bank.harvesting,
    continuous: bank.continuous,
    activity: bank.activity,
    separation: bank.separation,
    workers: Object.values(bank.workers).map(({ timer, loop, ...rest }) => rest),
  };
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "cache-control": "no-store",
  });
  res.end(data);
}

function pushActivity(level, message, harvesterId) {
  bank.activity.unshift({ ts: Date.now(), level, message, harvesterId });
  bank.activity = bank.activity.slice(0, 120);
}

function kindOf(module) {
  const m = String(module || "").toLowerCase();
  return m.includes("login") ? "login" : "atc";
}

function stepsOf(kind) {
  return kind === "login"
    ? ["proxy", "home", "account", "fake_email", "capture", "reset"]
    : ["proxy", "home", "pdp", "atc", "capture", "reset"];
}

function bankFull() {
  return bank.count >= bank.targetSize;
}

function stopWorker(id, reason) {
  const w = bank.workers[id];
  if (!w) return;
  if (w.timer) clearInterval(w.timer);
  w.timer = null;
  w.running = false;
  w.status = "idle";
  w.step = reason === "full" ? "full" : "idle";
  void closeHarvestSessionsFor(id).catch(() => {});
  void closeHarvestSessionsFor(String(id).startsWith("task-") ? id.slice(5) : id).catch(() => {});
}

async function harvestLoop(id) {
  const w = bank.workers[id];
  while (w && w.running) {
    const sh = publicShapeBank();
    const taskBound = String(id).startsWith("task-");
    if (taskBound && (w.cookieCount || 0) >= 2) {
      stopWorker(id, "full");
      pushActivity("success", `${w.name} · 2 cookies on this ISP · harvest paused`, id);
      break;
    }
    if (!taskBound && sh.count >= (sh.targetSize || bank.targetSize)) {
      stopWorker(id, "full");
      pushActivity("success", `${w.name} · bank full ${sh.count}/${sh.targetSize}`, id);
      bank.harvesting = Object.values(bank.workers).some((x) => x.running);
      break;
    }
    w.step = w.kind === "login" ? "account" : "pdp";
    w.status = "running";
    pushActivity("info", `${w.name} · headed Chrome · Shape+_px3 · ${w.kind === "login" ? "login" : "ATC / Ship it"}`, id);
    let harvested = false;
    try {
      const r = await enqueueHarvest({
        kind: w.kind,
        proxy: w.proxy,
        headed: true,
        module: w.module,
        taskId: String(id).startsWith("task-") ? id.slice(5) : id,
      });
      if (r.ok) {
        harvested = true;
        w.cookieCount = (w.cookieCount || 0) + 1;
        w.step = "capture";
        const after = publicShapeBank();
        pushActivity(
          "success",
          `${w.name} · ${r.grade || "live"} · _abck~${r.abckFlag || "-"} PX=${r.pxValid ? "yes" : "no"} · bank ${after.valid ?? after.count}/${after.targetSize}`,
          id
        );
      } else {
        w.step = "reset";
        pushActivity("warn", `${w.name} · harvest fail · ${r.error || "unknown"}`, id);
      }
    } catch (e) {
      pushActivity("error", `${w.name} · ${e?.message || e}`, id);
    }
    w.step = "reset";
    await new Promise((ok) => setTimeout(ok, harvested ? 400 : 1100));
  }
}

function startWorker(spec) {
  const id = String(spec.id || `h-${Date.now()}`);
  const kind = kindOf(spec.module);
  const prev = bank.workers[id];
  if (prev?.timer) clearInterval(prev.timer);
  prev && (prev.running = false);
  const w = {
    id,
    name: spec.name || id.slice(0, 8),
    module: spec.module || "target-shape",
    kind,
    proxy: spec.proxy || "",
    status: "running",
    step: "idle",
    running: true,
    cookieCount: prev?.cookieCount || 0,
    timer: null,
  };
  bank.workers[id] = w;
  bank.harvesting = true;
  bank.continuous = true;
  pushActivity("success", `${w.name} · Shape harvest REAL · ${kind.toUpperCase()}`, id);
  void harvestLoop(id);
  return w;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function normalizePath(rawPath) {
  let path = rawPath || "/";
  if (path.startsWith("/jokerz-api")) {
    path = path.slice("/jokerz-api".length) || "/";
  }
  return path;
}

export function isAioApiPath(url) {
  const path = (url || "").split("?")[0];
  return (
    path === "/health" ||
    path.startsWith("/api/") ||
    path === "/api" ||
    path === "/jokerz-api" ||
    path.startsWith("/jokerz-api/")
  );
}

export async function handleAioApi(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = normalizePath(url.pathname);
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    json(res, 204, { ok: true });
    return true;
  }

  if ((path === "/health" || path === "/api/health") && method === "GET") {
    json(res, 200, {
      ok: true,
      service: "jokerz-aio-api",
      preview: 8080,
      api: PORT,
      harvest: "refract",
      ts: Date.now(),
    });
    return true;
  }

  if (path === "/api/captcha/detect" && method === "POST") {
    const body = await readBody(req);
    json(res, 200, { ok: true, ...detectCaptcha(body) });
    return true;
  }

  if (
    (path === "/api/target/login" ||
      path === "/api/target/oauth2/login" ||
      path === "/api/target/session") &&
    method === "POST"
  ) {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || body.email || `login-${Date.now()}`);
    body.sessionId = sessionId;
    if (body.async) {
      runTargetLogin(body).catch((e) => console.error("[login]", e));
      json(res, 200, { ok: true, started: true, sessionId });
      return true;
    }
    try {
      const result = await runTargetLogin(body);
      json(res, 200, result);
    } catch (e) {
      json(res, 200, { ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/target/keepalive" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await runTargetKeepAlive(body));
    } catch (e) {
      json(res, 200, { ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/account-gen" && method === "POST") {
    const body = await readBody(req);
    try {
      const mod = String(body.module || "target").toLowerCase();
      if (mod !== "target") {
        json(res, 200, {
          ok: false,
          stage: "error",
          message: `${mod} acc-gen not in this build — Target only for now`,
        });
        return true;
      }
      json(res, 200, await runTargetAccGen(body));
    } catch (e) {
      json(res, 200, { ok: false, stage: "error", message: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/checkout/target" && method === "POST") {
    const body = await readBody(req);
    try {
      const result = await runTargetCheckout(body);
      json(res, 200, result);
    } catch (e) {
      json(res, 200, {
        ok: false,
        stage: "error",
        error: e?.message || String(e),
        message: e?.message || String(e),
      });
    }
    return true;
  }

  if (path === "/api/test/checkout" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await runCheckoutSelfTest(body));
    } catch (e) {
      json(res, 200, { ok: false, pass: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/imap/test" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await testImapLogin(body));
    } catch (e) {
      json(res, 200, { ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/cookies" && method === "GET") {
    const taskId = url.searchParams.get("taskId") || "";
    const email = url.searchParams.get("email") || "";
    const jar = loadCookies({ taskId, email });
    json(res, 200, {
      ok: true,
      jar: jar
        ? {
            taskId: jar.taskId,
            email: jar.email,
            store: jar.store,
            cookieCount: (jar.cookies || []).length,
            at: jar.at,
            header: toCookieHeader(jar.cookies),
          }
        : null,
      jars: listCookieJars(),
    });
    return true;
  }

  if (path === "/api/cookies/save" && method === "POST") {
    const body = await readBody(req);
    const jar = persistCookies({
      taskId: body.taskId || body.sessionId,
      email: body.email,
      cookies: body.cookies || [],
      proxy: body.proxy,
      store: body.store || "Target",
    });
    json(res, 200, { ok: true, cookieCount: (jar.cookies || []).length, taskId: jar.taskId });
    return true;
  }

  if (path === "/api/cookies/clear" && method === "POST") {
    const body = await readBody(req);
    clearCookies({ taskId: body.taskId || body.sessionId, email: body.email });
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/target/login/status" && method === "GET") {
    const id = url.searchParams.get("id") || url.searchParams.get("sessionId") || "";
    json(res, 200, { ok: true, job: getLoginJob(id), sessions: listLoginSessions() });
    return true;
  }

  if (path === "/api/target/sessions" && method === "GET") {
    json(res, 200, { ok: true, sessions: listLoginSessions() });
    return true;
  }

  if (
    (path === "/api/target/oauth2/sessions" || path === "/api/target/oauth2/sessions/validate") &&
    method === "GET"
  ) {
    json(res, 200, { ok: true, sessions: listLoginSessions(), count: Object.keys(listLoginSessions() || {}).length });
    return true;
  }

  if (
    (path === "/api/target/oauth2/renew" ||
      path === "/api/target/oauth2/refresh" ||
      path === "/api/target/oauth2/sessions/renew-all" ||
      path === "/api/target/oauth2/sessions/clear" ||
      path === "/api/target/oauth2/sessions/validate") &&
    method === "POST"
  ) {
    json(res, 200, { ok: true, sessions: listLoginSessions(), note: "preview oauth stub" });
    return true;
  }

  if (path === "/api/target/session/clear" && method === "POST") {
    const body = await readBody(req);
    clearLoginSession(body.email);
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/api/product-image" && method === "GET") {
    try {
      json(res, 200, await lookupProductImage({
        store: url.searchParams.get("store") || "",
        product: url.searchParams.get("product") || "",
      }));
    } catch (e) {
      json(res, 200, { ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/monitor/target" && method === "POST") {
    const body = await readBody(req);
    const tcin = String(body.tcin || body.sku || "").replace(/\D/g, "");
    try {
      const result = await checkTargetShipping({
        tcin,
        zip: body.zip || body.postal || "",
        proxy: body.proxy,
      });
      json(res, 200, result);
    } catch (e) {
      json(res, 200, {
        ok: false,
        inStock: false,
        tcin,
        error: e?.message || String(e),
      });
    }
    return true;
  }

  if (path === "/api/monitor/walmart" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await checkWalmartShipping({ sku: body.sku || body.product || body.tcin, proxy: body.proxy }));
    } catch (e) {
      json(res, 200, { ok: false, inStock: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/monitor/pokemon" && method === "POST") {
    const body = await readBody(req);
    try {
      json(
        res,
        200,
        await checkPokemonStock({ url: body.url, product: body.product || body.sku, region: body.region, proxy: body.proxy })
      );
    } catch (e) {
      json(res, 200, { ok: false, inStock: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/monitor/bandai" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await checkBandaiStock({ url: body.url, product: body.product || body.sku, proxy: body.proxy }));
    } catch (e) {
      json(res, 200, { ok: false, inStock: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/walmart/drawing" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await runWalmartDrawing(body));
    } catch (e) {
      json(res, 200, { ok: false, stage: "error", message: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/walmart/login" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await runWalmartLogin(body));
    } catch (e) {
      json(res, 200, { ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/checkout/walmart" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await runWalmartCheckout(body));
    } catch (e) {
      json(res, 200, { ok: false, stage: "error", message: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/checkout/pokemon" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await runPokemonCheckout(body));
    } catch (e) {
      json(res, 200, { ok: false, stage: "error", message: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/checkout/bandai" && method === "POST") {
    const body = await readBody(req);
    try {
      json(res, 200, await runBandaiCheckout(body));
    } catch (e) {
      json(res, 200, { ok: false, stage: "error", message: e?.message || String(e) });
    }
    return true;
  }

  if (path === "/api/harvest/bank" && method === "GET") {
    json(res, 200, { ok: true, ...publicBank() });
    return true;
  }

  if (path === "/api/harvest/bank/inject" && method === "POST") {
    const body = await readBody(req);
    const result = injectShape({
      sessionId: body.sessionId || body.taskId,
      email: body.email || body.accountEmail,
      module: body.module || "target-shape",
      consume: body.consume === true,
      cooldownMs: Number(body.cooldownMs) || 8000,
      proxy: body.proxy,
      requireSameProxy: body.requireSameProxy !== false,
    });
    json(res, result.ok ? 200 : 404, result);
    return true;
  }

  if (path === "/api/harvest/bank/config" && method === "POST") {
    const body = await readBody(req);
    if (body.targetSize) bank.targetSize = Number(body.targetSize) || bank.targetSize;
    if (body.ttlMinutes) bank.ttlMinutes = Number(body.ttlMinutes) || bank.ttlMinutes;
    configureBank({ targetSize: bank.targetSize, ttlMinutes: bank.ttlMinutes });
    pushActivity("info", `Bank · size ${bank.targetSize} · ttl ${bank.ttlMinutes}m`);
    json(res, 200, { ok: true, ...publicBank() });
    return true;
  }

  if (path === "/api/harvest/bank/start" && method === "POST") {
    const body = await readBody(req);
    if (body.targetSize) bank.targetSize = Number(body.targetSize) || bank.targetSize;
    if (body.ttlMinutes) bank.ttlMinutes = Number(body.ttlMinutes) || bank.ttlMinutes;
    configureBank({ targetSize: bank.targetSize, ttlMinutes: bank.ttlMinutes });
    const workers = Array.isArray(body.workers) ? body.workers : [];
    if (workers.length === 0) {
      startWorker({
        id: "default-atc",
        name: "Target ATC",
        module: "target-shape",
        proxy: Array.isArray(body.proxies) ? body.proxies[0] : "",
      });
    } else {
      for (const spec of workers) startWorker(spec);
    }
    json(res, 200, { ok: true, ...publicBank(), note: "Shape harvest REAL · headed Chrome · bank on disk" });
    return true;
  }

  if (path === "/api/harvest/bank/stop" && method === "POST") {
    for (const id of Object.keys(bank.workers)) stopWorker(id);
    bank.harvesting = false;
    bank.continuous = false;
    void closeAllHarvestSessions().catch(() => {});
    pushActivity("info", "All harvesters stopped");
    json(res, 200, { ok: true, ...publicBank() });
    return true;
  }

  if (path === "/api/harvest/bank/reset" && method === "POST") {
    bank.count = 0;
    bank.separation = { targetShapeLogin: 0, targetShapeAtc: 0 };
    for (const w of Object.values(bank.workers)) w.cookieCount = 0;
    resetShapeBank();
    pushActivity("warn", "Cookie bank wiped · start from 0");
    json(res, 200, { ok: true, ...publicBank() });
    return true;
  }

  if (path === "/api/harvest/worker/start" && method === "POST") {
    const body = await readBody(req);
    const w = startWorker(body);
    json(res, 200, { ok: true, worker: { ...w, timer: undefined }, ...publicBank() });
    return true;
  }

  if (path === "/api/harvest/worker/stop" && method === "POST") {
    const body = await readBody(req);
    const id = String(body.id || body.harvesterId || "");
    stopWorker(id);
    bank.harvesting = Object.values(bank.workers).some((x) => x.running);
    pushActivity("info", `Stopped ${id.slice(0, 8)}`);
    json(res, 200, { ok: true, ...publicBank() });
    return true;
  }

  if (path === "/api/harvest/task-bind" && method === "POST") {
    const body = await readBody(req);
    const taskId = String(body.taskId || body.sessionId || "");
    if (!taskId) {
      json(res, 200, { ok: false, error: "taskId required" });
      return true;
    }
    const proxy = String(body.proxy || "");
    const hint = proxy ? proxy.split("@").pop() || proxy : "local";
    const w = startWorker({
      id: `task-${taskId}`,
      name: body.name || `Task ${taskId.slice(0, 6)}`,
      module: body.module || "target-shape",
      proxy,
    });
    pushActivity("success", `${w.name} · bound harvest → ${hint}`, w.id);
    json(res, 200, {
      ok: true,
      workerId: w.id,
      proxy: hint,
      message: `harvest bound to this task ISP · ${hint}`,
    });
    return true;
  }

  if (path === "/api/harvest/task-unbind" && method === "POST") {
    const body = await readBody(req);
    const taskId = String(body.taskId || body.sessionId || "");
    const id = `task-${taskId}`;
    stopWorker(id);
    bank.harvesting = Object.values(bank.workers).some((x) => x.running);
    pushActivity("info", `Unbound harvest ${taskId.slice(0, 8)}`, id);
    json(res, 200, { ok: true, ...publicBank() });
    return true;
  }

  if (path === "/api/harvest/shape" && method === "POST") {
    const body = await readBody(req);
    const w = startWorker({
      id: body.harvesterId || body.id || `once-${Date.now()}`,
      name: body.name || "Harvester",
      module: body.module || "target-shape",
      proxy: body.proxy,
    });
    json(res, 200, {
      ok: true,
      cookieCount: w.cookieCount,
      bankCount: bank.count,
      bankTarget: bank.targetSize,
      note: "Started Refract loop for this worker",
    });
    return true;
  }

  if (path === "/api/fingerprint/tls/config" && method === "GET") {
    json(res, 200, { ok: true, locked: true, modules: lockedAdvancedTls() });
    return true;
  }

  if (path.startsWith("/api/fingerprint/") && (method === "POST" || method === "GET")) {
    const body = method === "POST" ? await readBody(req) : {};
    json(res, 200, probeAdvancedTls(body.profile || body.tlsClient || body.store));
    return true;
  }

  if (path === "/api/metrics/retries" && method === "GET") {
    json(res, 200, { ok: true, retries: 0, wins: 0, via: "preview" });
    return true;
  }

  json(res, 404, { ok: false, error: `No route ${method} ${path}` });
  return true;
}

export function aioApiVitePlugin() {
  return {
    name: "jokerz-aio-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (!isAioApiPath(req.url || "")) {
            next();
            return;
          }
          await handleAioApi(req, res);
        } catch (err) {
          console.error("[jokerz-api] middleware", err);
          if (!res.headersSent) {
            json(res, 500, { ok: false, error: String(err?.message || err) });
          }
        }
      });
    },
  };
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = http.createServer((req, res) => {
    handleAioApi(req, res).catch((e) => {
      console.error("[jokerz-api]", e);
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e?.message || e) });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`[jokerz-api] ${HOST}:${PORT} · also mounted on preview :8080 /api + /jokerz-api`);
  });
}
