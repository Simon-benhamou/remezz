/**
 * 🎯 META-ADAPTIVE CRYPTO SELECTION
 * 
 * Aligns crypto selection with our meta-adaptive strategy requirements.
 * Filters cryptos that will actually WORK with our 8 detection modules.
 * 
 * PROBLEM WITH CURRENT SYSTEM:
 * - Selects cryptos based on generic "opportunity" 
 * - Doesn't consider if they'll work with our specific strategy
 * - Ignores volatility regime requirements
 * - Doesn't check if accumulation detection will work
 * - Too focused on "momentum" which often = late entry
 * 
 * OUR REQUIREMENTS:
 * 1. Enough volatility for meaningful ATR-based stops (0.8%+ ATR)
 * 2. Sufficient volume history for accumulation detection (20 periods)
 * 3. Clear trend or consolidation (not choppy/noise)
 * 4. Liquid enough for meta-adaptive execution
 * 5. Compatible with our detection modules
 */

import type { TechnicalSnapshot } from '../../../ai/tech.js';
import type { VolumeFilteredCrypto } from '../../../ai/cryptoRanking.js';

export type CryptoTier = 'tier1' | 'tier2' | 'tier3' | 'tier4';

export type StrategyCompatibility = {
  compatible: boolean;
  score: number; // 0-1: How well crypto fits our strategy
  reasons: string[];
  warnings: string[];
  tier: CryptoTier;
  volatilityFit: 'excellent' | 'good' | 'acceptable' | 'poor';
  liquidityFit: 'excellent' | 'good' | 'acceptable' | 'poor';
  trendQuality: 'excellent' | 'good' | 'acceptable' | 'poor';
  accumulationDetectable: boolean;
  estimatedWinRate: number; // 0-1: Based on conditions
};

// Crypto tiers based on liquidity and reliability
// HEAVILY FAVOR MAJORS: BTC/ETH/SOL get massive boost, tier4 gets penalty
const TIER_DEFINITIONS = {
  tier1: {
    symbols: ['BTC', 'ETH', 'SOL'],
    minVolume: 500_000_000, // $500M+
    description: 'Blue chips - highest quality',
    scoreBonus: 0.35, // INCREASED from 0.15 → 0.35 (huge advantage)
    minATR: 0.4, // Lower requirement for blue chips
  },
  tier2: {
    symbols: ['XRP', 'BNB', 'ADA', 'DOGE', 'MATIC', 'TRX', 'LTC', 'DOT', 'SHIB', 
              'AVAX', 'LINK', 'UNI', 'ATOM', 'BCH', 'XLM', 'ETC', 'ICP'],
    minVolume: 30_000_000, // $30M+
    description: 'Major established coins',
    scoreBonus: 0.20, // INCREASED from 0.08 → 0.20 (strong preference)
    minATR: 0.8,
  },
  tier3: {
    symbols: ['NEAR', 'SUI', 'APT', 'ARB', 'OP', 'AAVE', 'FET', 'HBAR', 'TAO', 
              'RENDER', 'INJ', 'SEI', 'TIA', 'WLD', 'PEPE', 'FTM', 'ALGO'],
    minVolume: 10_000_000, // $10M+
    description: 'Promising alts',
    scoreBonus: 0.05, // Slight bump from 0.03
    minATR: 1.0,
  },
  tier4: {
    symbols: [], // Everything else (PUMP, ALLO, etc.)
    minVolume: 8_000_000, // $8M+ minimum (stricter)
    description: 'Small caps - high risk',
    scoreBonus: -0.15, // PENALTY: tier4 gets negative score
    minATR: 1.5, // Higher volatility requirement
  },
};

/**
 * Determine crypto tier based on symbol and volume
 */
export function getCryptoTier(symbol: string, volumeUsd24h: number): CryptoTier {
  const base = symbol.split('/')[0];
  
  if (TIER_DEFINITIONS.tier1.symbols.includes(base)) {
    return 'tier1';
  }
  if (TIER_DEFINITIONS.tier2.symbols.includes(base)) {
    return 'tier2';
  }
  if (TIER_DEFINITIONS.tier3.symbols.includes(base)) {
    return 'tier3';
  }
  return 'tier4';
}

