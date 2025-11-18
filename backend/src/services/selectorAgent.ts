import { EventEmitter } from 'events';

import { prisma } from '../db/client.js';
import { broadcast } from '../ws/hub.js';

const SELECTOR_EVENT = 'selector.snapshot';
const emitter = new EventEmitter();

const DEFAULT_REFRESH_MS = Math.max(30_000, Number(process.env.SELECTOR_REFRESH_MS || '60000'));
const LOOKBACK_MINUTES = Number(process.env.SELECTOR_LOOKBACK_MINUTES || '1440');
const WINDOW_WEIGHTS: Record<number, number> = {
  60: 3,
  360: 2,
  1440: 1,
};
const DEFAULT_WINDOW_WEIGHT = 1;
const MIN_TRADES = Math.max(1, Number(process.env.SELECTOR_MIN_TRADES || '3'));
const PROMOTE_THRESHOLD = Number(process.env.SELECTOR_PROMOTE_THRESHOLD || '0.25');
const DEMOTE_THRESHOLD = Number(process.env.SELECTOR_DEMOTE_THRESHOLD || '-0.15');

let refreshTimer: NodeJS.Timeout | null = null;
let latestSnapshot: SelectorSnapshot | null = null;

type LedgerRow = Awaited<ReturnType<typeof prisma.agentPerformanceLedger.findMany>>[number];

type AggregatedCombo = {
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
  decision: SelectorDecisionFlag;
};

type SelectorDecisionFlag = 'promote' | 'demote' | 'hold' | 'insufficient';

export type SelectorDecision = AggregatedCombo;

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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function windowWeight(minutes: number | null | undefined): number {
  if (!minutes) return DEFAULT_WINDOW_WEIGHT;
  return WINDOW_WEIGHTS[minutes] ?? DEFAULT_WINDOW_WEIGHT;
}

function normalizeScore(rawScore: number | null, netPnlUsd: number, tradeCount: number): number {
  if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
    return clamp(rawScore / 100, -1, 1);
  }
  if (!tradeCount) return 0;
  const perTrade = netPnlUsd / tradeCount;
  return clamp(perTrade / 50, -1, 1);
}

function aggregateCombo(rows: LedgerRow[]): AggregatedCombo {
  const head = rows[0];
  const weightedScoreSum = rows.reduce((sum, row) => sum + (row.score ?? 0) * windowWeight(row.windowMinutes), 0);
  const totalWeight = rows.reduce((sum, row) => sum + windowWeight(row.windowMinutes), 0) || 1;
  const totalTrades = rows.reduce((sum, row) => sum + Number(row.tradeCount ?? 0), 0);
  const netPnlUsd = rows.reduce((sum, row) => sum + Number(row.netPnlUsd ?? 0), 0);
  const wins = rows.reduce((sum, row) => sum + Number(row.winRate ?? 0) * Number(row.tradeCount ?? 0), 0);
  const avgLatencyMs = rows.reduce((sum, row) => sum + Number(row.avgLatencyMs ?? 0), 0);
  const avgSlippageBps = rows.reduce((sum, row) => sum + Number(row.avgSlippageBps ?? 0), 0);

  const normalizedScore = normalizeScore(weightedScoreSum / totalWeight, netPnlUsd, totalTrades);
  const winRate = totalTrades ? clamp(wins / totalTrades, 0, 1) : 0;
  const latestBucketStart = Math.max(...rows.map((row) => row.bucketStart.getTime()));
  const reasonParts: string[] = [];
  reasonParts.push(`trades=${totalTrades}`);
  reasonParts.push(`winRate=${(winRate * 100).toFixed(1)}%`);
  reasonParts.push(`net=${netPnlUsd.toFixed(2)} USD`);
  reasonParts.push(`score=${normalizedScore.toFixed(2)}`);

  const decision = pickDecision(totalTrades, normalizedScore);

  return {
    sessionId: head.sessionId,
    symbol: head.symbol,
    mode: head.mode,
    agentName: head.agentName,
    agentFamily: head.agentFamily ?? null,
    regime: head.regime ?? null,
    totalTrades,
    netPnlUsd,
    winRate,
    avgLatencyMs: rows.length ? avgLatencyMs / rows.length : null,
    avgSlippageBps: rows.length ? avgSlippageBps / rows.length : null,
    normalizedScore,
    rawScore: totalWeight ? weightedScoreSum / totalWeight : null,
    sampleWindows: Array.from(new Set(rows.map((row) => row.windowMinutes))).sort((a, b) => a - b),
    latestBucketStart,
    reason: reasonParts.join(' · '),
    decision,
  };
}

