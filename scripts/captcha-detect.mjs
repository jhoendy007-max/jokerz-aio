/** Shape: cookies on Target ≠ captcha. Layers: sensor | stale_abck | press_hold | hard_block */
function parseAbck(cookieStr) {
  const m = String(cookieStr).match(/_abck=([^;]+)/i);
  if (!m) return { present: false, valid: null };
  let v = m[1];
  try { v = decodeURIComponent(v); } catch { /* */ }
  if (/~0(?:~|$)/.test(v)) return { present: true, valid: false };
  if (/~-1(?:~|$)/.test(v) || /~1~/.test(v)) return { present: true, valid: true };
  return { present: true, valid: null };
}

export function analyzeShape({ html = "", url = "", cookies = "", status } = {}) {
  const ck = typeof cookies === "string" ? cookies : (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
  const abck = parseAbck(ck);
  const pressHold = /press and hold|press\s*&\s*hold|hold to confirm/i.test(html);
  const secCpt = /sec-cpt|#sec-cpt-if|cp-challenge|\/akam\/\d+\/pixel/i.test(html + url);
  const accessDenied = /access denied|you don'?t have permission|errors\.edgesuite/i.test(html) || status === 403;
  const sensorScript = /\/akam\/\d+|go-shape|_abck/i.test(html);
  let layer = "none";
  if (accessDenied && (abck.present || sensorScript || secCpt)) layer = "hard_block";
  else if (pressHold || secCpt) layer = "press_hold";
  else if (abck.present && abck.valid === false) layer = "stale_abck";
  else if (abck.present || /bm_sz=/i.test(ck) || sensorScript) layer = "sensor";
  const notes = {
    none: "No Shape",
    sensor: "Shape sensor only — NOT a captcha",
    stale_abck: "_abck ~0 — rotate cookie bank, same ISP",
    press_hold: "Shape press & hold — headed, same IP",
    hard_block: "Shape 403 — rest ISP 2–4 min",
  };
  return { present: layer !== "none", layer, abckValid: abck.valid, pressHold, secCpt, note: notes[layer] };
}

export function detectCaptcha({ html = "", url = "", headers = {}, cookies = "", status } = {}) {
  const ck = typeof cookies === "string" ? cookies : Array.isArray(cookies)
    ? cookies.map((c) => `${c.name}=${c.value}`).join("; ")
    : "";
  const shape = analyzeShape({ html, url, cookies: ck, status });
  const signals = [];
  const add = (where, what) => signals.push({ where, what });
  if (shape.layer !== "none") add("cookie", `shape ${shape.layer}`);
  if (shape.pressHold) add("html", "press and hold");
  if (shape.secCpt) add("html", "sec-cpt");
  if (/datadome=/.test(ck) || /captcha-delivery|datadome/i.test(html + url)) add("html", "DataDome interstitial");
  if (/px-captcha|_pxAppId|human\.px-cdn/i.test(html)) add("html", "PerimeterX widget");
  if (/_px3=|_pxvid=/.test(ck)) add("cookie", "PX sensor");
  if (/queue-it|queueittoken/i.test(html + url)) add("url", "Queue-it");
  if (/grecaptcha|google.com\/recaptcha/i.test(html)) add("html", "reCAPTCHA");
  if (/hcaptcha/i.test(html)) add("html", "hCaptcha");
  if (/cf-turnstile|challenges.cloudflare/i.test(html)) add("html", "Turnstile");

  const sitekey = (html.match(/data-sitekey=["']([^"']+)/i) || [])[1];
  const has = (w) => signals.some((s) => s.what.toLowerCase().includes(w));
  let provider = "unknown", challenge = "none", solver = "none", note = "No challenge", confidence = 0;

  if (has("queue-it")) {
    provider = "queueit"; challenge = "queue"; solver = "queue-wait"; confidence = 0.92; note = "Queue-it";
  } else if (has("datadome")) {
    provider = "datadome"; challenge = "interstitial"; solver = "capmonster"; confidence = 0.9; note = "DataDome";
  } else if (has("px-captcha") || (has("perimeterx widget") && /press and hold|px-captcha/i.test(html))) {
    provider = "perimeterx"; challenge = "press_hold"; solver = "headed"; confidence = 0.9; note = "PX press & hold headed";
  } else if (has("px sensor") && shape.layer === "sensor") {
    provider = "shape"; challenge = "none"; solver = "none"; confidence = 0.7; note = "Target Shape+PX sensors OK";
  } else if (shape.layer === "press_hold" || shape.layer === "hard_block" || shape.layer === "stale_abck") {
    provider = "shape";
    challenge = shape.layer === "press_hold" ? "press_hold" : "js_sensor";
    solver = shape.layer === "press_hold" ? "headed" : shape.layer === "stale_abck" ? "cookie-bank" : "rotate-isp";
    confidence = 0.93;
    note = shape.note;
  } else if (shape.layer === "sensor") {
    provider = "shape"; challenge = "none"; solver = "none"; confidence = 0.5; note = shape.note;
  } else if (has("recaptcha")) {
    provider = "recaptcha_v2"; challenge = "checkbox"; solver = "capmonster"; confidence = 0.9; note = "reCAPTCHA";
  } else if (has("hcaptcha")) {
    provider = "hcaptcha"; challenge = "checkbox"; solver = "capmonster"; confidence = 0.9; note = "hCaptcha";
  } else if (has("turnstile")) {
    provider = "turnstile"; challenge = "checkbox"; solver = "capmonster"; confidence = 0.9; note = "Turnstile";
  }

  const detected = challenge !== "none" && provider !== "unknown";
  return { detected, provider, challenge, confidence, sitekey, signals, solver, note, shape, url };
}
