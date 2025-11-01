import { metaAdaptiveStrategyAgent, AdaptiveSignal, PreciseDecimal } from './metaAdaptiveAgent.js';
import { computeInitialBracket } from './exitManager.js';
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
  qualityScore: number;
  confidenceGatePassed: boolean;
  blockedReason: string | null;
  entryEligibilityScore: number;
  entryEligibilityGatePassed: boolean;
  entryEligibilityReasons: string[];
  active: boolean;
  reasons: string[];
  metrics: Record<string, number | string | null>;
  meta?: {
    score: number;
    confidenceCalibrated?: number;
    confidenceThreshold?: number;
    qualityScore?: number;
    confidenceGatePassed?: boolean;
    blockedReason?: string | null;
    entryEligibilityScore?: number;
    entryEligibilityGatePassed?: boolean;
    entryEligibilityReasons?: string[];
    entryEligibilityComponents?: EntryEligibilityBreakdown['components'];
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
    entryAtr?: number | null;
    entryAtrPct?: number | null;
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
  volume24hUsd?: number | null;
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.72;
const BLOCKED_REASON_LOW_CONFIDENCE = 'low_confidence';
const BLOCKED_REASON_WEAK_CONTEXT = 'weak_entry_context';

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseConfidenceThreshold(): number {
  const raw = process.env.META_ADAPTIVE_CONFIDENCE_THRESHOLD
    ?? process.env.META_ADAPTIVE_CONF_THRESHOLD
    ?? process.env.META_ADAPTIVE_CONF_GATE;
  if (!raw) return DEFAULT_CONFIDENCE_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIDENCE_THRESHOLD;
  return clampNumber(parsed, 0, 1);
}

const CONFIDENCE_THRESHOLD = parseConfidenceThreshold();

export const metaAdaptiveConfidenceThreshold = CONFIDENCE_THRESHOLD;

const ENTRY_ELIGIBILITY_THRESHOLD = 0.58;

type EntryEligibilityBreakdown = {
  score: number;
  passed: boolean;
  reasons: string[];
  components: {
    mtf: number;
    adx: number;
    atr: number;
    flow: number;
  };
};

type MultiTimeframeBias = 'bullish' | 'bearish' | 'neutral' | 'mixed';

function normalizeBiasLabel(label: string | null | undefined): MultiTimeframeBias {
  const normalized = (label ?? '').toLowerCase();
  if (normalized.startsWith('bull')) return 'bullish';
  if (normalized.startsWith('bear')) return 'bearish';
  if (normalized.includes('mix')) return 'mixed';
  if (normalized.includes('neutral') || normalized.includes('flat') || normalized.includes('range')) return 'neutral';
  return 'mixed';
}

function desiredDirectionalBias(strategyBias: StrategyBias): MultiTimeframeBias | null {
  if (strategyBias === 'both') return null;
  return strategyBias === 'short' ? 'bearish' : 'bullish';
}

function computeMtfComponent(
  bias: StrategyBias,
  snap: TechnicalSnapshot,
): { score: number; reason: string } {
  const desired = desiredDirectionalBias(bias);
  const frames = (snap.multiTimeframe as any)?.timeframes ?? null;
  const ordered = ['4h', '1h', '15m'];
  let total = 0;
  let matches = 0;
  let partial = 0;
  if (!desired || !frames) {
    return { score: 0.6, reason: 'mtf=neutral(no_direction)' };
  }
  for (const tf of ordered) {
    const frameBias = frames?.[tf]?.bias ?? null;
    if (!frameBias) {
      partial += 0.5;
      continue;
    }
    total += 1;
    const normalized = normalizeBiasLabel(frameBias);
    if (normalized === desired) {
      matches += 1;
      partial += 1;
    } else if (normalized === 'mixed' || normalized === 'neutral') {
      partial += 0.5;
    }
  }
  const divisor = ordered.length;
  const score = divisor > 0 ? clampNumber(partial / divisor, 0, 1) : 0.6;
  const reason = `mtf=${matches >= 2 ? 'pass' : 'warn'}(${matches}/${ordered.length})`;
  return { score, reason };
}

function getStrategyFamilyFromId(id: RecognizedStrategyId): 'trend' | 'breakout' | 'mean' | 'momentum' {
  if (id === 'classic_trend_following') return 'trend';
  if (id === 'breakout_retest') return 'breakout';
  if (id === 'bollinger_mean_reversion') return 'mean';
  return 'momentum';
}

const MIN_ADX_BY_STRATEGY: Record<'trend' | 'breakout' | 'mean' | 'momentum', number> = {
  trend: 18,
  breakout: 16,
  mean: 12,
  momentum: 20,
};

const MIN_ATR_BY_STRATEGY: Record<'trend' | 'breakout' | 'mean' | 'momentum', number> = {
  trend: 0.8,
  breakout: 0.7,
  mean: 0.5,
  momentum: 0.75,
};

function computeAdxComponent(id: RecognizedStrategyId, snap: TechnicalSnapshot): { score: number; reason: string } {
  const family = getStrategyFamilyFromId(id);
  const minAdx = MIN_ADX_BY_STRATEGY[family];
  const adxRaw = Number((snap as any)?.adx14 ?? NaN);
  const adx = Number.isFinite(adxRaw) ? adxRaw : 0;
  const margin = 12;
  const normalized = (adx - (minAdx - 5)) / margin;
  const score = clampNumber(normalized, 0, 1);
  const reason = `adx=${adx >= minAdx ? 'pass' : 'fail'}(${adx.toFixed(1)}>=${minAdx})`;
  return { score, reason };
}

function computeAtrComponent(id: RecognizedStrategyId, snap: TechnicalSnapshot): { score: number; reason: string } {
  const family = getStrategyFamilyFromId(id);
  const minAtr = MIN_ATR_BY_STRATEGY[family];
  const atrRaw = Number((snap as any)?.atrPct ?? NaN);
  const atr = Number.isFinite(atrRaw) ? atrRaw : 0;
  const normalized = (atr - minAtr) / (Math.max(minAtr, 0.01));
  const score = clampNumber(normalized, 0, 1);
  const reason = `atr=${atr >= minAtr ? 'pass' : 'fail'}(${atr.toFixed(2)}>=${minAtr.toFixed(2)})`;
  return { score, reason };
}

function computeFlowComponent(
  bias: StrategyBias,
  snap: TechnicalSnapshot,
): { score: number; reason: string } {
  const volume = Number((snap as any)?.volume ?? NaN);
  const volumeMA = Number((snap as any)?.volumeMA ?? NaN);
  const cmfRaw = Number((snap as any)?.cmf20 ?? NaN);
  const cmf = Number.isFinite(cmfRaw) ? cmfRaw : 0;
  const ratio = Number.isFinite(volume) && Number.isFinite(volumeMA) && volumeMA > 0 ? volume / volumeMA : 1;
  const minVolumeRatio = 1.1;
  const desired = desiredDirectionalBias(bias);
  let cmfThreshold = 0.08;
  let cmfMagnitude = cmf;
  if (desired === 'bearish') {
    cmfThreshold = -0.08;
    cmfMagnitude = -cmf;
  }
  if (!desired) {
    cmfThreshold = 0.05;
    cmfMagnitude = Math.abs(cmf);
  }
  const cmfScore = clampNumber((cmfMagnitude - Math.abs(cmfThreshold)) / 0.2, 0, 1);
  const volumeScore = clampNumber((ratio - minVolumeRatio) / 0.6, 0, 1);
  const score = clampNumber(cmfScore * 0.6 + volumeScore * 0.4, 0, 1);
  const reason = `flow=${cmfMagnitude >= Math.abs(cmfThreshold) && ratio >= minVolumeRatio ? 'pass' : 'fail'}(cmf=${cmf.toFixed(2)},vol=${ratio.toFixed(2)})`;
  return { score, reason };
}

function computeEntryEligibility(
  signal: AdaptiveSignal,
  snap: TechnicalSnapshot,
): EntryEligibilityBreakdown {
  const mtf = computeMtfComponent(signal.bias, snap);
  const adx = computeAdxComponent(signal.id, snap);
  const atr = computeAtrComponent(signal.id, snap);
  const flow = computeFlowComponent(signal.bias, snap);
  const score = Number(
    clampNumber(
      mtf.score * 0.35
        + adx.score * 0.25
        + atr.score * 0.2
        + flow.score * 0.2,
      0,
      1,
    ).toFixed(4),
  );
  const passed = score >= ENTRY_ELIGIBILITY_THRESHOLD;
  const reasons = [mtf.reason, adx.reason, atr.reason, flow.reason];
  return {
    score,
    passed,
    reasons,
    components: {
      mtf: Number(mtf.score.toFixed(4)),
      adx: Number(adx.score.toFixed(4)),
      atr: Number(atr.score.toFixed(4)),
      flow: Number(flow.score.toFixed(4)),
    },
  };
}

function computeQualityScore(signal: AdaptiveSignal): number {
  const baseScore = clampNumber(signal.score, 0, 1);
  const penaltyOffset = Math.min(signal.penalties.length, 6) * 3.5;
  const guardrailPenalty = signal.guardrail ? 15 : 0;
  const explorationPenalty = signal.exploration ? 5 : 0;
  const activeBonus = signal.active ? 5 : -12;
  const pythonConfidenceValue = typeof signal.pythonSignal?.confidence === 'number'
    ? signal.pythonSignal.confidence
    : null;
  const pythonAdjustment = pythonConfidenceValue != null && Number.isFinite(pythonConfidenceValue)
    ? (clampNumber(pythonConfidenceValue, 0, 1) - 0.5) * 20
    : 0;
  const rawQuality = baseScore * 100
    - penaltyOffset
    - guardrailPenalty
    - explorationPenalty
    + activeBonus
    + pythonAdjustment;
  return Number(clampNumber(rawQuality, 0, 100).toFixed(2));
}

function computeCalibratedConfidence(signal: AdaptiveSignal): number {
  const baseScore = clampNumber(signal.score, 0, 1);
  const rawConfidence = clampNumber(signal.confidence ?? baseScore, 0, 1);
  const pythonConfidence = typeof signal.pythonSignal?.confidence === 'number'
    ? signal.pythonSignal.confidence
    : null;
  const pythonBlend = pythonConfidence != null && Number.isFinite(pythonConfidence)
    ? clampNumber(pythonConfidence, 0, 1)
    : null;
  let blended = baseScore * 0.6 + rawConfidence * 0.4;
  if (pythonBlend != null) {
    blended = blended * 0.7 + pythonBlend * 0.3;
  }
  let calibrated = 0.35 + blended * 0.55;
  const penaltyImpact = Math.min(signal.penalties.length * 0.02, 0.2);
  const guardrailImpact = signal.guardrail ? 0.12 : 0;
  const explorationImpact = signal.exploration ? 0.04 : 0;
  calibrated -= penaltyImpact + guardrailImpact + explorationImpact;
  if (!signal.active) {
    calibrated *= 0.7;
  }
  return Number(clampNumber(calibrated, 0, 1).toFixed(4));
}

function toRecognizedSignal(signal: AdaptiveSignal, snap: TechnicalSnapshot): RecognizedStrategySignal {
  const labelMap: Record<RecognizedStrategyId, string> = {
    classic_trend_following: 'Adaptive trend follower',
    breakout_retest: 'Adaptive breakout structure',
    bollinger_mean_reversion: 'Adaptive mean reversion',
    momentum_scanner_focus: 'Adaptive momentum scanner',
  };

  const calibratedConfidence = computeCalibratedConfidence(signal);
  const qualityScore = computeQualityScore(signal);
  const entryEligibility = computeEntryEligibility(signal, snap);
  const confidenceGatePassed = calibratedConfidence >= CONFIDENCE_THRESHOLD;
  const gateReasons: string[] = [];
  if (!confidenceGatePassed) gateReasons.push(BLOCKED_REASON_LOW_CONFIDENCE);
  if (!entryEligibility.passed) gateReasons.push(BLOCKED_REASON_WEAK_CONTEXT);
  const blockedReason = gateReasons.length > 0 ? gateReasons.join('|') : null;

  const metrics: Record<string, number | string | null> = {
    score: Number(signal.score.toFixed(4)),
    rawConfidence: Number(signal.confidence.toFixed(4)),
    confidence: calibratedConfidence,
    qualityScore,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    confidenceGatePassed: confidenceGatePassed ? 1 : 0,
    entryEligibilityScore: entryEligibility.score,
    entryEligibilityGatePassed: entryEligibility.passed ? 1 : 0,
    entryEligibilityReasons: entryEligibility.reasons.join('|'),
    entryEligibilityMtf: entryEligibility.components.mtf,
    entryEligibilityAdx: entryEligibility.components.adx,
    entryEligibilityAtr: entryEligibility.components.atr,
    entryEligibilityFlow: entryEligibility.components.flow,
    guardrail: signal.guardrail ?? null,
  };

  return {
    id: signal.id,
    label: labelMap[signal.id],
    bias: signal.bias,
    confidence: calibratedConfidence,
    qualityScore,
    confidenceGatePassed,
    blockedReason,
    entryEligibilityScore: entryEligibility.score,
    entryEligibilityGatePassed: entryEligibility.passed,
    entryEligibilityReasons: entryEligibility.reasons,
    active: signal.active && entryEligibility.passed && confidenceGatePassed,
    reasons: signal.reasons,
    metrics,
    meta: {
      score: Number(signal.score.toFixed(4)),
      confidenceCalibrated: calibratedConfidence,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      qualityScore,
      confidenceGatePassed,
      blockedReason,
      entryEligibilityScore: entryEligibility.score,
      entryEligibilityGatePassed: entryEligibility.passed,
      entryEligibilityReasons: entryEligibility.reasons,
      entryEligibilityComponents: entryEligibility.components,
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
      entryAtr: Number.isFinite((snap as any)?.atr14) ? Number((snap as any).atr14) : null,
      entryAtrPct: Number.isFinite((snap as any)?.atrPct) ? Number((snap as any).atrPct) : null,
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
    volume24hUsd: opts.volume24hUsd ?? null,
  });

  if (process.env.META_ADAPTIVE_BT_DEBUG === 'true' && evaluation.signals.length === 0) {
    const metaSummary = {
      atrPct: Number((snap as any)?.atrPct ?? 0),
      adx: Number((snap as any)?.adx14 ?? 0),
      cmf: Number((snap as any)?.cmf20 ?? 0),
      volume: Number((snap as any)?.volume ?? 0),
      volumeMA: Number((snap as any)?.volumeMA ?? 0),
      trendStrength: Number((snap as any)?.trendStrength ?? 0),
      srBias: (snap as any)?.srBias ?? 'n/a',
    };
    if (!(globalThis as any).__metaAdaptiveBacktestLogged) {
      // eslint-disable-next-line no-console
      console.log('[meta-adaptive-backtest] no_signals', metaSummary);
      (globalThis as any).__metaAdaptiveBacktestLogged = true;
    }
  }

  return evaluation.signals
    .map(signal => toRecognizedSignal(signal, snap))
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
  const confidenceGatePassed = params.signal.confidenceGatePassed
    ?? (Number.isFinite(params.signal.confidence) ? params.signal.confidence >= CONFIDENCE_THRESHOLD : false);
  const entryGatePassed = params.signal.entryEligibilityGatePassed
    ?? (Number.isFinite(params.signal.entryEligibilityScore)
      ? params.signal.entryEligibilityScore >= ENTRY_ELIGIBILITY_THRESHOLD
      : true);
  const entryReasons = (params.signal.entryEligibilityReasons?.length
    ? params.signal.entryEligibilityReasons
    : params.signal.meta?.entryEligibilityReasons) ?? [];
  if (!confidenceGatePassed || !entryGatePassed) {
    const signalConfidence = Number.isFinite(params.signal.confidence) ? params.signal.confidence : 0;
    const qualityScore = Number.isFinite(params.signal.qualityScore) ? params.signal.qualityScore : null;
    const entryScore = Number.isFinite(params.signal.entryEligibilityScore) ? params.signal.entryEligibilityScore : null;
    const blocked: string[] = [];
    if (!confidenceGatePassed) blocked.push(BLOCKED_REASON_LOW_CONFIDENCE);
    if (!entryGatePassed) blocked.push(BLOCKED_REASON_WEAK_CONTEXT);
    const fallbackReason = params.signal.blockedReason ?? BLOCKED_REASON_LOW_CONFIDENCE;
    const blockedReason = blocked.length > 0 ? blocked.join('|') : fallbackReason;
    recordOpsEvent({
      level: 'info',
      source: 'meta_adaptive_gate',
      message: 'trade_blocked',
      symbol: params.symbol,
      details: {
        strategy: params.signal.id,
        blockedReason,
        confidence: Number(signalConfidence.toFixed(4)),
        confidenceThreshold: CONFIDENCE_THRESHOLD,
        qualityScore,
        entryEligibilityScore: entryScore,
        entryEligibilityThreshold: ENTRY_ELIGIBILITY_THRESHOLD,
        entryReasons,
      },
    });
    console.log(JSON.stringify({
      level: 'info',
      event: 'adaptive_trade_blocked_by_gate',
      symbol: params.symbol,
      sessionId: params.sessionId ?? null,
      strategy: params.signal.id,
      blockedReason,
      confidence: Number(signalConfidence.toFixed(4)),
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      qualityScore,
      entryEligibilityScore: entryScore,
      entryEligibilityThreshold: ENTRY_ELIGIBILITY_THRESHOLD,
      entryReasons,
    }));
    return;
  }
  if (process.env.UNIT_TEST_MODE !== 'true' || entryReasons.length > 0) {
    recordOpsEvent({
      level: 'info',
      source: 'meta_adaptive_gate',
      message: 'entry_context_pass',
      symbol: params.symbol,
      details: {
        strategy: params.signal.id,
        confidence: Number(params.signal.confidence.toFixed(4)),
        qualityScore: Number.isFinite(params.signal.qualityScore) ? params.signal.qualityScore : null,
        entryEligibilityScore: Number.isFinite(params.signal.entryEligibilityScore)
          ? params.signal.entryEligibilityScore
          : null,
        entryReasons,
      },
    });
  }
  const quantConfig = getQuantAIConfig();
  const exitCfgBase = quantConfig.exits;
  const reentryCooldown = exitCfgBase.reentryCooldownMin ?? 0;
  metaAdaptiveStrategyAgent.setReentryCooldownMinutes(reentryCooldown);

  const rrThresholdRaw = process.env.META_ADAPTIVE_MIN_RR ?? process.env.META_ADAPTIVE_RR_MIN ?? '1.8';
  const rrThreshold = Number.parseFloat(rrThresholdRaw);
  const minRr = Number.isFinite(rrThreshold) && rrThreshold > 0 ? rrThreshold : 2;

  const side: 'long' | 'short' = params.signal.bias === 'short' ? 'short' : 'long';
  const entryAtrFromMeta = Number(params.signal.meta.entryAtr ?? Number.NaN);
  const entryAtrPct = Number(params.signal.meta.entryAtrPct ?? Number.NaN);
  let entryAtr = Number.isFinite(entryAtrFromMeta) && entryAtrFromMeta > 0 ? entryAtrFromMeta : Number.NaN;
  if ((!Number.isFinite(entryAtr) || entryAtr <= 0) && Number.isFinite(entryAtrPct) && entryAtrPct > 0) {
    entryAtr = (entryAtrPct / 100) * Math.max(Math.abs(params.entryPrice), 1);
  }
  if (!Number.isFinite(entryAtr) || entryAtr <= 0) {
    entryAtr = Math.max(Math.abs(params.stopDistance), 1);
  }
  const resolvedEntryAtrPct = Number.isFinite(entryAtrPct) && entryAtrPct > 0
    ? entryAtrPct
    : entryAtr > 0 && Number.isFinite(params.entryPrice) && params.entryPrice !== 0
      ? (entryAtr / Math.abs(params.entryPrice)) * 100
      : null;

  const rawMultipliers = Array.isArray((params.signal.meta as any)?.takeProfitMultiples)
    ? (params.signal.meta as any).takeProfitMultiples
    : [];
  const metaMultipliers = rawMultipliers
    .map((value: any) => Number(value))
    .filter((value: number) => Number.isFinite(value) && value > 0);

  let exitCfg = exitCfgBase;
  if (metaMultipliers.length) {
    exitCfg = { ...exitCfgBase, tpRMultiples: metaMultipliers };
  } else if (!exitCfg.tpRMultiples.length) {
    exitCfg = { ...exitCfgBase, tpRMultiples: [minRr] };
  }
  const tpMultipliers = exitCfg.tpRMultiples.length ? exitCfg.tpRMultiples.slice() : [minRr];
  if (tpMultipliers[0] < minRr) {
    tpMultipliers[0] = minRr;
  }
  exitCfg = { ...exitCfg, tpRMultiples: tpMultipliers };

  const direction = side === 'short' ? -1 : 1;
  let stopDistance = Math.max(1e-6, Math.abs(params.stopDistance));
  let targets: number[] = [];
  try {
    const bracket = computeInitialBracket(
      params.entryPrice,
      entryAtr,
      side,
      exitCfg,
      'impulse',
    );
    stopDistance = Math.max(bracket.riskPerUnit, 1e-6);
    targets = Array.isArray(bracket.targets) ? [...bracket.targets] : [];
  } catch (error) {
    const fallbackRisk = entryAtr > 0
      ? Math.max((exitCfg.minStopAtrMult ?? 0) * entryAtr, stopDistance)
      : stopDistance;
    stopDistance = Math.max(fallbackRisk, 1e-6);
    if (process.env.UNIT_TEST_MODE !== 'true') {
      console.warn('[meta-adaptive] computeInitialBracket failed, using fallback risk', {
        symbol: params.symbol,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!targets.length) {
    targets = tpMultipliers.map((multiple) => params.entryPrice + direction * multiple * stopDistance);
  }
  const firstTarget = targets[0] ?? params.entryPrice;
  const rrNumerator = Math.abs(firstTarget - params.entryPrice);
  const rr = stopDistance > 0 ? rrNumerator / stopDistance : 0;
  if (!(Number.isFinite(rr) && rr >= minRr)) {
    const blockedReason = 'rr_below_min';
    recordOpsEvent({
      level: 'warn',
      source: 'meta_adaptive_gate',
      message: 'trade_blocked',
      symbol: params.symbol,
      details: {
        strategy: params.signal.id,
        blockedReason,
        rr,
        rrThreshold: minRr,
      },
    });
    console.log(JSON.stringify({
      level: 'info',
      event: 'adaptive_trade_blocked_by_gate',
      symbol: params.symbol,
      sessionId: params.sessionId ?? null,
      strategy: params.signal.id,
      blockedReason,
      rr,
      rrThreshold: minRr,
    }));
    return;
  }

  const qtyAbs = Math.abs(params.qty);
  const riskPerUnit = stopDistance;
  const riskUsdValue = riskPerUnit * qtyAbs;
  const targetProfitUsdValue = Math.abs(rrNumerator) * qtyAbs;
  const stopAtrMultValue = entryAtr > 0 ? riskPerUnit / entryAtr : Number(params.signal.meta.stopAtrMult ?? 1);

  const planRiskPct = new PreciseDecimal(params.signal.meta.riskPct ?? '0');
  const stopAtrMult = new PreciseDecimal(Number.isFinite(stopAtrMultValue) ? stopAtrMultValue.toFixed(6) : (params.signal.meta.stopAtrMult ?? '1'));
  const planRiskUsd = new PreciseDecimal(riskUsdValue.toFixed(6));
  const planTargetProfitUsd = new PreciseDecimal(targetProfitUsdValue.toFixed(6));
  const takeProfitMultiplesPrecise = tpMultipliers.map((multiple) => new PreciseDecimal(multiple.toFixed(6)));
  const medianIndex = takeProfitMultiplesPrecise.length > 1 ? 1 : 0;
  const medianTakeProfitR = takeProfitMultiplesPrecise[medianIndex] ?? new PreciseDecimal('1');
  const trailingMeta = params.signal.meta.trailingPolicy ?? null;

  if (process.env.UNIT_TEST_MODE !== 'true' && (riskUsdValue <= 0 || targetProfitUsdValue <= 0)) {
    console.warn('[meta-adaptive] Invalid risk/target computation', {
      symbol: params.symbol,
      riskUsdValue,
      targetProfitUsdValue,
      rr,
    });
  }
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
    stopDistance,
    entryAtr,
    entryAtrPct: resolvedEntryAtrPct != null && Number.isFinite(resolvedEntryAtrPct) ? resolvedEntryAtrPct : null,
    riskPerUnit,
    targets,
    rr,
    plan: {
      riskPct: planRiskPct,
      stopAtrMult,
      takeProfitMultiples: takeProfitMultiplesPrecise,
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
