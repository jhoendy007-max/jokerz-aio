/**
 * Watchdogs (run app-wide from App.tsx):
 *  - monitors: flags a monitor as STALLED when it chains errors or has no valid
 *    response for N minutes, alerts once, and alerts again when it recovers.
 *  - sessions: polls the local API for saved account sessions and alerts once
 *    when a session is about to expire or has expired.
 */
import { getMonitorHealth, setMonitorStalled, subscribeMonitorHealth } from './monitorHealth';
import { stallCheck, sessionAlertsDue } from './monitorPolicy';
export { sessionAlertsDue };
import { loadSettings } from './storage';
import { sendAlert } from '../engine/webhooks';
import { API_BASE } from '../engine/apiBase';

type S = { monitorStallMinutes?: number; monitorStallErrors?: number; monitorStallAlerts?: boolean; sessionExpiryAlerts?: boolean };
const settings = () => loadSettings() as S;

const alerted = new Set<string>();

export function checkMonitorsOnce(now = Date.now()) {
  const s = settings();
  const opts = { stallMinutes: Math.max(1, Number(s.monitorStallMinutes) || 5), maxErrorStreak: Math.max(2, Number(s.monitorStallErrors) || 10) };
  for (const e of getMonitorHealth()) {
    const r = stallCheck(e, now, opts);
    if (r.stalled) {
      setMonitorStalled(e.key, true, r.why);
      if (!alerted.has(e.key)) {
        alerted.add(e.key);
        if (s.monitorStallAlerts !== false) {
          void sendAlert('info', {
            store: e.store,
            product: e.product,
            title: e.title,
            status: 'MONITOR_STALLED',
            extra: `Monitor stuck: ${r.why}${e.lastError ? ` · last error: ${e.lastError}` : ''}`,
          }).catch(() => {});
        }
      }
    } else if (alerted.has(e.key) && !e.stalled) {
      alerted.delete(e.key);
      if (s.monitorStallAlerts !== false) {
        void sendAlert('info', { store: e.store, product: e.product, title: e.title, status: 'MONITOR_RECOVERED', extra: 'Monitor is getting valid responses again' }).catch(() => {});
      }
    } else if (e.stalled && !r.stalled) {
      setMonitorStalled(e.key, false);
    }
  }
}

// ─── sessions ───
export interface AccountStatus {
  email: string;
  store: string;
  cookieCount: number;
  lastLoginMin?: number;
  expiresAt?: number | null;
  minutesLeft?: number | null;
  state: 'active' | 'expiring' | 'expired' | 'pending' | 'none';
  pending?: 'manual_login' | '2fa';
  /** session saved with "Log in manually" */
  manual?: boolean;
  /** last automatic login (login guard) */
  at?: number;
  ok?: boolean;
  errorCode?: string;
  friendlyError?: string;
  pausedUntil?: number;
  pausedMin?: number;
  loggingIn?: boolean;
}

const SESSION_ALERTS_KEY = 'jokerz_aio_session_alerts';
let accounts: AccountStatus[] = [];
let accountsError = '';
const accSubs = new Set<() => void>();
let accVersion = 0;
export const getAccounts = () => accounts;
export const getAccountsError = () => accountsError;
export const subscribeAccounts = (f: () => void) => {
  accSubs.add(f);
  return () => {
    accSubs.delete(f);
  };
};
export const getAccountsVersion = () => accVersion;

export async function refreshAccounts(): Promise<AccountStatus[]> {
  try {
    const r = await fetch(`${API_BASE}/api/accounts/status`);
    const j = await r.json();
    accounts = Array.isArray(j?.accounts) ? j.accounts : [];
    accountsError = '';
  } catch {
    accountsError = 'Backend offline — start with: npm run server';
  }
  accVersion++;
  accSubs.forEach((f) => f());
  return accounts;
}

async function checkSessionsOnce() {
  const list = await refreshAccounts();
  if (accountsError) return;
  let sent: Record<string, string> = {};
  try {
    sent = JSON.parse(localStorage.getItem(SESSION_ALERTS_KEY) || '{}') || {};
  } catch {
    /* */
  }
  // reset when a session is active again
  for (const a of list) if (a.state === 'active') delete sent[`${a.store}|${a.email}`];
  const due = sessionAlertsDue(list, sent);
  for (const a of due) {
    sent[`${a.store}|${a.email}`] = a.state;
    if (settings().sessionExpiryAlerts === false) continue;
    void sendAlert('info', {
      store: a.store,
      product: a.email,
      status: a.state === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_EXPIRING',
      extra:
        a.state === 'expired'
          ? `Session for ${a.email} expired — log in again (Settings → Accounts → Log in manually)`
          : `Session for ${a.email} expires in ~${a.minutesLeft ?? '?'} min`,
    }).catch(() => {});
  }
  // failed automatic logins: one alert per account + failure
  for (const a of list) {
    if (a.ok !== false || !a.at || !a.errorCode) continue;
    const k = `fail|${a.store}|${a.email}`;
    const sig = `${a.errorCode}@${a.at}`;
    if (sent[k] === sig || (sent[k] || '').startsWith(`${a.errorCode}@`)) continue;
    sent[k] = sig;
    if (settings().sessionExpiryAlerts === false) continue;
    void sendAlert('info', {
      store: a.store,
      product: a.email,
      status: 'LOGIN_FAILED',
      extra: `${a.friendlyError || a.errorCode}${a.pausedMin ? ` · automatic login paused ${a.pausedMin} min` : ''}`,
    }).catch(() => {});
  }
  for (const a of list) if (a.ok === true) delete sent[`fail|${a.store}|${a.email}`];
  try {
    localStorage.setItem(SESSION_ALERTS_KEY, JSON.stringify(sent));
  } catch {
    /* */
  }
}

export function startWatchdogs() {
  const t1 = setInterval(() => checkMonitorsOnce(), 30_000);
  const unsub = subscribeMonitorHealth(() => {
    // fast path: clear "stalled" alerts as soon as a monitor recovers
    for (const e of getMonitorHealth()) if (alerted.has(e.key) && !e.stalled) checkMonitorsOnce();
  });
  void checkSessionsOnce();
  const t2 = setInterval(() => void checkSessionsOnce(), 5 * 60_000);
  return () => {
    clearInterval(t1);
    clearInterval(t2);
    unsub();
  };
}
