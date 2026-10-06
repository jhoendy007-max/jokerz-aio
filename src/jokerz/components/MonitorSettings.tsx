import { Activity } from 'lucide-react';
import type { BotSettings } from '../lib/storage';

type Props = {
  settings: BotSettings;
  update: <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => void;
  inputClass: string;
};

/** Settings for adaptive polling (#2), monitor watchdog (#3) and session alerts (#8). */
export default function MonitorSettings({ settings, update, inputClass }: Props) {
  const box = (label: string, key: 'adaptivePolling' | 'monitorStallAlerts' | 'sessionExpiryAlerts', help: string) => (
    <label className="flex items-start gap-2 text-[12px] text-white cursor-pointer">
      <input type="checkbox" className="mt-0.5" checked={settings[key] !== false} onChange={(e) => update(key, e.target.checked)} />
      <span>
        {label}
        <span className="block text-[11px] text-[#888]">{help}</span>
      </span>
    </label>
  );
  return (
    <div className="rounded-lg border border-[#1f1f1f] bg-[#0a0a0a] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity size={14} className="text-[#7B2CBF]" />
        <span className="text-[11px] uppercase font-bold text-white tracking-wide">Monitors &amp; sessions</span>
      </div>
      {box(
        'Adaptive polling',
        'adaptivePolling',
        'Checks less often when a product has not changed for a while (×1.5 after 10 min, ×2 after 30 min, ×3 after 2 h, max 2 min) and goes back to your delay 30 min before a scheduled drop. Never faster than your delay.',
      )}
      {box('Alert when a monitor stalls', 'monitorStallAlerts', 'Discord message when a monitor gets stuck, and another when it recovers.')}
      <div className="grid grid-cols-2 gap-3 pl-6">
        <div>
          <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">Stalled after (minutes without a valid response)</label>
          <input
            type="number"
            min={1}
            max={120}
            value={settings.monitorStallMinutes ?? 5}
            onChange={(e) => update('monitorStallMinutes', Math.max(1, Math.min(120, Number(e.target.value) || 5)))}
            className={inputClass}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase font-bold text-[#555] mb-2 block">…or after this many errors in a row</label>
          <input
            type="number"
            min={2}
            max={200}
            value={settings.monitorStallErrors ?? 10}
            onChange={(e) => update('monitorStallErrors', Math.max(2, Math.min(200, Number(e.target.value) || 10)))}
            className={inputClass}
          />
        </div>
      </div>
      {box('Alert when a session expires', 'sessionExpiryAlerts', 'Discord message when an account session has less than 1 h left and when it has expired.')}
    </div>
  );
}
