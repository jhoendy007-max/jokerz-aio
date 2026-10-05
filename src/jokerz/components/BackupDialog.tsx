import { useRef, useState } from 'react';
import { Download, Upload, X, ShieldCheck, Lock, Undo2, AlertTriangle } from 'lucide-react';
import {
  BACKUP_KEYS,
  createBackup,
  parseBackupFile,
  backupData,
  summarize,
  applyBackup,
  hasUndo,
  undoImport,
  downloadJson,
  readSections,
  type BackupFile,
  type BackupSection,
} from '../lib/backup';

const LABEL: Record<BackupSection, string> = {
  tasks: 'Tasks',
  profiles: 'Profiles',
  proxies: 'Proxies',
  settings: 'Settings',
  checkouts: 'Checkouts',
  dashboardStats: 'Dashboard stats',
  drops: 'Upcoming drops',
  history: 'Price & stock history',
};

const input =
  'w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded-md px-2.5 py-1.5 text-[12px] text-white placeholder-[#555] focus:outline-none focus:border-[#7B2CBF]';
const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wide';

export default function BackupDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [mode, setMode] = useState<'safe' | 'full'>('safe');
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [file, setFile] = useState<BackupFile | null>(null);
  const [data, setData] = useState<Partial<Record<BackupSection, unknown>> | null>(null);
  const [pick, setPick] = useState<Set<BackupSection>>(new Set());
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const counts = summarize(readSections());

  const doExport = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const b = await createBackup({ mode, passphrase: pass });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      downloadJson(`jokerz-aio-backup-${mode}-${stamp}.json`, b);
      setMsg({ ok: true, text: mode === 'full' ? 'Encrypted backup downloaded. Keep the passphrase — it cannot be recovered.' : 'Backup downloaded (no secrets).' });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Export failed' });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f?: File) => {
    setMsg(null);
    setData(null);
    setFile(null);
    if (!f) return;
    try {
      const b = parseBackupFile(await f.text());
      setFile(b);
      if (!b.encrypted) {
        const d = await backupData(b);
        setData(d);
        setPick(new Set(Object.keys(d) as BackupSection[]));
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not read file' });
    }
  };

  const unlock = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const d = await backupData(file, pass);
      setData(d);
      setPick(new Set(Object.keys(d) as BackupSection[]));
      setMsg(null);
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not decrypt' });
    } finally {
      setBusy(false);
    }
  };

  const doImport = () => {
    if (!data || !pick.size) return;
    if (!confirm(`Replace ${[...pick].map((k) => LABEL[k]).join(', ')} with the backup? Your current data is saved first so you can undo.`)) return;
    applyBackup(data, [...pick]);
    setMsg({ ok: true, text: 'Imported. Reloading…' });
    setTimeout(() => window.location.reload(), 700);
  };

  const doUndo = () => {
    if (!confirm('Restore the data you had before the last import?')) return;
    undoImport();
    window.location.reload();
  };

  const sum = data ? summarize(data) : {};

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-[#121212] border border-[#262626] p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black italic uppercase tracking-tight text-white">Backup &amp; restore</h2>
          <button type="button" onClick={onClose} className="text-[#777] hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 p-1 rounded-lg bg-[#0a0a0a] border border-[#1a1a1a]">
          {(['export', 'import'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t);
                setMsg(null);
                setPass('');
              }}
              className={`flex-1 py-1.5 rounded-md text-[11px] font-bold uppercase ${tab === t ? 'bg-[#7B2CBF] text-white' : 'text-[#888] hover:text-white'}`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'export' ? (
          <div className="space-y-3">
            <div className="text-[12px] text-[#aaa]">
              Includes:{' '}
              {(Object.keys(BACKUP_KEYS) as BackupSection[])
                .filter((k) => k in counts)
                .map((k) => `${LABEL[k]} (${counts[k]})`)
                .join(' · ') || 'nothing saved yet'}
            </div>
            <label className={`flex gap-3 p-3 rounded-lg border cursor-pointer ${mode === 'safe' ? 'border-[#7B2CBF] bg-[#7B2CBF]/10' : 'border-[#1f1f1f]'}`}>
              <input type="radio" checked={mode === 'safe'} onChange={() => setMode('safe')} className="mt-0.5" />
              <div>
                <div className="flex items-center gap-1.5 text-[12px] font-bold text-white">
                  <ShieldCheck size={13} className="text-[#00FF41]" /> Safe (recommended)
                </div>
                <div className="text-[11px] text-[#999]">
                  Removes card number/CVV, account passwords &amp; 2FA, API keys, webhooks and IMAP password. Proxy lines are kept as-is (they include user:pass).
                </div>
              </div>
            </label>
            <label className={`flex gap-3 p-3 rounded-lg border cursor-pointer ${mode === 'full' ? 'border-[#7B2CBF] bg-[#7B2CBF]/10' : 'border-[#1f1f1f]'}`}>
              <input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} className="mt-0.5" />
              <div>
                <div className="flex items-center gap-1.5 text-[12px] font-bold text-white">
                  <Lock size={13} className="text-amber-300" /> Full, encrypted
                </div>
                <div className="text-[11px] text-[#999]">Everything, encrypted with a passphrase (AES-256). Without the passphrase the file is useless.</div>
              </div>
            </label>
            {mode === 'full' && (
              <input type="password" className={input} placeholder="Passphrase (min 8 characters)" value={pass} onChange={(e) => setPass(e.target.value)} />
            )}
            <div className="flex justify-end">
              <button type="button" disabled={busy} onClick={doExport} className={`${btn} bg-[#7B2CBF] hover:bg-[#9D4EDD] text-white disabled:opacity-50`}>
                <Download size={13} /> Download backup
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <button type="button" onClick={() => fileRef.current?.click()} className={`${btn} w-full justify-center border border-dashed border-[#333] text-[#aaa] hover:text-white py-4`}>
              <Upload size={13} /> Choose backup file
            </button>
            {file && (
              <div className="text-[11px] text-[#999]">
                {file.mode === 'full' ? 'Encrypted full backup' : 'Safe backup'} from {new Date(file.createdAt).toLocaleString()}
              </div>
            )}
            {file?.encrypted && !data && (
              <div className="flex gap-2">
                <input type="password" className={input} placeholder="Backup passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
                <button type="button" disabled={busy} onClick={unlock} className={`${btn} bg-[#262626] text-white`}>
                  Unlock
                </button>
              </div>
            )}
            {data && (
              <>
                <div className="space-y-1.5">
                  {(Object.keys(sum) as BackupSection[]).map((k) => (
                    <label key={k} className="flex items-center gap-2 text-[12px] text-white">
                      <input
                        type="checkbox"
                        checked={pick.has(k)}
                        onChange={(e) => {
                          const n = new Set(pick);
                          if (e.target.checked) n.add(k);
                          else n.delete(k);
                          setPick(n);
                        }}
                      />
                      {LABEL[k]} <span className="text-[#777]">({sum[k]})</span>
                    </label>
                  ))}
                </div>
                {!file?.encrypted && (
                  <div className="flex gap-2 text-[11px] text-[#aaa]">
                    <AlertTriangle size={13} className="text-amber-300 shrink-0 mt-0.5" />
                    Safe backup: your current cards, passwords and API keys are kept where the backup has none.
                  </div>
                )}
                <div className="flex justify-end">
                  <button type="button" disabled={!pick.size} onClick={doImport} className={`${btn} bg-[#7B2CBF] hover:bg-[#9D4EDD] text-white disabled:opacity-50`}>
                    <Upload size={13} /> Import selected
                  </button>
                </div>
              </>
            )}
            {hasUndo() && (
              <button type="button" onClick={doUndo} className={`${btn} text-[#aaa] hover:text-white px-0`}>
                <Undo2 size={13} /> Undo last import
              </button>
            )}
          </div>
        )}

        {msg && <div className={`text-[12px] ${msg.ok ? 'text-[#00FF41]' : 'text-[#FF4B2B]'}`}>{msg.text}</div>}
      </div>
    </div>
  );
}
