import { EventEmitter } from 'events';
import { prisma } from '../db/client.js';
import { broadcast } from '../ws/hub.js';

const DEFAULT_LOOKBACK_MINUTES = Math.max(60, Number(process.env.SUBAGENT_LEARNING_LOOKBACK_MINUTES || '1440'));
const DEFAULT_REFRESH_MS = Math.max(60_000, Number(process.env.SUBAGENT_LEARNING_REFRESH_MS || '120000'));
const MIN_TRADES_FOR_ACTION = Math.max(3, Number(process.env.SUBAGENT_LEARNING_MIN_TRADES || '5'));
const DEFAULT_MODE = 'paper';
const DEFAULT_REGIME = 'default';
const WINDOW_WEIGHTS: Record<number, number> = { 60: 3, 360: 2, 1440: 1 };
const DEFAULT_WINDOW_WEIGHT = 1;
const SUBAGENT_EVENT = 'learning.subagents';

export type SubagentKind = 'risk_governor' | 'execution' | 'predictor' | 'sentiment' | 'market_quality' | 'entry_timing' | 'exit_strategy';

type LedgerRow = NonNullable<Awaited<ReturnType<typeof prisma.agentPerformanceLedger.findFirst>>>;

type SymbolAggregate = {
  symbol: string;
  mode: string;
  regime: string | null;
  tradeCount: number;
  winRate: number;
  netPnlUsd: number;
  avgLatencyMs: number | null;
  avgSlippageBps: number | null;
  avgDrawdownPct: number | null;
  complianceRate: number;
  normalizedScore: number;
  sampleWindows: number[];
  agentFamilies: string[];
};

export type RiskLearningRecommendation = {
  recommendedMaxLeverage: number;
  recommendedMaxPositionPct: number;
  hedgingTension: number;
  confidence: number;
};

export type ExecutionLearningRecommendation = {
  preferredMode?: 'market' | 'sweep' | 'iceberg' | 'twap';
  passiveBias?: number;
  fallbackMs?: number;
  twapSliceMultiplier?: number;
  confidence: number;
};

export type PredictorLearningRecommendation = {
  action: 'healthy' | 'monitor' | 'retrain';
  confidenceModifier: number;
  forceFresh: boolean;
  cacheTtlMultiplier: number;
  reason: string;
};

export type SentimentLearningRecommendation = {
  signalWeight: number;
  cooldownMs: number;
  newsHeatWeight: number;
  confidence: number;
};

export type MarketQualityLearningRecommendation = {
  minScore: number;
  liquidityFloorUsd: number;
  spreadCeilBps: number;
  confidence: number;
};

export type EntryTimingLearningRecommendation = {
  defaultAction: 'immediate' | 'wait_pullback' | 'wait_confirmation';
  aggressivenessMultiplier: number;
  pullbackThresholdBps: number;
  confirmationBars: number;
  confidence: number;
};

export type ExitStrategyLearningRecommendation = {
  firstExitR: number;
  firstExitPct: number;
  secondExitR: number;
  secondExitPct: number;
  trailingAtrMult: number;
  trailingActivationR: number;
  maxHoldHours: number;
  lockProfitR: number;
  confidence: number;
};

export type SubagentLearningRecommendations = {
  risk_governor: RiskLearningRecommendation;
  execution: ExecutionLearningRecommendation;
  predictor: PredictorLearningRecommendation;
  sentiment: SentimentLearningRecommendation;
  market_quality: MarketQualityLearningRecommendation;
  entry_timing: EntryTimingLearningRecommendation;
  exit_strategy: ExitStrategyLearningRecommendation;
};

type SubagentLearningRecord<K extends SubagentKind> = {
  subagent: K;
  symbol: string;
  mode: string;
  regime: string;
  score: number;
  sampleCount: number;
  metrics: Record<string, unknown>;
  tuning: SubagentLearningRecommendations[K];
  reason?: string;
};

