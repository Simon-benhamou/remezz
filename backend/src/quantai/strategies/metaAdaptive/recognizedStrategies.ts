import { metaAdaptiveStrategyAgent, AdaptiveSignal, PreciseDecimal } from './metaAdaptiveAgent.js';
import { getQuantAIConfig } from '../../config.js';
import { TechnicalSnapshot } from '../../../ai/tech.js';
import type { Diagnostics as MultiTimeframeDiagnostics } from '../../../ai/multiTimeframe.js';
import { recordOpsEvent } from '../../../monitor/ops.js';
import { updateExecutionTelemetry } from '../../../services/executionTelemetry.js';
import type { PerpetualMetrics, OnChainMetrics, SentimentSnapshot, WatchlistMeta } from '../../../analytics/marketContext.js';

type StrategyBias = 'long' | 'short' | 'both';

export type RecognizedStrategyId =
  | 'classic_trend_following'
  | 'bollinger_mean_reversion'
  | 'breakout_retest'
  | 'momentum_scanner_focus';

export type RecognizedStrategySignal = {
  id: RecognizedStrategyId;
  label: string;
  bias: StrategyBias;
  confidence: number;
  active: boolean;
  reasons: string[];
  metrics: Record<string, number | string | null>;
  meta?: {
    score: number;
    guardrail?: string | null;
    penalties: string[];
    exploration: boolean;
    token?: string | null;
    executionMode?: 'market' | 'limit' | 'twap';
    riskPct?: string;
    stopAtrMult?: string;
    takeProfitMultiples?: string[];
    riskUsd?: string;
    targetProfitUsd?: string;
    entryWeight?: string;
    pythonRiskMultiplier?: string;
    trailingPolicy?: {
      breakevenArmR: number;
      trailActivationR: number;
      atrLookback: 'atr15m' | 'atr1h';
      atrMultiplier: number;
      contextAlignmentThreshold: number;
      adxThreshold: number;
    } | null;
    predictorFeatures?: Record<string, number> | null;
    pythonSignal?: {
      bias: StrategyBias;
      probability: number;
      bearishProbability: number;
      confidence: number;
      entryWeight: number;
      riskMultiplier: number;
      cooldown: { active: boolean; reason: string | null; seconds: number | null };
      meta?: Record<string, unknown> | null;
    } | null;
  };
};

type EvaluateOptions = {
  sessionId?: string | null;
  symbol?: string | null;
  bias?: 'long' | 'short' | 'none';
  regime?: string | null;
  allowMomentumOverride?: boolean;
  favorMeanReversion?: boolean;
  playbook?: string | null;
  micro?: {
    spreadBps?: number | null;
    depthUsd?: number | null;
    slippageBps?: number | null;
    fillRatio?: number | null;
    takerFeeBps?: number | string | PreciseDecimal | null;
  };
  atr1h?: number | null;
  atr4h?: number | null;
  forceLiquidityGate?: boolean;
  multiTimeframe?: MultiTimeframeDiagnostics | null;
  accountBalanceUsd?: string | number | null;
  desiredProfitUsd?: string | number | null;
  fundamental?: {
    severity?: 'negative' | 'neutral' | 'positive';
    source?: string | null;
    message?: string | null;
    expiresAt?: number | null;
  } | null;
  derivatives?: PerpetualMetrics | null;
  onChain?: OnChainMetrics | null;
  sentiment?: SentimentSnapshot | null;
  watchlist?: WatchlistMeta | null;
  ranking?: {
    change24hPct?: number | null;
    volumeUsd?: number | null;
    volatilityPct?: number | null;
    momentumScore?: number | null;
  } | null;
};

