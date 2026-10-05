import { getFingerprintProfile } from './fingerprintProfiles';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | object;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Proxy string ip:port or user:pass@ip:port — solo útil en backend/Node */
  proxy?: string;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
  json: <T = unknown>() => T;
  url: string;
}

const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': getFingerprintProfile('chrome-131-win').ua,
};

/**
 * Fetch wrapper con timeout + AbortSignal.
 * En el browser: sujeto a CORS (Walmart/Target bloquean).
 * En Node/Electron backend: aquí es donde se engancha proxy real.
 */
export async function httpRequest(
  url: string,
  opts: HttpRequestOptions = {}
): Promise<HttpResponse> {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 15000 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException(`Timeout ${timeoutMs}ms`, 'AbortError'));
    } catch {
      /* */
    }
  }, timeoutMs);

  let onAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    onAbort = () => {
      try {
        controller.abort((signal as any).reason ?? new DOMException('Aborted', 'AbortError'));
      } catch {
        /* */
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const isRelative = url.startsWith('/');
    const hdrs: Record<string, string> = { ...headers };
    if (!isRelative) {
      Object.assign(hdrs, DEFAULT_HEADERS);
    } else {
      if (!hdrs.Accept) hdrs.Accept = 'application/json, text/plain, */*';
    }
    const res = await fetch(url, {
      method,
      headers: hdrs,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
      credentials: 'same-origin',
      mode: isRelative ? 'same-origin' : 'cors',
    });

    const text = await res.text();

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text,
      url: res.url,
      json: <T = unknown>() => {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error('Response is not valid JSON');
        }
      },
    };
  } catch (err) {
    // Re-throw AbortError cleanly
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if ((err as any)?.name === 'AbortError') throw err;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* */
      }
    }
  }
}

/** Detecta errores típicos de CORS / red en el browser */
export function isCorsOrNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === 'TypeError' ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('cors') ||
    msg.includes('blocked')
  );
}
