/** Local beep when stock/queue hits (browser AudioContext) */
export function playAlertSound(kind: 'stock' | 'queue' | 'success' = 'stock') {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    const now = ctx.currentTime;
    if (kind === 'queue') {
      o.frequency.value = 440;
      g.gain.setValueAtTime(0.15, now);
      g.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      o.start(now);
      o.stop(now + 0.3);
    } else if (kind === 'success') {
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.12, now);
      g.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      o.start(now);
      o.stop(now + 0.4);
    } else {
      // stock — two beeps
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.15, now);
      g.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      o.start(now);
      o.stop(now + 0.15);
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.connect(g2);
      g2.connect(ctx.destination);
      o2.frequency.value = 880;
      g2.gain.setValueAtTime(0.15, now + 0.18);
      g2.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      o2.start(now + 0.18);
      o2.stop(now + 0.35);
    }
  } catch {
    // ignore
  }
}

/**
 * Random jitter around a base delay.
 * percent = 20 → result in [base*0.8, base*1.2] (clamped).
 * minMs avoids near-zero sleeps that hammer the API.
 */
export function jitterDelay(baseMs: number, percent = 15, minMs = 100): number {
  const base = Math.max(0, Number(baseMs) || 0);
  if (base <= 0) return 0;
  const p = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
  if (p <= 0) return Math.max(minMs, Math.round(base));
  const delta = base * p;
  const low = base - delta;
  const high = base + delta;
  const picked = low + Math.random() * (high - low);
  return Math.max(minMs, Math.round(picked));
}

/** Pure random delay in [minMs, maxMs] — for desync / humanize */
export function randomDelay(minMs: number, maxMs: number): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(lo, Math.max(minMs, maxMs));
  return Math.round(lo + Math.random() * (hi - lo));
}


/**
 * Exponential backoff delay in ms.
 * attempt 0 → baseMs
 * attempt 1 → baseMs * multiplier
 * attempt 2 → baseMs * multiplier^2
 * capped at maxMs, with optional jitter
 */
export function exponentialBackoff(
  attempt: number,
  baseMs = 2000,
  multiplier = 2,
  maxMs = 60000,
  jitterPercent = 15
): number {
  const a = Math.max(0, attempt);
  const raw = Math.min(maxMs, baseMs * Math.pow(multiplier, a));
  return jitterDelay(raw, jitterPercent);
}


/** Random delay 0..maxMs — use to desync Start All / queue releases */
export function staggerDelay(maxMs = 1500): number {
  return Math.floor(Math.random() * Math.max(0, maxMs));
}

/** Spread tasks across a window so they don't stampede */
export function spreadIndex(index: number, windowMs = 2000): number {
  const base = (index * windowMs) / Math.max(1, index + 1);
  return Math.floor(base + Math.random() * (windowMs * 0.25));
}
