import type { TechnicalSnapshot } from '../../ai/tech.js';
import type { PerpetualMetrics, OnChainMetrics } from '../../analytics/marketContext.js';
import type { StrategyFamily } from '../strategies/metaAdaptive/strategyTypes.js';

export type RegimeDetectionInput = {
  snap: TechnicalSnapshot;
  atr15mPct: number;
  atr1h?: number | null;
  atr4h?: number | null;
  realizedVol: number;
  hurst: number;
  isMajor: boolean;
  derivatives?: PerpetualMetrics | null;
  onChain?: OnChainMetrics | null;
};

export type MarketRegimeSignal = {
  dominant: 'trending' | 'range' | 'high_vol';
  confidence: number;
  volatilityLevel: 'low' | 'medium' | 'high' | 'extreme';
  familyMultipliers: Record<StrategyFamily, number>;
  disableFamilies: StrategyFamily[];
  trendScore: number;
  rangeScore: number;
  highVolScore: number;
  notes: string[];
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function computeAtrPct(atr: number | null | undefined, last: number): number {
  if (!Number.isFinite(atr) || !Number.isFinite(last) || !last) return 0;
  return (atr! / last) * 100;
}

export function detectMarketRegime(input: RegimeDetectionInput): MarketRegimeSignal {
  const price = safeNumber((input.snap as any)?.last, 0);
  const atr15mPct = Number.isFinite(input.atr15mPct) ? Math.max(0, input.atr15mPct) : 0;
  const atr1hPct = computeAtrPct(input.atr1h ?? null, price) || atr15mPct;
  const atr4hPct = computeAtrPct(input.atr4h ?? null, price) || Math.max(atr1hPct, atr15mPct);
  const realizedVol = Number.isFinite(input.realizedVol) ? Math.max(0, input.realizedVol) : 0;
  const hurst = Number.isFinite(input.hurst) ? clamp(input.hurst, 0, 1) : 0.5;
  const adx = safeNumber((input.snap as any)?.adx14, 0);
  const ema20 = safeNumber((input.snap as any)?.ema20, price);
  const ema50 = safeNumber((input.snap as any)?.ema50, price);
  const resistance = safeNumber((input.snap as any)?.resistance, price);
  const support = safeNumber((input.snap as any)?.support, price);
  const emaSpreadPct = price > 0 ? Math.abs((ema20 - ema50) / price) * 100 : 0;
  const rangePct = price > 0 ? Math.abs(resistance - support) / price * 100 : 0;
  const rangeToAtr = atr15mPct > 0 ? rangePct / Math.max(atr15mPct, 1e-6) : 0;
  const trendStrength = safeNumber((input.snap as any)?.trendStrength, emaSpreadPct);
  const emaSlopePct = price > 0 ? Math.abs(safeNumber((input.snap as any)?.ema20Slope, 0)) / price * 100 : 0;

  const isMajor = input.isMajor;
  const trendingAdxFloor = isMajor ? 18 : 22;
  const trendingAdxCeil = isMajor ? 34 : 38;
  const emaTrendThreshold = isMajor ? 0.55 : 0.85;
  const volMediumThreshold = isMajor ? 1.1 : 1.6;
  const volHighThreshold = isMajor ? 2.3 : 3.2;
  const volExtremeThreshold = isMajor ? 3.4 : 4.6;

  const adxTrendComponent = clamp((adx - trendingAdxFloor) / Math.max(1, trendingAdxCeil - trendingAdxFloor), 0, 1);
  const emaTrendComponent = clamp((Math.max(trendStrength, emaSpreadPct, emaSlopePct) - emaTrendThreshold) / (emaTrendThreshold + 1.2), 0, 1);
  const hurstTrendComponent = clamp((hurst - 0.52) / 0.35, 0, 1);
  const momentumTrendComponent = clamp((realizedVol - 1.2) / 4, 0, 1);
  const trendScore = clamp(
    adxTrendComponent * 0.45 +
      emaTrendComponent * 0.35 +
      hurstTrendComponent * 0.15 +
      momentumTrendComponent * 0.05,
    0,
    1,
  );

  const adxRangeCeil = isMajor ? 20 : 22;
  const adxRangeFloor = isMajor ? 10 : 12;
  const adxRangeComponent = clamp((adxRangeCeil - adx) / Math.max(1, adxRangeCeil - adxRangeFloor), 0, 1);
  const rangeCompression = clamp((1.6 - rangeToAtr) / 1.6, 0, 1);
  const hurstRangeComponent = clamp((0.55 - hurst) / 0.35, 0, 1);
  const volatilityRangePenalty = clamp((atr15mPct - volMediumThreshold) / (volHighThreshold - volMediumThreshold || 1), 0, 1);
  const rangeScore = clamp(
    adxRangeComponent * 0.45 +
      rangeCompression * 0.25 +
      hurstRangeComponent * 0.2 +
      (1 - volatilityRangePenalty) * 0.1,
    0,
    1,
  );

  const atrComposite = Math.max(atr15mPct, atr1hPct, atr4hPct);
  const volatilityComponent = clamp((atrComposite - volHighThreshold) / (volExtremeThreshold - volHighThreshold || 1), 0, 1);
  const realizedComponent = clamp((realizedVol - 2.4) / 5, 0, 1);
  const rangeExpansion = clamp((rangeToAtr - 2.5) / 3, 0, 1);
  const derivativeBoost = clamp(((input.derivatives?.openInterestChangePct ?? 0) / 30), -0.2, 0.6);
  const onChainBoost = clamp(((input.onChain?.exchangeNetflowUsd ?? 0) / 50_000_000), -0.2, 0.4);
  const highVolScore = clamp(
    volatilityComponent * 0.5 +
      realizedComponent * 0.25 +
      rangeExpansion * 0.15 +
      (derivativeBoost + Math.max(0, -onChainBoost)) * 0.1,
    0,
    1,
  );

  let dominant: MarketRegimeSignal['dominant'];
  if (highVolScore >= 0.6 && highVolScore >= trendScore && highVolScore >= rangeScore) {
    dominant = 'high_vol';
  } else if (trendScore >= rangeScore) {
    dominant = 'trending';
  } else {
    dominant = 'range';
  }

  const familyMultipliers: Record<StrategyFamily, number> = {
    trend: 1,
    breakout: 1,
    mean_reversion: 1,
    momentum: 1,
  };
  const disableFamilies: StrategyFamily[] = [];

  if (dominant === 'trending') {
    familyMultipliers.trend = 1.15;
    familyMultipliers.breakout = 1.1;
    familyMultipliers.momentum = 1.08;
    familyMultipliers.mean_reversion = 0.72;
  } else if (dominant === 'range') {
    familyMultipliers.mean_reversion = 1.2;
    familyMultipliers.trend = 0.75;
    familyMultipliers.breakout = 0.85;
    familyMultipliers.momentum = 0.9;
  } else {
    familyMultipliers.breakout = 1.12;
    familyMultipliers.momentum = 1.05;
    familyMultipliers.trend = 0.82;
    familyMultipliers.mean_reversion = 0.65;
  }

  if (rangeScore > 0.55 && dominant !== 'range') {
    familyMultipliers.mean_reversion = clamp(familyMultipliers.mean_reversion * 1.05, 0.4, 1.25);
  }
  if (trendScore > 0.65 && dominant !== 'trending') {
    familyMultipliers.trend = clamp(familyMultipliers.trend * 1.05, 0.6, 1.3);
    familyMultipliers.momentum = clamp(familyMultipliers.momentum * 1.03, 0.6, 1.25);
  }

  let volatilityLevel: MarketRegimeSignal['volatilityLevel'] = 'low';
  if (atrComposite >= volExtremeThreshold || realizedVol >= 6.5) {
    volatilityLevel = 'extreme';
  } else if (atrComposite >= volHighThreshold || realizedVol >= 4.5) {
    volatilityLevel = 'high';
  } else if (atrComposite >= volMediumThreshold || realizedVol >= 2.2) {
    volatilityLevel = 'medium';
  }

  // Enhanced extreme volatility detection with tighter constraints
  if (volatilityLevel === 'extreme') {
    // Aggressively reduce exposure during extreme volatility
    familyMultipliers.mean_reversion = clamp(familyMultipliers.mean_reversion * 0.35, 0, 0.5);
    familyMultipliers.trend = clamp(familyMultipliers.trend * 0.7, 0.3, 0.9);
    familyMultipliers.breakout = clamp(familyMultipliers.breakout * 0.6, 0.3, 0.8);
    familyMultipliers.momentum = clamp(familyMultipliers.momentum * 0.65, 0.3, 0.85);
    if (!disableFamilies.includes('mean_reversion')) disableFamilies.push('mean_reversion');
    // Log extreme volatility event for monitoring
    console.warn(`⚠️ EXTREME VOLATILITY detected: ATR=${atrComposite.toFixed(2)}%, realizedVol=${realizedVol.toFixed(2)}%`);
  } else if (volatilityLevel === 'high' && dominant !== 'range') {
    familyMultipliers.mean_reversion = clamp(familyMultipliers.mean_reversion * 0.8, 0.4, 1);
  }

  const confidence = dominant === 'high_vol'
    ? clamp(highVolScore + (volatilityLevel === 'extreme' ? 0.15 : 0), 0, 1)
    : dominant === 'trending'
      ? clamp(trendScore + (hurst > 0.6 ? 0.1 : 0), 0, 1)
      : clamp(rangeScore + (hurst < 0.45 ? 0.08 : 0), 0, 1);

  const notes: string[] = [
    `trendScore=${trendScore.toFixed(2)}`,
    `rangeScore=${rangeScore.toFixed(2)}`,
    `highVolScore=${highVolScore.toFixed(2)}`,
    `volatility=${volatilityLevel}`,
  ];

  return {
    dominant,
    confidence,
    volatilityLevel,
    familyMultipliers,
    disableFamilies,
    trendScore,
    rangeScore,
    highVolScore,
    notes,
  };
}

/**
 * Quick check for extreme volatility without full regime detection
 * Used for real-time risk monitoring during position holding
 */
export function isExtremeVolatilityDetected(input: {
  atr15mPct: number;
  atr1h?: number | null;
  realizedVol?: number;
  isMajor?: boolean;
}): { extreme: boolean; level: 'low' | 'medium' | 'high' | 'extreme'; reason?: string } {
  const isMajor = input.isMajor ?? false;
  const volHighThreshold = isMajor ? 2.3 : 3.2;
  const volExtremeThreshold = isMajor ? 3.4 : 4.6;
  
  const atr15mPct = Number.isFinite(input.atr15mPct) ? Math.max(0, input.atr15mPct) : 0;
  const atr1hPct = input.atr1h != null && Number.isFinite(input.atr1h) ? input.atr1h : atr15mPct;
  const realizedVol = input.realizedVol != null && Number.isFinite(input.realizedVol) ? input.realizedVol : 0;
  
  const atrComposite = Math.max(atr15mPct, atr1hPct);
  
  let level: 'low' | 'medium' | 'high' | 'extreme' = 'low';
  let extreme = false;
  let reason: string | undefined;
  
  if (atrComposite >= volExtremeThreshold || realizedVol >= 6.5) {
    level = 'extreme';
    extreme = true;
    reason = `ATR ${atrComposite.toFixed(2)}% or realizedVol ${realizedVol.toFixed(2)}% exceeds extreme threshold`;
  } else if (atrComposite >= volHighThreshold || realizedVol >= 4.5) {
    level = 'high';
    extreme = false;
  } else if (atrComposite >= 1.1 || realizedVol >= 2.2) {
    level = 'medium';
    extreme = false;
  }
  
  return { extreme, level, reason };
}
