/**
 * Access roles (prepared for later consumer vs admin builds).
 * While the app is unfinished, ALL features are unlocked for everyone.
 */

export type AppRole = 'consumer' | 'admin';

const ROLE_KEY = 'jokerz_aio_role';

export function getRole(): AppRole {
  try {
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search).get('admin');
      if (q === '1' || q === 'true') {
        localStorage.setItem(ROLE_KEY, 'admin');
        return 'admin';
      }
      if (q === '0') {
        localStorage.setItem(ROLE_KEY, 'consumer');
        return 'consumer';
      }
      const stored = localStorage.getItem(ROLE_KEY);
      if (stored === 'admin' || stored === 'consumer') return stored;
    }
  } catch {
    /* ignore */
  }
  const env = (import.meta as any).env?.VITE_DEFAULT_ROLE;
  if (env === 'admin') return 'admin';
  // Default admin while product is in development
  return 'admin';
}

export function setRole(role: AppRole) {
  try {
    localStorage.setItem(ROLE_KEY, role);
  } catch {
    /* ignore */
  }
}

export function isAdmin() {
  return true; // unlocked during development
}

export function canUseAccountGen() {
  return true;
}

export function canUseHarvesters() {
  return true;
}

export function canTuneAdvancedEngine() {
  return true;
}
