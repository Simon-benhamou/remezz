export type SelectorDecision = {
  sessionId: string;
  symbol: string;
  mode: string;
  agentName: string;
  agentFamily: string | null;
  regime: string | null;
  totalTrades: number;
  netPnlUsd: number;
  winRate: number;
  avgLatencyMs: number | null;
  avgSlippageBps: number | null;
  normalizedScore: number;
  rawScore: number | null;
  sampleWindows: number[];
  latestBucketStart: number;
  reason: string;
  decision: 'promote' | 'demote' | 'hold' | 'insufficient';
};

export type SelectorSnapshot = {
  generatedAt: number;
  source: 'selector_agent';
  combosEvaluated: number;
  promotions: SelectorDecision[];
  demotions: SelectorDecision[];
  watchlist: SelectorDecision[];
  suppressed: SelectorDecision[];
  stats: {
    lookbackMinutes: number;
    minTrades: number;
    promoteThreshold: number;
    demoteThreshold: number;
  };
};

export type SelectorSnapshotResponse = {
  ok: boolean;
  snapshot: SelectorSnapshot | null;
  refreshedAt?: number;
  reason?: string;
  code?: string;
  message?: string;
};
