import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApi, MonitorResponseSchema, ApiResponseSchema, rateLimitWaitMs, rlFields, stockFromMonitor } from './apiTypes.ts';

const res = (body: unknown, status = 200) => ({
  status,
  json: () => (typeof body === 'string' ? JSON.parse(body) : body),
});

test('parseApi: coerces price numbers and string booleans', () => {
  const d = parseApi(MonitorResponseSchema, res({ ok: 'true', inStock: true, price: 19.5, retryAfterMs: '3000', extra: 1 }));
  assert.equal(d.ok, true);
  assert.equal(d.price, '$19.50');
  assert.equal(d.retryAfterMs, 3000);
  assert.equal(d.extra, 1);
});

test('parseApi: bad JSON never throws', () => {
  const d = parseApi(ApiResponseSchema, { status: 502, json: () => { throw new Error('x'); } });
  assert.equal(d.ok, false);
  assert.match(String(d.error), /Bad JSON.*502/);
});

test('parseApi: non-object reply', () => {
  assert.equal(parseApi(ApiResponseSchema, res([1, 2])).ok, false);
  assert.equal(parseApi(ApiResponseSchema, res(null)).ok, false);
});

test('parseApi: drops only the invalid field, keeps the rest', () => {
  const d = parseApi(MonitorResponseSchema, res({ inStock: true, setCookie: 'not-an-array', title: 'X' }));
  assert.equal(d.inStock, true);
  assert.equal(d.title, 'X');
  assert.equal(d.setCookie, undefined);
});

test('rateLimitWaitMs: honors Retry-After, default 30s, clamps to interval and 10min', () => {
  assert.equal(rateLimitWaitMs({ rateLimited: false }), 0);
  assert.equal(rateLimitWaitMs({ rateLimited: true, retryAfterMs: 5000 }, 1000), 5000);
  assert.equal(rateLimitWaitMs({ rateLimited: true }), 30000);
  assert.equal(rateLimitWaitMs({ rateLimited: true, retryAfterMs: 500 }, 4000), 4000);
  assert.equal(rateLimitWaitMs({ rateLimited: true, retryAfterMs: 99e6 }), 600000);
  assert.equal(rateLimitWaitMs({ availabilityStatus: 'RATE_LIMITED' }), 30000);
  assert.equal(rateLimitWaitMs({ error: 'HTTP 429' }), 30000);
});

test('rlFields / stockFromMonitor forward rate-limit + proxy info', () => {
  assert.deepEqual(rlFields({ availabilityStatus: 'RATE_LIMITED', retryAfterMs: 2000, proxyIgnored: true }), {
    rateLimited: true,
    retryAfterMs: 2000,
    proxyIgnored: true,
  });
  const s = stockFromMonitor(parseApi(MonitorResponseSchema, res({ inStock: 0, rateLimited: true, retryAfterMs: 1000 })));
  assert.equal(s.inStock, false);
  assert.equal(s.rateLimited, true);
  assert.equal(s.retryAfterMs, 1000);
});
