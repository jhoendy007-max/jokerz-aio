import { useState, useEffect } from 'react';
import { Play, Square, Plus, Trash2, Copy, Search, X, Sparkles } from 'lucide-react';
import { loadAccGenTasks, saveAccGenTasks, AccGenTask, loadSettings, saveSettings, loadProxies, ProxyGroup } from '../lib/storage';

const StatusBadge = ({ status }: { status: AccGenTask['status'] }) => {
  const styles: Record<string, string> = {
    idle: 'bg-gray-800 text-[#888] border-gray-700',
    running: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    generating: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    success: 'bg-green-500/10 text-green-400 border-green-500/20',
    failed: 'bg-[#FF4B2B]/10 text-[#FF4B2B] border-red-500/20',
  };

  return (
    <span
      className={`px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-widest border ${styles[status] || styles.idle} inline-flex items-center gap-1.5`}
    >
      {(status === 'running' || status === 'generating') && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
      )}
      {status}
    </span>
  );
};

const MODULES = ['All', 'Walmart', 'Target', 'Bandai Collectables', 'Icloud'] as const;

function isResiGroup(g: ProxyGroup) {
  const t = `${g.type || ''} ${g.name || ''}`.toLowerCase();
  if (/\bisp\b|datacenter|\bdc\b|localhost|local\b/.test(t) && !/resi|residential|mobile/.test(t)) return false;
  return /resi|residential|mobile/.test(t);
}

function pickResiLine(g: ProxyGroup | undefined) {
  const lines = (g?.proxies || []).map((p) => String(p).trim()).filter(Boolean);
  if (!lines.length) return '';
  return lines[Math.floor(Math.random() * lines.length)];
}

const defaultTasks: AccGenTask[] = [];

