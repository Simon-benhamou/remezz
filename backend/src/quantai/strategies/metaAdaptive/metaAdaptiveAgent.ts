import { TechnicalSnapshot } from '../../../ai/tech.js';
import type { Diagnostics as MultiTimeframeDiagnostics } from '../../../ai/multiTimeframe.js';
import { defaultCalibrationProfile, type CalibrationProfile } from './metaAdaptiveCalibration.js';
import { getMarketContext, type MarketContextSnapshot, type PerpetualMetrics, type OnChainMetrics, type SentimentSnapshot, type WatchlistMeta } from '../../../analytics/marketContext.js';
import { detectMarketRegime, type MarketRegimeSignal } from '../../regime/marketRegimeDetector.js';
import {
  getPrediction as getPythonPrediction,
  getPredictionSync as getPythonPredictionSync,
  getPythonResolutionError,
  isPythonPredictorAvailable,
} from '../../pythonPredictor.js';
import type { PythonPredictionProbabilities, PythonPredictionResult } from '../../pythonPredictor.js';
import { getPythonSignalTuning } from '../../pythonSignalTuning.js';
import { PythonPerformanceTracker } from '../../pythonPerformanceTracker.js';
import type { StrategyFamily, StrategyBias } from './strategyTypes.js';
import { areAgentGuardsDisabled } from '../../../utils/agentGuards.js';

const DECIMAL_SCALE = 1_000_000n;
const pythonSignalTuning = getPythonSignalTuning();
const BASE_PYTHON_BIAS_WEIGHT = pythonSignalTuning.biasWeight;
const PYTHON_NEUTRAL_THRESHOLD = pythonSignalTuning.neutralThreshold;
const PYTHON_GATE_THRESHOLD = pythonSignalTuning.gateThreshold;
const DEFAULT_SHORT_CMF_THRESHOLD = 0.08;
const PYTHON_BIAS_BOOST_FLOOR = pythonSignalTuning.highConfidenceFloor;
const PYTHON_BOOST_PROB_THRESHOLD = pythonSignalTuning.highConfidenceProb;
const PYTHON_BOOST_CONF_THRESHOLD = pythonSignalTuning.highConfidenceConfidence;
const PYTHON_RISK_BOOST_MULTIPLIER = pythonSignalTuning.highConfidenceRiskBoost;
const PYTHON_BOOST_MIN_SAMPLES = pythonSignalTuning.minSamplesForBoost;
const PREDICTOR_MIN_PROB_LONG = sanitizeProbabilityThreshold(process.env.PRED_MIN_PROB_LONG, 0.58);
const PREDICTOR_MIN_PROB_SHORT = sanitizeProbabilityThreshold(process.env.PRED_MIN_PROB_SHORT, 0.55);
const PREDICTOR_MIN_CONFIDENCE = sanitizeProbabilityThreshold(process.env.PRED_MIN_CONF, 0.35);

function normalizeDecimalString(input: string): { sign: bigint; intPart: string; fracPart: string } {
  const trimmed = input.trim();
  if (!trimmed) return { sign: 1n, intPart: '0', fracPart: '000000' };
  const negative = trimmed.startsWith('-');
  const cleaned = trimmed.replace(/[^0-9.]/g, '');
  if (!cleaned) return { sign: negative ? -1n : 1n, intPart: '0', fracPart: '000000' };
  const [intRaw, fracRaw = ''] = cleaned.split('.');
  const intPart = intRaw === '' ? '0' : intRaw;
  const fracPart = (fracRaw + '000000').slice(0, 6);
  return { sign: negative ? -1n : 1n, intPart, fracPart };
}

function toBigIntScaled(value: string | number | PreciseDecimal): bigint {
  if (value instanceof PreciseDecimal) return value.raw;
  if (typeof value === 'number') {
    const fixed = Number.isFinite(value) ? value.toFixed(8) : '0';
    const { sign, intPart, fracPart } = normalizeDecimalString(fixed);
    return sign * (BigInt(intPart || '0') * DECIMAL_SCALE + BigInt(fracPart));
  }
  const { sign, intPart, fracPart } = normalizeDecimalString(value);
  return sign * (BigInt(intPart || '0') * DECIMAL_SCALE + BigInt(fracPart));
}

export class PreciseDecimal {
  public raw: bigint;

  constructor(value: string | number | PreciseDecimal) {
    this.raw = toBigIntScaled(value);
  }

  static fromRaw(raw: bigint): PreciseDecimal {
    const decimal = Object.create(PreciseDecimal.prototype) as PreciseDecimal;
    decimal.raw = raw;
    return decimal;
  }

  plus(other: PreciseDecimal): PreciseDecimal {
    return PreciseDecimal.fromRaw(this.raw + other.raw);
  }

  minus(other: PreciseDecimal): PreciseDecimal {
    return PreciseDecimal.fromRaw(this.raw - other.raw);
  }

  times(other: PreciseDecimal): PreciseDecimal {
    return PreciseDecimal.fromRaw((this.raw * other.raw) / DECIMAL_SCALE);
  }

  dividedBy(other: PreciseDecimal): PreciseDecimal {
    if (other.raw === 0n) return PreciseDecimal.fromRaw(0n);
    return PreciseDecimal.fromRaw((this.raw * DECIMAL_SCALE) / other.raw);
  }

  abs(): PreciseDecimal {
    return PreciseDecimal.fromRaw(this.raw < 0 ? -this.raw : this.raw);
  }

  gt(other: number | PreciseDecimal): boolean {
    const rhs = other instanceof PreciseDecimal ? other.raw : toBigIntScaled(other);
    return this.raw > rhs;
  }

  lt(other: number | PreciseDecimal): boolean {
    const rhs = other instanceof PreciseDecimal ? other.raw : toBigIntScaled(other);
    return this.raw < rhs;
  }

  equals(other: number | PreciseDecimal): boolean {
    const rhs = other instanceof PreciseDecimal ? other.raw : toBigIntScaled(other);
    return this.raw === rhs;
  }

  toNumber(): number {
    return Number(this.raw) / Number(DECIMAL_SCALE);
  }

  toFixed(decimals: number): string {
    const sign = this.raw < 0 ? '-' : '';
    const absRaw = this.raw < 0 ? -this.raw : this.raw;
    const intPart = absRaw / DECIMAL_SCALE;
    const fracPart = absRaw % DECIMAL_SCALE;
    const fracStr = fracPart.toString().padStart(6, '0');
    if (decimals <= 0) {
      return `${sign}${intPart.toString()}`;
    }
    const trimmed = fracStr.slice(0, Math.min(6, decimals));
    return `${sign}${intPart.toString()}.${trimmed.padEnd(decimals, '0')}`;
  }
}

function sanitizeProbabilityThreshold(raw: string | number | undefined, fallback: number): number {
  const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

export type { StrategyFamily, StrategyBias } from './strategyTypes.js';

type StrategyId =
  | 'classic_trend_following'
  | 'breakout_retest'
  | 'bollinger_mean_reversion'
  | 'momentum_scanner_focus';

type MultiTimeframeConsensus = 'bullish' | 'bearish' | 'neutral' | 'mixed';

export type AdaptiveTrailingPolicy = {
  breakevenArmR: PreciseDecimal;
  trailActivationR: PreciseDecimal;
  atrLookback: 'atr15m' | 'atr1h';
  atrMultiplier: PreciseDecimal;
  contextAlignmentThreshold: PreciseDecimal;
  adxThreshold: PreciseDecimal;
};

export type AdaptiveStrategyPlan = {
  riskPct: PreciseDecimal;
  stopAtrMult: PreciseDecimal;
  takeProfitMultiples: PreciseDecimal[];
  executionMode: 'market' | 'limit' | 'twap';
  riskUsd: PreciseDecimal;
  targetProfitUsd: PreciseDecimal;
  medianTakeProfitR: PreciseDecimal;
  trailingPolicy?: AdaptiveTrailingPolicy | null;
  entryWeight: PreciseDecimal;
  pythonRiskMultiplier: PreciseDecimal;
};

type PythonHybridSignal = {
  bias: StrategyBias;
  decision: 'long' | 'short' | 'none';
  probabilities: PythonPredictionProbabilities;
  probabilityLong: number;
  probabilityShort: number;
  probabilityNone: number;
  primaryProbability: number;
  confidence: number;
  entryWeight: number;
  riskMultiplier: number;
  cooldown: { active: boolean; reason: string | null; seconds: number | null };
  meta?: Record<string, unknown> | null;
};

type PredictorGateResult = {
  bias: StrategyBias;
  decision: 'long' | 'short' | 'none';
  primaryProbability: number;
  topLabel: 'long' | 'short' | 'none';
};

function evaluatePredictorGate(probabilities: PythonPredictionProbabilities, confidence: number): PredictorGateResult {
  const entries: Array<{ label: 'long' | 'short' | 'none'; value: number }> = [
    { label: 'long', value: clamp(probabilities.long, 0, 1) },
    { label: 'short', value: clamp(probabilities.short, 0, 1) },
    { label: 'none', value: clamp(probabilities.none, 0, 1) },
  ];
  entries.sort((a, b) => b.value - a.value);
  const [top] = entries;
  const meetsConfidence = confidence >= PREDICTOR_MIN_CONFIDENCE;

  if (top.label === 'long' && top.value >= PREDICTOR_MIN_PROB_LONG && meetsConfidence) {
    return { bias: 'long', decision: 'long', primaryProbability: top.value, topLabel: top.label };
  }
  if (top.label === 'short' && top.value >= PREDICTOR_MIN_PROB_SHORT && meetsConfidence) {
    return { bias: 'short', decision: 'short', primaryProbability: top.value, topLabel: top.label };
  }
  return { bias: 'both', decision: 'none', primaryProbability: top.value, topLabel: top.label };
}

function buildHybridSignal(result: PythonPredictionResult): PythonHybridSignal {
  const probabilities = {
    long: clamp(result.probabilities.long, 0, 1),
    short: clamp(result.probabilities.short, 0, 1),
    none: clamp(result.probabilities.none, 0, 1),
  };
  const sum = probabilities.long + probabilities.short + probabilities.none;
  if (sum > 0) {
    probabilities.long /= sum;
    probabilities.short /= sum;
    probabilities.none /= sum;
  } else {
    probabilities.long = probabilities.short = probabilities.none = 1 / 3;
  }

  const gate = evaluatePredictorGate(probabilities, result.confidence);

  const cooldownSeconds = typeof result.cooldown?.seconds === 'number' && Number.isFinite(result.cooldown.seconds)
    ? result.cooldown.seconds
    : null;

  return {
    bias: gate.bias,
    decision: gate.decision,
    probabilities,
    probabilityLong: probabilities.long,
    probabilityShort: probabilities.short,
    probabilityNone: probabilities.none,
    primaryProbability: gate.primaryProbability,
    confidence: clamp(result.confidence, 0, 1),
    entryWeight: clamp(result.entryWeight ?? 1, 0.2, 3),
    riskMultiplier: clamp(result.riskMultiplier ?? 1, 0.2, 3),
    cooldown: {
      active: Boolean(result.cooldown?.active),
      reason: result.cooldown?.reason ?? null,
      seconds: cooldownSeconds,
    },
    meta: result.meta ?? null,
  };
}

function computeProbabilityEdge(signal: Pick<PythonHybridSignal, 'probabilityLong' | 'probabilityShort'>): number {
  return clamp(signal.probabilityLong - signal.probabilityShort, -1, 1);
}

type StrategyScoreResult = {
  family: StrategyFamily;
  id: StrategyId;
  bias: StrategyBias;
  score: number;
  confidence: number;
  active: boolean;
  reasons: string[];
  penalties: string[];
  guardrail?: string | null;
  plan: AdaptiveStrategyPlan;
  predictorFeatures: Record<string, number> | null;
  pythonSignal: PythonHybridSignal | null;
};

export type AdaptiveSignal = StrategyScoreResult & {
  exploration: boolean;
  token: string | null;
};

export type AdaptiveTradeSnapshot = {
  token: string;
  symbol: string;
  side: StrategyBias;
  qty: number;
  entryPrice: number;
  riskPerUnit: number;
  targets: number[];
  entryAtr: number | null;
  entryAtrPct: number | null;
  riskUsd: number;
  targetProfitUsd: number;
  rr: number | null;
};

export type AdaptiveExitReason =
  | 'tp'
  | 'sl'
  | 'trailing'
  | 'timeout'
  | 'predictor_blocked'
  | 'min_hold_violation_prevented'
  | 'other';

export type AdaptiveEvaluationInput = {
  sessionId?: string | null;
  symbol: string;
  snap: TechnicalSnapshot;
  biasHint?: 'long' | 'short' | 'none';
  micro?: {
    spreadBps?: number | null;
    depthUsd?: number | null;
    slippageBps?: number | null;
    fillRatio?: number | null;
    takerFeeBps?: number | string | PreciseDecimal | null;
  };
  atr1h?: number | null;
  atr4h?: number | null;
  volume24hUsd?: number | null;
  forceLiquidityGate?: boolean;
  multiTimeframe?: MultiTimeframeDiagnostics | null;
  accountBalanceUsd?: string | number | PreciseDecimal | null;
  desiredProfitUsd?: string | number | PreciseDecimal | null;
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

type StrategyStats = {
  outcomes: PreciseDecimal[];
  sum: PreciseDecimal;
  wins: number;
  losses: number;
};

type ActiveTrade = {
  token: string;
  family: StrategyFamily;
  id: StrategyId;
  riskUsd: PreciseDecimal;
  riskPerUnit: PreciseDecimal;
  atrPct: number;
  timestamp: number;
  symbol: string;
  side: StrategyBias;
  qty: PreciseDecimal;
  entryPrice: PreciseDecimal;
  entryAtr: number | null;
  entryAtrPct: number | null;
  planRiskPct: PreciseDecimal;
  targetProfitUsd: PreciseDecimal;
  medianTakeProfitR: PreciseDecimal;
  targets: number[];
  rr: number | null;
  trailingPolicy?: AdaptiveTrailingPolicy | null;
  pythonProbability?: number;
  pythonConfidence?: number;
  pythonEntryWeight?: number;
  pythonRiskMultiplier?: number;
  pythonCooldownSeconds?: number | null;
  pythonTrackingKey?: string | null;
  minHoldMinutes: number | null;
  sideEffective: 'long' | 'short';
  minHoldGuardActive: boolean;
  minHoldGuardCount: number;
  minHoldGuardLastTs: number | null;
  lastExitReason?: AdaptiveExitReason | null;
  lastExitDirective?: string | null;
};

type GuardrailHalt = {
  reason: string;
  triggeredAt: number;
  activeUntil: number;
  winRate: number;
  expectancy: PreciseDecimal;
  samples: number;
};

type LiquidityTier = {
  name: string;
  maxVolumeUsd: number | null;
  minVolumeUsd: number;
  maxSpreadBps: number;
  minDepthUsd: number;
};

const LIQUIDITY_GUARD = {
  tiers: [
    { name: 'micro', maxVolumeUsd: 90_000_000, minVolumeUsd: 40_000_000, maxSpreadBps: 5, minDepthUsd: 50_000 },
    { name: 'mid', maxVolumeUsd: 350_000_000, minVolumeUsd: 60_000_000, maxSpreadBps: 8, minDepthUsd: 35_000 },
    { name: 'major', maxVolumeUsd: null, minVolumeUsd: 20_000_000, maxSpreadBps: 18, minDepthUsd: 25_000 },
  ] as const,
  microPenaltyCap: 1,
} as const;

const GUARDRAIL_CONFIG = {
  minSamples: 6,
  winRateFloor: 0.5,
  expectancyFloor: 0.01,
  cooldownMs: 6 * 60 * 60 * 1000,
} as const;

function resolveLiquidityTier(volume24hUsd: number | null | undefined): LiquidityTier {
  if (!Number.isFinite(volume24hUsd)) {
    return LIQUIDITY_GUARD.tiers[LIQUIDITY_GUARD.tiers.length - 1];
  }
  const vol = Number(volume24hUsd);
  for (const tier of LIQUIDITY_GUARD.tiers) {
    if (tier.maxVolumeUsd == null || vol <= tier.maxVolumeUsd) {
      return tier;
    }
  }
  return LIQUIDITY_GUARD.tiers[LIQUIDITY_GUARD.tiers.length - 1];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  const ratio = (value - min) / (max - min);
  return clamp(ratio, 0, 1);
}

function slopeScore(slope: number, basis: number): number {
  if (!Number.isFinite(slope) || !Number.isFinite(basis) || Math.abs(basis) < 1e-9) {
    return 0;
  }
  const pct = (slope / basis) * 100;
  return clamp(Math.abs(pct) / 1.2, 0, 1);
}

function computeVolumeRatio(snap: TechnicalSnapshot): number {
  const current = safeNumber((snap as any)?.volume, 0);
  const ma = safeNumber((snap as any)?.volumeMA, 0);
  if (ma <= 0) return current > 0 ? 2.5 : 0;
  return clamp(current / ma, 0, 5);
}

function buildPredictorFeatures(snap: TechnicalSnapshot): Record<string, number> | null {
  const ema20 = safeNumber((snap as any)?.ema20, Number.NaN);
  const ema50 = safeNumber((snap as any)?.ema50, Number.NaN);
  const ema100 = safeNumber((snap as any)?.ema100, Number.NaN);
  const ema200 = safeNumber((snap as any)?.ema200, Number.NaN);
  const rsi14 = safeNumber((snap as any)?.rsi14, Number.NaN);
  const atr14 = safeNumber((snap as any)?.atr14 ?? Number.NaN, Number.NaN);
  const adx14 = safeNumber((snap as any)?.adx14, Number.NaN);
  const ema20Slope = safeNumber((snap as any)?.ema20Slope, Number.NaN);
  const volume = safeNumber((snap as any)?.volume, Number.NaN);
  const volumeMA = safeNumber((snap as any)?.volumeMA, Number.NaN);
  const trendSpreadFallback = Number.isFinite(ema50) && Math.abs(ema50) > 1e-9 ? (ema20 - ema50) / ema50 : 0;
  const emaTrendSpread = safeNumber((snap as any)?.emaTrendSpread, trendSpreadFallback);
  const rsiSlope = safeNumber((snap as any)?.rsiSlope, 0);
  const volumeZScore = safeNumber((snap as any)?.volumeZScore, 0);
  const momentum3 = safeNumber((snap as any)?.momentum3, 0);
  const lastPrice = safeNumber((snap as any)?.last, Number.NaN);
  const atrPctPercent = safeNumber((snap as any)?.atrPct, Number.NaN);

  const atrPct = Number.isFinite(atr14) && Number.isFinite(lastPrice) && Math.abs(lastPrice) > 1e-9
    ? atr14 / lastPrice
    : Number.isFinite(atrPctPercent)
      ? atrPctPercent / 100
      : Number.NaN;

  if (!Number.isFinite(volume) || !Number.isFinite(volumeMA) || volumeMA <= 0) {
    return null;
  }

  const features: Record<string, number> = {
    ema20,
    ema50,
    ema100,
    ema200,
    rsi14,
    atr14,
    adx14,
    ema20Slope,
    volumeRatio: volume / volumeMA,
    emaTrendSpread,
    rsiSlope,
    atrPct,
    volumeZScore,
    momentum3,
  };

  const micro = (snap as any)?.microstructure as TechnicalSnapshot['microstructure'] | undefined;
  if (micro) {
    features.order_flow_imbalance = safeNumber(micro.orderFlowImbalance, 0);
    features.aggression_ratio = safeNumber(micro.aggressionRatio, 0);
    features.delta_volume_slope = safeNumber(micro.deltaVolumeSlope, 0);
    features.midprice_pressure = safeNumber(micro.midpricePressure, 0);
    features.micro_atr = safeNumber(micro.microAtr, 0);
    features.trend_strength = safeNumber(micro.trendStrength, 0);
    features.price_velocity = safeNumber(micro.priceVelocity, 0);
    features.delta_rsi = safeNumber(micro.deltaRsi, 0);
    features.delta_obi = safeNumber(micro.deltaObi, 0);
    const seqs: Array<[string, number[]]> = [
      ['seq_close_', micro.normalizedCloses ?? []],
      ['seq_volume_', micro.normalizedVolumes ?? []],
      ['seq_rsi_', micro.rsiSequence ?? []],
      ['seq_obi_', micro.obiSequence ?? []],
    ];
    for (const [prefix, values] of seqs) {
      for (let idx = 0; idx < 20; idx += 1) {
        const value = Number.isFinite(values[idx] ?? NaN) ? values[idx]! : 0;
        features[`${prefix}${idx}`] = value;
      }
    }
  } else {
    const prefixes = ['seq_close_', 'seq_volume_', 'seq_rsi_', 'seq_obi_'];
    for (const prefix of prefixes) {
      for (let idx = 0; idx < 20; idx += 1) {
        features[`${prefix}${idx}`] = 0;
      }
    }
  }

  if (Object.values(features).some(value => !Number.isFinite(value))) {
    return null;
  }

  return features;
}

function computeDistancePct(price: number, level: number | null | undefined): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(level) || !level) return null;
  return Math.abs((price - level) / level) * 100;
}

