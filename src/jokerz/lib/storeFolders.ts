/** Four store folders — accounts, harvest, and engine all use these keys. */
export const STORE_FOLDERS = [
  { id: 'Target', short: 'Target', harvest: ['target-shape', 'target-shape-login', 'shape-login', 'target'] },
  { id: 'Walmart', short: 'Walmart', harvest: ['walmart'] },
  { id: 'Pokemon Center', short: 'PKC', harvest: ['pokemon', 'pkc'] },
  { id: 'Bandai Collectables', short: 'Bandai', harvest: ['bandai'] },
] as const;

export type StoreFolderId = (typeof STORE_FOLDERS)[number]['id'];

export function canonicalStore(raw?: string): StoreFolderId {
  const m = String(raw || '').toLowerCase();
  if (m.includes('walmart')) return 'Walmart';
  if (m.includes('pokemon') || m.includes('pkc')) return 'Pokemon Center';
  if (m.includes('bandai')) return 'Bandai Collectables';
  return 'Target';
}

export function harvestFolder(module?: string): StoreFolderId {
  const m = String(module || '').toLowerCase();
  if (m.includes('walmart')) return 'Walmart';
  if (m.includes('pokemon') || m.includes('pkc')) return 'Pokemon Center';
  if (m.includes('bandai')) return 'Bandai Collectables';
  return 'Target';
}

export function emptyAccounts(): Record<StoreFolderId, { email: string; pass: string; totp?: string; proxy?: string; proxyGroupId?: string }[]> {
  return {
    Target: [],
    Walmart: [],
    'Pokemon Center': [],
    'Bandai Collectables': [],
  };
}

export function normalizeAccounts(raw: Record<string, any> | undefined) {
  const out = emptyAccounts();
  for (const [k, v] of Object.entries(raw || {})) {
    const id = canonicalStore(k);
    if (Array.isArray(v)) out[id] = [...out[id], ...v];
  }
  return out;
}

export function accountsForStore(
  settings: { accounts?: Record<string, any[]> } | null | undefined,
  store: string
) {
  const id = canonicalStore(store);
  const acc = settings?.accounts || {};
  return (acc[id] || acc[store] || acc[String(store).toLowerCase()] || []) as {
    email: string;
    pass: string;
    totp?: string;
    proxy?: string;
    proxyGroupId?: string;
  }[];
}