export type SubagentLearningSnapshot = {
  generatedAt: number;
  lookbackMinutes: number;
  combosEvaluated: number;
  data: {
    risk: Array<SubagentLearningRecord<'risk_governor'>>;
    execution: Array<SubagentLearningRecord<'execution'>>;
    predictor: Array<SubagentLearningRecord<'predictor'>>;
    sentiment: Array<SubagentLearningRecord<'sentiment'>>;
    marketQuality: Array<SubagentLearningRecord<'market_quality'>>;
    entryTiming: Array<SubagentLearningRecord<'entry_timing'>>;
    exitStrategy: Array<SubagentLearningRecord<'exit_strategy'>>;
  };
};

const emitter = new EventEmitter();
let refreshTimer: NodeJS.Timeout | null = null;
let latestSnapshot: SubagentLearningSnapshot | null = null;
const tuningCache = new Map<string, SubagentLearningRecord<SubagentKind>>();

function cacheKey(subagent: SubagentKind, symbol: string, mode?: string | null, regime?: string | null) {
  return `${subagent}|${symbol.toUpperCase()}|${normalizeMode(mode)}|${normalizeRegime(regime)}`;
}

function normalizeMode(mode?: string | null): string {
  return (mode ?? DEFAULT_MODE).toLowerCase();
}

