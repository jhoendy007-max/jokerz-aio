import { useState } from 'react';
import { Search, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { API_BASE } from '../engine/apiBase';
import { rememberImage } from '../lib/productImages';
import ProductThumb from './ProductThumb';

export interface ProbeResult {
  ok: boolean;
  store: string;
  product: string;
  state: string;
  reason: string;
  title?: string;
  price?: string;
  imageUrl?: string;
  inStock?: boolean;
  ms?: number;
  raw?: Record<string, unknown>;
}

export function stateClass(state: string) {
  if (state === 'IN_STOCK') return 'bg-[#00FF41]/15 text-[#00FF41]';
  if (state === 'OUT_OF_STOCK') return 'bg-zinc-500/15 text-zinc-300';
  if (state === 'QUEUE') return 'bg-sky-400/15 text-sky-300';
  if (state === 'RATE_LIMITED' || state === 'UNKNOWN') return 'bg-amber-400/15 text-amber-300';
  return 'bg-[#FF4B2B]/15 text-[#FF4B2B]';
}

export async function probeProduct(store: string, product: string, proxy?: string): Promise<ProbeResult> {
  try {
    const r = await fetch(`${API_BASE}/api/monitor/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store, product, proxy }),
    });
    const j = (await r.json()) as ProbeResult;
    if (j?.imageUrl) rememberImage(store, product, j.imageUrl);
    return j;
  } catch {
    return { ok: false, store, product, state: 'ERROR', reason: 'Backend offline — start with: npm run server' };
  }
}

/** Result card: photo, title, price, state + reason, optional raw response. */
export function ProbeCard({ r, showRaw = false }: { r: ProbeResult; showRaw?: boolean }) {
  const [open, setOpen] = useState(showRaw);
  return (
    <div className="rounded-lg border border-[#1f1f1f] bg-[#0a0a0a] p-3 space-y-2">
      <div className="flex gap-3 items-center">
        <ProductThumb src={r.imageUrl} size={52} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-white truncate" title={r.title}>
            {r.title || (r.ok ? 'Product found (no title on page)' : 'Product not confirmed')}
          </div>
          <div className="text-[11px] text-[#999] truncate">
            {r.store} · {r.product}
            {r.price ? ` · ${r.price}` : ''}
            {typeof r.ms === 'number' ? ` · ${r.ms} ms` : ''}
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${stateClass(r.state)}`}>{r.state}</span>
            <span className="text-[11px] text-[#bbb]">{r.reason}</span>
          </div>
        </div>
      </div>
      {r.raw && (
        <div>
          <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[10px] uppercase font-bold text-[#888] hover:text-white">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Raw monitor response
          </button>
          {open && (
            <pre className="mt-1 max-h-[260px] overflow-auto text-[10.5px] leading-snug text-[#ccc] bg-[#050505] border border-[#1a1a1a] rounded-md p-2 whitespace-pre-wrap break-all">
              {JSON.stringify(r.raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline "Check product" button for the task form. */
export function CheckProductButton({ store, product, onResult }: { store: string; product: string; onResult?: (r: ProbeResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const run = async () => {
    if (!product.trim()) return;
    setBusy(true);
    const r = await probeProduct(store, product.trim());
    setRes(r);
    onResult?.(r);
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={busy || !product.trim()}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#1a1a1a] border border-[#262626] hover:border-[#7B2CBF] text-[10px] font-bold uppercase text-[#ccc] hover:text-white disabled:opacity-40"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Check product
      </button>
      {res && res.store.toLowerCase().startsWith(store.toLowerCase().slice(0, 4)) && <ProbeCard r={res} />}
    </div>
  );
}
