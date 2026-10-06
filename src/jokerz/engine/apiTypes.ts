/**
 * Shared types + runtime validation for the AIO API responses used by the store modules.
 *
 * - One StockResult for every store (was 4 slightly different copies).
 * - zod schemas validate /api/monitor/* and /api/checkout/* replies. Known fields are
 *   typed and coerced (e.g. price number → "$12.34"); unknown extra fields are kept (any).
 * - parseApi() never throws: invalid JSON / wrong shape becomes { ok:false, error }.
 * - Rate-limit helpers so monitors honor Retry-After instead of hammering.
 */
import { z } from 'zod';
import type { HttpResponse } from './http';

export interface FingerprintInfo {
  provider?: string | null;
  signals?: string[];
  confidence?: string;
  summary?: string;
  signalDetails?: { id: string; what: string; severity: string }[];
}

export interface StockResult {
  inStock: boolean;
  inQueue?: boolean;
  queueProvider?: string | null;
  queuePosition?: number;
  price?: string;
  title?: string;
  /** Product photo (https) — used in alerts */
  imageUrl?: string;
  quantity?: number;
  ms?: number;
  error?: string;
  availabilityStatus?: string;
  source?: string;
  via?: string;
  confidence?: string;
  parseSignals?: string[];
  offerId?: string;
  tcin?: string;
  finalUrl?: string;
  unknown?: boolean;
  blocked?: boolean;
  rateLimited?: boolean;
  retryAfterMs?: number;
  proxyIgnored?: boolean;
  setCookie?: string[];
  fingerprint?: FingerprintInfo | any;
}

const optStr = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null ? undefined : String(v)));
const optNum = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  });
const optBool = z
  .union([z.boolean(), z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null ? undefined : v === true || v === 'true' || v === 1));
const price = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null || v === '' ? undefined : typeof v === 'number' ? `$${v.toFixed(2)}` : v));

/** /api/monitor/{target,walmart,pokemon,bandai} */
export const MonitorResponseSchema = z
  .object({
    ok: optBool,
    inStock: optBool,
    inQueue: optBool,
    queueProvider: z.string().nullish(),
    queuePosition: optNum,
    price,
    title: optStr,
    imageUrl: optStr,
    quantity: optNum,
    ms: optNum,
    error: optStr,
    availabilityStatus: optStr,
    source: optStr,
    via: optStr,
    offerId: optStr,
    tcin: optStr,
    finalUrl: optStr,
    blocked: optBool,
    rateLimited: optBool,
    retryAfterMs: optNum,
    proxyIgnored: optBool,
    setCookie: z.array(z.string()).nullish().transform((v) => v ?? undefined),
  })
  .catchall(z.any());
export type MonitorResponse = z.infer<typeof MonitorResponseSchema>;

/** /api/checkout/*, /api/walmart/drawing, login / keepalive / harvest helpers */
export const ApiResponseSchema = z
  .object({
    ok: optBool,
    stage: optStr,
    step: optStr,
    message: optStr,
    error: optStr,
    orderNumber: optStr,
    price,
    blocked: optBool,
    rateLimited: optBool,
    retryAfterMs: optNum,
  })
  .catchall(z.any());
export type ApiResponse = z.infer<typeof ApiResponseSchema>;

/**
 * Parse an HttpResponse body with a schema. Never throws.
 * Bad JSON / non-object → { ok:false, error, invalid:true } (typed as the schema output).
 */
export function parseApi<S extends z.ZodTypeAny>(schema: S, res: Pick<HttpResponse, 'json' | 'status'>): z.infer<S> {
  let raw: unknown;
  try {
    raw = res.json();
  } catch {
    return { ok: false, invalid: true, error: `Bad JSON from API (HTTP ${res.status})` } as z.infer<S>;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, invalid: true, error: `Unexpected API reply (HTTP ${res.status})` } as z.infer<S>;
  }
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  console.warn('[api] response shape mismatch', issue?.path?.join('.'), issue?.message);
  // keep what we can: raw fields minus the ones that failed validation
  const bad = new Set(r.error.issues.map((i: { path: PropertyKey[] }) => String(i.path[0])));
  const kept = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => !bad.has(k)));
  const again = schema.safeParse(kept);
  return (again.success ? again.data : { ok: false, invalid: true, error: 'Invalid API response' }) as z.infer<S>;
}

/** Copy the monitor fields every store's StockResult cares about. */
export function stockFromMonitor(data: MonitorResponse): StockResult {
  return {
    inStock: Boolean(data.inStock),
    inQueue: data.inQueue,
    queueProvider: data.queueProvider ?? undefined,
    queuePosition: data.queuePosition,
    price: data.price,
    title: data.title,
    quantity: data.quantity,
    ms: data.ms,
    error: data.error,
    availabilityStatus: data.availabilityStatus,
    source: data.source,
    via: data.via,
    offerId: data.offerId,
    tcin: data.tcin,
    finalUrl: data.finalUrl,
    blocked: data.blocked,
    rateLimited: data.rateLimited || data.availabilityStatus === 'RATE_LIMITED',
    retryAfterMs: data.retryAfterMs,
    proxyIgnored: data.proxyIgnored,
    setCookie: data.setCookie,
    fingerprint: data.fingerprint,
  };
}

/** Default wait when a 429 arrives without Retry-After. */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;
export const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;

/**
 * How long a monitor should pause after this result, or 0 if it shouldn't.
 * Honors Retry-After, falls back to 30s, never less than the normal interval, max 10 min.
 */
export function rateLimitWaitMs(r: Pick<StockResult, 'rateLimited' | 'retryAfterMs' | 'error' | 'availabilityStatus'>, intervalMs = 0): number {
  const limited = r.rateLimited || r.availabilityStatus === 'RATE_LIMITED' || /\b429\b|rate.?limit/i.test(r.error || '');
  if (!limited) return 0;
  const want = r.retryAfterMs && r.retryAfterMs > 0 ? r.retryAfterMs : DEFAULT_RATE_LIMIT_WAIT_MS;
  return Math.min(Math.max(want, intervalMs), MAX_RATE_LIMIT_WAIT_MS);
}

/** Rate-limit / proxy fields to forward from a monitor reply into a StockResult. */
export function rlFields(d: Partial<MonitorResponse> | null | undefined): Pick<StockResult, 'rateLimited' | 'retryAfterMs' | 'proxyIgnored'> {
  if (!d) return {};
  return {
    rateLimited: Boolean(d.rateLimited) || d.availabilityStatus === 'RATE_LIMITED' || undefined,
    retryAfterMs: d.retryAfterMs,
    proxyIgnored: d.proxyIgnored,
  };
}
