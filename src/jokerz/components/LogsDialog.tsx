import { useEffect, useState } from 'react';
import { X, ScrollText, Search, Download, RefreshCw } from 'lucide-react';
import { API_BASE } from '../engine/apiBase';

type Row = { t: string; level: string; source: string; msg: string };
type FileInfo = { day: string; size: number };
const LEVEL_COLOR: Record<string, string> = { error: 'text-red-400', warn: 'text-amber-400', info: 'text-[#9ad]', debug: 'text-[#666]' };
const input = 'bg-[#0a0a0a] border border-[#1f1f1f] rounded-md px-2.5 py-1.5 text-[12px] text-white placeholder-[#555] focus:outline-none focus:border-[#7B2CBF]';
const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wide';

export default function LogsDialog({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [day, setDay] = useState('');
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/logs/files`)
      .then((r) => r.json())
      .then((r) => {
        setFiles(r.files || []);
        setDay(r.files?.[0]?.day || r.today || '');
      })
      .catch(() => setErr('Engine server is not answering — logs are written by the server.'));
  }, []);

  const load = async () => {
    if (!day) return;
    setBusy(true);
    try {
      const p = new URLSearchParams({ day, q, level, source, limit: '800' });
      const r = await fetch(`${API_BASE}/api/logs?${p}`).then((x) => x.json());
      setRows(r.rows || []);
      setErr('');
    } catch {
      setErr('Could not read logs');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, q, level, source]);

  const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-4xl h-[85vh] flex flex-col rounded-2xl bg-[#121212] border border-[#262626] p-5 gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black italic uppercase tracking-tight text-white inline-flex items-center gap-2">
            <ScrollText size={15} className="text-[#9D4EDD]" /> Log files
          </h2>
          <button type="button" onClick={onClose} className="text-[#777] hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={day} onChange={(e) => setDay(e.target.value)} className={input} aria-label="Day">
            {files.map((f) => (
              <option key={f.day} value={f.day}>
                {f.day} · {kb(f.size)}
              </option>
            ))}
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search (429, login, TCIN…)" className={`${input} w-full pl-7`} />
          </div>
          <select value={level} onChange={(e) => setLevel(e.target.value)} className={input} aria-label="Level">
            <option value="">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings+</option>
            <option value="info">Info+</option>
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={input} aria-label="Source">
            <option value="">All sources</option>
            <option value="server">Server</option>
            <option value="task">Tasks</option>
            <option value="checkout">Checkouts</option>
            <option value="engine">Engine</option>
            <option value="ui">UI</option>
          </select>
          <button type="button" onClick={load} className={`${btn} bg-[#1a1a1a] border border-[#262626] text-[#ccc] hover:text-white`}>
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          </button>
          <a href={`${API_BASE}/api/logs/export`} className={`${btn} bg-[#7B2CBF] text-white hover:bg-[#9D4EDD]`}>
            <Download size={12} /> Export ZIP
          </a>
        </div>
        {err && <p className="text-[12px] text-red-400">{err}</p>}
        <div className="flex-1 overflow-auto rounded-lg bg-[#0a0a0a] border border-[#1a1a1a] p-2 font-mono text-[11px] leading-relaxed">
          {rows.length === 0 && !busy && <p className="text-[#555] text-center py-8">No lines match.</p>}
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2 hover:bg-white/[0.02] px-1">
              <span className="text-[#555] shrink-0">{r.t.slice(11, 19)}</span>
              <span className={`shrink-0 w-10 uppercase ${LEVEL_COLOR[r.level] || 'text-[#888]'}`}>{r.level}</span>
              <span className="shrink-0 w-16 text-[#777] truncate">{r.source}</span>
              <span className="text-[#ddd] break-all">{r.msg}</span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-[#555]">Files: logs/jokerz-YYYY-MM-DD.log · kept 14 days · passwords, tokens, webhooks and card numbers are hidden before writing.</p>
      </div>
    </div>
  );
}
