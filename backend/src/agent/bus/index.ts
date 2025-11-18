import { EventEmitter } from 'events';
import type { AgentEventMap, AgentEventName, AgentEventPayload } from './events.js';

class AgentEventBus extends EventEmitter {
  emitEvent<E extends AgentEventName>(event: E, payload: AgentEventPayload<E>): boolean {
    return super.emit(event, payload);
  }

  subscribe<E extends AgentEventName>(event: E, handler: (payload: AgentEventPayload<E>) => void): () => void {
    this.on(event, handler as any);
    return () => this.off(event, handler as any);
  }
}

export const agentEventBus = new AgentEventBus();