/**
 * 🚫 INTELLIGENT RANGE-BOUND DETECTION
 * Dynamically identifies choppy/range-bound cryptos via technical indicators
 * Based on empirical analysis: ADA/DOGE (range-bound) vs SOL/ETH/BCH (trending)
 * 
 * Detection criteria (from database analysis):
 * - Range-bound ATR: 0.46% avg, 100% under 0.6%
 * - Trending ATR: 1.09% avg, 0% under 0.6%
 * - Range-bound EMA compression: 100%
 * - Trending EMA compression: 0%
 */
function detectRangeBound(
  atrPct: number,
  ema20: number,
  ema50: number,
  ema100: number
): { isRangeBound: boolean; reason: string } {
  
  // 1. Extreme squeeze: ATR < 0.5% is definitive range-bound
  if (atrPct < 0.5) {
    return {
      isRangeBound: true,
      reason: `Extreme squeeze (ATR ${atrPct.toFixed(2)}% < 0.5%) - range-bound`
    };
  }
  
  // 2. Low ATR: ATR < 0.6% is strong indicator
  if (atrPct < 0.6) {
    return {
      isRangeBound: true,
      reason: `Low volatility (ATR ${atrPct.toFixed(2)}% < 0.6%) - likely range-bound`
    };
  }
  
  // 3. EMA compression: All EMAs within 2% = no trend structure
  const emaRange = Math.max(ema20, ema50, ema100) - Math.min(ema20, ema50, ema100);
  const emaAvg = (ema20 + ema50 + ema100) / 3;
  const emaCompressionPct = (emaRange / emaAvg) * 100;
  
  if (emaCompressionPct < 2.0 && atrPct < 0.75) {
    return {
      isRangeBound: true,
      reason: `EMA compression (${emaCompressionPct.toFixed(2)}% < 2%) + low ATR (${atrPct.toFixed(2)}%) - range-bound`
    };
  }
  
  // 4. Borderline case: ATR 0.6-0.8% with compressed EMAs
  if (atrPct < 0.8 && emaCompressionPct < 3.0) {
    return {
      isRangeBound: true,
      reason: `Borderline ATR (${atrPct.toFixed(2)}%) + EMA compression (${emaCompressionPct.toFixed(2)}%) - likely choppy`
    };
  }
  
  return {
    isRangeBound: false,
    reason: `Trending structure (ATR ${atrPct.toFixed(2)}%, EMA spread ${emaCompressionPct.toFixed(2)}%)`
  };
}

/**
 * Check if crypto has sufficient volatility for our ATR-based strategy
 */
function assessVolatilityFit(
  atrPct: number,
  tier: CryptoTier,
  realizedVol: number
): { fit: 'excellent' | 'good' | 'acceptable' | 'poor'; score: number; reason: string } {
  const tierDef = TIER_DEFINITIONS[tier];
  const minATR = tierDef.minATR;
  
  // Excellent: ATR well above minimum with good realized vol
  if (atrPct >= minATR * 1.5 && realizedVol >= 0.015) {
    return {
      fit: 'excellent',
      score: 1.0,
      reason: `High volatility (${atrPct.toFixed(2)}%) perfect for ATR-based stops`,
    };
  }
  
  // Good: ATR above minimum
  if (atrPct >= minATR * 1.2) {
    return {
      fit: 'good',
      score: 0.85,
      reason: `Good volatility (${atrPct.toFixed(2)}%) suitable for strategy`,
    };
  }
  
  // Acceptable: Meets minimum
  if (atrPct >= minATR) {
    return {
      fit: 'acceptable',
      score: 0.65,
      reason: `Acceptable volatility (${atrPct.toFixed(2)}%)`,
    };
  }
  
  // Poor: Below minimum - likely too tight for our stops
  return {
    fit: 'poor',
    score: 0.3,
    reason: `Low volatility (${atrPct.toFixed(2)}%) - stops may be too tight`,
  };
}

/**
 * Check if crypto has sufficient liquidity for our execution needs
 */
