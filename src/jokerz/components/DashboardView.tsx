import { useCallback, useEffect, useState, memo } from 'react';
import {
  ShoppingCart,
  XCircle,
  CheckCircle2,
  Clock,
  Check,
} from 'lucide-react';
import { useEngine } from '../hooks/useEngine';
import {
  loadCheckouts,
  saveDashboardStats,
  loadDashboardStats,
  addCheckout,
  defaultDashboardStats,
  type StoredCheckout,
  type DashboardStats,
} from '../lib/storage';
import type { EngineStats } from '../engine/types';

function formatMoney(n: number) {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function DashboardView() {
  const [stats, setStats] = useState<DashboardStats>(() => loadDashboardStats(defaultDashboardStats));
  const [checkouts, setCheckouts] = useState<StoredCheckout[]>(() => loadCheckouts());

  useEffect(() => {
    if (checkouts.length > 0) {
      localStorage.setItem('jokerz_aio_checkouts', JSON.stringify(checkouts.slice(0, 50)));
    }
  }, [checkouts]);

  useEffect(() => {
    saveDashboardStats(stats);
  }, [stats]);

  const onStats = useCallback((engineStats: EngineStats) => {
    setStats((prev) => ({
      ...prev,
      activeTasks: engineStats.activeTasks,
      successToday: engineStats.successToday,
      failsToday: engineStats.failsToday,
      totalCheckouts: Math.max(prev.totalCheckouts, engineStats.totalCheckouts),
    }));
  }, []);

  const onCheckout = useCallback((_taskId: string, data: any) => {
    const priceNum = parseFloat(String(data.price || '0').replace(/[^0-9.]/g, '')) || 0;
    const entry: StoredCheckout = {
      id: _taskId + '-' + Date.now(),
      store: data.store || 'Unknown',
      product: data.product || 'Product',
      orderNumber: data.orderNumber || '—',
      quantity: String(data.quantity || 1),
      profile: data.profile || '—',
      date: 'Just now',
      price: data.price || formatMoney(priceNum),
      ts: Date.now(),
    };
    addCheckout(entry);
    setCheckouts((prev) => [entry, ...prev].slice(0, 50));
    setStats((prev) => ({
      ...prev,
      totalCheckouts: prev.totalCheckouts + 1,
      successToday: prev.successToday + 1,
      totalSpent: prev.totalSpent + priceNum,
    }));
  }, []);

  useEngine({ onStats, onCheckout });

  const successful = stats.successToday || stats.totalCheckouts;
  const declined = stats.failedCheckouts || stats.failsToday;

  const statCards = [
    {
      label: 'TOTAL CHECKOUTS',
      value: (stats.totalCheckouts || 0).toLocaleString(),
      icon: ShoppingCart,
      iconBg: 'bg-[#00FF41]/15',
      iconColor: 'text-[#00FF41]',
    },
    {
      label: 'SUCCESSFUL',
      value: String(successful),
      icon: CheckCircle2,
      iconBg: 'bg-[#00FF41]/15',
      iconColor: 'text-[#00FF41]',
    },
    {
      label: 'DECLINED',
      value: String(declined),
      icon: XCircle,
      iconBg: 'bg-[#FF4B2B]/15',
      iconColor: 'text-[#FF4B2B]',
    },
    {
      label: 'RUNNING TASKS',
      value: String(stats.activeTasks || 0),
      icon: Clock,
      iconBg: 'bg-[#7B2CBF]/20',
      iconColor: 'text-[#C77DFF]',
    },
  ];

  return (
    <div className="p-5 space-y-4 max-w-[1400px] mx-auto min-h-full">
      {/* Header */}
      <div>
        <h1 className="text-xl font-black italic uppercase tracking-tighter text-white">Dashboard</h1>
        <p className="text-[10px] text-[#555] mt-1 uppercase font-bold tracking-widest">Checkouts · running tasks</p>
      </div>

      {/* Stat cards — 4 equal */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {statCards.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.label}
              className="rounded-lg bg-[#121212] border border-[#1c1c1c] px-4 py-3 flex items-center gap-3"
            >
              <div className={`w-8 h-8 rounded-md ${c.iconBg} flex items-center justify-center shrink-0`}>
                <Icon size={16} className={c.iconColor} strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <div className="text-xl font-semibold text-white tracking-tight tabular-nums">
                  {c.value}
                </div>
                <div className="text-[10px] font-medium text-[#555] uppercase tracking-wider">
                  {c.label}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom: Recent + Upcoming */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent checkouts */}
        <div className="rounded-lg bg-[#121212] border border-[#1c1c1c] p-4 min-h-[240px]">
          <h3 className="text-[11px] font-semibold text-[#666] uppercase tracking-wider mb-4">
            Recent Checkouts
          </h3>
          <div className="space-y-2">
            {checkouts.slice(0, 8).map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-xl bg-[#0a0a0a] border border-[#1a1a1a] px-4 py-3"
              >
                <div className="w-9 h-9 rounded-lg bg-[#7B2CBF]/15 flex items-center justify-center shrink-0">
                  <ShoppingCart size={16} className="text-[#9D4EDD]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{c.product}</div>
                  <div className="text-[11px] text-[#555] truncate">
                    {c.store}
                    {c.profile && c.profile !== '—' ? ` · ${c.profile}` : ''}
                  </div>
                </div>
                <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#00FF41]/15 text-[#00FF41] text-[10px] font-bold uppercase tracking-wide">
                  <Check size={12} strokeWidth={3} />
                  Success
                </span>
              </div>
            ))}
            {checkouts.length === 0 && (
              <div className="py-16 text-center text-[#444] text-sm">No checkouts yet</div>
            )}
          </div>
        </div>

        {/* Upcoming drops */}
        <div className="rounded-2xl bg-[#121212] border border-[#1c1c1c] p-5 min-h-[320px] flex flex-col">
          <h3 className="text-[11px] font-semibold text-[#666] uppercase tracking-wider mb-4">
            Upcoming Drops
          </h3>
          <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-[#222] rounded-xl">
            <Clock size={32} className="text-[#333] mb-3" strokeWidth={1.5} />
            <p className="text-[11px] font-medium text-[#444] uppercase tracking-wider">
              No upcoming drops scheduled
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(DashboardView);
