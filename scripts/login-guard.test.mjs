import test from "node:test";
import assert from "node:assert/strict";
import { guardedLogin, loginGuardStatus, clearLoginPause, _resetLoginGuard, pauseFor } from "./login-guard.mjs";
import { coalesceMonitor, monitorKey, _resetCoalesce, monitorCoalesceStats } from "./monitor-coalesce.mjs";
import { manualExpiry } from "./manual-login.mjs";

const noJar = { loadCookies: () => null };

test("manual session is used first, without running the automatic login", async () => {
  _resetLoginGuard();
  let ran = 0;
  const deps = { loadCookies: ({ taskId }) => (taskId === "manual:target:a@b.com" ? { source: "manual", store: "Target", cookies: [{ name: "x", value: "1" }], expiresAt: Date.now() + 3600_000 } : null) };
  const r = await guardedLogin("Target", { email: "A@b.com" }, async () => (ran++, { ok: true }), deps);
  assert.equal(r.ok, true);
  assert.equal(r.manual, true);
  assert.equal(ran, 0);
  // forceLogin skips it
  await guardedLogin("Target", { email: "a@b.com", forceLogin: true }, async () => (ran++, { ok: true }), deps);
  assert.equal(ran, 1);
});

test("manual session of another store or expired is ignored", async () => {
  _resetLoginGuard();
  let ran = 0;
  const deps = { loadCookies: () => ({ source: "manual", store: "Walmart", cookies: [{ name: "x" }], expiresAt: Date.now() + 3600_000 }) };
  await guardedLogin("Target", { email: "a@b.com" }, async () => (ran++, { ok: true }), deps);
  const deps2 = { loadCookies: () => ({ source: "manual", store: "Target", cookies: [{ name: "x" }], expiresAt: Date.now() + 10_000 }) };
  await guardedLogin("Target", { email: "a@b.com" }, async () => (ran++, { ok: true }), deps2);
  assert.equal(ran, 2);
});

test("one login at a time per account", async () => {
  _resetLoginGuard();
  let ran = 0;
  const run = () => new Promise((res) => setTimeout(() => (ran++, res({ ok: true })), 30));
  const rs = await Promise.all([1, 2, 3].map(() => guardedLogin("Walmart", { email: "a@b.com", password: "x" }, run, noJar)));
  assert.equal(ran, 1);
  assert.equal(rs.filter((r) => r.sharedLogin).length, 2);
});

test("wrong password pauses automatic logins, unpause clears it", async () => {
  _resetLoginGuard();
  let ran = 0;
  const run = async () => (ran++, { ok: false, error: "Incorrect password" });
  const r1 = await guardedLogin("Target", { email: "a@b.com", password: "x" }, run, noJar);
  assert.equal(r1.errorCode, "WRONG_PASSWORD");
  assert.ok(r1.pausedUntil > Date.now());
  const r2 = await guardedLogin("Target", { email: "a@b.com", password: "x" }, run, noJar);
  assert.equal(r2.errorCode, "LOGIN_PAUSED");
  assert.equal(ran, 1);
  assert.equal(loginGuardStatus()["target|a@b.com"].errorCode, "WRONG_PASSWORD");
  assert.equal(clearLoginPause("Target", "a@b.com"), true);
  await guardedLogin("Target", { email: "a@b.com", password: "x" }, run, noJar);
  assert.equal(ran, 2);
  assert.equal(pauseFor("TIMEOUT"), 0);
});

test("monitor requests are shared", async () => {
  _resetCoalesce();
  let calls = 0;
  const fn = () => new Promise((r) => setTimeout(() => (calls++, r({ ok: true, inStock: false })), 20));
  const k = monitorKey("target", { tcin: "123", proxy: "p" });
  const rs = await Promise.all([coalesceMonitor(k, fn), coalesceMonitor(k, fn)]);
  assert.equal(calls, 1);
  assert.equal(rs[1].shared, true);
  await coalesceMonitor(k, fn); // within ttl
  assert.equal(calls, 1);
  await coalesceMonitor(monitorKey("target", { tcin: "123", proxy: "other" }), fn);
  assert.equal(calls, 2);
  assert.equal(monitorCoalesceStats().shared, 2);
  await coalesceMonitor(k, fn, { ttlMs: 0 });
  assert.equal(calls, 3);
});

test("manualExpiry uses auth cookie expiry, capped", () => {
  const now = 1_000_000_000_000;
  assert.equal(manualExpiry([], now), now + 12 * 3600_000);
  assert.equal(manualExpiry([{ name: "accessToken", expires: (now + 3600_000) / 1000 }], now), now + 3600_000);
  assert.equal(manualExpiry([{ name: "accessToken", expires: (now + 30 * 86400_000) / 1000 }], now), now + 3 * 86400_000);
});
