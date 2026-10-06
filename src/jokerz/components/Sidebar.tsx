import { useEffect, useState, memo } from 'react';
import {
  LayoutDashboard,
  ListTodo,
  Users,
  Globe,
  Settings,
  UserPlus,
  BarChart3,
} from 'lucide-react';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'profiles', label: 'Profiles', icon: Users },
  { id: 'proxies', label: 'Proxies', icon: Globe },
  { id: 'results', label: 'Results', icon: BarChart3 },
  { id: 'account-gen', label: 'Account Gen', icon: UserPlus },
  { id: 'settings', label: 'Settings', icon: Settings },
] as const;

const API_BASE = import.meta.env.VITE_API_URL || '/jokerz-api';

function Sidebar({ activeTab, setActiveTab }: SidebarProps) {
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
        if (alive) setApiOk(res.ok);
      } catch {
        if (alive) setApiOk(false);
      }
    };
    check();
    const t = setInterval(check, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="w-[200px] bg-[#0a0a0a] border-r border-[#161616] flex flex-col h-screen text-[#888] shrink-0">
      <div className="px-4 pt-5 pb-5 flex items-center gap-2.5">
        <div className="w-8 h-8 bg-[#7B2CBF] rounded-lg flex items-center justify-center text-white font-black text-sm">
          J
        </div>
        <div className="leading-tight">
          <span className="text-white font-bold tracking-tight text-[13px]">JOKERZZZ</span>
          <span className="text-[#9D4EDD] font-bold tracking-tight text-[13px]"> AIO</span>
        </div>
      </div>

      <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors duration-100 text-[12px] font-medium ${
                isActive
                  ? 'bg-[#1a1a1a] text-white'
                  : 'text-[#777] hover:text-white hover:bg-[#121212]'
              }`}
            >
              <Icon
                className={`w-4 h-4 ${isActive ? 'text-white' : 'text-[#666]'}`}
                strokeWidth={isActive ? 2.25 : 2}
              />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="p-3 mt-auto">
        <div className="bg-[#121212] rounded-lg p-2.5 flex items-center justify-between border border-[#1a1a1a]">
          <div className="flex flex-col text-left min-w-0">
            <span className="text-[9px] text-[#555] font-semibold uppercase tracking-wider">
              Engine
            </span>
            <span
              className={`text-[11px] font-medium truncate ${
                apiOk === true
                  ? 'text-[#00FF41]'
                  : apiOk === false
                    ? 'text-[#FF4B2B]'
                    : 'text-[#555]'
              }`}
            >
              {apiOk === true ? 'Online' : apiOk === false ? 'Offline' : '…'}
            </span>
          </div>
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              apiOk === true ? 'bg-[#00FF41]' : apiOk === false ? 'bg-[#FF4B2B]' : 'bg-[#444]'
            }`}
          />
        </div>
      </div>
    </div>
  );
}

export default memo(Sidebar);
