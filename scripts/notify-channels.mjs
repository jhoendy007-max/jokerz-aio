/**
 * Extra alert channels sent from the server: Telegram (bot) and email (SMTP).
 * Credentials come with each request from the app's settings; nothing is stored here.
 */
import tls from "node:tls";
import net from "node:net";

// ─── Telegram ───
export async function telegramApi(token, method, body, { timeoutMs = 15000 } = {}) {
  if (!/^\d{5,}:[\w-]{20,}$/.test(String(token || ""))) return { ok: false, description: "Bad bot token (format 123456:ABC…)" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: e?.name === "AbortError" ? "timeout" : e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

export function telegramText({ title, lines = [], url }) {
  return [`<b>${esc(title)}</b>`, ...lines.filter(Boolean).map(esc), url ? `<a href="${esc(url)}">Open product</a>` : ""].filter(Boolean).join("\n");
}

export async function sendTelegram({ token, chatId, title, lines, url, imageUrl }) {
  if (!chatId) return { ok: false, error: "Missing chat id" };
  const text = telegramText({ title, lines, url });
  const r = imageUrl
    ? await telegramApi(token, "sendPhoto", { chat_id: chatId, photo: imageUrl, caption: text.slice(0, 1000), parse_mode: "HTML" })
    : await telegramApi(token, "sendMessage", { chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true });
  if (!r.ok && imageUrl) return sendTelegram({ token, chatId, title, lines, url }); // photo refused → text
  return r.ok ? { ok: true } : { ok: false, error: r.description || "Telegram error" };
}

// ─── SMTP (465 TLS or 587 STARTTLS, AUTH LOGIN) ───
export const SMTP_PRESETS = {
  "gmail.com": { host: "smtp.gmail.com", port: 465 },
  "googlemail.com": { host: "smtp.gmail.com", port: 465 },
  "outlook.com": { host: "smtp.office365.com", port: 587 },
  "hotmail.com": { host: "smtp.office365.com", port: 587 },
  "live.com": { host: "smtp.office365.com", port: 587 },
  "yahoo.com": { host: "smtp.mail.yahoo.com", port: 465 },
  "icloud.com": { host: "smtp.mail.me.com", port: 587 },
  "me.com": { host: "smtp.mail.me.com", port: 587 },
};
export function resolveSmtp(user, host, port) {
  const d = String(user || "").toLowerCase().split("@")[1] || "";
  const p = SMTP_PRESETS[d] || { host: `smtp.${d}`, port: 465 };
  return { host: host || p.host, port: Number(port) || p.port };
}

function reader(sock) {
  let buf = "";
  const waiters = [];
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    flush();
  });
  function flush() {
    // a full reply ends with a line "NNN text" (no dash)
    const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
    if (m && waiters.length) {
      const out = buf;
      buf = "";
      waiters.shift()(out);
    }
  }
  return () =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("SMTP timeout")), 15000);
      waiters.push((v) => {
        clearTimeout(t);
        res(v);
      });
      flush();
    });
}

const code = (r) => Number(String(r).trim().split("\r\n").pop().slice(0, 3));

export function buildMime({ from, to, subject, text }) {
  const subj = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const body = Buffer.from(text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return [`From: Jokerz AIO <${from}>`, `To: ${to}`, `Subject: ${subj}`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
}

export async function sendEmail({ user, pass, to, subject, text, host, port }) {
  if (!user || !pass) return { ok: false, error: "Email + app password required" };
  to = to || user;
  const cfg = resolveSmtp(user, host, port);
  let sock;
  try {
    if (cfg.port === 465) {
      sock = tls.connect({ host: cfg.host, port: 465, servername: cfg.host });
      await new Promise((res, rej) => (sock.once("secureConnect", res), sock.once("error", rej)));
    } else {
      sock = net.connect({ host: cfg.host, port: cfg.port });
      await new Promise((res, rej) => (sock.once("connect", res), sock.once("error", rej)));
    }
    let read = reader(sock);
    const send = async (line, ok) => {
      sock.write(line + "\r\n");
      const r = await read();
      if (ok && !ok.includes(code(r))) throw new Error(`SMTP: ${String(r).trim().split("\r\n").pop()}`);
      return r;
    };
    if (code(await read()) !== 220) throw new Error("SMTP greeting failed");
    await send("EHLO jokerz-aio", [250]);
    if (cfg.port !== 465) {
      await send("STARTTLS", [220]);
      sock.removeAllListeners("data");
      sock = tls.connect({ socket: sock, servername: cfg.host });
      await new Promise((res, rej) => (sock.once("secureConnect", res), sock.once("error", rej)));
      read = reader(sock);
      await send("EHLO jokerz-aio", [250]);
    }
    await send("AUTH LOGIN", [334]);
    await send(Buffer.from(user).toString("base64"), [334]);
    await send(Buffer.from(pass).toString("base64"), [235]);
    await send(`MAIL FROM:<${user}>`, [250]);
    await send(`RCPT TO:<${to}>`, [250, 251]);
    await send("DATA", [354]);
    await send(`${buildMime({ from: user, to, subject, text }).replace(/\r\n\./g, "\r\n..")}\r\n.`, [250]);
    sock.write("QUIT\r\n");
    return { ok: true, host: cfg.host };
  } catch (e) {
    const msg = e?.message || String(e);
    return { ok: false, error: /535|auth/i.test(msg) ? "Email login refused — use an App Password" : msg, host: cfg.host };
  } finally {
    setTimeout(() => sock?.destroy(), 500);
  }
}
