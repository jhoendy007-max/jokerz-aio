/** Sends task logs + engine errors to the server log file (logs/jokerz-YYYY-MM-DD.log), batched every 3 s. */
import { API_BASE } from '../engine/apiBase';
import { bus } from '../engine';
import { loadTasks } from './storage';

type Entry = { t: number; level: string; source: string; msg: string };
let buf: Entry[] = [];

export function queueLog(level: string, source: string, msg: string) {
  buf.push({ t: Date.now(), level, source, msg: String(msg).slice(0, 2000) });
  if (buf.length > 2000) buf = buf.slice(-2000);
}

export function startLogForwarder({ everyMs = 3000 } = {}) {
  const names = new Map<string, string>();
  const label = (id: string) => {
    if (!names.has(id)) {
      const t = loadTasks([]).find((x) => x.id === id);
      names.set(id, t ? `${t.store} ${String(t.product).slice(0, 30)}` : id);
    }
    return names.get(id)!;
  };
  const unsub = bus.onEvent((e: any) => {
    if (e.type === 'TASK_LOG') queueLog(e.level === 'success' ? 'info' : e.level, 'task', `[${label(e.taskId)}] ${e.message}`);
    else if (e.type === 'CHECKOUT_SUCCESS') queueLog('info', 'checkout', `SUCCESS ${e.data?.store || ''} ${e.data?.product || ''} order ${e.data?.orderNumber || '-'}${e.data?.dryRun ? ' (dry run)' : ''}`);
    else if (e.type === 'CHECKOUT_FAILED') queueLog('warn', 'checkout', `FAILED [${label(e.taskId)}] ${e.reason || ''}`);
    else if (e.type === 'ENGINE_ERROR') queueLog('error', 'engine', e.message);
  });
  const onErr = (ev: ErrorEvent) => queueLog('error', 'ui', `${ev.message} @ ${ev.filename}:${ev.lineno}`);
  const onRej = (ev: PromiseRejectionEvent) => queueLog('error', 'ui', `Unhandled: ${(ev.reason as Error)?.message || ev.reason}`);
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onRej);
  const flush = async () => {
    if (!buf.length) return;
    const entries = buf.splice(0, 500);
    try {
      const r = await fetch(`${API_BASE}/api/logs/client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      buf = entries.concat(buf).slice(-2000); // retry later
    }
  };
  const t = setInterval(flush, everyMs);
  return () => {
    clearInterval(t);
    unsub();
    window.removeEventListener('error', onErr);
    window.removeEventListener('unhandledrejection', onRej);
  };
}
