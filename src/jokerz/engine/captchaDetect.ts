/** Advanced captcha / antibot detection from HTML, headers, cookies, URL. */

export type CaptchaProvider =
  | 'shape'
  | 'akamai'
  | 'perimeterx'
  | 'datadome'
  | 'kasada'
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'turnstile'
  | 'funcaptcha'
  | 'geetest'
  | 'queueit'
  | 'cloudflare'
  | 'unknown';

export type ChallengeKind =
  | 'none'
  | 'press_hold'
  | 'slider'
  | 'interstitial'
  | 'checkbox'
  | 'invisible'
  | 'score'
  | 'image'
  | 'queue'
  | 'js_sensor';

export interface DetectSignal {
  where: 'html' | 'cookie' | 'header' | 'url' | 'script';
  what: string;
}

export interface CaptchaDetectResult {
  detected: boolean;
  provider: CaptchaProvider;
  challenge: ChallengeKind;
  confidence: number;
  sitekey?: string;
  action?: string;
  pxAppId?: string;
  datadomeCid?: string;
  queueId?: string;
  signals: DetectSignal[];
  /** How we should handle it */
  solver:
    | 'capmonster'
    | '2captcha'
    | 'headed'
    | 'cookie-bank'
    | 'queue-wait'
    | 'rotate-isp'
    | 'none';
  note: string;
}

/** Shape/Akamai is always on Target. Cookies ≠ challenge. */

export type ShapeLayer = 'none' | 'sensor' | 'stale_abck' | 'press_hold' | 'hard_block';

export interface ShapeAnalysis {
  present: boolean;
  layer: ShapeLayer;
  abckPresent: boolean;
  /** true ≈ sensor accepted (~-1). false ≈ invalidated (~0). */
  abckValid: boolean | null;
  bmSz: boolean;
  bmSv: boolean;
  akBmsc: boolean;
  pressHold: boolean;
  secCpt: boolean;
  accessDenied: boolean;
  status?: number;
  note: string;
}

