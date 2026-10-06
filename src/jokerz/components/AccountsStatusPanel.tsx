import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { KeyRound, RefreshCw, LogIn, Loader2, Check, X, ShieldAlert } from 'lucide-react';
import { API_BASE } from '../engine/apiBase';
import {
  getAccounts,
  getAccountsError,
  getAccountsVersion,
  refreshAccounts,
  subscribeAccounts,
  type AccountStatus,
} from '../lib/monitorWatchdog';
import type { BotSettings } from '../lib/storage';

const STORES = ['Target', 'Walmart', 'Pokemon Center', 'Bandai'];
const storeOf = (folder: string) => (/bandai/i.test(folder) ? 'Bandai' : folder);

const STATE: Record<string, { label: string; cls: string }> = {
  active: { label: 'ACTIVE', cls: 'bg-[#00FF41]/15 text-[#00FF41]' },
  expiring: { label: 'EXPIRING', cls: 'bg-amber-400/15 text-amber-300' },
  expired: { label: 'EXPIRED', cls: 'bg-[#FF4B2B]/15 text-[#FF4B2B]' },
  pending: { label: 'PENDING', cls: 'bg-sky-400/15 text-sky-300' },
  none: { label: 'NO SESSION', cls: 'bg-zinc-500/15 text-zinc-400' },
};

function ago(min?: number) {
  if (min == null) return '—';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}
function left(min?: number | null) {
  if (min == null) return '';
  if (min <= 0) return 'expired';
  return min < 60 ? `${min} min left` : `${Math.round(min / 60)} h left`;
}

type Job = { id: string; store: string; storeName: string; email: string; status: string; error?: string; cookieCount?: number };

