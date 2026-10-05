import { loadSettings } from '../lib/storage';

export type WebhookKind = 'queue' | 'stock' | 'success' | 'decline' | 'info' | 'price' | 'ban';

import { createAlertDedupe } from './alertDedupe';

const alertDedupe = createAlertDedupe();
export const getAlertDedupeStats = () => alertDedupe.stats();
export const resetAlertDedupe = () => alertDedupe.reset();

export interface WebhookPayload {
  store: string;
  product: string;
  title?: string;
  price?: string;
  status: string;
  taskId?: string;
  extra?: string;
  color?: number;
  /** Product image URL for embed thumbnail */
  imageUrl?: string;
  /** Override product page link */
  productUrl?: string;
  /** Proxy / region / queue pos etc. */
  proxy?: string;
  ms?: number;
  quantity?: number;
  /** Ban metadata */
  provider?: string;
  banMinutes?: number;
  reason?: string;
}

function pickDiscordUrl(kind: WebhookKind): string {
  const s = loadSettings() as {
    discordWebhook?: string;
    successWebhook?: string;
    declineWebhook?: string;
  };
  if (kind === 'success' || kind === 'stock' || kind === 'price') {
    return (s.successWebhook || s.discordWebhook || '').trim();
  }
  if (kind === 'decline' || kind === 'ban') {
    return (s.declineWebhook || s.discordWebhook || '').trim();
  }
  return (s.discordWebhook || '').trim();
}

function pickSlackUrl(kind: WebhookKind): string {
  const s = loadSettings() as {
    slackWebhook?: string;
    slackStockWebhook?: string;
  };
  if (kind === 'stock' || kind === 'success' || kind === 'price') {
    return (s.slackStockWebhook || s.slackWebhook || '').trim();
  }
  // ban / decline / queue → general slack
  return (s.slackWebhook || '').trim();
}

function isDiscordUrl(url: string) {
  return /discord\.com\/api\/webhooks|discordapp\.com\/api\/webhooks/i.test(url);
}

function isSlackUrl(url: string) {
  return /hooks\.slack\.com\//i.test(url);
}

const COLORS: Record<WebhookKind, number> = {
  queue: 0xf59e0b,
  stock: 0x22c55e,
  success: 0x10b981,
  decline: 0xef4444,
  info: 0x9333ea,
  price: 0x3b82f6,
  ban: 0xdc2626,
};

const TITLE: Record<WebhookKind, string> = {
  queue: 'Queue Detected',
  stock: 'Stock Detected',
  success: 'Checkout Success',
  decline: 'Checkout Failed',
  info: 'Bot Update',
  price: 'Price Change',
  ban: 'Proxy Banned',
};

const EMOJI: Record<WebhookKind, string> = {
  queue: '⏳',
  stock: '🟢',
  success: '✅',
  decline: '❌',
  info: 'ℹ️',
  price: '💰',
  ban: '🚫',
};

const SLACK_EMOJI: Record<WebhookKind, string> = {
  queue: ':hourglass_flowing_sand:',
  stock: ':large_green_circle:',
  success: ':white_check_mark:',
  decline: ':x:',
  info: ':information_source:',
  ban: ':no_entry:',
  price: ':moneybag:',
};

