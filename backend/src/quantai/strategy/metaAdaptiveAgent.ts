import { TechnicalSnapshot } from '../../ai/tech.js';
import type { Diagnostics as MultiTimeframeDiagnostics } from '../../ai/multiTimeframe.js';

const DECIMAL_SCALE = 1_000_000n;

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

type StrategyFamily = 'trend' | 'breakout' | 'mean_reversion' | 'momentum';

type StrategyId =
  | 'classic_trend_following'
  | 'breakout_retest'
  | 'bollinger_mean_reversion'
  | 'momentum_scanner_focus';

type StrategyBias = 'long' | 'short' | 'both';

export type AdaptiveStrategyPlan = {
  riskPct: PreciseDecimal;
  stopAtrMult: PreciseDecimal;
  takeProfitMultiples: PreciseDecimal[];
  executionMode: 'market' | 'limit' | 'twap';
};

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
};

export type AdaptiveSignal = StrategyScoreResult & {
  exploration: boolean;
  token: string | null;
};

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
  };
  atr1h?: number | null;
  atr4h?: number | null;
  volume24hUsd?: number | null;
  forceLiquidityGate?: boolean;
  multiTimeframe?: MultiTimeframeDiagnostics | null;
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
  atrPct: number;
  timestamp: number;
  symbol: string;
};

type GuardrailHalt = {
  reason: string;
  triggeredAt: number;
  activeUntil: number;
  winRate: number;
  expectancy: PreciseDecimal;
  samples: number;
};

const LIQUIDITY_GUARD = {
  minVolumeUsd: 50_000_000,
  maxSpreadBps: 10,
  minDepthUsd: 10_000,
} as const;

