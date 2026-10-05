/**
 * Discord/Slack alert de-duplication.
 * - Many tasks can watch the same product → only the first alert goes out.
 * - Stock flapping (in → out → in) inside the cooldown doesn't re-alert.
 * - Price alerts only repeat if the price is actually different.
 * Success / decline / ban / info alerts are never suppressed here.
 */
export type DedupeKind = 'queue' | 'stock' | 'success' | 'decline' | 'info' | 'price' | 'ban';

export interface DedupeInput {
  store: string;
  product: string;
  price?: string;
  status?: string;
}

const DEDUPED: ReadonlySet<string> = new Set(['stock', 'price', 'queue']);

export function normalizeProduct(store: string, product: string): string {
  const s = String(product || '').trim().toLowerCase();
  const id =
    s.match(/\/a-(\d{6,})/)?.[1] || // target
    s.match(/\/ip\/(?:[^/]+\/)?(\d{5,})/)?.[1] || // walmart
    s.match(/\/product\/([^/?#]+)/)?.[1] || // pokemon center
    s.match(/\/item\/([^/?#]+)/)?.[1] || // bandai
    s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `${String(store || '').toLowerCase()}:${id}`;
}

const normPrice = (p?: string) => String(p || '').replace(/[^0-9.→>-]/g, '');

export function createAlertDedupe(opts: { cooldownMs?: number; maxKeys?: number } = {}) {
  const maxKeys = opts.maxKeys ?? 2000;
  const seen = new Map<string, { at: number; sig: string }>();
  let suppressed = 0;

  function check(kind: DedupeKind, data: DedupeInput, now = Date.now(), cooldownMs = opts.cooldownMs ?? 5 * 60_000) {
    if (!DEDUPED.has(kind) || cooldownMs <= 0) return { send: true as const };
    const key = `${kind}|${normalizeProduct(data.store, data.product)}`;
    const sig = kind === 'price' ? normPrice(data.price) : kind === 'queue' ? String(data.status || '') : '';
    const prev = seen.get(key);
    if (prev && now - prev.at < cooldownMs && prev.sig === sig) {
      suppressed++;
      return { send: false as const, reason: `duplicate ${kind} within ${Math.round(cooldownMs / 1000)}s`, key };
    }
    seen.delete(key);
    seen.set(key, { at: now, sig });
    if (seen.size > maxKeys) seen.delete(seen.keys().next().value as string);
    return { send: true as const, key };
  }

  return {
    check,
    stats: () => ({ tracked: seen.size, suppressed }),
    reset: () => {
      seen.clear();
      suppressed = 0;
    },
  };
}