function chooseBiasFromTrend(trendBias: TechnicalSnapshot['trendBias']): StrategyBias {
  if (trendBias === 'bullish') return 'long';
  if (trendBias === 'bearish') return 'short';
  return 'both';
}

type ContextAlignment = {
  direction: StrategyBias;
  alignmentScore: number;
  conflict: boolean;
  reasons: string[];
  bullishStack: boolean;
  bearishStack: boolean;
};

function deriveBiasTag(bias: string | undefined | null): 'bullish' | 'bearish' | 'neutral' {
  if (bias === 'bullish' || bias === 'bearish') return bias;
  return 'neutral';
}

function biasToStrategy(bias: string | undefined | null): StrategyBias {
  const normalized = deriveBiasTag(bias);
  if (normalized === 'bullish') return 'long';
  if (normalized === 'bearish') return 'short';
  return 'both';
}

function computeContextAlignment(
  multi: MultiTimeframeDiagnostics | null | undefined,
  snap: TechnicalSnapshot,
): ContextAlignment {
  const timeframes = multi?.timeframes ?? {};
  const bias4h = deriveBiasTag(timeframes['4h']?.bias ?? (snap.meta?.contextTf ? undefined : null));
  const bias1h = deriveBiasTag(timeframes['1h']?.bias);
  const bias15m = deriveBiasTag(timeframes['15m']?.bias ?? (snap.trendBias === 'bullish'
    ? 'bullish'
    : snap.trendBias === 'bearish'
      ? 'bearish'
      : 'neutral'));

  const biases = [bias4h, bias1h, bias15m];
  const nonNeutral = biases.filter(b => b !== 'neutral');
  const bullishStack = biases.every(b => b === 'bullish');
  const bearishStack = biases.every(b => b === 'bearish');

  let direction: StrategyBias = 'both';
  if (bullishStack) direction = 'long';
  else if (bearishStack) direction = 'short';
  else if (bias4h !== 'neutral' && nonNeutral.length >= 2 && nonNeutral.every(b => b === bias4h)) {
    direction = biasToStrategy(bias4h);
  }

  const reasons = [
    `htf=${bias4h}`,
    `1h=${bias1h}`,
    `15m=${bias15m}`,
  ];

  let alignmentScore = 0.4;
  let conflict = false;

  if (bullishStack || bearishStack) {
    alignmentScore = 0.96;
    reasons.push(bullishStack ? 'stack_bullish' : 'stack_bearish');
  } else if (bias4h !== 'neutral') {
    const matches = [bias1h, bias15m].filter(b => b === bias4h).length;
    const mismatches = [bias1h, bias15m].filter(b => b !== 'neutral' && b !== bias4h).length;
    if (mismatches > 0) {
      conflict = true;
      alignmentScore = 0.22 + matches * 0.08;
    } else if (matches === 2) {
      alignmentScore = 0.9;
    } else if (matches === 1) {
      alignmentScore = 0.78;
    } else {
      alignmentScore = 0.6;
    }
  } else if (nonNeutral.length >= 2 && new Set(nonNeutral).size === 1) {
    alignmentScore = 0.82;
  } else if (nonNeutral.length === 1) {
    alignmentScore = 0.65;
  }

  alignmentScore = clamp(alignmentScore, 0.1, 1);
  reasons.push(`alignment=${alignmentScore.toFixed(2)}`);
  if (conflict) reasons.push('htf_conflict');

  return { direction, alignmentScore, conflict, reasons, bullishStack, bearishStack };
}

class MetaAdaptiveStrategyAgent {
  private static instance: MetaAdaptiveStrategyAgent | null = null;

  private readonly stats = new Map<string, Map<StrategyFamily, StrategyStats>>();
  private readonly activeTrades = new Map<string, ActiveTrade[]>();
  private readonly liquidityLog = new Map<string, number>();
  private readonly guardrailHalts = new Map<string, Map<StrategyFamily, GuardrailHalt>>();
  private readonly symbolCooldowns = new Map<string, number>();
  private readonly guardsDisabled = areAgentGuardsDisabled();
  private epsilonBase = 0.15;
  private calibrationProfile: CalibrationProfile = defaultCalibrationProfile;
  private readonly sessionCapital = new Map<string, PreciseDecimal>();
  private readonly tradeLedgers = new Map<string, PreciseDecimal>();
  private readonly assetRankings = new Map<string, { score: number; updatedAt: number }>();
  private readonly symbolMeta = new Map<string, { firstSeen: number; lastSeen: number; volumeSurge: number; rankingScore: number; rankHint: number | null }>();
  private readonly defaultCapital = new PreciseDecimal('1000');
  private readonly desiredProfitUsd = new PreciseDecimal('30');
  private readonly defaultFeeBps = new PreciseDecimal('4');
  private readonly hundred = new PreciseDecimal('100');
  private readonly tenThousand = new PreciseDecimal('10000');
  private readonly majorBases = new Set(['BTC', 'ETH']);
  private readonly pythonPerformance = new PythonPerformanceTracker(BASE_PYTHON_BIAS_WEIGHT);
  private rngState = 0x9e3779b9n;
  private tokenCounter = 0n;
  private reentryCooldownMs = 0;
  private pythonUnavailableLogged = false;

  static getInstance(): MetaAdaptiveStrategyAgent {
    if (!MetaAdaptiveStrategyAgent.instance) {
      MetaAdaptiveStrategyAgent.instance = new MetaAdaptiveStrategyAgent();
    }
    return MetaAdaptiveStrategyAgent.instance;
  }

  setExplorationEpsilon(epsilon: number): void {
    const floor = this.calibrationProfile?.explorationFloor ?? 0.01;
    this.epsilonBase = clamp(epsilon, floor, 1);
  }

  setRandomSeed(seed: number): void {
    const normalized = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 1;
    this.rngState = BigInt(normalized || 1) & 0xffffffffn;
    if (this.rngState === 0n) {
      this.rngState = 1n;
    }
    this.tokenCounter = 0n;
  }

  reset(sessionId?: string | null): void {
    if (!sessionId) {
      this.stats.clear();
      this.activeTrades.clear();
      this.liquidityLog.clear();
      this.guardrailHalts.clear();
      this.sessionCapital.clear();
      this.tradeLedgers.clear();
      this.symbolCooldowns.clear();
      this.setRandomSeed(0x9e3779b9);
      this.calibrationProfile = defaultCalibrationProfile;
      this.pythonPerformance.reset();
      return;
    }
    this.stats.delete(sessionId);
    this.activeTrades.delete(sessionId);
    this.guardrailHalts.delete(sessionId);
    this.sessionCapital.delete(sessionId);
    for (const key of Array.from(this.symbolCooldowns.keys())) {
      if (key.startsWith(`${sessionId}::`)) {
        this.symbolCooldowns.delete(key);
      }
    }
    for (const key of Array.from(this.tradeLedgers.keys())) {
      if (key.startsWith(`${sessionId}::`)) {
        this.tradeLedgers.delete(key);
      }
    }
  }