export default function AccountGenView() {
  const [tasks, setTasks] = useState<AccGenTask[]>(() => loadAccGenTasks(defaultTasks));
  const [activeModule, setActiveModule] = useState('All');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  // Form state
  const resiGroups = loadProxies([]).filter(isResiGroup);
  const [store, setStore] = useState('Target');
  const [proxy, setProxy] = useState(resiGroups[0]?.name || '');
  const [amount, setAmount] = useState(1);
  const [smsMode, setSmsMode] = useState<'manual' | 'api'>('manual');
  const [catchall, setCatchall] = useState('@catchall.com');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('Alex');
  const [lastName, setLastName] = useState('Rivera');
  // iCloud specific
  const [icloudEmail, setIcloudEmail] = useState('');
  const [icloudProfileGroup, setIcloudProfileGroup] = useState('');
  const [icloudProxyGroup, setIcloudProxyGroup] = useState('gen');
  const [icloudImportExisting, setIcloudImportExisting] = useState(true);
  const [icloudAutoStart, setIcloudAutoStart] = useState(false);

  const apiUrl = (path: string) => {
    const b = (import.meta.env.VITE_API_URL || '/jokerz-api').replace(/\/$/, '');
    return b ? `${b}${path}` : path;
  };

  const storeToModule = (s: string) => {
    const x = s.toLowerCase();
    if (x.includes('walmart')) return 'walmart';
    if (x.includes('bandai')) return 'bandai';
    return 'target';
  };

  const genPassword = () => {
    const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#';
    let p = '';
    for (let i = 0; i < 14; i++) p += chars[Math.floor(Math.random() * chars.length)];
    return p + 'aA1!';
  };

  const runGen = async (task: AccGenTask) => {
    const groups = loadProxies([]).filter(isResiGroup);
    const g =
      groups.find((x) => x.name === task.proxy || x.id === task.proxy) ||
      groups.find((x) => (x.proxies || []).includes(task.proxy));
    if (!g) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? { ...t, status: 'failed', message: 'Acc gen is RESI only — pick a Residential group in Proxies' }
            : t
        )
      );
      return;
    }
    const line = pickResiLine(g);
    if (!line) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id ? { ...t, status: 'failed', message: `Group ${g.name} has no proxies` } : t
        )
      );
      return;
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id ? { ...t, status: 'generating', message: `RESI ${g.name}…` } : t
      )
    );
    try {
      const pw = task.password || password || genPassword();
      const s = loadSettings() as any;
      const domain = String(catchall || s.catchallDomain || '').replace(/^@/, '');
      const res = await fetch(apiUrl('/api/account-gen'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: task.email,
          password: pw,
          firstName: task.firstName || firstName,
          lastName: task.lastName || lastName,
          proxy: line,
          proxyKind: 'residential',
          proxyGroup: g.name,
          proxyGroupType: g.type,
          module: storeToModule(task.store),
          smsMode,
          waitVerifySec: 90,
          imap: {
            user: s.imapUser,
            pass: s.imapPass,
            host: s.imapHost,
          },
          smspoolKey: s.smspoolKey,
          smsActivateKey: s.smsActivateKey || s.textverifyKey,
          smsProvider: s.smspoolKey ? 'smspool' : 'sms-activate',
          capmonsterKey: s.capmonsterKey,
          twocaptchaKey: s.twocaptchaKey,
          captchaProvider: s.captchaProvider || 'auto',
          catchall: domain,
        }),
      });
      const data = await res.json();
      const created = data.stage === 'created';
      if (created && data.email) {
        const cur = loadSettings();
        const list = [...((cur.accounts as any)?.Target || [])];
        if (!list.some((a: any) => a.email === data.email)) {
          list.push({ email: data.email, pass: data.password || pw, proxy: line });
          saveSettings({ ...cur, accounts: { ...cur.accounts, Target: list } });
        }
      }
      const ok =
        created || data.stage === 'needs_verification' || data.stage === 'needs_sms' || data.stage === 'form_filled';
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                password: data.password || pw,
                status: created ? 'success' : data.stage === 'blocked' || data.stage === 'error' ? 'failed' : ok ? 'success' : 'failed',
                message: data.message || data.stage,
              }
            : t
        )
      );
    } catch (e: any) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? {
                ...t,
                status: 'failed',
                message: e?.message || 'Server offline — npm run server',
              }
            : t
        )
      );
    }
  };

  useEffect(() => {
    saveAccGenTasks(tasks);
  }, [tasks]);

  const filteredTasks = tasks.filter(
    (t) =>
      (activeModule === 'All' || t.store === activeModule) &&
      t.email.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = () => {
    if (store === 'Icloud') {
      if (!icloudEmail.trim()) return;
      const newTask: AccGenTask = {
        id: Math.random().toString(36).substr(2, 9),
        store: 'Icloud',
        email: icloudEmail.trim(),
        proxy: icloudProxyGroup || 'gen',
        status: 'idle',
      };
      setTasks((prev) => [...prev, newTask]);
    } else {
      if (!isResiGroup(loadProxies([]).find((g) => g.name === proxy || g.id === proxy) || { id: '', name: proxy, type: '', status: '', count: 0 })) {
        return;
      }
      const pwBase = password || genPassword();
      const newTasks: AccGenTask[] = Array.from({ length: Math.max(1, amount) }).map((_, i) => ({
        id: Math.random().toString(36).substr(2, 9),
        store,
        email: `gen${Math.floor(Math.random() * 100000)}${catchall.startsWith('@') ? catchall : '@' + catchall}`,
        proxy,
        password: amount > 1 ? genPassword() : pwBase,
        firstName,
        lastName,
        status: 'idle' as const,
      }));
      setTasks((prev) => [...prev, ...newTasks]);
    }
    setShowCreate(false);
    setAmount(1);
    setIcloudEmail('');
  };

  const startAll = async () => {
    const list = filteredTasks.filter((t) => t.store !== 'Icloud').slice(0, 5);
    for (const t of list) {
      await runGen(t);
      await new Promise((r) => setTimeout(r, 8000));
    }
  };
  const stopAll = () => setTasks((prev) => prev.map((t) => ({ ...t, status: 'idle' })));
  const deleteAll = () => setTasks([]);

  const startTask = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (t) void runGen(t);
  };
  const stopTask = (id: string) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'idle' } : t)));
  const deleteTask = (id: string) => setTasks((prev) => prev.filter((t) => t.id !== id));
  const duplicateTask = (task: AccGenTask) => {
    setTasks((prev) => [
      ...prev,
      { ...task, id: Math.random().toString(36).substr(2, 9), status: 'idle' },
    ]);
  };

  return (
    <div className="p-4 h-full flex flex-col gap-3 animate-in fade-in duration-200 relative">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black italic uppercase tracking-tighter text-white">
            Account Gen
          </h1>
          <p className="text-[#555] text-[10px] mt-1 uppercase font-bold tracking-widest">
            {filteredTasks.length} {activeModule === 'All' ? 'Total' : activeModule} Tasks
          </p>
        </div>
        <div className="flex items-center gap-3">
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

      {/* Module tabs */}
      <div className="flex items-center gap-2 border-b border-[#1A1A1A] pb-4 overflow-x-auto">
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
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-lg p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-purple-900/30 border border-purple-500/30 flex items-center justify-center text-[#7B2CBF]">
                  <Sparkles size={20} />
                </div>
                <div>
                  <h2 className="text-white text-lg font-bold">Create Account Gen Tasks</h2>
                  <p className="text-[#555] text-xs">Generate accounts for the selected store</p>
                </div>
              </div>
              <button onClick={() => setShowCreate(false)} className="text-[#555] hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">Store*</label>
                <select
                  value={store}
                  onChange={(e) => setStore(e.target.value)}
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] appearance-none"
                >
                  {MODULES.filter((m) => m !== 'All').map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {store === 'Target' && (
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">SMS</label>
                  <select
                    value={smsMode}
                    onChange={(e) => setSmsMode(e.target.value as 'manual' | 'api')}
                    className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] appearance-none"
                  >
                    <option value="manual">B — IMAP email, SMS manual (Chrome stays open)</option>
                    <option value="api">C — SMSPool / SMS-Activate (Settings keys)</option>
                  </select>
                </div>
              )}

              {store === 'Icloud' ? (
                <>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">iCloud Email*</label>
                    <input
                      type="email"
                      value={icloudEmail}
                      onChange={(e) => setIcloudEmail(e.target.value)}
                      placeholder="user@icloud.com"
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">Profile Group</label>
                    <input
                      type="text"
                      value={icloudProfileGroup}
                      onChange={(e) => setIcloudProfileGroup(e.target.value)}
                      placeholder="TARGET JHOENDY"
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">Proxy Group</label>
                    <input
                      type="text"
                      value={icloudProxyGroup}
                      onChange={(e) => setIcloudProxyGroup(e.target.value)}
                      placeholder="gen"
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                    />
                  </div>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-sm text-[#888] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={icloudImportExisting}
                        onChange={(e) => setIcloudImportExisting(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-700 bg-[#0F0F0F]"
                      />
                      Import Existing
                    </label>
                    <label className="flex items-center gap-2 text-sm text-[#888] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={icloudAutoStart}
                        onChange={(e) => setIcloudAutoStart(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-700 bg-[#0F0F0F]"
                      />
                      Auto Start
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">
                      Password (blank = random)
                    </label>
                    <input
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="auto-generate if empty"
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm font-medium text-[#888] mb-2 block">First name</label>
                      <input
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-[#888] mb-2 block">Last name</label>
                      <input
                        type="text"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">Catchall Domain</label>
                    <input
                      type="text"
                      value={catchall}
                      onChange={(e) => setCatchall(e.target.value)}
                      placeholder="@catchall.com"
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">Residential proxy group*</label>
                    <select
                      value={proxy}
                      onChange={(e) => setProxy(e.target.value)}
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] appearance-none"
                    >
                      <option value="">— Residential groups only —</option>
                      {loadProxies([]).filter(isResiGroup).map((g) => (
                        <option key={g.id} value={g.name}>
                          {g.name} · {g.proxies?.length || 0} lines
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] text-[#555] mt-1 uppercase tracking-widest">
                      ISP / DC / Local blocked on account gen
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-[#888] mb-2 block">Task Amount*</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={amount}
                      onChange={(e) => setAmount(Number(e.target.value))}
                      className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-4 mt-8 pt-6 border-t border-gray-800">
              <button
                onClick={() => setShowCreate(false)}
                className="px-6 py-2.5 bg-transparent border border-gray-700 text-[#888] hover:text-white hover:border-gray-500 text-sm font-medium transition-colors rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="px-6 py-2.5 bg-[#4c1d95] hover:bg-[#5b21b6] text-white text-sm font-medium transition-colors rounded-lg"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk actions */}
      <div className="flex items-center gap-2 p-1.5 bg-[#0F0F0F] border-l-2 border-[#00FF41] w-fit">
        <button
          onClick={startAll}
          className="flex items-center gap-2 hover:bg-[#7B2CBF]/20 text-[#888] hover:text-white px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors"
        >
          <Play size={14} className="text-[#00FF41]" /> Start All
        </button>
        <button
          onClick={stopAll}
          className="flex items-center gap-2 hover:bg-[#7B2CBF]/20 text-[#888] hover:text-white px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors"
        >
          <Square size={14} className="text-[#FF4B2B]" /> Stop All
        </button>
        <div className="w-px h-4 bg-purple-900/50 mx-1" />
        <button
          onClick={deleteAll}
          className="flex items-center gap-2 hover:bg-[#7B2CBF]/20 text-[#888] hover:text-white px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-widest transition-colors"
        >
          <Trash2 size={14} /> Delete All
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 bg-[#0F0F0F] border-t border-[#1A1A1A] overflow-hidden flex flex-col">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1A1A1A] bg-black/20">
                <th className="p-4 text-[10px] font-bold text-[#555] uppercase tracking-widest w-16">ID</th>
                <th className="p-4 text-[10px] font-bold text-[#555] uppercase tracking-widest">Store</th>
                <th className="p-4 text-[10px] font-bold text-[#555] uppercase tracking-widest">Email</th>
                <th className="p-4 text-[10px] font-bold text-[#555] uppercase tracking-widest">Proxy</th>
                <th className="p-4 text-[10px] font-bold text-[#555] uppercase tracking-widest w-28">Status</th>
                <th className="p-4 text-[10px] font-bold text-[#555] uppercase tracking-widest">Result</th>
                <th className="p-4 text-[10px] font-bold text-[#555] uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-purple-900/50">
              {filteredTasks.map((task) => (
                <tr key={task.id} className="hover:bg-[#7B2CBF]/10 transition-colors group">
                  <td className="p-4 text-sm font-mono text-[#555]">{task.id}</td>
                  <td className="p-4 text-sm text-white font-bold uppercase">{task.store}</td>
                  <td className="p-4 text-sm text-[#888] truncate max-w-[200px]" title={task.password ? `pw: ${task.password}` : undefined}>
                    {task.email}
                  </td>
                  <td className="p-4 text-sm font-mono text-[#888]">{task.proxy}</td>
                  <td className="p-4">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="p-4 text-[11px] text-[#555] max-w-[220px] truncate" title={task.message}>
                    {task.message || '—'}
                  </td>
                  <td className="p-4">
                    <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => startTask(task.id)}
                        className="p-1.5 text-[#888] hover:text-[#00FF41] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                        title="Start"
                      >
                        <Play size={14} />
                      </button>
                      <button
                        onClick={() => stopTask(task.id)}
                        className="p-1.5 text-[#888] hover:text-[#FF4B2B] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                        title="Stop"
                      >
                        <Square size={14} />
                      </button>
                      <button
                        onClick={() => duplicateTask(task)}
                        className="p-1.5 text-[#888] hover:text-[#7B2CBF] hover:bg-[#7B2CBF]/20 rounded-sm transition-colors"
                        title="Duplicate"
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        onClick={() => deleteTask(task.id)}
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
                    colSpan={6}
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
  );
}
