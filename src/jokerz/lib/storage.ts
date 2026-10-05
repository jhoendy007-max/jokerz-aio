import { Task, Profile } from '../types';
import { normalizeAccounts } from './storeFolders';

export const KEYS = {
  tasks: 'jokerz_aio_tasks',
  profiles: 'jokerz_aio_profiles',
  proxies: 'jokerz_aio_proxies',
  accountGen: 'jokerz_aio_account_gen',
  settings: 'jokerz_aio_settings',
  checkouts: 'jokerz_aio_checkouts',
  dashboardStats: 'jokerz_aio_dashboard_stats',
  taskLogs: 'jokerz_aio_task_logs',
  sessionJars: 'jokerz_aio_session_jars',
  proxyScores: 'jokerz_aio_proxy_scores',
} as const;

// ─── Generic helpers ───────────────────────────────────────────────
function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, data: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.error(`Failed to save ${key}`, e);
  }
}

// ─── Tasks ─────────────────────────────────────────────────────────
const DEMO_TASK_IDS = new Set(['1001', '1002', '1003', '1004', '1005', '1006']);

export function loadTasks(fallback: Task[]): Task[] {
  const data = loadJSON(KEYS.tasks, fallback);
  const list = Array.isArray(data) ? data : fallback;
  return list.filter((t) => t && !DEMO_TASK_IDS.has(String(t.id)));
}

export function saveTasks(tasks: Task[]) {
  saveJSON(KEYS.tasks, tasks);
}

// ─── Profiles ──────────────────────────────────────────────────────
export function loadProfiles(fallback: Profile[]): Profile[] {
  const data = loadJSON(KEYS.profiles, fallback);
  return Array.isArray(data) ? data : fallback;
}

export function saveProfiles(profiles: Profile[]) {
  saveJSON(KEYS.profiles, profiles);
}

/** How to pick a profile when task uses `group:Name` */
export type ProfilePickMode = 'sticky' | 'round-robin' | 'random' | 'next';

const PROFILE_RR: Record<string, number> = {};
/** Last profile id used per task (sticky + rotate-on-decline) */
const PROFILE_STICKY: Record<string, string> = {};
/** Profiles temporarily skipped after decline (id → until ts) */
const PROFILE_COOLDOWN: Record<string, number> = {};

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}

function loadProfilePickMode(): ProfilePickMode {
  try {
    const s = loadJSON<any>(KEYS.settings, {});
    const m = String(s?.profilePickMode || s?.profileGroupMode || 'sticky').toLowerCase();
    if (m === 'round-robin' || m === 'rr') return 'round-robin';
    if (m === 'random') return 'random';
    if (m === 'next' || m === 'rotate') return 'next';
    return 'sticky';
  } catch {
    return 'sticky';
  }
}

/** Mark profile declined so next group pick skips it for a while */
export function markProfileDeclined(profileId: string, cooldownMs = 15 * 60 * 1000) {
  if (!profileId) return;
  PROFILE_COOLDOWN[profileId] = Date.now() + cooldownMs;
}

export function clearProfileSticky(taskId?: string) {
  if (taskId) delete PROFILE_STICKY[taskId];
  else Object.keys(PROFILE_STICKY).forEach((k) => delete PROFILE_STICKY[k]);
}

/**
 * Resolve task profile selection:
 * - `group:Name` → pick from that group by mode (sticky | round-robin | random | next)
 * - profile id or name → exact match
 * - fallback first profile
 *
 * Modes (settings.profilePickMode, default sticky):
 * - sticky: same task always same profile (hash of taskId)
 * - round-robin: cycle through group globally
 * - random: random each resolve
 * - next: sticky first time; after markProfileDeclined, advance to next in group
 */
