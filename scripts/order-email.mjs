/**
 * Reads order emails (confirmation / shipped / delivered / cancelled) from your inbox over IMAP
 * (same email + app password as Settings → Accounts → IMAP). Read-only (BODY.PEEK, nothing is marked as read).
 */
import tls from "node:tls";
import { resolveImap } from "./otp-inbox.mjs";

export const STORE_SENDERS = [
  ["Target", /target\.com/i],
  ["Walmart", /walmart\.com/i],
  ["Pokemon Center", /pokemoncenter\.com|pokemon\.com/i],
  ["Bandai", /bandai/i],
];

export function decodeMimeWords(s) {
  return String(s || "").replace(/=\?([\w-]+)\?([QB])\?([^?]*)\?=/gi, (_, _cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(txt, "base64").toString("utf8");
      return Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
    } catch {
      return txt;
    }
  });
}

export function decodeBody(raw) {
  let t = String(raw || "");
  // base64 parts (long runs of base64 lines)
  t = t.replace(/(?:^|\n)((?:[A-Za-z0-9+/]{60,}\r?\n){3,}[A-Za-z0-9+/=]*)/g, (m, b) => {
    try {
      const d = Buffer.from(b.replace(/\s+/g, ""), "base64").toString("utf8");
      // eslint-disable-next-line no-control-regex
      return /[\x00-\x08]/.test(d) ? m : `\n${d}`;
    } catch {
      return m;
    }
  });
  // quoted-printable
  t = t.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  // html → text
  return t
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#36;|&dollar;/g, "$")
    .replace(/[ \t]+/g, " ");
}

export function orderStatus(subject, body = "") {
  return statusOf(String(subject).toLowerCase()) || statusOf(String(body).slice(0, 400).toLowerCase());
}
function statusOf(s) {
  if (/cancel/.test(s)) return "cancelled";
  if (/deliver(ed|y complete)|was delivered|has been delivered/.test(s)) return "delivered";
  if (/shipped|on (its|the) way|out for delivery|tracking|has shipped|in transit/.test(s)) return "shipped";
  if (/thanks for (your )?(order|shopping)|order (confirmation|confirmed|received|placed)|we('ve| have) (got|received) your order|order #/.test(s)) return "confirmed";
  return null;
}

/** Pure: one email → order info (or null when it is not an order email). */
export function parseOrderEmail({ from = "", subject = "", date = "", body = "" }) {
  const store = STORE_SENDERS.find(([, re]) => re.test(from))?.[0];
  if (!store) return null;
  const text = `${subject}\n${body}`;
  const status = orderStatus(subject, body);
  if (!status) return null;
  const m =
    text.match(/order\s*(?:#|number|no\.?|num)\s*[:#]?\s*([A-Z]{0,3}\d[\d-]{5,24})/i) ||
    text.match(/\b(\d{7}-\d{8})\b/) || // Walmart style
    text.match(/#\s*(\d{9,16})\b/);
  if (!m) return null;
  const totalM = text.match(/(?:order total|grand total|total charged|total)\s*[:\s]*\$\s?([\d,]+\.\d{2})/i);
  const t = Date.parse(date);
  return {
    store,
    orderNumber: m[1].replace(/-+$/, ""),
    status,
    total: totalM ? `$${totalM[1]}` : undefined,
    t: Number.isFinite(t) ? t : Date.now(),
    subject: decodeMimeWords(subject).slice(0, 160),
  };
}

const imapDate = (d) => `${d.getUTCDate()}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}-${d.getUTCFullYear()}`;

function cmd(socket, tag, line, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const re = new RegExp(`\\r?\\n${tag} (OK|NO|BAD)[^\\n]*\\n?$|^${tag} (OK|NO|BAD)`, "m");
    const onData = (d) => {
      buf += d.toString("latin1");
      if (re.test(buf.slice(-400))) {
        cleanup();
        resolve(buf);
      }
    };
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("IMAP timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(t);
      socket.off("data", onData);
    };
    socket.on("data", onData);
    socket.write(`${tag} ${line}\r\n`);
  });
}

/** Split a FETCH response into messages. */
export function splitFetch(resp) {
  return String(resp)
    .split(/\r?\n(?=\* \d+ FETCH)/)
    .filter((p) => /^\* \d+ FETCH/.test(p.trim()))
    .map((p) => {
      const h = (name) => decodeMimeWords((p.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, "mi"))?.[1] || "").replace(/\r?\n[ \t]+/g, " ").trim());
      return { from: h("From"), subject: h("Subject"), date: h("Date"), body: decodeBody(p) };
    });
}

export async function scanOrderEmails({ user, pass, host, days = 30, max = 60 } = {}) {
  user = String(user || "").trim();
  pass = String(pass || "").trim();
  if (!user || !pass) return { ok: false, error: "Set the IMAP email + app password in Settings → Accounts → IMAP" };
  const preset = resolveImap(user);
  host = String(host || preset.host).trim();
  const socket = tls.connect({ host, port: 993, servername: host });
  try {
    await new Promise((res, rej) => {
      socket.once("secureConnect", res);
      socket.once("error", rej);
      setTimeout(() => rej(new Error("IMAP connect timeout")), 10000);
    });
    await new Promise((r) => setTimeout(r, 400));
    const login = await cmd(socket, "A1", `LOGIN "${user.replace(/"/g, '\\"')}" "${pass.replace(/"/g, '\\"')}"`);
    if (!/A1 OK/i.test(login)) return { ok: false, error: "IMAP login failed — use an App Password, not your normal password" };
    await cmd(socket, "A2", "EXAMINE INBOX"); // read-only
    const since = imapDate(new Date(Date.now() - days * 86400_000));
    const search = await cmd(socket, "A3", `UID SEARCH SINCE ${since} OR OR OR FROM "target.com" FROM "walmart.com" FROM "pokemoncenter.com" FROM "bandai"`);
    const uids = [...(search.match(/\* SEARCH[^\r\n]*/i)?.[0] || "").matchAll(/\d+/g)].map((m) => m[0]).slice(-max);
    const orders = [];
    for (let i = 0; i < uids.length; i += 10) {
      const chunk = uids.slice(i, i + 10).join(",");
      const resp = await cmd(socket, `F${i}`, `UID FETCH ${chunk} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.30000>)`, 60000);
      for (const msg of splitFetch(resp)) {
        const o = parseOrderEmail(msg);
        if (o) orders.push(o);
      }
    }
    await cmd(socket, "A9", "LOGOUT").catch(() => {});
    return { ok: true, scanned: uids.length, orders };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    socket.destroy();
  }
}
