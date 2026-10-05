/**
 * Request cancellation helpers — per-tick scopes linked to task AbortSignal.
 */

/** Combine multiple AbortSignals into one (any abort → abort all). */
export function anySignal(...signals: (AbortSignal | undefined | null)[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort((s as any).reason);
      return ctrl.signal;
    }
    s.addEventListener(
      'abort',
      () => {
        try {
          ctrl.abort((s as any).reason);
        } catch {
          /* */
        }
      },
      { once: true }
    );
  }
  return ctrl.signal;
}

/**
 * Scope for one monitor/checkout tick.
 * - abort() cancels only this tick's in-flight request
 * - parent task signal still cancels everything
 */
export function createTickScope(parent?: AbortSignal): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  isAborted: () => boolean;
} {
  const ctrl = new AbortController();
  if (parent) {
    if (parent.aborted) {
      ctrl.abort((parent as any).reason ?? new DOMException('Aborted', 'AbortError'));
    } else {
      parent.addEventListener(
        'abort',
        () => {
          try {
            ctrl.abort((parent as any).reason ?? new DOMException('Aborted', 'AbortError'));
          } catch {
            /* */
          }
        },
        { once: true }
      );
    }
  }
  return {
    signal: ctrl.signal,
    abort: (reason?: unknown) => {
      try {
        ctrl.abort(reason ?? new DOMException('Tick cancelled', 'AbortError'));
      } catch {
        /* already aborted */
      }
    },
    isAborted: () => ctrl.signal.aborted,
  };
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; message?: string };
  return (
    e.name === 'AbortError' ||
    e.code === 'ABORT_ERR' ||
    /aborted|abort/i.test(e.message || '')
  );
}
