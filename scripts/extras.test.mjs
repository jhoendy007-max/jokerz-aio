import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

process.env.JOKERZ_LOG_DIR = mkdtempSync(join(tmpdir(), "jl-"));
const { createZip, crc32 } = await import("./zip-lite.mjs");
const { redact, writeLog, searchLogs, listLogFiles, dayOf } = await import("./file-log.mjs");
const { testOneProxy, testProxies, maskProxy } = await import("./proxy-test.mjs");
const { parseOrderEmail, orderStatus, decodeMimeWords, splitFetch } = await import("./order-email.mjs");
const { parseCommand } = await import("./remote-control.mjs");
const { isProtected } = await import("./updater.mjs");
const { buildMime, resolveSmtp, telegramText } = await import("./notify-channels.mjs");
const { fetchImportText } = await import("./aio-api-extra.mjs");

test("zip: valid structure, crc, deflate round-trip", () => {
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
  const z = createZip([{ name: "a.txt", data: "hello hello hello" }, { name: "dir/b.log", data: Buffer.from("x".repeat(1000)) }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
  assert.equal(z.readUInt16LE(z.length - 12), 2);
  const nameLen = z.readUInt16LE(26);
  const compLen = z.readUInt32LE(18);
  const data = inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + compLen)).toString();
  assert.equal(data, "hello hello hello");
});

test("logs: redact secrets, write + search", () => {
  const r = redact('hook https://discord.com/api/webhooks/123/abcDEF_secret pass "password":"hunter2" card 4111 1111 1111 1234 proxy http://user:pw@1.2.3.4:80');
  assert.ok(!r.includes("abcDEF_secret"));
  assert.ok(!r.includes("hunter2"));
  assert.ok(r.includes("4111********1234"));
  assert.ok(!r.includes(":pw@"));
  const r2 = redact("Login failed password=hunter2 token: abc123 url?token=zz&x=1 \x1b[32mgreen\x1b[0m");
  assert.ok(!r2.includes("hunter2") && !r2.includes("abc123") && !r2.includes("zz&"), r2);
  assert.ok(r2.includes("green") && !r2.includes("\x1b"));
  assert.equal(redact("Wrong email or password"), "Wrong email or password");
  writeLog("info", "server", "monitor started");
  writeLog("warn", "task", "HTTP 429 on Target");
  assert.equal(listLogFiles()[0].day, dayOf());
  assert.equal(searchLogs({ q: "429" }).length, 1);
  assert.equal(searchLogs({ level: "info" })[0].msg, "monitor started");
  assert.equal(searchLogs({ source: "task" }).length, 1);
});

test("proxy test with fake network", async () => {
  const deps = {
    fetchText: async (_u, { proxy }) => (proxy.startsWith("bad") ? Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })) : { status: 200, text: '{"ip":"9.9.9.9"}' }),
    geoForProxy: async () => ({ country: "United States", city: "Ashburn" }),
  };
  const ok = await testOneProxy("1.2.3.4:8080:user:pass", { deps });
  assert.equal(ok.ok, true);
  assert.equal(ok.exitIp, "9.9.9.9");
  assert.equal(ok.country, "United States");
  assert.equal(ok.display, "1.2.3.4:8080 · user ***");
  const r = await testProxies(["1.2.3.4:8080", "bad.host:1", "nonsense"], { deps });
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 2);
  assert.match(r.results.find((x) => x.proxy === "bad.host:1").error, /Timeout/);
  assert.equal(maskProxy("h:1"), "h:1");
});

test("order emails", () => {
  const t = parseOrderEmail({ from: "Target <orders@oe.target.com>", subject: "Thanks for your order!", date: "Mon, 05 Oct 2026 10:00:00 -0400", body: "Order #912003456789 Order total $35.99" });
  assert.equal(t.store, "Target");
  assert.equal(t.orderNumber, "912003456789");
  assert.equal(t.status, "confirmed");
  assert.equal(t.total, "$35.99");
  const w = parseOrderEmail({ from: "help@walmart.com", subject: "Your order has shipped", body: "Order number: 2000123-45678901" });
  assert.equal(w.orderNumber, "2000123-45678901");
  assert.equal(w.status, "shipped");
  assert.equal(parseOrderEmail({ from: "news@target.com", subject: "Weekly deals", body: "save big" }), null);
  assert.equal(parseOrderEmail({ from: "a@gmail.com", subject: "order #123456789", body: "" }), null);
  assert.equal(orderStatus("Order confirmed", "tracking will follow"), "confirmed");
  assert.equal(orderStatus("Your package was delivered"), "delivered");
  assert.equal(decodeMimeWords("=?UTF-8?B?SGVsbG8=?="), "Hello");
  const msgs = splitFetch('* 1 FETCH (UID 5 BODY[HEADER] {50}\r\nFrom: a@target.com\r\nSubject: Order\r\n\r\nbody one)\r\n* 2 FETCH (UID 6 {10}\r\nFrom: b@walmart.com\r\nSubject: Shipped\r\n)\r\nF0 OK done');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].from, "b@walmart.com");
});

test("telegram commands", () => {
  assert.deepEqual(parseCommand("/status"), { cmd: "status", args: "" });
  assert.deepEqual(parseCommand("/start@JokerzBot target"), { cmd: "start", args: "target" });
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand("/rm -rf").cmd, "unknown");
  assert.ok(telegramText({ title: "<b>x", lines: ["a & b"] }).includes("&lt;b&gt;x"));
});

test("updater never overwrites user data", () => {
  for (const p of ["node_modules/x.js", "server/.cookie-jars.json", "logs/a.log", ".env", ".env.local", "backups/u/x", ".git/HEAD", ".jokerz-version"]) assert.equal(isProtected(p), true, p);
  for (const p of ["src/jokerz/App.tsx", "scripts/aio-api.mjs", "package.json", "server/README.md"]) assert.equal(isProtected(p), false, p);
});

test("email helpers", () => {
  assert.deepEqual(resolveSmtp("me@gmail.com"), { host: "smtp.gmail.com", port: 465 });
  assert.equal(resolveSmtp("me@outlook.com").port, 587);
  const m = buildMime({ from: "a@b.com", to: "c@d.com", subject: "Restock ✓", text: "hi" });
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.match(m, /Content-Transfer-Encoding: base64/);
});

test("drop import blocks local addresses", async () => {
  assert.equal((await fetchImportText("http://127.0.0.1:8787/x")).ok, false);
  assert.equal((await fetchImportText("file:///etc/passwd")).ok, false);
  assert.equal((await fetchImportText("not a url")).ok, false);
});

test.after(() => rmSync(process.env.JOKERZ_LOG_DIR, { recursive: true, force: true }));
