import { StoredTaskLog, loadTaskLogs } from '../lib/storage';

export type CollapseSeverity = 'ok' | 'warn' | 'critical';

export interface CollapseFinding {
  severity: CollapseSeverity;
  code: string;
  title: string;
  detail: string;
  count?: number;
  windowMs?: number;
}

export interface CollapseReport {
  analyzed: number;
  windowMs: number;
  severity: CollapseSeverity;
  findings: CollapseFinding[];
  bursts: { start: number; end: number; count: number }[];
  errorRate: number;
  startsPerSecondPeak: number;
  recommendations: string[];
}

const START_RE = /Started \(|Stagger start|Slot free — starting/i;
const ERROR_RE = /error|fail|timeout|blocked|429|rate.?limit|ban|ECONN|Backend offline/i;
const BACKOFF_RE = /Backoff \d+ms/i;

/**
 * Analyze recent task logs for thundering-herd / collapse patterns.
 */
export function analyzeCollapseLogs(
  logs?: StoredTaskLog[],
  opts: { windowMs?: number; burstThreshold?: number } = {}
): CollapseReport {
  const windowMs = opts.windowMs ?? 60_000;
  const burstThreshold = opts.burstThreshold ?? 5;
  const all = (logs && logs.length ? logs : loadTaskLogs()).slice().sort((a, b) => a.ts - b.ts);
  const now = all.length ? all[all.length - 1].ts : Date.now();
  const recent = all.filter((l) => l.ts >= now - windowMs);

  const findings: CollapseFinding[] = [];
  const recommendations: string[] = [];

  // ── Start bursts: many starts in a short slice ──
  const starts = recent.filter((l) => START_RE.test(l.message));
  const bursts: { start: number; end: number; count: number }[] = [];
  let peak = 0;

  // sliding 1s buckets
  const bucketMs = 1000;
  const buckets = new Map<number, number>();
  for (const s of starts) {
    const b = Math.floor(s.ts / bucketMs) * bucketMs;
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  for (const [ts, count] of buckets) {
    if (count > peak) peak = count;
    if (count >= burstThreshold) {
      bursts.push({ start: ts, end: ts + bucketMs, count });
    }
  }

  if (peak >= burstThreshold) {
    findings.push({
      severity: peak >= burstThreshold * 2 ? 'critical' : 'warn',
      code: 'START_BURST',
      title: 'Start stampede detected',
      detail: `Peak ${peak} task starts in 1s (${bursts.length} burst window(s)). Likely synchronized Start All or queue release.`,
      count: peak,
      windowMs: 1000,
    });
    recommendations.push('Increase Start Stagger (ms) in Settings (try 3000–5000).');
    recommendations.push('Lower Max Concurrent Tasks so fewer slots free at once.');
  }

  // ── Error storm ──
  const errors = recent.filter((l) => l.level === 'error' || ERROR_RE.test(l.message));
  const errorRate = recent.length ? errors.length / recent.length : 0;

  // errors clustered in 2s windows
  let errorBurstPeak = 0;
  const errBuckets = new Map<number, number>();
  for (const e of errors) {
    const b = Math.floor(e.ts / 2000) * 2000;
    errBuckets.set(b, (errBuckets.get(b) || 0) + 1);
  }
  for (const c of errBuckets.values()) {
    if (c > errorBurstPeak) errorBurstPeak = c;
  }

  if (errorRate >= 0.35 && errors.length >= 5) {
    findings.push({
      severity: errorRate >= 0.55 ? 'critical' : 'warn',
      code: 'ERROR_RATE',
      title: 'High error rate',
      detail: `${Math.round(errorRate * 100)}% of logs are errors (${errors.length}/${recent.length}) in last ${Math.round(windowMs / 1000)}s.`,
      count: errors.length,
      windowMs,
    });
    recommendations.push('Raise Error Delay / Max Retries and check proxies (blocked / 429).');
  }

  if (errorBurstPeak >= 4) {
    findings.push({
      severity: errorBurstPeak >= 8 ? 'critical' : 'warn',
      code: 'ERROR_BURST',
      title: 'Error burst (possible rate-limit)',
      detail: `${errorBurstPeak} errors within 2s — classic sign of collapse after synchronized requests.`,
      count: errorBurstPeak,
      windowMs: 2000,
    });
    recommendations.push('Increase Jitter Percent (25–40%) so monitors desync.');
    recommendations.push('Use more proxies / rotate groups; avoid same IP on all tasks.');
  }

  // ── Same-ms duplicate messages ──
  const byMs = new Map<number, number>();
  for (const l of recent) {
    byMs.set(l.ts, (byMs.get(l.ts) || 0) + 1);
  }
  let sameMsPeak = 0;
  for (const c of byMs.values()) {
    if (c > sameMsPeak) sameMsPeak = c;
  }
  if (sameMsPeak >= 6) {
    findings.push({
      severity: 'warn',
      code: 'SYNC_LOGS',
      title: 'Synchronized log lines',
      detail: `${sameMsPeak} log events share the exact same timestamp — tasks are still highly synchronized.`,
      count: sameMsPeak,
    });
    recommendations.push('Enable stronger stagger on queue releases; avoid starting all monitors on the same delay.');
  }

  // ── Backoff activity ──
  const backoffs = recent.filter((l) => BACKOFF_RE.test(l.message));
  if (backoffs.length >= 8) {
    findings.push({
      severity: 'warn',
      code: 'BACKOFF_HEAVY',
      title: 'Heavy exponential backoff',
      detail: `${backoffs.length} backoff events — monitors are failing repeatedly and slowing down.`,
      count: backoffs.length,
    });
    recommendations.push('Inspect proxy health and target site blocks; backoff is working but root cause remains.');
  }

  // ── Blocked signals ──
  const blocked = recent.filter((l) => /blocked|challenge|captcha|shape ban|429/i.test(l.message));
  if (blocked.length >= 3) {
    findings.push({
      severity: 'critical',
      code: 'BLOCKED',
      title: 'Block / challenge signals',
      detail: `${blocked.length} logs mention block, captcha, challenge or 429.`,
      count: blocked.length,
    });
    recommendations.push('Switch to residential/ISP proxies; reduce concurrency hard.');
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'ok',
      code: 'OK',
      title: 'No collapse pattern detected',
      detail: `Analyzed ${recent.length} logs in the last ${Math.round(windowMs / 1000)}s. Starts look distributed.`,
    });
  }

  // unique recommendations
  const recs = [...new Set(recommendations)];
  const severity: CollapseSeverity = findings.some((f) => f.severity === 'critical')
    ? 'critical'
    : findings.some((f) => f.severity === 'warn')
      ? 'warn'
      : 'ok';

  return {
    analyzed: recent.length,
    windowMs,
    severity,
    findings,
    bursts,
    errorRate,
    startsPerSecondPeak: peak,
    recommendations: recs,
  };
}

export function formatCollapseReport(report: CollapseReport): string {
  const lines: string[] = [
    `Collapse analysis · ${report.analyzed} logs · ${Math.round(report.windowMs / 1000)}s window · severity=${report.severity}`,
    `Peak starts/sec: ${report.startsPerSecondPeak} · error rate: ${Math.round(report.errorRate * 100)}%`,
    '',
  ];
  for (const f of report.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.title}`);
    lines.push(`  ${f.detail}`);
  }
  if (report.recommendations.length) {
    lines.push('', 'Recommendations:');
    report.recommendations.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
  }
  return lines.join('\n');
}
