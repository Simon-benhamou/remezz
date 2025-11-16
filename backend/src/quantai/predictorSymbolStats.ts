import { prisma } from '../db/client.js';
import { analyzePredictorDecisions } from './predictorDecisionAnalytics.js';

interface PredictorSymbolStatsCacheEntry {
  stats: PredictorSymbolStats;
  expiresAt: number;
}

export interface PredictorSymbolStats {
  winRate: number | null; // ratio 0-1
  completedTrades: number;
  lowConfidenceShortLossStreak: number;
  sampleSize: number;
  lastUpdated: number;
}

const STATS_CACHE = new Map<string, PredictorSymbolStatsCacheEntry>();
const STATS_CACHE_TTL_MS = 60_000;
const HISTORY_LIMIT = 60;

function computeLowConfidenceShortLossStreak(decisions: ReturnType<typeof analyzePredictorDecisions>['reverseChronological']) {
  let streak = 0;
  for (const decision of decisions) {
    if (decision.decision !== 'short') {
      continue;
    }
    if (decision.outcome === 'pending' || decision.outcome === 'not_applicable') {
      continue;
    }
    if (decision.confidence < 0.4 && decision.outcome === 'bad') {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

export async function getPredictorSymbolStats(symbol: string): Promise<PredictorSymbolStats | null> {
  const cacheEntry = STATS_CACHE.get(symbol);
  const now = Date.now();
  if (cacheEntry && cacheEntry.expiresAt > now) {
    return cacheEntry.stats;
  }

  const decisions = await prisma.predictorDecision.findMany({
    where: { symbol },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  });

  if (decisions.length === 0) {
    return null;
  }

  const analysis = analyzePredictorDecisions(decisions);
  const completedTrades = analysis.metrics.completedTrades;
  const winRateRatio = completedTrades > 0
    ? analysis.metrics.goodTrades / completedTrades
    : null;

  const stats: PredictorSymbolStats = {
    winRate: winRateRatio,
    completedTrades,
    lowConfidenceShortLossStreak: computeLowConfidenceShortLossStreak(analysis.reverseChronological),
    sampleSize: analysis.metrics.totalDecisions,
    lastUpdated: now,
  };

  STATS_CACHE.set(symbol, {
    stats,
    expiresAt: now + STATS_CACHE_TTL_MS,
  });

  return stats;
}
