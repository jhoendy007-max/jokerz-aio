import { useMemo, useState, useSyncExternalStore } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { BarChart3, Receipt, Download, MailSearch, Trash2 } from 'lucide-react';
import { loadCheckoutLog } from '../lib/dailySummary';
import { buildResults } from '../lib/analytics';
import { loadOrders, subscribeOrders, getOrdersVersion, setOrderStatus, removeOrder, mergeEmailOrders, ordersToCsv, ORDER_STATUSES, type OrderStatus } from '../lib/orders';
import { loadSettings, saveSettings } from '../lib/storage';
import { API_BASE } from '../engine/apiBase';

const card = 'rounded-xl bg-[#111] border border-[#1e1e1e] p-4';
const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wide';
const input = 'bg-[#0a0a0a] border border-[#1f1f1f] rounded-md px-2.5 py-1.5 text-[12px] text-white placeholder-[#555] focus:outline-none focus:border-[#7B2CBF]';
const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS_COLOR: Record<OrderStatus, string> = { placed: 'text-[#aaa]', confirmed: 'text-sky-300', shipped: 'text-amber-300', delivered: 'text-emerald-400', cancelled: 'text-red-400' };

function download(name: string, text: string, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function ResultsTab() {
  const [days, setDays] = useState(30);
  const [dry, setDry] = useState(false);
  const r = useMemo(() => buildResults(loadCheckoutLog() as any, { days, includeDryRuns: dry }), [days, dry]);
  const stat = (label: string, value: string, sub?: string, color = 'text-white') => (
    <div className={card}>
      <p className="text-[10px] uppercase tracking-widest text-[#666] font-bold">{label}</p>
      <p className={`text-2xl font-black mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-[#555] mt-0.5">{sub}</p>}
    </div>
  );
  const dayData = r.byDay.map((d) => ({ ...d, label: d.day.slice(5) }));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {[7, 30, 90].map((d) => (
          <button key={d} type="button" onClick={() => setDays(d)} className={`${btn} border ${days === d ? 'bg-[#7B2CBF] border-[#7B2CBF] text-white' : 'border-[#262626] text-[#999] hover:text-white'}`}>
            {d} days
          </button>
        ))}
        <label className="ml-3 inline-flex items-center gap-2 text-[11px] text-[#999]">
          <input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} className="accent-[#7B2CBF]" /> Include dry runs
        </label>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {stat('Checkouts', String(r.success), `${r.items} item(s)`, 'text-emerald-400')}
        {stat('Failed', String(r.failed), r.topReasons[0] ? `top: ${r.topReasons[0].reason}` : undefined, r.failed ? 'text-red-400' : 'text-white')}
        {stat('Success rate', `${r.successRate}%`, `${r.total} attempt(s)`)}
        {stat('Total spent', money(r.spend), `last ${days} days`, 'text-[#c79bff]')}
      </div>
      <div className={card}>
        <p className="text-[11px] font-bold uppercase tracking-widest text-white mb-3">Checkouts per day</p>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dayData} margin={{ left: -20, right: 8, top: 4 }}>
              <CartesianGrid stroke="#1c1c1c" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#666', fontSize: 10 }} interval="preserveStartEnd" minTickGap={14} />
              <YAxis allowDecimals={false} tick={{ fill: '#666', fontSize: 10 }} />
              <Tooltip contentStyle={{ background: '#141414', border: '1px solid #2a2a2a', fontSize: 11 }} cursor={{ fill: '#ffffff08' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="success" name="Success" stackId="a" fill="#34d399" radius={[0, 0, 0, 0]} />
              <Bar dataKey="failed" name="Failed" stackId="a" fill="#f87171" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className={card}>
          <p className="text-[11px] font-bold uppercase tracking-widest text-white mb-3">By store</p>
          {!r.byStore.length ? (
            <p className="text-[11px] text-[#555]">No checkouts in this range.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-[#555] text-left">
                  <th className="pb-2">Store</th>
                  <th className="pb-2 text-right">OK</th>
                  <th className="pb-2 text-right">Failed</th>
                  <th className="pb-2 text-right">Rate</th>
                  <th className="pb-2 text-right">Spent</th>
                </tr>
              </thead>
              <tbody>
                {r.byStore.map((s) => (
                  <tr key={s.store} className="border-t border-[#191919]">
                    <td className="py-1.5 text-white">{s.store}</td>
                    <td className="py-1.5 text-right text-emerald-400 font-mono">{s.success}</td>
                    <td className="py-1.5 text-right text-red-400 font-mono">{s.failed}</td>
                    <td className="py-1.5 text-right font-mono text-[#ccc]">{s.rate}%</td>
                    <td className="py-1.5 text-right font-mono text-[#c79bff]">{money(s.spend)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className={card}>
          <p className="text-[11px] font-bold uppercase tracking-widest text-white mb-3">Top products</p>
          {!r.topProducts.length ? (
            <p className="text-[11px] text-[#555]">No checkouts in this range.</p>
          ) : (
            <div className="space-y-1.5">
              {r.topProducts.map((p) => (
                <div key={`${p.store}|${p.product}`} className="flex items-center gap-2 text-[12px]">
                  <span className="text-[10px] uppercase text-[#666] w-16 shrink-0 truncate">{p.store}</span>
                  <span className="text-white truncate flex-1">{p.title || p.product}</span>
                  <span className="text-emerald-400 font-mono">{p.success}</span>
                  {p.failed ? <span className="text-red-400 font-mono">/{p.failed}</span> : null}
                  <span className="text-[#c79bff] font-mono w-20 text-right">{money(p.spend)}</span>
                </div>
              ))}
            </div>
          )}
          {r.topReasons.length > 0 && (
            <>
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#666] mt-4 mb-1.5">Why checkouts failed</p>
              {r.topReasons.map((x) => (
                <div key={x.reason} className="flex text-[11px] text-[#bbb]">
                  <span className="flex-1 truncate">{x.reason}</span>
                  <span className="font-mono text-red-400">{x.count}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OrdersTab() {
  useSyncExternalStore(subscribeOrders, getOrdersVersion, getOrdersVersion);
  const orders = loadOrders();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = loadSettings() as any;
  const [imapUser, setImapUser] = useState<string>(s.imapUser || '');
  const [imapPass, setImapPass] = useState<string>(s.imapPass || '');
  const [imapHost, setImapHost] = useState<string>(s.imapHost || '');

  const shown = orders.filter((o) => (!status || o.status === status) && (!filter || `${o.store} ${o.orderNumber} ${o.account || ''} ${o.product || ''} ${o.title || ''}`.toLowerCase().includes(filter.toLowerCase())));

  const scan = async () => {
    setBusy(true);
    setMsg(null);
    saveSettings({ ...(loadSettings() as any), imapUser, imapPass, imapHost });
    try {
      const r = await fetch(`${API_BASE}/api/orders/scan-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: imapUser, pass: imapPass, host: imapHost, days: 30 }) }).then((x) => x.json());
      if (!r.ok) setMsg({ ok: false, text: r.error || 'Could not read the inbox' });
      else {
        const m = mergeEmailOrders(r.orders || []);
        setMsg({ ok: true, text: `Read ${r.scanned ?? 0} email(s) · ${r.orders?.length ?? 0} order email(s) · ${m.added} new · ${m.updated} updated` });
      }
    } catch {
      setMsg({ ok: false, text: 'Engine server offline' });
    }
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-bold uppercase tracking-widest text-white inline-flex items-center gap-2">
            <MailSearch size={13} className="text-[#9D4EDD]" /> Read order emails (last 30 days)
          </p>
          <span className="text-[10px] text-[#555]">read-only · emails are never changed or marked as read</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[2fr_2fr_1.5fr_auto] gap-2">
          <input value={imapUser} onChange={(e) => setImapUser(e.target.value.trim())} placeholder="Email (you@gmail.com)" className={input} />
          <input type="password" value={imapPass} onChange={(e) => setImapPass(e.target.value)} placeholder="App password" className={input} />
          <input value={imapHost} onChange={(e) => setImapHost(e.target.value.trim())} placeholder="IMAP host (auto)" className={input} />
          <button type="button" onClick={scan} disabled={busy || !imapUser || !imapPass} className={`${btn} bg-[#7B2CBF] text-white hover:bg-[#9D4EDD] disabled:opacity-50 justify-center`}>
            {busy ? 'Reading…' : 'Scan email'}
          </button>
        </div>
        <p className="text-[10px] text-[#555] mt-1.5">Gmail: turn on 2-step verification → Google Account → App passwords. Finds Target, Walmart, Pokémon Center and Bandai order / shipped / delivered / cancelled emails.</p>
        {msg && <p className={`text-[11px] mt-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search order #, store, account…" className={`${input} flex-1 min-w-[220px]`} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={input} aria-label="Status">
          <option value="">All statuses</option>
          {ORDER_STATUSES.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => download(`jokerz-orders-${new Date().toISOString().slice(0, 10)}.csv`, ordersToCsv(shown))} disabled={!shown.length} className={`${btn} border border-[#262626] text-[#ccc] hover:text-white disabled:opacity-50`}>
          <Download size={12} /> CSV
        </button>
      </div>
      <div className={`${card} p-0 overflow-x-auto`}>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-[#555] text-left">
              <th className="px-4 py-2.5">Date</th>
              <th className="py-2.5">Store</th>
              <th className="py-2.5">Order #</th>
              <th className="py-2.5">Product</th>
              <th className="py-2.5">Account</th>
              <th className="py-2.5 text-right">Total</th>
              <th className="py-2.5 pl-4">Status</th>
              <th className="py-2.5 pr-4" />
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.id} className="border-t border-[#191919] hover:bg-white/[0.02]">
                <td className="px-4 py-2 text-[#999] whitespace-nowrap">{new Date(o.t).toLocaleDateString()}</td>
                <td className="py-2 text-white">{o.store}</td>
                <td className="py-2 font-mono text-[#ddd]">{o.orderNumber}</td>
                <td className="py-2 text-[#bbb] max-w-[260px] truncate">{o.title || o.product || (o.emailSubject ? <span className="text-[#666]">{o.emailSubject}</span> : '—')}</td>
                <td className="py-2 text-[#999]">{o.account || '—'}</td>
                <td className="py-2 text-right font-mono text-[#c79bff]">{o.total || '—'}</td>
                <td className="py-2 pl-4">
                  <select value={o.status} onChange={(e) => setOrderStatus(o.id, e.target.value as OrderStatus)} className={`bg-transparent text-[11px] font-bold uppercase ${STATUS_COLOR[o.status]} focus:outline-none`} aria-label="Order status">
                    {ORDER_STATUSES.map((x) => (
                      <option key={x} value={x} className="bg-[#111] text-white">
                        {x}
                      </option>
                    ))}
                  </select>
                  <span className="text-[9px] text-[#555] ml-1 uppercase">{o.source}</span>
                </td>
                <td className="py-2 pr-4 text-right">
                  <button type="button" onClick={() => window.confirm(`Remove order ${o.orderNumber} from the log?`) && removeOrder(o.id)} className="text-[#555] hover:text-red-400" aria-label="Remove">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={8} className="text-center text-[#555] py-10">
                  No orders yet — real checkouts are added automatically, or scan your email.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ResultsView() {
  const [tab, setTab] = useState<'results' | 'orders'>(() => (localStorage.getItem('jokerz_results_tab') === 'orders' ? 'orders' : 'results'));
  const pick = (t: 'results' | 'orders') => {
    setTab(t);
    try {
      localStorage.setItem('jokerz_results_tab', t);
    } catch {
      /* */
    }
  };
  return (
    <div className="p-5 space-y-4 max-w-[1400px] mx-auto min-h-full">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-black italic uppercase tracking-tighter text-white">Results</h1>
          <p className="text-[10px] text-[#555] mt-1 uppercase font-bold tracking-widest">Checkouts by store, day and product · order log</p>
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-[#0a0a0a] border border-[#1a1a1a]">
          {(
            [
              ['results', 'Results', BarChart3],
              ['orders', 'Orders', Receipt],
            ] as const
          ).map(([id, label, Icon]) => (
            <button key={id} type="button" onClick={() => pick(id)} className={`${btn} ${tab === id ? 'bg-[#7B2CBF] text-white' : 'text-[#888] hover:text-white'}`}>
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'results' ? <ResultsTab /> : <OrdersTab />}
    </div>
  );
}
