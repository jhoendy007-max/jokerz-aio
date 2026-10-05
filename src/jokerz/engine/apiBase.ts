/** Same-origin AIO API on the Grok preview (Vite middleware). Never 127.0.0.1 — that's the user's PC, not this sandbox. */
export const API_BASE = String(
  (import.meta as any).env?.VITE_API_URL || "/jokerz-api",
).replace(/\/$/, "");