function pickDecision(totalTrades: number, normalizedScore: number): SelectorDecisionFlag {
  if (totalTrades < MIN_TRADES) return 'insufficient';
  if (normalizedScore >= PROMOTE_THRESHOLD) return 'promote';
  if (normalizedScore <= DEMOTE_THRESHOLD) return 'demote';
  return 'hold';
}

function summarizeCombos(rows: LedgerRow[]): AggregatedCombo[] {
  const grouped = rows.reduce<Map<string, LedgerRow[]>>((acc, row) => {
    const key = `${row.sessionId}__${row.symbol}`;
    const bucket = acc.get(key);
    if (bucket) bucket.push(row);
    else acc.set(key, [row]);
    return acc;
  }, new Map());

  return Array.from(grouped.values()).map((rowsForCombo) => aggregateCombo(rowsForCombo));
}

function selectTop(decisions: AggregatedCombo[], flag: SelectorDecisionFlag, limit: number, desc = true) {
  const filtered = decisions.filter((combo) => combo.decision === flag);
  const sorted = filtered.sort((a, b) => (desc ? b.normalizedScore - a.normalizedScore : a.normalizedScore - b.normalizedScore));
  return sorted.slice(0, limit);
}

export async function computeSelectorSnapshot(): Promise<SelectorSnapshot> {
  const now = Date.now();
  const lookbackStart = new Date(now - LOOKBACK_MINUTES * 60_000);
  const rows = await prisma.agentPerformanceLedger.findMany({
    where: {
      bucketStart: { gte: lookbackStart },
    },
    orderBy: { bucketStart: 'desc' },
    take: 2000,
  });

  if (!rows.length) {
    return {
      generatedAt: now,
      source: 'selector_agent',
      combosEvaluated: 0,
      promotions: [],
      demotions: [],
      watchlist: [],
      suppressed: [],
      stats: {
        lookbackMinutes: LOOKBACK_MINUTES,
        minTrades: MIN_TRADES,
        promoteThreshold: PROMOTE_THRESHOLD,
        demoteThreshold: DEMOTE_THRESHOLD,
      },
    };
  }

  const combos = summarizeCombos(rows);
  const promotions = selectTop(combos, 'promote', 8, true);
  const demotions = selectTop(combos, 'demote', 8, false);
  const watchlist = combos
    .filter((combo) => combo.decision === 'hold')
    .sort((a, b) => b.totalTrades - a.totalTrades)
    .slice(0, 12);
  const suppressed = combos
    .filter((combo) => combo.decision === 'insufficient')
    .sort((a, b) => b.totalTrades - a.totalTrades)
    .slice(0, 12);

  return {
    generatedAt: now,
    source: 'selector_agent',
    combosEvaluated: combos.length,
    promotions,
    demotions,
    watchlist,
    suppressed,
    stats: {
      lookbackMinutes: LOOKBACK_MINUTES,
      minTrades: MIN_TRADES,
      promoteThreshold: PROMOTE_THRESHOLD,
      demoteThreshold: DEMOTE_THRESHOLD,
    },
  };
}

export function getSelectorSnapshot(): SelectorSnapshot | null {
  return latestSnapshot;
}

export function onSelectorSnapshot(listener: (snapshot: SelectorSnapshot) => void) {
  emitter.on(SELECTOR_EVENT, listener);
  return () => emitter.off(SELECTOR_EVENT, listener);
}

export async function refreshSelectorSnapshot(reason = 'manual'): Promise<SelectorSnapshot> {
  const snapshot = await computeSelectorSnapshot();
  latestSnapshot = snapshot;
  emitter.emit(SELECTOR_EVENT, snapshot);
  broadcast('selector.snapshot', { ...snapshot, reason });
  return snapshot;
}

export function startSelectorAgentLoop(intervalMs = DEFAULT_REFRESH_MS) {
  if (process.env.SELECTOR_AGENT_DISABLED === 'true') {
    return null;
  }
  if (refreshTimer) {
    return refreshTimer;
  }
  refreshSelectorSnapshot('startup').catch((error) => {
    console.warn('[SelectorAgent] Initial snapshot failed:', error);
  });
  refreshTimer = setInterval(() => {
    refreshSelectorSnapshot('interval').catch((error) => {
      console.warn('[SelectorAgent] Interval refresh failed:', error);
    });
  }, Math.max(15_000, intervalMs));
  return refreshTimer;
}

export function stopSelectorAgentLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
