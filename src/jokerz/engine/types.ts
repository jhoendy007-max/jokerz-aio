import { Store, TaskStatus } from '../types';

// ─── Commands que el UI envía al Engine ────────────────────────────
export type EngineCommand =
  | { type: 'START_TASK'; taskId: string }
  | { type: 'STOP_TASK'; taskId: string }
  | { type: 'START_ALL'; store?: string }
  | { type: 'STOP_ALL'; store?: string }
  | { type: 'DELETE_TASK'; taskId: string }
  | { type: 'CREATE_TASKS'; tasks: EngineTaskConfig[] }
  | { type: 'UPDATE_SETTINGS'; settings: Record<string, unknown> }
  | { type: 'GET_STATUS' }
  | { type: 'SET_MAX_CONCURRENT'; value: number };

// ─── Events que el Engine emite hacia el UI ────────────────────────
export type EngineEvent =
  | { type: 'TASK_STATUS'; taskId: string; status: TaskStatus; message?: string }
  | { type: 'TASK_LOG'; taskId: string; level: 'info' | 'warn' | 'error' | 'success'; message: string; ts: number }
  | { type: 'CHECKOUT_SUCCESS'; taskId: string; data: CheckoutResult }
  | { type: 'CHECKOUT_FAILED'; taskId: string; reason: string }
  | { type: 'STOCK_DETECTED'; taskId: string; store: string; product: string; title?: string; price?: string; productUrl?: string }
  | { type: 'ENGINE_READY' }
  | { type: 'ENGINE_ERROR'; message: string }
  | { type: 'STATS_UPDATE'; stats: EngineStats }
  | { type: 'QUEUE_UPDATE'; queued: number; running: number; maxConcurrent: number };

export interface CheckoutResult {
  orderNumber: string;
  product: string;
  store: string;
  profile: string;
  price: string;
  quantity: number;
  dryRun?: boolean;
}

export interface EngineStats {
  activeTasks: number;
  successToday: number;
  failsToday: number;
  totalCheckouts: number;
}

// ─── Config que se pasa al crear una task en el engine ─────────────
export interface EngineTaskConfig {
  id: string;
  store: Store | string;
  mode: string; // checkout | monitor | shipping | pickup | guest | login
  product: string; // SKU, TCIN, URL, PID
  profileId: string;
  proxyGroup: string;
  quantity: number;
  delay: number;
  /** 0=low 1=normal 2=high 3=critical — higher first */
  priority?: number;
  // Store-specific extras
  extras?: Record<string, unknown>;
}

// ─── Estado interno de una task en el engine ───────────────────────
export interface RunningTask {
  config: EngineTaskConfig;
  status: TaskStatus;
  startedAt?: number;
  queuedAt?: number;
  retryCount?: number;
  lastUpdate?: number;
  abortController?: AbortController;
}

// ─── Interface que cada módulo de tienda debe implementar ──────────
export interface StoreModule {
  name: string;
  supportedModes: string[];

  /** Arranca una task. Debe emitir eventos vía el callback. */
  run(
    task: EngineTaskConfig,
    signal: AbortSignal,
    emit: (event: EngineEvent) => void
  ): Promise<void>;

  /** Validación rápida antes de arrancar */
  validate?(task: EngineTaskConfig): string | null;

  /**
   * Refract-style: login + persist session on THIS task, before waiting for stock.
   * Checkout `run()` should reuse the saved session (fromCache).
   */
  login?(
    task: EngineTaskConfig,
    signal: AbortSignal,
    emit: (event: EngineEvent) => void
  ): Promise<void>;

  /** Refresh persisted session while armed waiting for stock. */
  keepAlive?(
    task: EngineTaskConfig,
    signal: AbortSignal,
    emit: (event: EngineEvent) => void
  ): Promise<void>;
}