export function resolveProfile(
  profileId: string | undefined | null,
  opts?: { taskId?: string; mode?: ProfilePickMode; rotate?: boolean }
): Profile | undefined {
  const profiles = loadProfiles([]);
  if (!profiles.length) return undefined;
  const raw = String(profileId || '').trim();
  if (!raw) return profiles[0];

  if (raw.startsWith('group:')) {
    const groupName = raw.slice(6).trim();
    let inGroup = profiles.filter(
      (p) => String(p.group || 'Personal').trim().toLowerCase() === groupName.toLowerCase()
    );
    if (!inGroup.length) return profiles[0];

    const now = Date.now();
    const available = inGroup.filter((p) => {
      const until = PROFILE_COOLDOWN[p.id] || PROFILE_COOLDOWN[p.name] || 0;
      return until <= now;
    });
    if (available.length) inGroup = available;

    const mode: ProfilePickMode =
      opts?.mode || (opts?.rotate ? 'next' : undefined) || loadProfilePickMode();
    const taskKey = String(opts?.taskId || '');

    if (mode === 'sticky' || mode === 'next') {
      if (taskKey && PROFILE_STICKY[taskKey]) {
        const kept = inGroup.find(
          (p) => p.id === PROFILE_STICKY[taskKey] || p.name === PROFILE_STICKY[taskKey]
        );
        if (kept) return kept;
        // previously sticky profile on cooldown → fall through to pick another
      }
      if (mode === 'sticky' && taskKey) {
        const idx = hashKey(taskKey) % inGroup.length;
        const picked = inGroup[idx];
        PROFILE_STICKY[taskKey] = picked.id;
        return picked;
      }
      // next: advance RR for this group, bind to task
      const gKey = groupName.toLowerCase();
      const idx = (PROFILE_RR[gKey] || 0) % inGroup.length;
      PROFILE_RR[gKey] = idx + 1;
      const picked = inGroup[idx];
      if (taskKey) PROFILE_STICKY[taskKey] = picked.id;
      return picked;
    }

    if (mode === 'round-robin') {
      const gKey = groupName.toLowerCase();
      const idx = (PROFILE_RR[gKey] || 0) % inGroup.length;
      PROFILE_RR[gKey] = idx + 1;
      const picked = inGroup[idx];
      if (taskKey) PROFILE_STICKY[taskKey] = picked.id;
      return picked;
    }

    // random
    const picked = inGroup[Math.floor(Math.random() * inGroup.length)];
    if (taskKey) PROFILE_STICKY[taskKey] = picked.id;
    return picked;
  }

  return (
    profiles.find((p) => p.id === raw || p.name === raw) ||
    profiles.find((p) => `${p.group || ''}·${p.name}` === raw) ||
    profiles[0]
  );
}