  loadCalibration(profile: CalibrationProfile): void {
    this.calibrationProfile = {
      familyScoreAdjustments: {
        ...defaultCalibrationProfile.familyScoreAdjustments,
        ...profile.familyScoreAdjustments,
      },
      minConfidence: clamp(profile.minConfidence, 0, 1),
      explorationFloor: clamp(profile.explorationFloor, 0.005, 0.2),
    };
    if (this.epsilonBase < this.calibrationProfile.explorationFloor) {
      this.epsilonBase = this.calibrationProfile.explorationFloor;
    }
  }

  private nextRandom(): number {
    this.rngState = (1664525n * this.rngState + 1013904223n) & 0xffffffffn;
    return Number(this.rngState) / 0xffffffff;
  }

  private nextToken(): string {
    const token = `meta-${(this.tokenCounter++).toString(36)}`;
    return token;
  }

  private cooldownKey(sessionId: string | null | undefined, symbol: string): string {
    return `${sessionId ?? 'global'}::${symbol}`;
  }

  private pythonTradeKey(sessionId: string | null | undefined, token: string | null | undefined, symbol: string): string | null {
    if (!sessionId || !token) {
      return null;
    }
    return `${sessionId}::${symbol}::${token}`;
  }

  private purgeExpiredCooldowns(now: number): void {
    if (!this.symbolCooldowns.size) return;
    for (const [key, until] of Array.from(this.symbolCooldowns.entries())) {
      if (until <= now) {
        this.symbolCooldowns.delete(key);
      }
    }
  }

  setReentryCooldownMinutes(minutes?: number | null): void {
    if (!Number.isFinite(minutes ?? NaN) || (minutes ?? 0) <= 0) {
      this.reentryCooldownMs = 0;
      this.symbolCooldowns.clear();
      return;
    }
    const normalized = Math.max(0, Number(minutes));
    this.reentryCooldownMs = normalized * 60_000;
  }

  public isSymbolEligibleForEntry(sessionId: string | null, symbol: string): boolean {
    if (this.guardsDisabled) return true;
    if (this.reentryCooldownMs <= 0) return true;
    if (!symbol) return true;
    const now = Date.now();
    this.purgeExpiredCooldowns(now);
    const key = this.cooldownKey(sessionId, symbol);
    const until = this.symbolCooldowns.get(key);
    if (!until) return true;
    if (until <= now) {
      this.symbolCooldowns.delete(key);
      return true;
    }
    return false;
  }

  private ledgerKey(sessionId: string | null | undefined, symbol: string): string {
    return `${sessionId ?? 'global'}::${symbol}`;
  }

  private clampDecimal(value: PreciseDecimal, min: PreciseDecimal, max: PreciseDecimal): PreciseDecimal {
    let result = value;
    if (result.lt(min)) result = min;
    if (result.gt(max)) result = max;
    return result;
  }

  private resolveCapital(sessionId: string | null | undefined, accountBalance: string | number | PreciseDecimal | null | undefined): PreciseDecimal {
    if (accountBalance != null) {
      const decimal = new PreciseDecimal(accountBalance);
      if (sessionId) {
        this.sessionCapital.set(sessionId, decimal);
      }
      return decimal;
    }
    if (sessionId && this.sessionCapital.has(sessionId)) {
      return this.sessionCapital.get(sessionId)!;
    }
    return this.defaultCapital;
  }

  private computeNetAfterFees(params: {
    riskUsd: PreciseDecimal;
    stopMult: PreciseDecimal;
    atrPct: number;
    feeBps: PreciseDecimal;
    targetProfitUsd: PreciseDecimal;
  }): { net: PreciseDecimal; feeUsd: PreciseDecimal } {
    const zero = new PreciseDecimal('0');
    if (params.riskUsd.equals(0) || params.targetProfitUsd.equals(0)) {
      return { net: zero, feeUsd: zero };
    }
    const atrPercent = Number.isFinite(params.atrPct) ? Math.max(params.atrPct, 0.05) : 0.05;
    const atrFraction = new PreciseDecimal((atrPercent / 100).toFixed(6));
    const stopFraction = params.stopMult.times(atrFraction);
    const notional = stopFraction.equals(0) ? params.riskUsd : params.riskUsd.dividedBy(stopFraction);
    const roundTripPct = params.feeBps.times(new PreciseDecimal('2')).dividedBy(this.tenThousand);
    const feeUsd = notional.times(roundTripPct);
    const net = params.targetProfitUsd.minus(feeUsd);
    return { net, feeUsd };
  }

  private isMajorSymbol(symbol: string): boolean {
    if (!symbol) return false;
    const base = symbol.includes('/') ? symbol.split('/')[0] : symbol;
    return this.majorBases.has(base.toUpperCase());
  }

  private computeVolumeSurge(snap: TechnicalSnapshot): number {
    const vol = Number((snap as any)?.volume ?? NaN);
    const baseline = Number((snap as any)?.volumeMA ?? NaN);
    if (!Number.isFinite(vol) || !Number.isFinite(baseline) || baseline <= 0) {
      return 0;
    }
    return clamp(vol / baseline - 1, 0, 4);
  }

  private updateSymbolMeta(symbol: string, snap: TechnicalSnapshot, watchlist?: WatchlistMeta | null): { isNew: boolean; ageMs: number; volumeSurge: number; rankHint: number | null } {
    const now = Date.now();
    const key = symbol.toUpperCase();
    const entry = this.symbolMeta.get(key) ?? {
      firstSeen: now,
      lastSeen: now,
      volumeSurge: 0,
      rankingScore: 0,
      rankHint: watchlist?.rankHint ?? null,
    };
    entry.lastSeen = now;
    if (watchlist?.addedAt != null && Number.isFinite(watchlist.addedAt)) {
      entry.firstSeen = Math.min(entry.firstSeen, Number(watchlist.addedAt));
    }
    if (watchlist?.firstSeenAt != null && Number.isFinite(watchlist.firstSeenAt)) {
      entry.firstSeen = Math.min(entry.firstSeen, Number(watchlist.firstSeenAt));
    }
    entry.rankHint = watchlist?.rankHint != null ? watchlist.rankHint : entry.rankHint;
    const surge = this.computeVolumeSurge(snap);
    if (watchlist?.volumeSurgeHint != null && Number.isFinite(watchlist.volumeSurgeHint)) {
      entry.volumeSurge = Math.max(surge, Number(watchlist.volumeSurgeHint));
    } else {
      entry.volumeSurge = surge;
    }
    this.symbolMeta.set(key, entry);
    const ageMs = Math.max(0, now - entry.firstSeen);
    const isNew = watchlist?.isNew != null ? !!watchlist.isNew : ageMs < 4 * 60 * 60 * 1000;
    return { isNew, ageMs, volumeSurge: entry.volumeSurge, rankHint: entry.rankHint ?? null };
  }

  private cleanupRankings(now: number): void {
    const expiry = 15 * 60_000;
    for (const [symbol, value] of this.assetRankings.entries()) {
      if (now - value.updatedAt > expiry) {
        this.assetRankings.delete(symbol);
      }
    }
  }

  private updateAssetRanking(symbol: string, factors: { change24hPct?: number | null; volumeUsd?: number | null; volatilityPct?: number | null; momentumScore?: number | null; fundingRate?: number | null }): { score: number; rank: number | null } {
    const now = Date.now();
    this.cleanupRankings(now);
    const change = Number(factors.change24hPct ?? 0);
    const changeScore = clamp(Math.abs(change) / 12, 0, 1);
    const directionBonus = clamp(change / 18, -0.5, 0.5);
    const volumeUsd = Number(factors.volumeUsd ?? 0);
    const volumeScore = volumeUsd > 0 ? clamp(Math.log10(volumeUsd + 1) / 10, 0, 1) : 0;
    const volatilityScore = clamp(Number(factors.volatilityPct ?? 0) / 6, 0, 1);
    const momentumScore = clamp(Number(factors.momentumScore ?? 0), 0, 1);
    const fundingScore = clamp(Math.abs(Number(factors.fundingRate ?? 0)) / 0.05, 0, 0.2);
    const raw = clamp(
      changeScore * 0.3 +
        Math.max(0, directionBonus) * 0.1 +
        volumeScore * 0.35 +
        volatilityScore * 0.15 +
        momentumScore * 0.1 +
        fundingScore,
      0,
      1.5,
    );
    const score = Number(raw.toFixed(6));
    const key = symbol.toUpperCase();
    this.assetRankings.set(key, { score, updatedAt: now });
    const meta = this.symbolMeta.get(key);
    if (meta) {
      meta.rankingScore = score;
      this.symbolMeta.set(key, meta);
    }
    const sorted = Array.from(this.assetRankings.entries()).sort((a, b) => b[1].score - a[1].score);
    const rankIndex = sorted.findIndex(([s]) => s === key);
    const rank = rankIndex === -1 ? null : rankIndex + 1;
    return { score, rank };
  }

  private computeRankingMultiplier(rank: number | null, rankingScore: number, meta: { isNew: boolean; ageMs: number; volumeSurge: number; rankHint: number | null }): number {
    let multiplier = 1;
    if (rank != null) {
      if (rank <= 3) multiplier *= 1.12;
      else if (rank <= 10) multiplier *= 1.05;
      else if (rank > 15) multiplier *= 0.75;
      else if (rank > 10) multiplier *= 0.85;
    }
    if (Number.isFinite(rankingScore) && rankingScore < 0.2) {
      multiplier *= 0.9;
    }
    if (meta.rankHint != null) {
      if (meta.rankHint <= 5) multiplier *= 1.1;
      else if (meta.rankHint > 12) multiplier *= 0.85;
    }
    if (meta.isNew) {
      multiplier *= 1.1;
    }
    if (meta.volumeSurge > 0) {
      multiplier *= 1 + clamp(meta.volumeSurge / 4, 0, 0.2);
    }
    return clamp(multiplier, 0.5, 1.35);
  }

  private computeDirectionalMultiplier(bias: StrategyBias, signal: number): number {
    const normalized = clamp(signal, -1, 1);
    if (bias === 'both') {
      return 1 + Math.abs(normalized) * 0.05;
    }
    const alignment = bias === 'long' ? normalized : -normalized;
    if (alignment >= 0) {
      return clamp(1 + alignment * 0.2, 0.85, 1.3);
    }
    return clamp(1 + alignment * 0.4, 0.4, 1);
  }

  private computeDerivativeSignal(metrics?: PerpetualMetrics | null): { bias: number; volatility: number; notes: string[] } {
    if (!metrics) return { bias: 0, volatility: 0, notes: [] };
    let bias = 0;
    const notes: string[] = [];
    if (metrics.fundingRate != null && Number.isFinite(metrics.fundingRate)) {
      const funding = Number(metrics.fundingRate);
      const fundingBias = clamp(funding / 0.015, -1.2, 1.2);
      bias += fundingBias * 0.6;
      notes.push(`funding=${funding.toFixed(4)}`);
    }
    if (metrics.longShortRatio != null && Number.isFinite(metrics.longShortRatio) && metrics.longShortRatio > 0) {
      const ratio = Number(metrics.longShortRatio);
      const ratioBias = clamp(Math.log(ratio), -1, 1);
      bias += ratioBias * 0.4;
      notes.push(`ls_ratio=${ratio.toFixed(2)}`);
    }
    if (metrics.openInterestChangePct != null && Number.isFinite(metrics.openInterestChangePct)) {
      const oi = Number(metrics.openInterestChangePct);
      const oiBias = clamp(oi / 35, -0.6, 0.6);
      bias += oiBias * 0.25;
      notes.push(`oi_change=${oi.toFixed(1)}%`);
    }
    const volatility = clamp(Math.abs(Number(metrics.openInterestChangePct ?? 0)) / 50, 0, 0.6);
    return { bias: clamp(bias, -1.5, 1.5), volatility, notes };
  }

  private computeOnChainSignal(metrics?: OnChainMetrics | null): { bias: number; notes: string[] } {
    if (!metrics) return { bias: 0, notes: [] };
    let bias = 0;
    const notes: string[] = [];
    if (metrics.exchangeNetflowUsd != null && Number.isFinite(metrics.exchangeNetflowUsd)) {
      const flow = Number(metrics.exchangeNetflowUsd);
      const flowBias = clamp(-flow / 50_000_000, -0.6, 0.6);
      bias += flowBias * 0.6;
      notes.push(`netflow=${Math.round(flow)}`);
    }
    if (metrics.stablecoinInflowsUsd != null && Number.isFinite(metrics.stablecoinInflowsUsd)) {
      const inflow = Number(metrics.stablecoinInflowsUsd);
      const inflowBias = clamp(inflow / 40_000_000, 0, 0.7);
      bias += inflowBias * 0.4;
      notes.push(`stable_in=${Math.round(inflow)}`);
    }
    if (metrics.activeAddresses != null && Number.isFinite(metrics.activeAddresses)) {
      const activity = Number(metrics.activeAddresses);
      const activityBias = clamp((activity - 500_000) / 1_500_000, -0.3, 0.3);
      bias += activityBias * 0.2;
      notes.push(`active_addr=${Math.round(activity)}`);
    }
    return { bias: clamp(bias, -1.2, 1.2), notes };
  }

  private computeSentimentSignal(sentiment?: SentimentSnapshot | null): { bias: number; conviction: number; notes: string[] } {
    if (!sentiment) return { bias: 0, conviction: 0, notes: [] };
    const label = sentiment.label;
    const direction = label === 'bullish' ? 1 : label === 'bearish' ? -1 : 0;
    const score = clamp((Number(sentiment.score ?? 0.5) - 0.5) * 2, -1, 1);
    const confidence = clamp(Number(sentiment.confidence ?? 0.5), 0, 1);
    const bias = clamp((direction + score) * confidence, -1, 1);
    const notes = [`sentiment=${label}`, `sentiment_score=${Number(sentiment.score ?? 0.5).toFixed(2)}`];
    return { bias, conviction: confidence, notes };
  }

  private estimateChange24h(snap: TechnicalSnapshot): number {
    const last = Number((snap as any)?.last ?? NaN);
    const ema = Number((snap as any)?.ema50 ?? NaN);
    if (!Number.isFinite(last) || !Number.isFinite(ema) || ema === 0) {
      return 0;
    }
    return ((last - ema) / ema) * 100;
  }