function normalizeRegime(regime?: string | null): string {
  return (regime ?? DEFAULT_REGIME).toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

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

function aggregateLedger(rows: LedgerRow[]): SymbolAggregate[] {
  const buckets = new Map<string, {
    symbol: string;
    mode: string;
    regimeCounts: Map<string, number>;
    tradeCount: number;
    netPnlUsd: number;
    winAccum: number;
    latencyAccum: number;
    slippageAccum: number;
    drawdownAccum: number;
    complianceHits: number;
    weightScoreSum: number;
    weightTotal: number;
    sampleWindows: Set<number>;
    families: Set<string>;
  }>();

  for (const row of rows) {
    const key = `${row.symbol}__${row.mode}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        symbol: row.symbol,
        mode: row.mode || 'paper',
        regimeCounts: new Map(),
        tradeCount: 0,
        netPnlUsd: 0,
        winAccum: 0,
        latencyAccum: 0,
        slippageAccum: 0,
        drawdownAccum: 0,
        complianceHits: 0,
        weightScoreSum: 0,
        weightTotal: 0,
        sampleWindows: new Set(),
        families: new Set(),
      };
      buckets.set(key, agg);
    }

    const trades = Number(row.tradeCount ?? 0);
    const winRate = Number(row.winRate ?? 0);
    const winCount = trades * clamp(winRate, 0, 1);
    const latency = Number(row.avgLatencyMs ?? 0);
    const slippage = Number(row.avgSlippageBps ?? 0);
    const drawdown = Number(row.drawdownPct ?? 0);
    const compliance = Number(row.complianceHits ?? 0);
    const weight = windowWeight(row.windowMinutes);
    const score = typeof row.score === 'number' ? row.score : null;

    agg.tradeCount += trades;
    agg.netPnlUsd += Number(row.netPnlUsd ?? 0);
    agg.winAccum += winCount;
    if (trades > 0) {
      if (Number.isFinite(latency)) agg.latencyAccum += latency * trades;
      if (Number.isFinite(slippage)) agg.slippageAccum += slippage * trades;
      if (Number.isFinite(drawdown)) agg.drawdownAccum += drawdown * trades;
    }
    agg.complianceHits += compliance;
    agg.weightScoreSum += (score ?? 0) * weight;
    agg.weightTotal += weight;
    if (Number.isFinite(row.windowMinutes ?? NaN)) {
      agg.sampleWindows.add(row.windowMinutes ?? 0);
    }
    if (row.agentFamily) {
      agg.families.add(row.agentFamily);
    }
    if (row.regime) {
      agg.regimeCounts.set(row.regime, (agg.regimeCounts.get(row.regime) ?? 0) + Math.max(trades, 1));
    }
  }

  return Array.from(buckets.values()).map((bucket) => {
    const dominantRegime = (() => {
      let best: { regime: string | null; count: number } = { regime: null, count: 0 };
      bucket.regimeCounts.forEach((count, regime) => {
        if (count > best.count) {
          best = { regime, count };
        }
      });
      return best.regime;
    })();

    const tradeCount = bucket.tradeCount;
    const winRate = tradeCount ? bucket.winAccum / tradeCount : 0;
    const avgLatency = tradeCount ? bucket.latencyAccum / tradeCount : null;
    const avgSlippage = tradeCount ? bucket.slippageAccum / tradeCount : null;
    const avgDrawdown = tradeCount ? bucket.drawdownAccum / tradeCount : null;
    const complianceRate = tradeCount ? bucket.complianceHits / Math.max(tradeCount, 1) : 0;
    const normalizedScore = normalizeScore(
      bucket.weightTotal ? bucket.weightScoreSum / bucket.weightTotal : null,
      bucket.netPnlUsd,
      tradeCount,
    );

    return {
      symbol: bucket.symbol,
      mode: bucket.mode || 'paper',
      regime: dominantRegime ?? null,
      tradeCount,
      winRate,
      netPnlUsd: bucket.netPnlUsd,
      avgLatencyMs: avgLatency,
      avgSlippageBps: avgSlippage,
      avgDrawdownPct: avgDrawdown,
      complianceRate,
      normalizedScore,
      sampleWindows: Array.from(bucket.sampleWindows).sort((a, b) => a - b),
      agentFamilies: Array.from(bucket.families),
    } satisfies SymbolAggregate;
  });
}

function buildMetricsPayload(agg: SymbolAggregate): Record<string, unknown> {
  return {
    tradeCount: agg.tradeCount,
    winRate: Number(agg.winRate.toFixed(4)),
    normalizedScore: Number(agg.normalizedScore.toFixed(4)),
    netPnlUsd: Number(agg.netPnlUsd.toFixed(2)),
    avgLatencyMs: agg.avgLatencyMs != null ? Number(agg.avgLatencyMs.toFixed(1)) : null,
    avgSlippageBps: agg.avgSlippageBps != null ? Number(agg.avgSlippageBps.toFixed(2)) : null,
    avgDrawdownPct: agg.avgDrawdownPct != null ? Number(agg.avgDrawdownPct.toFixed(2)) : null,
    complianceRate: Number(agg.complianceRate.toFixed(4)),
    sampleWindows: agg.sampleWindows,
    agentFamilies: agg.agentFamilies,
  };
}

/**
 * Returns neutral/conservative defaults for symbols without historical data.
 * These values allow trading while being cautious until performance data accumulates.
 */
function getNeutralRiskDefaults(): RiskLearningRecommendation {
  return {
    recommendedMaxLeverage: 3.5,        // Conservative leverage
    recommendedMaxPositionPct: 0.18,    // 18% position sizing (moderate)
    hedgingTension: 0.30,               // Low tension - won't force hedge
    confidence: 0.50,                    // Neutral confidence
  };
}

function deriveRiskRecommendation(agg: SymbolAggregate): { tuning: RiskLearningRecommendation; reason: string } {
  const drawdownPenalty = agg.avgDrawdownPct != null ? clamp(1 - agg.avgDrawdownPct / 140, 0.35, 1) : 1;
  const compliancePenalty = clamp(1 - agg.complianceRate * 1.4, 0.4, 1);
  const baseLeverage = clamp(1 + agg.winRate * 4, 1.2, 8);
  const recommendedMaxLeverage = Number((baseLeverage * drawdownPenalty * compliancePenalty).toFixed(2));
  const recommendedMaxPositionPct = Number(clamp(0.18 + agg.normalizedScore * 0.12, 0.08, 0.45).toFixed(3));
  const hedgingTension = Number(clamp((agg.avgDrawdownPct ?? 0) / 40 + agg.complianceRate * 1.2, 0, 1).toFixed(3));
  const confidence = Number(clamp(agg.tradeCount / 40, 0.25, 1).toFixed(3));
  const reason = `drawdown=${(agg.avgDrawdownPct ?? 0).toFixed(1)}|compliance=${agg.complianceRate.toFixed(2)}`;
  return {
    tuning: {
      recommendedMaxLeverage,
      recommendedMaxPositionPct,
      hedgingTension,
      confidence,
    },
    reason,
  };
}

function deriveExecutionRecommendation(agg: SymbolAggregate): { tuning: ExecutionLearningRecommendation; reason: string } {
  const slippage = agg.avgSlippageBps ?? 12;
  const latency = agg.avgLatencyMs ?? 900;
  let preferredMode: ExecutionLearningRecommendation['preferredMode'];
  if (slippage > 16 || latency > 1600) preferredMode = 'twap';
  else if (slippage < 6 && latency < 800) preferredMode = 'market';
  else if (slippage < 10) preferredMode = 'sweep';
  else preferredMode = 'iceberg';

  const passiveBias = Number(clamp(1 - slippage / 30 + agg.complianceRate * 0.2, 0, 1).toFixed(3));
  const fallbackMs = Math.round(clamp(2500 + latency * 0.6 + slippage * 40, 1500, 7000));
  const twapSliceMultiplier = Number(clamp(1 + slippage / 20, 0.8, 2.2).toFixed(2));
  const confidence = Number(clamp(agg.tradeCount / 30, 0.2, 1).toFixed(3));
  const reason = `slippage=${slippage.toFixed(1)}|latency=${latency.toFixed(0)}`;
  return {
    tuning: {
      preferredMode,
      passiveBias,
      fallbackMs,
      twapSliceMultiplier,
      confidence,
    },
    reason,
  };
}

function derivePredictorRecommendation(agg: SymbolAggregate): { tuning: PredictorLearningRecommendation; reason: string } {
  const needsSamples = agg.tradeCount >= MIN_TRADES_FOR_ACTION;
  const retrainThreshold = agg.normalizedScore <= -0.12 || agg.winRate <= 0.42;
  let action: PredictorLearningRecommendation['action'] = 'healthy';
  if (needsSamples && retrainThreshold) action = 'retrain';
  else if (agg.normalizedScore < 0.05 || agg.winRate < 0.5) action = 'monitor';

  const confidenceModifier = Number(clamp(1 + agg.normalizedScore * 0.35, 0.6, 1.35).toFixed(3));
  const forceFresh = action !== 'healthy';
  const cacheTtlMultiplier = Number(clamp(action === 'healthy' ? 1 : action === 'monitor' ? 0.75 : 0.5, 0.4, 1).toFixed(2));
  const reason = `score=${agg.normalizedScore.toFixed(2)}|winRate=${(agg.winRate * 100).toFixed(1)}%`;
  return {
    tuning: {
      action,
      confidenceModifier,
      forceFresh,
      cacheTtlMultiplier,
      reason,
    },
    reason,
  };
}

function deriveSentimentRecommendation(agg: SymbolAggregate): { tuning: SentimentLearningRecommendation; reason: string } {
  const signalWeight = Number(clamp(0.35 + agg.normalizedScore * 0.25, 0.15, 0.85).toFixed(3));
  const newsHeatWeight = Number(clamp(0.4 + agg.winRate * 0.3, 0.2, 0.9).toFixed(3));
  const cooldownMs = Math.round(clamp(30_000 - agg.normalizedScore * 10_000, 10_000, 45_000));
  const confidence = Number(clamp(agg.tradeCount / 25, 0.2, 1).toFixed(3));
  const reason = `weight=${signalWeight.toFixed(2)}|cooldown=${cooldownMs}`;
  return {
    tuning: {
      signalWeight,
      cooldownMs,
      newsHeatWeight,
      confidence,
    },
    reason,
  };
}

function deriveMarketQualityRecommendation(agg: SymbolAggregate): { tuning: MarketQualityLearningRecommendation; reason: string } {
  const liquidityFloor = Math.round(clamp((agg.avgSlippageBps ?? 10) * 4_000, 40_000, 220_000));
  const minScore = Number(clamp(0.45 + agg.normalizedScore * 0.25, 0.3, 0.9).toFixed(2));
  const spreadCeil = Math.round(clamp(12 - agg.normalizedScore * 6, 6, 20));
  const confidence = Number(clamp(agg.tradeCount / 30, 0.25, 1).toFixed(3));
  const reason = `slippage=${(agg.avgSlippageBps ?? 0).toFixed(1)}|drawdown=${(agg.avgDrawdownPct ?? 0).toFixed(1)}`;
  return {
    tuning: {
      minScore,
      liquidityFloorUsd: liquidityFloor,
      spreadCeilBps: spreadCeil,
      confidence,
    },
    reason,
  };
}

function deriveEntryTimingRecommendation(agg: SymbolAggregate): { tuning: EntryTimingLearningRecommendation; reason: string } {
  // Analyze entry timing patterns from performance data
  // High win rate + low drawdown = aggressive immediate entries work well
  // Low win rate or high drawdown = more caution needed
  
  let defaultAction: 'immediate' | 'wait_pullback' | 'wait_confirmation';
  if (agg.winRate > 0.6 && agg.normalizedScore > 0.2) {
    defaultAction = 'immediate';
  } else if (agg.winRate < 0.5 || (agg.avgDrawdownPct ?? 0) > 12) {
    defaultAction = 'wait_confirmation';
  } else {
    defaultAction = 'wait_pullback';
  }
  
  // Aggressiveness based on performance: better performance = more aggressive sizing
  const aggressivenessMultiplier = Number(clamp(0.8 + agg.normalizedScore * 0.5, 0.5, 1.5).toFixed(2));
  
  // Pullback threshold: higher slippage = wait for bigger pullbacks
  const pullbackThresholdBps = Math.round(clamp(15 + (agg.avgSlippageBps ?? 0) * 0.5, 10, 30));
  
  // Confirmation bars: lower win rate = need more confirmation
  const confirmationBars = agg.winRate > 0.55 ? 1 : 2;
  
  const confidence = Number(clamp(agg.tradeCount / 30, 0.2, 1).toFixed(3));
  const reason = `action=${defaultAction}|aggr=${aggressivenessMultiplier.toFixed(2)}x|winRate=${(agg.winRate * 100).toFixed(1)}%`;
  
  return {
    tuning: {
      defaultAction,
      aggressivenessMultiplier,
      pullbackThresholdBps,
      confirmationBars,
      confidence,
    },
    reason,
  };
}

function deriveExitStrategyRecommendation(agg: SymbolAggregate): { tuning: ExitStrategyLearningRecommendation; reason: string } {
  // Analyze optimal exit strategies from historical performance
  // High win rate + good score = let winners run (higher R-multiples)
  // Lower win rate = take profits earlier
  
  // First partial exit: scale based on performance
  const firstExitR = Number(clamp(agg.winRate > 0.6 ? 2.5 : 2.0, 1.5, 3.5).toFixed(1));
  const firstExitPct = 0.33; // Always exit 33% on first target
  
  // Second partial exit: winners go higher
  const secondExitR = Number(clamp(agg.normalizedScore > 0.2 ? 4.5 : 3.5, 3.0, 6.0).toFixed(1));
  const secondExitPct = 0.33; // Exit another 33%
  
  // Trailing stop: wider in volatile markets, tighter in stable
  const trailingAtrMult = Number(clamp(
    (agg.avgDrawdownPct ?? 0) > 15 ? 1.5 : 1.0,
    0.8,
    2.0
  ).toFixed(1));
  
  // Activate trailing stop after first target hit
  const trailingActivationR = Number(clamp(firstExitR * 0.9, 1.5, 3.0).toFixed(1));
  
  // Max hold time: extend for winning symbols, reduce for losers
  const maxHoldHours = Math.round(clamp(
    agg.normalizedScore > 0.15 ? 48 : agg.normalizedScore < -0.1 ? 18 : 24,
    12,
    72
  ));
  
  // Lock profit threshold: tighten stop when this R-multiple reached
  const lockProfitR = Number(clamp(firstExitR * 1.2, 2.0, 4.0).toFixed(1));
  
  const confidence = Number(clamp(agg.tradeCount / 40, 0.25, 1).toFixed(3));
  const reason = `exits=${firstExitR}R/${secondExitR}R|trail=${trailingAtrMult}xATR|maxHold=${maxHoldHours}h`;
  
  return {
    tuning: {
      firstExitR,
      firstExitPct,
      secondExitR,
      secondExitPct,
      trailingAtrMult,
      trailingActivationR,
      maxHoldHours,
      lockProfitR,
      confidence,
    },
    reason,
  };
}

async function persistLearning(records: Array<SubagentLearningRecord<SubagentKind>>) {
  if (!records.length) return;
  const chunkSize = 25;
  for (let i = 0; i < records.length; i += chunkSize) {
    const slice = records.slice(i, i + chunkSize);
    await prisma.$transaction(
      slice.map((record) =>
        prisma.subagentLearningState.upsert({
          where: {
            subagent_learning_unique: {
              subagent: record.subagent,
              symbol: record.symbol,
              mode: record.mode,
              regime: record.regime,
            },
          },
          create: {
            subagent: record.subagent,
            symbol: record.symbol,
            mode: record.mode,
            regime: record.regime,
            score: record.score,
            sampleCount: record.sampleCount,
            metrics: record.metrics as any,
            tuning: record.tuning as any,
            reason: record.reason,
          },
          update: {
            score: record.score,
            sampleCount: record.sampleCount,
            metrics: record.metrics as any,
            tuning: record.tuning as any,
            reason: record.reason,
            updatedAt: new Date(),
          },
        }),
      ),
    );
  }
}

function primeCache(records: Array<SubagentLearningRecord<SubagentKind>>) {
  tuningCache.clear();
  records.forEach((record) => {
    tuningCache.set(cacheKey(record.subagent, record.symbol, record.mode, record.regime), record);
  });
}

export async function refreshSubagentLearning(reason = 'manual'): Promise<SubagentLearningSnapshot> {
  const now = Date.now();
  const lookbackStart = new Date(now - DEFAULT_LOOKBACK_MINUTES * 60_000);
  const rows = await prisma.agentPerformanceLedger.findMany({
    where: { bucketStart: { gte: lookbackStart } },
    orderBy: { bucketStart: 'desc' },
    take: 4000,
  });
  const aggregates = aggregateLedger(rows);

  const riskRecords: Array<SubagentLearningRecord<'risk_governor'>> = [];
  const executionRecords: Array<SubagentLearningRecord<'execution'>> = [];
  const predictorRecords: Array<SubagentLearningRecord<'predictor'>> = [];
  const sentimentRecords: Array<SubagentLearningRecord<'sentiment'>> = [];
  const marketRecords: Array<SubagentLearningRecord<'market_quality'>> = [];
  const entryTimingRecords: Array<SubagentLearningRecord<'entry_timing'>> = [];
  const exitStrategyRecords: Array<SubagentLearningRecord<'exit_strategy'>> = [];

  for (const agg of aggregates) {
    const normalizedSymbol = agg.symbol.toUpperCase();
    const normalizedMode = normalizeMode(agg.mode);
    const normalizedRegime = normalizeRegime(agg.regime);
    const metrics = buildMetricsPayload(agg);

    const risk = deriveRiskRecommendation(agg);
    riskRecords.push({
      subagent: 'risk_governor',
      symbol: normalizedSymbol,
      mode: normalizedMode,
      regime: normalizedRegime,
      score: agg.normalizedScore,
      sampleCount: agg.tradeCount,
      metrics,
      tuning: risk.tuning,
      reason: risk.reason,
    });

    const exec = deriveExecutionRecommendation(agg);
    executionRecords.push({
      subagent: 'execution',
      symbol: normalizedSymbol,
      mode: normalizedMode,
      regime: normalizedRegime,
      score: agg.normalizedScore,
      sampleCount: agg.tradeCount,
      metrics,
      tuning: exec.tuning,
      reason: exec.reason,
    });

    const predictor = derivePredictorRecommendation(agg);
    predictorRecords.push({
      subagent: 'predictor',
      symbol: normalizedSymbol,
      mode: normalizedMode,
      regime: normalizedRegime,
      score: agg.normalizedScore,
      sampleCount: agg.tradeCount,
      metrics,
      tuning: predictor.tuning,
      reason: predictor.reason,
    });

    const sentiment = deriveSentimentRecommendation(agg);
    sentimentRecords.push({
      subagent: 'sentiment',
      symbol: normalizedSymbol,
      mode: normalizedMode,
      regime: normalizedRegime,
      score: agg.normalizedScore,
      sampleCount: agg.tradeCount,
      metrics,
      tuning: sentiment.tuning,
      reason: sentiment.reason,
    });

    const market = deriveMarketQualityRecommendation(agg);
    marketRecords.push({
      subagent: 'market_quality',
      symbol: normalizedSymbol,
      mode: normalizedMode,
      regime: normalizedRegime,
      score: agg.normalizedScore,
      sampleCount: agg.tradeCount,
      metrics,
      tuning: market.tuning,
      reason: market.reason,
    });

    const entryTiming = deriveEntryTimingRecommendation(agg);
    entryTimingRecords.push({
      subagent: 'entry_timing',
      symbol: normalizedSymbol,
      mode: normalizedMode,
      regime: normalizedRegime,
      score: agg.normalizedScore,
      sampleCount: agg.tradeCount,
      metrics,
      tuning: entryTiming.tuning,
      reason: entryTiming.reason,
    });

    const exitStrategy = deriveExitStrategyRecommendation(agg);
    exitStrategyRecords.push({
      subagent: 'exit_strategy',
      symbol: normalizedSymbol,
      mode: normalizedMode,
      regime: normalizedRegime,
      score: agg.normalizedScore,
      sampleCount: agg.tradeCount,
      metrics,
      tuning: exitStrategy.tuning,
      reason: exitStrategy.reason,
    });
  }

  const allRecords: Array<SubagentLearningRecord<SubagentKind>> = [
    ...riskRecords,
    ...executionRecords,
    ...predictorRecords,
    ...sentimentRecords,
    ...marketRecords,
    ...entryTimingRecords,
    ...exitStrategyRecords,
  ];

  await persistLearning(allRecords);
  primeCache(allRecords);

  const snapshot: SubagentLearningSnapshot = {
    generatedAt: now,
    lookbackMinutes: DEFAULT_LOOKBACK_MINUTES,
    combosEvaluated: aggregates.length,
    data: {
      risk: riskRecords.slice(0, 24),
      execution: executionRecords.slice(0, 24),
      predictor: predictorRecords.slice(0, 24),
      sentiment: sentimentRecords.slice(0, 24),
      marketQuality: marketRecords.slice(0, 24),
      entryTiming: entryTimingRecords.slice(0, 24),
      exitStrategy: exitStrategyRecords.slice(0, 24),
    },
  };

  latestSnapshot = snapshot;
  emitter.emit(SUBAGENT_EVENT, snapshot);
  broadcast('learning.subagents', { type: 'learning.subagents', data: snapshot, reason });
  return snapshot;
}

export function startSubagentLearningLoop(intervalMs = DEFAULT_REFRESH_MS) {
  if (process.env.SUBAGENT_LEARNING_DISABLED === 'true') {
    return null;
  }
  if (refreshTimer) {
    return refreshTimer;
  }
  refreshSubagentLearning('startup').catch((error) => {
    console.warn('[SubagentLearning] Initial refresh failed', error);
  });
  refreshTimer = setInterval(() => {
    refreshSubagentLearning('interval').catch((error) => {
      console.warn('[SubagentLearning] Interval refresh failed', error);
    });
  }, intervalMs);
  return refreshTimer;
}

export function stopSubagentLearningLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function getSubagentLearningSnapshot(): SubagentLearningSnapshot | null {
  return latestSnapshot;
}

export async function getSubagentTuning<K extends SubagentKind>(
  subagent: K,
  symbol: string,
  options?: { mode?: string | null; regime?: string | null },
): Promise<SubagentLearningRecommendations[K] | null> {
  const normalizedSymbol = symbol.toUpperCase();
  const requestedMode = options?.mode ? normalizeMode(options.mode) : null;
  const cacheMode = requestedMode ?? normalizeMode();
  const normalizedRegime = normalizeRegime(options?.regime);
  const cached = tuningCache.get(cacheKey(subagent, normalizedSymbol, cacheMode, normalizedRegime));
  if (cached) {
    return cached.tuning as SubagentLearningRecommendations[K];
  }

  let row = await prisma.subagentLearningState.findFirst({
    where: {
      subagent,
      symbol: normalizedSymbol,
      mode: requestedMode ?? undefined,
      regime: options?.regime ? normalizedRegime : undefined,
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (!row && options?.regime && normalizedRegime === DEFAULT_REGIME) {
    row = await prisma.subagentLearningState.findFirst({
      where: {
        subagent,
        symbol: normalizedSymbol,
        mode: requestedMode ?? undefined,
        regime: null,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  if (!row && options?.regime) {
    let fallback = await prisma.subagentLearningState.findFirst({
      where: {
        subagent,
        symbol: normalizedSymbol,
        mode: requestedMode ?? undefined,
        regime: DEFAULT_REGIME,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!fallback) {
      fallback = await prisma.subagentLearningState.findFirst({
        where: {
          subagent,
          symbol: normalizedSymbol,
          mode: requestedMode ?? undefined,
          regime: null,
        },
        orderBy: { updatedAt: 'desc' },
      });
    }
    if (fallback) {
      const fallbackMode = normalizeMode(fallback.mode);
      const fallbackRegime = normalizeRegime(fallback.regime);
      const cacheRecord = {
        subagent,
        symbol: fallback.symbol,
        mode: fallbackMode,
        regime: fallbackRegime,
        score: fallback.score ?? 0,
        sampleCount: fallback.sampleCount ?? 0,
        metrics: asRecord(fallback.metrics),
        tuning: fallback.tuning as SubagentLearningRecommendations[K],
        reason: fallback.reason ?? undefined,
      } as SubagentLearningRecord<K>;
      tuningCache.set(cacheKey(subagent, normalizedSymbol, fallbackMode, fallbackRegime), cacheRecord);
      if (!requestedMode && cacheMode !== fallbackMode) {
        tuningCache.set(cacheKey(subagent, normalizedSymbol, cacheMode, fallbackRegime), cacheRecord);
      }
      return fallback.tuning as SubagentLearningRecommendations[K];
    }
    return null;
  }

  if (!row) {
    // Return neutral defaults for symbols without historical data
    // This allows new symbols to trade while being conservative
    if (subagent === 'risk_governor') {
      return getNeutralRiskDefaults() as SubagentLearningRecommendations[K];
    }
    // For other subagents, return null and let them use their own defaults
    return null;
  }

  const rowMode = normalizeMode(row.mode);
  const rowRegime = normalizeRegime(row.regime);
  const cacheRecord = {
    subagent,
    symbol: row.symbol,
    mode: rowMode,
    regime: rowRegime,
    score: row.score ?? 0,
    sampleCount: row.sampleCount ?? 0,
    metrics: asRecord(row.metrics),
    tuning: row.tuning as SubagentLearningRecommendations[K],
    reason: row.reason ?? undefined,
  } as SubagentLearningRecord<K>;
  tuningCache.set(cacheKey(subagent, normalizedSymbol, rowMode, rowRegime), cacheRecord);
  if (!requestedMode && cacheMode !== rowMode) {
    tuningCache.set(cacheKey(subagent, normalizedSymbol, cacheMode, rowRegime), cacheRecord);
  }

  return row.tuning as SubagentLearningRecommendations[K];
}

export function onSubagentLearning(listener: (snapshot: SubagentLearningSnapshot) => void) {
  emitter.on(SUBAGENT_EVENT, listener);
  return () => emitter.off(SUBAGENT_EVENT, listener);
}
