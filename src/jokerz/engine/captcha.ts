
import { loadSettings } from '../lib/storage';
import { captchaKindForSolver, detectCaptcha, type CaptchaDetectResult } from './captchaDetect';

export type CaptchaKind =
  | 'RecaptchaV2'
  | 'RecaptchaV3'
  | 'HCaptcha'
  | 'Turnstile'
  | 'FunCaptcha'
  | 'DataDome';

export interface SolveCaptchaOpts {
  kind: CaptchaKind;
  websiteURL: string;
  websiteKey: string;
  /** reCAPTCHA v3 action */
  pageAction?: string;
  isInvisible?: boolean;
  /** poll timeout ms */
  timeoutMs?: number;
  userAgent?: string;
  proxy?: string;
  datadomeCookie?: string;
}

function normalizeHost(host: string) {
  let h = (host || '').trim().replace(/\/$/, '');
  if (!h) h = 'http://127.0.0.1:80';
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  return h;
}

function capMonsterTask(opts: SolveCaptchaOpts): Record<string, unknown> {
  if (opts.kind === 'RecaptchaV2') {
    return {
      type: 'NoCaptchaTaskProxyless',
      websiteURL: opts.websiteURL,
      websiteKey: opts.websiteKey,
    };
  }
  if (opts.kind === 'RecaptchaV3') {
    return {
      type: 'RecaptchaV3TaskProxyless',
      websiteURL: opts.websiteURL,
      websiteKey: opts.websiteKey,
      minScore: 0.7,
      pageAction: opts.pageAction || 'verify',
    };
  }
  if (opts.kind === 'HCaptcha') {
    return {
      type: 'HCaptchaTaskProxyless',
      websiteURL: opts.websiteURL,
      websiteKey: opts.websiteKey,
    };
  }
  if (opts.kind === 'Turnstile') {
    return {
      type: 'TurnstileTaskProxyless',
      websiteURL: opts.websiteURL,
      websiteKey: opts.websiteKey,
    };
  }
  if (opts.kind === 'FunCaptcha') {
    return {
      type: 'FunCaptchaTaskProxyless',
      websiteURL: opts.websiteURL,
      websitePublicKey: opts.websiteKey,
    };
  }
  return {
    type: 'DataDomeSliderTask',
    websiteURL: opts.websiteURL,
    captchaUrl: opts.websiteURL,
    userAgent: opts.userAgent || '',
    proxy: opts.proxy || '',
  };
}

/**
 * CapMonster Cloud + local (same API shape).
 * Local default: http://127.0.0.1:80  (or the port shown in CapMonster UI)
 * createTask → getTaskResult loop
 */
export async function solveWithCapMonster(opts: SolveCaptchaOpts): Promise<{
  ok: boolean;
  token?: string;
  error?: string;
  taskId?: number;
}> {
  const s = loadSettings() as {
    capmonsterKey?: string;
    capmonsterHost?: string;
  };
  const clientKey = (s.capmonsterKey || '').trim();
  if (!clientKey) {
    return { ok: false, error: 'CapMonster key empty — Settings → Captchas' };
  }
  const base = normalizeHost(s.capmonsterHost || 'http://127.0.0.1:80');
  const task = capMonsterTask(opts);

  try {
    const createRes = await fetch(`${base}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, task }),
    });
    const created = await createRes.json();
    if (created.errorId && created.errorId !== 0) {
      return {
        ok: false,
        error: created.errorDescription || created.errorCode || `createTask errorId ${created.errorId}`,
      };
    }
    const taskId = created.taskId;
    if (taskId == null) {
      return { ok: false, error: 'No taskId from CapMonster' };
    }

    const timeout = opts.timeoutMs ?? 180_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetch(`${base}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey, taskId }),
      });
      const poll = await pollRes.json();
      if (poll.errorId && poll.errorId !== 0) {
        return {
          ok: false,
          error: poll.errorDescription || poll.errorCode || 'getTaskResult error',
          taskId,
        };
      }
      if (poll.status === 'ready') {
        const token =
          poll.solution?.gRecaptchaResponse ||
          poll.solution?.token ||
          poll.solution?.cookie ||
          poll.solution?.gRecaptchaResponseToken;
        if (!token) return { ok: false, error: 'Empty solution token', taskId };
        return { ok: true, token, taskId };
      }
    }
    return { ok: false, error: 'CapMonster timeout waiting for solution', taskId };
  } catch (e: any) {
    return {
      ok: false,
      error:
        e?.message ||
        `Cannot reach CapMonster at ${base} — is the local app running?`,
    };
  }
}

