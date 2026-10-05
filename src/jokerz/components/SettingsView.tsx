import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { useDebouncedValue, useDebouncedCallback } from '../hooks/useDebouncedValue';
import {
  Save,
  Key,
  Clock,
  Webhook,
  Monitor,
  Users,
  Database,
  Download,
  Upload,
  Trash2,
  Plus,
  ArrowLeft,
  Smartphone,
  Play,
  Square,
  Search,
  Target,
  Mail,
  Check,
  ScanSearch,
} from 'lucide-react';
import {
  loadSettings,
  saveSettings,
  defaultSettings,
  BotSettings,
  clearAllStorage,
  exportAllData,
  importAllData,
  loadProxies,
  ProxyGroup,
} from '../lib/storage';
import { testDiscordWebhook, testSlackWebhook } from '../engine/webhooks';
import { listSessions, clearAllSessions, clearSession, SessionSummary } from '../engine/session';
import { resetProxyIntelligence } from '../engine/proxyIntelligence';
import { bus } from '../engine/EventBus';
import { testCapMonster, test2Captcha } from '../engine/captcha';
import { detectCaptcha } from '../engine/captchaDetect';
import type { ModuleFpKey } from '../engine/fingerprintProfiles';
import { lockedTlsMap } from '../engine/tlsAdvanced';
import { validateAccountsAuto, type AccountCheck, type ProfileAccountGap } from '../lib/validateAccounts';
import { STORE_FOLDERS, harvestFolder } from '../lib/storeFolders';
import { inspectTotp, totpCode, totpRemaining } from '../lib/totp';
import { resolveImapPreset } from '../lib/imapPresets';

function TotpBadge({ secret }: { secret?: string }) {
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(0);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (!secret) return;
    let dead = false;
    const tick = async () => {
      const inf = inspectTotp(secret);
      if (!inf.ok) {
        if (!dead) setBad(true);
        return;
      }
      const c = await totpCode(secret);
      if (dead) return;
      setBad(false);
      setCode(c);
      setLeft(totpRemaining());
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [secret]);
  if (!secret) return <span className="text-[#555]">—</span>;
  if (bad) return <span className="text-[#FF4B2B]">invalid</span>;
  return (
    <button
      type="button"
      title="Copy code"
      onClick={() => code && navigator.clipboard.writeText(code)}
      className="font-mono text-[11px] text-[#00FF41] hover:text-white"
    >
      {code || '······'}{' '}
      <span className="text-[#555]">{left}s</span>
    </button>
  );
}

