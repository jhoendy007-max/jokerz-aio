import { EngineEvent, EngineTaskConfig } from '../types';
import { TaskStatus } from '../../types';

/** Helper para sleep que respeta AbortSignal */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

export function log(
  emit: (e: EngineEvent) => void,
  taskId: string,
  level: 'info' | 'warn' | 'error' | 'success',
  message: string
) {
  emit({ type: 'TASK_LOG', taskId, level, message, ts: Date.now() });
}

export function setStatus(
  emit: (e: EngineEvent) => void,
  taskId: string,
  status: TaskStatus,
  message?: string
) {
  emit({ type: 'TASK_STATUS', taskId, status, message });
}

/**
 * Simula el flujo típico de un checkout para desarrollo de UI.
 * Más adelante cada módulo real reemplaza esto con requests reales.
 */
export async function simulateCheckoutFlow(
  task: EngineTaskConfig,
  signal: AbortSignal,
  emit: (e: EngineEvent) => void,
  steps: { name: string; delay: number; status?: string }[]
) {
  const id = task.id;

  for (const step of steps) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    log(emit, id, 'info', step.name);
    if (step.status) {
      setStatus(emit, id, step.status as any, step.name);
    }
    await sleep(step.delay, signal);
  }
}