  private computeExplorationProbability(
    symbol: string,
    candidate: StrategyScoreResult,
    context: { atr15mPct: number; atr1hPct: number; realizedVol: number; hurst: number },
    extras: {
      watchlist: { isNew: boolean; volumeSurge: number; rank: number | null; rankingScore: number };
      regime: MarketRegimeSignal;
      derivativeVolatility: number;
      combinedBias: number;
    },
  ): number {
    const base = this.epsilonBase;
    const symbolStats = this.stats.get(symbol);
    const familyStats = symbolStats?.get(candidate.family);
    const samples = familyStats?.outcomes.length ?? 0;
    let epsilon = base;
    let expectancy = 0;
    if (familyStats && samples >= 4) {
      expectancy = familyStats.sum.dividedBy(new PreciseDecimal(samples.toString())).toNumber();
      const normalizedExpectancy = clamp(expectancy / 3, -1, 1);
      epsilon = base * (1 - Math.min(candidate.confidence, 0.95)) * (1 - Math.max(0, normalizedExpectancy));
    } else if (!familyStats || samples === 0) {
      epsilon = base * 1.15;
    } else {
      epsilon = base * (1 + (4 - samples) / 10);
    }

    if (familyStats && samples >= 6 && expectancy > 0.6) {
      epsilon += base * 0.1;
    }

    const volatilityGauge = Math.max(context.atr15mPct, context.atr1hPct, context.realizedVol);
    if (volatilityGauge > 1.8 || context.realizedVol > 1.6) {
      epsilon += base * 0.2;
    } else if (context.hurst > 0.65) {
      epsilon += base * 0.05;
    }

    if (extras.watchlist.isNew) {
      epsilon += base * 0.25;
    }
    if (extras.watchlist.volumeSurge > 0) {
      epsilon += base * clamp(extras.watchlist.volumeSurge / 4, 0, 0.2);
    }
    if (extras.watchlist.rank != null) {
      if (extras.watchlist.rank <= 5) {
        epsilon *= 0.9;
      } else if (extras.watchlist.rank > 12) {
        epsilon += base * 0.1;
      }
    }
    if (extras.regime.dominant === 'high_vol') {
      epsilon += base * 0.08;
    } else if (extras.regime.dominant === 'range') {
      epsilon *= 0.95;
    }
    if (extras.derivativeVolatility > 0.4) {
      epsilon *= 0.85;
    }
    if (Math.abs(extras.combinedBias) > 0.8) {
      epsilon *= 0.9;
    }

    epsilon = clamp(epsilon, this.calibrationProfile.explorationFloor, 0.45);
    return epsilon;
  }

