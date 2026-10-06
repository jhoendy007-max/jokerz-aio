import { useState } from 'react';
import { CalendarClock, Send, Eye } from 'lucide-react';
import { sendSummaryNow, summaryFor } from '../lib/dailySummaryRunner';
import { money } from '../lib/dailySummary';
import type { BotSettings } from '../lib/storage';

type Props = {
  settings: BotSettings;
  update: <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => void;
  inputClass: string;
};

export default function DailySummarySettings({ settings, update, inputClass }: Props) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const doPreview = () => {
    const to = Date.now();
    const s = summaryFor(to - 86400_000, to);
    const c = s.checkouts;
    setPreview(
      [
        `Restocks: ${s.restocks.length}${s.restocks.length ? ' — ' + s.restocks.slice(0, 3).map((r) => r.title || r.product).join(', ') : ''}`,
        `Price changes: ${s.priceChanges.length}`,
        `Checkouts: ${c.ok.length} ok (${money(c.spent)}) · ${c.failed.length} failed${c.dryRuns ? ` · ${c.dryRuns} dry runs` : ''}`,
        `Products watched: ${s.productsWatched}`,
      ].join('\n'),
    );
  };

  const doSend = async () => {
    setBusy(true);
    setMsg(null);
    // let the debounced settings save land first
    await new Promise((r) => setTimeout(r, 600));
    const r = await sendSummaryNow();
    setMsg(r.ok ? { ok: true, text: 'Sent to Discord (last 24 h).' } : { ok: false, text: r.error || 'Failed' });
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-[#1f1f1f] bg-[#0a0a0a] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarClock size={14} className="text-[#7B2CBF]" />
          <span className="text-[11px] uppercase font-bold text-white tracking-wide">Daily summary</span>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-[#aaa] cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(settings.dailySummaryEnabled)}
            onChange={(e) => update('dailySummaryEnabled', e.target.checked)}
          />
          Enabled
        </label>
      </div>
      <p className="text-[11px] text-[#888]">
        One Discord message a day with the restocks, price changes and checkouts of the last 24 h. Sent while the app is open;
        if it was closed at that time, it goes out the next time you open it.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">Send at (local time)</label>
          <input
            type="time"
            value={settings.dailySummaryTime || '21:00'}
            onChange={(e) => update('dailySummaryTime', e.target.value || '21:00')}
            className={inputClass}
          />
        </div>
        <div className="md:col-span-2">
          <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">Webhook (optional — default: main Discord webhook)</label>
          <input
            type="text"
            value={settings.dailySummaryWebhook || ''}
            onChange={(e) => update('dailySummaryWebhook', e.target.value)}
            placeholder="https://discord.com/api/webhooks/..."
            className={inputClass}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-[#aaa] cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(settings.dailySummarySkipEmpty)}
          onChange={(e) => update('dailySummarySkipEmpty', e.target.checked)}
        />
        Skip days with nothing to report
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={doPreview}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1a1a1a] border border-[#262626] text-[11px] font-bold uppercase text-[#ccc] hover:text-white"
        >
          <Eye size={13} /> Preview
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={doSend}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#7B2CBF] hover:bg-[#9D4EDD] text-[11px] font-bold uppercase text-white disabled:opacity-50"
        >
          <Send size={13} /> Send now
        </button>
      </div>
      {preview && <pre className="text-[11px] text-[#ccc] whitespace-pre-wrap bg-[#050505] rounded-md p-3 border border-[#1a1a1a]">{preview}</pre>}
      {msg && <div className={`text-[11px] ${msg.ok ? 'text-[#00FF41]' : 'text-[#FF4B2B]'}`}>{msg.text}</div>}
    </div>
  );
}