export function listProfileGroups(): string[] {
  const profiles = loadProfiles([]);
  const set = new Set<string>();
  for (const p of profiles) {
    set.add(String(p.group || 'Personal').trim() || 'Personal');
  }
  try {
    const raw = localStorage.getItem('jokerz_aio_profile_groups');
    if (raw) {
      const extra = JSON.parse(raw) as string[];
      if (Array.isArray(extra)) extra.forEach((g) => set.add(String(g).trim()));
    }
  } catch {
    /* */
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// ─── Proxies ───────────────────────────────────────────────────────
export interface ProxyGroup {
  id: string;
  name: string;
  count: number;
  type: string;
  status: string;
  proxies?: string[];
  /** per-group rotation override */
  rotation?: 'round-robin' | 'random' | 'sticky' | 'least-used' | 'intelligent';
  /** per-group cooldown after failure (ms) */
  cooldownMs?: number;
  /** sticky session minutes for ISP (checkout) */
  stickyMinutes?: number;
}

export function loadProxies(fallback: ProxyGroup[]): ProxyGroup[] {
  const data = loadJSON(KEYS.proxies, fallback);
  return Array.isArray(data) ? data : fallback;
}

export function saveProxies(proxies: ProxyGroup[]) {
  saveJSON(KEYS.proxies, proxies);
}

// ─── Account Gen tasks ─────────────────────────────────────────────
export interface AccGenTask {
  id: string;
  store: string;
  email: string;
  proxy: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  message?: string;
  status: 'idle' | 'running' | 'generating' | 'success' | 'failed';
}

export function loadAccGenTasks(fallback: AccGenTask[]): AccGenTask[] {
  const data = loadJSON(KEYS.accountGen, fallback);
  return Array.isArray(data) ? data : fallback;
}

export function saveAccGenTasks(tasks: AccGenTask[]) {
  saveJSON(KEYS.accountGen, tasks);
}

// ─── Settings ──────────────────────────────────────────────────────
export interface BotSettings {
  /** ISP proxy: rotate every N requests */
  ispRotateEveryN?: number;
  // General
  monitorDelay: number;
  errorDelay: number;
  retryDelay: number;
  maxRetries: number;
  maxConcurrent: number; // task queue concurrency
  jitterPercent: number; // ±% on delays (default 20)
  startStaggerMs: number; // max random delay when starting many tasks
  proxyRotation: 'round-robin' | 'random' | 'sticky' | 'least-used' | 'intelligent';
  /**
   * When task profile = `group:Name`, how to pick a member:
   * sticky | round-robin | random | next (rotate after decline)
   */
  profilePickMode: ProfilePickMode;
  proxyCooldownMs: number; // cooldown after mark failed
  antiDetectAggressiveness: number; // 1 soft 2 balanced 3 strict
  /** Global Chrome/TLS fingerprint (overridden per module in fingerprintByModule) */
  fingerprintProfileId?: string;
  fingerprintByModule?: {
    target?: string;
    walmart?: string;
    pokemon?: string;
    bandai?: string;
  };
  sessionEncryptionKey: string; // passphrase for cookie jar AES-GCM
  /** Auto IP rotation: 0 = off (only AntiDetect) */
  autoRotateEvery: number; // rotate after N checks (0 = off)
  autoRotateMinutes: number; // rotate after N minutes on same IP (0 = off)
  /** Cookie bank soft rotate every N ticks (0 = only on block/errors) */
  cookieAutoRotateEvery?: number;
  /** Soft rotate cookie jar after N minutes (0 = off) */
  cookieAutoRotateMinutes?: number;
  cookieRotateMinGapMs?: number;
  cookieRotateAfterErrors?: number;
  proxyMaxReqPerWindow: number; // max requests per proxy per window (0 = off)
  proxyRateWindowMs: number; // rate limit window
  queueTimeoutMs: number; // default max wait in queue (0 = off)
  queueTimeoutByPriority: {
    critical: number;
    high: number;
    normal: number;
    low: number;
  };
  /** Max checkout tasks woken by one monitor stock edge (default 5) */
  maxCheckoutPerStockPing: number;
  // Webhooks
  discordWebhook: string;
  /** Seconds before the same stock/price/queue alert can repeat (0 = off). Default 300. */
  alertCooldownSec?: number;
  slackWebhook: string;
  slackStockWebhook: string; // optional dedicated stock channel
  successWebhook: string;
  declineWebhook: string;
  /**
   * Min severity for proxy ban Discord/Slack alerts.
   * off | low (all hard bans) | medium (shape/px/dd+) | high (imperva + streaks only) | critical (imperva only)
   */
  banAlertSeverity: 'off' | 'low' | 'medium' | 'high' | 'critical';
  /** Providers to always alert on regardless of severity (comma or array) */
  banAlertAlwaysProviders: string;
  // Captchas
  twocaptchaKey: string;
  /** 2Captcha API host — default https://2captcha.com */
  twocaptchaHost: string;
  capmonsterKey: string;
  /** CapMonster API base — cloud or local e.g. http://127.0.0.1:80 */
  capmonsterHost: string;
  captchaProvider: 'capmonster' | '2captcha' | 'none';
  aycdToken: string;
  aycdApiKey: string;
  /** xAI Grok API key for in-app Assistant */
  xaiApiKey: string;
  xaiModel: string;
  assistantEnabled: boolean;
  // SMS
  smspoolKey: string;
  textverifyKey: string;
  smsActivateKey: string;
  // Catchall / IMAP
  catchallDomain: string;
  imapHost: string;
  imapUser: string;
  imapPass: string;
  // Accounts per store
  accounts: Record<
    string,
    {
      email: string;
      pass: string;
      totp?: string;
      /** Optional per-account proxy line */
      proxy?: string;
      /** Optional saved proxy group id from Proxies tab */
      proxyGroupId?: string;
    }[]
  >;
  // Harvesters
  harvesters: {
    id: string;
    name: string;
    /** Single proxy or multi-line / comma-separated list (host:port:user:pass) */
    proxy: string;
    /** Optional saved Proxy Group id/name from Proxies tab */
    proxyGroupId?: string;
    module:
      | 'target-shape'
      | 'target-shape-login'
      | 'shape-login'
      | 'walmart'
      | 'bandai'
      | 'pkc'
      | 'generic'
      | string;
    enabled: boolean;
    /** last harvest status */
    status?: 'idle' | 'running' | 'ok' | 'error';
    lastRun?: number;
    lastError?: string;
    cookieCount?: number;
  }[];
}

/**
 * Factory defaults tuned for retail monitors (Target Shape/PX, Walmart, PKC).
 * Fresh install uses these until the user saves Settings.
 */
export const defaultSettings: BotSettings = {
  monitorDelay: 6000, // faster baseline; modules still override
  errorDelay: 4000,
  retryDelay: 6000,
  maxRetries: 5,
  maxConcurrent: 2,
  jitterPercent: 30, // more human variance
  startStaggerMs: 5000,
  proxyRotation: 'intelligent',
  /** Group profile pick: sticky (same task→same profile) | round-robin | random | next */
  profilePickMode: 'sticky' as ProfilePickMode,
  /** Rotate ISP every N monitor checks (0 = off schedule; only block/latency). Higher = less thrash. */
  ispRotateEveryN: 12,
  /** Skip ISP lines slower than this avg ms (0 = off) */
  maxProxyLatencyMs: 4500,
  proxyCooldownMs: 120000, // 2 min IP rest (aligned with Shape ISP soft CD)
  antiDetectAggressiveness: 2,
  fingerprintProfileId: 'chrome-131-win',
  fingerprintByModule: {
    target: 'chrome-131-win',
    walmart: 'chrome-131-win',
    pokemon: 'chrome-133-win',
    bandai: 'chrome-131-win',
  },
  sessionEncryptionKey: '',
  autoRotateEvery: 15,
  autoRotateMinutes: 6,
  cookieAutoRotateEvery: 12,
  cookieAutoRotateMinutes: 6,
  cookieRotateMinGapMs: 12000,
  cookieRotateAfterErrors: 2,
  proxyMaxReqPerWindow: 15,
  proxyRateWindowMs: 60000,
  queueTimeoutMs: 300000,
  maxCheckoutPerStockPing: 5,
  queueTimeoutByPriority: {
    critical: 600000,
    high: 300000,
    normal: 180000,
    low: 60000,
  },
  discordWebhook: '',
  alertCooldownSec: 300,
  slackWebhook: '',
  slackStockWebhook: '',
  successWebhook: '',
  declineWebhook: '',
  banAlertSeverity: 'high',
  banAlertAlwaysProviders: 'imperva',
  twocaptchaKey: '',
  twocaptchaHost: 'https://2captcha.com',
  capmonsterKey: '',
  capmonsterHost: 'https://api.capmonster.cloud',
  captchaProvider: 'capmonster',
  aycdToken: '',
  aycdApiKey: '',
  xaiApiKey: '',
  xaiModel: 'grok-3',
  assistantEnabled: true,
  smspoolKey: '',
  textverifyKey: '',
  smsActivateKey: '',
  catchallDomain: '',
  imapHost: '',
  imapUser: '',
  imapPass: '',
  accounts: {
    Walmart: [],
    Target: [],
    'Pokemon Center': [],
    'Bandai Collectables': [],
  },
  harvesters: [
    {
      id: 'shape-target',
      name: 'Target Shape (ATC)',
      proxy: '',
      module: 'target-shape',
      enabled: true,
      status: 'idle',
    },
    {
      id: 'shape-login',
      name: 'Target Shape Login',
      proxy: '',
      module: 'target-shape-login',
      enabled: true,
      status: 'idle',
    },
    {
      id: 'px-walmart',
      name: 'Walmart PX',
      proxy: '',
      module: 'walmart',
      enabled: true,
      status: 'idle',
    },
    {
      id: 'pkc',
      name: 'Pokemon Center',
      proxy: '',
      module: 'pkc',
      enabled: false,
      status: 'idle',
    },
    {
      id: 'shape-bandai',
      name: 'Bandai',
      proxy: '',
      module: 'bandai',
      enabled: false,
      status: 'idle',
    },
  ],
};



/** Per-store task defaults applied on Create Task when switching module */
export type ModuleKey = 'Target' | 'Walmart' | 'Pokemon Center' | 'Bandai Collectables';

export interface ModuleTaskDefaults {
  mode: 'monitor' | 'checkout' | 'shipping';
  delay: number;
  priority: 'low' | 'normal' | 'high' | 'critical';
  /** Suggested proxy group name (user can change) */
  monitorProxy: string;
  checkoutProxy: string;
  notes: string;
}

export const MODULE_DEFAULTS: Record<ModuleKey, ModuleTaskDefaults> = {
  Target: {
    mode: 'monitor',
    delay: 5000, // RedSky TLS path is fast; 5s poll is enough for restocks
    priority: 'high',
    monitorProxy: 'ISPs-VA',
    checkoutProxy: 'ISPs-VA',
    notes: 'Target: ISP + RedSky TLS, ~5s poll, low concurrency',
  },
  Walmart: {
    mode: 'monitor',
    delay: 7000,
    priority: 'high',
    monitorProxy: 'ISPs-VA',
    checkoutProxy: 'ISPs-VA',
    notes: 'Walmart: PerimeterX — ISP sticky, ~7s poll',
  },
  'Pokemon Center': {
    mode: 'monitor',
    delay: 6000,
    priority: 'critical',
    monitorProxy: 'ISPs-VA',
    checkoutProxy: 'ISPs-VA',
    notes: 'PKC: queue-aware; ~6s poll when not in queue',
  },
  'Bandai Collectables': {
    mode: 'monitor',
    delay: 6000,
    priority: 'normal',
    monitorProxy: 'DC-Resi',
    checkoutProxy: 'DC-Resi',
    notes: 'Bandai: moderate antibot; ~6s poll',
  },
};

export function defaultsForStore(store: string): ModuleTaskDefaults {
  const key = store as ModuleKey;
  return MODULE_DEFAULTS[key] || MODULE_DEFAULTS.Target;
}

function withAccounts(s: BotSettings): BotSettings {
  return { ...s, accounts: normalizeAccounts(s.accounts as any) };
}

export function loadSettings(): BotSettings {
  const stored = loadJSON(KEYS.settings, {}) as Partial<BotSettings> & { _defaultsVersion?: number };
  const CURRENT = 3; // bump when factory defaults change meaningfully
  // Fresh install or never migrated → apply full factory defaults
  if (!stored || Object.keys(stored).length === 0 || stored._defaultsVersion !== CURRENT) {
    if (!stored || Object.keys(stored).length === 0) {
      return withAccounts({ ...defaultSettings, _defaultsVersion: CURRENT } as any);
    }
    return withAccounts({ ...defaultSettings, ...stored, _defaultsVersion: CURRENT } as any);
  }
  return withAccounts({
    ...defaultSettings,
    ...stored,
    harvesters: Array.isArray(stored.harvesters) ? stored.harvesters : defaultSettings.harvesters,
  });
}


export function saveSettings(settings: BotSettings) {
  saveJSON(KEYS.settings, settings);
}

// ─── Checkouts / Dashboard ─────────────────────────────────────────
export interface StoredCheckout {
  id: string;
  store: string;
  product: string;
  orderNumber: string;
  quantity: string;
  profile: string;
  date: string;
  price: string;
  ts: number;
}

export interface DashboardStats {
  totalCheckouts: number;
  failedCheckouts: number;
  activeTasks: number;
  totalSpent: number;
  successToday: number;
  failsToday: number;
}

export const defaultDashboardStats: DashboardStats = {
  totalCheckouts: 0,
  failedCheckouts: 0,
  activeTasks: 0,
  totalSpent: 0,
  successToday: 0,
  failsToday: 0,
};

const DEMO_ORDERS = /^(WM-849201948|TG-102938475|PC-593028174|BC-928374650)$/;

export function loadCheckouts(fallback: StoredCheckout[] = []): StoredCheckout[] {
  const data = loadJSON(KEYS.checkouts, fallback);
  const list = Array.isArray(data) ? data : fallback;
  return list.filter((c) => c && !DEMO_ORDERS.test(String(c.orderNumber || '')));
}

export function saveCheckouts(checkouts: StoredCheckout[]) {
  // keep last 50
  saveJSON(KEYS.checkouts, checkouts.slice(0, 50));
}

export function addCheckout(checkout: StoredCheckout) {
  const current = loadCheckouts();
  saveCheckouts([checkout, ...current]);
}

export function loadDashboardStats(): DashboardStats {
  return { ...defaultDashboardStats, ...loadJSON(KEYS.dashboardStats, {}) };
}

export function saveDashboardStats(stats: DashboardStats) {
  saveJSON(KEYS.dashboardStats, stats);
}


// ─── Task logs ─────────────────────────────────────────────────────
export interface StoredTaskLog {
  taskId: string;
  level: string;
  message: string;
  ts: number;
}

export function loadTaskLogs(): StoredTaskLog[] {
  const data = loadJSON(KEYS.taskLogs, [] as StoredTaskLog[]);
  return Array.isArray(data) ? data : [];
}

export function appendTaskLog(entry: StoredTaskLog) {
  const all = loadTaskLogs();
  all.push(entry);
  // Cap per task so one noisy task doesn't wipe others' history
  const byTask = new Map<string, StoredTaskLog[]>();
  for (const e of all) {
    const id = e.taskId || '_';
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id)!.push(e);
  }
  const capped: StoredTaskLog[] = [];
  for (const [, list] of byTask) {
    capped.push(...list.slice(-200));
  }
  // Global hard cap
  saveJSON(KEYS.taskLogs, capped.slice(-2000));
}

export function getLogsForTask(taskId: string, limit = 200): StoredTaskLog[] {
  const id = String(taskId || '');
  return loadTaskLogs()
    .filter((l) => l.taskId === id)
    .slice(-limit);
}


// ─── Sticky session jars (cookies on disk) ─────────────────────────
export interface PersistedSession {
  taskId: string;
  proxy?: string;
  cookies: Record<string, string>;
  createdAt: number;
  lastUsedAt: number;
  hits: number;
  accountEmail?: string;
}

export function loadSessionJars(): Record<string, PersistedSession> {
  const data = loadJSON(KEYS.sessionJars, {} as Record<string, PersistedSession>);
  return data && typeof data === 'object' ? data : {};
}

export function saveSessionJars(jars: Record<string, PersistedSession>) {
  // prune sessions idle > 24h
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  const pruned: Record<string, PersistedSession> = {};
  for (const [k, v] of Object.entries(jars)) {
    if (v && now - (v.lastUsedAt || v.createdAt || 0) < maxAge) pruned[k] = v;
  }
  saveJSON(KEYS.sessionJars, pruned);
}

export function clearSessionJars() {
  saveJSON(KEYS.sessionJars, {});
}


// ─── Proxy intelligence scores ─────────────────────────────────────
export function loadProxyScores<T = Record<string, unknown>>(): T {
  return loadJSON(KEYS.proxyScores, {} as T);
}

export function saveProxyScores(data: unknown) {
  saveJSON(KEYS.proxyScores, data);
}

// ─── Clear all ─────────────────────────────────────────────────────
export function clearAllStorage() {
  Object.values(KEYS).forEach((key) => localStorage.removeItem(key));
}

export function exportAllData() {
  return {
    tasks: loadJSON(KEYS.tasks, []),
    profiles: loadJSON(KEYS.profiles, []),
    proxies: loadJSON(KEYS.proxies, []),
    accountGen: loadJSON(KEYS.accountGen, []),
    settings: loadJSON(KEYS.settings, defaultSettings),
    checkouts: loadJSON(KEYS.checkouts, []),
    taskLogs: loadJSON(KEYS.taskLogs, []),
    sessionJars: loadJSON(KEYS.sessionJars, {}),
    proxyScores: loadJSON(KEYS.proxyScores, {}),
    dashboardStats: loadJSON(KEYS.dashboardStats, defaultDashboardStats),
    exportedAt: new Date().toISOString(),
  };
}

export function importAllData(data: any) {
  if (data.tasks) saveJSON(KEYS.tasks, data.tasks);
  if (data.profiles) saveJSON(KEYS.profiles, data.profiles);
  if (data.proxies) saveJSON(KEYS.proxies, data.proxies);
  if (data.accountGen) saveJSON(KEYS.accountGen, data.accountGen);
  if (data.settings) saveJSON(KEYS.settings, data.settings);
  if (data.checkouts) saveJSON(KEYS.checkouts, data.checkouts);
  if (data.dashboardStats) saveJSON(KEYS.dashboardStats, data.dashboardStats);
}
