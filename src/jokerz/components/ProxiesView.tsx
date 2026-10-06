import { useState, useEffect, useCallback, memo } from 'react';
import { Globe, Plus, Trash2, Settings2, Activity, RefreshCw, ShieldOff, Eraser } from 'lucide-react';
import { loadProxies, saveProxies, ProxyGroup } from '../lib/storage';
import { loadProxyHealth, saveProxyHealth, applyTestResults, isDead, DEAD_AFTER } from '../lib/proxyHealth';
import {
  recordProxyResult,
  getProxyIntelligenceSummary,
  resetProxyIntelligence,
  clearProxyScoreBan,
  hydrateProxyIntelligence,
  persistProxyScoresNow,
} from '../engine/proxyIntelligence';

const defaultProxyGroups: ProxyGroup[] = [
  {
    id: '1',
    name: 'DC-Resi',
    count: 0,
    type: 'Residential',
    status: 'Online',
    proxies: [],
    rotation: 'random',
    cooldownMs: 45000,
    stickyMinutes: 5,
  },
  {
    id: '2',
    name: 'ISPs-VA',
    count: 0,
    type: 'ISP',
    status: 'Online',
    proxies: [],
    rotation: 'least-used',
    cooldownMs: 120000,
    stickyMinutes: 10,
  },
  { id: '3', name: 'Localhost', count: 1, type: 'Local', status: 'Online', proxies: [] },
];

type Rotation = NonNullable<ProxyGroup['rotation']>;

const PROXY_KINDS: {
  id: string;
  type: string;
  label: string;
  hint: string;
  rotation: Rotation;
  cooldownSec: number;
  stickyMin: number;
}[] = [
  {
    id: 'resi-rotating',
    type: 'Residential',
    label: 'Residential rotating',
    hint: 'Gateway Decodo / Aurum / Hype · IP cambia',
    rotation: 'random',
    cooldownSec: 45,
    stickyMin: 5,
  },
  {
    id: 'resi-sticky',
    type: 'Residential',
    label: 'Residential sticky',
    hint: 'Same IP per session · acc gen / signup',
    rotation: 'sticky',
    cooldownSec: 45,
    stickyMin: 10,
  },
  {
    id: 'mobile',
    type: 'Mobile',
    label: 'Mobile',
    hint: '4G/5G · PKC / hard Shape',
    rotation: 'random',
    cooldownSec: 60,
    stickyMin: 5,
  },
  {
    id: 'isp',
    type: 'ISP',
    label: 'ISP',
    hint: 'Monitor + checkout Target · no para acc gen',
    rotation: 'least-used',
    cooldownSec: 120,
    stickyMin: 10,
  },
  {
    id: 'dc',
    type: 'Datacenter',
    label: 'Datacenter',
    hint: 'Cheap · Target burns these',
    rotation: 'round-robin',
    cooldownSec: 90,
    stickyMin: 0,
  },
];