/** Build product page URL when possible */
export function productPageUrl(store: string, product: string): string | undefined {
  const p = (product || '').trim();
  if (!p) return undefined;
  const s = store.toLowerCase();
  if (s.includes('target')) {
    const tcin = p.replace(/\D/g, '') || p;
    return `https://www.target.com/p/-/A-${tcin}`;
  }
  if (s.includes('walmart')) {
    const id = p.replace(/\D/g, '') || p;
    return `https://www.walmart.com/ip/${id}`;
  }
  if (s.includes('pokemon')) {
    if (/^https?:\/\//i.test(p)) return p;
    return `https://www.pokemoncenter.com/product/${encodeURIComponent(p)}`;
  }
  if (s.includes('bandai')) {
    if (/^https?:\/\//i.test(p)) return p;
    return `https://www.bandai.com/search?q=${encodeURIComponent(p)}`;
  }
  if (/^https?:\/\//i.test(p)) return p;
  return undefined;
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function buildDiscordEmbed(kind: WebhookKind, data: WebhookPayload) {
  const color = data.color ?? COLORS[kind];
  const link = data.productUrl || productPageUrl(data.store, data.product);
  const displayTitle = data.title
    ? truncate(data.title, 120)
    : `${data.store} · ${truncate(data.product || '—', 80)}`;

  const descriptionParts: string[] = [];
  if (kind === 'stock') descriptionParts.push('**Item is available** — act fast.');
  if (kind === 'queue') descriptionParts.push('**Queue / waiting room** detected on product flow.');
  if (kind === 'success') descriptionParts.push('**Order placed** successfully.');
  if (kind === 'decline') descriptionParts.push('**Checkout failed** — review profile / payment / proxy.');
  if (kind === 'price') descriptionParts.push('**Price changed** on monitored product.');
  if (data.extra) descriptionParts.push(truncate(data.extra, 280));

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: '🏪 Store', value: data.store || '—', inline: true },
    { name: '📊 Status', value: `\`${data.status || kind.toUpperCase()}\``, inline: true },
  ];

  if (data.price) {
    fields.push({ name: '💵 Price', value: data.price, inline: true });
  } else {
    fields.push({ name: '💵 Price', value: '—', inline: true });
  }

  if (data.product) {
    const prodVal = link
      ? `[${truncate(data.product, 60)}](${link})`
      : `\`${truncate(data.product, 80)}\``;
    fields.push({ name: '📦 SKU / Product', value: prodVal, inline: false });
  }

  if (data.title) {
    fields.push({ name: '🏷️ Title', value: truncate(data.title, 180), inline: false });
  }

  if (data.quantity != null) {
    fields.push({ name: '🔢 Qty', value: String(data.quantity), inline: true });
  }
  if (data.ms != null) {
    fields.push({ name: '⚡ Latency', value: `${data.ms}ms`, inline: true });
  }
  if (data.proxy) {
    const proxyShort = data.proxy.includes('@') ? data.proxy.split('@').pop()! : data.proxy;
    fields.push({ name: '🌐 Proxy', value: `\`${truncate(proxyShort, 40)}\``, inline: true });
  }
  if (data.provider) {
    fields.push({ name: '🛡️ Provider', value: data.provider.toUpperCase(), inline: true });
  }
  if (data.banMinutes != null && data.banMinutes > 0) {
    fields.push({ name: '⏱️ Ban', value: `${data.banMinutes} min`, inline: true });
  }
  if (data.reason && kind === 'ban') {
    fields.push({ name: '📝 Reason', value: truncate(data.reason, 200), inline: false });
  }
  if (data.taskId) {
    fields.push({ name: '🆔 Task', value: `\`${data.taskId.slice(0, 10)}\``, inline: true });
  }

  // Pad to visual rows of 3 when useful
  while (fields.filter((f) => f.inline).length % 3 === 2) {
    fields.push({ name: '\u200b', value: '\u200b', inline: true });
  }

  const embed: Record<string, unknown> = {
    author: {
      name: `JOKERZ AIO · ${kind.toUpperCase()}`,
      icon_url: 'https://cdn.discordapp.com/embed/avatars/0.png',
    },
    title: `${EMOJI[kind]} ${TITLE[kind]}`,
    url: link || undefined,
    description: descriptionParts.length ? descriptionParts.join('\n') : undefined,
    color,
    fields: fields.slice(0, 25),
    timestamp: new Date().toISOString(),
    footer: {
      text: `JOKERZ AIO · ${data.store || 'monitor'}`,
    },
  };

  if (data.imageUrl && /^https?:\/\//i.test(data.imageUrl)) {
    embed.thumbnail = { url: data.imageUrl };
  }

  return embed;
}

/**
 * Advanced Discord embed webhook.
 */
export async function sendDiscordWebhook(
  kind: WebhookKind,
  data: WebhookPayload
): Promise<boolean> {
  const url = pickDiscordUrl(kind);
  if (!url || !isDiscordUrl(url)) return false;

  const embed = buildDiscordEmbed(kind, data);
  const content =
    kind === 'stock'
      ? '🟢 **STOCK** @here'
      : kind === 'success'
        ? '✅ **SUCCESS**'
        : kind === 'queue'
          ? '⏳ **QUEUE**'
          : undefined;

  const components = buildDiscordComponents(kind, data);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'JOKERZ AIO',
        avatar_url: 'https://cdn.discordapp.com/embed/avatars/1.png',
        content,
        allowed_mentions: { parse: kind === 'stock' ? ['everyone'] : [] },
        embeds: [embed],
        components: components.length ? components : undefined,
      }),
    });
    return res.ok || res.status === 204;
  } catch (e) {
    console.warn('[webhook:discord] failed', e);
    return false;
  }
}