/** Balance / ping CapMonster (cloud or local) */
export async function testCapMonster(): Promise<{ ok: boolean; balance?: number; error?: string; host?: string }> {
  const s = loadSettings() as { capmonsterKey?: string; capmonsterHost?: string };
  const clientKey = (s.capmonsterKey || '').trim();
  const base = normalizeHost(s.capmonsterHost || 'http://127.0.0.1:80');
  if (!clientKey) return { ok: false, error: 'No CapMonster key', host: base };
  try {
    const res = await fetch(`${base}/getBalance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey }),
    });
    const data = await res.json();
    if (data.errorId && data.errorId !== 0) {
      return {
        ok: false,
        error: data.errorDescription || data.errorCode || 'getBalance failed',
        host: base,
      };
    }
    return { ok: true, balance: data.balance, host: base };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || `Cannot connect to ${base}`,
      host: base,
    };
  }
}

/**
 * 2Captcha / RuCaptcha API (cloud).
 */
export async function solveWith2Captcha(opts: SolveCaptchaOpts): Promise<{
  ok: boolean;
  token?: string;
  error?: string;
  requestId?: string;
}> {
  const s = loadSettings() as { twocaptchaKey?: string; twocaptchaHost?: string };
  const key = (s.twocaptchaKey || '').trim();
  if (!key) return { ok: false, error: '2Captcha key empty — Settings → Captchas' };
  let base = (s.twocaptchaHost || 'https://2captcha.com').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;

  const method =
    opts.kind === 'HCaptcha'
      ? 'hcaptcha'
      : opts.kind === 'Turnstile'
        ? 'turnstile'
        : opts.kind === 'FunCaptcha'
          ? 'funcaptcha'
          : opts.kind === 'DataDome'
            ? 'datadome'
            : opts.kind === 'RecaptchaV3'
              ? 'userrecaptcha'
              : 'userrecaptcha';

  const params = new URLSearchParams({
    key,
    method,
    googlekey: opts.websiteKey,
    pageurl: opts.websiteURL,
    json: '1',
  });
  if (opts.kind === 'RecaptchaV3') {
    params.set('version', 'v3');
    params.set('action', opts.pageAction || 'verify');
    params.set('min_score', '0.7');
  }
  if (opts.kind === 'HCaptcha') {
    params.set('method', 'hcaptcha');
    params.set('sitekey', opts.websiteKey);
  }
  if (opts.kind === 'Turnstile') {
    params.set('method', 'turnstile');
    params.set('sitekey', opts.websiteKey);
  }

  try {
    const inRes = await fetch(`${base}/in.php?${params.toString()}`);
    const created = await inRes.json();
    if (created.status !== 1) {
      return { ok: false, error: created.request || '2Captcha in.php failed' };
    }
    const requestId = String(created.request);
    const timeout = opts.timeoutMs ?? 180_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetch(
        `${base}/res.php?key=${encodeURIComponent(key)}&action=get&id=${requestId}&json=1`
      );
      const data = await poll.json();
      if (data.status === 1) return { ok: true, token: data.request, requestId };
      if (data.request && data.request !== 'CAPCHA_NOT_READY') {
        return { ok: false, error: data.request, requestId };
      }
    }
    return { ok: false, error: '2Captcha timeout', requestId };
  } catch (e: any) {
    return { ok: false, error: e?.message || '2Captcha network error' };
  }
}

export async function test2Captcha(): Promise<{
  ok: boolean;
  balance?: number;
  error?: string;
  host?: string;
}> {
  const s = loadSettings() as { twocaptchaKey?: string; twocaptchaHost?: string };
  const key = (s.twocaptchaKey || '').trim();
  let base = (s.twocaptchaHost || 'https://2captcha.com').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  if (!key) return { ok: false, error: 'No 2Captcha key', host: base };
  try {
    const r = await fetch(`${base}/res.php?key=${encodeURIComponent(key)}&action=getbalance&json=1`);
    const data = await r.json();
    if (data.status === 1) return { ok: true, balance: Number(data.request), host: base };
    return { ok: false, error: data.request || 'balance fail', host: base };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'network', host: base };
  }
}

export async function detectAndSolve(input: {
  html?: string;
  url: string;
  cookies?: string;
  headers?: Record<string, string>;
  proxy?: string;
}): Promise<{
  detect: CaptchaDetectResult;
  solved: boolean;
  token?: string;
  error?: string;
}> {
  const detect = detectCaptcha(input);
  if (!detect.detected) return { detect, solved: false };
  if (detect.solver === 'headed' || detect.solver === 'cookie-bank' || detect.solver === 'queue-wait') {
    return { detect, solved: false, error: detect.note };
  }
  const kind = captchaKindForSolver(detect);
  if (!kind || !detect.sitekey) {
    return { detect, solved: false, error: 'No sitekey — cannot auto-solve' };
  }
  const opts: SolveCaptchaOpts = {
    kind,
    websiteURL: input.url,
    websiteKey: detect.sitekey,
    proxy: input.proxy,
  };
  let r = await solveWithCapMonster(opts);
  if (!r.ok) r = { ...r, ...(await solveWith2Captcha(opts)) };
  return { detect, solved: !!r.ok, token: r.token, error: r.error };
}

export { detectCaptcha };
