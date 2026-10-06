import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  memo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
} from 'react';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { initialTasks } from '../data';
import { Task, TaskStatus, CreateTaskFormState, defaultCreateTaskForm, Profile } from '../types';
import { Play, Square, Plus, Trash2, Edit2, Copy, Search, X, Terminal, ScrollText, ShoppingCart, Check } from 'lucide-react';

type LogEntry = { taskId: string; level: string; message: string; ts: number };

const LOG_PAGE = 40;

/** Infinite scroll log list — newest at bottom, load older on scroll-up */
function InfiniteLogList({
  entries,
  formatTime,
  className,
  emptyText,
}: {
  entries: LogEntry[];
  formatTime: (ts: number) => string;
  className?: string;
  emptyText?: string;
}) {
  const [visible, setVisible] = useState(LOG_PAGE);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const prevLen = useRef(entries.length);

  // Reset page when parent remounts (key=taskId) or list clears
  useEffect(() => {
    setVisible(LOG_PAGE);
    stickBottom.current = true;
    prevLen.current = entries.length;
  }, []);

  // Auto-scroll to bottom when new logs arrive and user was at bottom
  useEffect(() => {
    if (entries.length > prevLen.current && stickBottom.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
    prevLen.current = entries.length;
  }, [entries.length]);

  useEffect(() => {
    if (stickBottom.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [visible, entries]);

  const slice = useMemo(() => {
    // show last `visible` entries (oldest of the window first)
    const start = Math.max(0, entries.length - visible);
    return entries.slice(start);
  }, [entries, visible]);

  const hasMore = visible < entries.length;

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickBottom.current = distBottom < 48;
    // Near top → load older
    if (el.scrollTop < 80 && hasMore) {
      const prevHeight = el.scrollHeight;
      setVisible((v) => Math.min(v + LOG_PAGE, entries.length));
      requestAnimationFrame(() => {
        if (scrollerRef.current) {
          scrollerRef.current.scrollTop =
            scrollerRef.current.scrollHeight - prevHeight + el.scrollTop;
        }
      });
    }
  };

  if (!entries.length) {
    return (
      <div className={className}>
        <p className="text-[#555] text-center mt-12 text-[10px] uppercase tracking-widest font-bold">
          {emptyText || 'No logs yet'}
        </p>
      </div>
    );
  }

  return (
    <div ref={scrollerRef} onScroll={onScroll} className={className}>
      {hasMore && (
        <p className="text-center text-[10px] text-[#555] py-2 font-bold uppercase tracking-widest">
          Scroll up for older · showing {slice.length}/{entries.length}
        </p>
      )}
      {!hasMore && entries.length > LOG_PAGE && (
        <p className="text-center text-[10px] text-[#444] py-1">— beginning —</p>
      )}
      {slice.map((l, i) => (
        <div
          key={`${l.ts}-${i}-${l.message.slice(0, 12)}`}
          className="flex gap-3 border-b border-[#1a1220] pb-2 last:border-0"
        >
          <span className="text-[#444] shrink-0 w-14 text-[10px] pt-0.5">{formatTime(l.ts)}</span>
          <span
            className={
              l.level === 'error'
                ? 'text-[#FF4B2B]'
                : l.level === 'success'
                  ? 'text-[#00FF41]'
                  : l.level === 'warn'
                    ? 'text-yellow-400'
                    : 'text-[#ddd]'
            }
          >
            {l.message}
          </span>
        </div>
      ))}
    </div>
  );
}
import CreateTaskModal from './CreateTaskModal';
import {
  defaultsForStore,
  loadProfiles,
  loadProxies,
  loadSettings,
} from '../lib/storage';
import { loadTasks, saveTasks, appendTaskLog, getLogsForTask, loadTaskLogs } from '../lib/storage';
import { accountsForStore } from '../lib/storeFolders';
import { useEngine } from '../hooks/useEngine';
import { taskToEngineConfig } from '../lib/taskConfig';
import { sendDiscordWebhook } from '../engine/webhooks';
import { analyzeCollapseLogs, formatCollapseReport, CollapseReport } from '../engine/analyzeCollapse';

const STATUS_LABEL: Record<TaskStatus, string> = {
  idle: 'IDLE',
  queued: 'QUEUED',
  running: 'MONITORING',
  oos: 'OOS',
  instock: 'IN STOCK',
  carting: 'CARTING',
  carted: 'CARTED',
  checkout: 'CHECKOUT',
  success: 'SUCCESS',
  failed: 'FAILED',
};

const StatusBadge = memo(function StatusBadge({
  status,
  message,
  mode,
}: {
  status: TaskStatus;
  message?: string;
  mode?: string;
}) {
  const styles: Record<TaskStatus, string> = {
    idle: 'bg-gray-800/80 text-[#888] border-gray-700/80',
    queued: 'bg-orange-500/10 text-orange-400 border-orange-500/25',
    running: 'bg-sky-500/10 text-sky-400 border-sky-500/25',
    oos: 'bg-zinc-700/50 text-zinc-300 border-zinc-600/50',
    instock: 'bg-[#00FF41]/10/15 text-[#00FF41] border-emerald-500/35 shadow-[0_0_12px_rgba(52,211,153,0.15)]',
    carting: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/25',
    carted: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    checkout: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
    success: 'bg-green-500/15 text-green-400 border-green-500/35',
    failed: 'bg-[#FF4B2B]/10 text-[#FF4B2B] border-red-500/30',
  };

  const isMonitor = (mode || '').toLowerCase().includes('monitor');
  // Running monitor → MONITORING; running checkout → RUNNING
  let main =
    status === 'running' && isMonitor
      ? 'MONITORING'
      : status === 'running'
        ? 'RUNNING'
        : STATUS_LABEL[status] || status.toUpperCase();

  // Prefer engine message for stock states when short
  if (status === 'instock' && message) {
    main = message.toUpperCase().startsWith('IN STOCK') ? message : `IN STOCK`;
  }
  if (status === 'oos' && message) {
    main = message.toUpperCase().includes('OOS') || message.toUpperCase().includes('OUT')
      ? message.replace(/^OUT OF STOCK$/i, 'OOS')
      : 'OOS';
  }
  if (status === 'running' && message && /blocked|api offline|login/i.test(message)) {
    main = message;
  }

  const pulse =
    status === 'running' ||
    status === 'instock' ||
    status === 'carting' ||
    status === 'checkout';

  return (
    <div className="flex flex-col gap-0.5 min-w-[7.5rem]">
      <span
        className={`px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wider border ${styles[status]} inline-flex items-center gap-1.5 w-fit max-w-[14rem]`}
        title={message || main}
      >
        {pulse && (
          <span
            className={`w-1.5 h-1.5 rounded-full animate-pulse shrink-0 ${
              status === 'instock'
                ? 'bg-[#00FF41]/10'
                : status === 'running'
                  ? 'bg-sky-400'
                  : 'bg-purple-400'
            }`}
          />
        )}
        <span className="truncate">{main}</span>
      </span>
      {isMonitor && status !== 'idle' && (
        <span className="text-[9px] text-[#555] font-bold uppercase tracking-widest pl-0.5">
          monitor
        </span>
      )}
    </div>
  );
});


const TaskLogLine = memo(function TaskLogLine({
  level,
  message,
  time,
}: {
  level: string;
  message: string;
  time: string;
}) {
  return (
    <div className="flex gap-2 text-[11px] font-mono leading-relaxed">
      <span className="text-[#555] shrink-0">{time}</span>
      <span
        className={
          level === 'error'
            ? 'text-[#FF4B2B]'
            : level === 'success'
              ? 'text-[#00FF41]'
              : level === 'warn'
                ? 'text-amber-400'
                : 'text-[#888]'
        }
      >
        {message}
      </span>
    </div>
  );
});

const MODULES = ['All', 'Walmart', 'Pokemon Center', 'Target', 'Bandai Collectables'] as const;


/** Expand profile selection: group:X or single → list of concrete profiles */
function expandProfilesForCheckout(profileSel: string): Profile[] {
  const all = loadProfiles([]);
  const raw = String(profileSel || '').trim();
  if (!raw) return [];
  if (raw.startsWith('group:')) {
    const g = raw.slice(6).trim().toLowerCase();
    return all.filter((p) => String(p.group || 'Personal').trim().toLowerCase() === g);
  }
  // multi: comma / newline separated names
  if (raw.includes(',') || raw.includes('\n')) {
    const names = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const out: Profile[] = [];
    for (const n of names) {
      if (n.startsWith('group:')) {
        out.push(...expandProfilesForCheckout(n));
      } else {
        const p = all.find((x) => x.id === n || x.name === n);
        if (p) out.push(p);
      }
    }
    // unique by id
    const seen = new Set<string>();
    return out.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }
  const one = all.find((p) => p.id === raw || p.name === raw);
  return one ? [one] : [];
}

type AccountLink = {
  email?: string;
  /** account exists in Settings with password */
  ready: boolean;
  /** why not ready */
  reason?: string;
};

/** Match Settings account (email+pass) to profile email for this store */
function linkAccount(store: string, profile?: Profile): AccountLink {
  if (!profile) return { ready: false, reason: 'No profile' };
  const profileEmail = String(profile.email || '').trim();
  if (!profileEmail) {
    return {
      ready: false,
      reason: `Profile "${profile.name || profile.id}" has no email`,
    };
  }
  const settings = loadSettings();
  const list: any[] = accountsForStore(settings, store);
  const emailLc = profileEmail.toLowerCase();
  const hit = list.find(
    (a) => a?.email && String(a.email).trim().toLowerCase() === emailLc
  );
  if (!hit) {
    return {
      email: profileEmail,
      ready: false,
      reason: `No ${store} account for ${profileEmail} — add it in Settings → Accounts`,
    };
  }
  if (!String(hit.pass || hit.password || '').trim()) {
    return {
      email: String(hit.email).trim(),
      ready: false,
      reason: `Account ${hit.email} has no password in Settings`,
    };
  }
  return { email: String(hit.email).trim(), ready: true };
}

export default function TasksView() {
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks(initialTasks));
  const [search, setSearch] = useState('');
  const [activeModule, setActiveModule] = useState<string>('All');
  const [showCreate, setShowCreate] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [showMassEdit, setShowMassEdit] = useState(false);
  const [massEdit, setMassEdit] = useState({
    proxy: '',
    profile: '',
    delay: '',
    priority: '',
    mode: '',
  });
  const [form, setForm] = useState<CreateTaskFormState>(defaultCreateTaskForm);
  const [logs, setLogs] = useState<{ taskId: string; level: string; message: string; ts: number }[]>(() => loadTaskLogs());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  /** Full-screen log viewer for one task */
  const [logScreenTaskId, setLogScreenTaskId] = useState<string | null>(null);
  const [cookieBank, setCookieBank] = useState<{
    count: number;
    targetSize: number;
    ttlMinutes: number;
    harvesting: boolean;
    byModule?: Record<string, number>;
  } | null>(null);
  const [queueInfo, setQueueInfo] = useState({ queued: 0, running: 0, maxConcurrent: 5 });
  const [collapseReport, setCollapseReport] = useState<CollapseReport | null>(null);
  const [showCollapse, setShowCollapse] = useState(false);

  // ── Conectar con el Engine ──────────────────────────────────────
  const onStatus = useCallback((taskId: string, status: TaskStatus, message?: string) => {
    setTasks((prev) => {
      if (status === 'failed') {
        const task = prev.find((x) => x.id === taskId);
        const mode = (task?.mode || '').toLowerCase();
        const isMonitor = mode === 'monitor' || mode.includes('monitor');
        // Monitors must NOT spam "Checkout Failed" on Discord
        if (task && !isMonitor) {
          void sendDiscordWebhook('decline', {
            store: task.store || 'Unknown',
            product: task.product || taskId,
            status: message || 'failed',
            taskId,
          });
        }
      }
      return prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status,
              statusMessage: message || t.statusMessage,
              lastCheckAt: Date.now(),
            }
          : t
      );
    });
  }, []);

  const onLog = useCallback((taskId: string, level: string, message: string) => {
    const tid = String(taskId || '');
    const entry = { taskId: tid, level, message, ts: Date.now() };
    appendTaskLog(entry);
    // Keep more in memory so each task's modal stays independent
    setLogs((prev) => [...prev, entry].slice(-1500));
  }, []);

  const onCheckout = useCallback((taskId: string, data: any) => {
    console.log('[Checkout Success]', data);
    void sendDiscordWebhook('success', {
      store: data.store || 'Unknown',
      product: data.product || '',
      price: data.price,
      status: 'CHECKOUT_SUCCESS',
      taskId,
      extra: data.orderNumber ? `Order ${data.orderNumber}` : undefined,
    });
  }, []);

  const { startTask, stopTask, startAll, stopAll, registerTasks, deleteTask: engineDelete } =
    useEngine({ onStatus, onLog, onCheckout, onQueue: setQueueInfo });

  // Sync engine whenever task endpoints change (product, mode, proxy, store, etc.)
  const engineSyncKey = useMemo(
    () =>
      tasks
        .map(
          (t) =>
            `${t.id}|${t.store}|${t.mode}|${t.product}|${t.proxy}|${t.profile}|${t.sku || ''}|${t.offerId || ''}`
        )
        .join('~'),
    [tasks]
  );
  useEffect(() => {
    registerTasks(tasks.map(taskToEngineConfig));
  }, [engineSyncKey]);

  // Persistencia
  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  const debouncedSearch = useDebouncedValue(search, 250);
  const searchLower = debouncedSearch.trim().toLowerCase();
  const moduleLower = activeModule.toLowerCase();
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (activeModule !== 'All' && t.store.toLowerCase() !== moduleLower) return false;
      if (!searchLower) return true;
      return (
        t.product.toLowerCase().includes(searchLower) ||
        t.store.toLowerCase().includes(searchLower)
      );
    });
  }, [tasks, activeModule, moduleLower, searchLower]);

  const storeStats = useMemo(() => {
    const list = filteredTasks;
    const n = (...st: string[]) => list.filter((t) => st.includes(t.status)).length;
    return {
      total: list.length,
      running: n('running', 'queued', 'carting', 'checkout', 'instock'),
      carted: n('carted'),
      success: n('success'),
      oos: n('oos'),
      failed: n('failed'),
    };
  }, [filteredTasks]);


  const taskToForm = (task: Task): CreateTaskFormState => {
    const isTarget = task.store === 'Target';
    const isPokemon = task.store === 'Pokemon Center';
    return {
      ...defaultCreateTaskForm,
      name: (task as any).name || '',
      store: task.store as any,
      mode: (task.mode as any) || 'monitor',
      profile: task.profile || defaultCreateTaskForm.profile,
      checkoutProxy: task.proxy || defaultCreateTaskForm.checkoutProxy,
      monitorProxy: task.proxy || defaultCreateTaskForm.monitorProxy,
      delay: task.delay || defaultCreateTaskForm.delay,
      monitoringDelay: (task as any).monitoringDelay || task.delay || defaultCreateTaskForm.monitoringDelay,
      resetDelay: String((task as any).resetDelay ?? defaultCreateTaskForm.resetDelay ?? ''),
      monitorHighStock: !!(task as any).monitorHighStock,
      stockAlertCooldownMs: (task as any).stockAlertCooldownMs != null ? String((task as any).stockAlertCooldownMs) : defaultCreateTaskForm.stockAlertCooldownMs,
      moduleUnlockDelay: Number((task as any).moduleUnlockDelay) || defaultCreateTaskForm.moduleUnlockDelay,
      region: (task as any).region || defaultCreateTaskForm.region,
      sku: task.sku || (!isTarget && !isPokemon ? task.product : ''),
      offerId: task.offerId || '',
      inputList: isTarget ? task.product : '',
      urlsOrPids: isPokemon ? task.product : '',
      priority: (task.priority as any) || 'normal',
      qty: 1,
      accountEmail: (task as any).accountEmail || '',
      liveCheckout: !!(task as any).liveCheckout || !!(task as any).placeOrder,
      solve3ds: (task as any).solve3ds !== false,
      proxyBind: (task as any).proxyBind === 'split' ? 'split' : 'same',
      loginProxy: (task as any).loginProxy || task.proxy || defaultCreateTaskForm.loginProxy,
      harvestProxy: (task as any).harvestProxy || task.proxy || defaultCreateTaskForm.harvestProxy,
    };
  };

  const openEditTask = (task: Task) => {
    if (task.status === 'running' || task.status === 'carting' || task.status === 'checkout' || task.status === 'queued') {
      alert('Stop the task before editing.');
      return;
    }
    setEditingTaskId(task.id);
    setForm(taskToForm(task));
    setShowCreate(true);
  };

  const closeCreateModal = () => {
    setShowCreate(false);
    setEditingTaskId(null);
    setForm(defaultCreateTaskForm);
  };

  const updateForm = (updates: Partial<CreateTaskFormState>) => {
    setForm((prev) => ({ ...prev, ...updates }));
  };

  const handleCreateTasks = () => {
    let productValue = form.sku;
    if (form.store === 'Target') productValue = form.inputList;
    if (form.store === 'Pokemon Center') productValue = form.urlsOrPids;
    productValue = String(productValue || '').trim();

    if (!productValue) {
      alert(form.store === 'Target' ? 'Enter a TCIN / Input List' : 'Enter a product / SKU');
      return;
    }

    // Checkout / shipping needs a real profile + account
    const needsProfile = form.mode !== 'monitor';
    if (needsProfile && !String(form.profile || '').trim()) {
      alert('Select a Profile (create one in Profiles tab first)');
      return;
    }
    if (needsProfile && form.liveCheckout && form.store === 'Target') {
      const go = confirm(
        'This Target task is LIVE. On in-stock it will Place order (real money).\n\nCreate/save anyway?'
      );
      if (!go) return;
    }

    const mod = defaultsForStore(form.store);
    const proxy =
      form.mode === 'monitor'
        ? form.monitorProxy || mod.monitorProxy
        : form.checkoutProxy || mod.checkoutProxy;
    if (!proxy) {
      alert('Select a Proxy group');
      return;
    }
    const priority = form.priority || mod.priority;
    // Each setting independent — empty only falls back to module default, never to each other
    const delay = Number(form.delay) > 0 ? Number(form.delay) : mod.delay;
    const monitoringDelay =
      Number(form.monitoringDelay) > 0 ? Number(form.monitoringDelay) : mod.delay;
    const resetDelay =
      Number(form.resetDelay) > 0 ? Number(form.resetDelay) : 7500;
    const moduleUnlockDelay =
      Number(form.moduleUnlockDelay) > 0 ? Number(form.moduleUnlockDelay) : 12222;

    // ── Edit existing task ─────────────────────────────────────────
    if (editingTaskId) {
      const updated: Task = {
        ...(tasks.find((x) => x.id === editingTaskId) as Task),
        store: form.store,
        product: productValue,
        profile: form.profile,
        proxy,
        mode: form.mode,
        delay,
        monitoringDelay,
        resetDelay,
        monitorHighStock: !!form.monitorHighStock,
        stockAlertCooldownMs:
          form.stockAlertCooldownMs === '' || form.stockAlertCooldownMs == null
            ? 180000
            : Math.max(0, Number(form.stockAlertCooldownMs) || 0),
        sku: form.store === 'Target' ? productValue : form.sku,
        offerId: form.offerId,
        priority,
        accountEmail: form.accountEmail && form.accountEmail !== 'all' ? form.accountEmail : (tasks.find((x) => x.id === editingTaskId) as Task)?.accountEmail,
        liveCheckout: !!form.liveCheckout,
        placeOrder: !!form.liveCheckout,
        solve3ds: form.liveCheckout ? true : !!form.solve3ds,
        proxyBind: form.proxyBind === 'split' ? 'split' : 'same',
        loginProxy: form.proxyBind === 'split' ? form.loginProxy || proxy : proxy,
        harvestProxy: form.proxyBind === 'split' ? form.harvestProxy || proxy : proxy,
        status: 'idle',
        statusMessage: undefined,
        lastCheckAt: undefined,
      };
      setTasks((prev) => prev.map((t) => (t.id === editingTaskId ? updated : t)));
      // Always push latest endpoint config to engine (product/mode/proxy/store)
      registerTasks([taskToEngineConfig(updated)]);
      console.log('[tasks] updated engine config', {
        id: updated.id,
        store: updated.store,
        mode: updated.mode,
        product: updated.product,
        proxy: updated.proxy,
      });
      closeCreateModal();
      return;
    }

    // ── Create new ─────────────────────────────────────────────────
    // Checkout: 1 task per profile × account (Refract: login lives on the task)
    const isCheckout = form.mode !== 'monitor';
    type Slot = {
      profileName: string;
      accountEmail?: string;
      accountReady: boolean;
      accountReason?: string;
    };
    let profileSlots: Slot[] = [{ profileName: form.profile, accountReady: true }];

    if (isCheckout) {
      const expanded = expandProfilesForCheckout(form.profile);
      const profileNames =
        expanded.length > 0
          ? expanded.map((p) => p.name || p.id)
          : [form.profile];

      const settings = loadSettings();
      const list: any[] = accountsForStore(settings, form.store);

      let emails: string[] = [];
      if (form.accountEmail === 'all') {
        emails = list.map((a) => String(a.email || '').trim()).filter(Boolean);
      } else if (form.accountEmail) {
        emails = [form.accountEmail];
      }

      profileSlots = [];
      for (const profileName of profileNames) {
        if (!emails.length) {
          profileSlots.push({
            profileName,
            accountReady: false,
            accountReason: 'Pick an account on the task',
          });
          continue;
        }
        for (const email of emails) {
          const hit = list.find(
            (a) => String(a.email || '').trim().toLowerCase() === email.toLowerCase()
          );
          const pass = String(hit?.pass || hit?.password || '').trim();
          profileSlots.push({
            profileName,
            accountEmail: email,
            accountReady: !!pass,
            accountReason: pass ? undefined : `No password for ${email}`,
          });
        }
      }

      const missing = profileSlots.filter((s) => !s.accountReady);
      if (missing.length > 0) {
        const lines = missing
          .map((s) => `• ${s.profileName}: ${s.accountReason || 'missing account'}`)
          .join('\n');
        const go = confirm(
          `${missing.length} slot(s) missing account password:\n\n${lines}\n\n` +
            `OK = create anyway\nCancel = fix Settings → Accounts`
        );
        if (!go) return;
      }
    }

    const qty = Math.max(1, form.qty || 1);
    const newTasks: Task[] = [];
    for (const slot of profileSlots) {
      for (let i = 0; i < qty; i++) {
        newTasks.push({
          id: Math.random().toString(36).substr(2, 9),
          store: form.store,
          product: productValue,
          profile: slot.profileName,
          accountEmail: slot.accountEmail,
          proxy,
          quantity: '1',
          status: 'idle' as TaskStatus,
          // Surface missing account in the row until user fixes Settings
          statusMessage: slot.accountReady
            ? undefined
            : slot.accountReason || 'Missing account',
          mode: form.mode,
          delay,
          monitoringDelay,
          resetDelay,
          monitorHighStock: !!form.monitorHighStock,
          stockAlertCooldownMs:
            form.stockAlertCooldownMs === '' || form.stockAlertCooldownMs == null
              ? 180000
              : Math.max(0, Number(form.stockAlertCooldownMs) || 0),
          moduleUnlockDelay,
          region: form.region,
          sku: form.store === 'Target' ? productValue : form.sku,
          offerId: form.offerId,
          priority,
          liveCheckout: !!form.liveCheckout,
          placeOrder: !!form.liveCheckout,
          solve3ds: form.liveCheckout ? true : !!form.solve3ds,
          proxyBind: form.proxyBind === 'split' ? 'split' : 'same',
          loginProxy: form.proxyBind === 'split' ? form.loginProxy || proxy : proxy,
          harvestProxy: form.proxyBind === 'split' ? form.harvestProxy || proxy : proxy,
        });
      }
    }

    setTasks((prev) => [...prev, ...newTasks]);
    registerTasks(newTasks.map(taskToEngineConfig));
    console.log(
      `[tasks] created ${newTasks.length} task(s)`,
      profileSlots.map(
        (s) =>
          `${s.profileName}${s.accountReady ? ` → ${s.accountEmail}` : ` ⚠ ${s.accountReason}`}`
      )
    );
    closeCreateModal();
  };


  const clearSelection = () => {
    setSelectedIds(new Set());
    setLastClickedId(null);
  };

  const toggleSelectOne = (id: string, shiftKey: boolean, metaKey: boolean) => {
    const ids = filteredTasks.map((x) => x.id);
    const idx = ids.indexOf(id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastClickedId) {
        const a = ids.indexOf(lastClickedId);
        const b = idx;
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
          return next;
        }
      }
      if (metaKey || (!shiftKey && !metaKey)) {
        // plain click on checkbox area toggles; ctrl/cmd toggles without clearing
        if (metaKey) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        } else {
          // checkbox handler uses explicit toggle
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
      }
      return next;
    });
    setLastClickedId(id);
  };

  const selectAllFiltered = () => {
    setSelectedIds(new Set(filteredTasks.map((x) => x.id)));
  };

  const handleRowClick = (task: Task, e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,a')) return;
    if (e.shiftKey) {
      e.preventDefault();
      const ids = filteredTasks.map((x) => x.id);
      const idx = ids.indexOf(task.id);
      setSelectedIds((prev) => {
        const next = new Set(e.ctrlKey || e.metaKey ? prev : prev);
        const anchor = lastClickedId && ids.includes(lastClickedId) ? lastClickedId : ids[0];
        const a = ids.indexOf(anchor);
        const b = idx;
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          // if not ctrl, start fresh range from anchor
          const base = e.ctrlKey || e.metaKey ? next : new Set<string>();
          for (let i = lo; i <= hi; i++) base.add(ids[i]);
          return base;
        }
        next.add(task.id);
        return next;
      });
      setLastClickedId(task.id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(task.id)) next.delete(task.id);
        else next.add(task.id);
        return next;
      });
      setLastClickedId(task.id);
      return;
    }
    // normal: select for logs panel
    setSelectedTaskId(task.id === selectedTaskId ? null : task.id);
    setLastClickedId(task.id);
  };

  const handleMassStart = () => {
    selectedIds.forEach((id) => handleStartTask(id));
  };
  const handleMassStop = () => {
    selectedIds.forEach((id) => handleStopTask(id));
  };
  const handleMassDelete = () => {
    if (!selectedIds.size) return;
    if (!confirm(`Delete ${selectedIds.size} selected task(s)?`)) return;
    selectedIds.forEach((id) => {
      engineDelete(id);
    });
    setTasks((prev) => prev.filter((t) => !selectedIds.has(t.id)));
    if (selectedTaskId && selectedIds.has(selectedTaskId)) setSelectedTaskId(null);
    clearSelection();
  };

  const applyMassEdit = () => {
    if (!selectedIds.size) return;
    const running = tasks.filter(
      (t) =>
        selectedIds.has(t.id) &&
        (t.status === 'running' || t.status === 'carting' || t.status === 'checkout' || t.status === 'queued')
    );
    if (running.length) {
      alert(`Stop ${running.length} running task(s) before mass edit.`);
      return;
    }
    const patch: Partial<Task> = {};
    if (massEdit.proxy.trim()) patch.proxy = massEdit.proxy.trim();
    if (massEdit.profile.trim()) patch.profile = massEdit.profile.trim();
    if (massEdit.delay.trim() && !Number.isNaN(Number(massEdit.delay))) {
      (patch as any).delay = Number(massEdit.delay);
    }
    if (massEdit.priority.trim()) (patch as any).priority = massEdit.priority.trim();
    if (massEdit.mode.trim()) (patch as any).mode = massEdit.mode.trim();
    if (!Object.keys(patch).length) {
      alert('Fill at least one field to apply.');
      return;
    }
    const updatedList: Task[] = [];
    setTasks((prev) =>
      prev.map((t) => {
        if (!selectedIds.has(t.id)) return t;
        const u = { ...t, ...patch, status: 'idle' as TaskStatus };
        updatedList.push(u);
        return u;
      })
    );
    // register after state - use computed list
    const toReg = tasks
      .filter((t) => selectedIds.has(t.id))
      .map((t) => ({ ...t, ...patch, status: 'idle' as TaskStatus }));
    // Mass edit → refresh engine endpoints for every selected task
    registerTasks(toReg.map(taskToEngineConfig));
    console.log('[tasks] mass edit engine sync', toReg.map((t) => t.id));
    setShowMassEdit(false);
    setMassEdit({ proxy: '', profile: '', delay: '', priority: '', mode: '' });
  };


  const handleStartAll = () => {
    const store = activeModule === 'All' ? undefined : activeModule;
    startAll(store);
  };

  const handleStopAll = () => {
    const store = activeModule === 'All' ? undefined : activeModule;
    stopAll(store);
  };

  const handleDeleteAll = () => {
    tasks.forEach((t) => engineDelete(t.id));
    setTasks([]);
  };

  const handleStartTask = (id: string) => startTask(id);
  const handleStopTask = (id: string) => stopTask(id);

  const handleDeleteTask = (id: string) => {
    engineDelete(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (selectedTaskId === id) setSelectedTaskId(null);
  };

  const duplicateTask = (task: Task) => {
    const copy: Task = {
      ...task,
      id: Math.random().toString(36).substr(2, 9),
      status: 'idle',
    };
    setTasks((prev) => [...prev, copy]);
    registerTasks([taskToEngineConfig(copy)]);
  };

  // Logs de la task seleccionada, o últimos globales si no hay selección
  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null),
    [tasks, selectedTaskId]
  );
  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };


  // Cookie bank status (Stellar-style counter)
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const base = import.meta.env.VITE_API_URL || '/jokerz-api';
        const url = base ? `${base}/api/harvest/bank` : '/api/harvest/bank';
        const r = await fetch(url);
        if (!r.ok) return;
        const d = await r.json();
        if (dead) return;
        setCookieBank({
          count: d.count ?? 0,
          targetSize: d.targetSize ?? 0,
          ttlMinutes: d.ttlMinutes ?? 0,
          harvesting: !!d.harvesting,
          byModule: d.byModule || {},
        });
      } catch {
        if (!dead) setCookieBank(null);
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="p-4 h-full flex flex-col gap-3 animate-in fade-in duration-200 relative">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black italic uppercase tracking-tighter text-white">Tasks</h1>
          <p className="text-[#555] text-[10px] mt-1 uppercase font-bold tracking-widest">
            {tasks.length} Tasks · Queue {queueInfo.running}/{queueInfo.maxConcurrent} running
            {queueInfo.queued > 0 ? ` · ${queueInfo.queued} waiting` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Cookie bank — Stellar-style */}
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-sm border text-[10px] font-black uppercase tracking-widest ${
              cookieBank && cookieBank.count > 0
                ? 'border-green-500/40 bg-green-500/10 text-[#00FF41]'
                : cookieBank?.harvesting
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                  : 'border-[#1A1A1A] bg-[#0F0F0F] text-[#555]'
            }`}
            title={
              cookieBank
                ? `Cookie bank ${cookieBank.count}/${cookieBank.targetSize} · TTL ${cookieBank.ttlMinutes}m`
                : 'Cookie bank offline — start server + harvest'
            }
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                cookieBank?.harvesting
                  ? 'bg-amber-400 animate-pulse'
                  : cookieBank && cookieBank.count > 0
                    ? 'bg-[#00FF41]'
                    : 'bg-gray-600'
              }`}
            />
            <span>
              Cookies{' '}
              {cookieBank
                ? `${cookieBank.count}/${cookieBank.targetSize || '—'}`
                : '—/—'}
            </span>
            {cookieBank?.harvesting && <span className="text-amber-400/80">Harvest</span>}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555]" size={16} />
            <input
              type="text"
              placeholder="SEARCH TASKS..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-sm pl-9 pr-4 py-2 text-sm text-white font-bold placeholder:text-[#555] focus:outline-none focus:border-[#7B2CBF] transition-all w-64 uppercase"
            />
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-[#7B2CBF] hover:bg-[#9D4EDD] text-white px-4 py-2 rounded-sm text-xs font-black uppercase tracking-wider transition-colors"
          >
            <Plus size={14} /> Create
          </button>
        </div>
      </div>

      
      {/* Multi-select toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-[#0F0F0F] border border-purple-800/60 rounded-sm px-3 py-2 mb-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#a78bfa]">
            {selectedIds.size} selected
          </span>
          <button
            type="button"
            onClick={selectAllFiltered}
            className="text-[10px] font-bold uppercase tracking-widest text-[#888] hover:text-white px-2 py-1"
          >
            Select all ({filteredTasks.length})
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="text-[10px] font-bold uppercase tracking-widest text-[#555] hover:text-white px-2 py-1"
          >
            Clear
          </button>
          <div className="w-px h-4 bg-purple-900/80" />
          <button
            type="button"
            onClick={handleMassStart}
            className="text-[10px] font-bold uppercase tracking-widest text-[#00FF41] hover:bg-green-500/10 px-2 py-1 rounded-sm"
          >
            Start
          </button>
          <button
            type="button"
            onClick={handleMassStop}
            className="text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B] hover:bg-[#FF4B2B]/10 px-2 py-1 rounded-sm"
          >
            Stop
          </button>
          <button
            type="button"
            onClick={() => setShowMassEdit(true)}
            className="text-[10px] font-bold uppercase tracking-widest text-[#a78bfa] hover:bg-purple-500/10 px-2 py-1 rounded-sm"
          >
            Mass Edit
          </button>
          <button
            type="button"
            onClick={handleMassDelete}
            className="text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B] hover:bg-[#FF4B2B]/10 px-2 py-1 rounded-sm"
          >
            Delete
          </button>
          <span className="text-[9px] text-[#555] font-bold uppercase tracking-wider ml-auto hidden sm:inline">
            Shift+click range · Ctrl/Cmd+click toggle
          </span>
        </div>
      )}

      {/* Module tabs */}
      <div className="flex items-center gap-2 border-b border-[#1A1A1A] pb-2 overflow-x-auto">
        {MODULES.map((mod) => (
          <button
            key={mod}
            onClick={() => setActiveModule(mod)}
            className={`px-4 py-2 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors whitespace-nowrap ${
              activeModule === mod
                ? 'bg-[#7B2CBF] text-white'
                : 'bg-[#0F0F0F] text-[#555] hover:text-white border border-[#1A1A1A] hover:border-[#7B2CBF]'
            }`}
          >
            {mod}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 text-[11px] font-black tabular-nums">
          <span className="text-[#888]" title="Tasks">
            {storeStats.total}
          </span>
          <span className="text-[#7B2CBF]" title="Running">
            {storeStats.running}
          </span>
          <span className="flex items-center gap-1 text-amber-300" title="In cart (ATC ok, not paid)">
            <ShoppingCart size={12} /> {storeStats.carted}
          </span>
          <span className="flex items-center gap-1 text-[#00FF41]" title="Ordered">
            <Check size={12} /> {storeStats.success}
          </span>
          <span className="text-[#FF4B2B]" title="OOS / failed">
            {storeStats.oos + storeStats.failed}
          </span>
        </div>
      </div>

      
      {showCollapse && collapseReport && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowCollapse(false)}>
          <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-lg p-6 shadow-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white uppercase tracking-wider">Collapse Analysis</h2>
              <button onClick={() => setShowCollapse(false)} className="text-[#555] hover:text-white text-sm font-bold">✕</button>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#555] mb-4">
              {collapseReport.analyzed} logs · {Math.round(collapseReport.windowMs / 1000)}s · peak {collapseReport.startsPerSecondPeak}/s · errors {Math.round(collapseReport.errorRate * 100)}%
            </p>
            <div className={`mb-4 px-3 py-2 rounded-sm text-[10px] font-bold uppercase tracking-widest border ${
              collapseReport.severity === 'critical'
                ? 'border-red-500/40 text-[#FF4B2B] bg-[#FF4B2B]/10'
                : collapseReport.severity === 'warn'
                  ? 'border-orange-500/40 text-orange-400 bg-orange-500/10'
                  : 'border-[#00FF41]/40 text-[#00FF41] bg-[#00FF41]/10'
            }`}>
              Severity: {collapseReport.severity}
            </div>
            <div className="space-y-3 mb-4">
              {collapseReport.findings.map((f, i) => (
                <div key={i} className="bg-[#0e0915] border border-[#1A1A1A] p-3 rounded-sm">
                  <p className={`text-xs font-bold uppercase tracking-widest mb-1 ${
                    f.severity === 'critical' ? 'text-[#FF4B2B]' : f.severity === 'warn' ? 'text-orange-400' : 'text-[#00FF41]'
                  }`}>{f.title}</p>
                  <p className="text-[11px] text-[#888] leading-relaxed">{f.detail}</p>
                </div>
              ))}
            </div>
            {collapseReport.recommendations.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-[#7B2CBF] mb-2">Recommendations</p>
                <ul className="space-y-1.5">
                  {collapseReport.recommendations.map((r, i) => (
                    <li key={i} className="text-[11px] text-[#E0E0E0]">· {r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Modal */}
      
      {showMassEdit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-white mb-1">Mass Edit</h2>
            <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest mb-5">
              {selectedIds.size} task(s) · empty fields are left unchanged
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase font-bold text-[#555] mb-1 block">Proxy group</label>
                <select
                  className="w-full bg-[#0e0915] border border-[#1A1A1A] rounded-sm px-3 py-2 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                  value={massEdit.proxy}
                  onChange={(e) => setMassEdit((m) => ({ ...m, proxy: e.target.value }))}
                >
                  <option value="">— no change —</option>
                  {loadProxies([]).map((g) => (
                    <option key={g.id || g.name} value={g.name}>
                      {g.name} ({g.proxies?.length || 0})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-[#555] mb-1 block">Profile</label>
                <select
                  className="w-full bg-[#0e0915] border border-[#1A1A1A] rounded-sm px-3 py-2 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                  value={massEdit.profile}
                  onChange={(e) => setMassEdit((m) => ({ ...m, profile: e.target.value }))}
                >
                  <option value="">— no change —</option>
                  {(() => {
                    const list = loadProfiles([]);
                    const map = new Map<string, typeof list>();
                    for (const p of list) {
                      const g = String(p.group || 'Personal').trim() || 'Personal';
                      if (!map.has(g)) map.set(g, []);
                      map.get(g)!.push(p);
                    }
                    return Array.from(map.entries())
                      .sort((a, b) => a[0].localeCompare(b[0]))
                      .map(([g, ps]) => (
                        <optgroup key={g} label={`${g} (${ps.length})`}>
                          <option value={`group:${g}`}>★ Entire group · {g}</option>
                          {ps.map((p) => (
                            <option key={p.id || p.name} value={p.name || p.id}>
                              {p.name || p.id}
                            </option>
                          ))}
                        </optgroup>
                      ));
                  })()}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-[#555] mb-1 block">Delay (ms)</label>
                <input
                  type="number"
                  className="w-full bg-[#0e0915] border border-[#1A1A1A] rounded-sm px-3 py-2 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                  placeholder="e.g. 5000"
                  value={massEdit.delay}
                  onChange={(e) => setMassEdit((m) => ({ ...m, delay: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-[#555] mb-1 block">Priority</label>
                <select
                  className="w-full bg-[#0e0915] border border-[#1A1A1A] rounded-sm px-3 py-2 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                  value={massEdit.priority}
                  onChange={(e) => setMassEdit((m) => ({ ...m, priority: e.target.value }))}
                >
                  <option value="">— no change —</option>
                  <option value="low">low</option>
                  <option value="normal">normal</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-[#555] mb-1 block">Mode</label>
                <select
                  className="w-full bg-[#0e0915] border border-[#1A1A1A] rounded-sm px-3 py-2 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                  value={massEdit.mode}
                  onChange={(e) => setMassEdit((m) => ({ ...m, mode: e.target.value }))}
                >
                  <option value="">— no change —</option>
                  <option value="monitor">monitor</option>
                  <option value="checkout">checkout</option>
                  <option value="shipping">shipping</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => setShowMassEdit(false)}
                className="px-4 py-2 text-sm text-[#888] border border-gray-700 rounded-lg hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyMassEdit}
                className="px-4 py-2 text-sm font-bold text-white bg-[#4c1d95] hover:bg-[#5b21b6] rounded-lg"
              >
                Apply to {selectedIds.size}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          form={form}
          onChange={updateForm}
          editingTaskId={editingTaskId}
          onClose={closeCreateModal}
          onSave={handleCreateTasks}
        />
      )}

      {/* Bulk actions */}
      <div className="flex items-center gap-2 p-1.5 bg-[#0F0F0F] border-l-2 border-[#00FF41] w-fit">
        <button
          onClick={handleStartAll}
          className="flex items-center gap-2 hover:bg-[#7B2CBF]/20 text-[#888] hover:text-white px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors"
        >
          <Play size={14} className="text-[#00FF41]" /> Start All
        </button>
        <button
          onClick={handleStopAll}
          className="flex items-center gap-2 hover:bg-[#7B2CBF]/20 text-[#888] hover:text-white px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors"
        >
          <Square size={14} className="text-[#FF4B2B]" /> Stop All
        </button>
        <div className="w-px h-4 bg-purple-900/50 mx-1" />
        <button
          onClick={handleDeleteAll}
          className="flex items-center gap-2 hover:bg-[#7B2CBF]/20 text-[#888] hover:text-white px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors"
        >
          <Trash2 size={14} /> Delete All
        </button>
        <div className="w-px h-4 bg-purple-900/50 mx-1" />
        <button
          onClick={() => {
            const report = analyzeCollapseLogs(logs, { windowMs: 120000 });
            setCollapseReport(report);
            setShowCollapse(true);
            console.log(formatCollapseReport(report));
          }}
          className="flex items-center gap-2 hover:bg-[#7B2CBF]/20 text-orange-400 hover:text-white px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors"
        >
          Analyze Collapse
        </button>
      </div>

      {/* Tasks table + mini log */}
      <div className="flex-1 flex gap-4 min-h-0">
        <div className="flex-1 bg-[#0F0F0F] border-t border-[#1A1A1A] overflow-hidden flex flex-col">
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left border-collapse jokerz-table">
              <thead>
                <tr className="border-b border-[#1A1A1A] bg-black/20">
                  <th className="w-10">
                    <input
                      type="checkbox"
                      className="accent-[#7B2CBF] cursor-pointer"
                      checked={
                        filteredTasks.length > 0 &&
                        filteredTasks.every((x) => selectedIds.has(x.id))
                      }
                      onChange={(e) => {
                        if (e.target.checked) selectAllFiltered();
                        else clearSelection();
                      }}
                      title="Select all filtered"
                    />
                  </th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest w-16">ID</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest">Store</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest w-1/3">Product</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest">Profile</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest">Account</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest">Proxy</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest">Qty</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest w-32">Status</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest w-20">Pri</th>
                  <th className="text-[10px] font-bold text-[#555] uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-purple-900/50">
                {filteredTasks.map((task) => (
                  <tr
                    key={task.id}
                    onClick={(e) => handleRowClick(task, e)}
                    className={`transition-colors group cursor-pointer ${
                      selectedIds.has(task.id)
                        ? 'bg-[#7B2CBF]/25 border-l-2 border-l-[#a78bfa]'
                        : selectedTaskId === task.id
                          ? 'bg-[#7B2CBF]/15 border-l-2 border-l-[#00FF41]'
                          : 'hover:bg-[#7B2CBF]/10'
                    }`}
                  >
                    <td className="w-10" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="accent-[#7B2CBF] cursor-pointer"
                        checked={selectedIds.has(task.id)}
                        onChange={(e) => {
                          const shift = (e.nativeEvent as MouseEvent).shiftKey;
                          if (shift && lastClickedId) {
                            const ids = filteredTasks.map((x) => x.id);
                            const a = ids.indexOf(lastClickedId);
                            const b = ids.indexOf(task.id);
                            if (a >= 0 && b >= 0) {
                              const [lo, hi] = a < b ? [a, b] : [b, a];
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                for (let i = lo; i <= hi; i++) next.add(ids[i]);
                                return next;
                              });
                              setLastClickedId(task.id);
                              return;
                            }
                          }
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(task.id)) next.delete(task.id);
                            else next.add(task.id);
                            return next;
                          });
                          setLastClickedId(task.id);
                        }}
                      />
                    </td>
                    <td className="text-sm font-mono text-[#555]">{task.id.slice(0, 6)}</td>
                    <td className="text-sm text-white font-bold uppercase">{task.store}</td>
                    <td className="text-sm text-[#E0E0E0] truncate max-w-[220px]">
                      <div className="font-mono text-[12px] text-white/90">{task.product}</div>
                      <div className="text-[9px] text-[#555] font-bold uppercase tracking-widest mt-0.5">
                        {(task.mode || 'checkout').replace(/_/g, ' ')}
                        {((task as any).liveCheckout || (task as any).placeOrder) ? (
                          <span className="text-red-400"> · LIVE</span>
                        ) : (task.mode || '') !== 'monitor' ? (
                          <span className="text-[#555]"> · dry-run</span>
                        ) : null}
                        {task.lastCheckAt
                          ? ` · ${new Date(task.lastCheckAt).toLocaleTimeString()}`
                          : ''}
                      </div>
                    </td>
                    <td className="text-sm text-[#888]">{task.profile}</td>
                    <td className="text-xs font-mono text-[#9D4EDD] truncate max-w-[160px]" title={(task as any).accountEmail || ''}>
                      {(task as any).accountEmail || (task.mode === 'monitor' ? '—' : 'no account')}
                    </td>
                    <td className="text-sm font-mono text-[#888]">{task.proxy}</td>
                    <td className="text-sm text-[#888]">{task.quantity}</td>
                    <td>
                      <StatusBadge
                        status={task.status}
                        message={(task as any).statusMessage}
                        mode={task.mode}
                      />
                    </td>
                    <td>
                      <span className={`text-[9px] font-bold uppercase tracking-widest ${
                        (task.priority === 'critical' || (!task.priority && task.mode === 'monitor'))
                          ? 'text-[#FF4B2B]'
                          : task.priority === 'high' || (!task.priority && (task.mode || '').includes('monitor'))
                            ? 'text-orange-400'
                            : task.priority === 'low'
                              ? 'text-[#555]'
                              : 'text-[#888]'
                      }`}>
                        {task.priority || (task.mode === 'monitor' ? 'high' : 'normal')}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          onClick={() => handleStartTask(task.id)}
                          className="p-1.5 text-[#888] hover:text-[#00FF41] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                          title="Start"
                        >
                          <Play size={14} />
                        </button>
                        <button
                          onClick={() => handleStopTask(task.id)}
                          className="p-1.5 text-[#888] hover:text-[#FF4B2B] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                          title="Stop"
                        >
                          <Square size={14} />
                        </button>
                        <button
                          onClick={() => setLogScreenTaskId(task.id)}
                          className="p-1.5 text-[#888] hover:text-[#00FF41] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                          title="Logs"
                        >
                          <ScrollText size={14} />
                        </button>
                        <button
                          onClick={() => openEditTask(task)}
                          className="p-1.5 text-[#888] hover:text-[#a78bfa] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                          title="Edit"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => duplicateTask(task)}
                          className="p-1.5 text-[#888] hover:text-[#7B2CBF] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                          title="Duplicate"
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          onClick={() => handleDeleteTask(task.id)}
                          className="p-1.5 text-[#888] hover:text-[#FF4B2B] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredTasks.length === 0 && (
                  <tr>
                    <td
                      colSpan={10}
                      className="p-8 text-center text-[#555] text-[10px] font-bold uppercase tracking-widest"
                    >
                      No tasks found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Task logs modal — same style as Edit Task */}
      {logScreenTaskId && (
        <div
          className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLogScreenTaskId(null)}
        >
          <div
            className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-3xl shadow-2xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1A1A1A] shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <ScrollText size={18} className="text-[#00FF41] shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-white font-bold text-base truncate">
                    Task Logs
                  </h2>
                  <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest truncate mt-0.5">
                    {tasks.find((t) => t.id === logScreenTaskId)?.product || 'Task'} ·{' '}
                    {logScreenTaskId.slice(0, 8)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLogScreenTaskId(null)}
                className="p-2 rounded-lg text-[#888] hover:text-white hover:bg-[#1a1a1a] transition-colors"
                title="Close"
              >
                <X size={18} />
              </button>
            </div>

            <InfiniteLogList
              key={logScreenTaskId}
              entries={(() => {
                const id = String(logScreenTaskId);
                // Memory first (live), then disk — only this taskId
                const fromMem = logs.filter((l) => l.taskId === id);
                if (fromMem.length) return fromMem;
                return getLogsForTask(id, 200);
              })()}
              formatTime={formatTime}
              emptyText="No logs for this task yet — start it"
              className="flex-1 overflow-y-auto px-6 py-4 font-mono text-[12px] space-y-2 min-h-[280px]"
            />

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-[#1A1A1A] shrink-0">
              <button
                type="button"
                onClick={() => setLogScreenTaskId(null)}
                className="px-5 py-2 rounded-lg border border-gray-700 text-[#888] text-xs font-bold uppercase tracking-widest hover:text-white hover:border-gray-500"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
