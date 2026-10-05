import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CreateTaskFormState, Store, Profile } from '../types';
import { defaultsForStore, loadProfiles, loadProxies, loadSettings, ProxyGroup } from '../lib/storage';
import { accountsForStore } from '../lib/storeFolders';
import { isAdmin, canTuneAdvancedEngine } from '../lib/access';
import { CircleHelp, ChevronDown, ChevronRight, Folder } from 'lucide-react';

/** Collapsible profile picker: expand group → entire group or one profile */
function ProfilePicker({
  value,
  onChange,
  groups,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: [string, Profile[]][];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Auto-expand group of current value
  useEffect(() => {
    if (!value) return;
    if (value.startsWith('group:')) {
      const g = value.slice(6);
      setExpanded((e) => ({ ...e, [g]: true }));
      return;
    }
    for (const [g, list] of groups) {
      if (list.some((p) => p.name === value || p.id === value)) {
        setExpanded((e) => ({ ...e, [g]: true }));
        break;
      }
    }
  }, [value, groups]);

  const label = (() => {
    if (!value) return '— select profile or group —';
    if (value.startsWith('group:')) return `★ Entire group · ${value.slice(6)}`;
    return value;
  })();

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${className} flex items-center justify-between gap-2 text-left`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={14} className={`shrink-0 text-[#666] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-[80] left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-[#2a2a2a] bg-[#121212] shadow-xl">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-[#888] hover:bg-[#1a1a1a]"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          >
            — select profile or group —
          </button>
          {groups.map(([groupName, list]) => {
            const isOpen = expanded[groupName] !== false; // default open
            const forced = expanded[groupName] === true || expanded[groupName] === undefined;
            const show = expanded[groupName] ?? true;
            return (
              <div key={groupName} className="border-t border-[#1a1a1a]">
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-[#C77DFF] hover:bg-[#1a1a1a] font-medium"
                  onClick={() =>
                    setExpanded((e) => ({
                      ...e,
                      [groupName]: !(e[groupName] ?? true),
                    }))
                  }
                >
                  {show ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Folder size={14} />
                  <span className="truncate">
                    {groupName} ({list.length})
                  </span>
                </button>
                {show && (
                  <div className="pb-1">
                    <button
                      type="button"
                      className={`w-full text-left pl-9 pr-3 py-1.5 text-[13px] hover:bg-[#1a1a1a] ${
                        value === `group:${groupName}` ? 'text-[#00FF41]' : 'text-white'
                      }`}
                      onClick={() => {
                        onChange(`group:${groupName}`);
                        setOpen(false);
                      }}
                    >
                      ★ Entire group · {groupName} ({list.length})
                    </button>
                    {list.map((p) => {
                      const v = p.name || p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`w-full text-left pl-9 pr-3 py-1.5 text-[13px] hover:bg-[#1a1a1a] truncate ${
                            value === v ? 'text-[#00FF41]' : 'text-[#ccc]'
                          }`}
                          onClick={() => {
                            onChange(v);
                            setOpen(false);
                          }}
                        >
                          {p.name || p.id}
                          {p.zip ? ` · ${p.zip}` : ''}
                          {p.cardEnd ? ` · ••${p.cardEnd}` : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Fixed-position portal tooltip — never clipped by modal overflow */
function HelpTip({ text }: { text: string }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const tipW = 280;
    let left = r.left;
    // Keep inside viewport
    if (left + tipW > window.innerWidth - 12) left = window.innerWidth - tipW - 12;
    if (left < 12) left = 12;
    let top = r.bottom + 8;
    // If near bottom, flip above
    if (top + 80 > window.innerHeight) top = r.top - 8 - 72;
    setPos({ top, left });
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="inline-flex items-center align-middle ml-1.5 cursor-help p-0 border-0 bg-transparent"
        aria-label={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <CircleHelp
          size={14}
          strokeWidth={2.25}
          className="text-[#9D4EDD] hover:text-[#C77DFF] transition-colors shrink-0"
        />
      </button>
      {open &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: 280,
              zIndex: 99999,
            }}
            className="px-3 py-2.5 rounded-lg bg-[#1a1028] border border-[#9D4EDD]/70 text-[12px] leading-relaxed text-[#F0EAF8] shadow-[0_12px_32px_rgba(0,0,0,0.65)] pointer-events-none"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}

const defaultProxyGroups: ProxyGroup[] = [
  { id: '1', name: 'DC-Resi', count: 0, type: 'Residential', status: 'Online', proxies: [] },
  { id: '2', name: 'ISPs-VA', count: 0, type: 'ISP', status: 'Online', proxies: [] },
  { id: '3', name: 'Localhost', count: 1, type: 'Local', status: 'Online', proxies: [] },
];


interface CreateTaskModalProps {
  form: CreateTaskFormState;
  onChange: (updates: Partial<CreateTaskFormState>) => void;
  onClose: () => void;
  onSave: () => void;
  /** When set, modal is in edit mode for that task id */
  editingTaskId?: string | null;
}

export default function CreateTaskModal({ form, onChange, onClose, onSave, editingTaskId }: CreateTaskModalProps) {
  const set = (key: keyof CreateTaskFormState, value: any) => {
    onChange({ [key]: value });
  };

  const proxyGroups = loadProxies(defaultProxyGroups);
  const proxyOptions = proxyGroups.length
    ? proxyGroups.map((g) => ({
        value: g.name,
        label: `${g.name} (${g.proxies?.length || g.count || 0})`,
      }))
    : [{ value: 'Localhost', label: 'Localhost (0)' }];

  // Real profiles from Profiles tab — groups + individual profiles
  const profiles: Profile[] = loadProfiles([]);
  const profileGroups = (() => {
    const map = new Map<string, Profile[]>();
    for (const p of profiles) {
      const g = String(p.group || 'Personal').trim() || 'Personal';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(p);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  })();

  const isMonitor = form.mode === 'monitor';
  const isWalmart = form.store === 'Walmart';
  const isTarget = form.store === 'Target';
  const isPokemon = form.store === 'Pokemon Center';
  const isBandai = form.store === 'Bandai Collectables';
  const admin = isAdmin();
  const storeAccounts = accountsForStore(loadSettings(), form.store);

  // Shared select style — always clickable (no appearance-none traps on Windows)
  const selectClass =
    'w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all cursor-pointer';
  const inputClass =
    'w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-5xl p-6 shadow-2xl animate-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto overflow-x-visible">
        <h2 className="text-xl font-bold text-white mb-6">{editingTaskId ? 'Edit Task' : 'Create Tasks'}</h2>
        {editingTaskId && (
          <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest -mt-4 mb-4">
            Editing {editingTaskId.slice(0, 8)} · stop the task before changing store/mode if it was running
          </p>
        )}
        {!isAdmin() && (
          <div className="mb-4 px-3 py-2 rounded-sm border border-purple-800/50 bg-purple-500/10 text-[10px] text-purple-200 font-bold uppercase tracking-widest">
            Defaults by store applied — you can edit delay / reset anytime
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-x-6 gap-y-4">
          {/* Name + Store */}
          <div className="md:col-span-4 grid grid-cols-1 md:grid-cols-2 gap-x-6">
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Enter Task Name"
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Store</label>
              <select
                value={form.store}
                onChange={(e) => {
                  const store = e.target.value as Store;
                  const d = defaultsForStore(store);
                  onChange({
                    store,
                    mode: d.mode as any,
                    delay: d.delay,
                    monitoringDelay: d.delay,
                    priority: d.priority as any,
                    monitorProxy: d.monitorProxy,
                    checkoutProxy: d.checkoutProxy,
                  });
                }}
                className={selectClass}
              >
                <option value="Walmart">Walmart</option>
                <option value="Target">Target</option>
                <option value="Pokemon Center">Pokemon Center</option>
                <option value="Bandai Collectables">Bandai Collectables</option>
              </select>
            </div>
          </div>


          {!admin && (
            <div className="md:col-span-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] font-bold uppercase tracking-widest text-[#888]">
              <div className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-lg px-3 py-2">
                Delay <span className="text-white">{form.delay}ms</span>
              </div>
              <div className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-lg px-3 py-2">
                Priority <span className="text-white">{form.priority}</span>
              </div>
              <div className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-lg px-3 py-2">
                Mode <span className="text-white">{form.mode}</span>
              </div>
              <div className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-lg px-3 py-2 text-purple-300">
                Auto by store
              </div>
            </div>
          )}

          {/* Mode */}
          <div>
            <label className="text-sm font-medium text-[#888] mb-2 block">
              Mode*
              <HelpTip text="monitor: only checks stock. shipping/preorder: waits for IN STOCK then ATC. pickup: store pickup." />
            </label>
            <select
              value={form.mode}
              onChange={(e) => set('mode', e.target.value)}
              className={selectClass}
            >
              {isWalmart && (
                <>
                  <option value="checkout">checkout</option>
                  <option value="monitor">monitor</option>
                </>
              )}
              {isTarget && (
                <>
                  <option value="shipping">shipping (dry-run / checkout)</option>
                  <option value="preorder">preorder (ATC when pre-order opens)</option>
                  <option value="pickup">pickup</option>
                  <option value="monitor">monitor</option>
                </>
              )}
              {isPokemon && (
                <>
                  <option value="guest">guest</option>
                  <option value="login">login</option>
                  <option value="monitor">monitor + queue</option>
                </>
              )}
              {isBandai && (
                <>
                  <option value="normal">normal</option>
                  <option value="monitor">monitor</option>
                </>
              )}
            </select>
          </div>

          {/* Profile — entire group OR one specific profile */}
          {!isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">
                Profile*
                <span className="text-[10px] text-[#555] font-normal normal-case ml-2">
                  group or single
                </span>
              </label>
              <ProfilePicker
                value={form.profile || ''}
                onChange={(v) => set('profile', v)}
                groups={profileGroups}
                className={selectClass}
              />
              {!profiles.length && (
                <p className="text-[10px] text-amber-400 mt-1 font-bold uppercase tracking-widest">
                  Go to Profiles → New Group / New Profile → reopen this form
                </p>
              )}
              {String(form.profile || '').startsWith('group:') && (
                <p className="text-[10px] text-[#7B2CBF] mt-1 font-bold uppercase tracking-widest">
                  Checkout: 1 task per profile. Each uses the Account you pick (or All accounts).
                </p>
              )}
            </div>
          )}

          {!isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">
                Account*
                <HelpTip text="Login runs on THIS task (Refract). Settings → Accounts is only email + password. Session stays on the task until the monitor pings this TCIN." />
              </label>
              <select
                value={form.accountEmail || ''}
                onChange={(e) => set('accountEmail', e.target.value)}
                className={selectClass}
              >
                <option value="">— select account —</option>
                {storeAccounts.length > 1 && <option value="all">All accounts (1 task each)</option>}
                {storeAccounts.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.email}
                  </option>
                ))}
              </select>
              {!storeAccounts.length && (
                <p className="text-[10px] text-amber-400 mt-1 font-bold uppercase tracking-widest">
                  Settings → Accounts → add email:password for {form.store}
                </p>
              )}
            </div>
          )}

          {!isMonitor && form.store === 'Target' && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">
                Live checkout
                <HelpTip text="OFF = dry-run (Ship it → cart only). ON = fill profile card/address and Place order. 3DS still needs you in headed Chrome." />
              </label>
              <div className="flex items-center h-[42px] gap-3">
                <input
                  type="checkbox"
                  checked={!!form.liveCheckout}
                  onChange={(e) => {
                    if (e.target.checked) {
                      const ok = window.confirm(
                        'LIVE checkout: when the monitor says IN STOCK, this task will Place order with the profile card.\n\nBank 3DS/OTP: Chrome stays open — you may need to type the code.\n\nTurn ON?'
                      );
                      if (!ok) return;
                      set('liveCheckout', true);
                      set('solve3ds', true);
                    } else {
                      set('liveCheckout', false);
                    }
                  }}
                  className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                />
                <span className="text-xs text-[#888]">
                  {form.liveCheckout ? 'LIVE · will place order' : 'Dry-run · no charge'}
                </span>
              </div>
            </div>
          )}

          {/* Priority */}
          <div>
            <label className="text-sm font-medium text-[#888] mb-2 block">Priority</label>
            <select
              value={form.priority || 'normal'}
              onChange={(e) => set('priority', e.target.value)}
              className={selectClass}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High (monitors default)</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          {/* Checkout Proxy */}
          {!isMonitor && (
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 flex items-center gap-2">
                  Proxy bind
                  <span className="text-[10px] text-[#666] font-normal">
                    SAME = login + harvest + ATC una IP (ISP o resi)
                  </span>
                </label>
                <div className="flex gap-2">
                  {(['same', 'split'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        set('proxyBind', m);
                        if (m === 'same') {
                          set('loginProxy', form.checkoutProxy);
                          set('harvestProxy', form.checkoutProxy);
                        }
                      }}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-widest ${
                        (form.proxyBind || 'same') === m
                          ? 'bg-[#7B2CBF] text-white'
                          : 'bg-[#1a1a1a] text-[#888] border border-white/10'
                      }`}
                    >
                      {m === 'same' ? 'Same IP' : 'Split roles'}
                    </button>
                  ))}
                </div>
              </div>
              {(form.proxyBind || 'same') === 'same' ? (
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">Checkout / login / harvest*</label>
                  <select
                    value={form.checkoutProxy || proxyOptions[0]?.value || ''}
                    onChange={(e) => {
                      set('checkoutProxy', e.target.value);
                      set('loginProxy', e.target.value);
                      set('harvestProxy', e.target.value);
                    }}
                    className={selectClass}
                  >
                    {proxyOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {(
                    [
                      ['loginProxy', 'Login (often ISP)'],
                      ['harvestProxy', 'Harvest Shape (often ISP)'],
                      ['checkoutProxy', 'Checkout ATC (ISP or resi)'],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key}>
                      <label className="text-[11px] font-medium text-[#888] mb-1 block">{label}</label>
                      <select
                        value={(form as any)[key] || form.checkoutProxy || proxyOptions[0]?.value || ''}
                        onChange={(e) => set(key, e.target.value)}
                        className={selectClass}
                      >
                        {proxyOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Monitor Proxy */}
          {isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Monitor Proxy*</label>
              <select
                value={form.monitorProxy || proxyOptions[0]?.value || ''}
                onChange={(e) => set('monitorProxy', e.target.value)}
                className={selectClass}
              >
                {proxyOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Pokemon Center Region */}
          {isPokemon && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Region*</label>
              <select
                value={form.region}
                onChange={(e) => set('region', e.target.value)}
                className={selectClass}
              >
                <option value="US">US</option>
                <option value="UK">UK</option>
                <option value="CA">CA</option>
              </select>
            </div>
          )}

          {/* Pokemon Center URLs/PIDs */}
          {isPokemon && (
            <div className="md:col-span-4">
              <label className="text-sm font-medium text-[#888] mb-2 block">
                Enter product URLs or PIDs*
                <HelpTip text="Product page URL or PID from Pokemon Center. One per task is best for stable matching." />
              </label>
              <input
                type="text"
                value={form.urlsOrPids}
                onChange={(e) => set('urlsOrPids', e.target.value)}
                placeholder="123221`1"
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
            </div>
          )}

          {/* Target Input List */}
          {isTarget && (
            <div className="md:col-span-4">
              <label className="text-sm font-medium text-[#888] mb-2 block">
                TCIN / Input List*
                <HelpTip text="Target product ID (TCIN). Monitor and checkout use this SKU. One TCIN per task recommended." />
              </label>
              <input
                type="text"
                value={form.inputList}
                onChange={(e) => set('inputList', e.target.value)}
                placeholder="e.g. 1012055696 or one TCIN per line"
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
              <p className="text-[10px] text-[#555] mt-1">
                This is the product the monitor/checkout will use. Edit and Save to change TCIN.
              </p>
            </div>
          )}

          {/* Walmart / Bandai specific */}
          {(isWalmart || isBandai) && (
            <>
              {isWalmart && !isMonitor && (
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">Queue Proxy</label>
                  <select
                    value={form.queueProxy}
                    onChange={(e) => set('queueProxy', e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Select Queue Proxy</option>
                    {proxyOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  SKU{isBandai ? '*' : ''}
                  {isBandai && (
                    <HelpTip text="Bandai product SKU / product code used for monitor and cart." />
                  )}
                </label>
                <input
                  type="text"
                  value={form.sku}
                  onChange={(e) => set('sku', e.target.value)}
                  placeholder="19965460207"
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
                />
              </div>

              {isWalmart && !isMonitor && (
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">Offer Id</label>
                  <input
                    type="text"
                    value={form.offerId}
                    onChange={(e) => set('offerId', e.target.value)}
                    placeholder="Enter Offer Id"
                    className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-[#888] focus:outline-none focus:border-[#7B2CBF] transition-all"
                  />
                </div>
              )}
            </>
          )}

          {/* Coupon (Pokemon) */}
          {isPokemon && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Coupon</label>
              <input
                type="text"
                value={form.coupon}
                onChange={(e) => set('coupon', e.target.value)}
                placeholder="Enter Coupon"
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-[#888] focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
            </div>
          )}

          {/* Delay */}
          {true && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Task Delay* (ms)</label>
              <input
                type="number"
                value={form.delay}
                onChange={(e) => set('delay', Number(e.target.value))}
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
            </div>
          )}

          {/* Monitoring Delay */}
          {isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Monitoring Task Delay* (ms)</label>
              <input
                type="number"
                value={form.monitoringDelay}
                onChange={(e) => set('monitoringDelay', Number(e.target.value))}
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
            </div>
          )}

          {/* Module Unlock Delay (Pokemon) — admin */}
          {isPokemon && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Module Unlock Delay (ms)</label>
              <input
                type="number"
                value={form.moduleUnlockDelay}
                onChange={(e) => set('moduleUnlockDelay', Number(e.target.value))}
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
            </div>
          )}

          {/* Qty = how many task rows to create (not cart quantity) */}
          {!isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block"># of tasks</label>
              <input
                type="number"
                min={1}
                max={50}
                value={form.qty || 1}
                onChange={(e) => set('qty', Math.max(1, Number(e.target.value) || 1))}
                className={inputClass}
              />
              <p className="text-[10px] text-[#555] mt-1">Creates this many task rows (cart qty stays 1 for dry-run)</p>
            </div>
          )}

          {/* Session — optional label, free text (not a locked fake select) */}
          {!isPokemon && !isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Session (optional)</label>
              <input
                type="text"
                value={form.session || ''}
                onChange={(e) => set('session', e.target.value)}
                placeholder="Leave empty for auto"
                className={inputClass}
              />
            </div>
          )}

          {/* Pokemon specific: Min items + Catch All */}
          {isPokemon && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Minimum Items In Cart*
                  <HelpTip text="Cart must reach this many items before checkout continues (PKC multi-item)." />
                </label>
                <input
                  type="number"
                  value={form.minItemsInCart}
                  onChange={(e) => set('minItemsInCart', Number(e.target.value))}
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Catch All?
                  <HelpTip text="If on, tries any matching in-stock product in the list instead of one fixed PID." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.catchAll}
                    onChange={(e) => set('catchAll', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
            </>
          )}

          {/* IMAP Session */}
          {(isWalmart || isTarget) && !isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">
                {isTarget ? 'Imap Session (Login)' : 'Imap Session'}
                <HelpTip text="Inbox used for login/2FA emails. Pick the mailbox linked to this account." />
              </label>
              <select
                value={form.imapSession}
                onChange={(e) => set('imapSession', e.target.value)}
                className={selectClass}
              >
                <option value="AYCD Inbox">AYCD Inbox</option>
                <option value="jhoendy">jhoendy</option>
              </select>
            </div>
          )}

          {/* Walmart OTP + SMS */}
          {isWalmart && !isMonitor && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  OTP Input*
                  <HelpTip text="Where to read one-time passcodes for Walmart login (IMAP inbox)." />
                </label>
                <select
                  value={form.otpInput}
                  onChange={(e) => set('otpInput', e.target.value)}
                  className={selectClass}
                >
                  <option value="IMAP">IMAP</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Check SMS Verification
                  <HelpTip text="If on, waits for SMS verification codes during login/checkout." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.checkSms}
                    onChange={(e) => set('checkSms', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
            </>
          )}

          {/* Target / Bandai: Extra TCIN, Auto Cancel, Watch Task */}
          {(isTarget || isBandai) && !isMonitor && (
            <>
              {isTarget && (
                <>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">
                      Extra Item TCIN
                      <HelpTip text="Optional second TCIN to add to cart with the main item (bundle / filler)." />
                    </label>
                    <input
                      type="text"
                      value={form.extraTcin}
                      onChange={(e) => set('extraTcin', e.target.value)}
                      placeholder="Enter Extra Item TCIN"
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-[#888] focus:outline-none focus:border-[#7B2CBF] transition-all"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">
                      Auto Cancel Extra TCIN?
                      <HelpTip text="If on, removes the extra TCIN from cart after main item is secured." />
                    </label>
                    <div className="flex items-center h-[42px]">
                      <input
                        type="checkbox"
                        checked={form.autoCancel}
                        onChange={(e) => set('autoCancel', e.target.checked)}
                        className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                      />
                    </div>
                  </div>
                </>
              )}
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Watch Task?
                  <HelpTip text="Keeps task alive watching stock / retries instead of stopping after one pass." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.watchTask}
                    onChange={(e) => set('watchTask', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
            </>
          )}

          {/* Walmart Checkout SMS + Reset Password */}
          {isWalmart && !isMonitor && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block truncate">
                  Checkout SMS Verification
                  <HelpTip text="SMS provider/inbox used if Walmart asks for checkout verification." />
                </label>
                <select
                  value={form.checkoutSms}
                  onChange={(e) => set('checkoutSms', e.target.value)}
                  className={selectClass}
                >
                  <option value="">Select Checkout SMS Verification</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Reset Invalid Password
                  <HelpTip text="If login fails for bad password, try reset flow instead of hard fail." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.resetInvalid}
                    onChange={(e) => set('resetInvalid', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
            </>
          )}

          {/* Target Monitor High Stock + alert cooldown */}
          {isTarget && isMonitor && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Monitor High Stock (10+) Only?
                  <HelpTip text="Only alert when quantity is 10 or more. Ignores low stock noise." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.monitorHighStock}
                    onChange={(e) => set('monitorHighStock', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Stock Alert Cooldown (ms)
                  <HelpTip text="Min time between Discord/Slack stock alerts for the same TCIN. 180000 = 3 min." />
                </label>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={form.stockAlertCooldownMs ?? '180000'}
                  onChange={(e) => set('stockAlertCooldownMs', e.target.value)}
                  placeholder="180000"
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all font-mono"
                />
                <p className="text-[10px] text-[#555] mt-1">
                  Discord/Slack por TCIN. 180000 = 3 min · 300000 = 5 min · 0 = sin cooldown de webhook
                </p>
              </div>
            </>
          )}

          {/* Walmart Monitor Max Price + 3rd Party */}
          {isWalmart && isMonitor && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Max Price
                  <HelpTip text="Ignore stock if price is above this amount (Walmart monitor filter)." />
                </label>
                <input
                  type="text"
                  value={form.maxPrice}
                  onChange={(e) => set('maxPrice', e.target.value)}
                  placeholder="Enter Max Price"
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-[#888] focus:outline-none focus:border-[#7B2CBF] transition-all"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Allow 3rd Party?
                  <HelpTip text="If on, accept marketplace/3rd-party sellers. Off = Walmart sold only." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.allow3rdParty}
                    onChange={(e) => set('allow3rdParty', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
            </>
          )}

          {/* Reset Delay */}
          {(isWalmart || isTarget) && isMonitor && (
            <div>
              <label className="text-sm font-medium text-[#888] mb-2 block">Reset Delay (ms) — independent of poll</label>
              <input
                type="text"
                value={form.resetDelay}
                onChange={(e) => set('resetDelay', e.target.value)}
                placeholder="7500"
                className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] transition-all"
              />
            </div>
          )}

          {/* Start / End Time */}
          <div>
            <label className="text-sm font-medium text-[#888] mb-2 block">
              Start Time
              <HelpTip text="Optional schedule: task arms only after this time (drop window)." />
            </label>
            <input
              type="text"
              value={form.startTime}
              onChange={(e) => set('startTime', e.target.value)}
              placeholder="Select Start Time"
              className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-[#888] focus:outline-none focus:border-[#7B2CBF] transition-all"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-[#888] mb-2 block">
              End Time
              <HelpTip text="Optional: stop the task after this time even if still running." />
            </label>
            <input
              type="text"
              value={form.endTime}
              onChange={(e) => set('endTime', e.target.value)}
              placeholder="Select End Time"
              className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-[#888] focus:outline-none focus:border-[#7B2CBF] transition-all"
            />
          </div>

          {/* Endless Mode (Target + Pokemon) */}
          {(isTarget || isPokemon) && !isMonitor && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Endless Mode
                  <HelpTip text="After a checkout attempt, loop again until limit or stop (multi-checkout)." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.endlessMode}
                    onChange={(e) => set('endlessMode', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Endless Limit
                  <HelpTip text="Max successful loops in Endless Mode (empty = no hard cap)." />
                </label>
                <input
                  type="text"
                  value={form.endlessLimit}
                  onChange={(e) => set('endlessLimit', e.target.value)}
                  placeholder="Enter Endless Limit"
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-[#888] focus:outline-none focus:border-[#7B2CBF] transition-all"
                />
              </div>
            </>
          )}

          {/* Pokemon: Solve 3DS + Rotate Profiles */}
          {isPokemon && !isMonitor && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Solve 3DS?
                  <HelpTip text="Attempt to handle 3-D Secure bank challenge during payment." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.solve3ds}
                    onChange={(e) => set('solve3ds', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Rotate Profiles on Decline?
                  <HelpTip text="On card decline, switch to another profile and retry." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.rotateProfiles}
                    onChange={(e) => set('rotateProfiles', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
            </>
          )}

          {/* Target: Rakuten + TopCashback */}
          {isTarget && !isMonitor && (
            <>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Use Rakuten?
                  <HelpTip text="Open checkout via Rakuten cashback link when available." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.useRakuten}
                    onChange={(e) => set('useRakuten', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">
                  Use TopCashback?
                  <HelpTip text="Open checkout via TopCashback link when available." />
                </label>
                <div className="flex items-center h-[42px]">
                  <input
                    type="checkbox"
                    checked={form.useTopCashback}
                    onChange={(e) => set('useTopCashback', e.target.checked)}
                    className="w-5 h-5 rounded border-gray-700 bg-[#0F0F0F] focus:ring-[#7B2CBF]"
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer buttons */}
        <div className="flex justify-end gap-4 mt-8 pt-6 border-t border-gray-800 relative z-10">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2.5 bg-transparent border border-gray-700 text-[#888] hover:text-white hover:border-gray-500 text-sm font-medium transition-colors rounded-lg cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="px-6 py-2.5 bg-[#4c1d95] hover:bg-[#5b21b6] text-white text-sm font-medium transition-colors rounded-lg cursor-pointer"
          >
            {editingTaskId ? 'Save Changes' : 'Create Tasks'}
          </button>
        </div>
      </div>
    </div>
  );
}
