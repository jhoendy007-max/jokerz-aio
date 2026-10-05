import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea } from 'recharts';
import { TrendingUp, Trash2 } from 'lucide-react';
import {
  loadHistory,
  subscribeHistory,
  getHistoryVersion,
  priceStats,
  clearHistory,
  type ProductHistory,
} from '../lib/monitorHistory';

const fmtT = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const money = (n?: number) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');

/** Contiguous in-stock spans → shaded areas on the chart. */
function stockSpans(h: ProductHistory, now: number) {
  const spans: { x1: number; x2: number }[] = [];
  let start: number | null = null;
  for (const p of h.points) {
    if (p.inStock && start == null) start = p.t;
    if (!p.inStock && start != null) {
      spans.push({ x1: start, x2: p.t });
      start = null;
    }
  }
  if (start != null) spans.push({ x1: start, x2: now });
  return spans;
}

function PriceHistoryPanel() {
  useSyncExternalStore(subscribeHistory, getHistoryVersion, getHistoryVersion);
  // localStorage only exists in the browser: render empty on the server/first pass (no hydration mismatch)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const map = mounted ? loadHistory() : {};
  const list = Object.values(map).sort((a, b) => b.lastSeen - a.lastSeen);
  const [sel, setSel] = useState<string>('');
  const h = map[sel] || list[0];
  const now = Date.now();

  const chart = useMemo(() => {
    if (!h) return [];
    const pts = h.points.map((p) => ({ t: p.t, price: p.price ?? null, inStock: p.inStock }));
    // extend the line to "now" so the latest state is visible
    const last = pts[pts.length - 1];
    if (last && now - last.t > 60_000) pts.push({ ...last, t: now });
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h, h?.points.length]);

  const stats = h ? priceStats(h) : null;
  const current = h?.points[h.points.length - 1];
  const hasPrice = chart.some((p) => p.price != null);

  return (
    <div className="rounded-2xl bg-[#121212] border border-[#1c1c1c] p-5">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-[#7B2CBF]" />
          <h3 className="text-[11px] font-semibold text-[#888] uppercase tracking-wider">Price &amp; stock history</h3>
        </div>
        {list.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={h?.key}
              onChange={(e) => setSel(e.target.value)}
              className="max-w-[340px] bg-[#0a0a0a] border border-[#1f1f1f] rounded-md px-2.5 py-1 text-[12px] text-white focus:outline-none focus:border-[#7B2CBF]"
            >
              {list.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.store} · {p.title || p.product}
                </option>
              ))}
            </select>
            {h && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Clear history for ${h.title || h.product}?`)) clearHistory(h.key);
                }}
                className="text-[#666] hover:text-[#FF4B2B]"
                title="Clear this product's history"
                aria-label="Clear history"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )}
      </div>

      {!h ? (
        <div className="py-8 text-center text-[#666] text-sm">
          No history yet — it fills in automatically while monitors run
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
            {[
              ['Now', current?.inStock ? 'IN STOCK' : 'OUT OF STOCK', current?.inStock ? 'text-[#00FF41]' : 'text-[#FF4B2B]'],
              ['Price', money(stats?.last), 'text-white'],
              ['Low', money(stats?.min), 'text-[#00FF41]'],
              ['High', money(stats?.max), 'text-amber-300'],
              ['Restocks', String(h.restocks), 'text-[#C77DFF]'],
            ].map(([k, v, c]) => (
              <div key={k} className="rounded-lg bg-[#0a0a0a] border border-[#1a1a1a] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-[#777]">{k}</div>
                <div className={`text-sm font-bold tabular-nums ${c}`}>{v}</div>
              </div>
            ))}
          </div>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                {stockSpans(h, now).map((s, i) => (
                  <ReferenceArea key={i} x1={s.x1} x2={s.x2} fill="#00FF41" fillOpacity={0.08} ifOverflow="extendDomain" />
                ))}
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  stroke="#555"
                  fontSize={10}
                />
                <YAxis
                  stroke="#555"
                  fontSize={10}
                  width={48}
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => `$${v}`}
                  hide={!hasPrice}
                />
                <Tooltip
                  contentStyle={{ background: '#0a0a0a', border: '1px solid #222', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(t) => fmtT(Number(t))}
                  formatter={(v: any, _n, item: any) => [`${money(v)} · ${item?.payload?.inStock ? 'in stock' : 'out of stock'}`, 'Price']}
                />
                <Line type="stepAfter" dataKey="price" stroke="#9D4EDD" strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 text-[11px] text-[#777]">
            Green bands = in stock · {h.points.length} changes recorded since {fmtT(h.points[0].t)}
            {!hasPrice && ' · this monitor does not report a price'}
          </div>
        </>
      )}
    </div>
  );
}

export default memo(PriceHistoryPanel);
