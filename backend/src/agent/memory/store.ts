type MemoryKey = `${string}:${string}`;

export type AgentMemoryEntry<T = unknown> = {
  key: MemoryKey;
  agent: string;
  updatedAt: number;
  data: T;
};

class AgentMemoryStore {
  private snapshots = new Map<MemoryKey, AgentMemoryEntry>();

  private buildKey(agent: string, identifier: string): MemoryKey {
    return `${agent}:${identifier}`;
  }

  update<T>(agent: string, identifier: string, data: T): AgentMemoryEntry<T> {
    const key = this.buildKey(agent, identifier);
    const entry: AgentMemoryEntry<T> = {
      key,
      agent,
      updatedAt: Date.now(),
      data,
    };
    this.snapshots.set(key, entry);
    return entry;
  }

  get<T>(agent: string, identifier: string): AgentMemoryEntry<T> | null {
    const key = this.buildKey(agent, identifier);
    return (this.snapshots.get(key) as AgentMemoryEntry<T> | undefined) ?? null;
  }

  getAll(agent: string): AgentMemoryEntry[] {
    return Array.from(this.snapshots.values()).filter((entry) => entry.agent === agent);
  }

  /**
   * Get cached entry only if it's fresh (within maxAge)
   */
  getFresh<T>(agent: string, identifier: string, maxAgeMs: number): AgentMemoryEntry<T> | null {
    const entry = this.get<T>(agent, identifier);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > maxAgeMs) return null;
    return entry;
  }

  /**
   * Clear all entries for a specific agent
   */
  clearAgent(agent: string): void {
    for (const [key, entry] of this.snapshots.entries()) {
      if (entry.agent === agent) {
        this.snapshots.delete(key);
      }
    }
  }
}

export const agentMemoryStore = new AgentMemoryStore();
