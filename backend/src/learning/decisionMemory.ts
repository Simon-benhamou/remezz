import { prisma } from '../db/client.js';
import type { IntelligentAnalysis } from '../services/intelligentAgent.js';
import { refreshAdaptiveWeightsForFamily } from './adaptiveWeights.js';
import { classifySymbolFamily } from './symbolFamily.js';

export type DecisionFeatures = {
  momentum: number;
  volume24h: number;
  volatility: number;
  trend: number;
  trendStrength: number;
  score: number;
  confidence: number;
  biasConfidence: number;
  agreementScore?: number;
  divergenceScore?: number;
};

const FEATURE_KEYS: Array<keyof DecisionFeatures> = [
  'momentum',
  'volume24h',
  'volatility',
  'trend',
  'trendStrength',
  'score',
  'confidence',
  'biasConfidence',
  'agreementScore',
  'divergenceScore',
];

type SimilarDecision = {
  id: string;
  createdAt: string;
  outcome: string | null;
  realizedPnl: number | null;
  bias?: string | null;
  similarity: number;
  features: DecisionFeatures | null;
};

export type DecisionMemoryInsight = {
  symbol: string;
  sampleSize: number;
  symbolWinRate: number | null;
  weightedOutcome: number | null;
  scoreMultiplier: number;
  similarDecisions: SimilarDecision[];
  similarWinCount: number;
  similarLossCount: number;
};

function extractFeatures(analysis: IntelligentAnalysis): DecisionFeatures {
  const metrics = analysis.metrics || ({} as any);
  return {
    momentum: Number(metrics.momentum ?? 0),
    volume24h: Number(metrics.volume24h ?? 0),
    volatility: Number(metrics.volatility ?? 0),
    trend: Number(metrics.trend ?? 0),
    trendStrength: Number(metrics.trendStrength ?? 0),
    score: Number(analysis.score ?? 0),
    confidence: Number(analysis.confidence ?? 0),
    biasConfidence: Number(analysis.autoBias?.confidence ?? 0),
    agreementScore: analysis.multiTimeframe?.agreementScore,
    divergenceScore: analysis.multiTimeframe?.divergenceScore,
  };
}

export async function recordDecisionSnapshot(params: {
  sessionId?: string;
  symbol: string;
  analysis: IntelligentAnalysis;
  aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
}): Promise<string | null> {
  try {
    const features = extractFeatures(params.analysis);
    const family = classifySymbolFamily(params.symbol);
    const record = await prisma.decisionMemory.create({
      data: {
        sessionId: params.sessionId,
        symbol: params.symbol,
        family,
        timeframe: '15m',
        bias: params.analysis.autoBias?.bias,
        score: params.analysis.score,
        confidence: params.analysis.confidence,
        biasConfidence: params.analysis.autoBias?.confidence,
        features,
      },
      select: { id: true },
    });
    pruneDecisionMemory(family).catch((error) => console.warn('Decision memory prune failed:', error));
    pruneDecisionMemory().catch((error) => console.warn('Global decision memory prune failed:', error));
    return record.id;
  } catch (error) {
    console.warn('Failed to record decision snapshot:', error);
    return null;
  }
}

function normalizeFeature(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const abs = Math.abs(value);
  return Math.log10(abs + 1);
}

function buildFeatureVector(features: Partial<DecisionFeatures> | null | undefined): number[] {
  return FEATURE_KEYS.map((key) => normalizeFeature(Number((features as any)?.[key] ?? 0)));
}

