import { useEffect, useMemo, useState } from 'react';
import { HeartPulse, RefreshCw, AlertTriangle } from 'lucide-react';
import type { BotSettings } from '../lib/storage';
import { API_BASE } from '../engine/apiBase';
import { buildAccountHealth, type LoginEvent } from '../lib/accountHealth';
import { loadCheckoutLog } from '../lib/dailySummary';

const ago = (t?: number) => {
  if (!t) return '—';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
const DOT = { good: 'bg-emerald-400', watch: 'bg-amber-400', bad: 'bg-red-500' };

export default function AccountHealthPanel({ settings }: { settings: BotSettings }) {
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/accounts/history?days=90`).then((x) => x.json());
      setEvents(r.events || []);
      setErr('');
    } catch {
      setErr('Engine server offline — login history comes from the server.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const rows = useMemo(() => {
    const accounts = Object.entries(settings.accounts || {}).flatMap(([store, list]) => (list || []).filter((a) => a.email).map((a) => ({ email: a.email, store, hasPassword: Boolean(a.pass) })));
    return buildAccountHealth(accounts, events, loadCheckoutLog() as any).sort((a, b) => ({ bad: 0, watch: 1, good: 2 })[a.score] - ({ bad: 0, watch: 1, good: 2 })[b.score]);
  }, [settings.accounts, events]);

  const warnCount = rows.filter((r) => r.score !== 'good').length;

  return (
    <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-white inline-flex items-center gap-2">
            <HeartPulse size={14} className="text-[#9D4EDD]" /> Account health
          </h2>
          <p className="text-[10px] text-[#555] mt-1 uppercase tracking-widest">Logins (90 days) · checkouts · warnings{warnCount ? ` · ${warnCount} need attention` : ''}</p>
        </div>
        <button type="button" onClick={load} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border border-[#1A1A1A] text-[#ccc] hover:text-white">
          <RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {err && <p className="text-[11px] text-amber-400">{err}</p>}
      {!rows.length ? (
        <p className="text-[11px] text-[#666]">No accounts saved yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[9px] uppercase tracking-widest text-[#555] text-left">
                <th className="py-1.5 pr-3 font-bold">Account</th>
                <th className="py-1.5 pr-3 font-bold">Store</th>
                <th className="py-1.5 pr-3 font-bold">Logins ok / failed</th>
                <th className="py-1.5 pr-3 font-bold">Last good login</th>
                <th className="py-1.5 pr-3 font-bold">Checkouts</th>
                <th className="py-1.5 pr-3 font-bold">Last used</th>
                <th className="py-1.5 font-bold">Warnings</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.store}|${r.email}`} className="border-t border-[#161616] align-top">
                  <td className="py-2 pr-3 text-white whitespace-nowrap">
                    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${DOT[r.score]}`} />
                    {r.email}
                  </td>
                  <td className="py-2 pr-3 text-[#aaa]">{r.store}</td>
                  <td className="py-2 pr-3 font-mono">
                    <span className="text-emerald-400">{r.logins - r.loginFails}</span> / <span className={r.loginFails ? 'text-red-400' : 'text-[#666]'}>{r.loginFails}</span>
                  </td>
                  <td className="py-2 pr-3 text-[#aaa]">{ago(r.lastLoginOkAt)}</td>
                  <td className="py-2 pr-3 font-mono whitespace-nowrap">
                    <span className="text-emerald-400">{r.checkouts}</span>
                    {r.checkoutFails ? <span className="text-red-400"> · {r.checkoutFails} failed</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-[#aaa]">{ago(r.lastUsedAt)}</td>
                  <td className="py-2 text-[#ccc]">
                    {r.warnings.length ? (
                      r.warnings.map((w) => (
                        <div key={w} className="flex items-start gap-1">
                          <AlertTriangle size={10} className={`mt-0.5 shrink-0 ${r.score === 'bad' ? 'text-red-400' : 'text-amber-400'}`} />
                          {w}
                        </div>
                      ))
                    ) : (
                      <span className="text-[#555]">—</span>
                    )}
                    {r.lastFail && r.score === 'bad' && <div className="text-[10px] text-[#666] mt-0.5">Last error: {r.lastFail}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
