import { EngineEvent, EngineCommand } from './types';

type EventHandler = (event: EngineEvent) => void;
type CommandHandler = (cmd: EngineCommand) => void;

/**
 * Bus simple para comunicar UI ↔ Engine.
 * En el futuro se puede reemplazar por WebSocket / IPC sin cambiar el resto del código.
 */
export class EventBus {
  private eventListeners = new Set<EventHandler>();
  private commandListeners = new Set<CommandHandler>();

  // UI se suscribe a eventos del engine
  onEvent(handler: EventHandler): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  // Engine emite eventos
  emit(event: EngineEvent) {
    this.eventListeners.forEach((h) => {
      try {
        h(event);
      } catch (e) {
        console.error('[EventBus] listener error', e);
      }
    });
  }

  // Engine se suscribe a comandos del UI
  onCommand(handler: CommandHandler): () => void {
    this.commandListeners.add(handler);
    return () => this.commandListeners.delete(handler);
  }

  // UI envía comandos
  send(cmd: EngineCommand) {
    this.commandListeners.forEach((h) => {
      try {
        h(cmd);
      } catch (e) {
        console.error('[EventBus] command handler error', e);
      }
    });
  }
}

// Singleton compartido
export const bus = new EventBus();
