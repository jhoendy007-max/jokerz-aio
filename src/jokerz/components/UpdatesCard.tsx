import { useEffect, useState } from 'react';
import { RefreshCw, Download, GitBranch, CheckCircle2 } from 'lucide-react';
import { API_BASE } from '../engine/apiBase';

type Check = { ok: boolean; error?: string; mode?: string; current?: string; latest?: string; behind?: number; available?: boolean; commits?: { sha: string; message: string; date?: string }[] };
const btn = 'inline-flex items-center gap-1.5 px-4 py-2 text-[10px] font-bold uppercase tracking-widest border border-[#1A1A1A] text-[#ccc] hover:text-white disabled:opacity-50';
const input = 'w-full bg-[#0a0a0a] border border-[#1f1f1f] px-3 py-2 text-[12px] text-white placeholder-[#555] focus:outline-none focus:border-[#7B2CBF]';
const post = (path: string, body: unknown = {}) => fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export default function UpdatesCard() {
  const [cfg, setCfg] = useState<{ repo?: string; branch?: string; hasToken?: boolean; mode?: string } | null>(null);
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState<{ version?: string; sha?: string; launcher?: boolean }>({});

  useEffect(() => {
    fetch(`${API_BASE}/api/update/config`).then((r) => r.json()).then(setCfg).catch(() => setCfg(null));
    fetch(`${API_BASE}/api/version`).then((r) => r.json()).then(setVersion).catch(() => {});
  }, []);

  const saveToken = async () => {
    setBusy('save');
    const r = await post('/api/update/config', { token: token.trim() }).catch(() => null);
    if (r) setCfg(r);
    setToken('');
    setMsg({ ok: Boolean(r?.ok), text: r?.ok ? 'Token saved on this PC (never sent anywhere except GitHub).' : 'Could not save' });
    setBusy('');
  };
  const doCheck = async () => {
    setBusy('check');
    setMsg(null);
    try {
      const r: Check = await fetch(`${API_BASE}/api/update/check`).then((x) => x.json());
      setCheck(r);
      if (!r.ok) setMsg({ ok: false, text: r.error || 'Check failed' });
    } catch {
      setMsg({ ok: false, text: 'Engine server offline' });
    }
    setBusy('');
  };
  const apply = async () => {
    if (!window.confirm('Install the update now?\n\nYour tasks, profiles, proxies, settings and saved sessions are kept. Changed program files are backed up to backups/. Tip: make a Backup first (Dashboard → Backup).')) return;
    setBusy('apply');
    setMsg({ ok: true, text: 'Downloading and installing… do not close the app.' });
    try {
      const r = await post('/api/update/apply');
      if (r.ok) {
        setMsg({ ok: true, text: `Updated to ${String(r.to || '').slice(0, 7)} · ${r.changed ?? 0} file(s)${r.npmInstall ? ' · dependencies installed' : ''}. Restart to finish.` });
        setCheck(null);
      } else setMsg({ ok: false, text: r.error || 'Update failed — nothing was changed' });
    } catch {
      setMsg({ ok: false, text: 'Update failed' });
    }
    setBusy('');
  };
  const restart = async () => {
    const r = await post('/api/restart').catch(() => null);
    if (r?.ok) {
      setMsg({ ok: true, text: 'Restarting… this page reloads in a few seconds.' });
      setTimeout(() => window.location.reload(), 9000);
    } else setMsg({ ok: false, text: r?.error || 'Close the AIO window and open START-JOKERZ.bat again.' });
  };

  const needsToken = cfg && cfg.mode !== 'git' && !cfg.hasToken;

  return (
    <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-white inline-flex items-center gap-2">
            <GitBranch size={14} className="text-[#9D4EDD]" /> Updates
          </h2>
          <p className="text-[10px] text-[#555] mt-1 uppercase tracking-widest">
            {cfg?.repo || 'GitHub'} · {cfg?.branch || 'main'} · installed {version.sha || version.version || 'unknown'} · {cfg?.mode === 'git' ? 'git folder' : 'zip mode'}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={doCheck} disabled={Boolean(busy) || Boolean(needsToken)}>
            <RefreshCw size={11} className={busy === 'check' ? 'animate-spin' : ''} /> Check
          </button>
          {check?.ok && check.available && (
            <button type="button" className={`${btn} bg-[#7B2CBF] text-white border-[#7B2CBF]`} onClick={apply} disabled={Boolean(busy)}>
              <Download size={11} /> Install {check.behind ? `(${check.behind})` : ''}
            </button>
          )}
          {msg?.ok && msg.text.includes('Restart') && (
            <button type="button" className={`${btn} border-emerald-700 text-emerald-300`} onClick={restart}>
              Restart now
            </button>
          )}
        </div>
      </div>
      {cfg && (
        <div className="flex gap-2 items-center">
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg?.hasToken ? 'Token saved · paste a new one to replace' : 'GitHub token (read-only, for the private repo)'} className={input} />
          <button type="button" className={btn} disabled={!token.trim() || busy === 'save'} onClick={saveToken}>
            Save token
          </button>
        </div>
      )}
      {needsToken && <p className="text-[10px] text-[#666]">GitHub → Settings → Developer settings → Fine-grained token → only this repo → Contents: Read-only.</p>}
      {check?.ok && !check.available && (
        <p className="text-[11px] text-emerald-400 inline-flex items-center gap-1.5">
          <CheckCircle2 size={12} /> You have the latest version.
        </p>
      )}
      {check?.ok && check.available && check.commits?.length ? (
        <div className="rounded border border-[#1A1A1A] bg-[#0a0a0a] p-3 space-y-1 max-h-48 overflow-auto">
          {check.commits.map((c) => (
            <div key={c.sha} className="text-[11px] flex gap-2">
              <span className="font-mono text-[#9D4EDD] shrink-0">{c.sha.slice(0, 7)}</span>
              <span className="text-[#ccc] truncate">{c.message.split('\n')[0]}</span>
              {c.date && <span className="text-[#555] shrink-0 ml-auto">{c.date.slice(0, 10)}</span>}
            </div>
          ))}
        </div>
      ) : null}
      {msg && <p className={`text-[11px] ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}
    </div>
  );
}
