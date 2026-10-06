/**
 * Runs the daily summary while the app is open: checks every minute, sends to
 * Discord once per day at the configured time (catch-up if the app was closed).
 */
import { loadSettings } from './storage';
import { loadHistory } from './monitorHistory';
import {
  buildSummary,
  loadCheckoutLog,
  summaryToDiscord,
  dueSummary,
  isEmpty,
  LAST_SUMMARY_KEY,
  lastSlotDay,
  type Summary,
} from './dailySummary';

type S = {
  dailySummaryEnabled?: boolean;
  dailySummaryTime?: string;
  dailySummaryWebhook?: string;
  dailySummarySkipEmpty?: boolean;
  discordWebhook?: string;
};

function webhookUrl(s: S) {
  const u = (s.dailySummaryWebhook || s.discordWebhook || '').trim();
  return /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(u) ? u : '';
}

export function summaryFor(from: number, to: number): Summary {
  return buildSummary(loadHistory() as any, loadCheckoutLog(), from, to);
}

export async function postSummary(s: Summary, label?: string): Promise<{ ok: boolean; error?: string }> {
  const url = webhookUrl(loadSettings() as S);
  if (!url) return { ok: false, error: 'No Discord webhook set (Settings → Discord Webhooks)' };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summaryToDiscord(s, { label })) });
    return r.ok ? { ok: true } : { ok: false, error: `Discord answered ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Network error' };
  }
}

/** "Send now" button: last 24 h. */
export async function sendSummaryNow() {
  const to = Date.now();
  return postSummary(summaryFor(to - 86400_000, to), 'last 24 h');
}

let sending = false;
async function tick() {
  const s = loadSettings() as S;
  if (!s.dailySummaryEnabled || sending) return;
  const last = localStorage.getItem(LAST_SUMMARY_KEY);
  const due = dueSummary(s.dailySummaryTime || '21:00', last);
  if (!due) {
    // first run long after the slot: mark it as handled so the next one is sent on time
    if (!last) localStorage.setItem(LAST_SUMMARY_KEY, lastSlotDay(s.dailySummaryTime || '21:00'));
    return;
  }
  sending = true;
  try {
    const sum = summaryFor(due.from, due.to);
    if (s.dailySummarySkipEmpty && isEmpty(sum)) {
      localStorage.setItem(LAST_SUMMARY_KEY, due.day);
      return;
    }
    const r = await postSummary(sum);
    if (r.ok) localStorage.setItem(LAST_SUMMARY_KEY, due.day);
  } finally {
    sending = false;
  }
}

export function startDailySummary(everyMs = 60_000) {
  void tick();
  const t = setInterval(() => void tick(), everyMs);
  return () => clearInterval(t);
}
