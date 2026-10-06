/** Pure: account health from login history + checkout log. */
export interface LoginEvent {
  t: number;
  store: string; // target | walmart | …
  email: string;
  ok: boolean;
  manual?: boolean;
  errorCode?: string;
  friendlyError?: string;
}
export interface CheckoutEv {
  t: number;
  ok: boolean;
  store: string;
  account?: string;
  dryRun?: boolean;
}
export interface AccountHealth {
  email: string;
  store: string;
  logins: number;
  loginFails: number;
  lastLoginOkAt?: number;
  lastFailAt?: number;
  lastFail?: string;
  lastFailCode?: string;
  checkouts: number;
  checkoutFails: number;
  lastUsedAt?: number;
  warnings: string[];
  score: 'good' | 'watch' | 'bad';
}

const sk = (s: string) => {
  const v = String(s || '').toLowerCase();
  return v.includes('target') ? 'target' : v.includes('walmart') ? 'walmart' : v.includes('pokemon') ? 'pokemon' : v.includes('bandai') ? 'bandai' : v;
};

export function buildAccountHealth(
  accounts: { email: string; store: string; hasPassword?: boolean }[],
  logins: LoginEvent[],
  checkouts: CheckoutEv[],
  { now = Date.now(), unusedDays = 30 } = {},
): AccountHealth[] {
  return accounts.map((a) => {
    const email = a.email.trim().toLowerCase();
    const s = sk(a.store);
    const L = logins.filter((e) => e.email === email && sk(e.store) === s).sort((x, y) => x.t - y.t);
    const C = checkouts.filter((e) => !e.dryRun && String(e.account || '').toLowerCase() === email && sk(e.store) === s);
    const oks = L.filter((e) => e.ok);
    const fails = L.filter((e) => !e.ok);
    const lastOk = oks.at(-1);
    const lastFail = fails.at(-1);
    const lastUsedAt = Math.max(lastOk?.t || 0, ...C.map((c) => c.t), 0) || undefined;
    const warnings: string[] = [];
    const failAfterOk = lastFail && (!lastOk || lastFail.t > lastOk.t);
    if (failAfterOk && lastFail.errorCode === 'WRONG_PASSWORD') warnings.push('Password is probably out of date — update it in Settings → Accounts');
    if (failAfterOk && lastFail.errorCode === 'ACCOUNT_LOCKED') warnings.push("Account locked — fix it on the store's website");
    if (failAfterOk && lastFail.errorCode === 'NEEDS_2FA') warnings.push('Store asks for a 2FA code — add the TOTP secret or use Log in manually');
    if (failAfterOk && lastFail.errorCode === 'BLOCKED') warnings.push('Login blocked by the store — use Log in manually');
    const recentFails = fails.filter((e) => now - e.t < 7 * 86400_000).length;
    if (recentFails >= 3 && !warnings.length) warnings.push(`${recentFails} failed logins in the last 7 days`);
    if (!lastUsedAt) warnings.push('Never used by a task yet');
    else if (now - lastUsedAt > unusedDays * 86400_000) warnings.push(`Not used in ${Math.floor((now - lastUsedAt) / 86400_000)} days`);
    if (a.hasPassword === false) warnings.push('No password saved (works only with a manual session)');
    const bad = warnings.some((w) => /out of date|locked|blocked/i.test(w));
    return {
      email,
      store: a.store,
      logins: L.length,
      loginFails: fails.length,
      lastLoginOkAt: lastOk?.t,
      lastFailAt: lastFail?.t,
      lastFail: lastFail?.friendlyError,
      lastFailCode: lastFail?.errorCode,
      checkouts: C.filter((c) => c.ok).length,
      checkoutFails: C.filter((c) => !c.ok).length,
      lastUsedAt,
      warnings,
      score: bad ? 'bad' : warnings.length ? 'watch' : 'good',
    };
  });
}