/**
 * Discord message components.
 * Webhooks only support LINK buttons (style 5) — no interaction callback needed.
 * Primary/Secondary/Success/Danger buttons require a Discord Application Bot
 * with an interactions endpoint (not available from pure webhook).
 */
function buildDiscordComponents(kind: WebhookKind, data: WebhookPayload) {
  const link = data.productUrl || productPageUrl(data.store, data.product);
  const buttons: {
    type: 2;
    style: number;
    label: string;
    url?: string;
    emoji?: { name: string };
    disabled?: boolean;
  }[] = [];

  if (link && /^https?:\/\//i.test(link)) {
    buttons.push({
      type: 2,
      style: 5, // Link
      label: kind === 'stock' ? 'Open Product' : 'View Product',
      url: link,
      emoji: { name: '🛒' },
    });
  }

  // Store home shortcuts
  const store = (data.store || '').toLowerCase();
  let storeHome: string | undefined;
  if (store.includes('target')) storeHome = 'https://www.target.com/';
  else if (store.includes('walmart')) storeHome = 'https://www.walmart.com/';
  else if (store.includes('pokemon')) storeHome = 'https://www.pokemoncenter.com/';
  else if (store.includes('bandai')) storeHome = 'https://www.bandai.com/';

  if (storeHome) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'Store Home',
      url: storeHome,
      emoji: { name: '🏪' },
    });
  }

  // Optional search on Google for the SKU
  if (data.product && data.product.length < 80) {
    const q = encodeURIComponent(`${data.store} ${data.product}`);
    buttons.push({
      type: 2,
      style: 5,
      label: 'Search',
      url: `https://www.google.com/search?q=${q}`,
      emoji: { name: '🔎' },
    });
  }

  if (!buttons.length) return [];

  // Discord: max 5 buttons per action row, max 5 rows
  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    rows.push({
      type: 1, // Action Row
      components: buttons.slice(i, i + 5),
    });
  }
  return rows;
}

