import { useEffect, useCallback, useRef } from 'react';
import { engine, bus, EngineEvent, EngineTaskConfig, EngineStats } from '../engine';
import { TaskStatus } from '../types';

interface UseEngineOptions {
  onStatus?: (taskId: string, status: TaskStatus, message?: string) => void;
  onLog?: (taskId: string, level: string, message: string) => void;
  onCheckout?: (taskId: string, data: any) => void;
  onStats?: (stats: EngineStats) => void;
  onQueue?: (q: { queued: number; running: number; maxConcurrent: number }) => void;
}

/**
 * Hook para conectar el UI con el Engine.
 * Arranca el engine una sola vez y reenvía eventos a callbacks.
 */
export function useEngine(options: UseEngineOptions = {}) {
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    engine.start();

    const unsub = bus.onEvent((event: EngineEvent) => {
      const o = optsRef.current;
      switch (event.type) {
        case 'TASK_STATUS':
          o.onStatus?.(event.taskId, event.status, event.message);
          break;
        case 'TASK_LOG':
          o.onLog?.(event.taskId, event.level, event.message);
          break;
        case 'CHECKOUT_SUCCESS':
          o.onCheckout?.(event.taskId, event.data);
          o.onStatus?.(event.taskId, 'success');
          break;
        case 'CHECKOUT_FAILED':
          o.onStatus?.(event.taskId, 'failed', event.reason);
          break;
        case 'STATS_UPDATE':
          o.onStats?.(event.stats);
          break;
        case 'QUEUE_UPDATE':
          o.onQueue?.(event);
          break;
        case 'ENGINE_READY':
          console.log('[UI] Engine ready');
          break;
        case 'ENGINE_ERROR':
          console.error('[UI] Engine error:', event.message);
          break;
      }
    });

    return () => {
      unsub();
      // No paramos el engine al desmontar una vista (puede haber otras)
    };
  }, []);

  const startTask = useCallback((taskId: string) => {
    bus.send({ type: 'START_TASK', taskId });
  }, []);

  const stopTask = useCallback((taskId: string) => {
    bus.send({ type: 'STOP_TASK', taskId });
  }, []);

  const startAll = useCallback((store?: string) => {
    bus.send({ type: 'START_ALL', store });
  }, []);

  const stopAll = useCallback((store?: string) => {
    bus.send({ type: 'STOP_ALL', store });
  }, []);

  const registerTasks = useCallback((configs: EngineTaskConfig[]) => {
    bus.send({ type: 'CREATE_TASKS', tasks: configs });
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    bus.send({ type: 'DELETE_TASK', taskId });
  }, []);

  return {
    startTask,
    stopTask,
    startAll,
    stopAll,
    registerTasks,
    deleteTask,
  };
}