function assessLiquidityFit(
  volumeUsd24h: number,
  volumeRatio: number,
  tier: CryptoTier,
  spreadBps?: number
): { fit: 'excellent' | 'good' | 'acceptable' | 'poor'; score: number; reason: string } {
  const tierDef = TIER_DEFINITIONS[tier];
  
  // Check volume threshold for tier
  if (volumeUsd24h < tierDef.minVolume) {
    return {
      fit: 'poor',
      score: 0.2,
      reason: `Volume $${(volumeUsd24h / 1e6).toFixed(1)}M below tier minimum $${(tierDef.minVolume / 1e6).toFixed(0)}M`,
    };
  }
  
  // Check volume ratio (current volume vs average)
  if (volumeRatio < 0.5) {
    return {
      fit: 'poor',
      score: 0.25,
      reason: `Volume ratio ${volumeRatio.toFixed(2)} too low - illiquid period`,
    };
  }
  
  // Check spread if available
  if (spreadBps && spreadBps > 20) {
    return {
      fit: 'acceptable',
      score: 0.6,
      reason: `Spread ${spreadBps.toFixed(0)}bps wide but volume acceptable`,
    };
  }
  
  // Excellent: High volume, good ratio
  if (volumeRatio >= 1.0 && volumeUsd24h >= tierDef.minVolume * 2) {
    return {
      fit: 'excellent',
      score: 1.0,
      reason: `Excellent liquidity: $${(volumeUsd24h / 1e6).toFixed(0)}M volume, ${volumeRatio.toFixed(2)}x ratio`,
    };
  }
  
  // Good: Meets requirements well
  if (volumeRatio >= 0.7) {
    return {
      fit: 'good',
      score: 0.85,
      reason: `Good liquidity: ${volumeRatio.toFixed(2)}x volume ratio`,
    };
  }
  
  // Acceptable: Meets minimums
  return {
    fit: 'acceptable',
    score: 0.65,
    reason: `Acceptable liquidity: ${volumeRatio.toFixed(2)}x ratio`,
  };
}

/**
 * Check trend quality - prefer clear trends or consolidations, avoid chop
 */
function assessTrendQuality(
  adx: number,
  ema20: number,
  ema50: number,
  ema100: number,
  trendStrength: number,
  multiTimeframe?: any
): { fit: 'excellent' | 'good' | 'acceptable' | 'poor'; score: number; reason: string } {
  
  // Check multi-timeframe alignment
  const tf4h = multiTimeframe?.timeframes?.['4h']?.bias;
  const tf1h = multiTimeframe?.timeframes?.['1h']?.bias;
  const tf15m = multiTimeframe?.timeframes?.['15m']?.bias;
  
  // Conflict = choppy = bad for our strategy
  const hasConflict = (
    (tf4h === 'bullish' && tf1h === 'bearish') ||
    (tf4h === 'bearish' && tf1h === 'bullish') ||
    (tf1h === 'bullish' && tf15m === 'bearish') ||
    (tf1h === 'bearish' && tf15m === 'bullish')
  );
  
  if (hasConflict) {
    return {
      fit: 'poor',
      score: 0.3,
      reason: `Multi-timeframe conflict (4h:${tf4h}, 1h:${tf1h}) - choppy market`,
    };
  }
  
  // Excellent: Strong trend with alignment
  if (adx >= 25 && Math.abs(trendStrength) >= 0.7 && tf4h === tf1h) {
    const emaAligned = (ema20 > ema50 && ema50 > ema100) || (ema20 < ema50 && ema50 < ema100);
    if (emaAligned) {
      return {
        fit: 'excellent',
        score: 1.0,
        reason: `Strong trend (ADX ${adx.toFixed(0)}, ${tf4h}) with HTF alignment`,
      };
    }
  }
  
  // Good: Clear direction
  if (adx >= 18 && (tf4h !== 'neutral' || tf1h !== 'neutral')) {
    return {
      fit: 'good',
      score: 0.85,
      reason: `Clear direction (ADX ${adx.toFixed(0)}, bias: ${tf4h || tf1h})`,
    };
  }
  
  // Acceptable: Consolidation (good for breakout strategy)
  if (adx < 18 && Math.abs(trendStrength) < 0.3) {
    const priceRange = Math.abs(ema20 - ema50) / ema50;
    if (priceRange < 0.02) {
      return {
        fit: 'good',
        score: 0.8,
        reason: `Tight consolidation (ADX ${adx.toFixed(0)}) - breakout setup`,
      };
    }
  }
  
  // Acceptable: Some structure
  if (adx >= 12) {
    return {
      fit: 'acceptable',
      score: 0.65,
      reason: `Moderate structure (ADX ${adx.toFixed(0)})`,
    };
  }
  
  // Poor: No structure
  return {
    fit: 'poor',
    score: 0.35,
    reason: `Weak structure (ADX ${adx.toFixed(0)}) - choppy`,
  };
}