function computeSimilarityVector(current: number[], historical: number[]): number {
  let distanceSquared = 0;
  let valid = 0;
  for (let i = 0; i < current.length; i += 1) {
    const a = current[i];
    const b = historical[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const diff = a - b;
    distanceSquared += diff * diff;
    valid += 1;
  }
  if (valid === 0) return 0;
  const distance = Math.sqrt(distanceSquared / valid);
  return Math.exp(-distance);
}

function outcomeToScore(outcome: string | null): number {
  if (outcome === 'win') return 1;
  if (outcome === 'breakeven') return 0.5;
  if (outcome === 'loss') return 0;
  return 0.4; // cancelled/unknown/slight penalty
}

function clampMultiplier(value: number): number {
  return Math.max(0.6, Math.min(1.4, value));
}

export async function analyzeDecisionMemoryForSymbol(symbol: string, currentFeatures: DecisionFeatures): Promise<DecisionMemoryInsight | null> {
  try {
    const rows = await prisma.decisionMemory.findMany({
      where: { symbol },
      orderBy: { createdAt: 'desc' },
      take: 250,
    });

    if (!rows.length) {
      return null;
    }

    const withOutcome = rows.filter((row) => row.outcome && row.features) as Array<typeof rows[number]>;
    const sampleSize = withOutcome.length;
    const wins = withOutcome.filter((row) => row.outcome === 'win').length;
    const symbolWinRate = sampleSize > 0 ? wins / sampleSize : null;

    const currentVector = buildFeatureVector(currentFeatures);
    const similar = withOutcome
      .map((row) => {
        const vector = buildFeatureVector(row.features as DecisionFeatures);
        const similarity = computeSimilarityVector(currentVector, vector);
        return {
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          outcome: row.outcome,
          realizedPnl: row.realizedPnl ?? null,
          bias: row.bias,
          similarity,
          features: row.features as DecisionFeatures,
        } as SimilarDecision;
      })
      .filter((item) => item.similarity > 0.05)
      .sort((a, b) => b.similarity - a.similarity);

    const topSimilar = similar.slice(0, 12);
    const weightSum = topSimilar.reduce((sum, item) => sum + item.similarity, 0);
    const weightedOutcome = weightSum > 0
      ? topSimilar.reduce((sum, item) => sum + outcomeToScore(item.outcome) * item.similarity, 0) / weightSum
      : null;

    const baseMultiplier = weightedOutcome != null ? 1 + (weightedOutcome - 0.5) * 0.8 : 1;
    const trendMultiplier = symbolWinRate != null ? 1 + (symbolWinRate - 0.5) * 0.4 : 1;
    const similarityMultiplier = topSimilar.length >= 3 ? 1 + Math.min(0.15, weightSum / topSimilar.length - 0.5) : 1;
    const combinedMultiplier = clampMultiplier(baseMultiplier * trendMultiplier * similarityMultiplier);

    return {
      symbol,
      sampleSize,
      symbolWinRate,
      weightedOutcome,
      scoreMultiplier: combinedMultiplier,
      similarDecisions: topSimilar,
      similarWinCount: topSimilar.filter((item) => item.outcome === 'win').length,
      similarLossCount: topSimilar.filter((item) => item.outcome === 'loss').length,
    };
  } catch (error) {
    console.warn('Failed to analyze decision memory:', error);
    return null;
  }
}

export async function recomputeAdaptiveWeights(family: string) {
  const samples = await prisma.decisionMemory.findMany({
    where: {
      family,
      outcome: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  if (!samples.length) {
    await prisma.adaptiveThreshold.upsert({
      where: { family },
      update: {
        momentumWeight: 1,
        volumeWeight: 1,
        volatilityWeight: 1,
        confidence: 0,
        sampleSize: 0,
        lastWinRate: 0,
      },
      create: {
        family,
        momentumWeight: 1,
        volumeWeight: 1,
        volatilityWeight: 1,
        confidence: 0,
        sampleSize: 0,
        lastWinRate: 0,
      },
    });
    refreshAdaptiveWeightsForFamily(family, true).catch(() => {});
    return;
  }

  const wins = samples.filter(s => s.outcome === 'win');
  const losses = samples.filter(s => s.outcome === 'loss');
  const epsilon = 1e-6;

  function computeRatio(key: keyof DecisionFeatures) {
    const winAvg = wins.length
      ? wins.reduce((sum, item) => sum + normalizeFeature((item.features as any)?.[key] ?? 0), 0) / wins.length
      : 0;
    const lossAvg = losses.length
      ? losses.reduce((sum, item) => sum + normalizeFeature((item.features as any)?.[key] ?? 0), 0) / losses.length
      : 0;
    const ratio = (winAvg + epsilon) / (lossAvg + epsilon);
    return Math.max(0.7, Math.min(1.3, ratio));
  }

  const momentumWeight = computeRatio('momentum');
  const volumeWeight = computeRatio('volume24h');
  const volatilityWeight = computeRatio('volatility');
  const confidence = wins.length / samples.length;
  const winRate = wins.length / samples.length;

  await prisma.adaptiveThreshold.upsert({
    where: { family },
    update: {
      momentumWeight,
      volumeWeight,
      volatilityWeight,
      confidence,
      sampleSize: samples.length,
      lastWinRate: winRate,
    },
    create: {
      family,
      momentumWeight,
      volumeWeight,
      volatilityWeight,
      confidence,
      sampleSize: samples.length,
      lastWinRate: winRate,
    },
  });

  refreshAdaptiveWeightsForFamily(family, true).catch(() => {});
}

export async function recomputeAdaptiveWeightsForFamilies(limit = 20) {
  try {
    const families = await prisma.decisionMemory.findMany({
      distinct: ['family'],
      select: { family: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    await Promise.all(families.map(async (row) => {
      if (!row.family) return;
      await recomputeAdaptiveWeights(row.family);
    }));
  } catch (error) {
    console.warn('Failed to run adaptive weights training batch:', error);
  }
}

export async function finalizeDecisionOutcome(sessionId: string, realizedPnl: number) {
  try {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { profileJson: true },
    });
    const profile = (session?.profileJson || {}) as any;
    const decisionId = profile?.currentDecisionId;
    if (!decisionId) return;

    const outcome = realizedPnl > 0 ? 'win' : realizedPnl < 0 ? 'loss' : 'breakeven';

    const decision = await prisma.decisionMemory.update({
      where: { id: decisionId },
      data: {
        outcome,
        realizedPnl,
      },
      select: { family: true },
    });

    profile.currentDecisionId = null;
    try {
      await prisma.agentSession.update({
        where: { id: sessionId },
        data: { profileJson: profile as any },
      });
    } catch (err) {
      console.warn('Failed to clear currentDecisionId on session:', err);
    }

    if (decision?.family) {
      await recomputeAdaptiveWeights(decision.family);
    }
  } catch (error) {
    console.warn('Failed to finalize decision outcome:', error);
  }
}

export async function markDecisionCancelled(sessionId: string) {
  try {
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { profileJson: true },
    });
    const profile = (session?.profileJson || {}) as any;
    const decisionId = profile?.currentDecisionId;
    if (!decisionId) return;

    await prisma.decisionMemory.updateMany({
      where: { id: decisionId, outcome: null },
      data: { outcome: 'cancelled' },
    });

    profile.currentDecisionId = null;
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { profileJson: profile as any },
    });
  } catch (error) {
    console.warn('Failed to mark decision cancelled:', error);
  }
}

const MAX_PER_FAMILY = 1200;
const MAX_TOTAL = 10000;

async function pruneDecisionMemory(family?: string) {
  const where = family ? { family } : {};
  const total = await prisma.decisionMemory.count({ where });
  const limit = family ? MAX_PER_FAMILY : MAX_TOTAL;
  if (total <= limit) return;

  const excess = total - limit;
  const toDelete = await prisma.decisionMemory.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: excess,
    select: { id: true },
  });
  if (!toDelete.length) return;
  await prisma.decisionMemory.deleteMany({
    where: { id: { in: toDelete.map((d) => d.id) } },
  });
}