async function post(path: string, body: unknown) {
  const r = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

/**
 * #6 manual login + #7 account status (+ #9 readable errors from the server).
 * Rows = accounts saved in Settings + any saved session on the server.
 */
export default function AccountsStatusPanel({ settings }: { settings: BotSettings }) {
  useSyncExternalStore(subscribeAccounts, getAccountsVersion, getAccountsVersion);
  const [job, setJob] = useState<Job | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newStore, setNewStore] = useState('Target');
  const [newEmail, setNewEmail] = useState('');
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void refreshAccounts();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  // merge configured accounts with server sessions
  const sessions = getAccounts();
  const rows: (AccountStatus & { configured: boolean })[] = [];
  const seen = new Set<string>();
  for (const [folder, list] of Object.entries(settings.accounts || {})) {
    for (const a of list || []) {
      const email = String(a.email || '').trim().toLowerCase();
      if (!email) continue;
      const store = storeOf(folder);
      const s = sessions.find((x) => x.email === email && x.store.toLowerCase().startsWith(store.toLowerCase().slice(0, 4)));
      seen.add(`${store}|${email}`);
      rows.push(s ? { ...s, store, configured: true } : { email, store, cookieCount: 0, state: 'none', configured: true });
    }
  }
  for (const s of sessions) {
    const store = STORES.find((x) => s.store.toLowerCase().startsWith(x.toLowerCase().slice(0, 4))) || s.store;
    if (!seen.has(`${store}|${s.email}`)) rows.push({ ...s, store, configured: false });
  }

  const watch = (id: string) => {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/manual-login/status?id=${encodeURIComponent(id)}`).then((x) => x.json());
        if (r?.job) {
          setJob(r.job);
          if (r.job.status !== 'waiting' && r.job.status !== 'opening') {
            if (poll.current) clearInterval(poll.current);
            if (r.job.status === 'closed') setMsg({ ok: false, text: 'The login window was closed before saving.' });
            if (r.job.status === 'timeout') setMsg({ ok: false, text: 'The login window was open for 15 min and was closed.' });
            void refreshAccounts();
          }
        }
      } catch {
        /* */
      }
    }, 2000);
  };

  const start = async (store: string, email: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await post('/api/manual-login/start', { store, email });
      if (!r.ok) setMsg({ ok: false, text: r.friendlyError || r.error || 'Could not open the login window' });
      else {
        setJob(r.job);
        watch(r.id);
      }
    } catch {
      setMsg({ ok: false, text: 'Backend offline — start with: npm run server' });
    }
    setBusy(false);
  };

  const save = async () => {
    if (!job) return;
    setBusy(true);
    const r = await post('/api/manual-login/save', { id: job.id }).catch(() => ({ ok: false, error: 'Backend offline' }));
    setBusy(false);
    if (r.ok) {
      setMsg({ ok: true, text: `Session saved for ${job.email} (${r.cookieCount} cookies). Tasks for this account will use it.` });
      setJob(null);
      if (poll.current) clearInterval(poll.current);
      void refreshAccounts();
    } else setMsg({ ok: false, text: r.error || 'Could not save' });
  };

  const cancel = async () => {
    if (!job) return;
    await post('/api/manual-login/cancel', { id: job.id }).catch(() => {});
    if (poll.current) clearInterval(poll.current);
    setJob(null);
  };

  const err = getAccountsError();

  return (
    <div className="rounded-lg border border-[#1f1f1f] bg-[#0a0a0a] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-[#7B2CBF]" />
          <span className="text-[11px] uppercase font-bold text-white tracking-wide">Account sessions</span>
        </div>
        <button
          type="button"
          onClick={() => void refreshAccounts()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#1a1a1a] text-[10px] font-bold uppercase text-[#aaa] hover:text-white"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      <p className="text-[11px] text-[#888]">
        "Log in manually" opens a normal browser window on the store's sign-in page. Sign in yourself (password, 2FA code, anything the store asks), then
        press <b className="text-white">Save session</b>. The app keeps that session for the account's tasks and warns you before it expires.
      </p>

      {job && (job.status === 'waiting' || job.status === 'opening') && (
        <div className="rounded-md border border-[#7B2CBF]/40 bg-[#7B2CBF]/10 p-3 flex items-center gap-3 flex-wrap">
          <Loader2 size={14} className="animate-spin text-[#C77DFF]" />
          <div className="text-[12px] text-white flex-1 min-w-[200px]">
            {job.status === 'opening' ? 'Opening browser…' : `Browser open for ${job.storeName} · ${job.email}. Sign in, then save.`}
          </div>
          <button type="button" disabled={busy || job.status !== 'waiting'} onClick={save} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#7B2CBF] hover:bg-[#9D4EDD] text-[11px] font-bold uppercase text-white disabled:opacity-50">
            <Check size={13} /> Save session
          </button>
          <button type="button" onClick={cancel} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#1a1a1a] text-[11px] font-bold uppercase text-[#aaa] hover:text-white">
            <X size={13} /> Cancel
          </button>
        </div>
      )}
      {msg && <div className={`text-[12px] ${msg.ok ? 'text-[#00FF41]' : 'text-[#FF4B2B]'}`}>{msg.text}</div>}
      {err && (
        <div className="flex items-center gap-2 text-[11px] text-amber-300">
          <ShieldAlert size={13} /> {err}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="py-4 text-center text-[12px] text-[#777]">No accounts yet — add one below or in the store folders.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[#777] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3 font-semibold">Store</th>
                <th className="py-1.5 pr-3 font-semibold">Account</th>
                <th className="py-1.5 pr-3 font-semibold">Session</th>
                <th className="py-1.5 pr-3 font-semibold">Last login</th>
                <th className="py-1.5 font-semibold text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = STATE[r.state] || STATE.none;
                return (
                  <tr key={`${r.store}|${r.email}`} className="border-t border-[#1a1a1a]">
                    <td className="py-1.5 pr-3 text-[#aaa] whitespace-nowrap">{r.store}</td>
                    <td className="py-1.5 pr-3 text-white truncate max-w-[240px]">{r.email}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${st.cls}`}>{st.label}</span>
                      {r.pending === '2fa' && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-400/15 text-sky-300">WAITING 2FA CODE</span>}
                      {r.pending === 'manual_login' && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-400/15 text-sky-300">LOGIN WINDOW OPEN</span>}
                      {r.state !== 'none' && r.state !== 'pending' && <span className="ml-2 text-[#888]">{left(r.minutesLeft)}</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-[#888] whitespace-nowrap">{r.state === 'none' ? '—' : ago(r.lastLoginMin)}</td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        disabled={busy || !!job}
                        onClick={() => start(r.store, r.email)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#1a1a1a] border border-[#262626] hover:border-[#7B2CBF] text-[10px] font-bold uppercase text-[#ccc] hover:text-white disabled:opacity-40"
                      >
                        <LogIn size={12} /> Log in manually
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-2 flex-wrap pt-1">
        <select value={newStore} onChange={(e) => setNewStore(e.target.value)} className="bg-[#050505] border border-[#1f1f1f] rounded-md px-2 py-1.5 text-[12px] text-white">
          {STORES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <input
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="account email"
          className="flex-1 min-w-[200px] bg-[#050505] border border-[#1f1f1f] rounded-md px-2.5 py-1.5 text-[12px] text-white placeholder-[#555] focus:outline-none focus:border-[#7B2CBF]"
        />
        <button
          type="button"
          disabled={busy || !!job || !/.+@.+\..+/.test(newEmail)}
          onClick={() => start(newStore, newEmail.trim())}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#7B2CBF] hover:bg-[#9D4EDD] text-[11px] font-bold uppercase text-white disabled:opacity-40"
        >
          <LogIn size={13} /> Log in manually
        </button>
      </div>
    </div>
  );
}
