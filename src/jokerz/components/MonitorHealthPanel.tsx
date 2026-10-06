import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { Gauge, ShieldOff, Activity, BellOff, FlaskConical, AlertTriangle } from 'lucide-react';
import TestMonitorDialog from './TestMonitorDialog';
import { stateClass } from './ProductCheck';
import {
  getMonitorHealth,
  getMonitorHealthVersion,
  subscribeMonitorHealth,
  clearMonitorHealth,
} from '../lib/monitorHealth';
import { getAlertDedupeStats } from '../engine/webhooks';

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function statusClass(status: string) {
  if (status === 'IN_STOCK') return 'bg-[#00FF41]/15 text-[#00FF41]';
  if (status === 'RATE_LIMITED') return 'bg-amber-400/15 text-amber-300';
  if (status === 'OUT_OF_STOCK') return 'bg-zinc-500/15 text-zinc-400';
  if (status === 'QUEUE') return 'bg-sky-400/15 text-sky-300';
  return 'bg-[#FF4B2B]/15 text-[#FF4B2B]';
}

function MonitorHealthPanel() {
  useSyncExternalStore(subscribeMonitorHealth, getMonitorHealthVersion, getMonitorHealthVersion);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = getMonitorHealth();
  const rateLimited = rows.filter((r) => r.rateLimited).length;
  const proxyIgnored = rows.filter((r) => r.proxyIgnored).length;
  const dupes = getAlertDedupeStats().suppressed;
  const stalled = rows.filter((r) => r.stalled).length;
  const [test, setTest] = useState<{ store?: string; product?: string } | null>(null);

  return (
    <div className="rounded-lg bg-[#121212] border border-[#1c1c1c] p-4">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h3 className="text-[11px] font-semibold text-[#666] uppercase tracking-wider flex items-center gap-2">
          <Activity size={13} /> Monitor Health
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide ${
              stalled ? 'bg-[#FF4B2B]/15 text-[#FF4B2B]' : 'bg-[#1a1a1a] text-[#555]'
            }`}
            title="Monitors with no valid response for a while or many errors in a row (Settings → Webhooks → Monitors)"
          >
            <AlertTriangle size={12} /> Stalled · {stalled}
          </span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide ${
              rateLimited ? 'bg-amber-400/15 text-amber-300' : 'bg-[#1a1a1a] text-[#555]'
            }`}
            title="Monitors whose last response was HTTP 429 / RATE_LIMITED"
          >
            <Gauge size={12} /> Rate limited · {rateLimited}
          </span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide ${
              proxyIgnored ? 'bg-[#FF4B2B]/15 text-[#FF4B2B]' : 'bg-[#1a1a1a] text-[#555]'
            }`}
            title="A proxy was configured but the server could not use it (undici missing) — requests went out from your own IP"
          >
            <ShieldOff size={12} /> Proxy ignored · {proxyIgnored}
          </span>
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide bg-[#1a1a1a] text-[#888]"
            title="Repeated Discord/Slack stock, price and queue alerts blocked by the cooldown (Settings → Discord Webhooks)"
          >
            <BellOff size={12} /> Duplicate alerts blocked · {dupes}
          </span>
          <button
            type="button"
            onClick={() => setTest({})}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase bg-[#7B2CBF]/20 text-[#C77DFF] hover:bg-[#7B2CBF]/30"
          >
            <FlaskConical size={12} /> Test monitor
          </button>
          {rows.length > 0 && (
            <button
              onClick={clearMonitorHealth}
              className="px-2 py-1 rounded-md text-[10px] font-bold uppercase text-[#555] hover:text-white bg-[#1a1a1a]"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {proxyIgnored > 0 && (
        <div className="mb-3 rounded-md border border-[#FF4B2B]/30 bg-[#FF4B2B]/10 px-3 py-2 text-[11px] text-[#ff8a75]">
          Proxies are being ignored — requests go out from your own IP. Run <code className="text-white">npm install undici</code> and restart the server.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="py-8 text-center text-[#444] text-sm">No monitor data yet — start a Target, Walmart, Pokémon Center or Bandai task</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[#555] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3 font-semibold">Store</th>
                <th className="py-1.5 pr-3 font-semibold">Product</th>
                <th className="py-1.5 pr-3 font-semibold">Status</th>
                <th className="py-1.5 pr-3 font-semibold">Why</th>
                <th className="py-1.5 pr-3 font-semibold">Retry in</th>
                <th className="py-1.5 pr-3 font-semibold">Proxy</th>
                <th className="py-1.5 pr-3 font-semibold text-right">429s</th>
                <th className="py-1.5 font-semibold text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map((r) => {
                const retryLeft = r.rateLimited && r.retryAfterMs ? r.at + r.retryAfterMs - now : 0;
                return (
                  <tr key={r.key} className="border-t border-[#1a1a1a]">
                    <td className="py-1.5 pr-3 text-[#aaa] whitespace-nowrap">{r.store}</td>
                    <td className="py-1.5 pr-3 text-white truncate max-w-[220px]" title={r.title || r.product}>
                      <button type="button" className="hover:underline text-left truncate max-w-[220px]" onClick={() => setTest({ store: r.store, product: r.product })} title="Test this monitor">
                        {r.title || r.product}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {r.stalled && <span className="mr-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#FF4B2B] text-white">STALLED</span>}
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r.state ? stateClass(r.state) : statusClass(r.status)}`}>{r.state || r.status}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-[#999] truncate max-w-[280px]" title={r.stalledWhy || r.reason || ''}>
                      {r.stalled ? `${r.stalledWhy}${r.lastError ? ` · ${r.lastError}` : ''}` : r.reason || (r.errorStreak ? `${r.errorStreak} errors in a row` : '—')}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-amber-300">{retryLeft > 0 ? ago(retryLeft) : '—'}</td>
                    <td className="py-1.5 pr-3">
                      {r.proxyIgnored ? (
                        <span className="text-[#FF4B2B] font-bold">IGNORED</span>
                      ) : (
                        <span className="text-[#555]">ok</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-[#888]">{r.rateLimitedCount}</td>
                    <td className="py-1.5 text-right tabular-nums text-[#555]">{ago(now - r.at)} ago</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {test && <TestMonitorDialog initial={test} onClose={() => setTest(null)} />}
    </div>
  );
}

export default memo(MonitorHealthPanel);
