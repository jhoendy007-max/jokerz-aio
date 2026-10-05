/**
 * Node captcha solver for checkout/3DS ACS pages.
 * Solves reCAPTCHA / hCaptcha / Turnstile / FunCaptcha only — not bank OTP.
 */
import { detectCaptcha } from "./captcha-detect.mjs";

function kindFromDetect(d) {
  const p = String(d.provider || "");
  if (p.includes("datadome")) return "DataDome";
  if (p.includes("recaptcha") && /v3/i.test(p + d.challenge)) return "RecaptchaV3";
  if (p.includes("recaptcha")) return "RecaptchaV2";
  if (p.includes("hcaptcha")) return "HCaptcha";
  if (p.includes("turnstile")) return "Turnstile";
  if (p.includes("fun")) return "FunCaptcha";
  return null;
}

function datadomeCaptchaUrl(html) {
  const m = String(html || "").match(/https?:\/\/[^"'\\\s]*captcha-delivery\.com[^"'\\\s]*/i);
  return m ? m[0].replace(/amp;/g, "") : "";
}

function capmonsterBase(cfg) {
  let base = String(cfg.capmonsterHost || "").trim();
  if (!base || /127\.0\.0\.1|localhost/i.test(base)) {
    // Key + no local app → CapMonster Cloud (complete-bot default)
    if (String(cfg.capmonsterKey || "").trim()) base = "https://api.capmonster.cloud";
    else base = base || "https://api.capmonster.cloud";
  }
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/$/, "");
}

async function solveCapMonster(cfg, { kind, websiteURL, websiteKey, timeoutMs, html, userAgent }) {
  const clientKey = String(cfg.capmonsterKey || "").trim();
  if (!clientKey) return { ok: false, error: "CapMonster key empty" };
  const base = capmonsterBase(cfg);
  let task;
  if (kind === "DataDome") {
    const captchaUrl = datadomeCaptchaUrl(html) || websiteKey || websiteURL;
    task = {
      type: "CustomTask",
      class: "DataDome",
      websiteURL,
      userAgent: userAgent || "",
      metadata: { captchaUrl, datadomeCookie: "" },
    };
  } else {
    const type =
      kind === "HCaptcha"
        ? "HCaptchaTaskProxyless"
        : kind === "Turnstile"
          ? "TurnstileTaskProxyless"
          : kind === "FunCaptcha"
            ? "FunCaptchaTaskProxyless"
            : kind === "RecaptchaV3"
              ? "RecaptchaV3TaskProxyless"
              : "NoCaptchaTaskProxyless";
    task = { type, websiteURL, websiteKey };
    if (kind === "FunCaptcha") task.websitePublicKey = websiteKey;
    if (kind === "RecaptchaV3") {
      task.minScore = 0.7;
      task.pageAction = "verify";
    }
  }
  const created = await fetch(`${base}/createTask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientKey, task }),
  }).then((r) => r.json());
  if (created.errorId) return { ok: false, error: created.errorDescription || "createTask" };
  const id = created.taskId;
  const start = Date.now();
  const timeout = timeoutMs || 120000;
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`${base}/getTaskResult`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientKey, taskId: id }),
    }).then((r) => r.json());
    if (poll.status === "ready") {
      const token =
        poll.solution?.gRecaptchaResponse ||
        poll.solution?.token ||
        poll.solution?.cookie ||
        poll.solution?.text;
      return { ok: true, token, provider: "capmonster" };
    }
    if (poll.errorId) return { ok: false, error: poll.errorDescription || "getTaskResult" };
  }
  return { ok: false, error: "CapMonster timeout" };
}

async function solveTwoCaptcha(cfg, { kind, websiteURL, websiteKey, timeoutMs }) {
  const key = String(cfg.twocaptchaKey || "").trim();
  if (!key) return { ok: false, error: "2Captcha key empty" };
  let base = String(cfg.twocaptchaHost || "https://2captcha.com").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  const params = new URLSearchParams({
    key,
    method: "userrecaptcha",
    googlekey: websiteKey,
    pageurl: websiteURL,
    json: "1",
  });
  if (kind === "HCaptcha") {
    params.set("method", "hcaptcha");
    params.set("sitekey", websiteKey);
  }
  if (kind === "Turnstile") {
    params.set("method", "turnstile");
    params.set("sitekey", websiteKey);
  }
  if (kind === "RecaptchaV3") {
    params.set("version", "v3");
    params.set("min_score", "0.7");
  }
  const created = await fetch(`${base}/in.php?${params}`).then((r) => r.json());
  if (created.status !== 1) return { ok: false, error: created.request || "in.php" };
  const id = created.request;
  const start = Date.now();
  const timeout = timeoutMs || 120000;
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await fetch(
      `${base}/res.php?key=${encodeURIComponent(key)}&action=get&id=${id}&json=1`
    ).then((r) => r.json());
    if (poll.status === 1) return { ok: true, token: poll.request, provider: "2captcha" };
    if (poll.request && poll.request !== "CAPCHA_NOT_READY") {
      return { ok: false, error: poll.request };
    }
  }
  return { ok: false, error: "2Captcha timeout" };
}

function sitekeyFromHtml(html) {
  const m =
    String(html || "").match(/data-sitekey=["']([^"']+)/i) ||
    String(html || "").match(/sitekey["']?\s*[:=]\s*["']([^"']+)/i) ||
    String(html || "").match(/render=([0-9A-Za-z_-]{20,})/);
  return m ? m[1] : "";
}

export async function solvePageCaptcha({ html, url, cfg, timeoutMs } = {}) {
  const detect = detectCaptcha({ html, url });
  const kind = kindFromDetect(detect);
  const sitekey = detect.sitekey || sitekeyFromHtml(html) || datadomeCaptchaUrl(html);
  if (!kind || (kind !== "DataDome" && !sitekey)) {
    return {
      ok: false,
      skip: true,
      reason: detect.solver === "headed" ? detect.note || "headed challenge" : "no solvable captcha",
      detect,
    };
  }
  const hasPaid = String(cfg?.capmonsterKey || "").trim() || String(cfg?.twocaptchaKey || "").trim();
  if (!hasPaid) {
    return {
      ok: false,
      skip: true,
      reason: "no paid solver · using headed Chrome (PX hold / recaptcha click) — free",
      detect,
      kind,
      sitekey,
    };
  }
  const provider = String(cfg?.provider || cfg?.captchaProvider || "capmonster").toLowerCase();
  const args = { kind, websiteURL: url || "https://www.pokemoncenter.com/", websiteKey: sitekey, timeoutMs, html };
  try {
    if (provider === "2captcha" || provider === "twocaptcha") {
      const r = await solveTwoCaptcha(cfg || {}, args);
      return { ...r, kind, sitekey, detect };
    }
    const r = await solveCapMonster(cfg || {}, args);
    if (!r.ok && String(cfg?.twocaptchaKey || "").trim()) {
      const r2 = await solveTwoCaptcha(cfg || {}, args);
      return { ...r2, kind, sitekey, detect, fallback: true };
    }
    return { ...r, kind, sitekey, detect };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), kind, sitekey, detect };
  }
}

export async function injectCaptchaToken(frame, token, kind) {
  if (!token) return false;
  try {
    await frame.evaluate(
      ({ token, kind }) => {
        if (kind === "DataDome") {
          const raw = String(token || "");
          const cookie = raw.includes("datadome=") ? raw : `datadome=${raw}`;
          document.cookie = `${cookie}; path=/; secure`;
          return;
        }
          kind === "HCaptcha"
            ? ["h-captcha-response", "g-recaptcha-response"]
            : kind === "Turnstile"
              ? ["cf-turnstile-response"]
              : ["g-recaptcha-response"];
        for (const n of names) {
          document.querySelectorAll(`[name="${n}"], #${n}, textarea.${n}`).forEach((el) => {
            el.value = token;
            el.innerHTML = token;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
        }
        try {
          if (window.grecaptcha && window.grecaptcha.getResponse) {
            /* token injected via textarea */
          }
        } catch {
          /* */
        }
        const btn = document.querySelector(
          'button[type="submit"], input[type="submit"], button:not([disabled])'
        );
        if (btn) btn.click();
      },
      { token, kind }
    );
    return true;
  } catch {
    return false;
  }
}
