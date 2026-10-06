import { loadProfiles, loadSettings } from './storage';
import { accountsForStore, canonicalStore, STORE_FOLDERS, type StoreFolderId } from './storeFolders';
import { inspectTotp } from './totp';

export type AccountCheckStatus = 'ok' | 'warn' | 'fail';

export interface AccountCheck {
  store: string;
  email: string;
  index: number;
  status: AccountCheckStatus;
  issues: string[];
  linkedProfiles: string[];
  liveOk?: boolean;
  liveMessage?: string;
  liveSkipped?: boolean;
}

export interface ProfileAccountGap {
  profileName: string;
  group: string;
  email: string;
  storeHint: string;
  issue: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loginPath(store: StoreFolderId): string | null {
  if (store === 'Target') return '/api/target/login';
  if (store === 'Walmart') return '/api/walmart/login';
  return null;
}

export async function liveTestStoreAccount(
  store: string,
  email: string,
  password: string,
  apiBase = '',
  totp?: string
): Promise<{ ok: boolean; message: string; skipped?: boolean }> {
  const id = canonicalStore(store);
  const path = loginPath(id);
  if (!path) {
    return { ok: true, skipped: true, message: `${id} is guest — no password login to test` };
  }
  try {
    const r = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        pass: password,
        totp: totp,
        totpSecret: totp,
        sessionId: `validate-${id}-${Date.now()}`,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      return {
        ok: true,
        message: `Login OK · ${d.cookieCount ?? (d.cookies || []).length ?? '?'} ck · ${d.ms || '?'}ms`,
      };
    }
    return { ok: false, message: d.friendlyError || d.message || d.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) };
  }
}

/** @deprecated use liveTestStoreAccount */
export async function liveTestTargetAccount(email: string, password: string, apiBase = '') {
  return liveTestStoreAccount('Target', email, password, apiBase);
}

export function validateAccountsLocal(opts?: { store?: string }): {
  accounts: AccountCheck[];
  gaps: ProfileAccountGap[];
} {
  const settings = loadSettings();
  const profiles = loadProfiles([]);
  const accountsOut: AccountCheck[] = [];
  const stores: StoreFolderId[] = opts?.store
    ? [canonicalStore(opts.store)]
    : STORE_FOLDERS.map((f) => f.id);

  for (const store of stores) {
    const list = accountsForStore(settings, store);
    const seen = new Map<string, number>();
    list.forEach((acc: any, index: number) => {
      const email = String(acc?.email || '').trim();
      const pass = String(acc?.pass || acc?.password || '').trim();
      const issues: string[] = [];
      let status: AccountCheckStatus = 'ok';

      if (!email) {
        issues.push('Missing email');
        status = 'fail';
      } else if (!EMAIL_RE.test(email)) {
        issues.push('Invalid email format');
        status = 'fail';
      }
      if (!pass) {
        issues.push('Missing password');
        status = 'fail';
      } else if (pass.length < 4) {
        issues.push('Password too short');
        if (status === 'ok') status = 'warn';
      }
      if (store === 'Target') {
        const totp = String(acc?.totp || acc?.totpSecret || '').trim();
        if (!totp) {
          issues.push('No TOTP secret');
          if (status === 'ok') status = 'warn';
        } else {
          const t = inspectTotp(totp);
          if (!t.ok) {
            issues.push(`TOTP invalid (${t.reason})`);
            status = 'fail';
          }
        }
      }

      const key = email.toLowerCase();
      if (email && seen.has(key)) {
        issues.push(`Duplicate of row #${(seen.get(key) || 0) + 1}`);
        if (status === 'ok') status = 'warn';
      } else if (email) {
        seen.set(key, index);
      }

      const linkedProfiles = profiles
        .filter((p) => p.email && String(p.email).trim().toLowerCase() === key)
        .map((p) => p.name || p.id);

      if (email && linkedProfiles.length === 0 && (store === 'Target' || store === 'Walmart')) {
        issues.push('No profile uses this email');
        if (status === 'ok') status = 'warn';
      }

      accountsOut.push({
        store,
        email: email || `(row ${index + 1})`,
        index,
        status,
        issues,
        linkedProfiles,
      });
    });
  }

  const gaps: ProfileAccountGap[] = [];
  const folderEmails = new Set(
    accountsOut.map((a) => a.email.trim().toLowerCase()).filter((e) => e.includes('@'))
  );
  const hint = opts?.store ? canonicalStore(opts.store) : 'any';
  for (const p of profiles) {
    const email = String(p.email || '').trim();
    if (!email) {
      gaps.push({
        profileName: p.name || p.id,
        group: p.group || 'Personal',
        email: '',
        storeHint: hint,
        issue: 'Profile has no email',
      });
      continue;
    }
    if (opts?.store && !folderEmails.has(email.toLowerCase())) {
      gaps.push({
        profileName: p.name || p.id,
        group: p.group || 'Personal',
        email,
        storeHint: hint,
        issue: `No ${hint} account for this email`,
      });
    }
  }

  return { accounts: accountsOut, gaps };
}

export async function validateAccountsAuto(opts?: {
  live?: boolean;
  store?: string;
  apiBase?: string;
  onProgress?: (msg: string) => void;
}): Promise<{ accounts: AccountCheck[]; gaps: ProfileAccountGap[] }> {
  const local = validateAccountsLocal({ store: opts?.store });
  if (!opts?.live) return local;

  const apiBase = opts.apiBase || '';
  const settings = loadSettings();
  for (const check of local.accounts) {
    if (check.status === 'fail') continue;
    const list = accountsForStore(settings, check.store);
    const acc = list[check.index];
    if (!acc?.pass && !(acc as any)?.password) continue;
    opts.onProgress?.(`${check.store} · ${check.email}…`);
    const live = await liveTestStoreAccount(
      check.store,
      check.email,
      String(acc.pass || (acc as any).password),
      apiBase,
      String((acc as any).totp || (acc as any).totpSecret || '')
    );
    check.liveOk = live.ok;
    check.liveMessage = live.message;
    check.liveSkipped = live.skipped;
    if (live.skipped) {
      check.issues.push(live.message);
      if (check.status === 'ok') check.status = 'warn';
    } else if (!live.ok) {
      check.status = 'fail';
      check.issues.push(`Live login: ${live.message}`);
    }
  }
  return local;
}
