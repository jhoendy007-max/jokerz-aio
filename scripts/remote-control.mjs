/**
 * Telegram remote control. The server long-polls your bot; commands from YOUR chat only are queued,
 * the open app picks them up (GET /api/remote/pending), runs them and replies (POST /api/remote/reply).
 * Commands: /help /status /tasks /start [store] /stop [store] /summary /drops /health
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { telegramApi } from "./notify-channels.mjs";

const FILE = join(process.env.JOKERZ_DATA || join(process.cwd(), "server"), ".remote-config.json");
export const COMMANDS = ["help", "status", "tasks", "start", "stop", "summary", "drops", "health"];

let cfg = { enabled: false, token: "", chatId: "" };
try {
  cfg = { ...cfg, ...JSON.parse(readFileSync(FILE, "utf8")) };
} catch {
  /* */
}
const queue = [];
let offset = 0;
let running = false;
let lastClientPoll = 0;
let lastError = "";
let seq = 0;

export const remotePublic = () => ({ enabled: cfg.enabled, hasToken: Boolean(cfg.token), chatId: cfg.chatId, polling: running, lastError, appConnected: Date.now() - lastClientPoll < 15000 });

export function setRemoteConfig(patch = {}) {
  cfg = { ...cfg, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  cfg.chatId = String(cfg.chatId || "").trim();
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(cfg));
  } catch {
    /* */
  }
  if (cfg.enabled && cfg.token) startRemote();
  return remotePublic();
}

/** Pure: Telegram text → command or null. */
export function parseCommand(text) {
  const m = String(text || "").trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  if (!COMMANDS.includes(cmd)) return { cmd: "unknown", args: m[1] };
  return { cmd, args: String(m[2] || "").trim() };
}

const reply = (chatId, text) => telegramApi(cfg.token, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true });

async function handleUpdate(u) {
  const msg = u.message || u.edited_message;
  if (!msg?.text) return;
  const chatId = String(msg.chat?.id || "");
  if (!cfg.chatId) {
    await reply(chatId, `Your chat id is <code>${chatId}</code>. Paste it in Jokerz AIO → Settings → Webhooks → Telegram to enable commands.`);
    return;
  }
  if (chatId !== cfg.chatId) return; // ignore everyone else
  const c = parseCommand(msg.text);
  if (!c) return;
  if (c.cmd === "unknown") {
    await reply(chatId, `Unknown command /${c.args}. Try /help`);
    return;
  }
  if (Date.now() - lastClientPoll > 15000) {
    await reply(chatId, "The Jokerz AIO window is not open — open the app to run commands.");
    return;
  }
  queue.push({ id: `r${++seq}`, chatId, ...c, at: Date.now() });
}

export function startRemote() {
  if (running) return;
  running = true;
  (async () => {
    while (cfg.enabled && cfg.token) {
      const r = await telegramApi(cfg.token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, { timeoutMs: 35000 });
      if (!r.ok) {
        lastError = r.description || "getUpdates failed";
        await new Promise((res) => setTimeout(res, 10000));
        continue;
      }
      lastError = "";
      for (const u of r.result || []) {
        offset = Math.max(offset, u.update_id + 1);
        await handleUpdate(u).catch(() => {});
      }
    }
    running = false;
  })();
}

export function takePending() {
  lastClientPoll = Date.now();
  // polling starts in the process the app talks to (avoids two pollers on the same bot)
  if (cfg.enabled && cfg.token && !running) startRemote();
  // drop stale commands (> 2 min)
  while (queue.length && Date.now() - queue[0].at > 120000) queue.shift();
  return queue.splice(0, queue.length);
}

export async function remoteReply(chatId, text) {
  if (!cfg.token || !chatId) return { ok: false };
  const r = await reply(chatId, text);
  return { ok: Boolean(r.ok), error: r.description };
}

