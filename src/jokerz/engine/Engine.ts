import { bus } from './EventBus';
import { clearGroupProxyCooldowns, releaseSticky } from './proxy';
import { EngineCommand, EngineEvent, EngineTaskConfig, RunningTask, StoreModule, EngineStats } from './types';
import { WalmartModule } from './modules/walmart';
import { TargetModule } from './modules/target';
import { PokemonModule } from './modules/pokemon';
import { BandaiModule } from './modules/bandai';
import { TaskStatus } from '../types';
import { loadSettings } from '../lib/storage';
import { hydrateSessions } from './session';
import { hydrateProxyIntelligence } from './proxyIntelligence';
import { exponentialBackoff, staggerDelay, jitterDelay } from './notify';
import { httpRequest } from './http';
import { API_BASE } from './apiBase';

export class Engine {
  private tasks = new Map<string, RunningTask>();
  private modules = new Map<string, StoreModule>();
  private queue: string[] = [];
  private maxConcurrent = 5;
  private queueTimeoutMs = 300000;
  private queueTimeoutByPriority: Record<string, number> = {
    critical: 600000,
    high: 300000,
    normal: 180000,
    low: 60000,
  };
  private timeoutTimer?: ReturnType<typeof setInterval>;
  private stats: EngineStats = {
    activeTasks: 0,
    successToday: 0,
    failsToday: 0,
    totalCheckouts: 0,
  };
  /** Checkout/shipping tasks armed via Start — only run when monitor emits STOCK_DETECTED */
  private armedForStock = new Set<string>();
  private loggingIn = new Set<string>();
  private keepAliveTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Serialize Target logins so drop RL doesn't get 20 Sign-ins at once */
  private loginTail: Promise<void> = Promise.resolve();
  private unsub?: () => void;
  private started = false;

  constructor() {
    this.register(WalmartModule);
    this.register(TargetModule);
    this.register(PokemonModule);
    this.register(BandaiModule);
    try {
      const s = loadSettings();
      if (s.maxConcurrent && s.maxConcurrent > 0) this.maxConcurrent = s.maxConcurrent;
      if (typeof s.queueTimeoutMs === 'number') this.queueTimeoutMs = Math.max(0, s.queueTimeoutMs);
      if (s.queueTimeoutByPriority) {
        this.queueTimeoutByPriority = { ...this.queueTimeoutByPriority, ...s.queueTimeoutByPriority };
      }
    } catch { /* ignore */ }
  }

  private register(mod: StoreModule) {
    this.modules.set(mod.name.toLowerCase(), mod);
  }

  start() {
    if (this.started) return;
    this.started = true;
    hydrateSessions();
    hydrateProxyIntelligence();
    this.unsub = bus.onCommand((cmd) => this.handleCommand(cmd));
    bus.emit({ type: 'ENGINE_READY' });
    this.emitQueue();
    this.timeoutTimer = setInterval(() => this.expireTimedOutQueue(), 2000);
    console.log(
      '[Engine] Ready · maxConcurrent=' +
        this.maxConcurrent +
        ' · queueTimeoutMs=' +
        this.queueTimeoutMs
    );
  }

  stop() {
    if (this.timeoutTimer) clearInterval(this.timeoutTimer);
    this.queue = [];
    this.tasks.forEach((t) => t.abortController?.abort());
    this.tasks.clear();
    this.unsub?.();
  }

  private emit(event: EngineEvent) {
    bus.emit(event);
    if (event.type === 'TASK_STATUS') this.recountActive();
    if (event.type === 'CHECKOUT_SUCCESS') {
      this.stats.successToday++;
      this.stats.totalCheckouts++;
      this.armedForStock.delete(event.taskId);
      this.stopSessionKeepAlive(event.taskId);
      this.unbindTaskHarvest(event.taskId);
      this.emitStats();
    }
    if (event.type === 'CHECKOUT_FAILED') {
      this.stats.failsToday++;
      this.emitStats();
      // Stay armed — next monitor ping retries. Don't force user to Start/login again.
      if (this.tasks.get(event.taskId) && this.isCheckoutMode(this.tasks.get(event.taskId)!.config.mode)) {
        this.armedForStock.add(event.taskId);
      }
    }
    if (event.type === 'STOCK_DETECTED') {
      this.pingCheckoutTasks(event);
    }
  }

