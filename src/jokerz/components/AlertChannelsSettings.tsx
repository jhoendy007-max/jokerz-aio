import { useEffect, useState } from 'react';
import { Send, Bell, Mail, Terminal } from 'lucide-react';
import type { BotSettings, AlertKindSetting } from '../lib/storage';
import { ALL_KINDS, KIND_LABEL, sendTelegramAlert, sendEmailAlert, showBrowserNotification, requestBrowserPermission, type AlertKind } from '../lib/channels';
import { API_BASE } from '../engine/apiBase';

type Props = {
  settings: BotSettings;
  update: <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => void;
  inputClass: string;
};

const TEST = { store: 'Target', product: '93954446', title: 'Test alert · Jokerz AIO', status: 'TEST', price: '$49.99', extra: 'If you see this, the channel works.', productUrl: 'https://www.target.com/' };
const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-widest border border-[#262626] text-[#ccc] hover:text-white hover:border-[#7B2CBF] disabled:opacity-50';

function Kinds({ value, onChange, fallback }: { value?: AlertKindSetting[]; onChange: (v: AlertKindSetting[]) => void; fallback: AlertKind[] }) {
  const cur = value && value.length ? value : fallback;
  return (
    <div className="flex flex-wrap gap-1.5">
      {ALL_KINDS.map((k) => {
        const on = cur.includes(k);
        return (
          <button
            key={k}
            type="button"
            onClick={() => onChange((on ? cur.filter((x) => x !== k) : [...cur, k]) as AlertKindSetting[])}
            className={`px-2 py-1 rounded text-[10px] font-bold border ${on ? 'bg-[#7B2CBF]/20 border-[#7B2CBF] text-white' : 'border-[#262626] text-[#666]'}`}
          >
            {KIND_LABEL[k]}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-[11px] text-[#ccc] cursor-pointer select-none">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="accent-[#7B2CBF]" />
      {label}
    </label>
  );
}

export default function AlertChannelsSettings({ settings: s, update, inputClass }: Props) {
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState('');
  const [remote, setRemote] = useState<{ polling?: boolean; appConnected?: boolean; lastError?: string } | null>(null);
  const say = (k: string, ok: boolean, text: string) => setMsg((m) => ({ ...m, [k]: { ok, text } }));

  useEffect(() => {
    if (!s.remoteCommandsEnabled) return;
    const load = () =>
      fetch(`${API_BASE}/api/remote/status`)
        .then((r) => r.json())
        .then(setRemote)
        .catch(() => setRemote(null));
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [s.remoteCommandsEnabled]);

  const testTelegram = async () => {
    setBusy('tg');
    const r: any = await sendTelegramAlert(s, 'stock', TEST).catch(() => ({ ok: false }));
    say('tg', Boolean(r?.ok), r?.ok ? 'Sent — check Telegram' : r?.error || 'Failed (check the token and chat id)');
    setBusy('');
  };
  const findChat = async () => {
    setBusy('tgc');
    try {
      const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(String(s.telegramToken || '').trim())}/getUpdates`).then((x) => x.json());
      const chat = (r.result || []).map((u: any) => u.message?.chat).filter(Boolean).at(-1);
      if (chat?.id) {
        update('telegramChatId', String(chat.id));
        say('tg', true, `Chat id found: ${chat.id} (${chat.username || chat.title || chat.first_name || ''}) — press Save`);
      } else say('tg', false, r.ok ? 'No messages yet — send any message to your bot first, then try again' : r.description || 'Invalid token');
    } catch {
      say('tg', false, 'Could not reach Telegram');
    }
    setBusy('');
  };
  const testBrowser = async () => {
    const p = await requestBrowserPermission();
    if (p !== 'granted') return say('br', false, p === 'unsupported' ? 'This browser does not support notifications' : 'Permission blocked — allow notifications for this site');
    showBrowserNotification(s, 'stock', TEST);
    say('br', true, 'Shown');
  };
  const testEmail = async () => {
    setBusy('em');
    const r: any = await sendEmailAlert(s, 'success', TEST).catch(() => ({ ok: false }));
    say('em', Boolean(r?.ok), r?.ok ? `Sent to ${s.emailAlertTo || s.emailAlertUser}` : r?.error || 'Failed');
    setBusy('');
  };
  const Msg = ({ k }: { k: string }) => (msg[k] ? <p className={`text-[11px] ${msg[k].ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg[k].text}</p> : null);

  return (
    <div className="space-y-4 border border-[#1A1A1A] rounded-lg p-4 bg-[#0B0B0B]">
      <div>
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-white">More alert channels</h3>
        <p className="text-[10px] text-[#555] mt-1">Same alerts as Discord (no repeats). Pick which kinds go to each channel.</p>
      </div>

      {/* Telegram */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-[#ddd] inline-flex items-center gap-1.5">
            <Send size={12} className="text-sky-400" /> Telegram
          </span>
          <Toggle on={Boolean(s.telegramEnabled)} onChange={(v) => update('telegramEnabled', v)} label="Enabled" />
        </div>
        <p className="text-[10px] text-[#555]">Create a bot with @BotFather, paste the token, send any message to the bot, then press Find chat id.</p>
        <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-2">
          <input type="password" value={s.telegramToken || ''} onChange={(e) => update('telegramToken', e.target.value.trim())} placeholder="Bot token 123456:ABC…" className={inputClass} />
          <input value={s.telegramChatId || ''} onChange={(e) => update('telegramChatId', e.target.value.trim())} placeholder="Chat id" className={inputClass} />
        </div>
        <Kinds value={s.telegramKinds} onChange={(v) => update('telegramKinds', v)} fallback={['stock', 'success', 'decline', 'price', 'info']} />
        <div className="flex gap-2">
          <button type="button" className={btn} disabled={!s.telegramToken || busy === 'tgc'} onClick={findChat}>
            Find chat id
          </button>
          <button type="button" className={btn} disabled={!s.telegramToken || !s.telegramChatId || busy === 'tg'} onClick={testTelegram}>
            Test
          </button>
        </div>
        <Msg k="tg" />
      </div>

      {/* Remote commands */}
      <div className="space-y-2 border-t border-[#1A1A1A] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-[#ddd] inline-flex items-center gap-1.5">
            <Terminal size={12} className="text-[#9D4EDD]" /> Telegram commands
          </span>
          <Toggle on={Boolean(s.remoteCommandsEnabled)} onChange={(v) => update('remoteCommandsEnabled', v)} label="Enabled" />
        </div>
        <p className="text-[10px] text-[#555]">
          From your chat only: /status · /tasks · /start [store] · /stop [store] · /summary · /drops · /health · /help. The app window must be open.
        </p>
        {s.remoteCommandsEnabled && (
          <p className="text-[11px] text-[#888]">
            {remote ? (remote.lastError ? <span className="text-red-400">Telegram: {remote.lastError}</span> : remote.polling ? <span className="text-emerald-400">Listening for commands</span> : 'Starting… (press Save)') : 'Engine server offline'}
          </p>
        )}
      </div>

      {/* Browser */}
      <div className="space-y-2 border-t border-[#1A1A1A] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-[#ddd] inline-flex items-center gap-1.5">
            <Bell size={12} className="text-amber-400" /> Browser notification + sound
          </span>
          <div className="flex gap-4">
            <Toggle on={s.browserNotifySound !== false} onChange={(v) => update('browserNotifySound', v)} label="Sound" />
            <Toggle
              on={Boolean(s.browserNotifyEnabled)}
              onChange={(v) => {
                update('browserNotifyEnabled', v);
                if (v) void requestBrowserPermission();
              }}
              label="Enabled"
            />
          </div>
        </div>
        <Kinds value={s.browserNotifyKinds} onChange={(v) => update('browserNotifyKinds', v)} fallback={['stock', 'success']} />
        <button type="button" className={btn} onClick={testBrowser}>
          Test
        </button>
        <Msg k="br" />
      </div>

      {/* Email */}
      <div className="space-y-2 border-t border-[#1A1A1A] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-[#ddd] inline-flex items-center gap-1.5">
            <Mail size={12} className="text-emerald-400" /> Email
          </span>
          <Toggle on={Boolean(s.emailAlertsEnabled)} onChange={(v) => update('emailAlertsEnabled', v)} label="Enabled" />
        </div>
        <p className="text-[10px] text-[#555]">Gmail / Outlook / Yahoo / iCloud: use an App Password (not your normal password).</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input value={s.emailAlertUser || ''} onChange={(e) => update('emailAlertUser', e.target.value.trim())} placeholder="Send from (you@gmail.com)" className={inputClass} />
          <input type="password" value={s.emailAlertPass || ''} onChange={(e) => update('emailAlertPass', e.target.value)} placeholder="App password" className={inputClass} />
          <input value={s.emailAlertTo || ''} onChange={(e) => update('emailAlertTo', e.target.value.trim())} placeholder="Send to (default: same)" className={inputClass} />
        </div>
        <Kinds value={s.emailAlertKinds} onChange={(v) => update('emailAlertKinds', v)} fallback={['success']} />
        <button type="button" className={btn} disabled={!s.emailAlertUser || !s.emailAlertPass || busy === 'em'} onClick={testEmail}>
          Test
        </button>
        <Msg k="em" />
      </div>
    </div>
  );
}
