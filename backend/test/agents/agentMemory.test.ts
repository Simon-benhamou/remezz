import { agentMemoryStore } from '../../src/agent/memory/store.js';

describe('AgentMemoryStore', () => {
  it('stores and retrieves snapshots per agent', () => {
    const entry = agentMemoryStore.update('marketQuality', 'BTC/USDT', { score: 0.8 });
    expect(entry.key).toBe('marketQuality:BTC/USDT');

    const retrieved = agentMemoryStore.get<typeof entry.data>('marketQuality', 'BTC/USDT');
    expect(retrieved?.data.score).toBe(0.8);
  });

  it('returns null when snapshot missing', () => {
    const missing = agentMemoryStore.get('sentiment', 'NOPE');
    expect(missing).toBeNull();
  });
});