  private isCheckoutMode(mode?: string): boolean {
    const m = (mode || '').toLowerCase();
    if (!m || m === 'monitor' || m.includes('monitor')) return false;
    return ['checkout', 'shipping', 'preorder', 'pickup', 'guest', 'login', 'normal', 'cart'].some(
      (x) => m === x || m.includes(x)
    );
  }

  /**
   * Start monitor → runs now.
   * Start checkout → LOGIN on this task, save session, then wait for monitor IN STOCK.
   */
  private startOrArmTask(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t) {
      this.emit({ type: 'TASK_LOG', taskId, level: 'warn', message: 'Task not registered in engine.', ts: Date.now() });
      return;
    }
    const force =
      !!(t.config.extras as any)?.forceRunCheckout ||
      !!(t.config.extras as any)?.skipWaitMonitor;

    if (this.isCheckoutMode(t.config.mode) && !force) {
      void this.loginThenArm(taskId);
      return;
    }

    this.enqueueTask(taskId);
  }

  private staggerLogin<T>(fn: () => Promise<T>): Promise<T> {
    const wait = 10_000 + Math.floor(Math.random() * 8_000);
    const run = this.loginTail.then(async () => {
      await new Promise((r) => setTimeout(r, wait));
      return fn();
    });
    this.loginTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Login now (save session on this task) → arm until monitor pings the same TCIN/SKU. */
  private async loginThenArm(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (this.loggingIn.has(taskId)) return;
    this.loggingIn.add(taskId);
    const ac = new AbortController();
    t.abortController = ac;
    t.status = 'running';
    t.startedAt = Date.now();
    this.tasks.set(taskId, t);

    const prod = String(t.config.product || '').trim();
    const email = String((t.config.extras as any)?.accountEmail || '').trim();
    this.emit({
      type: 'TASK_STATUS',
      taskId,
      status: 'running',
      message: email ? `Login ${email}…` : 'Login…',
    });
    this.emit({
      type: 'TASK_LOG',
      taskId,
      level: 'info',
      message: `Task login · ${t.config.store} · ${email || 'account'} · stagger (drop RL)`,
      ts: Date.now(),
    });

    const mod = this.getModule(t.config.store);
    try {
      if (mod && typeof mod.login === 'function') {
        await this.staggerLogin(() => mod.login!(t.config, ac.signal, (e) => this.emit(e)));
      } else {
        this.emit({
          type: 'TASK_LOG',
          taskId,
          level: 'info',
          message: 'No dedicated login for this store — session will bind on stock ping',
          ts: Date.now(),
        });
      }
      if (ac.signal.aborted) return;
      this.armedForStock.add(taskId);
      t.status = 'queued';
      t.queuedAt = Date.now();
      this.tasks.set(taskId, t);
      this.startSessionKeepAlive(taskId);
      this.emit({
        type: 'TASK_STATUS',
        taskId,
        status: 'queued',
        message: 'Logged in · waiting TCIN',
      });
      this.emit({
        type: 'TASK_LOG',
        taskId,
        level: 'success',
        message: `Session SAVED on this task · waiting monitor IN STOCK · ${prod || 'SKU'}`,
        ts: Date.now(),
      });
      this.emitQueue();
    } catch (e: any) {
      if (e?.name === 'AbortError' || ac.signal.aborted) return;
      t.status = 'failed';
      this.tasks.set(taskId, t);
      this.emit({
        type: 'TASK_STATUS',
        taskId,
        status: 'failed',
        message: 'Login failed',
      });
      this.emit({
        type: 'TASK_LOG',
        taskId,
        level: 'error',
        message: e?.message || 'Login failed',
        ts: Date.now(),
      });
    } finally {
      this.loggingIn.delete(taskId);
    }
  }

  /** Monitor found stock → start matching *armed* checkout tasks (same store + TCIN/product) */
  private pingCheckoutTasks(event: {
    taskId: string;
    store: string;
    product: string;
    title?: string;
    price?: string;
  }) {
    const productKey = String(event.product || '').trim().toLowerCase();
    const digits = productKey.replace(/\D/g, '');
    const storeKey = String(event.store || '').trim().toLowerCase();

    let maxPerPing = 5;
    try {
      const s = loadSettings() as any;
      const n = Number(s.maxCheckoutPerStockPing ?? s.stockPingMaxCheckouts);
      if (Number.isFinite(n) && n > 0) maxPerPing = Math.min(20, Math.floor(n));
    } catch {
      /* default */
    }

    type Cand = { id: string; priority: number; status: string };
    const candidates: Cand[] = [];
    let busy = 0;
    let notArmed = 0;

    this.tasks.forEach((t, id) => {
      if (id === event.taskId) return;
      if (!this.isCheckoutMode(t.config.mode)) return;

      const st = (t.config.store || '').toLowerCase();
      if (
        storeKey &&
        st &&
        st !== storeKey &&
        !(st.includes('target') && storeKey.includes('target')) &&
        !(st.includes('bandai') && storeKey.includes('bandai')) &&
        !(st.includes('walmart') && storeKey.includes('walmart')) &&
        !(st.includes('pokemon') && storeKey.includes('pokemon'))
      )
        return;
      const prod = String(t.config.product || '').trim().toLowerCase();
      const prodDigits = prod.replace(/\D/g, '');
      const match =
        prod === productKey ||
        (productKey && prod.includes(productKey)) ||
        (prod && productKey.includes(prod)) ||
        (digits.length >= 4 &&
          prodDigits.length >= 4 &&
          (prodDigits.includes(digits) || digits.includes(prodDigits))) ||
        (digits.length >= 8 && prodDigits.includes(digits)) ||
        (prodDigits.length >= 8 && digits.includes(prodDigits));
      if (!match) return;

      // Must have been Started (armed) — otherwise skip
      if (!this.armedForStock.has(id) && !['queued'].includes(t.status)) {
        notArmed++;
        return;
      }
      // Accept armed even if status idle/queued/failed after previous run
      if (!this.armedForStock.has(id) && t.status === 'queued') {
        this.armedForStock.add(id);
      }

      if (!['idle', 'failed', 'success', 'oos', 'queued'].includes(t.status)) {
        busy++;
        this.emit({
          type: 'TASK_LOG',
          taskId: event.taskId,
          level: 'info',
          message: `Stock ping · checkout ${id.slice(0, 8)}… busy (${t.status}) — skip`,
          ts: Date.now(),
        });
        return;
      }
      const pri =
        typeof t.config.priority === 'number'
          ? t.config.priority
          : t.status === 'queued' || this.armedForStock.has(id)
            ? 2
            : 1;
      candidates.push({ id, priority: pri, status: t.status });
    });

    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.status === 'queued' && b.status !== 'queued') return -1;
      if (b.status === 'queued' && a.status !== 'queued') return 1;
      return 0;
    });

    let started = 0;
    for (const c of candidates) {
      if (started >= maxPerPing) break;
      // Stay armed: if ATC/bank fails, next IN STOCK ping retries without re-login.
      this.stopSessionKeepAlive(c.id);
      this.emit({
        type: 'TASK_LOG',
        taskId: c.id,
        level: 'success',
        message: `Ping from monitor ${event.taskId.slice(0, 8)}… · IN STOCK ${event.product}${event.price ? ` · ${event.price}` : ''} — starting checkout`,
        ts: Date.now(),
      });
      // Ensure not stuck as queued forever
      const rt = this.tasks.get(c.id);
      if (rt && rt.status === 'queued') {
        rt.status = 'idle';
        this.tasks.set(c.id, rt);
      }
      this.enqueueTask(c.id);
      started++;
    }

    const held = Math.max(0, candidates.length - started);
    this.emit({
      type: 'TASK_LOG',
      taskId: event.taskId,
      level: 'info',
      message:
        started > 0
          ? `Stock ping → started ${started}/${candidates.length} checkout(s) · maxPerPing=${maxPerPing}${held ? ` · ${held} held` : ''} · TCIN ${event.product}`
          : busy > 0
            ? 'Stock ping → matching checkouts busy (not idle)'
            : notArmed > 0
              ? `Stock ping → ${notArmed} checkout(s) match TCIN but not Started (arm with ▶ first)`
              : 'Stock ping → no checkout tasks matched (same store + TCIN). Create shipping task + Start it.',
      ts: Date.now(),
    });
  }


  private recountActive() {
    let active = 0;
    this.tasks.forEach((t) => {
      if (['running', 'carting', 'checkout'].includes(t.status)) active++;
    });
    this.stats.activeTasks = active;
    this.emitStats();
    this.emitQueue();
  }

  private emitStats() {
    bus.emit({ type: 'STATS_UPDATE', stats: { ...this.stats } });
  }

  private emitQueue() {
    bus.emit({
      type: 'QUEUE_UPDATE',
      queued: this.queue.length,
      running: this.countRunning(),
      maxConcurrent: this.maxConcurrent,
    });
  }

  private countRunning(): number {
    let n = 0;
    this.tasks.forEach((t) => {
      if (['running', 'carting', 'checkout'].includes(t.status)) n++;
    });
    return n;
  }

  private priorityScore(taskId: string): number {
    const t = this.tasks.get(taskId);
    if (!t) return 0;
    if (typeof t.config.priority === 'number') return t.config.priority;
    // auto: monitor > checkout modes
    const mode = (t.config.mode || '').toLowerCase();
    if (mode === 'monitor' || mode.includes('monitor')) return 2; // high
    return 1; // normal
  }

  /** Insert into queue sorted by priority desc, then FIFO among same priority */
  private enqueueByPriority(taskId: string) {
    const score = this.priorityScore(taskId);
    let idx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (score > this.priorityScore(this.queue[i])) {
        idx = i;
        break;
      }
    }
    this.queue.splice(idx, 0, taskId);
  }

  private handleCommand(cmd: EngineCommand) {
    switch (cmd.type) {
      case 'START_TASK':
        this.startOrArmTask(cmd.taskId);
        break;
      case 'STOP_TASK':
        this.armedForStock.delete(cmd.taskId);
        this.stopTask(cmd.taskId);
        break;
      case 'START_ALL': {
        const settings = loadSettings();
        const windowMs = settings.startStaggerMs ?? 2000;
        const ids: string[] = [];
        this.tasks.forEach((_, id) => {
          if (!cmd.store || this.tasks.get(id)?.config.store === cmd.store) ids.push(id);
        });
        ids.forEach((id, index) => {
          const delay = Math.floor((index / Math.max(1, ids.length)) * windowMs + Math.random() * (windowMs * 0.2));
          if (delay <= 0) {
            this.startOrArmTask(id);
          } else {
            this.emit({
              type: 'TASK_LOG',
              taskId: id,
              level: 'info',
              message: `Stagger start in ${delay}ms`,
              ts: Date.now(),
            });
            setTimeout(() => this.startOrArmTask(id), delay);
          }
        });
        break;
      }
      case 'STOP_ALL':
        this.queue = this.queue.filter((id) => {
          const t = this.tasks.get(id);
          if (!cmd.store || t?.config.store === cmd.store) {
            if (t) {
              t.status = 'idle';
              this.emit({ type: 'TASK_STATUS', taskId: id, status: 'idle', message: 'Removed from queue' });
            }
            return false;
          }
          return true;
        });
        this.tasks.forEach((_, id) => {
          if (!cmd.store || this.tasks.get(id)?.config.store === cmd.store) this.stopTask(id);
        });
        this.emitQueue();
        break;
      case 'DELETE_TASK':
        this.stopTask(cmd.taskId);
        this.tasks.delete(cmd.taskId);
        break;
      case 'CREATE_TASKS':
        cmd.tasks.forEach((cfg) => this.registerTask(cfg));
        break;
      case 'GET_STATUS':
        this.emitStats();
        this.emitQueue();
        break;
      case 'UPDATE_SETTINGS': {
        const s = (cmd as any).settings || {};
        if (typeof s.maxConcurrent === 'number' && s.maxConcurrent > 0) {
          this.maxConcurrent = Math.max(1, s.maxConcurrent);
        }
        if (typeof s.queueTimeoutMs === 'number') {
          this.queueTimeoutMs = Math.max(0, s.queueTimeoutMs);
        }
        if (s.queueTimeoutByPriority) {
          this.queueTimeoutByPriority = { ...this.queueTimeoutByPriority, ...s.queueTimeoutByPriority };
        }
        this.pumpQueue();
        this.emitQueue();
        break;
      }
      case 'SET_MAX_CONCURRENT':
        this.maxConcurrent = Math.max(1, cmd.value);
        this.pumpQueue();
        this.emitQueue();
        break;
    }
  }

  registerTask(config: EngineTaskConfig) {
    const existing = this.tasks.get(config.id);
    if (existing) {
      const busy = ['running', 'carting', 'checkout', 'queued'].includes(String(existing.status));
      if (busy) {
        // Queue config for next run — still merge non-runtime fields
        existing.config = {
          ...existing.config,
          ...config,
          // keep id stable
          id: existing.config.id,
        };
        return;
      }
      // Full replace so product/mode/proxy/extras always match UI edit
      existing.config = { ...config };
      existing.status = 'idle';
      existing.retryCount = 0;
      return;
    }
    this.tasks.set(config.id, { config: { ...config }, status: 'idle' });
  }

  private getModule(store: string): StoreModule | undefined {
    return this.modules.get(store.toLowerCase());
  }


  private scheduleRetry(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const settings = loadSettings();
    const max = Math.max(0, settings.maxRetries ?? 3);
    const count = t.retryCount || 0;
    if (count >= max) {
      this.emit({
        type: 'TASK_LOG',
        taskId,
        level: 'warn',
        message: `No more retries (${count}/${max})`,
        ts: Date.now(),
      });
      return;
    }
    t.retryCount = count + 1;
    const delay = exponentialBackoff(count, settings.errorDelay || 2000, 2, 120000);
    this.emit({
      type: 'TASK_LOG',
      taskId,
      level: 'info',
      message: `Retry ${t.retryCount}/${max} in ${Math.round(delay)}ms`,
      ts: Date.now(),
    });
    setTimeout(() => {
      const cur = this.tasks.get(taskId);
      if (!cur || cur.status === 'running') return;
      // re-enqueue with same priority
      cur.status = 'idle';
      this.enqueueTask(taskId);
    }, delay);
  }

  private enqueueTask(taskId: string) {
    const running = this.tasks.get(taskId);
    if (!running) {
      this.emit({ type: 'TASK_LOG', taskId, level: 'warn', message: 'Task not registered in engine.', ts: Date.now() });
      return;
    }
    if (['running', 'carting', 'checkout'].includes(running.status)) return;
    if (this.queue.includes(taskId)) return;

    const slots = this.countRunning();
    if (slots >= this.maxConcurrent) {
      this.enqueueByPriority(taskId);
      running.status = 'queued';
      running.queuedAt = Date.now();
      this.tasks.set(taskId, running);
      const pr = this.priorityScore(taskId);
      const prLabel = pr >= 3 ? 'critical' : pr >= 2 ? 'high' : pr >= 1 ? 'normal' : 'low';
      this.emit({ type: 'TASK_STATUS', taskId, status: 'queued', message: `Waiting in queue (${prLabel})` });
      this.emit({
        type: 'TASK_LOG',
        taskId,
        level: 'info',
        message: `Queued [${prLabel}] pos ~${this.queue.indexOf(taskId) + 1}/${this.queue.length} · ${slots}/${this.maxConcurrent} running`,
        ts: Date.now(),
      });
      this.emitQueue();
      return;
    }
    void this.runTaskNow(taskId);
  }


  private priorityLabel(score: number): 'critical' | 'high' | 'normal' | 'low' {
    if (score >= 3) return 'critical';
    if (score >= 2) return 'high';
    if (score >= 1) return 'normal';
    return 'low';
  }

  private timeoutForTask(taskId: string): number {
    const label = this.priorityLabel(this.priorityScore(taskId));
    const byPri = this.queueTimeoutByPriority[label];
    if (typeof byPri === 'number') return byPri;
    return this.queueTimeoutMs;
  }

  /** Drop tasks that waited too long in queue (per-priority limits) */
  private expireTimedOutQueue() {
    const now = Date.now();
    const kept: string[] = [];
    let changed = false;

    for (const taskId of this.queue) {
      const t = this.tasks.get(taskId);
      const limit = this.timeoutForTask(taskId);
      if (!limit || limit <= 0) {
        kept.push(taskId);
        continue;
      }
      const waited = t?.queuedAt ? now - t.queuedAt : 0;
      if (t && waited >= limit) {
        const label = this.priorityLabel(this.priorityScore(taskId));
        t.status = 'failed';
        t.queuedAt = undefined;
        this.emit({ type: 'TASK_STATUS', taskId, status: 'failed', message: 'Queue timeout' });
        this.emit({
          type: 'TASK_LOG',
          taskId,
          level: 'error',
          message: `Queue timeout [${label}] after ${Math.round(waited / 1000)}s (limit ${Math.round(limit / 1000)}s)`,
          ts: now,
        });
        this.emit({ type: 'CHECKOUT_FAILED', taskId, reason: `Queue timeout (${label})` });
        changed = true;
      } else {
        kept.push(taskId);
      }
    }

    if (changed) {
      this.queue = kept;
      this.emitQueue();
      this.recountActive();
    }
  }

  private pumpQueue() {
    const settings = loadSettings();
    const stagger = Math.min(1500, settings.startStaggerMs ?? 2000);
    let released = 0;
    while (this.queue.length > 0 && this.countRunning() + released < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const t = this.tasks.get(next);
      if (!t || t.status === 'running') continue;
      const delay = released === 0 ? 0 : staggerDelay(Math.max(200, Math.floor(stagger / 3)));
      released++;
      if (delay <= 0) {
        void this.runTaskNow(next);
      } else {
        // mark as still queued visually until start
        t.status = 'queued';
        this.emit({
          type: 'TASK_LOG',
          taskId: next,
          level: 'info',
          message: `Slot free — starting in ${delay}ms (anti-stampede)`,
          ts: Date.now(),
        });
        setTimeout(() => {
          const cur = this.tasks.get(next);
          if (!cur || cur.status === 'running') return;
          void this.runTaskNow(next);
        }, delay);
      }
    }
    this.emitQueue();
  }

  private async runTaskNow(taskId: string) {
    const running = this.tasks.get(taskId);
    if (!running) return;
    if (['running', 'carting', 'checkout'].includes(running.status)) return;

    const mod = this.getModule(running.config.store);
    if (!mod) {
      this.emit({ type: 'TASK_STATUS', taskId, status: 'failed', message: `No module for store: ${running.config.store}` });
      this.pumpQueue();
      return;
    }

    const validationError = mod.validate?.(running.config);
    if (validationError) {
      this.emit({ type: 'TASK_STATUS', taskId, status: 'failed', message: validationError });
      this.emit({ type: 'TASK_LOG', taskId, level: 'error', message: validationError, ts: Date.now() });
      this.pumpQueue();
      return;
    }

    const abort = new AbortController();
    running.abortController = abort;
    running.status = 'running';
    running.startedAt = Date.now();
    this.tasks.set(taskId, running);

    this.emit({ type: 'TASK_STATUS', taskId, status: 'running' });
    this.emit({
      type: 'TASK_LOG',
      taskId,
      level: 'info',
      message: `Started (${this.countRunning()}/${this.maxConcurrent} slots)`,
      ts: Date.now(),
    });
    this.emitQueue();

    try {
      await mod.run(running.config, abort.signal, (e) => this.emit(e));
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.emit({ type: 'TASK_STATUS', taskId, status: 'idle', message: 'Stopped' });
        this.emit({ type: 'TASK_LOG', taskId, level: 'warn', message: 'Task stopped by user', ts: Date.now() });
      } else {
        const msg = err?.message || 'Unknown error';
        this.emit({ type: 'TASK_STATUS', taskId, status: 'failed', message: msg });
        this.emit({ type: 'TASK_LOG', taskId, level: 'error', message: msg, ts: Date.now() });
      }
    } finally {
      const t = this.tasks.get(taskId);
      let shouldRetry = false;
      if (t) {
        t.abortController = undefined;
        const checkout = this.isCheckoutMode(t.config.mode);
        if (t.status === 'success') {
          this.armedForStock.delete(taskId);
          this.stopSessionKeepAlive(taskId);
        } else if (checkout && this.armedForStock.has(taskId) && t.status !== 'idle') {
          t.status = 'queued';
          this.startSessionKeepAlive(taskId);
          this.emit({
            type: 'TASK_STATUS',
            taskId,
            status: 'queued',
            message: 'Re-armed · waiting stock',
          });
          this.emit({
            type: 'TASK_LOG',
            taskId,
            level: 'info',
            message: 'ATC/bank did not close · session kept · waiting next IN STOCK ping',
            ts: Date.now(),
          });
        } else if (t.status === 'failed' && t.startedAt && !checkout) {
          shouldRetry = true;
        } else if (['running', 'carting', 'checkout', 'queued'].includes(t.status) && !this.armedForStock.has(taskId)) {
          t.status = 'idle';
        }
      }
      this.recountActive();
      this.pumpQueue();
      if (shouldRetry) this.scheduleRetry(taskId);
    }
  }

  private startSessionKeepAlive(taskId: string) {
    this.stopSessionKeepAlive(taskId);
    const tick = async () => {
      const t = this.tasks.get(taskId);
      if (!t || !this.armedForStock.has(taskId)) {
        this.stopSessionKeepAlive(taskId);
        return;
      }
      const mod = this.getModule(t.config.store);
      if (!mod || typeof (mod as any).keepAlive !== 'function') return;
      const ac = new AbortController();
      try {
        await (mod as any).keepAlive(t.config, ac.signal, (e: EngineEvent) => this.emit(e));
      } catch {
        /* next tick */
      }
    };
    const timer = setInterval(() => void tick(), 8 * 60 * 1000);
    this.keepAliveTimers.set(taskId, timer);
  }

  private stopSessionKeepAlive(taskId: string) {
    const t = this.keepAliveTimers.get(taskId);
    if (t) clearInterval(t);
    this.keepAliveTimers.delete(taskId);
  }

  private unbindTaskHarvest(taskId: string) {
    void httpRequest(`${API_BASE}/api/harvest/task-unbind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { taskId },
      timeoutMs: 8000,
    }).catch(() => {});
  }

  private stopTask(taskId: string) {
    this.stopSessionKeepAlive(taskId);
    this.unbindTaskHarvest(taskId);
    const qi = this.queue.indexOf(taskId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      const t = this.tasks.get(taskId);
      if (t) t.status = 'idle';
      this.emit({ type: 'TASK_STATUS', taskId, status: 'idle', message: 'Removed from queue' });
      this.emit({ type: 'TASK_LOG', taskId, level: 'warn', message: 'Removed from queue', ts: Date.now() });
      this.emitQueue();
      return;
    }
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.abortController?.abort();
    t.status = 'idle';
    this.emit({ type: 'TASK_STATUS', taskId, status: 'idle', message: 'Stopped' });
    this.pumpQueue();
  }

  syncTasks(configs: EngineTaskConfig[]) {
    configs.forEach((c) => this.registerTask(c));
  }

  getTaskStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }
}

export const engine = new Engine();
