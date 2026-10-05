import { useEffect, useRef, useState } from 'react';
import { Bot, Send, Sparkles, Terminal, Trash2 } from 'lucide-react';
import { loadSettings, saveSettings } from '../lib/storage';

const API_BASE = import.meta.env.VITE_API_URL || '/jokerz-api';

type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  actions?: unknown[];
  ts: number;
};

const QUICK = [
  { label: 'Browser status', text: '/browser' },
  { label: 'Health', text: '/health' },
  { label: 'JA3 check', text: '/ja3' },
  { label: 'Target tips', text: 'How do I set up a Target monitor with ISP and Chrome session?' },
  { label: 'PKC queue', text: 'Explain how the bot handles the Pokemon Center queue' },
];

export default function AssistantView() {
  const settings = loadSettings() as {
    xaiApiKey?: string;
    xaiModel?: string;
  };
  const [apiKey, setApiKey] = useState(settings.xaiApiKey || '');
  const [model, setModel] = useState(settings.xaiModel || 'grok-3');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: 'welcome',
      role: 'system',
      content:
        'Grok Assistant · /health /browser /ja3 work without a key. For full chat, paste your xAI API key below (saved to Settings on send).',
      ts: Date.now(),
    },
  ]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, busy]);

  const persistKey = () => {
    const cur = loadSettings() as any;
    saveSettings({ ...cur, xaiApiKey: apiKey, xaiModel: model });
  };

  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput('');
    persistKey();
    const userMsg: Msg = {
      id: Math.random().toString(36).slice(2),
      role: 'user',
      content: message,
      ts: Date.now(),
    };
    setMsgs((m) => [...m, userMsg]);
    setBusy(true);
    try {
      const history = msgs
        .filter((x) => x.role === 'user' || x.role === 'assistant')
        .slice(-10)
        .map((x) => ({ role: x.role, content: x.content }));
      const res = await fetch(`${API_BASE}/api/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history,
          apiKey: apiKey || undefined,
          model,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setMsgs((m) => [
          ...m,
          {
            id: Math.random().toString(36).slice(2),
            role: 'assistant',
            content: `Error: ${data.error || res.status}`,
            ts: Date.now(),
          },
        ]);
      } else {
        let content = data.reply || '';
        if (data.actions?.length) {
          content +=
            '\n\n—— actions ——\n' +
            data.actions.map((a: any) => JSON.stringify(a, null, 0)).join('\n');
        }
        setMsgs((m) => [
          ...m,
          {
            id: Math.random().toString(36).slice(2),
            role: 'assistant',
            content,
            actions: data.actions,
            ts: Date.now(),
          },
        ]);
      }
    } catch (e: any) {
      setMsgs((m) => [
        ...m,
        {
          id: Math.random().toString(36).slice(2),
          role: 'assistant',
          content: `Backend offline or network error: ${e?.message || e}`,
          ts: Date.now(),
        },
      ]);
    }
    setBusy(false);
  };

  return (
    <div className="p-6 h-full flex flex-col gap-4 animate-in fade-in duration-300">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black italic uppercase tracking-tighter text-white flex items-center gap-2">
            <Sparkles className="text-[#7B2CBF]" size={22} /> Grok Assistant
          </h1>
          <p className="text-[#555] text-[10px] mt-1 uppercase font-bold tracking-widest">
            xAI API · acciones seguras del bot
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="xAI API key"
            className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-sm px-3 py-2 text-xs text-white w-56 font-mono"
          />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-sm px-2 py-2 text-[10px] font-bold uppercase tracking-widest text-[#E0E0E0]"
          >
            <option value="grok-3">grok-3</option>
            <option value="grok-3-mini">grok-3-mini</option>
            <option value="grok-2">grok-2</option>
          </select>
          <button
            type="button"
            onClick={() => setMsgs((m) => m.filter((x) => x.id === 'welcome'))}
            className="p-2 text-[#555] hover:text-white"
            title="Clear chat"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => send(q.text)}
            className="text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-sm border border-[#1A1A1A] text-[#888] hover:text-white hover:border-[#7B2CBF]"
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 bg-[#0F0F0F] border border-[#1A1A1A] rounded-sm overflow-y-auto p-4 space-y-3">
        {msgs.map((m) => (
          <div
            key={m.id}
            className={`max-w-[90%] rounded-sm px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === 'user'
                ? 'ml-auto bg-[#7B2CBF]/25 border border-purple-700/40 text-white'
                : m.role === 'system'
                  ? 'bg-black/30 border border-[#1A1A1A] text-[#888] text-xs'
                  : 'bg-[#0e0915] border border-[#1A1A1A] text-gray-200'
            }`}
          >
            <div className="flex items-center gap-2 mb-1 text-[9px] font-bold uppercase tracking-widest text-[#555]">
              {m.role === 'user' ? 'You' : m.role === 'system' ? 'System' : (
                <span className="flex items-center gap-1 text-purple-300">
                  <Bot size={12} /> Grok
                </span>
              )}
            </div>
            {m.content}
          </div>
        ))}
        {busy && (
          <div className="text-[10px] font-bold uppercase tracking-widest text-purple-400 flex items-center gap-2">
            <Terminal size={12} className="animate-pulse" /> Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Pregunta o /browser /health /ja3…"
          className="flex-1 bg-[#0F0F0F] border border-[#1A1A1A] rounded-sm px-4 py-3 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="px-5 py-3 bg-[#7B2CBF] hover:bg-[#9D4EDD] disabled:opacity-40 text-white rounded-sm"
        >
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