/**
 * Check if crypto will work with our accumulation detection
 */
function canDetectAccumulation(
  volumeHistory: number, // How many periods of volume data available
  volumeRatio: number,
  volumeZScore?: number
): { detectable: boolean; confidence: number; reason: string } {
  
  // Need at least 10 periods for pattern detection, 20 is ideal
  if (volumeHistory < 10) {
    return {
      detectable: false,
      confidence: 0,
      reason: `Insufficient volume history (${volumeHistory} periods, need 10+)`,
    };
  }
  
  // Check if volume is active enough to show patterns
  if (volumeRatio < 0.4) {
    return {
      detectable: false,
      confidence: 0.2,
      reason: `Volume too low (${volumeRatio.toFixed(2)}x) - patterns unlikely`,
    };
  }
  
  // Excellent: Full history with good volume variation
  if (volumeHistory >= 20 && volumeZScore !== undefined && Math.abs(volumeZScore) >= 0.3) {
    return {
      detectable: true,
      confidence: 1.0,
      reason: `Full volume history (${volumeHistory}p) with variation (Z:${volumeZScore.toFixed(2)})`,
    };
  }
  
  // Good: Sufficient history
  if (volumeHistory >= 15) {
    return {
      detectable: true,
      confidence: 0.85,
      reason: `Good volume history (${volumeHistory} periods)`,
    };
  }
  
  // Acceptable: Minimum history
  return {
    detectable: true,
    confidence: 0.65,
    reason: `Acceptable volume history (${volumeHistory} periods)`,
  };
}

/**
 * Estimate win rate based on conditions
 */
function estimateWinRate(
  tier: CryptoTier,
  volatilityFit: string,
  liquidityFit: string,
  trendQuality: string,
  accumulationDetectable: boolean
): number {
  // Base win rate by tier
  let baseWR = tier === 'tier1' ? 0.55 : tier === 'tier2' ? 0.50 : tier === 'tier3' ? 0.45 : 0.40;
  
  // Adjust for volatility
  if (volatilityFit === 'excellent') baseWR += 0.08;
  else if (volatilityFit === 'good') baseWR += 0.05;
  else if (volatilityFit === 'poor') baseWR -= 0.10;
  
  // Adjust for liquidity
  if (liquidityFit === 'excellent') baseWR += 0.05;
  else if (liquidityFit === 'poor') baseWR -= 0.08;
  
  // Adjust for trend quality
  if (trendQuality === 'excellent') baseWR += 0.10;
  else if (trendQuality === 'good') baseWR += 0.05;
  else if (trendQuality === 'poor') baseWR -= 0.12;
  
  // Accumulation detection is a big edge
  if (accumulationDetectable) baseWR += 0.07;
  
  return Math.max(0.25, Math.min(0.85, baseWR));
}

/**
 * Main function: Evaluate crypto compatibility with our meta-adaptive strategy
 */