function cookieBlob(
  cookies?: string | { name: string; value: string }[]
): string {
  if (!cookies) return '';
  if (typeof cookies === 'string') return cookies;
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function parseAbck(cookieStr: string): { present: boolean; valid: boolean | null } {
  const m = cookieStr.match(/_abck=([^;]+)/i);
  if (!m) return { present: false, valid: null };
  let v = m[1];
  try {
    v = decodeURIComponent(v);
  } catch {
    /* */
  }
  if (/~0(?:~|$)/.test(v)) return { present: true, valid: false };
  if (/~-1(?:~|$)/.test(v) || /~1~/.test(v)) return { present: true, valid: true };
  return { present: true, valid: null };
}

export function analyzeShape(input: {
  html?: string;
  url?: string;
  cookies?: string | { name: string; value: string }[];
  status?: number;
}): ShapeAnalysis {
  const html = String(input.html || '');
  const url = String(input.url || '');
  const ck = cookieBlob(input.cookies);
  const status = input.status;
  const abck = parseAbck(ck);
  const bmSz = /bm_sz=/i.test(ck);
  const bmSv = /bm_sv=/i.test(ck);
  const akBmsc = /ak_bmsc=/i.test(ck);
  const pressHold = /press and hold|press\s*&\s*hold|hold to confirm/i.test(html);
  const secCpt =
    /sec-cpt|#sec-cpt-if|cp-challenge|sec_cpt/i.test(html) ||
    /\/akam\/\d+\/pixel/i.test(html + url);
  const accessDenied =
    /access denied|you don'?t have permission|errors\.edgesuite/i.test(html) ||
    status === 403;
  const sensorScript = /\/akam\/\d+|go-shape|shape security|_abck/i.test(html);

  let layer: ShapeLayer = 'none';
  if (accessDenied && (abck.present || sensorScript || secCpt)) layer = 'hard_block';
  else if (pressHold || secCpt) layer = 'press_hold';
  else if (abck.present && abck.valid === false) layer = 'stale_abck';
  else if (abck.present || bmSz || sensorScript) layer = 'sensor';

  const present = layer !== 'none';
  const notes: Record<ShapeLayer, string> = {
    none: 'No Shape/Akamai stack',
    sensor: 'Shape sensor only (_abck) — NOT a captcha. Harvest/login cookies OK',
    stale_abck: '_abck invalidated (~0) — rotate LOGIN/ATC bank, same ISP',
    press_hold: 'Shape press & hold / sec-cpt — headed Chrome, same IP',
    hard_block: 'Shape hard 403 — rest ISP 2–4 min, new context, do not retry fast',
  };

  return {
    present,
    layer,
    abckPresent: abck.present,
    abckValid: abck.valid,
    bmSz,
    bmSv,
    akBmsc,
    pressHold,
    secCpt,
    accessDenied,
    status,
    note: notes[layer],
  };
}

function extractSitekey(html: string): string | undefined {
  const pats = [
    /data-sitekey=["']([^"']+)["']/i,
    /sitekey["']?\s*[:=]\s*["']([^"']+)["']/i,
    /grecaptcha\.(?:execute|render)\(\s*["']([^"']+)["']/i,
    /"sitekey"\s*:\s*"([^"]+)"/i,
    /k=([A-Za-z0-9_-]{20,100})/,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

export function detectCaptcha(input: {
  html?: string;
  url?: string;
  headers?: Record<string, string>;
  cookies?: string | { name: string; value: string }[];
  status?: number;
}): CaptchaDetectResult {
  const html = String(input.html || '');
  const url = String(input.url || '');
  const hdr = Object.fromEntries(
    Object.entries(input.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
  );
  const cookieStr = cookieBlob(input.cookies);
  const status = input.status;
  const shape = analyzeShape({ html, url, cookies: cookieStr, status });
  const signals: DetectSignal[] = [];

  const add = (where: DetectSignal['where'], what: string) => signals.push({ where, what });

  if (shape.abckPresent) add('cookie', `_abck ${shape.abckValid === false ? 'STALE~0' : shape.abckValid ? 'OK~-1' : 'present'}`);
  if (shape.bmSz) add('cookie', 'bm_sz');
  if (shape.pressHold) add('html', 'press and hold');
  if (shape.secCpt) add('html', 'sec-cpt');
  if (shape.accessDenied) add('html', 'access denied / 403');
  if (shape.layer === 'sensor') add('cookie', 'Shape sensor (not challenge)');
  if (/datadome=/.test(cookieStr)) add('cookie', 'datadome cookie');
  if (/_px3=|_pxvid=|_pxhd=/.test(cookieStr)) add('cookie', 'PerimeterX sensor (_px3)');
  if (/x-datadome/i.test(JSON.stringify(hdr))) add('header', 'x-datadome');
  if (/x-kpsdk/i.test(JSON.stringify(hdr))) add('header', 'Kasada kpsdk');
  if (/x-px-/i.test(JSON.stringify(hdr))) add('header', 'x-px block');

  if (/akam\/13|go-shape|shape security/i.test(html) && shape.layer !== 'sensor')
    add('html', 'Shape script');
  if (/px-captcha|human\.px-cdn|_pxappid|px-cdn\.net\/init\.js/i.test(html)) add('html', 'PerimeterX widget');
  if (/captcha-delivery\.com|datadome|dd\.js|geo\.captcha-delivery/i.test(html))
    add('html', 'DataDome interstitial');
  if (/challenges\.cloudflare\.com|cf-turnstile|turnstile/i.test(html)) add('html', 'Turnstile');
  if (/google\.com\/recaptcha|grecaptcha/i.test(html)) add('html', 'reCAPTCHA');
  if (/hcaptcha\.com|h-captcha/i.test(html)) add('html', 'hCaptcha');
  if (/arkoselabs|funcaptcha/i.test(html)) add('html', 'FunCaptcha');
  if (/geetest|gt\.js/i.test(html)) add('html', 'GeeTest');
  if (/queue-it|queueittoken|queueid/i.test(html + url)) add('url', 'Queue-it');
  if (/kasada|ips\.js|kpsdk/i.test(html)) add('html', 'Kasada');
  if (/captcha-delivery|geo\.captcha-delivery/i.test(url)) add('url', 'DataDome URL');

  const sitekey = pickSitekey(html);
  const pxApp = html.match(/_pxAppId["']?\s*[:=]\s*["']([^"']+)/i)?.[1];
  const ddCid = html.match(/cid=([A-Za-z0-9_-]{8,})/)?.[1] || cookieStr.match(/datadome=([^;]+)/)?.[1];
  const queueId = html.match(/queueid=([^&"']+)/i)?.[1];
  const recaptchaV3 = /grecaptcha\.execute|recaptcha\/enterprise.*v3|render=explicit/i.test(html);

  let provider: CaptchaProvider = 'unknown';
  let challenge: ChallengeKind = 'none';
  let solver: CaptchaDetectResult['solver'] = 'none';
  let note = 'No challenge';
  let confidence = 0;

  const has = (w: string) => signals.some((s) => s.what.toLowerCase().includes(w));

  if (has('queue-it')) {
    provider = 'queueit';
    challenge = 'queue';
    solver = 'queue-wait';
    confidence = 0.92;
    note = 'Queue-it virtual waiting room — hold position, do not spam';
  } else if (has('datadome')) {
    provider = 'datadome';
    challenge = /slider|interstitial|captcha-delivery/i.test(html + url) ? 'interstitial' : 'slider';
    solver = 'capmonster';
    confidence = 0.9;
    note = 'DataDome — CapMonster DataDomeSlider (needs same IP) or headed';
  } else if (
    /px-captcha|press and hold|press\s*&\s*hold/i.test(html) &&
    (has('perimeterx') || has('_px3') || /_pxAppId|human\.px-cdn/i.test(html))
  ) {
    provider = 'perimeterx';
    challenge = 'press_hold';
    solver = 'headed';
    confidence = 0.9;
    note = 'PX press & hold — headed Chrome, same ISP (do not treat _px3 alone as captcha)';
  } else if (has('_px3') && shape.layer === 'sensor') {
    provider = 'shape';
    challenge = 'none';
    solver = 'none';
    confidence = 0.7;
    note = 'Target dual-stack · Shape + PX sensors OK (not a challenge)';
  } else if (has('_px3') && shape.layer === 'none') {
    provider = 'perimeterx';
    challenge = 'none';
    solver = 'none';
    confidence = 0.55;
    note = 'PX sensor cookies only — NOT a captcha. Harvest/login OK';
  } else if (shape.layer === 'press_hold' || shape.layer === 'hard_block' || shape.layer === 'stale_abck') {
    provider = 'shape';
    challenge = shape.layer === 'press_hold' ? 'press_hold' : shape.layer === 'hard_block' ? 'interstitial' : 'js_sensor';
    solver =
      shape.layer === 'press_hold'
        ? 'headed'
        : shape.layer === 'stale_abck'
          ? 'cookie-bank'
          : 'rotate-isp';
    confidence = shape.layer === 'hard_block' ? 0.95 : 0.92;
    note = shape.note;
  } else if (shape.layer === 'sensor') {
    // Presence of _abck is normal on Target — do not treat as captcha
    provider = 'shape';
    challenge = 'none';
    solver = 'none';
    confidence = 0.5;
    note = shape.note;
  } else if (has('kasada')) {
    provider = 'kasada';
    challenge = 'js_sensor';
    solver = 'headed';
    confidence = 0.8;
    note = 'Kasada JS SDK — headed Chrome, do not replay tokens across IPs';
  } else if (has('funcaptcha') || has('arkose')) {
    provider = 'funcaptcha';
    challenge = 'image';
    solver = 'capmonster';
    confidence = 0.85;
    note = 'Arkose FunCaptcha — CapMonster FunCaptchaTask';
  } else if (has('hcaptcha')) {
    provider = 'hcaptcha';
    challenge = 'checkbox';
    solver = 'capmonster';
    confidence = 0.9;
    note = 'hCaptcha — CapMonster / 2Captcha';
  } else if (has('turnstile')) {
    provider = 'turnstile';
    challenge = 'checkbox';
    solver = 'capmonster';
    confidence = 0.9;
    note = 'Cloudflare Turnstile — CapMonster TurnstileTask';
  } else if (has('recaptcha')) {
    provider = recaptchaV3 ? 'recaptcha_v3' : 'recaptcha_v2';
    challenge = recaptchaV3 ? 'score' : 'checkbox';
    solver = 'capmonster';
    confidence = 0.9;
    note = recaptchaV3 ? 'reCAPTCHA v3 score' : 'reCAPTCHA v2';
  } else if (has('geetest')) {
    provider = 'geetest';
    challenge = 'slider';
    solver = '2captcha';
    confidence = 0.75;
    note = 'GeeTest — 2Captcha geetest';
  } else if (has('cloudflare') && /just a moment|cf-browser-verification/i.test(html)) {
    provider = 'cloudflare';
    challenge = 'js_sensor';
    solver = 'headed';
    confidence = 0.7;
    note = 'Cloudflare IUAM — wait headed';
  }

  if (signals.length && provider === 'unknown') {
    provider = 'unknown';
    challenge = 'js_sensor';
    solver = 'headed';
    confidence = 0.4;
    note = 'Unknown challenge — headed fallback';
  }

  return {
    detected:
      (provider !== 'unknown' && challenge !== 'none') ||
      (signals.length > 0 && shape.layer !== 'sensor' && shape.layer !== 'none'),
    provider,
    challenge,
    confidence,
    sitekey,
    pxAppId: pxApp,
    datadomeCid: ddCid,
    queueId,
    signals,
    solver,
    note,
    shape,
  } as CaptchaDetectResult & { shape: ShapeAnalysis };
}

export function captchaKindForSolver(
  d: CaptchaDetectResult
): 'RecaptchaV2' | 'RecaptchaV3' | 'HCaptcha' | 'Turnstile' | 'FunCaptcha' | 'DataDome' | null {
  switch (d.provider) {
    case 'recaptcha_v2':
      return 'RecaptchaV2';
    case 'recaptcha_v3':
      return 'RecaptchaV3';
    case 'hcaptcha':
      return 'HCaptcha';
    case 'turnstile':
      return 'Turnstile';
    case 'funcaptcha':
      return 'FunCaptcha';
    case 'datadome':
      return 'DataDome';
    default:
      return null;
  }
}
