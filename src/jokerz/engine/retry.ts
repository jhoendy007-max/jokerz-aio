/**
 * Automatic retries with exponential backoff + jitter.
 * Respects AbortSignal; does not retry AbortError.
 */
import { isAbortError } from './abort';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

export type RetryOptions = {
  /** Total attempts including the first (default 3) */
  attempts?: number;
  /** Base delay ms before first retry (default 500) */
  baseMs?: number;
  /** Max delay between retries (default 12000) */
  maxMs?: number;
  /** Backoff multiplier (default 2) */
  factor?: number;
  /** Jitter 0–1 applied to delay (default 0.4 — reduces thundering herd) */
  jitter?: number;
  signal?: AbortSignal;
  /** Return true to retry this error/result */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (info: {
    attempt: number;
    attempts: number;
    delayMs: number;
    error: unknown;
  }) => void;
};

function defaultShouldRetry(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err || '');
  // Transient network / timeout
  if (/timeout|network|fetch failed|econnreset|econnrefused|enotfound|socket|503|502|504|429/i.test(msg)) {
    return true;
  }
  if (typeof err === 'object' && err && 'status' in err) {
    const s = Number((err as any).status);
    if (s === 429 || s === 502 || s === 503 || s === 504) return true;
  }
  return false;
}

export function retryDelayMs(
  attemptIndex: number,
  baseMs = 500,
  factor = 2,
  maxMs = 12_000,
  jitter = 0.4
): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attemptIndex)));
  // Decorrelated-ish: random between exp/3 and exp*(1+jitter)
  const lo = exp / 3;
  const hi = exp * (1 + Math.max(0, Math.min(1, jitter)));
  const picked = lo + Math.random() * (hi - lo);
  return Math.max(50, Math.round(picked));
}

/**
 * Run async fn with automatic retries.
 * attemptIndex 0 = first try.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 12_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? 0.4;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;
      const canRetry = attempt < attempts && shouldRetry(err, attempt);
      if (!canRetry) throw err;
      const delay = retryDelayMs(attempt - 1, baseMs, factor, maxMs, jitter);
      opts.onRetry?.({ attempt, attempts, delayMs: delay, error: err });
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

/** Classify stock-check style results for retry (soft network only). */
export function isRetryableStockError(error?: string, blocked?: boolean): boolean {
  if (blocked) return false;
  if (!error) return false;
  if (/blocked|challenge|px-captcha|shape|forbidden|403|login/i.test(error)) return false;
  return /timeout|network|backend offline|502|503|504|429|econn|fetch|socket|failed to fetch/i.test(
    error
  );
}
