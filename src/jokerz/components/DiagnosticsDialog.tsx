import { useEffect, useState } from 'react';
import { X, Stethoscope, RefreshCw, Download, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { API_BASE } from '../engine/apiBase';
import { loadSettings, loadTasks, loadProxies } from '../lib/storage';
import { getMonitorHealth } from '../lib/monitorHealth';
import { loadProxyHealth, isDead } from '../lib/proxyHealth';

type Check = { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string };
type Report = { ok: boolean; at: string; summary: { ok: number; warn: number; fail: number }; checks: Check[] };

const DISCORD_RE = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i;

/** Checks that only the browser can see (settings, storage, monitors). */
function clientChecks(): Check[] {
  const s = loadSettings() as any;
  const out: Check[] = [];
  const hooks = ['discordWebhook', 'successWebhook', 'declineWebhook', 'dailySummaryWebhook'].map((k) => [k, String(s[k] || '').trim()] as const).filter(([, v]) => v);
  const bad = hooks.filter(([, v]) => !DISCORD_RE.test(v));
  out.push(
    !hooks.length
      ? { id: 'webhooks', label: 'Discord webhooks', status: 'warn', detail: 'No webhook set — you will not get alerts', fix: 'Settings → Webhooks → paste your Discord webhook URL, then Test' }
      : bad.length
        ? { id: 'webhooks', label: 'Discord webhooks', status: 'fail', detail: `${bad.length} webhook URL(s) look wrong (${bad.map(([k]) => k).join(', ')})`, fix: 'Copy the full URL from Discord → Channel settings → Integrations → Webhooks' }
        : { id: 'webhooks', label: 'Discord webhooks', status: 'ok', detail: `${hooks.length} set` },
  );
  if (s.telegramEnabled) out.push(s.telegramToken && s.telegramChatId ? { id: 'telegram', label: 'Telegram', status: 'ok', detail: 'bot + chat id set' } : { id: 'telegram', label: 'Telegram', status: 'warn', detail: 'Enabled but token or chat id missing', fix: 'Settings → Webhooks → Telegram' });
  const tasks = loadTasks([]);
  const proxies = loadProxies([]);
  const lines = proxies.flatMap((g) => g.proxies || []).map((l) => String(l).trim()).filter(Boolean);
  const ph = loadProxyHealth();
  const dead = lines.filter((l) => isDead(ph[l])).length;
  out.push({ id: 'tasks', label: 'Tasks', status: tasks.length ? 'ok' : 'warn', detail: `${tasks.length} task(s)`, fix: tasks.length ? undefined : 'Tasks → Create task' });
  out.push({ id: 'proxies', label: 'Proxies', status: dead ? 'warn' : 'ok', detail: `${lines.length} proxy line(s) in ${proxies.length} group(s)${dead ? ` · ${dead} marked dead` : ''}`, fix: dead ? 'Proxies → Test → Remove dead' : undefined });
  const accounts = Object.values((s.accounts || {}) as Record<string, any[]>).flat();
  const noPass = accounts.filter((a) => a?.email && !a?.pass).length;
  out.push({ id: 'accounts', label: 'Accounts', status: noPass ? 'warn' : 'ok', detail: `${accounts.length} account(s)${noPass ? ` · ${noPass} without password` : ''}`, fix: noPass ? 'Settings → Accounts, or use Log in manually' : undefined });
  const h = getMonitorHealth();
  const stalled = h.filter((m: any) => m.stalled).length;
  const blocked = h.filter((m: any) => ['BLOCKED', 'RATE_LIMITED'].includes(String(m.state))).length;
  out.push({ id: 'monitors', label: 'Monitors', status: stalled || blocked ? 'warn' : 'ok', detail: h.length ? `${h.length} watched · ${stalled} stalled · ${blocked} blocked/rate-limited` : 'no monitor running', fix: stalled || blocked ? 'Dashboard → Monitor health: raise the delay or test the proxy' : undefined });
  let bytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      bytes += (k.length + (localStorage.getItem(k) || '').length) * 2;
    }
  } catch {
    /* */
  }
  const mb = bytes / 1048576;
  out.push({ id: 'storage', label: 'App storage', status: mb > 8 ? 'warn' : 'ok', detail: `${mb.toFixed(1)} MB used`, fix: mb > 8 ? 'Backup, then clear old task logs / price history' : undefined });
  out.push({ id: 'notify', label: 'Browser notifications', status: typeof Notification === 'undefined' ? 'warn' : Notification.permission === 'denied' ? 'warn' : 'ok', detail: typeof Notification === 'undefined' ? 'not supported' : Notification.permission });
  return out;
}

const ICON = { ok: <CheckCircle2 size={14} className="text-emerald-400" />, warn: <AlertTriangle size={14} className="text-amber-400" />, fail: <XCircle size={14} className="text-red-400" /> };
const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wide';

export default function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const [server, setServer] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState<Check[]>([]);

  const run = async () => {
    setBusy(true);
    setErr('');
    setClient(clientChecks());
    try {
      const r = await fetch(`${API_BASE}/api/diagnostics`).then((x) => x.json());
      setServer(r);
    } catch {
      setServer(null);
      setErr('Engine server is not answering — start the app with START-JOKERZ.bat');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run();
  }, []);

  const all = [...(server?.checks || []), ...client];
  const sum = { ok: all.filter((c) => c.status === 'ok').length, warn: all.filter((c) => c.status === 'warn').length, fail: all.filter((c) => c.status === 'fail').length + (err ? 1 : 0) };

  const download = () => {
    const report = { app: 'jokerz-aio', at: new Date().toISOString(), summary: sum, serverError: err || undefined, checks: all, userAgent: navigator.userAgent };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jokerz-diagnostics-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-[#121212] border border-[#262626] p-5 gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black italic uppercase tracking-tight text-white inline-flex items-center gap-2">
            <Stethoscope size={15} className="text-[#9D4EDD]" /> Diagnostics
          </h2>
          <button type="button" onClick={onClose} className="text-[#777] hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-bold">
          <span className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-400">{sum.ok} OK</span>
          <span className="px-2 py-1 rounded bg-amber-500/10 text-amber-400">{sum.warn} warning</span>
          <span className="px-2 py-1 rounded bg-red-500/10 text-red-400">{sum.fail} problem</span>
          <div className="flex-1" />
          <button type="button" onClick={run} disabled={busy} className={`${btn} bg-[#1a1a1a] border border-[#262626] text-[#ccc] hover:text-white disabled:opacity-50`}>
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Run again
          </button>
          <button type="button" onClick={download} className={`${btn} bg-[#7B2CBF] text-white hover:bg-[#9D4EDD]`}>
            <Download size={12} /> Report
          </button>
        </div>
        {err && <p className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{err}</p>}
        <div className="overflow-auto -mx-1 px-1 space-y-1">
          {all.map((c) => (
            <div key={c.id} className="flex items-start gap-2.5 rounded-lg bg-[#0d0d0d] border border-[#1c1c1c] px-3 py-2">
              <span className="mt-0.5">{ICON[c.status]}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] font-bold text-white">{c.label}</span>
                  <span className="text-[11px] text-[#888] truncate">{c.detail}</span>
                </div>
                {c.fix && c.status !== 'ok' && <p className="text-[11px] text-[#bbb] mt-0.5">→ {c.fix}</p>}
              </div>
            </div>
          ))}
          {busy && !all.length && <p className="text-[12px] text-[#777] py-6 text-center">Checking…</p>}
        </div>
        <p className="text-[10px] text-[#555]">The report has no passwords, webhooks or card data — safe to send when asking for help.</p>
      </div>
    </div>
  );
}
