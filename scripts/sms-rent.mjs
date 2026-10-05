/**
 * SMS rental for Target acc-gen (mode C).
 * SMSPool (Settings smspoolKey) or SMS-Activate (smsActivateKey).
 */
async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text), text };
  } catch {
    return { status: r.status, json: null, text };
  }
}

export async function rentNumber(cfg = {}) {
  const provider = String(cfg.provider || "").toLowerCase();
  const pool = cfg.smspoolKey || cfg.smspool;
  const act = cfg.smsActivateKey || cfg.smsActivate;
  if (provider === "sms-activate" || (!pool && act)) {
    const key = act;
    if (!key) return { ok: false, error: "No sms-activate key" };
    const service = cfg.service || "ot";
    const country = cfg.country || "12";
    const u = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${encodeURIComponent(key)}&action=getNumber&service=${encodeURIComponent(service)}&country=${encodeURIComponent(country)}`;
    const { text } = await getJson(u);
    if (/ACCESS_NUMBER:(\d+):(\d+)/.test(text || "")) {
      const [, id, phone] = text.match(/ACCESS_NUMBER:(\d+):(\d+)/);
      return { ok: true, provider: "sms-activate", id, phone: phone.replace(/^\+?1/, ""), rawPhone: phone };
    }
    return { ok: false, error: text || "sms-activate getNumber failed", provider: "sms-activate" };
  }
  if (pool) {
    const body = new URLSearchParams({
      key: pool,
      country: String(cfg.country || "US"),
      service: String(cfg.service || "Target"),
    });
    const { json, text } = await getJson("https://api.smspool.net/purchase/sms", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const order = json?.orderid || json?.order_id || json?.id;
    const phone = String(json?.phonenumber || json?.phone || json?.number || "").replace(/\D/g, "");
    if (order && phone) {
      return {
        ok: true,
        provider: "smspool",
        id: String(order),
        phone: phone.replace(/^1/, "").slice(-10),
        rawPhone: phone,
      };
    }
    return { ok: false, error: json?.message || text || "SMSPool purchase failed", provider: "smspool" };
  }
  return { ok: false, error: "No SMS key — Settings smspoolKey or smsActivateKey" };
}

export async function pollSms(rental, cfg = {}, timeoutMs = 90000) {
  if (!rental?.ok) return { ok: false, error: "no rental" };
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (rental.provider === "sms-activate") {
      const key = cfg.smsActivateKey || cfg.smsActivate;
      const u = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${encodeURIComponent(key)}&action=getStatus&id=${encodeURIComponent(rental.id)}`;
      const { text } = await getJson(u);
      if (/STATUS_OK:(\d+)/.test(text || "")) {
        return { ok: true, code: text.match(/STATUS_OK:(\d+)/)[1] };
      }
    } else if (rental.provider === "smspool") {
      const key = cfg.smspoolKey || cfg.smspool;
      const u = `https://api.smspool.net/sms/check?key=${encodeURIComponent(key)}&orderid=${encodeURIComponent(rental.id)}`;
      const { json, text } = await getJson(u);
      const code = json?.sms || json?.code || json?.full_code;
      if (code) return { ok: true, code: String(code).replace(/\D/g, "").slice(0, 8) };
      if (json?.status === "success" && json?.sms) return { ok: true, code: String(json.sms) };
      void text;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { ok: false, error: "SMS timeout" };
}

export async function finishSms(rental, cfg = {}) {
  try {
    if (rental?.provider === "sms-activate") {
      const key = cfg.smsActivateKey || cfg.smsActivate;
      await getJson(
        `https://api.sms-activate.org/stubs/handler_api.php?api_key=${encodeURIComponent(key)}&action=setStatus&id=${encodeURIComponent(rental.id)}&status=6`
      );
    }
  } catch {
    /* */
  }
}
