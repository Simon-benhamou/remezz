import { agentEventBus } from '../../src/agent/bus/index.js';
import type { AgentEventName } from '../../src/agent/bus/events.js';

describe('AgentEventBus', () => {
  beforeEach(() => {
    (agentEventBus as any).removeAllListeners();
  });

  it('emits and receives typed payloads', async () => {
    const events: Array<{ name: AgentEventName; payload: unknown }> = [];
    const unsubscribe = agentEventBus.subscribe('marketQuality.updated', (payload) => {
      events.push({ name: 'marketQuality.updated', payload });
    });

    agentEventBus.emitEvent('marketQuality.updated', {
      symbol: 'BTC/USDT',
      sessionIds: ['session-1'],
      snapshot: {
        symbol: 'BTC/USDT',
        spreadBps: 4,
        bookDepthUsd: 500000,
        impactUsd: 250,
        score: 0.9,
        timestamp: Date.now(),
      },
    });

    unsubscribe();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.name).toBe('marketQuality.updated');
    expect((event.payload as any).symbol).toBe('BTC/USDT');
  });
});