function toRecognizedSignal(signal: AdaptiveSignal): RecognizedStrategySignal {
  const labelMap: Record<RecognizedStrategyId, string> = {
    classic_trend_following: 'Adaptive trend follower',
    breakout_retest: 'Adaptive breakout structure',
    bollinger_mean_reversion: 'Adaptive mean reversion',
    momentum_scanner_focus: 'Adaptive momentum scanner',
  };

  const metrics: Record<string, number | string | null> = {
    score: Number(signal.score.toFixed(4)),
    confidence: Number(signal.confidence.toFixed(4)),
    guardrail: signal.guardrail ?? null,
  };

  return {
    id: signal.id,
    label: labelMap[signal.id],
    bias: signal.bias,
    confidence: Number(signal.confidence.toFixed(4)),
    active: signal.active,
    reasons: signal.reasons,
    metrics,
    meta: {
      score: Number(signal.score.toFixed(4)),
      guardrail: signal.guardrail ?? null,
      penalties: signal.penalties,
      exploration: signal.exploration,
      token: signal.token ?? undefined,
      executionMode: signal.plan.executionMode,
      riskPct: signal.plan.riskPct.toFixed(6),
      stopAtrMult: signal.plan.stopAtrMult.toFixed(6),
      takeProfitMultiples: signal.plan.takeProfitMultiples.map(tp => tp.toFixed(4)),
      riskUsd: signal.plan.riskUsd.toFixed(6),
      targetProfitUsd: signal.plan.targetProfitUsd.toFixed(6),
      entryWeight: signal.plan.entryWeight.toFixed(6),
      pythonRiskMultiplier: signal.plan.pythonRiskMultiplier.toFixed(6),
      trailingPolicy: signal.plan.trailingPolicy
        ? {
            breakevenArmR: signal.plan.trailingPolicy.breakevenArmR.toNumber(),
            trailActivationR: signal.plan.trailingPolicy.trailActivationR.toNumber(),
            atrLookback: signal.plan.trailingPolicy.atrLookback,
            atrMultiplier: signal.plan.trailingPolicy.atrMultiplier.toNumber(),
            contextAlignmentThreshold: signal.plan.trailingPolicy.contextAlignmentThreshold.toNumber(),
            adxThreshold: signal.plan.trailingPolicy.adxThreshold.toNumber(),
          }
        : null,
      predictorFeatures: signal.predictorFeatures,
      pythonSignal: signal.pythonSignal
        ? {
            bias: signal.pythonSignal.bias,
            probability: signal.pythonSignal.probability,
            bearishProbability: signal.pythonSignal.bearishProbability,
            confidence: signal.pythonSignal.confidence,
            entryWeight: signal.pythonSignal.entryWeight,
            riskMultiplier: signal.pythonSignal.riskMultiplier,
            cooldown: signal.pythonSignal.cooldown,
            meta: signal.pythonSignal.meta ?? null,
          }
        : null,
    },
  };
}

export function evaluateRecognizedStrategies(
  snap: TechnicalSnapshot,
  opts: EvaluateOptions = {},
): RecognizedStrategySignal[] {
  const evaluation = metaAdaptiveStrategyAgent.evaluate({
    sessionId: opts.sessionId ?? null,
    symbol: opts.symbol ?? (snap.symbol || 'UNKNOWN'),
    snap,
    biasHint: opts.bias,
    micro: opts.micro,
    atr1h: opts.atr1h,
    atr4h: opts.atr4h,
    forceLiquidityGate: opts.forceLiquidityGate ?? false,
    multiTimeframe: opts.multiTimeframe ?? (snap as any)?.multiTimeframe ?? null,
    accountBalanceUsd: opts.accountBalanceUsd ?? null,
    desiredProfitUsd: opts.desiredProfitUsd ?? null,
    fundamental: opts.fundamental ?? null,
    derivatives: opts.derivatives ?? null,
    onChain: opts.onChain ?? null,
    sentiment: opts.sentiment ?? null,
    watchlist: opts.watchlist ?? null,
    ranking: opts.ranking ?? null,
  });

  return evaluation.signals
    .map(toRecognizedSignal)
    .sort((a, b) => b.meta!.score - a.meta!.score);
}