export async function sendSlackWebhook(
  kind: WebhookKind,
  data: WebhookPayload
): Promise<boolean> {
  const url = pickSlackUrl(kind);
  if (!url || !isSlackUrl(url)) return false;

  const link = data.productUrl || productPageUrl(data.store, data.product);
  const lines = [
    `*Store:* ${data.store}`,
    `*Status:* \`${data.status}\``,
  ];
  if (data.price) lines.push(`*Price:* ${data.price}`);
  if (data.product) {
    lines.push(
      link ? `*Product:* <${link}|${data.product}>` : `*Product:* \`${data.product}\``
    );
  }
  if (data.title) lines.push(`*Title:* ${data.title.slice(0, 150)}`);
  if (data.extra) lines.push(`*Details:* ${data.extra.slice(0, 300)}`);
  if (data.taskId) lines.push(`*Task:* \`${data.taskId.slice(0, 8)}\``);

  const color =
    kind === 'stock' || kind === 'success'
      ? '#22c55e'
      : kind === 'decline'
        ? '#ef4444'
        : kind === 'queue'
          ? '#f59e0b'
          : '#9333ea';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${SLACK_EMOJI[kind]} ${TITLE[kind]} — ${data.store}`,
        attachments: [
          {
            color,
            mrkdwn_in: ['text', 'fields'],
            title: TITLE[kind],
            title_link: link,
            text: lines.join('\n'),
            footer: 'JOKERZ AIO',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[webhook:slack] failed', e);
    return false;
  }
}

export async function sendAlert(
  kind: WebhookKind,
  data: WebhookPayload
): Promise<{ discord: boolean; slack: boolean; suppressed?: boolean }> {
  const sec = Number((loadSettings() as { alertCooldownSec?: number }).alertCooldownSec ?? 300);
  const gate = alertDedupe.check(kind, data, Date.now(), Number.isFinite(sec) ? sec * 1000 : 300_000);
  if (!gate.send) {
    console.debug(`[alerts] suppressed ${kind} ${data.store} ${data.product}: ${gate.reason}`);
    return { discord: false, slack: false, suppressed: true };
  }
  const [discord, slack] = await Promise.all([
    sendDiscordWebhook(kind, data),
    sendSlackWebhook(kind, data),
  ]);
  return { discord, slack };
}

export async function notifyStock(data: WebhookPayload) {
  return sendAlert('stock', data);
}

/** Debounce map: proxy key → last alert ts */
const lastBanAlertAt = new Map<string, number>();

/**
 * Discord/Slack alert when an IP is hard-banned (Imperva, Shape streak, etc.).
 * Debounced 2 min per proxy to avoid spam on repeated failures.
 */
/** Rank providers for severity filter (higher = more severe) */
function banProviderSeverity(provider?: string): number {
  const p = (provider || '').toLowerCase();
  if (p === 'imperva') return 4; // critical
  if (p === 'shape' || p === 'kasada' || p === 'perimeterx' || p === 'px') return 3; // high
  if (p === 'datadome' || p === 'akamai') return 2; // medium
  if (p === 'generic' || p === 'cloudflare') return 1; // low
  return 1;
}

function severityThreshold(level: string): number {
  switch ((level || '').toLowerCase()) {
    case 'off':
      return 99;
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
    default:
      return 1;
  }
}

export async function notifyProxyBan(opts: {
  proxy: string;
  provider?: string;
  reason?: string;
  banMs?: number;
  store?: string;
  taskId?: string;
  force?: boolean;
}): Promise<{ discord: boolean; slack: boolean; skipped?: boolean; filtered?: boolean }> {
  const key = (opts.proxy.includes('@') ? opts.proxy.split('@').pop() : opts.proxy) || opts.proxy;
  const provider = (opts.provider || 'unknown').toLowerCase();

  // Severity filter from Settings
  if (!opts.force) {
    try {
      const s = loadSettings() as {
        banAlertSeverity?: string;
        banAlertAlwaysProviders?: string;
      };
      const level = s.banAlertSeverity || 'high';
      if (level === 'off') {
        return { discord: false, slack: false, filtered: true };
      }
      const always = String(s.banAlertAlwaysProviders || 'imperva')
        .split(/[,\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      const rank = banProviderSeverity(provider);
      const need = severityThreshold(level);
      if (!always.includes(provider) && rank < need) {
        return { discord: false, slack: false, filtered: true };
      }
    } catch {
      /* use defaults */
    }
  }

  const now = Date.now();
  if (!opts.force && now - (lastBanAlertAt.get(key) || 0) < 120_000) {
    return { discord: false, slack: false, skipped: true };
  }
  lastBanAlertAt.set(key, now);

  const banMinutes = opts.banMs ? Math.max(1, Math.ceil(opts.banMs / 60_000)) : undefined;
  return sendAlert('ban', {
    store: opts.store || 'Proxy',
    product: key,
    title: `IP banned · ${provider}`,
    status: 'BANNED',
    proxy: opts.proxy,
    provider,
    banMinutes,
    reason: opts.reason || `Hard ban applied (${provider})`,
    taskId: opts.taskId,
    extra: banMinutes ? `Avoid this IP for ~${banMinutes}m` : undefined,
  });
}

export async function testDiscordWebhook(url?: string): Promise<{ ok: boolean; error?: string }> {
  const target = (url || pickDiscordUrl('info')).trim();
  if (!target || !isDiscordUrl(target)) {
    return { ok: false, error: 'No valid Discord webhook URL configured' };
  }
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'JOKERZ AIO',
        content: '✅ **Webhook test**',
        embeds: [
          buildDiscordEmbed('stock', {
            store: 'Target',
            product: '1012055696',
            title: 'JOKERZ AIO — interactive buttons preview',
            price: '$19.99',
            status: 'IN_STOCK',
            taskId: 'test123456',
            extra: 'Link buttons work from webhooks. Click Open Product / Store Home.',
            ms: 42,
          }),
        ],
        components: buildDiscordComponents('stock', {
          store: 'Target',
          product: '1012055696',
          status: 'IN_STOCK',
        }),
      }),
    });
    if (!res.ok && res.status !== 204) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Request failed' };
  }
}

export async function testSlackWebhook(url?: string): Promise<{ ok: boolean; error?: string }> {
  const target = (url || pickSlackUrl('stock') || pickSlackUrl('info')).trim();
  if (!target || !isSlackUrl(target)) {
    return { ok: false, error: 'No valid Slack webhook URL (hooks.slack.com/...)' };
  }
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: ':white_check_mark: *JOKERZ AIO* — Slack webhook test',
        attachments: [
          {
            color: '#22c55e',
            text: 'If you see this, Slack stock alerts are working.',
            footer: 'JOKERZ AIO',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Request failed' };
  }
}
