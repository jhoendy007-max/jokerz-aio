/**
 * Upcoming drops: user-scheduled releases with countdown + optional reminder
 * (Discord/Slack "info" alert and browser notification) N minutes before.
 * Stored in localStorage. Pure helpers are exported for tests.
 */
export type DropStore = 'Target' | 'Walmart' | 'Pokemon Center' | 'Bandai' | 'Other';

export interface Drop {
  id: string;
  store: DropStore;
  title: string;
  product?: string; // URL / SKU / TCIN
  at: number; // epoch ms
  remindMin: number; // 0 = no reminder
  note?: string;
  reminded?: boolean;
  createdAt: number;
}

export const DROPS_KEY = 'jokerz_aio_drops';
/** Drops stay visible this long after start, then auto-hide (kept in storage). */
export const SHOW_PAST_MS = 60 * 60_000;

const subs = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  subs.forEach((f) => f());
};
export const subscribeDrops = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
export const getDropsVersion = () => version;

function isDrop(x: unknown): x is Drop {
  const d = x as Drop;
  return !!d && typeof d.id === 'string' && typeof d.title === 'string' && Number.isFinite(d.at);
}

export function loadDrops(): Drop[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DROPS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(isDrop) : [];
  } catch {
    return [];
  }
}

export function saveDrops(list: Drop[]) {
  try {
    localStorage.setItem(DROPS_KEY, JSON.stringify(list.slice(0, 200)));
  } catch {
    /* quota */
  }
  notify();
}

export function newDropId() {
  return `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function upsertDrop(d: Drop) {
  const list = loadDrops();
  const i = list.findIndex((x) => x.id === d.id);
  // editing the time re-arms the reminder
  if (i >= 0) list[i] = { ...d, reminded: list[i].at === d.at && list[i].remindMin === d.remindMin ? list[i].reminded : false };
  else list.push(d);
  saveDrops(list);
}

export function removeDrop(id: string) {
  saveDrops(loadDrops().filter((d) => d.id !== id));
}

/** Upcoming (and just-started) drops, soonest first. */
export function visibleDrops(list: Drop[], now = Date.now()): Drop[] {
  return list.filter((d) => d.at > now - SHOW_PAST_MS).sort((a, b) => a.at - b.at);
}

/** Drops whose reminder should fire now. */
export function dueReminders(list: Drop[], now = Date.now()): Drop[] {
  return list.filter((d) => !d.reminded && d.remindMin > 0 && now >= d.at - d.remindMin * 60_000 && now < d.at + 5 * 60_000);
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'LIVE';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/** Background reminder loop — call once from App. Returns a stop function. */
export function startDropReminders(
  send: (d: Drop) => Promise<unknown> | void,
  { everyMs = 15_000 }: { everyMs?: number } = {},
) {
  const tick = () => {
    const list = loadDrops();
    const due = dueReminders(list);
    if (!due.length) return;
    const ids = new Set(due.map((d) => d.id));
    saveDrops(list.map((d) => (ids.has(d.id) ? { ...d, reminded: true } : d)));
    for (const d of due) {
      try {
        void send(d);
      } catch {
        /* */
      }
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(`Drop in ${d.remindMin} min · ${d.store}`, { body: d.title });
        }
      } catch {
        /* */
      }
    }
  };
  tick();
  const t = setInterval(tick, everyMs);
  return () => clearInterval(t);
}