export function evaluateStrategyCompatibility(
  crypto: VolumeFilteredCrypto,
  snap: TechnicalSnapshot
): StrategyCompatibility {
  
  const tier = getCryptoTier(crypto.symbol, crypto.volumeUsd24h);
  const reasons: string[] = [];
  const warnings: string[] = [];
  
  // 🚫 INTELLIGENT RANGE-BOUND DETECTION
  const atrPct = Number(snap.atrPct || 0);
  const ema20 = Number(snap.ema20 || 0);
  const ema50 = Number(snap.ema50 || 0);
  const ema100 = Number(snap.ema100 || 0);
  
  const rangeBoundCheck = detectRangeBound(atrPct, ema20, ema50, ema100);
  if (rangeBoundCheck.isRangeBound) {
    return {
      compatible: false,
      score: 0,
      reasons: [`🚫 ${rangeBoundCheck.reason}`],
      warnings: ['Range-bound cryptos fail HTF alignment and have 100% block rate in trend-following strategy. Use mean reversion instead.'],
      tier,
      volatilityFit: 'poor',
      liquidityFit: 'poor',
      trendQuality: 'poor',
      accumulationDetectable: false,
      estimatedWinRate: 0,
    };
  }
  
  // 1. Assess volatility fit
  const realizedVol = Number((snap as any).realizedVol || 0);
  const volatility = assessVolatilityFit(atrPct, tier, realizedVol);
  reasons.push(volatility.reason);
  
  // 2. Assess liquidity fit
  const volumeRatio = Number((snap as any).volumeRatio || 1);
  const spreadBps = Number((snap as any).spreadBps);
  const liquidity = assessLiquidityFit(crypto.volumeUsd24h, volumeRatio, tier, spreadBps);
  reasons.push(liquidity.reason);
  
  // 3. Assess trend quality
  const adx = Number(snap.adx14 || 0);
  const trendStrength = Number((snap as any).trendStrength || 0);
  const trend = assessTrendQuality(adx, ema20, ema50, ema100, trendStrength, (snap as any).multiTimeframe);
  reasons.push(trend.reason);
  
  // 4. Check accumulation detection viability
  const volumeHistory = 20; // Assume we have full history if snapshot exists
  const volumeZScore = Number((snap as any).volumeZScore);
  const accumulation = canDetectAccumulation(volumeHistory, volumeRatio, volumeZScore);
  if (accumulation.detectable) {
    reasons.push(accumulation.reason);
  } else {
    warnings.push(accumulation.reason);
  }
  
  // 5. Add tier bonus
  const tierDef = TIER_DEFINITIONS[tier];
  reasons.push(`${tierDef.description} (Tier ${tier.slice(-1)})`);
  
  // Calculate composite score
  let score = 0;
  score += volatility.score * 0.30; // 30% weight
  score += liquidity.score * 0.25;  // 25% weight
  score += trend.score * 0.30;      // 30% weight
  score += (accumulation.detectable ? accumulation.confidence * 0.15 : 0); // 15% weight
  score += tierDef.scoreBonus;      // Tier bonus
  
  // Compatibility threshold
  const compatible = score >= 0.50;
  
  // Estimate win rate
  const estimatedWR = estimateWinRate(
    tier,
    volatility.fit,
    liquidity.fit,
    trend.fit,
    accumulation.detectable
  );
  
  // Add warnings for poor fits
  if (volatility.fit === 'poor') {
    warnings.push('Volatility may be too low for ATR-based stops');
  }
  if (liquidity.fit === 'poor') {
    warnings.push('Liquidity concerns - execution may be difficult');
  }
  if (trend.fit === 'poor') {
    warnings.push('Choppy market - our strategy performs poorly here');
  }
  
  return {
    compatible,
    score: Number(score.toFixed(3)),
    reasons,
    warnings,
    tier,
    volatilityFit: volatility.fit,
    liquidityFit: liquidity.fit,
    trendQuality: trend.fit,
    accumulationDetectable: accumulation.detectable,
    estimatedWinRate: Number(estimatedWR.toFixed(3)),
  };
}

/**
 * Filter and rank cryptos by strategy compatibility
 */
export function filterByStrategyCompatibility(
  cryptos: Array<{ crypto: VolumeFilteredCrypto; snap: TechnicalSnapshot }>
): Array<{ crypto: VolumeFilteredCrypto; snap: TechnicalSnapshot; compatibility: StrategyCompatibility }> {
  
  const evaluated = cryptos.map(({ crypto, snap }) => ({
    crypto,
    snap,
    compatibility: evaluateStrategyCompatibility(crypto, snap),
  }));
  
  // Sort by compatibility score (descending)
  evaluated.sort((a, b) => b.compatibility.score - a.compatibility.score);
  
  // Log top candidates
  console.log('🎯 Top 10 Strategy-Compatible Cryptos:');
  evaluated.slice(0, 10).forEach((item, i) => {
    const c = item.compatibility;
    console.log(`   ${i + 1}. ${item.crypto.symbol}:`);
    console.log(`      Score: ${c.score.toFixed(2)} | Est. WR: ${(c.estimatedWinRate * 100).toFixed(0)}% | Tier: ${c.tier}`);
    console.log(`      Vol: ${c.volatilityFit} | Liq: ${c.liquidityFit} | Trend: ${c.trendQuality}`);
    console.log(`      ${c.reasons[0]}`);
    if (c.warnings.length > 0) {
      console.log(`      ⚠️ ${c.warnings[0]}`);
    }
  });
  
  return evaluated;
}
