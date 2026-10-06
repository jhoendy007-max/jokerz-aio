import { useState, useCallback, useEffect, Component, type ReactNode, memo } from 'react';
import { startDropReminders } from './lib/drops';
import { startDailySummary } from './lib/dailySummaryRunner';
import { startWatchdogs } from './lib/monitorWatchdog';
import { startLogForwarder } from './lib/logForwarder';
import { startRemoteControl } from './lib/remoteControl';
import { startDropAutoStart } from './lib/drops';
import { bus, engine } from './engine';
import { loadTasks } from './lib/storage';
import { taskToEngineConfig } from './lib/taskConfig';
import { sendAlert, productPageUrl } from './engine/webhooks';
import { AnimatePresence, motion } from 'motion/react';
import Sidebar from './components/Sidebar';
import DashboardView from './components/DashboardView';
import TasksView from './components/TasksView';
import ProfilesView from './components/ProfilesView';
import ProxiesView from './components/ProxiesView';
import ResultsView from './components/ResultsView';
import SettingsView from './components/SettingsView';
import AccountGenView from './components/AccountGenView';

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8 text-[#E0E0E0] bg-[#050505] min-h-screen">
          <h1 className="text-xl font-bold text-[#FF4B2B] mb-2">UI error</h1>
          <pre className="text-xs text-[#888] whitespace-pre-wrap mb-4">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="px-4 py-2 bg-[#7B2CBF] rounded-md text-sm font-bold text-white"
            onClick={() => {
              try {
                localStorage.removeItem('jokerz_settings_tab');
                localStorage.setItem('jokerz_active_tab', 'tasks');
              } catch {}
              this.setState({ error: null });
              window.location.href = '/';
            }}
          >
            Reset view → Tasks
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Cheap page transitions — opacity + transform only (no filter/blur = less GPU). */
const pageTransition = {
  duration: 0.12,
  ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
};

const pageVariants = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: pageTransition,
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.12, ease: 'easeIn' as const },
  },
};

export default function App() {
  useEffect(() => startDailySummary(), []);
  useEffect(() => startWatchdogs(), []);
  useEffect(() => startLogForwarder(), []);
  useEffect(() => startRemoteControl(), []);
  // Drop calendar: start linked MONITOR tasks a few minutes before the drop (checkout tasks are never auto-started).
  useEffect(
    () =>
      startDropAutoStart((ids, d) => {
        const tasks = loadTasks([]).filter((t) => ids.includes(t.id) && String(t.mode || '').toLowerCase().includes('monitor'));
        if (!tasks.length) return;
        engine.start();
        bus.send({ type: 'CREATE_TASKS', tasks: tasks.map(taskToEngineConfig) });
        tasks.forEach((t) => bus.send({ type: 'START_TASK', taskId: t.id }));
        void sendAlert('info', { store: d.store, product: d.product || d.title, title: d.title, status: 'MONITORS STARTED', extra: `Started ${tasks.length} monitor task(s) ${d.autoStartMin ?? 10} min before the drop.` });
      }),
    [],
  );
  // Drop reminders run app-wide (not only while the Dashboard is open).
  useEffect(
    () =>
      startDropReminders((d) =>
        sendAlert('info', {
          store: d.store,
          product: d.product || d.title,
          title: d.title,
          status: `DROP IN ${d.remindMin} MIN`,
          extra: `${new Date(d.at).toLocaleString()}${d.note ? ` · ${d.note}` : ''}`,
          productUrl: d.product ? (/^https?:\/\//i.test(d.product) ? d.product : productPageUrl(d.store, d.product)) : undefined,
        }),
      ),
    [],
  );
  const [activeTab, setActiveTab] = useState(() => {
    try {
      return localStorage.getItem('jokerz_active_tab') || 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  const changeTab = useCallback((id: string) => {
    setActiveTab(id);
    try {
      localStorage.setItem('jokerz_active_tab', id);
    } catch {
      /* ignore */
    }
  }, []);

  const renderView = () => {
    switch (activeTab) {
      case 'dashboard':
        return <DashboardView />;
      case 'tasks':
        return <TasksView />;
      case 'profiles':
        return <ProfilesView />;
      case 'proxies':
        return <ProxiesView />;
      case 'results':
        return <ResultsView />;
      case 'account-gen':
        return <AccountGenView />;
      case 'settings':
        return <SettingsView />;
      default:
        return <DashboardView />;
    }
  };

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-[#E0E0E0] overflow-hidden font-sans antialiased selection:bg-[#7B2CBF]/30">
      <Sidebar activeTab={activeTab} setActiveTab={changeTab} />
      <main className="flex-1 overflow-y-auto relative bg-[#0a0a0a]">
        <ErrorBoundary>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="min-h-full"
              style={{ willChange: 'opacity, transform' }}
            >
              {renderView()}
            </motion.div>
          </AnimatePresence>
        </ErrorBoundary>
      </main>
    </div>
  );
}
