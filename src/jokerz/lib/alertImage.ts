/** Pure helpers for product photos in alerts (no imports → unit-testable). */
export type AlertImageStyle = 'large' | 'thumbnail' | 'off';

/** https-only, no quotes/spaces; protocol-relative / http → https */
export function safeImageUrl(u: unknown): string | undefined {
  let s = String(u ?? '').trim();
  if (!s) return undefined;
  if (s.startsWith('//')) s = 'https:' + s;
  if (s.startsWith('http://')) s = 'https://' + s.slice(7);
  return /^https:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 1000 ? s : undefined;
}

export function normalizeStyle(v: unknown): AlertImageStyle {
  return v === 'thumbnail' || v === 'off' ? v : 'large';
}

const BIG = new Set(['stock', 'success', 'price', 'info']);

/** Where the photo goes in a Discord embed: `image` (big), `thumbnail` (small) or nowhere. */
export function discordImagePlacement(kind: string, style: AlertImageStyle, url: unknown): { image?: { url: string }; thumbnail?: { url: string } } {
  const u = safeImageUrl(url);
  if (!u || style === 'off') return {};
  return style === 'large' && BIG.has(kind) ? { image: { url: u } } : { thumbnail: { url: u } };
}

/** Slack attachment fields for the photo. */
export function slackImageFields(style: AlertImageStyle, url: unknown): { image_url?: string; thumb_url?: string } {
  const u = safeImageUrl(url);
  if (!u || style === 'off') return {};
  return style === 'large' ? { image_url: u } : { thumb_url: u };
}
