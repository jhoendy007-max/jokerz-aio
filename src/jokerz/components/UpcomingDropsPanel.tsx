import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { Clock, Plus, Trash2, Pencil, Bell, BellOff, ExternalLink, X } from 'lucide-react';
import {
  loadDrops,
  upsertDrop,
  removeDrop,
  visibleDrops,
  formatCountdown,
  newDropId,
  subscribeDrops,
  getDropsVersion,
  type Drop,
  type DropStore,
} from '../lib/drops';
import { productPageUrl } from '../engine/webhooks';

const STORES: DropStore[] = ['Target', 'Walmart', 'Pokemon Center', 'Bandai', 'Other'];
const REMIND = [0, 5, 10, 15, 30, 60];

const input =
  'w-full bg-[#0a0a0a] border border-[#1f1f1f] rounded-md px-2.5 py-1.5 text-[12px] text-white placeholder-[#444] focus:outline-none focus:border-[#7B2CBF]';

/** datetime-local value in the user's local time */
function toLocalInput(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Form = { id?: string; createdAt?: number; store: DropStore; title: string; product: string; at: string; remindMin: number; note: string };
const emptyForm = (): Form => ({
  store: 'Target',
  title: '',
  product: '',
  at: toLocalInput(Date.now() + 60 * 60_000),
  remindMin: 10,
  note: '',
});

function UpcomingDropsPanel() {
  useSyncExternalStore(subscribeDrops, getDropsVersion, getDropsVersion);
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState<Form | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const drops = mounted ? visibleDrops(loadDrops(), now) : [];

  const save = () => {
    if (!form) return;
    const at = new Date(form.at).getTime();
    if (!form.title.trim()) return setErr('Name is required');
    if (!Number.isFinite(at)) return setErr('Pick a date and time');
    if (!form.id && at < Date.now() - 60_000) return setErr('That time is in the past');
    const drop: Drop = {
      id: form.id || newDropId(),
      createdAt: form.createdAt || Date.now(),
      store: form.store,
      title: form.title.trim().slice(0, 120),
      product: form.product.trim() || undefined,
      at,
      remindMin: form.remindMin,
      note: form.note.trim() || undefined,
    };
    upsertDrop(drop);
    if (drop.remindMin > 0 && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => {});
    }
    setForm(null);
    setErr('');
  };

  const edit = (d: Drop) => {
    setErr('');
    setForm({
      id: d.id,
      createdAt: d.createdAt,
      store: d.store,
      title: d.title,
      product: d.product || '',
      at: toLocalInput(d.at),
      remindMin: d.remindMin,
      note: d.note || '',
    });
  };

  return (
    <div className="rounded-2xl bg-[#121212] border border-[#1c1c1c] p-5 min-h-[320px] flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[11px] font-semibold text-[#666] uppercase tracking-wider">Upcoming Drops</h3>
        {!form && (
          <button
            type="button"
            onClick={() => {
              setErr('');
              setForm(emptyForm());
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#7B2CBF]/20 text-[#C77DFF] hover:bg-[#7B2CBF]/30 text-[10px] font-bold uppercase tracking-wide"
          >
            <Plus size={12} /> Add drop
          </button>
        )}
      </div>

      {form && (
        <div className="mb-4 rounded-xl border border-[#2a1a3a] bg-[#0d0a12] p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#C77DFF]">
              {form.id ? 'Edit drop' : 'New drop'}
            </span>
            <button type="button" onClick={() => setForm(null)} className="text-[#555] hover:text-white" aria-label="Close">
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select className={input} value={form.store} onChange={(e) => setForm({ ...form, store: e.target.value as DropStore })}>
              {STORES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input type="datetime-local" className={input} value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
          </div>
          <input className={input} placeholder="Name (e.g. Prismatic Evolutions ETB)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input className={input} placeholder="Product URL / SKU / TCIN (optional)" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <select className={input} value={form.remindMin} onChange={(e) => setForm({ ...form, remindMin: Number(e.target.value) })}>
              {REMIND.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'No reminder' : `Remind ${m} min before`}
                </option>
              ))}
            </select>
            <input className={input} placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          {err && <div className="text-[11px] text-[#FF4B2B]">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setForm(null)} className="px-3 py-1.5 rounded-md text-[11px] font-bold uppercase text-[#777] hover:text-white">
              Cancel
            </button>
            <button type="button" onClick={save} className="px-3 py-1.5 rounded-md bg-[#7B2CBF] hover:bg-[#9D4EDD] text-[11px] font-bold uppercase text-white">
              Save
            </button>
          </div>
        </div>
      )}

      {drops.length === 0 && !form ? (
        <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-[#222] rounded-xl">
          <Clock size={32} className="text-[#333] mb-3" strokeWidth={1.5} />
          <p className="text-[11px] font-medium text-[#444] uppercase tracking-wider">No upcoming drops scheduled</p>
        </div>
      ) : (
        <div className="space-y-2 overflow-y-auto max-h-[420px] pr-1">
          {drops.map((d) => {
            const left = d.at - now;
            const live = left <= 0;
            const soon = !live && left < 15 * 60_000;
            const href = d.product ? (/^https?:\/\//i.test(d.product) ? d.product : productPageUrl(d.store, d.product)) : undefined;
            return (
              <div key={d.id} className="flex items-center gap-3 rounded-xl bg-[#0a0a0a] border border-[#1a1a1a] px-4 py-3">
                <div
                  className={`w-[76px] shrink-0 text-center rounded-md px-1.5 py-1 text-[11px] font-bold tabular-nums ${
                    live ? 'bg-[#00FF41]/15 text-[#00FF41]' : soon ? 'bg-amber-400/15 text-amber-300' : 'bg-[#7B2CBF]/15 text-[#C77DFF]'
                  }`}
                >
                  {formatCountdown(left)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate" title={d.title}>
                    {d.title}
                  </div>
                  <div className="text-[11px] text-[#555] truncate">
                    {d.store} · {new Date(d.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {d.note ? ` · ${d.note}` : ''}
                  </div>
                </div>
                <span className="shrink-0 text-[#555]" title={d.remindMin ? `Reminder ${d.remindMin} min before${d.reminded ? ' (sent)' : ''}` : 'No reminder'}>
                  {d.remindMin ? <Bell size={13} className={d.reminded ? 'text-[#00FF41]' : ''} /> : <BellOff size={13} />}
                </span>
                {href && (
                  <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-[#555] hover:text-white" title="Open product page">
                    <ExternalLink size={13} />
                  </a>
                )}
                <button type="button" onClick={() => edit(d)} className="shrink-0 text-[#555] hover:text-white" aria-label="Edit">
                  <Pencil size={13} />
                </button>
                <button type="button" onClick={() => removeDrop(d.id)} className="shrink-0 text-[#555] hover:text-[#FF4B2B]" aria-label="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(UpcomingDropsPanel);