export async function registerAdaptiveTradeEntry(params: {
  sessionId?: string | null;
  symbol: string;
  signal: RecognizedStrategySignal | null;
  qty: number;
  entryPrice: number;
  stopDistance: number;
  fillRatio?: number | null;
  slippageBps?: number | null;
  spreadBps?: number | null;
  latencyMs?: number | null;
  passiveOffsetBps?: number | null;
  fallbackLatencyMs?: number | null;
  executionMode?: 'market' | 'limit' | 'twap';
}): Promise<void> {
  if (!params.signal || !params.signal.meta) return;
  const reentryCooldown = getQuantAIConfig().exits.reentryCooldownMin ?? 0;
  metaAdaptiveStrategyAgent.setReentryCooldownMinutes(reentryCooldown);
  const planRiskPct = new PreciseDecimal(params.signal.meta.riskPct ?? '0');
  const stopAtrMult = new PreciseDecimal(params.signal.meta.stopAtrMult ?? '1');
  const planRiskUsd = new PreciseDecimal(params.signal.meta.riskUsd ?? '0');
  const planTargetProfitUsd = new PreciseDecimal(params.signal.meta.targetProfitUsd ?? '0');
  const tpList = params.signal.meta.takeProfitMultiples ?? [];
  const medianIndex = tpList.length > 1 ? 1 : 0;
  const medianTakeProfitR = new PreciseDecimal(tpList[medianIndex] ?? '1');
  const trailingMeta = params.signal.meta.trailingPolicy ?? null;
  await metaAdaptiveStrategyAgent.registerActiveTrade({
    sessionId: params.sessionId,
    symbol: params.symbol,
    family: params.signal.id === 'classic_trend_following'
      ? 'trend'
      : params.signal.id === 'breakout_retest'
        ? 'breakout'
        : params.signal.id === 'bollinger_mean_reversion'
          ? 'mean_reversion'
          : 'momentum',
    id: params.signal.id,
    token: params.signal.meta.token ?? null,
    qty: params.qty,
    entryPrice: params.entryPrice,
    stopDistance: params.stopDistance,
    plan: {
      riskPct: planRiskPct,
      stopAtrMult,
      takeProfitMultiples: (params.signal.meta.takeProfitMultiples ?? []).map(v => new PreciseDecimal(v)),
      executionMode: params.signal.meta.executionMode ?? 'market',
      riskUsd: planRiskUsd,
      targetProfitUsd: planTargetProfitUsd,
      medianTakeProfitR,
      trailingPolicy: trailingMeta
        ? {
            breakevenArmR: new PreciseDecimal(trailingMeta.breakevenArmR ?? 0),
            trailActivationR: new PreciseDecimal(trailingMeta.trailActivationR ?? 0),
            atrLookback: trailingMeta.atrLookback,
            atrMultiplier: new PreciseDecimal(trailingMeta.atrMultiplier ?? 1),
            contextAlignmentThreshold: new PreciseDecimal(trailingMeta.contextAlignmentThreshold ?? 0.65),
            adxThreshold: new PreciseDecimal(trailingMeta.adxThreshold ?? 20),
          }
        : null,
      entryWeight: new PreciseDecimal(params.signal.meta.entryWeight ?? '1'),
      pythonRiskMultiplier: new PreciseDecimal(params.signal.meta.pythonRiskMultiplier ?? '1'),
    },
    side: params.signal.bias,
    predictorFeatures: params.signal.meta.predictorFeatures ?? null,
    pythonSignal: params.signal.meta.pythonSignal
      ? {
          bias: params.signal.meta.pythonSignal.bias,
          probability: params.signal.meta.pythonSignal.probability,
          bearishProbability: params.signal.meta.pythonSignal.bearishProbability,
          confidence: params.signal.meta.pythonSignal.confidence,
          entryWeight: params.signal.meta.pythonSignal.entryWeight,
          riskMultiplier: params.signal.meta.pythonSignal.riskMultiplier,
          cooldown: params.signal.meta.pythonSignal.cooldown,
          meta: params.signal.meta.pythonSignal.meta ?? null,
        }
      : null,
  });

  const executionMode = params.executionMode ?? params.signal.meta.executionMode ?? 'market';
  const fillRatio = Number.isFinite(params.fillRatio ?? NaN) ? Number(params.fillRatio) : null;
  const slippageBps = Number.isFinite(params.slippageBps ?? NaN) ? Number(params.slippageBps) : null;
  const spreadBps = Number.isFinite(params.spreadBps ?? NaN) ? Number(params.spreadBps) : null;
  const latencyMs = Number.isFinite(params.latencyMs ?? NaN) ? Number(params.latencyMs) : null;
  const passiveOffsetBps = Number.isFinite(params.passiveOffsetBps ?? NaN) ? Number(params.passiveOffsetBps) : null;
  const fallbackLatencyMs = Number.isFinite(params.fallbackLatencyMs ?? NaN) ? Number(params.fallbackLatencyMs) : null;
  const notionalUsd = Number.isFinite(params.entryPrice) && Number.isFinite(params.qty)
    ? params.entryPrice * params.qty
    : null;

  updateExecutionTelemetry(params.symbol, {
    symbol: params.symbol,
    mode: executionMode,
    fillRatio,
    slippageBps,
    spreadBps,
    latencyMs,
    passiveOffsetBps,
    fallbackTriggered: fallbackLatencyMs != null && fallbackLatencyMs > 0,
    notionalUsd,
  });

  const makerShare = executionMode === 'limit' && fillRatio != null ? Math.max(0, Math.min(1, fillRatio)) : null;
  const takerShare = executionMode === 'market'
    ? 1
    : fillRatio != null
      ? Number((1 - Math.max(0, Math.min(1, fillRatio))).toFixed(4))
      : null;

  recordOpsEvent({
    level: 'info',
    source: 'adaptive_plan_vs_fill',
    message: 'plan_fill_snapshot',
    symbol: params.symbol,
    details: {
      strategy: params.signal.id,
      executionMode,
      fillRatio,
      makerShare,
      takerShare,
      slippageBps,
      spreadBps,
      latencyMs,
      fallbackLatencyMs,
      notionalUsd,
      passiveOffsetBps,
    },
  });
}

export function registerAdaptiveTradeOutcome(params: {
  sessionId?: string | null;
  symbol: string;
  token?: string | null;
  realizedPnlUsd?: number | null;
}): void {
  metaAdaptiveStrategyAgent.registerOutcome(params);
}

export type { StrategyBias };
