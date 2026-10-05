/**
 * IMAP OTP poll — email + app password only.
 * Host/port come from the domain (Gmail / Outlook / Yahoo / iCloud).
 */
import tls from "node:tls";

export const IMAP_PRESETS = {
  gmail: { id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993 },
  outlook: { id: "outlook", label: "Outlook / Hotmail", host: "outlook.office365.com", port: 993 },
  yahoo: { id: "yahoo", label: "Yahoo", host: "imap.mail.yahoo.com", port: 993 },
  icloud: { id: "icloud", label: "iCloud", host: "imap.mail.me.com", port: 993 },
};

const DOMAIN = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
  "msn.com": "outlook",
  "office365.com": "outlook",
  "yahoo.com": "yahoo",
  "ymail.com": "yahoo",
  "rocketmail.com": "yahoo",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
};

export function resolveImap(email) {
  const d = String(email || "")
    .toLowerCase()
    .trim()
    .match(/@([^@\s]+)$/)?.[1];
  if (!d) return { ...IMAP_PRESETS.gmail, unknown: true };
  const id = DOMAIN[d] || (d.endsWith(".outlook.com") ? "outlook" : null);
  if (id) return { ...IMAP_PRESETS[id], domain: d };
  return { ...IMAP_PRESETS.gmail, host: `imap.${d}`, domain: d, unknown: true };
}

export function extractOtp(text) {
  const t = String(text || "").replace(/=\r?\n/g, "");
  const near = t.match(
    /(?:one[-\s]?time|passcode|otp|verif(?:y|ication)?|security code|3-?d\s*secure|authentication code)[^\d]{0,48}(\d{4,8})/i
  );
  if (near) return near[1];
  const six = t.match(/\b(\d{6})\b/);
  return six ? six[1] : "";
}

function imapCmd(socket, tag, line) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      if (new RegExp(`^${tag} (OK|NO|BAD)`, "mi").test(buf) || /\n\* BYE/i.test(buf)) {
        socket.off("data", onData);
        resolve(buf);
      }
    };
    const t = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error("IMAP timeout"));
    }, 12000);
    socket.on("data", onData);
    socket.write(`${tag} ${line}\r\n`);
    const orig = resolve;
    resolve = (v) => {
      clearTimeout(t);
      orig(v);
    };
  });
}

export async function pollEmailOtp(cfg = {}) {
  const user = String(cfg.user || cfg.imapUser || "").trim();
  const pass = String(cfg.pass || cfg.imapPass || "").trim();
  if (!user || !pass) return { ok: false, skip: true, reason: "no imap" };
  const preset = resolveImap(user);
  const host = String(cfg.host || cfg.imapHost || preset.host).trim();
  const port = Number(cfg.port || cfg.imapPort || preset.port || 993) || 993;

  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  await new Promise((res, rej) => {
    socket.once("secureConnect", res);
    socket.once("error", rej);
    setTimeout(() => rej(new Error("IMAP connect timeout")), 10000);
  });

  try {
    await new Promise((res) => {
      const kick = (d) => {
        if (/\* OK/i.test(d.toString())) {
          socket.off("data", kick);
          res();
        }
      };
      socket.on("data", kick);
      setTimeout(res, 1500);
    });

    const login = await imapCmd(socket, "A1", `LOGIN "${user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`);
    if (!/^A1 OK/mi.test(login)) {
      return { ok: false, error: "IMAP login failed (app password?)" };
    }
    await imapCmd(socket, "Z2", "SELECT INBOX");
    const search = await imapCmd(socket, "Z3", "UID SEARCH UNSEEN");
    const uids = [...(search.match(/\* SEARCH[^\r\n]*/i)?.[0] || "").matchAll(/\d+/g)].map((m) => m[0]);
    if (!uids.length) {
      await imapCmd(socket, "Z9", "LOGOUT").catch(() => {});
      return { ok: false, skip: true, reason: "no unseen mail" };
    }
    const fetch = await imapCmd(
      socket,
      "Z4",
      `UID FETCH ${uids.slice(-6).join(",")} (BODY.PEEK[TEXT] BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])`
    );
    const code = extractOtp(fetch);
    await imapCmd(socket, "A9", "LOGOUT").catch(() => {});
    if (!code) return { ok: false, skip: true, reason: "no otp in mail" };
    return { ok: true, code, via: "imap", preset: preset.label, host };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    socket.destroy();
  }
}

export async function testImapLogin(cfg = {}) {
  const user = String(cfg.user || cfg.imapUser || "").trim();
  const pass = String(cfg.pass || cfg.imapPass || "").trim();
  if (!user || !pass) return { ok: false, error: "email + app password required" };
  const preset = resolveImap(user);
  const host = String(cfg.host || preset.host).trim();
  const port = Number(cfg.port || preset.port || 993) || 993;
  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  try {
    await new Promise((res, rej) => {
      socket.once("secureConnect", res);
      socket.once("error", rej);
      setTimeout(() => rej(new Error("IMAP connect timeout")), 10000);
    });
    await new Promise((res) => setTimeout(res, 400));
    const login = await imapCmd(socket, "A1", `LOGIN "${user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`);
    if (!/^A1 OK/mi.test(login)) {
      return { ok: false, error: "Login failed — usa App Password, no la pass normal", preset: preset.label, host };
    }
    await imapCmd(socket, "Z2", "SELECT INBOX");
    await imapCmd(socket, "A9", "LOGOUT").catch(() => {});
    return { ok: true, message: `${preset.label} OK · ${host}:993 · INBOX`, preset: preset.label, host };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), preset: preset.label, host };
  } finally {
    socket.destroy();
  }
}