export default function SettingsView() {
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const t = localStorage.getItem('jokerz_settings_tab') || 'accounts';
      if (['sms', 'assistant', 'grok', 'fingerprint', 'advanced'].includes(t)) return 'accounts';
      return t;
    } catch {
      return 'accounts';
    }
  });
  const selectSettingsTab = (id: string) => {
    setActiveTab(id);
    try {
      localStorage.setItem('jokerz_settings_tab', id);
    } catch {
      /* ignore */
    }
  };

  const [settings, setSettings] = useState<BotSettings>(() => loadSettings());
  const debouncedSaveSettings = useDebouncedCallback((next: BotSettings) => {
    saveSettings(next);
  }, 400);

  const [testMsg, setTestMsg] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [capDetect, setCapDetect] = useState<ReturnType<typeof detectCaptcha> | null>(null);
  const [harvestBusy, setHarvestBusy] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [loginFeed, setLoginFeed] = useState<{ ts: number; level: string; message: string }[]>([]);
  const [harvestMsg, setHarvestMsg] = useState('');
  const [acctChecks, setAcctChecks] = useState<AccountCheck[]>([]);
  const [acctGaps, setAcctGaps] = useState<ProfileAccountGap[]>([]);
  const [acctValidating, setAcctValidating] = useState(false);
  type OAuthRow = {
    email: string;
    sessionId: string;
    cookieCount: number;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    flow: string;
    ageMin: number;
    stale: boolean;
  };
  const [oauthSessions, setOauthSessions] = useState<OAuthRow[]>([]);
  const [oauthBusy, setOauthBusy] = useState('');
  const [bulkImportText, setBulkImportText] = useState('');
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [acctSearch, setAcctSearch] = useState('');
  const [showPassIdx, setShowPassIdx] = useState<number | null>(null);
  const [bankTarget, setBankTarget] = useState(20);
  const [bankTtl, setBankTtl] = useState(15);
  const [bankStatus, setBankStatus] = useState('');
  const [bankSep, setBankSep] = useState({ login: 0, atc: 0 });
  const [harvesterSearch, setHarvesterSearch] = useState('');
  const savedProxyGroups = useMemo(() => loadProxies([]), [activeTab, settings.harvesters]);

  /** Resolve one proxy line from harvester: group first, then manual list */
  const pickHarvesterProxy = (h: {
    proxy?: string;
    proxyGroupId?: string;
  }): { proxy?: string; from: string } => {
    const gid = (h.proxyGroupId || '').trim();
    if (gid) {
      const groups = loadProxies([]);
      const g =
        groups.find((x) => x.id === gid || x.name === gid) ||
        groups.find((x) => x.name.toLowerCase() === gid.toLowerCase());
      const list = (g?.proxies || []).map((s) => String(s).trim()).filter((s) => s.includes(':') || s.includes('@'));
      if (list.length) {
        const picked = list[Math.floor(Math.random() * list.length)];
        return { proxy: picked, from: `group:${g?.name || gid}` };
      }
    }
    const lines = String(h.proxy || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes(':') || s.includes('@'));
    if (lines.length) {
      return {
        proxy: lines[Math.floor(Math.random() * lines.length)],
        from: 'manual',
      };
    }
    return { from: 'direct' };
  };
  const debouncedHarvesterSearch = useDebouncedValue(harvesterSearch, 250);
  const [harvestActivity, setHarvestActivity] = useState<
    { ts: number; level: string; message: string }[]
  >([]);
  const [harvestWorkers, setHarvestWorkers] = useState<
    Record<string, { status?: string; step?: string; cookieCount?: number; running?: boolean; kind?: string }>
  >({});


  const [fpMsg, setFpMsg] = useState('');
  const [fpBusy, setFpBusy] = useState(false);
  const [retryMetrics, setRetryMetrics] = useState<any>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryMsg, setRetryMsg] = useState('');
  const [retryAuto, setRetryAuto] = useState(true);
  const [imapTest, setImapTest] = useState('');
  const [imapBusy, setImapBusy] = useState(false);
  const apiBase = () => {
    // Prefer Vite proxy (/api → 8787) so no CORS issues from :3000
    if (import.meta.env.VITE_API_URL) return String(import.meta.env.VITE_API_URL).replace(/\/$/, '');
    return '/jokerz-api';
  };
  const apiUrl = (path: string) => {
    const b = apiBase();
    const p = path.startsWith('/') ? path : `/${path}`;
    return b ? `${b}${p}` : p;
  };

  // Adaptive polling while Advanced is open:
  // hot (<30s since change) → 2s | warm (<2min) → 5s | idle → 15s | offline → 20s
  useEffect(() => {
    if (activeTab !== 'advanced' || !retryAuto) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastTotalsKey = '';
    let lastChangeAt = Date.now();
    let offline = false;

    const nextDelay = () => {
      if (offline) return 20_000;
      const idleFor = Date.now() - lastChangeAt;
      if (idleFor < 30_000) return 2_000;
      if (idleFor < 120_000) return 5_000;
      return 15_000;
    };

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(tick, nextDelay());
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await fetch(apiUrl('/api/metrics/retries'));
        const j = await r.json();
        offline = false;
        if (!cancelled && j) {
          const key = JSON.stringify(j.totals || {}) + ':' + (j.recent?.[0]?.ts || 0);
          if (key !== lastTotalsKey) {
            lastTotalsKey = key;
            lastChangeAt = Date.now();
          }
          setRetryMetrics(j);
        }
      } catch {
        offline = true;
      }
      schedule();
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, retryAuto]);

  const [sessionRows, setSessionRows] = useState<SessionSummary[]>([]);

  const [saved, setSaved] = useState(false);
  const [managingStore, setManagingStore] = useState<string | null>('Target');
  const [harvestFolderTab, setHarvestFolderTab] = useState<string>('Target');
  const [newEmail, setNewEmail] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newTotp, setNewTotp] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-save on change (debounced feel via effect)
  useEffect(() => {
    saveSettings(settings);
    bus.send({ type: 'UPDATE_SETTINGS', settings: { maxConcurrent: settings.maxConcurrent, queueTimeoutMs: settings.queueTimeoutMs, queueTimeoutByPriority: settings.queueTimeoutByPriority, jitterPercent: settings.jitterPercent, startStaggerMs: settings.startStaggerMs, proxyRotation: settings.proxyRotation, proxyCooldownMs: settings.proxyCooldownMs, antiDetectAggressiveness: settings.antiDetectAggressiveness, sessionEncryptionKey: settings.sessionEncryptionKey, autoRotateEvery: settings.autoRotateEvery, autoRotateMinutes: settings.autoRotateMinutes, proxyMaxReqPerWindow: settings.proxyMaxReqPerWindow, proxyRateWindowMs: settings.proxyRateWindowMs } } as any);
  }, [settings]);

  const update = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  // Live harvest feed while on Harvesters tab (Refract-style)
  useEffect(() => {
    if (activeTab !== 'harvesters' && activeTab !== 'accounts') return;
    let dead = false;
    const tick = async () => {
      try {
        const r = await fetch(apiUrl('/api/harvest/bank'));
        if (!r.ok || dead) return;
        const d = await r.json();
        if (dead) return;
        setBankStatus(
          `Bank LIVE ${d.valid ?? d.count}/${d.targetSize} · Shape ${d.shape ?? "?"} · PX ${d.px ?? d.separation?.targetPx ?? 0} · TTL ${d.ttlMinutes}m · ${
            d.harvesting ? 'RUNNING' : d.continuous ? 'waiting' : 'idle'
          }`
        );
        setBankSep({
          login: d.separation?.targetShapeLogin ?? 0,
          atc: d.separation?.targetShapeAtc ?? 0,
        });
        setBankTarget((x) => (x === 20 || x === d.targetSize ? d.targetSize : x));
        setHarvestActivity(Array.isArray(d.activity) ? d.activity : []);
        const wmap: typeof harvestWorkers = {};
        const list = Array.isArray(d.workers) ? d.workers : [];
        for (const w of list) {
          if (w?.id) wmap[w.id] = w;
        }
        setHarvestWorkers(wmap);
      } catch {
        /* offline */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'harvesters') return;
    setSettings((prev) => {
      const list = prev.harvesters || [];
      const extras = [
        { id: 'wm-px', name: 'Walmart PX', proxy: '', module: 'walmart', enabled: false, status: 'idle' as const },
        { id: 'pkc-dd', name: 'PKC DataDome', proxy: '', module: 'pokemon', enabled: false, status: 'idle' as const },
        { id: 'bandai-h', name: 'Bandai', proxy: '', module: 'bandai', enabled: false, status: 'idle' as const },
      ];
      if (!list.length) {
        return {
          ...prev,
          harvesters: [
            { id: 'refract-atc', name: 'Target ATC', proxy: '', module: 'target-shape', enabled: true, status: 'idle' as const },
            { id: 'refract-login', name: 'Target Login', proxy: '', module: 'target-shape-login', enabled: true, status: 'idle' as const },
            ...extras,
          ],
        };
      }
      const add = extras.filter((e) => !list.some((h) => h.id === e.id || String(h.module).toLowerCase() === e.module));
      if (!add.length) return prev;
      return { ...prev, harvesters: [...list, ...add] };
    });
  }, [activeTab]);

  const harvesterQ = harvesterSearch.trim().toLowerCase();
  const filteredHarvesters = useMemo(() => {
    const list = (settings.harvesters || []).filter((h) => harvestFolder(h.module) === harvestFolderTab);
    if (!harvesterQ) return list;
    return list.filter(
      (h) =>
        h.name.toLowerCase().includes(harvesterQ) ||
        h.module.toLowerCase().includes(harvesterQ)
    );
  }, [settings.harvesters, harvesterQ, harvestFolderTab]);

  const handleSave = () => {
    saveSettings(settings);
    bus.send({ type: 'UPDATE_SETTINGS', settings: { maxConcurrent: settings.maxConcurrent, queueTimeoutMs: settings.queueTimeoutMs, queueTimeoutByPriority: settings.queueTimeoutByPriority, jitterPercent: settings.jitterPercent, startStaggerMs: settings.startStaggerMs, proxyRotation: settings.proxyRotation, proxyCooldownMs: settings.proxyCooldownMs, antiDetectAggressiveness: settings.antiDetectAggressiveness, sessionEncryptionKey: settings.sessionEncryptionKey, autoRotateEvery: settings.autoRotateEvery, autoRotateMinutes: settings.autoRotateMinutes, proxyMaxReqPerWindow: settings.proxyMaxReqPerWindow, proxyRateWindowMs: settings.proxyRateWindowMs } } as any);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAddAccount = () => {
    if (!managingStore || !newEmail || !newPass) return;
    const email = newEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setHarvestMsg('✗ Invalid email format');
      return;
    }
    const existing = (settings.accounts[managingStore] || []).some(
      (a) => a.email.trim().toLowerCase() === email.toLowerCase()
    );
    if (existing) {
      setHarvestMsg(`✗ Duplicate account ${email}`);
      return;
    }
    setSettings((prev) => ({
      ...prev,
      accounts: {
        ...prev.accounts,
        [managingStore]: [
          ...(prev.accounts[managingStore] || []),
          { email, pass: newPass, totp: newTotp.trim() || undefined },
        ],
      },
    }));
    setNewEmail('');
    setNewPass('');
    setNewTotp('');
    setHarvestMsg(`✓ Added ${email} — run Validate to check profile link / login`);
  };

  const loadOAuthSessions = async () => {
    try {
      const r = await fetch(apiUrl('/api/target/sessions'));
      const d = await r.json();
      if (d.ok) setOauthSessions(d.sessions || []);
    } catch {
      try {
        const r2 = await fetch(apiUrl('/api/target/oauth2/sessions'));
        const d2 = await r2.json();
        if (d2.ok) setOauthSessions(d2.sessions || []);
      } catch (e: any) {
        setHarvestMsg(`✗ ${e?.message || e}`);
      }
    }
  };

  const renewOAuthSession = async (email: string) => {
    setOauthBusy(`renew-${email}`);
    try {
      const r = await fetch(apiUrl('/api/target/oauth2/renew'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      setHarvestMsg(d.ok ? `✓ Renewed ${email}` : `✗ Renew ${email}: ${d.message || d.error}`);
      await loadOAuthSessions();
    } catch (e: any) {
      setHarvestMsg(`✗ ${e?.message || e}`);
    }
    setOauthBusy('');
  };

  const deleteOAuthSession = async (email: string) => {
    if (!confirm(`Delete OAuth2 session for ${email}?`)) return;
    setOauthBusy(`del-${email}`);
    try {
      const r = await fetch(apiUrl(`/api/target/oauth2/sessions?email=${encodeURIComponent(email)}`), {
        method: 'DELETE',
      });
      const d = await r.json();
      setHarvestMsg(d.ok ? `✓ Deleted session ${email}` : `✗ ${d.error}`);
      await loadOAuthSessions();
    } catch (e: any) {
      setHarvestMsg(`✗ ${e?.message || e}`);
    }
    setOauthBusy('');
  };

  const renewAllOAuth = async () => {
    setOauthBusy('renew-all');
    setHarvestMsg('Renewing stale OAuth2 sessions…');
    try {
      const r = await fetch(apiUrl('/api/target/oauth2/sessions/renew-all'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlyStale: true }),
      });
      const d = await r.json();
      setHarvestMsg(
        d.ok
          ? `✓ Renew-all · ${d.success}/${d.attempted} ok`
          : `✗ ${d.error || 'renew-all failed'}`
      );
      await loadOAuthSessions();
    } catch (e: any) {
      setHarvestMsg(`✗ ${e?.message || e}`);
    }
    setOauthBusy('');
  };

  const clearAllOAuth = async () => {
    if (!confirm('Clear ALL Target OAuth2 sessions from disk?')) return;
    setOauthBusy('clear-all');
    try {
      const r = await fetch(apiUrl('/api/target/oauth2/sessions/clear'), { method: 'POST' });
      const d = await r.json();
      setHarvestMsg(d.ok ? `✓ Cleared ${d.cleared} sessions` : `✗ ${d.error}`);
      setOauthSessions([]);
    } catch (e: any) {
      setHarvestMsg(`✗ ${e?.message || e}`);
    }
    setOauthBusy('');
  };

  const validateOAuthSessions = async (live: boolean) => {
    setOauthBusy(live ? 'validate-live' : 'validate');
    setHarvestMsg(
      live
        ? 'Validating OAuth2 sessions (live /account)…'
        : 'Validating OAuth2 sessions (static)…'
    );
    try {
      const r = await fetch(apiUrl('/api/target/oauth2/sessions/validate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live }),
      });
      const d = await r.json();
      if (d.results) {
        const lines = (d.results as any[])
          .slice(0, 6)
          .map((x) => `${String(x.status || '').toUpperCase()} ${x.email}: ${x.message}`)
          .join(' · ');
        setHarvestMsg(
          `${d.fail ? '✗' : d.stale ? '⚠' : '✓'} OAuth2 · ${d.ok} ok · ${d.stale} stale · ${d.fail} fail` +
            (lines ? ` · ${lines}` : '')
        );
      } else if (d.result) {
        const x = d.result;
        setHarvestMsg(
          `${x.ok ? '✓' : '✗'} ${String(x.status || '').toUpperCase()} · ${x.email}: ${x.message}`
        );
      } else {
        setHarvestMsg(`✗ ${d.error || 'validate failed'}`);
      }
      await loadOAuthSessions();
    } catch (e: any) {
      setHarvestMsg(`✗ ${e?.message || e}`);
    }
    setOauthBusy('');
  };

  const runAccountValidation = async (live: boolean) => {
    setAcctValidating(true);
    setHarvestMsg(live ? 'Validating + live login…' : 'Validating accounts…');
    try {
      const result = await validateAccountsAuto({
        live,
        store: managingStore || 'Target',
        apiBase: apiBase(),
        onProgress: (m) => setHarvestMsg(m),
      });
      setAcctChecks(result.accounts);
      setAcctGaps(result.gaps);
      const fails = result.accounts.filter((a) => a.status === 'fail').length;
      const warns = result.accounts.filter((a) => a.status === 'warn').length;
      const oks = result.accounts.filter((a) => a.status === 'ok').length;
      setHarvestMsg(
        `${fails ? '✗' : warns ? '⚠' : '✓'} Accounts: ${oks} ok · ${warns} warn · ${fails} fail · ${result.gaps.length} profile gap(s)`
      );
    } catch (e: any) {
      setHarvestMsg(`✗ Validate failed: ${e?.message || e}`);
    }
    setAcctValidating(false);
  };

  const handleRemoveAccount = (store: string, idx: number) => {
    setSettings((prev) => ({
      ...prev,
      accounts: {
        ...prev.accounts,
        [store]: prev.accounts[store].filter((_, i) => i !== idx),
      },
    }));
  };

  /** Stellar-style bulk import: email:pass or email:pass:proxy per line */
  const handleBulkImport = () => {
    if (!managingStore) return;
    const lines = bulkImportText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const existing = new Set(
      (settings.accounts[managingStore] || []).map((a) => a.email.trim().toLowerCase())
    );
    const added: { email: string; pass: string; totp?: string }[] = [];
    let skipped = 0;
    for (const line of lines) {
      // email:pass or email:pass:extra
      const parts = line.split(':');
      if (parts.length < 2) {
        skipped++;
        continue;
      }
      const email = parts[0].trim();
      let finalPass = parts[1].trim();
      let totp: string | undefined;
      if (parts.length >= 3 && email.includes('@')) {
        const extra = parts[2].trim();
        if (/^[A-Z2-7=]{10,}$/i.test(extra.replace(/\s/g, ''))) totp = extra;
        else finalPass = parts[1].trim();
      }
      if (!email.includes('@') || !finalPass) {
        skipped++;
        continue;
      }
      if (existing.has(email.toLowerCase())) {
        skipped++;
        continue;
      }
      existing.add(email.toLowerCase());
      added.push({ email, pass: finalPass, totp });
    }
    if (!added.length) {
      setHarvestMsg(`✗ No new accounts imported (${skipped} skipped)`);
      return;
    }
    setSettings((prev) => ({
      ...prev,
      accounts: {
        ...prev.accounts,
        [managingStore]: [...(prev.accounts[managingStore] || []), ...added],
      },
    }));
    setBulkImportText('');
    setShowBulkImport(false);
    setHarvestMsg(`✓ Imported ${added.length} · skipped ${skipped}`);
  };

  const handleExportAccounts = () => {
    if (!managingStore) return;
    const list = settings.accounts[managingStore] || [];
    const text = list.map((a) => `${a.email}:${a.pass}`).join('\n');
    navigator.clipboard?.writeText(text).then(
      () => setHarvestMsg(`✓ Copied ${list.length} accounts to clipboard`),
      () => setHarvestMsg(text || '✗ empty')
    );
  };

  const handleClearStoreAccounts = () => {
    if (!managingStore) return;
    if (!confirm(`Delete all ${managingStore} accounts?`)) return;
    setSettings((prev) => ({
      ...prev,
      accounts: { ...prev.accounts, [managingStore]: [] },
    }));
    setHarvestMsg(`✓ Cleared ${managingStore} accounts`);
  };

  const handleAddHarvester = () => {
    setSettings((prev) => ({
      ...prev,
      harvesters: [
        ...prev.harvesters,
        {
          id: Date.now().toString(),
          name: `Harvester ${prev.harvesters.length + 1}`,
          proxy: '',
          proxyGroupId: '',
          module: 'target-shape' as const,
          enabled: true,
          status: 'idle' as const,
        },
      ],
    }));
  };

  const handleRemoveHarvester = (id: string) => {
    setSettings((prev) => ({
      ...prev,
      harvesters: prev.harvesters.filter((h) => h.id !== id),
    }));
  };

  const handleExport = () => {
    const data = exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jokerz-aio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        importAllData(data);
        // reload settings from storage
        setSettings(loadSettings());
        alert('Data imported successfully. Refresh recommended.');
      } catch {
        alert('Invalid backup file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleReset = () => {
    if (!confirm('This will delete ALL tasks, profiles, proxies, settings and account gen data. Continue?')) return;
    clearAllStorage();
    setSettings({ ...defaultSettings });
    alert('All data cleared.');
  };

    const tabs = [
    { id: 'accounts', label: 'Accounts', icon: Users },
    { id: 'harvesters', label: 'Harvesters', icon: Target },
    { id: 'webhooks', label: 'Webhooks', icon: Webhook },
    { id: 'captchas', label: 'Captchas', icon: Key },
    { id: 'general', label: 'General', icon: Monitor },
  ];


  const inputClass =
    'w-full bg-[#0e0915] border border-[#1A1A1A] rounded-sm px-4 py-2 text-sm text-white focus:outline-none focus:border-[#7B2CBF] focus:shadow-[0_0_10px_rgba(147,51,234,0.3)] transition-all font-mono';

  return (
    <div className="p-4 h-full flex flex-col gap-4 animate-in fade-in duration-200">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black italic uppercase tracking-tighter text-white">Settings</h1>
          <p className="text-[#555] text-[10px] mt-1 uppercase font-bold tracking-widest">
            Accounts · harvest · Discord · captcha
          </p>
        </div>
        <button type="button"
          onClick={handleSave}
          className={`flex items-center gap-2 px-5 py-2 text-xs font-black uppercase tracking-wider transition-colors rounded-sm ${
            saved
              ? 'bg-[#00FF41] text-black'
              : 'bg-[#00FF41] hover:bg-[#39ff6a] text-black'
          }`}
        >
          {saved ? <Check size={14} /> : <Save size={14} />}
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>

      <div className="flex flex-1 gap-8 overflow-hidden">
        {/* Sidebar */}
        <div className="w-56 flex flex-col gap-2 shrink-0 border-r border-[#1A1A1A] pr-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button type="button"
                key={tab.id}
                onClick={() => {
                  selectSettingsTab(tab.id);
                  setManagingStore(null);
                }}
                className={`flex items-center gap-3 px-4 py-3 text-xs font-bold uppercase tracking-widest transition-all rounded-sm ${
                  isActive
                    ? 'bg-[#7B2CBF]/20 text-[#7B2CBF] border border-[#7B2CBF]/50 shadow-[0_0_10px_rgba(147,51,234,0.2)]'
                    : 'text-[#555] hover:text-white hover:bg-[#121212] border border-transparent'
                }`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto pr-4 custom-scrollbar pb-4">
          {/* GENERAL */}
          {activeTab === 'general' && (
            <div className="space-y-6">
              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <h2 className="text-sm font-bold uppercase tracking-widest text-white mb-2">Engine</h2>
                <p className="text-[10px] text-[#555] mb-4 uppercase tracking-widest">
                  Delays locked · each module ships its own defaults
                </p>
                <div className="grid grid-cols-2 gap-3 text-[11px] font-mono text-[#888] mb-6">
                  <p>Monitor {settings.monitorDelay}ms</p>
                  <p>Error {settings.errorDelay}ms</p>
                  <p>Retry {settings.retryDelay}ms</p>
                  <p>Max retries {settings.maxRetries}</p>
                </div>
                <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">Max concurrent checkouts</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.maxConcurrent ?? 2}
                  onChange={(e) => update('maxConcurrent', Number(e.target.value) || 2)}
                  className={inputClass}
                />
                <p className="text-[10px] text-[#555] mt-2">How many checkout Chromes at once. Harvest/login are separate.</p>
              </div>

              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <h2 className="text-sm font-bold uppercase tracking-widest text-white mb-4">Sticky sessions</h2>
                <div className="flex gap-2 mb-3">
                  <button type="button" onClick={() => setSessionRows(listSessions())} className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#ccc] border border-[#1A1A1A]">
                    Refresh
                  </button>
                  <button type="button" onClick={() => { clearAllSessions(); setSessionRows([]); }} className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B] border border-red-900/40">
                    Clear login cookies
                  </button>
                </div>
                {sessionRows.length === 0 ? (
                  <p className="text-[11px] text-[#555]">None. Start a checkout to create a session.</p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {sessionRows.map((row) => (
                      <div key={row.taskId} className="flex items-center justify-between gap-2 text-[10px] font-mono bg-[#0e0915] border border-[#1A1A1A] px-3 py-2">
                        <p className="text-white truncate">{row.taskId.slice(0, 8)} · {row.kind} · {row.cookieCount} ck</p>
                        <button type="button" onClick={() => { clearSession(row.taskId); setSessionRows(listSessions()); }} className="text-[#FF4B2B] font-bold">Drop</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <h2 className="text-sm font-bold uppercase tracking-widest text-white mb-4">Data</h2>
                <div className="flex gap-2">
                  <button type="button" onClick={handleExport} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest border border-[#1A1A1A] text-[#ccc]">Export</button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest border border-[#1A1A1A] text-[#ccc]">Import</button>
                  <button type="button" onClick={handleReset} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B] border border-red-900/40">Reset all</button>
                  <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
                </div>
              </div>
            </div>
          )}

          {/* FINGERPRINT */}
          {false && activeTab === 'fingerprint' && (
            <div className="space-y-6">
              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <h2 className="text-sm font-bold uppercase tracking-widest text-white mb-2">
                  Advanced TLS fingerprint (locked)
                </h2>
                <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest mb-4">
                  JA4 + H2 Akamai + GREASE + extension shuffle. No knobs — each module uses the right Chrome.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                  {lockedTlsMap().map(({ module, profile, tls }) => {
                    const labels: Record<ModuleFpKey, string> = {
                      target: 'Target · Shape / Akamai',
                      walmart: 'Walmart · PerimeterX',
                      pokemon: 'Pokemon Center · DataDome',
                      bandai: 'Bandai · Shape',
                    };
                    return (
                      <div
                        key={module}
                        className="rounded-lg border border-[#1A1A1A] bg-[#0a0a0a] p-4 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-white">{labels[module]}</span>
                          <span className="text-[9px] px-2 py-0.5 rounded bg-[#7B2CBF]/20 text-[#C77DFF] font-mono uppercase">
                            {profile.label}
                          </span>
                        </div>
                        <p className="text-[10px] text-[#666]">{profile.notes}</p>
                        <p className="text-[9px] font-mono text-[#888] break-all">
                          TLS {tls.identifier} · ALPN {tls.alpn.join(',')} · shuffle {tls.shuffleExtensions ? 'ON' : 'OFF'}
                        </p>
                        <p className="text-[9px] font-mono text-[#555] break-all">H2 {tls.h2.akamai}</p>
                        <p className="text-[9px] font-mono text-[#444]">
                          groups {tls.groups.filter((g) => g !== 'GREASE').join(' · ')}
                          {tls.ech ? ' · ECH' : ''}
                          {tls.alps ? ' · ALPS' : ''}
                        </p>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap gap-2 mb-4">
                  <button
                    type="button"
                    disabled={fpBusy}
                    onClick={async () => {
                      setFpBusy(true);
                      setFpMsg('Checking API…');
                      try {
                        const h = await fetch(apiUrl('/health'), { signal: AbortSignal.timeout(4000) });
                        if (!h.ok) throw new Error(`health HTTP ${h.status}`);
                        setFpMsg('API online · advanced TLS probe…');
                        const r = await fetch(apiUrl('/api/fingerprint/tls'), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            store: 'target',
                            profile: 'chrome-131-win',
                            tlsClient: 'chrome_131',
                          }),
                        });
                        const d = await r.json();
                        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
                        const t = d.tls || {};
                        setFpMsg(
                          d.ok
                            ? `✓ ${t.identifier || 'tls'} · JA4 ${t.ja4 || '—'} · H2 ${String(t.h2Akamai || '').slice(0, 28)} · ${d.shuffle?.uniqueOrders ?? '?'} hellos · ${t.note || ''}`
                            : `✗ ${t.error || 'tls fail'}`
                        );
                      } catch (e: any) {
                        const msg = e?.message || String(e);
                        setFpMsg(
                          /fetch|Failed|Network|health|ECONNREFUSED|timeout/i.test(msg)
                            ? '✗ API offline — on your PC: npm run server'
                            : `✗ ${msg}`
                        );
                      }
                      setFpBusy(false);
                    }}
                    className="px-3 py-2 bg-[#7B2CBF] hover:bg-[#9D4EDD] disabled:opacity-50 text-white text-[10px] font-bold uppercase tracking-widest rounded-sm"
                  >
                    {fpBusy ? '…' : 'Test advanced TLS'}
                  </button>
                  <button
                    type="button"
                    disabled={fpBusy}
                    onClick={async () => {
                      setFpBusy(true);
                      setFpMsg('Checking API…');
                      try {
                        const h = await fetch(apiUrl('/health'), { signal: AbortSignal.timeout(4000) });
                        if (!h.ok) throw new Error(`health HTTP ${h.status}`);
                        setFpMsg('API online · browser fingerprint…');
                        const r = await fetch(apiUrl('/api/fingerprint/browser'), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: '{}',
                        });
                        const d = await r.json();
                        if (!r.ok) throw new Error(d.error || d.browser?.error || `HTTP ${r.status}`);
                        setFpMsg(
                          d.browser && !d.browser.error
                            ? `✓ webdriver=${String(d.browser.webdriver)} · plugins=${d.browser.pluginsLength} · ${String(d.browser.userAgent || '').slice(0, 42)}…`
                            : `✗ ${d.browser?.error || 'browser fail'}`
                        );
                      } catch (e: any) {
                        const msg = e?.message || String(e);
                        setFpMsg(
                          /fetch|Failed|Network|health|ECONNREFUSED|timeout/i.test(msg)
                            ? '✗ API offline — on your PC: npm run server'
                            : `✗ ${msg}`
                        );
                      }
                      setFpBusy(false);
                    }}
                    className="px-3 py-2 bg-[#00FF41] hover:bg-[#00FF41] disabled:opacity-50 text-black text-[10px] font-bold uppercase tracking-widest rounded-sm"
                  >
                    Test Browser FP
                  </button>
                </div>
                {fpMsg && (
                  <p
                    className={`text-xs font-mono whitespace-pre-wrap ${
                      fpMsg.startsWith('✓') ? 'text-[#00FF41]' : fpMsg.startsWith('✗') ? 'text-[#FF4B2B]' : 'text-[#E0E0E0]'
                    }`}
                  >
                    {fpMsg}
                  </p>
                )}
                <p className="text-[9px] text-[#555] mt-4 font-bold uppercase tracking-widest">
                  JA3 is not pinned (Chrome shuffle). Shape looks at JA4 + H2 + GREASE + IP.
                </p>
              </div>
            </div>
          )}

          {/* WEBHOOKS */}
          {activeTab === 'webhooks' && (
            <div className="space-y-6">
              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <div className="flex items-center gap-3 mb-6">
                  <Webhook className="text-[#7B2CBF]" size={20} />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-white">Discord Webhooks</h2>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      Main Discord Webhook
                    </label>
                    <input
                      type="text"
                      value={settings.discordWebhook}
                      onChange={(e) => update('discordWebhook', e.target.value)}
                      placeholder="https://discord.com/api/webhooks/... (queue + general)"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      Alert cooldown (seconds) — no repeat stock / price / queue alerts for the same product
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      value={settings.alertCooldownSec ?? 300}
                      onChange={(e) => update('alertCooldownSec', Math.max(0, Math.min(3600, Number(e.target.value) || 0)))}
                      placeholder="300"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      Success Webhook
                    </label>
                    <input
                      type="text"
                      value={settings.successWebhook}
                      onChange={(e) => update('successWebhook', e.target.value)}
                      placeholder="Stock + checkout success (falls back to main)"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      Decline Webhook
                    </label>
                    <input
                      type="text"
                      value={settings.declineWebhook}
                      onChange={(e) => update('declineWebhook', e.target.value)}
                      placeholder="Fails / declines / bans (falls back to main)"
                      className={inputClass}
                    />
                  </div>

                  <details className="pt-4 border-t border-[#1A1A1A]">
                    <summary className="text-[10px] uppercase font-bold text-[#555] tracking-widest cursor-pointer">
                      Ban alerts (optional)
                    </summary>
                    <div className="mt-3">
                    <p className="text-[10px] text-[#555] mb-3 leading-relaxed">
                      Which bans go to Discord. Default high = Shape/PX.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                          Min severity
                        </label>
                        <select
                          value={(settings as any).banAlertSeverity || 'high'}
                          onChange={(e) => update('banAlertSeverity' as any, e.target.value)}
                          className={inputClass}
                        >
                          <option value="off">Off — no ban webhooks</option>
                          <option value="low">Low — all hard bans</option>
                          <option value="medium">Medium — DataDome+</option>
                          <option value="high">High — Shape / PX / Imperva</option>
                          <option value="critical">Critical — Imperva only</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                          Always alert providers
                        </label>
                        <input
                          type="text"
                          value={(settings as any).banAlertAlwaysProviders ?? 'imperva'}
                          onChange={(e) => update('banAlertAlwaysProviders' as any, e.target.value)}
                          placeholder="imperva, shape"
                          className={inputClass}
                        />
                        <p className="text-[9px] text-[#555] mt-1 uppercase tracking-wider">
                          Comma-separated · bypass severity
                        </p>
                      </div>
                    </div>
                    </div>
                  </details>

                  <div className="mt-4 flex items-center gap-3">
                    <button type="button"
                      disabled={testing}
                      onClick={async () => {
                        setTesting(true);
                        setTestMsg('');
                        const r = await testDiscordWebhook(settings.discordWebhook || settings.successWebhook);
                        setTestMsg(r.ok ? '✓ Discord OK' : `✗ Discord: ${r.error || 'failed'}`);
                        setTesting(false);
                      }}
                      className="px-4 py-2 bg-[#7B2CBF] hover:bg-[#9D4EDD] disabled:opacity-50 text-white text-[10px] font-bold uppercase tracking-widest rounded-sm transition-colors"
                    >
                      {testing ? 'Sending…' : 'Test Discord'}
                    </button>
                    {testMsg && (
                      <span className={`text-xs font-bold ${testMsg.startsWith('✓') ? 'text-[#00FF41]' : 'text-[#FF4B2B]'}`}>
                        {testMsg}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          

          {/* HARVESTERS — Refract-style table */}
          {activeTab === 'harvesters' && (
            <div className="space-y-4 flex flex-col h-full min-h-0">
              {/* Top bar */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-[#0F0F0F] border border-[#1A1A1A] flex items-center justify-center">
                    <Target className="text-[#7B2CBF]" size={20} />
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-white">Harvesters</h2>
                    <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest">
                      {(settings.harvesters || []).filter((h) => harvestFolder(h.module) === harvestFolderTab).length} in {harvestFolderTab} · bank{' '}
                      {bankStatus || '—'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    title="Start bank fill"
                    onClick={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setHarvestBusy('bank');
                      setHarvestMsg('');
                      try {
                        await fetch(apiUrl('/api/harvest/bank/config'), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ targetSize: bankTarget, ttlMinutes: bankTtl }),
                        });
                        // Collect proxies + modules from enabled harvesters (groups + manual)
                        const enabled = (settings.harvesters || []).filter(
                          (x) => x.enabled !== false && harvestFolder(x.module) === harvestFolderTab
                        );
                        const workers = enabled.map((x) => {
                          const { proxy } = pickHarvesterProxy(x);
                          return {
                            id: x.id,
                            name: x.name,
                            module: x.module,
                            proxy: proxy || undefined,
                          };
                        });
                        const r = await fetch(apiUrl('/api/harvest/bank/start'), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            targetSize: bankTarget,
                            ttlMinutes: bankTtl,
                            workers,
                          }),
                        });
                        const d = await r.json();
                        setHarvestMsg(
                          d.ok
                            ? `✓ Refract harvest · ${workers.length} workers · bank ${bankTarget} / ${bankTtl}m`
                            : `✗ ${d.error || 'fail'}`
                        );
                      } catch (err: any) {
                        setHarvestMsg(`✗ ${err?.message || err}`);
                      }
                      setHarvestBusy('');
                    }}
                    className="p-2 rounded-md bg-[#0F0F0F] border border-[#1A1A1A] text-[#00FF41] hover:bg-green-500/10"
                  >
                    <Play size={16} />
                  </button>
                  <button
                    type="button"
                    title="Stop harvest"
                    onClick={async (e) => {
                      e.preventDefault();
                      try {
                        await fetch(apiUrl('/api/harvest/bank/stop'), { method: 'POST' });
                        setHarvestMsg('✓ Stopped');
                      } catch (err: any) {
                        setHarvestMsg(`✗ ${err?.message || err}`);
                      }
                    }}
                    className="p-2 rounded-md bg-[#0F0F0F] border border-[#1A1A1A] text-[#888] hover:text-white"
                  >
                    <Square size={16} />
                  </button>
                  <button
                    type="button"
                    title="Add harvester"
                    onClick={(e) => {
                      e.preventDefault();
                      handleAddHarvester();
                    }}
                    className="p-2 rounded-md bg-[#0F0F0F] border border-[#1A1A1A] text-[#7B2CBF] hover:bg-purple-500/10"
                  >
                    <Plus size={16} />
                  </button>
                  <button
                    type="button"
                    title="Clear all bank cookies (start from zero)"
                    onClick={async (e) => {
                      e.preventDefault();
                      if (
                        !confirm(
                          'Clear all bank cookies (LOGIN + ATC + others) and start from zero?'
                        )
                      )
                        return;
                      try {
                        const r = await fetch(apiUrl('/api/harvest/bank/reset'), {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({}),
                        });
                        const d = await r.json();
                        setBankSep({ login: 0, atc: 0 });
                        setHarvestMsg(
                          d.ok
                            ? 'Cookies cleared · empty bank · harvest again from zero'
                            : `✗ ${d.error || 'reset fail'}`
                        );
                      } catch (err: any) {
                        setHarvestMsg(`✗ ${err?.message || err}`);
                      }
                    }}
                    className="px-2.5 py-1.5 rounded-md bg-[#1a0a0a] border border-red-800/60 text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B] hover:bg-[#FF4B2B]/15 flex items-center gap-1.5"
                  >
                    <Trash2 size={14} />
                    Clear cookies
                  </button>
                </div>
              </div>

              {/* Cookie bank — simple */}
              <div className="flex flex-wrap items-center gap-3 bg-[#0F0F0F] border border-[#1A1A1A] rounded-lg px-3 py-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#888]">Bank</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-900/40 font-mono">
                  LOGIN {bankSep.login}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-900/40 font-mono">
                  ATC {bankSep.atc}
                </span>
                <label className="text-[10px] font-bold uppercase text-[#555] ml-2">Size</label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={bankTarget}
                  onChange={(e) => setBankTarget(Math.max(1, Number(e.target.value) || 1))}
                  className="w-14 bg-[#0e0915] border border-[#1A1A1A] rounded px-2 py-1 text-xs text-white"
                />
                <label className="text-[10px] font-bold uppercase text-[#555]">TTL min</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={bankTtl}
                  onChange={(e) => setBankTtl(Math.max(1, Number(e.target.value) || 1))}
                  className="w-14 bg-[#0e0915] border border-[#1A1A1A] rounded px-2 py-1 text-xs text-white"
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await fetch(apiUrl('/api/harvest/bank/config'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ targetSize: bankTarget, ttlMinutes: bankTtl }),
                      });
                      setHarvestMsg('✓ Bank saved');
                    } catch (err: any) {
                      setHarvestMsg(`✗ ${err?.message || err}`);
                    }
                  }}
                  className="text-[10px] font-bold uppercase tracking-widest text-purple-300 hover:text-white px-2"
                >
                  Save
                </button>
                {harvestMsg && (
                  <span
                    className={`text-[10px] font-bold ${
                      harvestMsg.startsWith('✓') ? 'text-[#00FF41]' : 'text-[#FF4B2B]'
                    }`}
                  >
                    {harvestMsg}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-1 border-b border-[#1A1A1A]">
                {STORE_FOLDERS.map((f) => {
                  const n = (settings.harvesters || []).filter((h) => harvestFolder(h.module) === f.id).length;
                  const active = harvestFolderTab === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setHarvestFolderTab(f.id)}
                      className={`px-4 py-2 text-[11px] font-bold uppercase tracking-widest border-b-2 ${
                        active ? 'border-[#7B2CBF] text-white' : 'border-transparent text-[#666] hover:text-white'
                      }`}
                    >
                      {f.short}
                      <span className={`ml-2 text-[10px] ${active ? 'text-[#9D4EDD]' : 'text-[#444]'}`}>{n}</span>
                    </button>
                  );
                })}
              </div>

              {/* Search */}
              <div className="flex items-center justify-between gap-3">
                <div className="relative flex-1 max-w-sm">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555]" size={14} />
                  <input
                    type="text"
                    value={harvesterSearch}
                    onChange={(e) => setHarvesterSearch(e.target.value)}
                    placeholder="Search harvesters..."
                    className="w-full bg-[#0F0F0F] border border-[#1A1A1A] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder:text-[#555] focus:outline-none focus:border-[#7B2CBF]"
                  />
                </div>
                <span className="text-[10px] text-[#555] font-bold uppercase tracking-widest">
                  {filteredHarvesters.length} harvesters
                </span>
              </div>

              {/* Table */}
              <div className="flex-1 overflow-auto rounded-lg border border-[#1A1A1A] bg-[#0e0915]">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#1A1A1A] text-[10px] font-bold uppercase tracking-widest text-[#555]">
                      <th className="p-3 w-8">
                        <span className="sr-only">Select</span>
                      </th>
                      <th className="p-3">Name</th>
                      <th className="p-3">Type</th>
                      <th className="p-3">Proxy</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Cookies</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHarvesters.map((h) => (
                        <tr
                          key={h.id}
                          className="border-b border-[#1A1A1A] hover:bg-[#0F0F0F]/80 text-sm"
                        >
                          <td className="p-3">
                            <input
                              type="checkbox"
                              checked={h.enabled !== false}
                              onChange={(e) =>
                                setSettings((prev) => ({
                                  ...prev,
                                  harvesters: prev.harvesters.map((x) =>
                                    x.id === h.id ? { ...x, enabled: e.target.checked } : x
                                  ),
                                }))
                              }
                              className="accent-[#7B2CBF]"
                            />
                          </td>
                          <td className="p-3">
                            <input
                              type="text"
                              value={h.name}
                              onChange={(e) =>
                                setSettings((prev) => ({
                                  ...prev,
                                  harvesters: prev.harvesters.map((x) =>
                                    x.id === h.id ? { ...x, name: e.target.value } : x
                                  ),
                                }))
                              }
                              className="bg-transparent border-0 text-white text-sm font-medium w-full focus:outline-none focus:text-[#a78bfa]"
                            />
                          </td>
                          <td className="p-3">
                            <select
                              value={h.module}
                              onChange={(e) =>
                                setSettings((prev) => ({
                                  ...prev,
                                  harvesters: prev.harvesters.map((x) =>
                                    x.id === h.id ? { ...x, module: e.target.value as any } : x
                                  ),
                                }))
                              }
                              className="bg-[#0F0F0F] border border-[#1A1A1A] rounded px-2 py-1 text-xs text-purple-200"
                            >
                              <option value="target-shape">Target ATC</option>
                              <option value="target-shape-login">Target Login</option>
                              <option value="walmart">Walmart</option>
                              <option value="bandai">Bandai</option>
                              <option value="pkc">Pokemon Center</option>
                            </select>
                          </td>
                          <td className="p-3 min-w-[240px]">
                            <select
                              value={h.proxyGroupId || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setSettings((prev) => {
                                  const next = {
                                    ...prev,
                                    harvesters: prev.harvesters.map((x) =>
                                      x.id === h.id
                                        ? {
                                            ...x,
                                            proxyGroupId: val || undefined,
                                            // Keep manual list as override; group takes priority when set
                                          }
                                        : x
                                    ),
                                  };
                                  try {
                                    saveSettings(next);
                                  } catch {
                                    /* */
                                  }
                                  return next;
                                });
                              }}
                              className="w-full mb-1.5 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-[11px] text-purple-200 focus:outline-none focus:border-[#7B2CBF]"
                              title="Use a saved Proxy Group from Proxies tab"
                            >
                              <option value="">— Manual / no group —</option>
                              {savedProxyGroups.map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.name} ({(g.proxies || []).length} proxies)
                                </option>
                              ))}
                            </select>
                            <input
                              value={h.proxy || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setSettings((prev) => ({
                                  ...prev,
                                  harvesters: prev.harvesters.map((x) =>
                                    x.id === h.id ? { ...x, proxy: val } : x
                                  ),
                                }));
                              }}
                              onBlur={(e) => {
                                const val = e.target.value;
                                setSettings((prev) => {
                                  const next = {
                                    ...prev,
                                    harvesters: prev.harvesters.map((x) =>
                                      x.id === h.id ? { ...x, proxy: val } : x
                                    ),
                                  };
                                  try {
                                    saveSettings(next);
                                  } catch {
                                    /* */
                                  }
                                  return next;
                                });
                              }}
                              spellCheck={false}
                              placeholder="host:port:user:pass  (or pick group)"
                              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-[#ccc] text-[11px] font-mono focus:outline-none focus:border-[#7B2CBF]"
                            />
                            <p className="text-[9px] text-[#555] mt-0.5 uppercase tracking-widest">
                              {(() => {
                                if (h.proxyGroupId) {
                                  const g = savedProxyGroups.find(
                                    (x) => x.id === h.proxyGroupId || x.name === h.proxyGroupId
                                  );
                                  const n = (g?.proxies || []).length;
                                  return n
                                    ? `group · ${g?.name || h.proxyGroupId} · ${n} proxies`
                                    : `group empty · ${h.proxyGroupId}`;
                                }
                                const n = String(h.proxy || '')
                                  .split(/[\n,;]+/)
                                  .map((s) => s.trim())
                                  .filter((s) => s.includes(':') || s.includes('@')).length;
                                return n ? `${n} manual line(s)` : 'no proxy · local IP';
                              })()}
                            </p>
                          </td>
                          <td className="p-3">
                            {(() => {
                              const w = harvestWorkers[h.id];
                              const running = w?.running || w?.status === 'running';
                              const step = w?.step || h.status;
                              const label = running
                                ? String(step || 'running').replace(/_/g, ' ')
                                : step === 'full'
                                  ? 'Bank full'
                                  : h.status === 'ok'
                                    ? 'OK'
                                    : h.status === 'error'
                                      ? 'Error'
                                      : 'Idle';
                              return (
                                <span
                                  className={`text-[10px] font-bold uppercase tracking-widest ${
                                    running
                                      ? 'text-amber-400'
                                      : step === 'full' || h.status === 'ok'
                                        ? 'text-[#00FF41]'
                                        : h.status === 'error'
                                          ? 'text-[#FF4B2B]'
                                          : 'text-[#555]'
                                  }`}
                                >
                                  {label}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="p-3 font-mono text-xs text-purple-200">
                            {harvestWorkers[h.id]?.cookieCount ?? h.cookieCount ?? 0}
                          </td>
                          <td className="p-3 text-right whitespace-nowrap">
                            <button
                              type="button"
                              disabled={harvestBusy === h.id}
                              title="Start Refract loop"
                              onClick={async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setHarvestBusy(h.id);
                                setHarvestMsg('');
                                try {
                                  const latest =
                                    (settings.harvesters || []).find((x) => x.id === h.id) || h;
                                  const { proxy: picked, from } = pickHarvesterProxy(latest);
                                  const res = await fetch(apiUrl('/api/harvest/worker/start'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      id: h.id,
                                      name: latest.name || h.name,
                                      module: latest.module || h.module,
                                      proxy: picked || undefined,
                                    }),
                                  });
                                  const d = await res.json();
                                  setHarvestMsg(
                                    d.ok
                                      ? `✓ ${h.name} loop · ${from}${picked ? ` · ${String(picked).split('@').pop()}` : ' · local'}`
                                      : `✗ ${d.error || 'fail'}`
                                  );
                                } catch (err: any) {
                                  setHarvestMsg(`✗ ${err?.message || err}`);
                                }
                                setHarvestBusy('');
                              }}
                              className="inline-flex p-1.5 text-[#00FF41] hover:bg-green-500/10 rounded"
                            >
                              <Play size={14} />
                            </button>
                            <button
                              type="button"
                              title="Stop this harvester"
                              onClick={async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                try {
                                  await fetch(apiUrl('/api/harvest/worker/stop'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: h.id }),
                                  });
                                  setHarvestMsg(`✓ Stopped ${h.name}`);
                                } catch (err: any) {
                                  setHarvestMsg(`✗ ${err?.message || err}`);
                                }
                              }}
                              className="inline-flex p-1.5 text-amber-400 hover:bg-amber-500/10 rounded"
                            >
                              <Square size={14} />
                            </button>
                            <button
                              type="button"
                              title="Delete"
                              onClick={() => handleRemoveHarvester(h.id)}
                              className="inline-flex p-1.5 text-[#555] hover:text-[#FF4B2B] rounded"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    {(settings.harvesters || []).length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-8 text-center text-[#555] text-xs">
                          No harvesters — press + · Refract loop: ATC = random PDP, Login = fake email
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Live feed */}
              <div className="bg-[#0a0610] border border-[#1A1A1A] rounded-lg overflow-hidden shrink-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-[#1A1A1A]">
                  <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">
                    Live harvest · Refract loop
                  </span>
                  <span className="text-[9px] text-[#555] font-bold uppercase tracking-widest">
                    auto-refresh 2s
                  </span>
                </div>
                <div className="h-36 overflow-y-auto font-mono text-[11px] p-3 space-y-1">
                  {harvestActivity.length === 0 ? (
                    <p className="text-[#555]">Hit play on a worker · ATC = random PDP · Login = fake email · reset each cookie</p>
                  ) : (
                    harvestActivity.map((a, i) => (
                      <div key={`${a.ts}-${i}`} className="flex gap-2">
                        <span className="text-[#555] shrink-0">
                          {new Date(a.ts).toLocaleTimeString('en-US', { hour12: false })}
                        </span>
                        <span
                          className={
                            a.level === 'success'
                              ? 'text-[#00FF41]'
                              : a.level === 'error'
                                ? 'text-[#FF4B2B]'
                                : a.level === 'warn'
                                  ? 'text-amber-400'
                                  : 'text-[#888]'
                          }
                        >
                          {a.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'captchas' && (
            <div className="space-y-6">
              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <div className="flex items-center gap-3 mb-6">
                  <Key className="text-[#7B2CBF]" size={20} />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-white">Captcha Solvers</h2>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      2Captcha API Key
                    </label>
                    <input
                      type="password"
                      value={settings.twocaptchaKey}
                      onChange={(e) => update('twocaptchaKey', e.target.value)}
                      placeholder="2Captcha API key"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      2Captcha Host
                    </label>
                    <input
                      type="text"
                      value={settings.twocaptchaHost || 'https://2captcha.com'}
                      onChange={(e) => update('twocaptchaHost', e.target.value)}
                      placeholder="https://2captcha.com"
                      className={inputClass}
                    />
                    <p className="text-[9px] text-[#555] mt-1 font-bold uppercase tracking-widest">
                      Cloud API from your PC · not a desktop app like CapMonster
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button"
                      disabled={testing}
                      onClick={async () => {
                        setTesting(true);
                        setTestMsg('');
                        const r = await test2Captcha();
                        setTestMsg(
                          r.ok
                            ? `✓ 2Captcha OK · balance $${r.balance} · ${r.host}`
                            : `✗ 2Captcha: ${r.error || 'failed'} · ${r.host || ''}`
                        );
                        setTesting(false);
                      }}
                      className="px-4 py-2 bg-[#00FF41] hover:bg-[#00FF41] disabled:opacity-50 text-black text-[10px] font-bold uppercase tracking-widest rounded-sm"
                    >
                      {testing ? 'Testing…' : 'Test 2Captcha'}
                    </button>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      CapMonster API Key
                    </label>
                    <input
                      type="password"
                      value={settings.capmonsterKey}
                      onChange={(e) => update('capmonsterKey', e.target.value)}
                      placeholder="Client key (local or cloud)"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      CapMonster Host (local)
                    </label>
                    <input
                      type="text"
                      value={settings.capmonsterHost || 'https://api.capmonster.cloud'}
                      onChange={(e) => update('capmonsterHost', e.target.value)}
                      placeholder="https://api.capmonster.cloud"
                      className={inputClass}
                    />
                    <p className="text-[9px] text-[#555] mt-1 font-bold uppercase tracking-widest">
                      Local app default port — check CapMonster UI if different. Cloud: https://api.capmonster.cloud
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      Provider
                    </label>
                    <select
                      value={settings.captchaProvider || 'capmonster'}
                      onChange={(e) => update('captchaProvider', e.target.value as BotSettings['captchaProvider'])}
                      className={inputClass}
                    >
                      <option value="capmonster">CapMonster (local/cloud)</option>
                      <option value="2captcha">2Captcha</option>
                      <option value="none">None</option>
                    </select>
                  </div>
                  <div className="md:col-span-2 flex items-center gap-3">
                    <button type="button"
                      disabled={testing}
                      onClick={async () => {
                        setTesting(true);
                        setTestMsg('');
                        const r = await testCapMonster();
                        setTestMsg(
                          r.ok
                            ? `✓ CapMonster OK · balance ${r.balance ?? '?'} · ${r.host}`
                            : `✗ ${r.error || 'failed'} · ${r.host || ''}`
                        );
                        setTesting(false);
                      }}
                      className="px-4 py-2 bg-[#7B2CBF] hover:bg-[#9D4EDD] disabled:opacity-50 text-white text-[10px] font-bold uppercase tracking-widest rounded-sm"
                    >
                      {testing ? 'Testing…' : 'Test CapMonster'}
                    </button>
                    {testMsg && (testMsg.includes('CapMonster') || testMsg.includes('127.0.0.1') || testMsg.includes('capmonster')) && (
                      <span className={`text-xs font-bold ${testMsg.startsWith('✓') ? 'text-[#00FF41]' : 'text-[#FF4B2B]'}`}>
                        {testMsg}
                      </span>
                    )}
                  </div>
                  <div className="pt-4 border-t border-[#1A1A1A] space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-[#888]">
                      Advanced detect · Shape · PX · DataDome · reCAPTCHA · Turnstile · Queue-it
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          ['Target Shape+PX', 'press and hold _abck bm_sz _px3=_pxvid= human.px-cdn px-captcha'],
                          ['Walmart PX', 'px-captcha _pxAppId="PX123" human.px-cdn'],
                          ['PKC DataDome', 'captcha-delivery.com datadome geo.captcha-delivery'],
                          ['Queue-it', 'queue-it.net queueittoken queueid=abc'],
                          ['reCAPTCHA', 'grecaptcha data-sitekey="6LeTest" google.com/recaptcha'],
                        ] as const
                      ).map(([label, html]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setCapDetect(detectCaptcha({ html, url: label }))}
                          className="px-2 py-1 text-[9px] font-bold uppercase tracking-widest rounded-sm border border-[#2a2a2a] text-purple-200 hover:bg-purple-500/10"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {capDetect && (
                      <div className="text-[11px] font-mono text-[#ccc] space-y-1 bg-[#0a0610] border border-[#1A1A1A] rounded p-3">
                        <p>
                          <span className="text-[#00FF41]">{capDetect.provider}</span>
                          {' · '}
                          {capDetect.challenge} · solver {capDetect.solver} ·{' '}
                          {Math.round(capDetect.confidence * 100)}%
                        </p>
                        <p className="text-[#888]">{capDetect.note}</p>
                        {capDetect.sitekey && <p>sitekey {capDetect.sitekey}</p>}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <Key className="text-[#00FF41]" size={20} />
                    <h2 className="text-sm font-bold uppercase tracking-widest text-white">AYCD AutoSolve</h2>
                  </div>
                  <span className="px-2 py-0.5 rounded-sm bg-gray-800 text-[#888] border border-gray-700 text-[10px] font-bold uppercase tracking-widest">
                    {settings.aycdToken ? 'Configured' : 'Disconnected'}
                  </span>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      Access Token
                    </label>
                    <input
                      type="password"
                      value={settings.aycdToken}
                      onChange={(e) => update('aycdToken', e.target.value)}
                      placeholder="••••••••••••••••"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">API Key</label>
                    <input
                      type="password"
                      value={settings.aycdApiKey}
                      onChange={(e) => update('aycdApiKey', e.target.value)}
                      placeholder="••••••••••••••••"
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SMS */}
          {false && activeTab === 'sms' && (
            <div className="space-y-6">
              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <div className="flex items-center gap-3 mb-6">
                  <Smartphone className="text-[#7B2CBF]" size={20} />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-white">
                    SMS Verification Services
                  </h2>
                </div>
                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      SMSPool API Key
                    </label>
                    <input
                      type="password"
                      value={settings.smspoolKey}
                      onChange={(e) => update('smspoolKey', e.target.value)}
                      placeholder="••••••••••••••••"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">
                      TextVerify API Key
                    </label>
                    <input
                      type="password"
                      value={settings.textverifyKey}
                      onChange={(e) => update('textverifyKey', e.target.value)}
                      placeholder="••••••••••••••••"
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ACCOUNTS — Refract: email + password only. Login lives on the task. */}
          {activeTab === 'accounts' && (
            <div className="space-y-4">
              {/* Site folders */}
              <div className="flex flex-wrap gap-1 border-b border-[#1A1A1A] pb-0">
                {STORE_FOLDERS.map((f) => {
                  const n = settings.accounts[f.id]?.length || 0;
                  const active = managingStore === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => {
                        setManagingStore(f.id);
                        setAcctSearch('');
                        setShowBulkImport(false);
                      }}
                      className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest border-b-2 transition-colors ${
                        active
                          ? 'border-[#7B2CBF] text-white'
                          : 'border-transparent text-[#666] hover:text-white'
                      }`}
                    >
                      {f.short}
                      <span className={`ml-2 text-[10px] ${active ? 'text-[#9D4EDD]' : 'text-[#444]'}`}>
                        {n}
                      </span>
                    </button>
                  );
                })}
              </div>

              {managingStore && (
                <div className="space-y-4">
                  {/* Toolbar */}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[160px] max-w-xs">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555]" />
                      <input
                        value={acctSearch}
                        onChange={(e) => setAcctSearch(e.target.value)}
                        placeholder="Search email…"
                        className={`pl-9 ${inputClass}`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowBulkImport((v) => !v)}
                      className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded-sm bg-[#7B2CBF] hover:bg-[#9D4EDD] text-white"
                    >
                      Import
                    </button>
                    <button
                      type="button"
                      disabled={acctValidating}
                      onClick={() => runAccountValidation(false)}
                      className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded-sm border border-[#333] text-[#aaa] hover:text-white disabled:opacity-50"
                    >
                      {acctValidating ? '…' : 'Check format'}
                    </button>
                    <button
                      type="button"
                      disabled={acctValidating}
                      onClick={() => runAccountValidation(true)}
                      className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded-sm border border-[#7B2CBF] text-[#c77dff] hover:bg-[#7B2CBF]/20 disabled:opacity-50"
                    >
                      {acctValidating ? 'Login…' : 'Live login'}
                    </button>
                    <button
                      type="button"
                      onClick={handleExportAccounts}
                      className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded-sm border border-[#333] text-[#aaa] hover:text-white"
                    >
                      Export
                    </button>
                    <button
                      type="button"
                      onClick={handleClearStoreAccounts}
                      className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded-sm border border-red-900/40 text-red-400 hover:bg-red-500/10 ml-auto"
                    >
                      Clear
                    </button>
                  </div>

                  <p className="text-[10px] text-[#666] uppercase tracking-widest font-bold">
                    Folder {managingStore} only. Check format = email/pass. Live login = Target o Walmart (Chrome). PKC/Bandai = guest.
                  </p>

                  {/* Bulk import panel */}
                  {showBulkImport && (
                    <div className="rounded-lg border border-[#1A1A1A] bg-[#0e0915] p-4 space-y-3">
                      <p className="text-[10px] text-[#888] uppercase tracking-widest font-bold">
                        Bulk import — one per line: email:password
                      </p>
                      <textarea
                        value={bulkImportText}
                        onChange={(e) => setBulkImportText(e.target.value)}
                        rows={6}
                        placeholder={'user1@gmail.com:pass123\nuser2@gmail.com:pass456'}
                        className={`w-full font-mono text-xs ${inputClass}`}
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleBulkImport}
                          className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest bg-[#7B2CBF] text-white rounded-sm"
                        >
                          Import lines
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowBulkImport(false)}
                          className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[#888] border border-[#333] rounded-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Quick add row */}
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder="email@example.com"
                      className={`flex-1 min-w-[180px] ${inputClass}`}
                    />
                    <input
                      type="password"
                      value={newPass}
                      onChange={(e) => setNewPass(e.target.value)}
                      placeholder="password"
                      autoComplete="new-password"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      className={`w-40 bg-[#0a0a0a] border border-[#2a2a2a] text-white rounded-sm px-3 py-2 text-sm focus:outline-none focus:border-[#7B2CBF]`}
                    />
                    <input
                      value={newTotp}
                      onChange={(e) => setNewTotp(e.target.value)}
                      placeholder="TOTP secret (opcional)"
                      className={`w-44 bg-[#0a0a0a] border border-[#2a2a2a] text-white rounded-sm px-3 py-2 text-sm focus:outline-none focus:border-[#7B2CBF]`}
                    />
                    <button
                      type="button"
                      onClick={handleAddAccount}
                      className="px-4 py-2 bg-[#7B2CBF] hover:bg-[#9D4EDD] text-white text-[10px] font-bold uppercase tracking-widest rounded-sm flex items-center gap-1"
                    >
                      <Plus size={14} /> Add
                    </button>
                  </div>

                  {/* Table */}
                  <div className="rounded-lg border border-[#1A1A1A] overflow-hidden">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-widest text-[#555] border-b border-[#1A1A1A] bg-[#0a0a0a]">
                          <th className="px-3 py-2.5 font-bold w-10">#</th>
                          <th className="px-3 py-2.5 font-bold">Email</th>
                          <th className="px-3 py-2.5 font-bold">Password</th>
                          <th className="px-3 py-2.5 font-bold">TOTP</th>
                          <th className="px-3 py-2.5 font-bold">Check</th>
                          <th className="px-3 py-2.5 font-bold text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(settings.accounts[managingStore] || [])
                          .map((acc, idx) => ({ acc, idx }))
                          .filter(
                            ({ acc }) =>
                              !acctSearch ||
                              acc.email.toLowerCase().includes(acctSearch.toLowerCase())
                          )
                          .map(({ acc, idx }) => (
                              <tr
                                key={idx}
                                className="border-b border-[#141414] hover:bg-[#121212] text-sm"
                              >
                                <td className="px-3 py-2.5 text-[#555] text-xs font-mono">
                                  {idx + 1}
                                </td>
                                <td className="px-3 py-2.5 text-white font-mono text-xs truncate max-w-[280px]">
                                  {acc.email}
                                </td>
                                <td className="px-3 py-2.5 font-mono text-xs text-[#666]">
                                  <button
                                    type="button"
                                    className="hover:text-white"
                                    onClick={() =>
                                      setShowPassIdx(showPassIdx === idx ? null : idx)
                                    }
                                    title="Show / hide"
                                  >
                                    {showPassIdx === idx ? acc.pass : '••••••••'}
                                  </button>
                                </td>
                                <td className="px-3 py-2.5">
                                  <TotpBadge secret={(acc as any).totp || (acc as any).totpSecret} />
                                </td>
                                <td className="px-3 py-2.5 text-[10px] uppercase tracking-widest">
                                  {(() => {
                                    const c = acctChecks.find(
                                      (x) => x.store === managingStore && x.index === idx
                                    );
                                    if (!c) return <span className="text-[#444]">—</span>;
                                    const color =
                                      c.status === 'ok'
                                        ? 'text-[#00FF41]'
                                        : c.status === 'warn'
                                          ? 'text-yellow-400'
                                          : 'text-[#FF4B2B]';
                                    return (
                                      <span className={color} title={c.issues.join(' · ') || c.liveMessage}>
                                        {c.status}
                                        {c.liveOk === true ? ' · live' : c.liveOk === false ? ' · login fail' : ''}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td className="px-3 py-2.5">
                                  <div className="flex items-center justify-end">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleRemoveAccount(managingStore, idx)
                                      }
                                      className="p-1.5 text-[#555] hover:text-[#FF4B2B] rounded-sm"
                                      title="Delete"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                        {(settings.accounts[managingStore] || []).length === 0 && (
                          <tr>
                            <td
                              colSpan={4}
                              className="px-3 py-12 text-center text-[#555] text-[10px] uppercase tracking-widest font-bold"
                            >
                              No accounts — Import or Add email:password
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Catchall compact */}
                  <details className="rounded-lg border border-[#1A1A1A] bg-[#0e0915]" open>
                    <summary className="px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[#888] cursor-pointer hover:text-white">
                      IMAP · 3DS email OTP
                    </summary>
                    <div className="px-4 pb-4 space-y-3">
                      <p className="text-[10px] text-[#666]">
                        Email + App Password only. Gmail / Outlook / Yahoo / iCloud already have host. Bank SMS is not here.
                      </p>
                      <input
                        value={settings.imapUser}
                        onChange={(e) => {
                          const email = e.target.value;
                          const p = resolveImapPreset(email);
                          update('imapUser', email);
                          if (p) update('imapHost', p.host);
                        }}
                        placeholder="email (gmail / outlook / yahoo / icloud)"
                        className={inputClass}
                      />
                      <input
                        type="password"
                        value={settings.imapPass}
                        onChange={(e) => update('imapPass', e.target.value)}
                        placeholder="App Password (no la pass normal)"
                        className={inputClass}
                      />
                      {(() => {
                        const p = resolveImapPreset(settings.imapUser);
                        return (
                          <p className="text-[10px] text-[#888]">
                            {p ? (
                              <>
                                <span className="text-[#00FF41]">{p.label}</span> · {p.host}:{p.port} · {p.hint}
                              </>
                            ) : settings.imapUser.includes('@') ? (
                              'Unknown domain — using imap.[domain]:993'
                            ) : (
                              'Gmail · Outlook · Yahoo · iCloud'
                            )}
                          </p>
                        );
                      })()}
                      <button
                        type="button"
                        disabled={imapBusy || !settings.imapUser || !settings.imapPass}
                        onClick={async () => {
                          setImapBusy(true);
                          setImapTest('');
                          try {
                            const r = await fetch(apiUrl('/api/imap/test'), {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                user: settings.imapUser,
                                pass: settings.imapPass,
                              }),
                            });
                            const j = await r.json();
                            setImapTest(j.ok ? j.message || 'IMAP OK' : j.error || 'fail');
                          } catch (e: any) {
                            setImapTest(e?.message || 'fail');
                          } finally {
                            setImapBusy(false);
                          }
                        }}
                        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border border-[#1A1A1A] text-[#ccc] hover:text-white disabled:opacity-40"
                      >
                        {imapBusy ? 'Testing…' : 'Test IMAP'}
                      </button>
                      {imapTest && (
                        <p className={`text-[10px] ${/OK/i.test(imapTest) ? 'text-[#00FF41]' : 'text-[#FF4B2B]'}`}>
                          {imapTest}
                        </p>
                      )}
                    </div>
                  </details>
                </div>
              )}
            </div>
          )}

          {false && activeTab === 'advanced' && (
            <div className="space-y-6">
              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <Clock className="text-[#7B2CBF]" size={20} />
                    <h2 className="text-sm font-bold uppercase tracking-widest text-white">
                      Retry Metrics
                    </h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRetryAuto((v) => !v)}
                      className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border rounded-sm ${
                        retryAuto
                          ? 'text-green-400 border-green-900/50'
                          : 'text-[#555] border-[#1A1A1A]'
                      }`}
                      title="Adaptive poll: 2s hot · 5s warm · 15s idle · 20s offline"
                    >
                      Auto {retryAuto ? 'ON' : 'OFF'}
                    </button>
                    <button
                      type="button"
                      disabled={retryBusy}
                      onClick={async () => {
                        setRetryBusy(true);
                        setRetryMsg('');
                        try {
                          const r = await fetch(apiUrl('/api/metrics/retries'));
                          const j = await r.json();
                          setRetryMetrics(j);
                          setRetryMsg(j.ok ? 'Updated' : j.error || 'Failed');
                        } catch (e: any) {
                          setRetryMsg(e?.message || 'Server offline');
                        } finally {
                          setRetryBusy(false);
                        }
                      }}
                      className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#E0E0E0] hover:text-white border border-[#1A1A1A] rounded-sm"
                    >
                      {retryBusy ? '…' : 'Refresh'}
                    </button>
                    <button
                      type="button"
                      disabled={retryBusy}
                      onClick={async () => {
                        if (!confirm('Reset retry metrics?')) return;
                        setRetryBusy(true);
                        try {
                          await fetch(apiUrl('/api/metrics/retries/reset'), { method: 'POST' });
                          setRetryMetrics(null);
                          setRetryMsg('Reset');
                        } catch (e: any) {
                          setRetryMsg(e?.message || 'Failed');
                        } finally {
                          setRetryBusy(false);
                        }
                      }}
                      className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B]/80 hover:text-[#FF4B2B] border border-red-900/40 rounded-sm"
                    >
                      Reset
                    </button>
                  </div>
                </div>
                {retryMsg && (
                  <p className="text-[10px] text-[#555] mb-3 font-mono">{retryMsg}</p>
                )}
                {retryMetrics?.totals && (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                    {[
                      ['Attempts', retryMetrics.totals.attempts],
                      ['Retries', retryMetrics.totals.retries],
                      ['Success', retryMetrics.totals.success],
                      ['Fail', retryMetrics.totals.fail],
                      ['Recovered', retryMetrics.totals.successAfterRetry],
                    ].map(([label, val]) => (
                      <div
                        key={String(label)}
                        className="bg-[#0e0915] border border-[#1A1A1A] rounded-sm p-3 text-center"
                      >
                        <p className="text-[9px] uppercase font-bold text-[#555] tracking-widest">
                          {label}
                        </p>
                        <p className="text-lg font-mono text-white mt-1">{val ?? 0}</p>
                      </div>
                    ))}
                  </div>
                )}
                {retryMetrics?.modules &&
                  Object.keys(retryMetrics.modules).length > 0 && (
                    <div className="overflow-x-auto mb-4">
                      <table className="w-full text-left text-[11px]">
                        <thead>
                          <tr className="text-[9px] uppercase text-[#555] tracking-widest border-b border-[#1A1A1A]">
                            <th className="py-2 pr-3">Module</th>
                            <th className="py-2 pr-3">Attempts</th>
                            <th className="py-2 pr-3">Retries</th>
                            <th className="py-2 pr-3">OK</th>
                            <th className="py-2 pr-3">Fail</th>
                            <th className="py-2 pr-3">Recover %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(retryMetrics.modules).map(([name, m]: [string, any]) => (
                            <tr key={name} className="border-b border-[#1A1A1A] text-[#E0E0E0]">
                              <td className="py-2 pr-3 font-mono text-white">{name}</td>
                              <td className="py-2 pr-3 font-mono">{m.attempts}</td>
                              <td className="py-2 pr-3 font-mono">{m.retries}</td>
                              <td className="py-2 pr-3 font-mono text-green-400">{m.success}</td>
                              <td className="py-2 pr-3 font-mono text-[#FF4B2B]">{m.fail}</td>
                              <td className="py-2 pr-3 font-mono">
                                {Math.round((m.recoverRate || 0) * 100)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                {retryMetrics?.recent?.length > 0 && (
                  <div className="bg-[#0a0610] border border-[#1A1A1A] rounded-sm max-h-40 overflow-y-auto p-3 font-mono text-[10px] space-y-1">
                    {retryMetrics.recent.slice(0, 20).map((e: any, i: number) => (
                      <div key={i} className="flex gap-2 text-[#888]">
                        <span className="text-[#555] shrink-0">
                          {e.ts ? new Date(e.ts).toLocaleTimeString('en-US', { hour12: false }) : ''}
                        </span>
                        <span className="text-purple-300">{e.module}</span>
                        <span
                          className={
                            e.outcome === 'success'
                              ? 'text-green-400'
                              : e.outcome === 'fail'
                                ? 'text-[#FF4B2B]'
                                : 'text-amber-400'
                          }
                        >
                          {e.outcome || 'retry'}
                        </span>
                        <span>{e.stage}</span>
                        {e.delayMs != null && <span className="text-[#555]">+{e.delayMs}ms</span>}
                        {e.error && (
                          <span className="text-[#555] truncate">{String(e.error).slice(0, 50)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {!retryMetrics && (
                  <p className="text-[10px] text-[#555] uppercase font-bold tracking-widest">
                    Press Refresh · requires npm run server
                  </p>
                )}
              </div>

              <div className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-6">
                <div className="flex items-center gap-3 mb-6">
                  <Database className="text-[#7B2CBF]" size={20} />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-white">Data Management</h2>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <button type="button"
                    onClick={handleExport}
                    className="flex flex-col items-center justify-center gap-2 p-4 bg-[#0e0915] border border-[#1A1A1A] rounded-sm hover:border-[#7B2CBF] hover:bg-[#7B2CBF]/5 transition-all group"
                  >
                    <Download className="text-[#555] group-hover:text-[#7B2CBF] transition-colors" size={24} />
                    <span className="text-xs font-bold uppercase tracking-widest text-white">Export Data</span>
                  </button>
                  <button type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center gap-2 p-4 bg-[#0e0915] border border-[#1A1A1A] rounded-sm hover:border-[#7B2CBF] hover:bg-[#7B2CBF]/5 transition-all group"
                  >
                    <Upload className="text-[#555] group-hover:text-[#7B2CBF] transition-colors" size={24} />
                    <span className="text-xs font-bold uppercase tracking-widest text-white">Import Data</span>
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleImport}
                    className="hidden"
                  />
                </div>
                <div className="mt-6 pt-6 border-t border-[#1A1A1A]">
                  <button type="button"
                    onClick={handleReset}
                    className="w-full flex items-center justify-center gap-2 bg-[#FF4B2B]/10 hover:bg-[#FF4B2B]/10 text-[#FF4B2B] py-3 text-xs font-bold uppercase tracking-widest border border-red-500/30 transition-colors rounded-sm"
                  >
                    <Trash2 size={16} /> Reset All Data
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
