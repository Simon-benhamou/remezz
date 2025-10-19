import { TechnicalSnapshot } from '../../ai/tech.js';
import type { Diagnostics as MultiTimeframeDiagnostics } from '../../ai/multiTimeframe.js';
import { defaultCalibrationProfile, type CalibrationProfile } from './metaAdaptiveCalibration.js';

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

export type StrategyFamily = 'trend' | 'breakout' | 'mean_reversion' | 'momentum';

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
  riskUsd: PreciseDecimal;
  targetProfitUsd: PreciseDecimal;
  medianTakeProfitR: PreciseDecimal;
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
  side: StrategyBias;
  qty: PreciseDecimal;
  entryPrice: PreciseDecimal;
  planRiskPct: PreciseDecimal;
  targetProfitUsd: PreciseDecimal;
  medianTakeProfitR: PreciseDecimal;
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
    { name: 'micro', maxVolumeUsd: 150_000_000, minVolumeUsd: 100_000_000, maxSpreadBps: 5, minDepthUsd: 50_000 },
    { name: 'mid', maxVolumeUsd: 500_000_000, minVolumeUsd: 150_000_000, maxSpreadBps: 6, minDepthUsd: 65_000 },
    { name: 'large', maxVolumeUsd: null, minVolumeUsd: 80_000_000, maxSpreadBps: 8, minDepthUsd: 30_000 },
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
  private epsilonBase = 0.08;
  private calibrationProfile: CalibrationProfile = defaultCalibrationProfile;
  private readonly sessionCapital = new Map<string, PreciseDecimal>();
  private readonly tradeLedgers = new Map<string, PreciseDecimal>();
  private readonly defaultCapital = new PreciseDecimal('1000');
  private readonly desiredProfitUsd = new PreciseDecimal('30');
  private readonly defaultFeeBps = new PreciseDecimal('4');
  private readonly hundred = new PreciseDecimal('100');
  private readonly tenThousand = new PreciseDecimal('10000');
  private rngState = 0x9e3779b9n;
  private tokenCounter = 0n;

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
      this.setRandomSeed(0x9e3779b9);
      this.calibrationProfile = defaultCalibrationProfile;
      return;
    }
    this.stats.delete(sessionId);
    this.activeTrades.delete(sessionId);
    this.guardrailHalts.delete(sessionId);
    this.sessionCapital.delete(sessionId);
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

  private computeExplorationProbability(symbol: string, candidate: StrategyScoreResult): number {
    const base = this.epsilonBase;
    const symbolStats = this.stats.get(symbol);
    const familyStats = symbolStats?.get(candidate.family);
    const samples = familyStats?.outcomes.length ?? 0;
    let epsilon = base;
    if (familyStats && samples >= 4) {
      const expectancy = familyStats.sum.dividedBy(new PreciseDecimal(samples.toString())).toNumber();
      const normalizedExpectancy = clamp(expectancy / 3, -1, 1);
      epsilon = base * (1 - Math.min(candidate.confidence, 0.95)) * (1 - Math.max(0, normalizedExpectancy));
    } else if (!familyStats || samples === 0) {
      epsilon = base * 1.15;
    } else {
      epsilon = base * (1 + (4 - samples) / 10);
    }
    epsilon = clamp(epsilon, this.calibrationProfile.explorationFloor, 0.35);
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

    const capital = this.resolveCapital(input.sessionId ?? null, input.accountBalanceUsd ?? null);
    const desiredProfit = input.desiredProfitUsd != null
      ? new PreciseDecimal(input.desiredProfitUsd)
      : this.desiredProfitUsd;

    const needsRiskReduction = context.alignmentScore < 0.65 || adx < 14;
    const riskAdjustmentFactor = context.conflict
      ? new PreciseDecimal('0.4')
      : needsRiskReduction
        ? new PreciseDecimal('0.5')
        : new PreciseDecimal('1');

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
      },
      breakout: {
        riskPct: new PreciseDecimal(breakoutRiskBase).times(riskAdjustmentFactor),
        stopAtrMult: new PreciseDecimal('1'),
        takeProfitMultiples: breakoutTargets,
        executionMode: breakoutExecution,
        riskUsd: new PreciseDecimal('0'),
        targetProfitUsd: new PreciseDecimal('0'),
        medianTakeProfitR: breakoutTargets[Math.min(1, breakoutTargets.length - 1)],
      },
      mean_reversion: {
        riskPct: new PreciseDecimal(meanRiskBase).times(needsRiskReduction ? new PreciseDecimal('0.75') : new PreciseDecimal('1')),
        stopAtrMult: new PreciseDecimal('0.9'),
        takeProfitMultiples: meanTargets,
        executionMode: 'limit',
        riskUsd: new PreciseDecimal('0'),
        targetProfitUsd: new PreciseDecimal('0'),
        medianTakeProfitR: meanTargets[Math.min(1, meanTargets.length - 1)],
      },
      momentum: {
        riskPct: new PreciseDecimal(momentumRiskBase).times(riskAdjustmentFactor),
        stopAtrMult: new PreciseDecimal('1.1'),
        takeProfitMultiples: momentumTargets,
        executionMode: momentumExecution,
        riskUsd: new PreciseDecimal('0'),
        targetProfitUsd: new PreciseDecimal('0'),
        medianTakeProfitR: momentumTargets[Math.min(1, momentumTargets.length - 1)],
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

    const familyScores: Array<{ family: StrategyFamily; score: number; confidence: number; bias: StrategyBias; reasons: string[]; plan: AdaptiveStrategyPlan }>
      = [
        {
          family: 'trend',
          score: scoreTrend,
          confidence: scoreTrend,
          bias: allowLongStack ? 'long' : allowShortStack ? 'short' : 'both',
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
          bias: allowLongStack ? 'long' : allowShortStack ? 'short' : 'both',
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
          bias: allowLongStack ? 'long' : allowShortStack ? 'short' : 'both',
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

    const calibrationAdjustments = this.calibrationProfile.familyScoreAdjustments;

    let weighted: StrategyScoreResult[] = familyScores.map(item => {
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
      if (item.family === 'mean_reversion' && adx >= 18) {
        effectiveScore *= 0.6;
        penaltiesApplied.push('adx_too_high');
      }
      if (item.family === 'mean_reversion' && context.alignmentScore >= 0.85 && adx >= 25) {
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
      const adjustment = calibrationAdjustments[item.family] ?? 0;
      effectiveScore = clamp(effectiveScore + adjustment, 0, 1);
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
        reasons: item.reasons,
        penalties: penaltiesApplied,
        guardrail,
        plan: item.plan,
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
      : this.chooseStrategy(input.sessionId, input.symbol, ordered);
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
    side?: StrategyBias;
  }): void {
    if (!params.sessionId || !params.token) return;
    const qty = new PreciseDecimal(params.qty ?? 0);
    const entryPrice = new PreciseDecimal(params.entryPrice ?? 0);
    const stopDistance = new PreciseDecimal(params.stopDistance ?? 0).abs();
    const planRiskUsd = params.plan.riskUsd ?? new PreciseDecimal('0');
    const computedRisk = stopDistance.times(qty);
    const riskUsd = planRiskUsd.gt(0) ? planRiskUsd : computedRisk;
    const side = params.side ?? (params.family === 'mean_reversion' ? 'both' : 'long');
    const queue = this.activeTrades.get(params.sessionId) ?? [];
    queue.push({
      token: params.token,
      family: params.family,
      id: params.id,
      riskUsd,
      atrPct: params.plan.stopAtrMult.toNumber(),
      timestamp: Date.now(),
      symbol: params.symbol,
      side,
      qty,
      entryPrice,
      planRiskPct: params.plan.riskPct,
      targetProfitUsd: params.plan.targetProfitUsd,
      medianTakeProfitR: params.plan.medianTakeProfitR,
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
    const ledgerKey = this.ledgerKey(params.sessionId, params.symbol);
    const previous = this.tradeLedgers.get(ledgerKey) ?? new PreciseDecimal('0');
    const cumulative = previous.plus(pnl);
    this.tradeLedgers.set(ledgerKey, cumulative);
    console.log(JSON.stringify({
      level: 'info',
      event: 'adaptive_trade_outcome',
      timestamp: new Date().toISOString(),
      sessionId: params.sessionId ?? null,
      symbol: params.symbol,
      token: params.token ?? null,
      side: trade.side,
      qty: trade.qty.toFixed(6),
      entryPrice: trade.entryPrice.toFixed(6),
      realizedPnlUsd: pnl.toFixed(6),
      cumulativePnlUsd: cumulative.toFixed(6),
      riskUsd: trade.riskUsd.toFixed(6),
      targetProfitUsd: trade.targetProfitUsd.toFixed(6),
    }));
    this.updateStats(params.symbol, trade.family, normalized);
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
    return {
      riskPct: finalRiskPct,
      stopAtrMult: stopMult,
      takeProfitMultiples: base.takeProfitMultiples.map(tp => tp),
      executionMode: base.executionMode,
      riskUsd,
      targetProfitUsd,
      medianTakeProfitR: median,
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
    const candidate = available[0] ?? ordered[0];
    const epsilon = candidate ? this.computeExplorationProbability(symbol, candidate) : this.epsilonBase;
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

export const metaAdaptiveStrategyAgent = MetaAdaptiveStrategyAgent.getInstance();