function ProxiesView() {
  const [proxyGroups, setProxyGroups] = useState<ProxyGroup[]>(() => loadProxies(defaultProxyGroups));
  const [showAdd, setShowAdd] = useState(false);
  const [addStep, setAddStep] = useState<'type' | 'form'>('type');
  const [editId, setEditId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('ISP');
  const [newRotation, setNewRotation] = useState<Rotation>('least-used');
  const [newCooldownSec, setNewCooldownSec] = useState(120);
  const [newStickyMin, setNewStickyMin] = useState(10);
  const [newProxies, setNewProxies] = useState('');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testReport, setTestReport] = useState<{
    groupId?: string;
    groupName: string;
    passed: number;
    failed: number;
    avgMs?: number;
    results: { proxy?: string; display?: string; ok: boolean; ms?: number; exitIp?: string; error?: string; country?: string; city?: string; speed?: string }[];
  } | null>(null);
  const [proxyHealth, setProxyHealth] = useState(() => loadProxyHealth());
  const removeDead = (groupId?: string) => {
    if (!groupId) return;
    const g = proxyGroups.find((x) => x.id === groupId);
    if (!g) return;
    const dead = (g.proxies || []).filter((l) => isDead(proxyHealth[l.trim()]));
    if (!dead.length || !window.confirm(`Remove ${dead.length} dead proxy line(s) from "${g.name}"? (failed ${DEAD_AFTER}+ tests in a row)`)) return;
    const keep = (g.proxies || []).filter((l) => !isDead(proxyHealth[l.trim()]));
    setProxyGroups((prev) => prev.map((x) => (x.id === groupId ? { ...x, proxies: keep, count: keep.length } : x)));
  };
  const [scoreFilter, setScoreFilter] = useState<'all' | 'banned' | 'ok'>('all');
  const [scoreGroup, setScoreGroup] = useState<string>('all');
  const [scoreRows, setScoreRows] = useState<
    {
      key: string;
      score: number;
      success: number;
      blocked: number;
      fail: number;
      avgMs: number;
      lastResult: string;
      lastProvider?: string;
      banRemainingMs: number;
      consecutiveBlocks: number;
    }[]
  >([]);

  const API_BASE = import.meta.env.VITE_API_URL || '/jokerz-api';

  const refreshScores = useCallback(() => {
    try {
      hydrateProxyIntelligence();
      const allProxies = proxyGroups.flatMap((g) => {
        if (scoreGroup !== 'all' && g.name !== scoreGroup) return [];
        return g.proxies || [];
      });
      // If filter is all groups, still show any scored keys even outside lists
      const unique = [...new Set(allProxies.map((p) => p.trim()).filter(Boolean))];
      let rows = getProxyIntelligenceSummary(
        unique.length
          ? unique
          : proxyGroups.flatMap((g) => g.proxies || []).filter(Boolean)
      );
      // Also include orphan scores from storage that match filter
      if (scoreGroup === 'all') {
        const extra = getProxyIntelligenceSummary(
          proxyGroups.flatMap((g) => g.proxies || []).filter(Boolean)
        );
        const seen = new Set(rows.map((r) => r.key));
        for (const r of extra) {
          if (!seen.has(r.key)) rows.push(r);
        }
      }
      if (scoreFilter === 'banned') {
        rows = rows.filter((r) => (r.banRemainingMs || 0) > 0);
      } else if (scoreFilter === 'ok') {
        rows = rows.filter((r) => (r.banRemainingMs || 0) <= 0);
      }
      setScoreRows(rows);
    } catch {
      setScoreRows([]);
    }
  }, [proxyGroups, scoreFilter, scoreGroup]);

  useEffect(() => {
    refreshScores();
    const t = setInterval(refreshScores, 5000);
    return () => clearInterval(t);
  }, [refreshScores]);

  const testProxyGroup = async (group: ProxyGroup) => {
    const list = (group.proxies || []).map((x) => x.trim()).filter(Boolean);
    if (list.length === 0) {
      setTestReport({
        groupName: group.name,
        passed: 0,
        failed: 0,
        results: [{ ok: false, error: 'No proxies in group — paste list and save' }],
      });
      return;
    }
    setTestingId(group.id);
    setTestReport(null);
    try {
      const res = await fetch(`${API_BASE}/api/proxy/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies: list.slice(0, 200), connectivityOnly: true }),
      });
      const data = await res.json();
      if (!data.ok && data.error) {
        setTestReport({
          groupName: group.name,
          passed: 0,
          failed: list.length,
          results: [{ ok: false, error: data.error }],
        });
      } else {
        setTestReport({
          groupId: group.id,
          groupName: group.name,
          passed: data.passed || 0,
          failed: data.failed || 0,
          avgMs: data.avgMs,
          results: data.results || [],
        });
        const nextHealth = applyTestResults(loadProxyHealth(), data.results || []);
        saveProxyHealth(nextHealth);
        setProxyHealth(nextHealth);
        for (const r of data.results || []) {
          if (r.proxy) {
            recordProxyResult(r.proxy, {
              ok: !!r.ok,
              blocked: !!r.blocked,
              ms: r.ms,
            });
          }
        }
        // mark group status
        setProxyGroups((prev) =>
          prev.map((g) =>
            g.id === group.id
              ? {
                  ...g,
                  status: data.passed > 0 ? 'Online' : 'Degraded',
                }
              : g
          )
        );
      }
    } catch (e: any) {
      setTestReport({
        groupName: group.name,
        passed: 0,
        failed: 1,
        results: [{ ok: false, error: e?.message || 'Backend offline — npm run server' }],
      });
    } finally {
      setTestingId(null);
    }
  };


  useEffect(() => {
    saveProxies(proxyGroups);
  }, [proxyGroups]);

  const pickKind = (k: (typeof PROXY_KINDS)[number]) => {
    setNewType(k.type);
    setNewRotation(k.rotation);
    setNewCooldownSec(k.cooldownSec);
    setNewStickyMin(k.stickyMin);
    setAddStep('form');
  };

  const handleAddGroup = () => {
    if (!newName.trim()) return;
    const lines = newProxies
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const group: ProxyGroup = {
      id: Math.random().toString(36).substr(2, 9),
      name: newName.trim(),
      count: lines.length || 0,
      type: newType,
      status: 'Online',
      proxies: lines,
      rotation: newRotation,
      cooldownMs: newCooldownSec * 1000,
      stickyMinutes: newStickyMin,
    };

    setProxyGroups((prev) => [...prev, group]);
    setShowAdd(false);
    setAddStep('type');
    setNewName('');
    setNewProxies('');
  };

  const deleteGroup = (id: string) => {
    setProxyGroups((prev) => prev.filter((g) => g.id !== id));
  };

  const updateGroup = (id: string, patch: Partial<ProxyGroup>) => {
    setProxyGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  };

  const editing = proxyGroups.find((g) => g.id === editId);

  return (
    <div className="p-4 h-full flex flex-col gap-4 animate-in fade-in duration-200 relative">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black italic uppercase tracking-tighter text-white">Proxies</h1>
          <p className="text-[#555] text-[10px] mt-1 uppercase font-bold tracking-widest">
            ISP groups · least-used + sticky · cooldown on block
          </p>
        </div>
        <button
          onClick={() => {
            setAddStep('type');
            setNewName('');
            setNewProxies('');
            setShowAdd(true);
          }}
          className="flex items-center gap-2 bg-[#7B2CBF] hover:bg-[#9D4EDD] text-white px-6 py-2 text-sm font-black uppercase tracking-wider transition-colors skew-x-[-12deg]"
        >
          <span className="skew-x-[12deg] flex items-center gap-2">
            <Plus size={16} /> Add Group
          </span>
        </button>
      </div>

      <div className="bg-[#0F0F0F] border border-[#1A1A1A] p-4 rounded-sm text-[11px] text-[#888] leading-relaxed space-y-2">
        <p>
          <span className="text-[#00FF41] font-bold uppercase tracking-widest">ISP:</span> use{' '}
          <span className="text-white">least-used</span> on monitor and{' '}
          <span className="text-white">sticky</span> (10–15 min) on checkout. Cooldown 90–180s after 429/block.
        </p>
        <p>
          <span className="text-[#7B2CBF] font-bold uppercase tracking-widest">Residential:</span>{' '}
          typical{' '}
          <span className="text-white font-mono text-[10px]">user-session-XXXX:pass@gate.provider:port</span>
          {' '}or rotating gateway. Defaults: <span className="text-white">random</span> · CD{' '}
          <span className="text-white">45s</span> · sticky <span className="text-white">5m</span>.
          Static lists → switch rotation to <span className="text-white">intelligent</span>.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {proxyGroups.map((group) => (
          <div
            key={group.id}
            className="bg-[#0F0F0F] border-t border-[#1A1A1A] p-5 hover:border-[#00FF41] transition-colors group relative"
          >
            <div className="absolute top-4 right-4 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => setEditId(group.id)}
                className="text-[#555] hover:text-[#7B2CBF] p-1 rounded-sm hover:bg-[#7B2CBF]/10"
                title="Rotation settings"
              >
                <Settings2 size={16} />
              </button>
              <button
                onClick={() => deleteGroup(group.id)}
                className="text-[#555] hover:text-[#FF4B2B] p-1 rounded-sm hover:bg-[#FF4B2B]/10"
                title="Delete group"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="w-10 h-10 bg-[#0e0915] rounded-sm border border-[#1A1A1A] flex items-center justify-center text-[#7B2CBF] mb-4">
              <Globe size={18} />
            </div>
            <h3 className="text-white font-bold uppercase">{group.name}</h3>
            <p className="text-[#555] text-[10px] font-bold uppercase tracking-widest mt-1">
              {group.proxies?.length || group.count || 0} proxies · {group.type}
            </p>
            <p className="text-[10px] font-bold uppercase tracking-widest mt-2 text-[#888]">
              Rot: <span className="text-[#00FF41]">{group.rotation || (group.type === 'ISP' ? 'least-used' : 'global')}</span>
              {group.cooldownMs != null && (
                <> · CD {Math.round((group.cooldownMs || 0) / 1000)}s</>
              )}
              {group.stickyMinutes != null && group.stickyMinutes > 0 && (
                <> · sticky {group.stickyMinutes}m</>
              )}
            </p>

            <div className="mt-4 pt-4 border-t border-[#1A1A1A] flex items-center justify-between">
              <span className="px-2 py-0.5 rounded-sm bg-green-500/10 text-[#00FF41] border border-[#00FF41]/20 text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00FF41]" />
                {group.status}
              </span>
              {(() => {
                const dead = (group.proxies || []).filter((l) => isDead(proxyHealth[l.trim()])).length;
                return dead ? <span className="text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B]">{dead} dead</span> : null;
              })()}
              <button
                type="button"
                onClick={() => testProxyGroup(group)}
                disabled={testingId === group.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm border border-[#1A1A1A] hover:border-[#7B2CBF] text-[10px] font-bold uppercase tracking-widest text-[#ccc] hover:text-white disabled:opacity-50"
                title="Test speed, exit IP and country (max 200 lines)"
              >
                <RefreshCw size={11} className={testingId === group.id ? 'animate-spin' : ''} />
                {testingId === group.id ? 'Testing…' : 'Test'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Proxy intelligence scores panel ── */}
      <div className="bg-[#0F0F0F] border border-[#1A1A1A] rounded-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-[#1A1A1A]">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-[#7B2CBF]" />
            <h2 className="text-sm font-black uppercase tracking-widest text-white">Proxy Scores</h2>
            <span className="text-[10px] font-bold text-[#555] uppercase tracking-widest">
              {scoreRows.length} tracked · persists in browser
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={scoreGroup}
              onChange={(e) => setScoreGroup(e.target.value)}
              className="bg-[#0e0915] border border-[#1A1A1A] text-[10px] font-bold uppercase tracking-widest text-[#E0E0E0] px-2 py-1.5 rounded-sm"
            >
              <option value="all">All groups</option>
              {proxyGroups.map((g) => (
                <option key={g.id} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
            <select
              value={scoreFilter}
              onChange={(e) => setScoreFilter(e.target.value as 'all' | 'banned' | 'ok')}
              className="bg-[#0e0915] border border-[#1A1A1A] text-[10px] font-bold uppercase tracking-widest text-[#E0E0E0] px-2 py-1.5 rounded-sm"
            >
              <option value="all">All scores</option>
              <option value="banned">Banned only</option>
              <option value="ok">Active only</option>
            </select>
            <button
              type="button"
              onClick={() => refreshScores()}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#E0E0E0] hover:text-white border border-[#1A1A1A] hover:border-[#7B2CBF]/50 rounded-sm"
            >
              <RefreshCw size={12} /> Refresh
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm('Reset ALL proxy scores? Bans and latency history will be cleared.')) {
                  resetProxyIntelligence();
                  refreshScores();
                }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[#FF4B2B]/80 hover:text-[#FF4B2B] border border-red-900/40 hover:border-red-500/40 rounded-sm"
            >
              <Eraser size={12} /> Reset all
            </button>
          </div>
        </div>

        <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-[#15101c] z-10">
              <tr className="border-b border-[#1A1A1A]">
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Proxy</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Score</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">OK</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Block</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Fail</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Avg ms</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Last</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Provider</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Ban</th>
                <th className="p-3 text-[10px] font-bold text-[#555] uppercase tracking-widest">Actions</th>
              </tr>
            </thead>
            <tbody>
              {scoreRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-6 text-center text-[11px] text-[#555]">
                    No scores yet — run monitors or Test Group to build history
                  </td>
                </tr>
              )}
              {scoreRows.map((r) => {
                const banned = (r.banRemainingMs || 0) > 0;
                const banMin = banned ? Math.ceil(r.banRemainingMs / 60000) : 0;
                const scoreColor =
                  r.score >= 40 ? 'text-[#00FF41]' : r.score >= 10 ? 'text-yellow-400' : 'text-[#FF4B2B]';
                return (
                  <tr
                    key={r.key}
                    className={`border-b border-[#1A1A1A] hover:bg-[#7B2CBF]/5 ${
                      banned ? 'bg-[#FF4B2B]/10' : ''
                    }`}
                  >
                    <td className="p-3 text-[11px] font-mono text-[#E0E0E0] max-w-[180px] truncate" title={r.key}>
                      {r.key}
                    </td>
                    <td className={`p-3 text-[11px] font-black ${scoreColor}`}>{r.score}</td>
                    <td className="p-3 text-[11px] text-[#00FF41]">{r.success}</td>
                    <td className="p-3 text-[11px] text-[#FF4B2B]">{r.blocked}</td>
                    <td className="p-3 text-[11px] text-[#888]">{r.fail}</td>
                    <td className="p-3 text-[11px] text-[#888]">{r.avgMs || '—'}</td>
                    <td className="p-3 text-[10px] uppercase font-bold tracking-wider text-[#888]">
                      {r.lastResult}
                      {r.consecutiveBlocks > 1 ? ` · ×${r.consecutiveBlocks}` : ''}
                    </td>
                    <td className="p-3 text-[10px] uppercase font-bold tracking-wider text-[#555]">
                      {r.lastProvider || '—'}
                    </td>
                    <td className="p-3 text-[10px] font-bold uppercase tracking-wider">
                      {banned ? (
                        <span className="text-[#FF4B2B]">BAN {banMin}m</span>
                      ) : (
                        <span className="text-[#555]">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      {banned && (
                        <button
                          type="button"
                          title="Clear ban for this IP"
                          onClick={() => {
                            clearProxyScoreBan(r.key);
                            persistProxyScoresNow();
                            refreshScores();
                          }}
                          className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-yellow-400/90 hover:text-yellow-300"
                        >
                          <ShieldOff size={12} /> Unban
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {testReport && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setTestReport(null)}>
          <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-2xl p-6 shadow-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white uppercase tracking-wider">Proxy Test · {testReport.groupName}</h2>
              <button onClick={() => setTestReport(null)} className="text-[#555] hover:text-white text-sm font-bold">✕</button>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#555] mb-4">
              <span className="text-[#00FF41]">{testReport.passed} passed</span>
              {' · '}
              <span className="text-[#FF4B2B]">{testReport.failed} failed</span>
              {testReport.avgMs ? <span> · avg {testReport.avgMs}ms</span> : null}
            </p>
            {(() => {
              const dead = testReport.results.filter((r) => r.proxy && isDead(proxyHealth[r.proxy.trim()])).length;
              return dead ? (
                <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-sm border border-red-500/30 bg-red-500/10">
                  <span className="text-[10px] text-[#ffb4a8]">
                    {dead} proxy line(s) failed {DEAD_AFTER}+ tests in a row (dead)
                  </span>
                  <button type="button" onClick={() => removeDead(testReport.groupId)} className="text-[10px] font-bold uppercase tracking-widest text-white bg-[#FF4B2B]/80 hover:bg-[#FF4B2B] px-2.5 py-1 rounded-sm">
                    Remove dead
                  </button>
                </div>
              ) : null;
            })()}
            <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
              {testReport.results.map((r, i) => (
                <div
                  key={i}
                  className={`text-[10px] font-mono px-3 py-2 rounded-sm border ${
                    r.ok
                      ? 'border-[#00FF41]/20 bg-[#00FF41]/5 text-[#E0E0E0]'
                      : 'border-red-500/20 bg-[#FF4B2B]/10 text-[#888]'
                  }`}
                >
                  <span className={r.ok ? 'text-[#00FF41]' : 'text-[#FF4B2B]'}>{r.ok ? 'OK' : 'FAIL'}</span>
                  {' '}{r.display || 'proxy'}
                  {r.ms != null && <span className="text-[#555]"> · {r.ms}ms</span>}
                  {r.speed && <span className={r.speed === 'fast' ? 'text-[#00FF41]' : r.speed === 'slow' ? 'text-amber-400' : 'text-[#aaa]'}> · {r.speed}</span>}
                  {r.exitIp && <span className="text-[#555]"> · ip {r.exitIp}</span>}
                  {(r.country || r.city) && <span className="text-[#888]"> · {[r.city, r.country].filter(Boolean).join(', ')}</span>}
                  {r.error && <span className="text-[#FF4B2B]"> · {r.error}</span>}
                  {r.proxy && proxyHealth[r.proxy.trim()]?.fails ? (
                    <span className={isDead(proxyHealth[r.proxy.trim()]) ? 'text-[#FF4B2B] font-bold' : 'text-amber-400'}> · {isDead(proxyHealth[r.proxy.trim()]) ? 'DEAD' : `${proxyHealth[r.proxy.trim()].fails}× fail`}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            {addStep === 'type' ? (
              <>
                <h2 className="text-xl font-black uppercase italic text-white tracking-tight">Proxy type</h2>
                <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest mt-1 mb-5">
                  Pick first · Acc gen only accepts Residential / Mobile
                </p>
                <div className="grid grid-cols-1 gap-2">
                  {PROXY_KINDS.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      onClick={() => pickKind(k)}
                      className={`text-left px-4 py-3 rounded-sm border transition-colors ${
                        k.type === 'Residential'
                          ? 'border-[#7B2CBF]/50 hover:border-[#7B2CBF] bg-[#7B2CBF]/10'
                          : 'border-[#1A1A1A] hover:border-[#7B2CBF]/40 bg-[#0F0F0F]'
                      }`}
                    >
                      <div className="text-sm font-black uppercase tracking-widest text-white">{k.label}</div>
                      <div className="text-[10px] text-[#888] mt-0.5">{k.hint}</div>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="mt-5 text-[10px] font-bold uppercase tracking-widest text-[#555] hover:text-white"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setAddStep('type')}
                  className="text-[10px] font-bold uppercase tracking-widest text-[#7B2CBF] mb-3"
                >
                  ← change type
                </button>
                <h2 className="text-xl font-bold text-white mb-1">Add Proxy Group</h2>
                <p className="text-[10px] font-bold uppercase tracking-widest text-[#888] mb-5">
                  {newType} · {newRotation} · CD {newCooldownSec}s
                </p>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">Group Name*</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={newType === 'Residential' ? 'e.g. Resi-Sticky-Gen' : 'e.g. ISPs-Comcast-FL'}
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">Rotation</label>
                <select
                  value={newRotation}
                  onChange={(e) => setNewRotation(e.target.value as Rotation)}
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF] appearance-none"
                >
                  <option value="least-used">Least-used (best for ISP monitor)</option>
                  <option value="intelligent">Intelligent (score + explore)</option>
                  <option value="round-robin">Round-robin</option>
                  <option value="random">Random</option>
                  <option value="sticky">Sticky (checkout / acc gen)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">Cooldown (sec)</label>
                  <input
                    type="number"
                    min={0}
                    value={newCooldownSec}
                    onChange={(e) => setNewCooldownSec(Number(e.target.value) || 0)}
                    className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">Sticky (min)</label>
                  <input
                    type="number"
                    min={0}
                    value={newStickyMin}
                    onChange={(e) => setNewStickyMin(Number(e.target.value) || 0)}
                    className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#7B2CBF]"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">Proxies (one per line)</label>
                <textarea
                  value={newProxies}
                  onChange={(e) => setNewProxies(e.target.value)}
                  rows={6}
                  placeholder={'user:pass@host:port\nhost:port'}
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-[#7B2CBF]"
                />
              </div>
              <div className="flex gap-3 justify-end pt-2">
                <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-xs font-bold uppercase text-[#888]">
                  Cancel
                </button>
                <button
                  onClick={handleAddGroup}
                  disabled={!newName.trim()}
                  className="px-6 py-2 bg-[#7B2CBF] hover:bg-[#9D4EDD] disabled:opacity-40 text-white text-xs font-bold uppercase tracking-widest rounded-sm"
                >
                  Save Group
                </button>
              </div>
            </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Edit rotation modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#15101c] border border-[#1A1A1A] rounded-xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-white mb-1 uppercase">{editing.name}</h2>
            <p className="text-[10px] text-[#555] font-bold uppercase tracking-widest mb-4">
              {editing.type} · rotation settings
            </p>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">Rotation</label>
                <select
                  value={editing.rotation || 'least-used'}
                  onChange={(e) => updateGroup(editing.id, { rotation: e.target.value as Rotation })}
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white appearance-none"
                >
                  <option value="least-used">Least-used</option>
                  <option value="intelligent">Intelligent</option>
                  <option value="round-robin">Round-robin</option>
                  <option value="random">Random</option>
                  <option value="sticky">Sticky</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">Cooldown (sec)</label>
                  <input
                    type="number"
                    value={Math.round((editing.cooldownMs ?? 120000) / 1000)}
                    onChange={(e) =>
                      updateGroup(editing.id, { cooldownMs: (Number(e.target.value) || 0) * 1000 })
                    }
                    className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-[#888] mb-2 block">Sticky (min)</label>
                  <input
                    type="number"
                    value={editing.stickyMinutes ?? 10}
                    onChange={(e) => updateGroup(editing.id, { stickyMinutes: Number(e.target.value) || 0 })}
                    className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-[#888] mb-2 block">Replace proxy list (optional)</label>
                <textarea
                  rows={4}
                  defaultValue={(editing.proxies || []).join('\n')}
                  onBlur={(e) => {
                    const lines = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
                    updateGroup(editing.id, { proxies: lines, count: lines.length });
                  }}
                  className="w-full bg-[#0F0F0F] border border-gray-700/50 rounded-lg px-4 py-2.5 text-sm text-white font-mono"
                />
              </div>
              <button
                onClick={() => setEditId(null)}
                className="w-full py-2.5 bg-[#7B2CBF] hover:bg-[#9D4EDD] text-white text-xs font-bold uppercase tracking-widest rounded-sm"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ProxiesView);
