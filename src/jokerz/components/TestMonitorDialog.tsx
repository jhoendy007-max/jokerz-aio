import { useState } from 'react';
import { X, Play, Loader2 } from 'lucide-react';
import { probeProduct, ProbeCard, type ProbeResult } from './ProductCheck';

const STORES = ['Target', 'Walmart', 'Pokemon Center', 'Bandai'];
const input =
  'w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded-md px-2.5 py-1.5 text-[12px] text-white placeholder-[#555] focus:outline-none focus:border-[#7B2CBF]';

/** One-off monitor check with the raw server response — to see why stock is or isn't detected. */
export default function TestMonitorDialog({ onClose, initial }: { onClose: () => void; initial?: { store?: string; product?: string } }) {
  const [store, setStore] = useState(initial?.store && STORES.includes(initial.store) ? initial.store : 'Target');
  const [product, setProduct] = useState(initial?.product || '');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ProbeResult | null>(null);

  const run = async () => {
    if (!product.trim()) return;
    setBusy(true);
    setRes(await probeProduct(store, product.trim()));
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl bg-[#121212] border border-[#262626] p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black italic uppercase tracking-tight text-white">Test monitor</h2>
          <button type="button" onClick={onClose} className="text-[#777] hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="text-[11px] text-[#999]">Runs the same monitor your tasks use, once, and shows exactly what came back.</p>
        <div className="flex gap-2">
          <select value={store} onChange={(e) => setStore(e.target.value)} className={`${input} max-w-[160px]`}>
            {STORES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <input
            className={input}
            placeholder="SKU / TCIN / product URL"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
          />
          <button
            type="button"
            onClick={run}
            disabled={busy || !product.trim()}
            className="inline-flex items-center gap-1.5 px-3 rounded-md bg-[#7B2CBF] hover:bg-[#9D4EDD] text-[11px] font-bold uppercase text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run
          </button>
        </div>
        {res && <ProbeCard r={res} showRaw />}
      </div>
    </div>
  );
}
