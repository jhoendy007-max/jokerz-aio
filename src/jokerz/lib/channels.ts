/**
 * Extra alert channels besides Discord / Slack: Telegram, browser notifications (with sound), email.
 * Each channel has its own list of alert kinds. Called from sendAlert after de-duplication.
 */
import { loadSettings } from './storage';
import { API_BASE } from '../engine/apiBase';

export type AlertKind = 'queue' | 'stock' | 'success' | 'decline' | 'info' | 'price' | 'ban';
export const ALL_KINDS: AlertKind[] = ['stock', 'success', 'decline', 'price', 'queue', 'info', 'ban'];
export const KIND_LABEL: Record<AlertKind, string> = {
  stock: 'Restock',
  success: 'Checkout OK',
  decline: 'Checkout failed',
  price: 'Price change',
  queue: 'Queue',
  info: 'Info (drops, logins, monitors)',
  ban: 'Proxy ban',
};

export interface ChannelSettings {
  telegramEnabled?: boolean;
  telegramToken?: string;
  telegramChatId?: string;
  telegramKinds?: AlertKind[];
  browserNotifyEnabled?: boolean;
  browserNotifySound?: boolean;
  browserNotifyKinds?: AlertKind[];
  emailAlertsEnabled?: boolean;
  emailAlertUser?: string;
  emailAlertPass?: string;
  emailAlertTo?: string;
  emailAlertKinds?: AlertKind[];
}

export interface ChannelPayload {
  store: string;
  product: string;
  title?: string;
  price?: string;
  status: string;
  extra?: string;
  imageUrl?: string;
  productUrl?: string;
}

const TITLES: Record<AlertKind, string> = {
  stock: 'IN STOCK',
  success: 'CHECKOUT SUCCESS',
  decline: 'CHECKOUT FAILED',
  price: 'PRICE CHANGE',
  queue: 'QUEUE',
  info: 'INFO',
  ban: 'PROXY BAN',
};

/** Pure: message parts for any channel. */
export function alertText(kind: AlertKind, d: ChannelPayload) {
  const title = `${TITLES[kind] || kind.toUpperCase()} · ${d.store}`;
  const lines = [d.title || d.product, d.price ? `Price: ${d.price}` : '', d.status && d.status !== TITLES[kind] ? `Status: ${d.status}` : '', d.extra || '', d.title && d.product ? `Product: ${d.product}` : ''].filter(Boolean);
  return { title, lines };
}

export const wants = (kinds: AlertKind[] | undefined, kind: AlertKind, fallback: AlertKind[]) => (kinds && kinds.length ? kinds : fallback).includes(kind);

let audioCtx: AudioContext | null = null;
export function beep(kind: AlertKind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = audioCtx;
    const notes = kind === 'stock' || kind === 'success' ? [880, 1175, 1568] : [440, 330];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.15 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.15 + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.15);
      o.stop(ctx.currentTime + i * 0.15 + 0.15);
    });
  } catch {
    /* no audio */
  }
}

export async function requestBrowserPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

async function post(path: string, body: unknown) {
  const r = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false }));
}

export async function sendTelegramAlert(s: ChannelSettings, kind: AlertKind, d: ChannelPayload) {
  const { title, lines } = alertText(kind, d);
  return post('/api/notify/telegram', { token: s.telegramToken, chatId: s.telegramChatId, title, lines, url: d.productUrl, imageUrl: d.imageUrl });
}

export async function sendEmailAlert(s: ChannelSettings, kind: AlertKind, d: ChannelPayload) {
  const { title, lines } = alertText(kind, d);
  return post('/api/notify/email', {
    user: s.emailAlertUser,
    pass: s.emailAlertPass,
    to: s.emailAlertTo || s.emailAlertUser,
    subject: `Jokerz AIO · ${title}`,
    text: [...lines, d.productUrl ? `Link: ${d.productUrl}` : '', '', '— Jokerz AIO'].filter((x) => x !== undefined).join('\n'),
  });
}

export function showBrowserNotification(s: ChannelSettings, kind: AlertKind, d: ChannelPayload) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const { title, lines } = alertText(kind, d);
  try {
    const n = new Notification(title, { body: lines.slice(0, 3).join('\n'), icon: d.imageUrl, tag: `${kind}:${d.store}:${d.product}` });
    if (d.productUrl) n.onclick = () => window.open(d.productUrl, '_blank');
  } catch {
    return false;
  }
  if (s.browserNotifySound !== false) beep(kind);
  return true;
}

/** Fan-out to every enabled extra channel. Never throws. */
export async function sendExtraChannels(kind: AlertKind, d: ChannelPayload) {
  const s = loadSettings() as ChannelSettings;
  const jobs: Promise<unknown>[] = [];
  const out = { telegram: false, browser: false, email: false };
  if (s.telegramEnabled && s.telegramToken && s.telegramChatId && wants(s.telegramKinds, kind, ['stock', 'success', 'decline', 'price', 'info'])) {
    jobs.push(sendTelegramAlert(s, kind, d).then((r: any) => (out.telegram = Boolean(r?.ok))).catch(() => {}));
  }
  if (s.browserNotifyEnabled && wants(s.browserNotifyKinds, kind, ['stock', 'success'])) out.browser = showBrowserNotification(s, kind, d);
  if (s.emailAlertsEnabled && s.emailAlertUser && s.emailAlertPass && wants(s.emailAlertKinds, kind, ['success'])) {
    jobs.push(sendEmailAlert(s, kind, d).then((r: any) => (out.email = Boolean(r?.ok))).catch(() => {}));
  }
  await Promise.all(jobs);
  return out;
}
