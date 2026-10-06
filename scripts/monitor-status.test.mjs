import test from "node:test";
import assert from "node:assert/strict";
import { monitorState, withMonitorState, classifyLoginError, withLoginError } from "./monitor-status.mjs";
import { validateProductInput, probeProduct } from "./product-probe.mjs";
import { sessionState, storeKey } from "./manual-login.mjs";

test("monitorState: one state per situation", () => {
  const S = (r) => monitorState("Walmart", r).state;
  assert.equal(S({ inStock: true, price: "$5" }), "IN_STOCK");
  assert.equal(S({ inStock: false, availabilityStatus: "OUT_OF_STOCK" }), "OUT_OF_STOCK");
  assert.equal(S({ inQueue: true }), "QUEUE");
  assert.equal(S({ rateLimited: true, retryAfterMs: 30000 }), "RATE_LIMITED");
  assert.match(monitorState("Walmart", { rateLimited: true, retryAfterMs: 30000 }).reason, /30s/);
  assert.equal(S({ blocked: true }), "BLOCKED");
  assert.equal(S({ availabilityStatus: "DATADOME" }), "BLOCKED");
  assert.equal(S({ error: "No Walmart item id" }), "NOT_FOUND");
  assert.equal(S({ error: "HTTP 404" }), "NOT_FOUND");
  assert.equal(S({ error: "The operation was aborted" }), "ERROR");
  assert.match(monitorState("Walmart", { error: "fetch failed ECONNREFUSED" }).reason, /Network/);
  assert.equal(S({ inStock: false, availabilityStatus: "UNKNOWN" }), "UNKNOWN");
  assert.equal(S(null), "ERROR");
});

test("withMonitorState keeps fields and existing state", () => {
  const r = withMonitorState("Target", { inStock: true, title: "X" });
  assert.equal(r.title, "X");
  assert.equal(r.state, "IN_STOCK");
  assert.equal(withMonitorState("Target", { state: "QUEUE", inStock: true }).state, "QUEUE");
});

test("classifyLoginError", () => {
  const C = (t) => classifyLoginError(t).errorCode;
  assert.equal(C("Missing email/password"), "MISSING_CREDENTIALS");
  assert.equal(C("Your password is incorrect"), "WRONG_PASSWORD");
  assert.equal(C("Enter the verification code we sent"), "NEEDS_2FA");
  assert.equal(C("Account locked — reset your password"), "ACCOUNT_LOCKED");
  assert.equal(C("HTTP 429 Too Many Requests"), "RATE_LIMITED");
  assert.equal(C("px-captcha press and hold"), "BLOCKED");
  assert.equal(C("page.goto: Timeout 40000ms exceeded"), "TIMEOUT");
  assert.equal(C("net::ERR_PROXY_CONNECTION_FAILED"), "NETWORK");
  assert.equal(C("weird"), "UNKNOWN");
  assert.equal(withLoginError({ ok: true }).errorCode, undefined);
  assert.equal(withLoginError({ ok: false, error: "x", steps: [{ message: "Wrong password" }] }).errorCode, "WRONG_PASSWORD");
});

test("validateProductInput per store", () => {
  assert.equal(validateProductInput("Target", "93954446").id, "93954446");
  assert.equal(validateProductInput("Target", "https://www.target.com/p/x/-/A-93954446").id, "93954446");
  assert.equal(validateProductInput("Target", "abc").ok, false);
  assert.equal(validateProductInput("Walmart", "https://www.walmart.com/ip/foo/5056010573").id, "5056010573");
  assert.equal(validateProductInput("Walmart", "hello").ok, false);
  assert.equal(validateProductInput("Pokemon Center", "https://evil.com/x").ok, false);
  assert.equal(validateProductInput("Nope", "1").ok, false);
});

test("probeProduct uses the store monitor once and normalizes", async () => {
  let calls = 0;
  const r = await probeProduct(
    { store: "Walmart", product: "5056010573" },
    { noImage: true, run: async () => { calls++; return { inStock: false, availabilityStatus: "OUT_OF_STOCK", title: "Box", price: "$143.64", html: "x".repeat(2000) }; } },
  );
  assert.equal(calls, 1);
  assert.equal(r.state, "OUT_OF_STOCK");
  assert.equal(r.title, "Box");
  assert.ok(r.raw.html.length < 500);
  const bad = await probeProduct({ store: "Target", product: "abc" }, { run: async () => assert.fail("should not call") });
  assert.equal(bad.state, "NOT_FOUND");
});

test("sessionState + storeKey", () => {
  const now = 1_000_000_000;
  assert.equal(sessionState({ cookieCount: 5, expiresAt: now + 5 * 3600_000 }, now).state, "active");
  assert.equal(sessionState({ cookieCount: 5, expiresAt: now + 30 * 60_000 }, now).state, "expiring");
  assert.equal(sessionState({ cookieCount: 5, expiresAt: now - 1 }, now).state, "expired");
  assert.equal(sessionState({ cookieCount: 0 }, now).state, "expired");
  assert.equal(storeKey("Pokemon Center"), "pokemon");
});