  evaluate(input: AdaptiveEvaluationInput): { signals: AdaptiveSignal[]; selection: AdaptiveSignal | null } {
    const micro = input.micro ?? {};
    const snap = input.snap;
    const price = safeNumber(snap.last, 0);
    const fundamental = input.fundamental ?? null;
    const fundamentalSeverity = fundamental?.severity ?? 'neutral';
    const fundamentalActive = fundamental != null
      ? fundamental.expiresAt == null || fundamental.expiresAt > Date.now()
      : false;
    const fundamentalNegative = fundamentalActive && fundamentalSeverity === 'negative';
    const atr15mPct = safeNumber(snap.atrPct, 0);
    const atr1hPct = safeNumber(input.atr1h ?? (snap as any)?.atr14_1h, atr15mPct);
    const atr4hPct = safeNumber(input.atr4h ?? (snap as any)?.atr14_4h, atr1hPct);
    const adx = safeNumber(snap.adx14, 0);
    const hurst = safeNumber((snap as any)?.hurst, 0.5);
    const trendStrength = safeNumber((snap as any)?.trendStrength, 0);
    const ema20 = safeNumber(snap.ema20, price);
    const ema50 = safeNumber(snap.ema50, price);
    const ema100 = safeNumber(snap.ema100, price);
    const ema200 = safeNumber(snap.ema200, price);
    const realizedVol = safeNumber(snap.realizedVol, atr15mPct);

    const externalContext: MarketContextSnapshot | null = getMarketContext(input.symbol) ?? null;
    const derivatives = input.derivatives ?? externalContext?.derivatives ?? null;
    const onChain = input.onChain ?? externalContext?.onChain ?? null;
    const sentiment = input.sentiment ?? externalContext?.sentiment ?? null;
    const watchlistMeta = input.watchlist ?? externalContext?.watchlist ?? null;
    const watchlistState = this.updateSymbolMeta(input.symbol, snap, watchlistMeta);
    const isMajor = this.isMajorSymbol(input.symbol);

    const pythonEnabled = process.env.DISABLE_PYTHON_PREDICTOR !== 'true';
    const pythonAvailable = pythonEnabled && isPythonPredictorAvailable();
    if (
      pythonEnabled
      && !pythonAvailable
      && !this.pythonUnavailableLogged
      && process.env.UNIT_TEST_MODE !== 'true'
    ) {
      const resolutionError = getPythonResolutionError();
      console.warn('python predictor disabled: interpreter unavailable', {
        error: resolutionError?.message ?? 'unknown error',
      });
      this.pythonUnavailableLogged = true;
    }
    if (pythonAvailable) {
      this.pythonUnavailableLogged = false;
    }
    const predictorFeatures = pythonAvailable ? buildPredictorFeatures(snap) : null;

    let pythonBias = 0;
    let pythonSignal: PythonHybridSignal | null = null;
    let pythonWeight = this.pythonPerformance.getBiasWeight(BASE_PYTHON_BIAS_WEIGHT);
    if (pythonAvailable && predictorFeatures) {
      try {
        const prediction = getPythonPredictionSync(predictorFeatures);
        const hybridSignal = buildHybridSignal(prediction);
        const probabilityEdge = computeProbabilityEdge(hybridSignal);
        pythonBias = clamp(probabilityEdge * (0.55 + hybridSignal.confidence * 0.45), -1, 1);
        const strongBias = Math.abs(pythonBias) >= PYTHON_NEUTRAL_THRESHOLD ? hybridSignal.bias : 'both';
        pythonSignal = {
          ...hybridSignal,
          bias: strongBias,
        };
        pythonWeight = this.pythonPerformance.getBiasWeight(BASE_PYTHON_BIAS_WEIGHT);
      } catch (error) {
        pythonBias = 0;
        if (process.env.UNIT_TEST_MODE !== 'true') {
          console.warn('python predictor sync failed during evaluation', {
            symbol: input.symbol,
            error: (error as Error).message,
          });
        }
      }
    }

    const livePythonMetrics = this.pythonPerformance.getMetrics();
    let pythonBoostApplied = false;
    if (
      pythonSignal
      && Math.abs(pythonBias) >= PYTHON_NEUTRAL_THRESHOLD
      && pythonSignal.primaryProbability >= PYTHON_BOOST_PROB_THRESHOLD
      && pythonSignal.confidence >= PYTHON_BOOST_CONF_THRESHOLD
      && livePythonMetrics.samples >= PYTHON_BOOST_MIN_SAMPLES
      && livePythonMetrics.hitRate > 0.52
      && livePythonMetrics.realizedEdge > 0
    ) {
      const edgeFactor = 1 + clamp(livePythonMetrics.realizedEdge * 2, 0, 0.4);
      const weightFloor = Math.max(pythonWeight, PYTHON_BIAS_BOOST_FLOOR);
      pythonWeight = clamp(weightFloor * edgeFactor, 0.35, 1.2);
      const boostedEntry = clamp(pythonSignal.entryWeight * (PYTHON_RISK_BOOST_MULTIPLIER * edgeFactor), 0.2, 3);
      const boostedRisk = clamp(pythonSignal.riskMultiplier * (PYTHON_RISK_BOOST_MULTIPLIER * edgeFactor), 0.2, 3);
      pythonSignal = {
        ...pythonSignal,
        entryWeight: boostedEntry,
        riskMultiplier: boostedRisk,
      };
      pythonBoostApplied = true;
    }

    const regimeSignal = detectMarketRegime({
      snap,
      atr15mPct,
      atr1h: input.atr1h ?? (snap as any)?.atr14_1h ?? null,
      atr4h: input.atr4h ?? (snap as any)?.atr14_4h ?? null,
      realizedVol,
      hurst,
      isMajor,
      derivatives,
      onChain,
    });

    const derivativeSignal = this.computeDerivativeSignal(derivatives);
    const onChainSignal = this.computeOnChainSignal(onChain);
    const sentimentSignal = this.computeSentimentSignal(sentiment);
    const combinedBias = clamp(
      derivativeSignal.bias + onChainSignal.bias + sentimentSignal.bias + pythonBias * pythonWeight,
      -1.5,
      1.5,
    );
    const macroNotes = [...derivativeSignal.notes, ...onChainSignal.notes, ...sentimentSignal.notes, ...regimeSignal.notes];
    if (pythonSignal) {
      macroNotes.push(`python_bias=${pythonBias.toFixed(2)}`);
      macroNotes.push(`python_weight=${pythonWeight.toFixed(2)}`);
      macroNotes.push(`python_decision=${pythonSignal.decision}`);
      macroNotes.push(`python_prob_primary=${pythonSignal.primaryProbability.toFixed(2)}`);
      macroNotes.push(`python_conf=${pythonSignal.confidence.toFixed(2)}`);
      macroNotes.push(`python_entry=${pythonSignal.entryWeight.toFixed(2)}`);
      if (pythonBoostApplied) {
        macroNotes.push('python_boost_high_conf');
      }
      if (pythonSignal.cooldown.active) {
        macroNotes.push('python_cooldown_active');
      }
    }

    const emaAlignmentBull = ema20 >= ema50 && ema50 >= ema100 && ema100 >= ema200;
    const emaAlignmentBear = ema20 <= ema50 && ema50 <= ema100 && ema100 <= ema200;
    const emaAlignmentScore = emaAlignmentBull || emaAlignmentBear ? 1 : 0.2;
    const slope = slopeScore(snap.ema20Slope ?? 0, ema20 || price || 1);
    const volumeRatio = computeVolumeRatio(snap);
    const cmf = safeNumber((snap as any)?.cmf20, 0);

    const compressionScore = (() => {
      if (realizedVol <= 0) return 0;
      const atrRatio = atr15mPct / realizedVol;
      return clamp(1 - atrRatio, 0, 1);
    })();

    const rsi = safeNumber(snap.rsi14, 50);
    const distSupport = computeDistancePct(price, snap.support);
    const distResistance = computeDistancePct(price, snap.resistance);
    const rangeFavor = adx <= 12 ? 1 : adx <= 16 ? 0.5 : 0;
    const srBias = (snap.srBias ?? 'neutral') as string;

    const spreadBps = micro.spreadBps ?? safeNumber((snap as any)?.spreadBps, NaN);
    const depthUsd = micro.depthUsd ?? safeNumber((snap as any)?.bookDepthUsd, NaN);
    const slippageBps = micro.slippageBps ?? safeNumber((snap as any)?.slippageBps, NaN);
    const fillRatio = micro.fillRatio ?? safeNumber((snap as any)?.fillRatio, NaN);
    const volume24hUsd = safeNumber(input.volume24hUsd ?? (snap as any)?.volume24hUsd ?? (snap as any)?.volume24h, NaN);
    const liquidityTier = resolveLiquidityTier(volume24hUsd);

    const liquidityFailures: string[] = [];
    const volumePresent = Number.isFinite(volume24hUsd);
    const volumeOk = !volumePresent || (volume24hUsd as number) >= liquidityTier.minVolumeUsd;
    const spreadOk = Number.isFinite(spreadBps) ? (spreadBps as number) <= liquidityTier.maxSpreadBps : true;
    const depthOk = Number.isFinite(depthUsd) ? (depthUsd as number) >= liquidityTier.minDepthUsd : true;

    if (volumePresent && !volumeOk) {
      liquidityFailures.push(`volume_24h_below_${liquidityTier.minVolumeUsd}`);
    }
    if (!spreadOk) {
      liquidityFailures.push(`spread_above_${liquidityTier.maxSpreadBps}bps`);
    }
    if (!depthOk) {
      liquidityFailures.push(`depth_below_${liquidityTier.minDepthUsd}`);
    }

    const bypassGate = process.env.UNIT_TEST_MODE === 'true' && !input.forceLiquidityGate;

    if (liquidityFailures.length > 0 && !bypassGate) {
      const lastLogTs = this.liquidityLog.get(input.symbol) ?? 0;
      const now = Date.now();
      if (now - lastLogTs > 60_000) {
        console.log(JSON.stringify({
          level: 'info',
          event: 'adaptive_liquidity_gate',
          symbol: input.symbol,
          session_id: input.sessionId ?? null,
          reasons: liquidityFailures,
          metrics: {
            volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : null,
            spreadBps: Number.isFinite(spreadBps) ? spreadBps : null,
            depthUsd: Number.isFinite(depthUsd) ? depthUsd : null,
          },
        }));
        this.liquidityLog.set(input.symbol, now);
      }
      return { signals: [], selection: null };
    }

    const penalties: string[] = [];
    if (fundamentalNegative) {
      penalties.push('fundamental_negative');
    }
    if (sentimentSignal.bias <= -0.4) {
      penalties.push('sentiment_bearish');
    } else if (sentimentSignal.bias >= 0.4) {
      penalties.push('sentiment_bullish');
    }
    if (derivativeSignal.bias <= -0.6) {
      penalties.push('derivatives_bias_short');
    } else if (derivativeSignal.bias >= 0.6) {
      penalties.push('derivatives_bias_long');
    }
    if (regimeSignal.volatilityLevel === 'extreme') {
      penalties.push('regime_extreme_volatility');
    }
    let microPenalty = 0;
    if (Number.isFinite(spreadBps) && spreadBps > liquidityTier.maxSpreadBps) {
      microPenalty += normalize(spreadBps, liquidityTier.maxSpreadBps, liquidityTier.maxSpreadBps + 25);
      penalties.push('spread_wide');
    }
    if (Number.isFinite(depthUsd) && depthUsd < liquidityTier.minDepthUsd) {
      microPenalty += normalize(liquidityTier.minDepthUsd - depthUsd, 0, Math.max(1, liquidityTier.minDepthUsd / 2));
      penalties.push('depth_shallow');
    }
    if (Number.isFinite(slippageBps) && Number.isFinite(spreadBps) && slippageBps > (spreadBps as number) * 1.5) {
      microPenalty += 0.4;
      penalties.push('slippage_vs_spread');
    }
    if (Number.isFinite(fillRatio) && fillRatio < 0.45) {
      microPenalty += normalize(0.45 - fillRatio, 0, 0.45);
      penalties.push('fill_ratio_low');
    }
    microPenalty = clamp(microPenalty, 0, LIQUIDITY_GUARD.microPenaltyCap);

    const context = computeContextAlignment(input.multiTimeframe ?? (snap as any)?.multiTimeframe, snap);
    if (context.conflict) penalties.push('htf_conflict');

    const distanceSupportScore = distSupport == null ? 0 : clamp(1 - distSupport / Math.max(1.2, atr15mPct * 1.5), 0, 1);
    const distanceResistanceScore = distResistance == null ? 0 : clamp(1 - distResistance / Math.max(1.2, atr15mPct * 1.5), 0, 1);
    const contextInverse = clamp(1 - context.alignmentScore, 0, 1);

    const scoreTrend = clamp(
      (normalize(adx, 15, 42)
        + emaAlignmentScore
        + slope
        + clamp(trendStrength / 1.2, 0, 1)
        + context.alignmentScore) / 5,
      0,
      1,
    );

    const breakoutCompression = compressionScore * 1.25;
    const breakoutAdx = normalize(adx, 16, 35);
    const breakoutVolume = clamp(volumeRatio / 2, 0, 1) * 1.15;
    const breakoutImpulse = clamp((volumeRatio - 1) / 1.5, 0, 1) * 0.8;
    const breakoutCmf = clamp((cmf + 0.3) / 0.8, 0, 1);
    const breakoutContext = Math.max(context.alignmentScore, 0.5);
    const breakoutWeight = 1.25 + 1.15 + 0.8 + 1 + 1 + 1;
    const scoreBreakout = clamp(
      (breakoutCompression + breakoutAdx + breakoutVolume + breakoutImpulse + breakoutCmf + breakoutContext) / breakoutWeight,
      0,
      1,
    );

    const rangeComponent = (2 - normalize(adx, 8, 20)) / 2;
    const scoreMean = clamp(
      (rangeFavor
        + rangeComponent
        + clamp((50 - Math.abs(rsi - 50)) / 20, 0, 1)
        + Math.max(distanceSupportScore, distanceResistanceScore)
        + contextInverse) / 5,
      0,
      1,
    );

    const momentumTrend = clamp(Math.abs((snap as any)?.trend ?? 0) / 1.8, 0, 1);
    const momentumStrength = clamp(trendStrength / 1.0, 0, 1);
    const momentumVolume = clamp(volumeRatio / 2.5, 0, 1) * 1.05;
    const momentumImpulse = clamp((volumeRatio - 1) / 1.5, 0, 1);
    const momentumCmf = clamp((cmf + 0.2) / 0.6, 0, 1);
    const momentumContext = Math.max(context.alignmentScore, 0.55);
    const momentumSlope = clamp(slope * 1.1, 0, 1);
    const momentumWeight = 1 + 1 + 1.05 + 1 + 1 + 1 + 1;
    const scoreMomentum = clamp(
      (
        momentumTrend
        + momentumStrength
        + momentumVolume
        + momentumImpulse
        + momentumCmf
        + momentumContext
        + momentumSlope
      ) / momentumWeight,
      0,
      1,
    );

    const rankingInput = input.ranking ?? null;
    const ranking = this.updateAssetRanking(input.symbol, {
      change24hPct: rankingInput?.change24hPct ?? this.estimateChange24h(snap),
      volumeUsd: rankingInput?.volumeUsd ?? (Number.isFinite(volume24hUsd) ? Number(volume24hUsd) : Number((snap as any)?.volume24h ?? 0)),
      volatilityPct: rankingInput?.volatilityPct ?? realizedVol,
      momentumScore: rankingInput?.momentumScore ?? scoreMomentum,
      fundingRate: derivatives?.fundingRate ?? null,
    });
    const rankingMultiplier = this.computeRankingMultiplier(ranking.rank, ranking.score, watchlistState);

    const capital = this.resolveCapital(input.sessionId ?? null, input.accountBalanceUsd ?? null);
    const desiredProfit = input.desiredProfitUsd != null
      ? new PreciseDecimal(input.desiredProfitUsd)
      : this.desiredProfitUsd;

    const needsRiskReduction = context.alignmentScore < 0.65 || adx < 14;
    const volatilityRiskMultiplier = regimeSignal.volatilityLevel === 'extreme'
      ? new PreciseDecimal('0.65')
      : regimeSignal.volatilityLevel === 'high'
        ? new PreciseDecimal('0.85')
        : new PreciseDecimal('1');
    const riskAdjustmentFactorBase = context.conflict
      ? new PreciseDecimal('0.4')
      : needsRiskReduction
        ? new PreciseDecimal('0.5')
        : new PreciseDecimal('1');
    const riskAdjustmentFactor = riskAdjustmentFactorBase.times(volatilityRiskMultiplier);

    const trendRiskBase = context.conflict
      ? '0.45'
      : context.alignmentScore >= 0.92
        ? '1.3'
        : context.alignmentScore >= 0.8
          ? '1.05'
          : '0.75';
    const breakoutRiskBase = context.conflict
      ? '0.5'
      : context.alignmentScore >= 0.88
        ? '1.1'
        : '0.85';
    const meanRiskBase = context.alignmentScore <= 0.45
      ? '0.9'
      : context.alignmentScore <= 0.6
        ? '0.8'
        : '0.7';
    const momentumRiskBase = context.conflict
      ? '0.45'
      : context.alignmentScore >= 0.9
        ? '1.2'
        : '0.95';

    const trendExecution: 'market' | 'limit' = context.alignmentScore >= 0.9 ? 'market' : 'limit';
    const breakoutExecution: 'market' | 'limit' = context.alignmentScore >= 0.82 ? 'market' : 'limit';
    const momentumExecution: 'market' | 'limit' = context.alignmentScore >= 0.9 ? 'market' : 'limit';

    const trendTargets = [new PreciseDecimal('1.8'), new PreciseDecimal('3'), new PreciseDecimal('5')];
    const breakoutTargets = [new PreciseDecimal('2'), new PreciseDecimal('3.5'), new PreciseDecimal('5')];
    const meanTargets = [new PreciseDecimal('1.5'), new PreciseDecimal('2.4'), new PreciseDecimal('3.5')];
    const momentumTargets = [new PreciseDecimal('2'), new PreciseDecimal('3.5'), new PreciseDecimal('5')];

    const allowLongStack = context.bullishStack && context.alignmentScore >= 0.9;
    const allowShortStack = context.bearishStack && context.alignmentScore >= 0.9;

    const basePlans: Record<StrategyFamily, AdaptiveStrategyPlan> = {
      trend: {
        riskPct: new PreciseDecimal(trendRiskBase).times(riskAdjustmentFactor),
        stopAtrMult: new PreciseDecimal('1'),
        takeProfitMultiples: trendTargets,
        executionMode: trendExecution,
        riskUsd: new PreciseDecimal('0'),
        targetProfitUsd: new PreciseDecimal('0'),
        medianTakeProfitR: trendTargets[Math.min(1, trendTargets.length - 1)],
        trailingPolicy: {
          breakevenArmR: new PreciseDecimal('1.6'),
          trailActivationR: new PreciseDecimal('1.8'),
          atrLookback: 'atr15m',
          atrMultiplier: new PreciseDecimal('1'),
          contextAlignmentThreshold: new PreciseDecimal('0.65'),
          adxThreshold: new PreciseDecimal('20'),
        },
        entryWeight: new PreciseDecimal('1'),
        pythonRiskMultiplier: new PreciseDecimal('1'),
      },
      breakout: {
        riskPct: new PreciseDecimal(breakoutRiskBase).times(riskAdjustmentFactor),
        stopAtrMult: new PreciseDecimal('1'),
        takeProfitMultiples: breakoutTargets,
        executionMode: breakoutExecution,
        riskUsd: new PreciseDecimal('0'),
        targetProfitUsd: new PreciseDecimal('0'),
        medianTakeProfitR: breakoutTargets[Math.min(1, breakoutTargets.length - 1)],
        entryWeight: new PreciseDecimal('1'),
        pythonRiskMultiplier: new PreciseDecimal('1'),
      },
      mean_reversion: {
        riskPct: new PreciseDecimal(meanRiskBase).times(needsRiskReduction ? new PreciseDecimal('0.75') : new PreciseDecimal('1')),
        stopAtrMult: new PreciseDecimal('0.9'),
        takeProfitMultiples: meanTargets,
        executionMode: 'limit',
        riskUsd: new PreciseDecimal('0'),
        targetProfitUsd: new PreciseDecimal('0'),
        medianTakeProfitR: meanTargets[Math.min(1, meanTargets.length - 1)],
        entryWeight: new PreciseDecimal('1'),
        pythonRiskMultiplier: new PreciseDecimal('1'),
      },
      momentum: {
        riskPct: new PreciseDecimal(momentumRiskBase).times(riskAdjustmentFactor),
        stopAtrMult: new PreciseDecimal('1.1'),
        takeProfitMultiples: momentumTargets,
        executionMode: momentumExecution,
        riskUsd: new PreciseDecimal('0'),
        targetProfitUsd: new PreciseDecimal('0'),
        medianTakeProfitR: momentumTargets[Math.min(1, momentumTargets.length - 1)],
        entryWeight: new PreciseDecimal('1'),
        pythonRiskMultiplier: new PreciseDecimal('1'),
      },
    };

    const takerFeeBps = micro.takerFeeBps != null
      ? new PreciseDecimal(micro.takerFeeBps)
      : this.defaultFeeBps;

    const adjustedPlans: Record<StrategyFamily, AdaptiveStrategyPlan> = {
      trend: this.scalePlanByAtr(basePlans.trend, atr15mPct, atr1hPct, atr4hPct, capital, desiredProfit, !context.conflict, takerFeeBps),
      breakout: this.scalePlanByAtr(basePlans.breakout, atr15mPct, atr1hPct, atr4hPct, capital, desiredProfit, !context.conflict, takerFeeBps),
      mean_reversion: this.scalePlanByAtr(basePlans.mean_reversion, atr15mPct, atr1hPct, atr4hPct, capital, desiredProfit, !context.conflict, takerFeeBps),
      momentum: this.scalePlanByAtr(
        basePlans.momentum,
        atr15mPct,
        atr1hPct,
        atr4hPct,
        capital,
        desiredProfit,
        !context.conflict && context.alignmentScore >= 0.9,
        takerFeeBps,
      ),
    };

    const familyScores: Array<{
      family: StrategyFamily;
      score: number;
      confidence: number;
      bias: StrategyBias;
      reasons: string[];
      plan: AdaptiveStrategyPlan;
    predictorFeatures: Record<string, number> | null;
    pythonSignal: PythonHybridSignal | null;
  }>
      = [
        {
          family: 'trend',
          score: scoreTrend,
          confidence: scoreTrend,
          bias: allowLongStack ? 'long' : allowShortStack ? 'short' : 'both',
          reasons: [
            `regime=${regimeSignal.dominant}`,
            `adx=${adx.toFixed(2)}`,
            `trend_strength=${trendStrength.toFixed(2)}`,
            emaAlignmentBull ? 'ema_bull_stack' : emaAlignmentBear ? 'ema_bear_stack' : 'ema_mixed',
            ...context.reasons,
          ],
          plan: adjustedPlans.trend,
          predictorFeatures,
          pythonSignal,
        },
        {
          family: 'breakout',
          score: scoreBreakout,
          confidence: scoreBreakout,
          bias: allowLongStack ? 'long' : allowShortStack ? 'short' : 'both',
          reasons: [
            `regime=${regimeSignal.dominant}`,
            `compression=${compressionScore.toFixed(2)}`,
            `volume_ratio=${volumeRatio.toFixed(2)}`,
            `cmf=${cmf.toFixed(3)}`,
            ...context.reasons,
          ],
          plan: adjustedPlans.breakout,
          predictorFeatures,
          pythonSignal,
        },
        {
          family: 'mean_reversion',
          score: scoreMean,
          confidence: scoreMean,
          bias: 'both',
          reasons: [
            `regime=${regimeSignal.dominant}`,
            `rsi=${rsi.toFixed(1)}`,
            `range_bias=${srBias}`,
            distSupport != null ? `dist_support=${distSupport.toFixed(2)}%` : 'support_missing',
            distResistance != null ? `dist_resistance=${distResistance.toFixed(2)}%` : 'resistance_missing',
            `context_inverse=${contextInverse.toFixed(2)}`,
          ],
          plan: adjustedPlans.mean_reversion,
          predictorFeatures,
          pythonSignal,
        },
        {
          family: 'momentum',
          score: scoreMomentum,
          confidence: scoreMomentum,
          bias: allowLongStack ? 'long' : allowShortStack ? 'short' : 'both',
          reasons: [
            `regime=${regimeSignal.dominant}`,
            `trend=${safeNumber((snap as any)?.trend, 0).toFixed(2)}`,
            `trend_strength=${trendStrength.toFixed(2)}`,
            `volume_ratio=${volumeRatio.toFixed(2)}`,
            `cmf=${cmf.toFixed(3)}`,
            ...context.reasons,
          ],
          plan: adjustedPlans.momentum,
          predictorFeatures,
          pythonSignal,
        },
      ];

    const calibrationAdjustments = this.calibrationProfile.familyScoreAdjustments;

    let weighted: StrategyScoreResult[] = familyScores.map(item => {
      const pythonSignalForItem = item.pythonSignal;
      const planAdjusted = this.applyPythonPlanAdjustments(item.plan, pythonSignalForItem);
      const penaltiesApplied = [...penalties];
      const reasonsAugmented = [...item.reasons, ...macroNotes];
      if (ranking.rank != null) reasonsAugmented.push(`rank=${ranking.rank}`);
      reasonsAugmented.push(`macro_bias=${combinedBias.toFixed(2)}`);
      reasonsAugmented.push(`volatility=${regimeSignal.volatilityLevel}`);
      if (watchlistState.isNew) reasonsAugmented.push('watchlist_new');

      let effectiveScore = item.score * (1 - microPenalty * 0.3);

      if (context.conflict && item.family !== 'mean_reversion') {
        effectiveScore *= 0.45;
        if (!penaltiesApplied.includes('htf_conflict')) penaltiesApplied.push('htf_conflict');
      }
      if (!context.conflict && item.family === 'mean_reversion') {
        const suppress = clamp(1 - context.alignmentScore * 0.5, 0.4, 1);
        effectiveScore *= suppress;
        if (context.alignmentScore > 0.6) penaltiesApplied.push('htf_trend_dominant');
      }
      if (item.family !== 'mean_reversion') {
        if (!allowLongStack && !allowShortStack) {
          effectiveScore = 0;
          if (!penaltiesApplied.includes('htf_alignment_insufficient')) {
            penaltiesApplied.push('htf_alignment_insufficient');
          }
        }
        if (item.bias === 'long' && !allowLongStack) {
          effectiveScore = 0;
          penaltiesApplied.push('long_blocked_by_stack');
        }
        if (item.bias === 'short' && !allowShortStack) {
          effectiveScore = 0;
          penaltiesApplied.push('short_blocked_by_stack');
        }
      }
      if (context.alignmentScore >= 0.9 && (item.family === 'trend' || item.family === 'momentum')) {
        effectiveScore = Math.min(1, effectiveScore * 1.15);
      }
      if (item.family === 'mean_reversion' && adx >= 22) {
        effectiveScore *= 0.75;
        penaltiesApplied.push('adx_too_high');
      }
      if (item.family === 'mean_reversion' && context.alignmentScore >= 0.92 && adx >= 30) {
        effectiveScore = 0;
        if (!penaltiesApplied.includes('mean_disabled_strong_trend')) {
          penaltiesApplied.push('mean_disabled_strong_trend');
        }
      }
      if (item.family === 'momentum' && context.alignmentScore <= 0.45 && adx <= 14) {
        effectiveScore *= 0.7;
        penaltiesApplied.push('momentum_suppressed_range');
      }
      if (fundamentalNegative) {
        effectiveScore = 0;
        if (!penaltiesApplied.includes('fundamental_negative')) {
          penaltiesApplied.push('fundamental_negative');
        }
      }
      if (regimeSignal.disableFamilies.includes(item.family)) {
        effectiveScore = 0;
        if (!penaltiesApplied.includes('regime_disabled')) {
          penaltiesApplied.push('regime_disabled');
        }
      }
      if (effectiveScore > 0) {
        const regimeMultiplier = regimeSignal.familyMultipliers[item.family] ?? 1;
        if (regimeMultiplier !== 1) {
          effectiveScore *= regimeMultiplier;
          reasonsAugmented.push(`regime_mult=${regimeMultiplier.toFixed(2)}`);
        }
        if (pythonSignalForItem && Math.abs(pythonBias) >= PYTHON_NEUTRAL_THRESHOLD) {
          const pythonMultiplier = this.computeDirectionalMultiplier(item.bias, pythonBias);
          if (pythonMultiplier !== 1) {
            effectiveScore *= pythonMultiplier;
            reasonsAugmented.push(`python_mult=${pythonMultiplier.toFixed(2)}`);
          }
        }
        const directionalMultiplier = this.computeDirectionalMultiplier(item.bias, combinedBias);
        if (directionalMultiplier !== 1) {
          effectiveScore *= directionalMultiplier;
          reasonsAugmented.push(`directional_mult=${directionalMultiplier.toFixed(2)}`);
        }
        if (rankingMultiplier !== 1) {
          effectiveScore *= rankingMultiplier;
          reasonsAugmented.push(`ranking_mult=${rankingMultiplier.toFixed(2)}`);
        }
        if (derivativeSignal.volatility > 0.35 && item.family === 'mean_reversion') {
          effectiveScore *= 0.75;
          penaltiesApplied.push('perp_volatility_suppression');
        }
        if (sentimentSignal.conviction > 0.7 && Math.abs(sentimentSignal.bias) > 0.4) {
          const sentimentMultiplier = this.computeDirectionalMultiplier(item.bias, sentimentSignal.bias);
          if (sentimentMultiplier !== 1) {
            effectiveScore *= sentimentMultiplier;
            reasonsAugmented.push(`sentiment_mult=${sentimentMultiplier.toFixed(2)}`);
          }
        }
      }

      const calibrationAdjustment = calibrationAdjustments[item.family] ?? 0;
      effectiveScore = clamp(effectiveScore + calibrationAdjustment, 0, 1);

      if (item.family === 'trend' && item.score < 0.35) {
        penaltiesApplied.push('trend_score_low');
      }
      if (item.family === 'momentum' && volumeRatio < 1.2) {
        effectiveScore *= 0.7;
        penaltiesApplied.push('volume_low');
      }

      const guardrailBase = this.guardrailReason(input.symbol, item.family);
      const guardrail = fundamentalNegative
        ? guardrailBase
          ? `${guardrailBase};fundamental_negative_alert`
          : 'fundamental_negative_alert'
        : guardrailBase;
      const active = effectiveScore >= 0.25 && guardrail == null && !fundamentalNegative;
      const id: StrategyId = item.family === 'trend'
        ? 'classic_trend_following'
        : item.family === 'breakout'
          ? 'breakout_retest'
          : item.family === 'mean_reversion'
            ? 'bollinger_mean_reversion'
            : 'momentum_scanner_focus';
      const confidence = clamp(Math.max(item.confidence, this.calibrationProfile.minConfidence), 0, 1);
      return {
        family: item.family,
        id,
        bias: item.bias,
        score: clamp(effectiveScore, 0, 1),
        confidence,
        active,
        reasons: reasonsAugmented,
        penalties: penaltiesApplied,
        guardrail,
        plan: planAdjusted,
        predictorFeatures: item.predictorFeatures,
        pythonSignal: item.pythonSignal,
      };
    });

    let drawdownHalt: { reason: string; threshold: PreciseDecimal; cumulative: PreciseDecimal } | null = null;
    if (input.sessionId) {
      const ledgerKey = this.ledgerKey(input.sessionId, input.symbol);
      const cumulative = this.tradeLedgers.get(ledgerKey);
      if (cumulative && cumulative.lt(0)) {
        const referenceCapital = capital.gt(0) ? capital : this.defaultCapital;
        const threshold = referenceCapital.times(new PreciseDecimal('-0.05'));
        if (cumulative.lt(threshold)) {
          drawdownHalt = { reason: 'symbol_drawdown_limit', threshold, cumulative };
        }
      }
    }

    if (drawdownHalt) {
      let logged = false;
      weighted = weighted.map(signal => {
        const penaltiesAugmented = signal.penalties.includes(drawdownHalt!.reason)
          ? signal.penalties
          : [...signal.penalties, drawdownHalt!.reason];
        const guardrail = signal.guardrail
          ? `${signal.guardrail};${drawdownHalt!.reason}`
          : drawdownHalt!.reason;
        if (!logged && !signal.guardrail?.includes(drawdownHalt!.reason)) {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'adaptive_symbol_loss_halt',
            symbol: input.symbol,
            sessionId: input.sessionId ?? null,
            reason: drawdownHalt!.reason,
            cumulativePnlUsd: drawdownHalt!.cumulative.toFixed(6),
            thresholdUsd: drawdownHalt!.threshold.toFixed(6),
          }));
          logged = true;
        }
        return {
          ...signal,
          score: 0,
          active: false,
          guardrail,
          penalties: penaltiesAugmented,
        };
      });
    }

    const ordered = weighted.sort((a, b) => b.score - a.score);

      const selection = drawdownHalt || fundamentalNegative
        ? null
        : this.chooseStrategy(
          input.sessionId ?? null,
          input.symbol,
          ordered,
          { atr15mPct, atr1hPct, realizedVol, hurst },
          {
            watchlist: {
              isNew: watchlistState.isNew,
              volumeSurge: watchlistState.volumeSurge,
              rank: ranking.rank ?? null,
              rankingScore: ranking.score,
            },
            regime: regimeSignal,
            derivativeVolatility: derivativeSignal.volatility,
            combinedBias,
          },
        );
    const enrichedSignals = ordered.map(signal => ({
      ...signal,
      exploration: selection != null && selection.id === signal.id ? selection.exploration : false,
      token: selection != null && selection.id === signal.id ? selection.token : null,
    }));
    return {
      signals: enrichedSignals,
      selection,
    };
  }

  async registerActiveTrade(params: {
    sessionId?: string | null;
    symbol: string;
    family: StrategyFamily;
    id: StrategyId;
    token: string | null;
    qty: number;
    entryPrice: number;
    stopDistance: number;
    entryAtr?: number | null;
    entryAtrPct?: number | null;
    riskPerUnit?: number | null;
    targets?: number[] | null;
    rr?: number | null;
    plan: AdaptiveStrategyPlan;
    side?: StrategyBias;
    predictorFeatures?: Record<string, number> | null;
    pythonSignal?: PythonHybridSignal | null;
    flowCmf?: number | null;
    flowThreshold?: number | null;
    flowVolumeRatio?: number | null;
    mtfConsensus?: MultiTimeframeConsensus | null;
    mtfMatches?: number | null;
    mtfFrames?: number | null;
    minHoldMinutes?: number | null;
  }): Promise<'registered' | 'predictor_blocked' | 'skipped'> {
    if (!params.sessionId || !params.token) return 'skipped';

    const pythonSignalMeta = params.pythonSignal ?? null;
    let predictorProbabilities: PythonPredictionProbabilities | null = pythonSignalMeta?.probabilities ?? null;
    let predictorDecision: StrategyBias = pythonSignalMeta?.bias ?? 'both';
    let predictorDecisionLabel: 'long' | 'short' | 'none' = pythonSignalMeta?.decision ?? 'none';
    let predictorPrimaryProbability = pythonSignalMeta?.primaryProbability ?? 0.5;
    let predictorConfidence = pythonSignalMeta?.confidence ?? 0;
    // The Python predictor (python/predict_service.py) loads the persisted XGBoost
    // model and scores the latest indicator snapshot. The classifier now emits
    // calibrated probabilities for long/short/none; only confident sides above
    // the configured thresholds are allowed to enforce a directional veto.
    // Updating the model means re-running `npm run train-model`, which
    // refreshes python/xgboost_direction.json and python/features.txt – the
    // agent picks up the new artefacts on the next process spawn.
    const shouldQueryPython = params.predictorFeatures
      && process.env.DISABLE_PYTHON_PREDICTOR !== 'true'
      && isPythonPredictorAvailable()
      && (!pythonSignalMeta
        || pythonSignalMeta.bias === 'both'
        || pythonSignalMeta.confidence < PREDICTOR_MIN_CONFIDENCE);

    if (shouldQueryPython && params.predictorFeatures) {
      try {
        const raw = await getPythonPrediction(params.predictorFeatures);
        const enriched = buildHybridSignal(raw);
        predictorProbabilities = enriched.probabilities;
        const probabilityEdge = computeProbabilityEdge(enriched);
        predictorDecision = Math.abs(probabilityEdge) >= PYTHON_NEUTRAL_THRESHOLD ? enriched.bias : 'both';
        predictorDecisionLabel = predictorDecision === 'both' ? 'none' : enriched.decision;
        predictorPrimaryProbability = enriched.primaryProbability;
        predictorConfidence = enriched.confidence;
      } catch (error) {
        if (process.env.UNIT_TEST_MODE !== 'true') {
          console.warn('python predictor failure during trade registration', error);
        }
      }
    }

    if (!Number.isFinite(predictorConfidence)) {
      predictorConfidence = 0;
    }
    if (predictorProbabilities) {
      const ranked = [
        { label: 'long' as const, value: clamp(predictorProbabilities.long, 0, 1) },
        { label: 'short' as const, value: clamp(predictorProbabilities.short, 0, 1) },
        { label: 'none' as const, value: clamp(predictorProbabilities.none, 0, 1) },
      ].sort((a, b) => b.value - a.value);
      const top = ranked[0];
      const second = ranked[1] ?? top;
      predictorPrimaryProbability = top.value;
      if (predictorDecisionLabel === 'none') {
        predictorDecisionLabel = top.label;
      }
      const diff = Math.abs(top.value - second.value);
      if (predictorConfidence < diff) {
        predictorConfidence = diff;
      }
    }
    if (predictorConfidence < PREDICTOR_MIN_CONFIDENCE) {
      predictorDecision = 'both';
      predictorDecisionLabel = 'none';
    }
    if (predictorDecision !== 'long' && predictorDecision !== 'short') {
      predictorDecision = 'both';
    }

    const intendedSide = params.side ?? (params.family === 'mean_reversion' ? 'both' : 'long');
    if ((predictorDecision === 'long' && intendedSide === 'short') || (predictorDecision === 'short' && intendedSide === 'long')) {
      console.log(JSON.stringify({
        level: 'info',
        event: 'adaptive_trade_blocked_by_predictor',
        symbol: params.symbol,
        sessionId: params.sessionId ?? null,
        token: params.token,
        predictorDecision,
        predictorDecisionLabel,
        predictorProbability: Number(predictorPrimaryProbability.toFixed(4)),
        predictorConfidence: Number(predictorConfidence.toFixed(4)),
        intendedSide,
      }));
      return 'predictor_blocked';
    }

    if (intendedSide === 'short') {
      const predictorAllowsShort = predictorDecision === 'short' || predictorDecision === 'both';
      const cmfThresholdAbs = params.flowThreshold != null && Number.isFinite(params.flowThreshold)
        ? Math.abs(params.flowThreshold)
        : DEFAULT_SHORT_CMF_THRESHOLD;
      const cmfRequirement = -Math.abs(cmfThresholdAbs);
      const flowCmfValue = params.flowCmf;
      const flowPass = flowCmfValue != null && Number.isFinite(flowCmfValue) && flowCmfValue <= cmfRequirement;
      const mtfConsensus = params.mtfConsensus ?? null;
      const mtfPass = mtfConsensus === 'bearish';
      const flowVolumeRatioValue = params.flowVolumeRatio;
      const flowVolumeRatioLogged = flowVolumeRatioValue != null && Number.isFinite(flowVolumeRatioValue)
        ? Number(flowVolumeRatioValue.toFixed(4))
        : (flowVolumeRatioValue ?? null);
      if (!predictorAllowsShort || !flowPass || !mtfPass) {
        const guardReasons: string[] = [];
        if (!predictorAllowsShort) guardReasons.push('predictor_disagrees');
        if (!flowPass) guardReasons.push('flow_cmf_threshold');
        if (!mtfPass) guardReasons.push('mtf_not_bearish');
        console.log(JSON.stringify({
          level: 'info',
          event: 'adaptive_trade_blocked_by_predictor',
        symbol: params.symbol,
        sessionId: params.sessionId ?? null,
        token: params.token,
        predictorDecision,
        predictorDecisionLabel,
        predictorProbability: Number(predictorPrimaryProbability.toFixed(4)),
        predictorConfidence: Number(predictorConfidence.toFixed(4)),
        intendedSide,
        reason: 'short_guardrail',
        guardReasons,
          flowCmf: flowCmfValue != null && Number.isFinite(flowCmfValue) ? Number(flowCmfValue.toFixed(6)) : null,
          flowThreshold: -cmfThresholdAbs,
          flowVolumeRatio: flowVolumeRatioLogged,
          mtfConsensus,
          mtfMatches: params.mtfMatches ?? null,
          mtfFrames: params.mtfFrames ?? null,
        }));
        return 'predictor_blocked';
      }
    }

    const qty = new PreciseDecimal(params.qty ?? 0);
    const qtyAbs = qty.abs();
    const entryPrice = new PreciseDecimal(params.entryPrice ?? 0);
    const stopDistance = new PreciseDecimal(params.stopDistance ?? 0).abs();
    const riskPerUnit = params.riskPerUnit != null && Number.isFinite(params.riskPerUnit)
      ? new PreciseDecimal(params.riskPerUnit)
      : stopDistance;
    const planRiskUsd = params.plan.riskUsd ?? new PreciseDecimal('0');
    const computedRisk = riskPerUnit.times(qtyAbs);
    const riskUsd = planRiskUsd.gt(0) ? planRiskUsd : computedRisk;
    const normalizedTargets = Array.isArray(params.targets)
      ? params.targets
        .map((target) => Number(target))
        .filter((value) => Number.isFinite(value))
        .map((value) => Number(value.toFixed(6)))
      : [];
    const primaryTp = params.plan.takeProfitMultiples[0] ?? new PreciseDecimal('2');
    let computedTargetUsd = riskPerUnit.times(qtyAbs).times(primaryTp);
    if (normalizedTargets.length) {
      const targetPrice = new PreciseDecimal(normalizedTargets[0]);
      const diff = targetPrice.minus(entryPrice).abs();
      computedTargetUsd = diff.times(qtyAbs);
    }
    const planTargetProfitUsd = params.plan.targetProfitUsd ?? new PreciseDecimal('0');
    const targetProfitUsd = planTargetProfitUsd.gt(0) ? planTargetProfitUsd : computedTargetUsd;
    const entryAtrValue = params.entryAtr != null && Number.isFinite(params.entryAtr) ? Number(params.entryAtr) : null;
    const entryAtrPctValue = params.entryAtrPct != null && Number.isFinite(params.entryAtrPct)
      ? Number(params.entryAtrPct)
      : null;
    const rr = (() => {
      if (params.rr != null && Number.isFinite(params.rr)) {
        return Number(params.rr);
      }
      if (!normalizedTargets.length || !riskPerUnit.gt(0)) {
        return null;
      }
      const targetPrice = new PreciseDecimal(normalizedTargets[0]);
      const diff = targetPrice.minus(entryPrice).abs();
      if (riskPerUnit.equals(0)) {
        return null;
      }
      return diff.dividedBy(riskPerUnit).toNumber();
    })();
    const rrValue = rr != null && Number.isFinite(rr) ? Number(rr.toFixed(6)) : null;
    const side = params.side ?? (params.family === 'mean_reversion' ? 'both' : 'long');
    const minHoldMinutesValue = params.minHoldMinutes != null && Number.isFinite(params.minHoldMinutes)
      ? Number(params.minHoldMinutes)
      : null;
    const entryPriceNumber = entryPrice.toNumber();
    const sideEffective: 'long' | 'short' = (() => {
      if (side === 'short') return 'short';
      if (side === 'long') return 'long';
      const firstTarget = normalizedTargets[0];
      if (Number.isFinite(firstTarget)) {
        return firstTarget! < entryPriceNumber ? 'short' : 'long';
      }
      return 'long';
    })();
    const queue = this.activeTrades.get(params.sessionId) ?? [];
    const pythonTrackingKey = this.pythonTradeKey(params.sessionId ?? null, params.token ?? null, params.symbol);
    if (pythonTrackingKey) {
      this.pythonPerformance.recordExpectation(
        pythonTrackingKey,
        predictorPrimaryProbability,
        predictorConfidence,
      );
    }
    const pythonEntryWeight = pythonSignalMeta?.entryWeight ?? 1;
    const planRiskMultiplierDecimal = params.plan.pythonRiskMultiplier ?? new PreciseDecimal('1');
    if (!this.guardsDisabled && pythonSignalMeta?.cooldown.active) {
      const cooldownSeconds = pythonSignalMeta.cooldown.seconds ?? 180;
      const until = Date.now() + Math.max(0, cooldownSeconds) * 1000;
      const key = this.cooldownKey(params.sessionId ?? null, params.symbol);
      this.symbolCooldowns.set(key, Math.max(this.symbolCooldowns.get(key) ?? 0, until));
    }
    queue.push({
      token: params.token,
      family: params.family,
      id: params.id,
      riskUsd,
      riskPerUnit,
      atrPct: params.plan.stopAtrMult.toNumber(),
      timestamp: Date.now(),
      symbol: params.symbol,
      side,
      qty,
      entryPrice,
      entryAtr: entryAtrValue,
      entryAtrPct: entryAtrPctValue,
      planRiskPct: params.plan.riskPct,
      targetProfitUsd,
      medianTakeProfitR: params.plan.medianTakeProfitR,
      targets: normalizedTargets,
      rr: rrValue,
      trailingPolicy: params.plan.trailingPolicy ?? null,
      pythonProbability: predictorPrimaryProbability,
      pythonConfidence: predictorConfidence,
      pythonEntryWeight,
      pythonRiskMultiplier: planRiskMultiplierDecimal.toNumber(),
      pythonCooldownSeconds: pythonSignalMeta?.cooldown.seconds ?? null,
      pythonTrackingKey,
      minHoldMinutes: minHoldMinutesValue,
      sideEffective,
      minHoldGuardActive: false,
      minHoldGuardCount: 0,
      minHoldGuardLastTs: null,
      lastExitReason: null,
      lastExitDirective: null,
    });
    this.activeTrades.set(params.sessionId, queue);

    console.log(JSON.stringify({
      level: 'info',
      event: 'adaptive_trade_registered',
      symbol: params.symbol,
      sessionId: params.sessionId ?? null,
      token: params.token,
      predictorDecision,
      predictorDecisionLabel,
      predictorProbability: Number(predictorPrimaryProbability.toFixed(4)),
      predictorConfidence: Number(predictorConfidence.toFixed(4)),
      intendedSide,
    }));
    return 'registered';
  }

  noteMinHoldGuard(params: {
    sessionId?: string | null;
    symbol: string;
    token?: string | null;
    reason?: string | null;
    elapsedMs?: number | null;
    requiredMs?: number | null;
  }): void {
    if (!params.sessionId) return;
    const queue = this.activeTrades.get(params.sessionId);
    if (!queue || queue.length === 0) return;
    let tradeIndex = 0;
    const candidate = queue.findIndex(
      trade => trade.symbol === params.symbol && (!params.token || trade.token === params.token),
    );
    if (candidate >= 0) {
      tradeIndex = candidate;
    } else if (params.token) {
      const tokenOnlyIndex = queue.findIndex(trade => trade.token === params.token);
      if (tokenOnlyIndex >= 0) {
        tradeIndex = tokenOnlyIndex;
      }
    }
    const trade = queue[tradeIndex];
    if (!trade) return;
    trade.minHoldGuardActive = true;
    trade.minHoldGuardCount = (trade.minHoldGuardCount ?? 0) + 1;
    trade.minHoldGuardLastTs = Date.now();
    trade.lastExitDirective = params.reason ?? trade.lastExitDirective ?? 'min_hold_active';
    const minutesElapsed = params.elapsedMs != null && Number.isFinite(params.elapsedMs)
      ? Number((params.elapsedMs / 60000).toFixed(4))
      : null;
    const minutesRequired = (() => {
      if (params.requiredMs != null && Number.isFinite(params.requiredMs)) {
        return Number((params.requiredMs / 60000).toFixed(4));
      }
      if (trade.minHoldMinutes != null && Number.isFinite(trade.minHoldMinutes)) {
        return Number(trade.minHoldMinutes.toFixed(4));
      }
      return null;
    })();
    queue[tradeIndex] = trade;
    this.activeTrades.set(params.sessionId, queue);
    console.log(JSON.stringify({
      level: 'info',
      event: 'adaptive_trade_min_hold_guard',
      timestamp: new Date().toISOString(),
      sessionId: params.sessionId ?? null,
      symbol: params.symbol,
      token: params.token ?? null,
      side: trade.side,
      side_effective: trade.sideEffective,
      min_hold_guard_active: true,
      activation_count: trade.minHoldGuardCount,
      minutes_elapsed: minutesElapsed,
      min_hold_minutes_required: minutesRequired,
      reason: params.reason ?? 'min_hold_active',
    }));
  }

  registerOutcome(params: {
    sessionId?: string | null;
    symbol: string;
    token?: string | null;
    realizedPnlUsd?: number | null;
    exitReason?: AdaptiveExitReason | null;
    rawExitReason?: string | null;
    holdDurationMs?: number | null;
    minHoldRequiredMs?: number | null;
    sideEffective?: 'long' | 'short' | null;
    minHoldGuardActive?: boolean | null;
  }): void {
    if (!params.sessionId) return;
    const queue = this.activeTrades.get(params.sessionId);
    if (!queue || queue.length === 0) return;
    let tradeIndex = 0;
    if (params.token) {
      tradeIndex = queue.findIndex(trade => trade.token === params.token && trade.symbol === params.symbol);
      if (tradeIndex === -1) tradeIndex = 0;
    }
    const trade = queue.splice(tradeIndex, 1)[0];
    if (queue.length === 0) {
      this.activeTrades.delete(params.sessionId);
    } else {
      this.activeTrades.set(params.sessionId, queue);
    }
    if (!trade) return;
    const pnl = new PreciseDecimal(params.realizedPnlUsd ?? 0);
    const risk = trade.riskUsd.abs().gt(0) ? trade.riskUsd.abs() : new PreciseDecimal('1');
    const normalized = pnl.dividedBy(risk);
    const ledgerKey = this.ledgerKey(params.sessionId, params.symbol);
    const previous = this.tradeLedgers.get(ledgerKey) ?? new PreciseDecimal('0');
    const cumulative = previous.plus(pnl);
    this.tradeLedgers.set(ledgerKey, cumulative);
    if (trade.pythonTrackingKey) {
      this.pythonPerformance.recordOutcome(trade.pythonTrackingKey, normalized.toNumber());
    }
    const holdElapsedMs = (() => {
      if (params.holdDurationMs != null && Number.isFinite(params.holdDurationMs)) {
        return Number(params.holdDurationMs);
      }
      return Math.max(0, Date.now() - trade.timestamp);
    })();
    const minHoldRequiredMs = (() => {
      if (params.minHoldRequiredMs != null && Number.isFinite(params.minHoldRequiredMs)) {
        return Math.max(0, Number(params.minHoldRequiredMs));
      }
      if (trade.minHoldMinutes != null && Number.isFinite(trade.minHoldMinutes)) {
        return Math.max(0, trade.minHoldMinutes * 60000);
      }
      return null;
    })();
    const guardActive = Boolean(params.minHoldGuardActive ?? trade.minHoldGuardActive);
    const guardCount = trade.minHoldGuardCount ?? (guardActive ? 1 : 0);
    const sideEffective = params.sideEffective ?? trade.sideEffective ?? (trade.side === 'short' ? 'short' : 'long');
    const exitReason = params.exitReason ?? trade.lastExitReason ?? (guardActive ? 'min_hold_violation_prevented' : 'other');
    const rawExitReason = params.rawExitReason ?? trade.lastExitDirective ?? null;
    console.log(JSON.stringify({
      level: 'info',
      event: 'adaptive_trade_outcome',
      timestamp: new Date().toISOString(),
      sessionId: params.sessionId ?? null,
      symbol: params.symbol,
      token: params.token ?? null,
      side: trade.side,
      side_effective: sideEffective,
      qty: trade.qty.toFixed(6),
      entryPrice: trade.entryPrice.toFixed(6),
      realizedPnlUsd: pnl.toFixed(6),
      cumulativePnlUsd: cumulative.toFixed(6),
      riskUsd: trade.riskUsd.toFixed(6),
      targetProfitUsd: trade.targetProfitUsd.toFixed(6),
      riskPerUnit: trade.riskPerUnit.toFixed(6),
      rr: trade.rr != null ? Number(trade.rr.toFixed(4)) : null,
      firstTarget: trade.targets.length ? Number(trade.targets[0].toFixed(6)) : null,
      exit_reason: exitReason,
      exit_reason_raw: rawExitReason,
      min_hold_elapsed_ms: Math.max(0, Math.round(holdElapsedMs)),
      min_hold_required_ms: minHoldRequiredMs != null ? Math.max(0, Math.round(minHoldRequiredMs)) : null,
      min_hold_guard_active: guardActive,
      min_hold_guard_count: guardCount,
      min_hold_guard_last_ts: trade.minHoldGuardLastTs ? new Date(trade.minHoldGuardLastTs).toISOString() : null,
    }));
    if (this.reentryCooldownMs > 0 && normalized.lt(0)) {
      const now = Date.now();
      const until = now + this.reentryCooldownMs;
      const cooldownKey = this.cooldownKey(params.sessionId ?? null, params.symbol);
      this.symbolCooldowns.set(cooldownKey, until);
      console.log(JSON.stringify({
        level: 'info',
        event: 'adaptive_symbol_cooldown',
        sessionId: params.sessionId ?? null,
        symbol: params.symbol,
        cooldownMinutes: Number((this.reentryCooldownMs / 60000).toFixed(2)),
        eligibleAt: new Date(until).toISOString(),
      }));
    }
    this.updateStats(params.symbol, trade.family, normalized);
  }

  getActiveTradeSnapshot(
    sessionId: string | null | undefined,
    token?: string | null,
    symbol?: string | null,
  ): AdaptiveTradeSnapshot | null {
    if (!sessionId) return null;
    const queue = this.activeTrades.get(sessionId);
    if (!queue || queue.length === 0) return null;
    let trade = token
      ? queue.find(item => item.token === token && (!symbol || item.symbol === symbol))
      : undefined;
    if (!trade && symbol) {
      trade = [...queue].reverse().find(item => item.symbol === symbol);
    }
    if (!trade) {
      trade = queue[queue.length - 1];
    }
    if (!trade) return null;
    return {
      token: trade.token,
      symbol: trade.symbol,
      side: trade.side,
      qty: trade.qty.toNumber(),
      entryPrice: trade.entryPrice.toNumber(),
      riskPerUnit: trade.riskPerUnit.toNumber(),
      targets: trade.targets.map((target) => Number(target)),
      entryAtr: trade.entryAtr ?? null,
      entryAtrPct: trade.entryAtrPct ?? null,
      riskUsd: trade.riskUsd.toNumber(),
      targetProfitUsd: trade.targetProfitUsd.toNumber(),
      rr: trade.rr ?? null,
    };
  }

  private scalePlanByAtr(
    base: AdaptiveStrategyPlan,
    atr15m: number,
    atr1h: number,
    atr4h: number,
    capital: PreciseDecimal,
    desiredProfit: PreciseDecimal,
    allowUpsize: boolean,
    feeBps: PreciseDecimal,
  ): AdaptiveStrategyPlan {
    const targetAtr = atr1h > 0 ? atr1h : atr15m;
    const current = atr15m > 0 ? atr15m : targetAtr;
    const ratio = current > 0 ? clamp(targetAtr / current, 0.75, 1.35) : 1;
    let scaledRisk = base.riskPct.times(new PreciseDecimal(ratio.toFixed(6)));
    const atrBlend = atr4h > 0 ? (atr4h + atr1h + atr15m) / 3 : atr1h > 0 ? (atr1h + atr15m) / 2 : atr15m;
    const stopMult = base.stopAtrMult.times(new PreciseDecimal(clamp(atrBlend > 0 ? atr15m / atrBlend : 1, 0.75, 1.35).toFixed(6)));
    const median = base.medianTakeProfitR ?? new PreciseDecimal('1');
    if (median.gt(0) && !capital.equals(0)) {
      const numerator = desiredProfit.times(new PreciseDecimal('100'));
      const denominator = capital.times(median);
      const targetRiskPct = denominator.equals(0) ? new PreciseDecimal('0') : numerator.dividedBy(denominator);
      if (targetRiskPct.gt(scaledRisk)) {
        scaledRisk = targetRiskPct;
      }
    }
    const defaultMin = new PreciseDecimal('0.6');
    const absoluteMin = new PreciseDecimal('0.25');
    const minRiskCandidate = base.riskPct.lt(defaultMin) ? base.riskPct : defaultMin;
    const minRisk = minRiskCandidate.lt(absoluteMin) ? absoluteMin : minRiskCandidate;
    const baseMax = allowUpsize ? new PreciseDecimal('2.2') : new PreciseDecimal('1.4');
    const maxRisk = base.riskPct.gt(baseMax) ? base.riskPct : baseMax;
    let finalRiskPct = this.clampDecimal(scaledRisk, minRisk, maxRisk);
    const suppressionThreshold = new PreciseDecimal('0.8');
    if (base.riskPct.lt(suppressionThreshold) && finalRiskPct.gt(base.riskPct)) {
      finalRiskPct = base.riskPct;
    }
    if (!allowUpsize && finalRiskPct.gt(base.riskPct)) {
      finalRiskPct = base.riskPct;
    }
    const zero = new PreciseDecimal('0');
    const atrForStop = atr15m > 0 ? atr15m : atr1h > 0 ? atr1h : atr4h;
    let riskUsd = capital.times(finalRiskPct).dividedBy(this.hundred);
    let targetProfitUsd = median.times(riskUsd);
    let netAfterFees = this.computeNetAfterFees({
      riskUsd,
      stopMult,
      atrPct: atrForStop,
      feeBps,
      targetProfitUsd,
    });
    if (netAfterFees.net.lt(desiredProfit)) {
      const netPositive = !netAfterFees.net.equals(0) && !netAfterFees.net.lt(0);
      if (allowUpsize && netPositive) {
        const scaleFactor = desiredProfit.dividedBy(netAfterFees.net);
        let scaled = finalRiskPct.times(scaleFactor);
        scaled = this.clampDecimal(scaled, minRisk, maxRisk);
        if (base.riskPct.lt(suppressionThreshold) && scaled.gt(base.riskPct)) {
          scaled = base.riskPct;
        }
        if (!allowUpsize && scaled.gt(base.riskPct)) {
          scaled = base.riskPct;
        }
        finalRiskPct = scaled;
        riskUsd = capital.times(finalRiskPct).dividedBy(this.hundred);
        targetProfitUsd = median.times(riskUsd);
        netAfterFees = this.computeNetAfterFees({
          riskUsd,
          stopMult,
          atrPct: atrForStop,
          feeBps,
          targetProfitUsd,
        });
      }
      if (!allowUpsize || netAfterFees.net.lt(desiredProfit) || !netPositive) {
        finalRiskPct = zero;
        riskUsd = zero;
        targetProfitUsd = zero;
      }
    }
    const trailingPolicy = base.trailingPolicy
      ? {
          breakevenArmR: new PreciseDecimal(base.trailingPolicy.breakevenArmR),
          trailActivationR: new PreciseDecimal(base.trailingPolicy.trailActivationR),
          atrLookback: base.trailingPolicy.atrLookback,
          atrMultiplier: base.trailingPolicy.atrMultiplier
            .times(new PreciseDecimal(clamp(ratio, 0.85, 1.2).toFixed(6))),
          contextAlignmentThreshold: new PreciseDecimal(base.trailingPolicy.contextAlignmentThreshold),
          adxThreshold: new PreciseDecimal(base.trailingPolicy.adxThreshold),
        }
      : null;

    return {
      riskPct: finalRiskPct,
      stopAtrMult: stopMult,
      takeProfitMultiples: base.takeProfitMultiples.map(tp => tp),
      executionMode: base.executionMode,
      riskUsd,
      targetProfitUsd,
      medianTakeProfitR: median,
      trailingPolicy,
      entryWeight: base.entryWeight,
      pythonRiskMultiplier: base.pythonRiskMultiplier,
    };
  }

  private applyPythonPlanAdjustments(
    base: AdaptiveStrategyPlan,
    signal: PythonHybridSignal | null,
  ): AdaptiveStrategyPlan {
    if (!signal) {
      return base;
    }
    const riskMultiplier = new PreciseDecimal(signal.riskMultiplier.toFixed(6));
    const entryWeight = new PreciseDecimal(signal.entryWeight.toFixed(6));
    return {
      ...base,
      riskPct: base.riskPct.times(riskMultiplier),
      pythonRiskMultiplier: riskMultiplier,
      entryWeight,
    };
  }

  private updateStats(symbol: string, family: StrategyFamily, outcome: PreciseDecimal): void {
    const symbolMap = this.stats.get(symbol) ?? new Map<StrategyFamily, StrategyStats>();
    const stat = symbolMap.get(family) ?? { outcomes: [], sum: new PreciseDecimal('0'), wins: 0, losses: 0 };
    const maxSamples = 40;
    stat.outcomes.push(outcome);
    stat.sum = stat.sum.plus(outcome);
    if (outcome.gt(0)) stat.wins += 1;
    else if (outcome.lt(0)) stat.losses += 1;
    if (stat.outcomes.length > maxSamples) {
      const removed = stat.outcomes.shift();
      if (removed) {
        stat.sum = stat.sum.minus(removed);
        if (removed.gt(0)) stat.wins = Math.max(0, stat.wins - 1);
        else if (removed.lt(0)) stat.losses = Math.max(0, stat.losses - 1);
      }
    }
    symbolMap.set(family, stat);
    this.stats.set(symbol, symbolMap);
    this.evaluateGuardrail(symbol, family, stat);
  }

  private guardrailReason(symbol: string, family: StrategyFamily): string | null {
    const halt = this.getGuardrailState(symbol, family);
    if (halt) {
      if (halt.activeUntil > Date.now()) {
        const remainingMs = halt.activeUntil - Date.now();
        const remainingHours = Math.max(0, remainingMs / (60 * 60 * 1000));
        return `${halt.reason}(cooldown=${remainingHours.toFixed(2)}h)`;
      }
      this.clearGuardrail(symbol, family);
    }
    return null;
  }

  private getGuardrailState(symbol: string, family: StrategyFamily): GuardrailHalt | null {
    const bucket = this.guardrailHalts.get(symbol);
    if (!bucket) return null;
    return bucket.get(family) ?? null;
  }

  private setGuardrailState(symbol: string, family: StrategyFamily, halt: GuardrailHalt): void {
    const bucket = this.guardrailHalts.get(symbol) ?? new Map<StrategyFamily, GuardrailHalt>();
    bucket.set(family, halt);
    this.guardrailHalts.set(symbol, bucket);
  }

  private clearGuardrail(symbol: string, family: StrategyFamily): void {
    const bucket = this.guardrailHalts.get(symbol);
    if (!bucket) return;
    if (bucket.delete(family)) {
      console.log(JSON.stringify({
        level: 'info',
        event: 'adaptive_guardrail_clear',
        symbol,
        family,
      }));
    }
    if (bucket.size === 0) {
      this.guardrailHalts.delete(symbol);
    }
  }

  private evaluateGuardrail(symbol: string, family: StrategyFamily, stat: StrategyStats): void {
    const sample = stat.outcomes.length;
    if (sample < GUARDRAIL_CONFIG.minSamples) {
      const existing = this.getGuardrailState(symbol, family);
      if (existing && existing.activeUntil <= Date.now()) {
        this.clearGuardrail(symbol, family);
      }
      return;
    }

    const expectancy = stat.sum.dividedBy(new PreciseDecimal(sample.toString()));
    const winRate = stat.wins / sample;
    const now = Date.now();
    const existing = this.getGuardrailState(symbol, family);

    const shouldHaltByWinRate = winRate < GUARDRAIL_CONFIG.winRateFloor;
    const shouldHaltByExpectancy = expectancy.lt(GUARDRAIL_CONFIG.expectancyFloor);

    if (shouldHaltByWinRate || shouldHaltByExpectancy) {
      const reason = shouldHaltByWinRate
        ? `halt_winrate_below_${Math.round(GUARDRAIL_CONFIG.winRateFloor * 100)}pct`
        : 'halt_expectancy_negative';
      if (existing && existing.reason === reason && existing.activeUntil > now) {
        return;
      }
      const halt: GuardrailHalt = {
        reason,
        triggeredAt: now,
        activeUntil: now + GUARDRAIL_CONFIG.cooldownMs,
        winRate,
        expectancy,
        samples: sample,
      };
      this.setGuardrailState(symbol, family, halt);
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'adaptive_guardrail_halt',
        symbol,
        family,
        reason,
        cooldown_hours: GUARDRAIL_CONFIG.cooldownMs / (60 * 60 * 1000),
        metrics: {
          winRate,
          expectancy: expectancy.toNumber(),
          samples: sample,
        },
      }));
      return;
    }

    if (existing && !shouldHaltByWinRate && !shouldHaltByExpectancy) {
      this.clearGuardrail(symbol, family);
    }
  }

  private chooseStrategy(
    sessionId: string | null | undefined,
    symbol: string,
    ordered: StrategyScoreResult[],
    context: { atr15mPct: number; atr1hPct: number; realizedVol: number; hurst: number },
    extras: {
      watchlist: { isNew: boolean; volumeSurge: number; rank: number | null; rankingScore: number };
      regime: MarketRegimeSignal;
      derivativeVolatility: number;
      combinedBias: number;
    },
  ): AdaptiveSignal | null {
    if (!ordered.length) return null;
    if (!this.isSymbolEligibleForEntry(sessionId ?? null, symbol)) {
      return null;
    }
    const available = ordered.filter(signal => signal.active).length > 0
      ? ordered.filter(signal => signal.active)
      : ordered;
    let chosen: StrategyScoreResult | null = null;
    let exploration = false;
    const candidate = available[0] ?? ordered[0];
    const epsilon = candidate
      ? this.computeExplorationProbability(symbol, candidate, context, extras)
      : this.epsilonBase;
    if (this.nextRandom() < epsilon) {
      exploration = true;
      const index = Math.floor(this.nextRandom() * available.length);
      chosen = available[index];
    } else {
      chosen = available[0];
    }
    if (!chosen) return null;
    const token = sessionId ? this.nextToken() : null;
    return { ...chosen, exploration, token };
  }
}

export const __testHooks = {
  buildPredictorFeatures,
};

export const metaAdaptiveStrategyAgent = MetaAdaptiveStrategyAgent.getInstance();
