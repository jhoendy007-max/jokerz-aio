/**
 * Telegram commands: the server receives messages from YOUR chat only and queues them;
 * this loop (runs while the app is open) executes them and sends the answer back.
 */
import { API_BASE } from '../engine/apiBase';
import { bus, engine } from '../engine';
import { loadSettings, loadTasks } from './storage';
import { taskToEngineConfig } from './taskConfig';
import { summaryFor } from './dailySummaryRunner';
import { money } from './dailySummary';
import { loadDrops, visibleDrops, formatCountdown } from './drops';
import { getMonitorHealth } from './monitorHealth';
import type { Task } from '../types';

type Cmd = { id: string; chatId: string; cmd: string; args: string };
const STORES = ['Target', 'Walmart', 'Pokemon Center', 'Bandai Collectables'];

export function matchStore(arg: string): string | undefined {
  const a = arg.toLowerCase().replace(/[^a-z]/g, '');
  if (!a || a === 'all') return undefined;
  return STORES.find((s) => s.toLowerCase().replace(/[^a-z]/g, '').startsWith(a) || (a === 'pkc' && s === 'Pokemon Center'));
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function ensureRegistered(tasks: Task[]) {
  engine.start();
  const missing = tasks.filter((t) => engine.getTaskStatus(t.id) === undefined);
  if (missing.length) bus.send({ type: 'CREATE_TASKS', tasks: missing.map(taskToEngineConfig) });
}

const HELP = [
  '<b>Jokerz AIO commands</b>',
  '/status — tasks running / idle / success',
  '/tasks — list tasks with status',
  '/start [target|walmart|pkc|bandai] — start all (or one store)',
  '/stop [store] — stop all (or one store)',
  '/summary — last 24 h restocks, price changes, checkouts',
  '/drops — upcoming drops',
  '/health — monitor health',
].join('\n');

export function runCommand(c: Pick<Cmd, 'cmd' | 'args'>): string {
  const tasks = loadTasks([]);
  if (c.cmd === 'help') return HELP;
  if (c.cmd === 'status' || c.cmd === 'tasks') {
    const st = tasks.map((t) => ({ t, s: engine.getTaskStatus(t.id) || t.status || 'idle' }));
    const count = (f: (s: string) => boolean) => st.filter((x) => f(String(x.s))).length;
    const active = count((s) => ['running', 'queued', 'oos', 'instock', 'carting', 'carted', 'checkout'].includes(s));
    const head = `<b>Tasks</b>: ${tasks.length} · active ${active} · success ${count((s) => s === 'success')} · failed ${count((s) => s === 'failed')}`;
    if (c.cmd === 'status') {
      const byStore = STORES.map((s) => [s, st.filter((x) => x.t.store === s)] as const).filter(([, l]) => l.length);
      return [head, ...byStore.map(([s, l]) => `${esc(s)}: ${l.length} (${l.filter((x) => !['idle', 'success', 'failed'].includes(String(x.s))).length} active)`)].join('\n');
    }
    return [head, ...st.slice(0, 40).map(({ t, s }) => `• ${esc(t.store)} · ${esc(String(t.product).slice(0, 40))} · <b>${esc(s)}</b>`), tasks.length > 40 ? `… +${tasks.length - 40} more` : ''].filter(Boolean).join('\n');
  }
  if (c.cmd === 'start' || c.cmd === 'stop') {
    const store = matchStore(c.args);
    if (c.args && !store && c.args.toLowerCase() !== 'all') return `Unknown store "${esc(c.args)}". Use target, walmart, pkc or bandai.`;
    const list = tasks.filter((t) => !store || t.store === store);
    if (!list.length) return 'No tasks for that store.';
    if (c.cmd === 'start') {
      ensureRegistered(list);
      bus.send({ type: 'START_ALL', store });
      return `Starting ${list.length} task(s)${store ? ` · ${esc(store)}` : ''}.`;
    }
    bus.send({ type: 'STOP_ALL', store });
    return `Stopping ${list.length} task(s)${store ? ` · ${esc(store)}` : ''}.`;
  }
  if (c.cmd === 'summary') {
    const now = Date.now();
    const s = summaryFor(now - 86400_000, now);
    return [
      '<b>Last 24 h</b>',
      `Restocks: ${s.restocks.length}`,
      ...s.restocks.slice(0, 5).map((r: any) => `  • ${esc(r.store)} · ${esc(r.title || r.product)}`),
      `Price changes: ${s.priceChanges.length}`,
      `Checkouts: ${s.checkouts.ok.length} ok · ${s.checkouts.failed.length} failed · spent ${money(s.checkouts.spent)}`,
      `Products watched: ${s.productsWatched}`,
    ].join('\n');
  }
  if (c.cmd === 'drops') {
    const now = Date.now();
    const list = visibleDrops(loadDrops(), now).slice(0, 10);
    if (!list.length) return 'No upcoming drops.';
    return ['<b>Upcoming drops</b>', ...list.map((d) => `• ${esc(d.store)} · ${esc(d.title)} · ${new Date(d.at).toLocaleString()} (${formatCountdown(d.at - now)})`)].join('\n');
  }
  if (c.cmd === 'health') {
    const h = getMonitorHealth();
    if (!h.length) return 'No monitor data yet.';
    return ['<b>Monitors</b>', ...h.slice(0, 15).map((m: any) => `• ${esc(m.store)} · ${esc(String(m.title || m.product).slice(0, 40))} · ${esc(m.state || '')}${m.stalled ? ' · STALLED' : ''} · ${m.total ? Math.round((m.okCount / m.total) * 100) : 0}% ok`)].join('\n');
  }
  return 'Unknown command. /help';
}

let started = false;
export function startRemoteControl({ everyMs = 3000 } = {}) {
  if (started) return () => {};
  started = true;
  let lastCfg = '';
  let stop = false;
  const syncConfig = async () => {
    const s = loadSettings() as any;
    const cfg = { enabled: Boolean(s.remoteCommandsEnabled && s.telegramToken), token: s.telegramToken || '', chatId: s.telegramChatId || '' };
    const key = JSON.stringify(cfg);
    if (key === lastCfg) return cfg.enabled;
    lastCfg = key;
    await fetch(`${API_BASE}/api/remote/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key }).catch(() => {});
    return cfg.enabled;
  };
  const tick = async () => {
    if (stop) return;
    try {
      if (await syncConfig()) {
        const r = await fetch(`${API_BASE}/api/remote/pending`).then((x) => x.json());
        for (const c of (r.commands || []) as Cmd[]) {
          let text: string;
          try {
            text = runCommand(c);
          } catch (e) {
            text = `Error: ${esc((e as Error)?.message || e)}`;
          }
          await fetch(`${API_BASE}/api/remote/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id, chatId: c.chatId, text }) }).catch(() => {});
        }
      }
    } catch {
      /* server offline */
    }
    if (!stop) setTimeout(tick, everyMs);
  };
  void tick();
  return () => {
    stop = true;
    started = false;
  };
}