const GUARDRAIL_CONFIG = {
  minSamples: 12,
  winRateFloor: 0.35,
  expectancyFloor: 0,
  cooldownMs: 6 * 60 * 60 * 1000,
} as const;

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

  const direction = biasToStrategy(bias4h === 'neutral' ? bias1h : bias4h);
  const reasons = [
    `htf=${bias4h}`,
    `1h=${bias1h}`,
    `15m=${bias15m}`,
  ];

  let alignmentScore = 0.6;
  let conflict = false;

  if (bias4h !== 'neutral') {
    const matches = [bias1h, bias15m].filter(b => b === bias4h).length;
    const mismatches = [bias1h, bias15m].filter(b => b !== 'neutral' && b !== bias4h).length;
    if (mismatches > 0) {
      conflict = true;
      alignmentScore = 0.18 + matches * 0.1;
    } else {
      alignmentScore = 0.7 + matches * 0.15;
    }
  } else {
    if (bias1h !== 'neutral' && bias15m === bias1h) {
      alignmentScore = 0.78;
    } else if (bias1h !== 'neutral' || bias15m !== 'neutral') {
      alignmentScore = 0.65;
    }
  }

  alignmentScore = clamp(alignmentScore, 0.1, 1);
  reasons.push(`alignment=${alignmentScore.toFixed(2)}`);
  if (conflict) reasons.push('htf_conflict');

  return { direction, alignmentScore, conflict, reasons };
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class MetaAdaptiveStrategyAgent {
  private static instance: MetaAdaptiveStrategyAgent | null = null;

  private readonly stats = new Map<string, Map<StrategyFamily, StrategyStats>>();
  private readonly activeTrades = new Map<string, ActiveTrade[]>();
  private readonly liquidityLog = new Map<string, number>();
  private readonly guardrailHalts = new Map<string, Map<StrategyFamily, GuardrailHalt>>();
  private epsilon = 0.08;

  static getInstance(): MetaAdaptiveStrategyAgent {
    if (!MetaAdaptiveStrategyAgent.instance) {
      MetaAdaptiveStrategyAgent.instance = new MetaAdaptiveStrategyAgent();
    }
    return MetaAdaptiveStrategyAgent.instance;
  }

  setExplorationEpsilon(epsilon: number): void {
    this.epsilon = clamp(epsilon, 0, 1);
  }

  evaluate(input: AdaptiveEvaluationInput): { signals: AdaptiveSignal[]; selection: AdaptiveSignal | null } {
    const micro = input.micro ?? {};
    const snap = input.snap;
    const price = safeNumber(snap.last, 0);
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

    const emaAlignmentBull = ema20 >= ema50 && ema50 >= ema100 && ema100 >= ema200;
    const emaAlignmentBear = ema20 <= ema50 && ema50 <= ema100 && ema100 <= ema200;
    const emaAlignmentScore = emaAlignmentBull || emaAlignmentBear ? 1 : 0.2;
    const slope = slopeScore(snap.ema20Slope ?? 0, ema20 || price || 1);
    const volumeRatio = computeVolumeRatio(snap);
    const cmf = safeNumber((snap as any)?.cmf20, 0);

    const compressionScore = (() => {
      const realized = safeNumber(snap.realizedVol, atr15mPct);
      if (realized <= 0) return 0;
      const atrRatio = atr15mPct / realized;
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

    const liquidityFailures: string[] = [];
    const volumePresent = Number.isFinite(volume24hUsd);
    const volumeOk = !volumePresent || (volume24hUsd as number) >= LIQUIDITY_GUARD.minVolumeUsd;
    const spreadOk = Number.isFinite(spreadBps) ? (spreadBps as number) <= LIQUIDITY_GUARD.maxSpreadBps : true;
    const depthOk = Number.isFinite(depthUsd) ? (depthUsd as number) >= LIQUIDITY_GUARD.minDepthUsd : true;

    if (volumePresent && !volumeOk) {
      liquidityFailures.push('volume_24h_below_threshold');
    }
    if (!spreadOk) {
      liquidityFailures.push('spread_above_threshold');
    }
    if (!depthOk) {
      liquidityFailures.push('depth_below_threshold');
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
    let microPenalty = 0;
    if (Number.isFinite(spreadBps) && spreadBps > 10) {
      microPenalty += normalize(spreadBps, 10, 35);
      penalties.push('spread_wide');
    }
    if (Number.isFinite(depthUsd) && depthUsd < 10_000) {
      microPenalty += normalize(10_000 - depthUsd, 0, 9_000);
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
    microPenalty = clamp(microPenalty, 0, 1);

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

    const scoreBreakout = clamp(
      (compressionScore
        + normalize(adx, 16, 35)
        + clamp(volumeRatio / 2, 0, 1)
        + clamp((cmf + 0.3) / 0.8, 0, 1)
        + Math.max(context.alignmentScore, 0.4)) / 5,
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

    const scoreMomentum = clamp(
      (clamp(Math.abs((snap as any)?.trend ?? 0) / 1.8, 0, 1)
        + clamp(trendStrength / 1.0, 0, 1)
        + clamp(volumeRatio / 2.5, 0, 1)
        + clamp((cmf + 0.2) / 0.6, 0, 1)
        + context.alignmentScore) / 5,
      0,
      1,
    );

    const trendRiskBase = context.conflict
      ? '0.6'
      : context.alignmentScore >= 0.85
        ? '1.4'
        : context.alignmentScore >= 0.65
          ? '1.2'
          : '1';
    const breakoutRiskBase = context.conflict
      ? '0.7'
      : context.alignmentScore >= 0.75
        ? '1.25'
        : '0.95';
    const meanRiskBase = context.alignmentScore <= 0.45
      ? '1.0'
      : context.alignmentScore <= 0.6
        ? '0.9'
        : '0.75';
    const momentumRiskBase = context.conflict
      ? '0.6'
      : context.alignmentScore >= 0.8
        ? '1.3'
        : '1.05';

    const trendExecution: 'market' | 'limit' = context.alignmentScore >= 0.75 ? 'market' : 'limit';
    const breakoutExecution: 'market' | 'limit' = context.alignmentScore >= 0.7 ? 'market' : 'limit';
    const momentumExecution: 'market' | 'limit' = context.alignmentScore >= 0.8 ? 'market' : 'limit';

    const basePlans: Record<StrategyFamily, AdaptiveStrategyPlan> = {
      trend: {
        riskPct: new PreciseDecimal(trendRiskBase),
        stopAtrMult: new PreciseDecimal('1'),
        takeProfitMultiples: [new PreciseDecimal('1.8'), new PreciseDecimal('3'), new PreciseDecimal('5')],
        executionMode: trendExecution,
      },
      breakout: {
        riskPct: new PreciseDecimal(breakoutRiskBase),
        stopAtrMult: new PreciseDecimal('1'),
        takeProfitMultiples: [new PreciseDecimal('2'), new PreciseDecimal('3.5'), new PreciseDecimal('5')],
        executionMode: breakoutExecution,
      },
      mean_reversion: {
        riskPct: new PreciseDecimal(meanRiskBase),
        stopAtrMult: new PreciseDecimal('0.9'),
        takeProfitMultiples: [new PreciseDecimal('1.5'), new PreciseDecimal('2.4'), new PreciseDecimal('3.5')],
        executionMode: 'limit',
      },
      momentum: {
        riskPct: new PreciseDecimal(momentumRiskBase),
        stopAtrMult: new PreciseDecimal('1.1'),
        takeProfitMultiples: [new PreciseDecimal('2'), new PreciseDecimal('3.5'), new PreciseDecimal('5')],
        executionMode: momentumExecution,
      },
    };

    const adjustedPlans: Record<StrategyFamily, AdaptiveStrategyPlan> = {
      trend: this.scalePlanByAtr(basePlans.trend, atr15mPct, atr1hPct, atr4hPct),
      breakout: this.scalePlanByAtr(basePlans.breakout, atr15mPct, atr1hPct, atr4hPct),
      mean_reversion: this.scalePlanByAtr(basePlans.mean_reversion, atr15mPct, atr1hPct, atr4hPct),
      momentum: this.scalePlanByAtr(basePlans.momentum, atr15mPct, atr1hPct, atr4hPct),
    };

    const familyScores: Array<{ family: StrategyFamily; score: number; confidence: number; bias: StrategyBias; reasons: string[]; plan: AdaptiveStrategyPlan }>
      = [
        {
          family: 'trend',
          score: scoreTrend,
          confidence: scoreTrend,
          bias: chooseBiasFromTrend(snap.trendBias),
          reasons: [
            `adx=${adx.toFixed(2)}`,
            `trend_strength=${trendStrength.toFixed(2)}`,
            emaAlignmentBull ? 'ema_bull_stack' : emaAlignmentBear ? 'ema_bear_stack' : 'ema_mixed',
            ...context.reasons,
          ],
          plan: adjustedPlans.trend,
        },
        {
          family: 'breakout',
          score: scoreBreakout,
          confidence: scoreBreakout,
          bias: chooseBiasFromTrend(snap.trendBias),
          reasons: [
            `compression=${compressionScore.toFixed(2)}`,
            `volume_ratio=${volumeRatio.toFixed(2)}`,
            `cmf=${cmf.toFixed(3)}`,
            ...context.reasons,
          ],
          plan: adjustedPlans.breakout,
        },
        {
          family: 'mean_reversion',
          score: scoreMean,
          confidence: scoreMean,
          bias: 'both',
          reasons: [
            `rsi=${rsi.toFixed(1)}`,
            `range_bias=${srBias}`,
            distSupport != null ? `dist_support=${distSupport.toFixed(2)}%` : 'support_missing',
            distResistance != null ? `dist_resistance=${distResistance.toFixed(2)}%` : 'resistance_missing',
            `context_inverse=${contextInverse.toFixed(2)}`,
          ],
          plan: adjustedPlans.mean_reversion,
        },
        {
          family: 'momentum',
          score: scoreMomentum,
          confidence: scoreMomentum,
          bias: chooseBiasFromTrend(snap.trendBias),
          reasons: [
            `trend=${safeNumber((snap as any)?.trend, 0).toFixed(2)}`,
            `trend_strength=${trendStrength.toFixed(2)}`,
            `volume_ratio=${volumeRatio.toFixed(2)}`,
            `cmf=${cmf.toFixed(3)}`,
            ...context.reasons,
          ],
          plan: adjustedPlans.momentum,
        },
      ];

    const weighted: StrategyScoreResult[] = familyScores.map(item => {
      const penaltiesApplied = [...penalties];
      let effectiveScore = item.score * (1 - microPenalty * 0.6);
      if (context.conflict && item.family !== 'mean_reversion') {
        effectiveScore *= 0.45;
        if (!penaltiesApplied.includes('htf_conflict')) penaltiesApplied.push('htf_conflict');
      }
      if (!context.conflict && item.family === 'mean_reversion') {
        const suppress = clamp(1 - context.alignmentScore * 0.5, 0.4, 1);
        effectiveScore *= suppress;
        if (context.alignmentScore > 0.6) penaltiesApplied.push('htf_trend_dominant');
      }
      if (context.alignmentScore >= 0.8 && (item.family === 'trend' || item.family === 'momentum')) {
        effectiveScore = Math.min(1, effectiveScore * 1.15);
      }
      if (item.family === 'mean_reversion' && adx >= 18) {
        effectiveScore *= 0.6;
        penaltiesApplied.push('adx_too_high');
      }
      if (item.family === 'trend' && item.score < 0.35) {
        penaltiesApplied.push('trend_score_low');
      }
      if (item.family === 'momentum' && volumeRatio < 1.2) {
        effectiveScore *= 0.7;
        penaltiesApplied.push('volume_low');
      }
      const guardrail = this.guardrailReason(input.symbol, item.family);
      const active = effectiveScore >= 0.25 && guardrail == null;
      const id: StrategyId = item.family === 'trend'
        ? 'classic_trend_following'
        : item.family === 'breakout'
          ? 'breakout_retest'
          : item.family === 'mean_reversion'
            ? 'bollinger_mean_reversion'
            : 'momentum_scanner_focus';
      return {
        family: item.family,
        id,
        bias: item.bias,
        score: clamp(effectiveScore, 0, 1),
        confidence: clamp(item.confidence, 0, 1),
        active,
        reasons: item.reasons,
        penalties: penaltiesApplied,
        guardrail,
        plan: item.plan,
      };
    });

    const ordered = weighted.sort((a, b) => b.score - a.score);

    const selection = this.chooseStrategy(input.sessionId, input.symbol, ordered);
    return {
      signals: ordered.map(signal => ({ ...signal, exploration: selection?.id === signal.id && selection.exploration, token: selection?.token ?? null })),
      selection,
    };
  }

  registerActiveTrade(params: {
    sessionId?: string | null;
    symbol: string;
    family: StrategyFamily;
    id: StrategyId;
    token: string | null;
    qty: number;
    entryPrice: number;
    stopDistance: number;
    plan: AdaptiveStrategyPlan;
  }): void {
    if (!params.sessionId || !params.token) return;
    const riskUsd = new PreciseDecimal(params.stopDistance || 0).abs().times(new PreciseDecimal(params.qty || 0));
    const queue = this.activeTrades.get(params.sessionId) ?? [];
    queue.push({
      token: params.token,
      family: params.family,
      id: params.id,
      riskUsd,
      atrPct: params.plan.stopAtrMult.toNumber(),
      timestamp: Date.now(),
      symbol: params.symbol,
    });
    this.activeTrades.set(params.sessionId, queue);
  }

  registerOutcome(params: {
    sessionId?: string | null;
    symbol: string;
    token?: string | null;
    realizedPnlUsd?: number | null;
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
    this.updateStats(params.symbol, trade.family, normalized);
  }

  private scalePlanByAtr(base: AdaptiveStrategyPlan, atr15m: number, atr1h: number, atr4h: number): AdaptiveStrategyPlan {
    const targetAtr = atr1h > 0 ? atr1h : atr15m;
    const current = atr15m > 0 ? atr15m : targetAtr;
    const ratio = current > 0 ? clamp(targetAtr / current, 0.75, 1.35) : 1;
    const scaledRisk = base.riskPct.times(new PreciseDecimal(ratio.toFixed(6)));
    const atrBlend = atr4h > 0 ? (atr4h + atr1h + atr15m) / 3 : atr1h > 0 ? (atr1h + atr15m) / 2 : atr15m;
    const stopMult = base.stopAtrMult.times(new PreciseDecimal(clamp(atrBlend > 0 ? atr15m / atrBlend : 1, 0.75, 1.35).toFixed(6)));
    return {
      riskPct: scaledRisk,
      stopAtrMult: stopMult,
      takeProfitMultiples: base.takeProfitMultiples.map(tp => tp),
      executionMode: base.executionMode,
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

  private chooseStrategy(sessionId: string | null | undefined, symbol: string, ordered: StrategyScoreResult[]): AdaptiveSignal | null {
    if (!ordered.length) return null;
    const available = ordered.filter(signal => signal.active).length > 0
      ? ordered.filter(signal => signal.active)
      : ordered;
    let chosen: StrategyScoreResult | null = null;
    let exploration = false;
    if (Math.random() < this.epsilon) {
      exploration = true;
      const index = Math.floor(Math.random() * available.length);
      chosen = available[index];
    } else {
      chosen = available[0];
    }
    if (!chosen) return null;
    const token = sessionId ? randomToken() : null;
    return { ...chosen, exploration, token };
  }
}

export const metaAdaptiveStrategyAgent = MetaAdaptiveStrategyAgent.getInstance();
