/**
 * 🎯 ACCUMULATION / DISTRIBUTION DETECTION
 * 
 * Detects PROGRESSIVE volume changes that precede price movements.
 * Unlike simple volumeRatio (instant), this tracks TRENDS in volume behavior.
 * 
 * KEY INSIGHT: Smart money accumulates/distributes BEFORE retail notices.
 * - Accumulation: Volume increases while price consolidates → Bullish setup
 * - Distribution: Volume increases while price weakens → Bearish setup
 * 
 * DETECTION PATTERNS:
 * 1. Volume Acceleration: Volume growing over multiple periods
 * 2. Silent Accumulation: Volume + no price move = someone buying quietly
 * 3. Distribution Phase: Volume + price weakness = smart money exiting
 * 4. Pre-Breakout Setup: Volume + compression = coiled spring
 */

import type { TechnicalSnapshot } from '../../../ai/tech.js';

export type AccumulationPhase = 
  | 'accumulation'      // Volume ↑, Price flat/up slowly → Bullish setup
  | 'distribution'      // Volume ↑, Price flat/down slowly → Bearish setup
  | 'markup'            // Volume ↑, Price ↑ fast → Trend confirmed
  | 'markdown'          // Volume ↑, Price ↓ fast → Dump confirmed
  | 'none';             // No clear pattern

export type AccumulationSignal = {
  phase: AccumulationPhase;
  confidence: number;          // 0-1: How confident are we in this phase?
  volumeTrend: number;         // -1 to 1: Volume trend over last N periods
  volumeAcceleration: number;  // Rate of volume change (2nd derivative)
  priceVolumeDivergence: number; // Divergence between price and volume
  silentAccumulation: boolean; // Volume up but price flat (smart money)
  breakoutLikelihood: number;  // 0-1: Probability of imminent breakout
  shouldBoost: boolean;        // Boost entry confidence if true
  shouldWait: boolean;         // Wait for confirmation if true
  penalty: number;             // 0.5-1.5: Score multiplier
  reason: string;
  details: {
    volumeGrowthRate: number;      // % growth per period
    priceStability: number;         // How stable is price during volume change
    consecutiveVolumeIncrease: number; // Number of periods with increasing volume
    avgVolumeRatio: number;         // Average volume vs MA over detection window
  };
  timestamp: number;
};

interface VolumeDataPoint {
  timestamp: number;
  volume: number;
  price: number;
  volumeRatio: number;
}

// Cache volume history per symbol
const volumeHistory = new Map<string, VolumeDataPoint[]>();
const HISTORY_LENGTH = 20; // Track last 20 periods (20 * 15m = 5 hours)
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Update volume history for a symbol
 */
function updateVolumeHistory(symbol: string, snap: TechnicalSnapshot): VolumeDataPoint[] {
  const now = Date.now();
  const volume = Number((snap as any)?.volume ?? 0);
  const volumeRatio = Number((snap as any)?.volumeRatio ?? 1);
  const price = Number(snap.last ?? 0);
  
  if (!volumeHistory.has(symbol)) {
    volumeHistory.set(symbol, []);
  }
  
  const history = volumeHistory.get(symbol)!;
  
  // Add new data point
  history.push({
    timestamp: now,
    volume,
    price,
    volumeRatio,
  });
  
  // Remove old data (keep only last HISTORY_LENGTH periods)
  while (history.length > HISTORY_LENGTH) {
    history.shift();
  }
  
  // Clean expired data (older than 6 hours)
  const expiry = now - 6 * 60 * 60 * 1000;
  while (history.length > 0 && history[0].timestamp < expiry) {
    history.shift();
  }
  
  return history;
}

/**
 * Calculate volume trend (linear regression slope)
 */
function calculateVolumeTrend(history: VolumeDataPoint[]): number {
  if (history.length < 3) return 0;
  
  const n = history.length;
  const x = Array.from({ length: n }, (_, i) => i);
  const y = history.map(d => d.volumeRatio);
  
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  
  // Normalize to -1 to 1 range
  return Math.max(-1, Math.min(1, slope * 5));
}

/**
 * Calculate volume acceleration (change in trend)
 */
function calculateVolumeAcceleration(history: VolumeDataPoint[]): number {
  if (history.length < 6) return 0;
  
  // Compare recent trend vs earlier trend
  const recent = history.slice(-6);
  const earlier = history.slice(-12, -6);
  
  const recentTrend = calculateVolumeTrend(recent);
  const earlierTrend = calculateVolumeTrend(earlier);
  
  // Acceleration = change in trend
  return recentTrend - earlierTrend;
}

/**
 * Detect price-volume divergence
 */
function calculatePriceVolumeDivergence(history: VolumeDataPoint[]): number {
  if (history.length < 5) return 0;
  
  const recent = history.slice(-5);
  
  // Calculate price trend
  const priceChange = (recent[recent.length - 1].price - recent[0].price) / recent[0].price;
  
  // Calculate volume trend
  const volumeChange = (recent[recent.length - 1].volumeRatio - recent[0].volumeRatio) / Math.max(0.1, recent[0].volumeRatio);
  
  // Divergence: Volume up but price flat/down (or vice versa)
  // Positive divergence: Volume ↑, Price flat → Accumulation
  // Negative divergence: Volume ↑, Price ↓ → Distribution
  
  if (volumeChange > 0.2) {
    if (Math.abs(priceChange) < 0.01) {
      // Silent accumulation: Volume up, price stable
      return 0.8;
    } else if (priceChange < -0.02) {
      // Distribution: Volume up, price down
      return -0.8;
    } else if (priceChange > 0.02) {
      // Markup: Volume up, price up (confirmation)
      return 0.3;
    }
  }
  
  return 0;
}

/**
 * Count consecutive periods with increasing volume
 */
function countConsecutiveVolumeIncrease(history: VolumeDataPoint[]): number {
  if (history.length < 2) return 0;
  
  let count = 0;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].volumeRatio > history[i - 1].volumeRatio) {
      count++;
    } else {
      break;
    }
  }
  
  return count;
}

/**
 * Calculate price stability (low volatility = consolidation)
 */
function calculatePriceStability(history: VolumeDataPoint[]): number {
  if (history.length < 3) return 0;
  
  const prices = history.map(d => d.price);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = avgPrice > 0 ? stdDev / avgPrice : 0;
  
  // Return stability score (1 = very stable, 0 = very volatile)
  return Math.max(0, 1 - coefficientOfVariation * 100);
}

/**
 * Detect accumulation/distribution phase
 */
function detectPhase(
  volumeTrend: number,
  priceVolumeDivergence: number,
  consecutiveIncrease: number,
  priceStability: number
): { phase: AccumulationPhase; confidence: number; breakoutLikelihood: number } {
  
  // ACCUMULATION: Volume ↑, Price flat
  if (volumeTrend > 0.3 && priceVolumeDivergence > 0.5 && priceStability > 0.6) {
    return {
      phase: 'accumulation',
      confidence: Math.min(0.95, 0.6 + consecutiveIncrease * 0.05 + priceStability * 0.2),
      breakoutLikelihood: Math.min(0.9, consecutiveIncrease * 0.1 + volumeTrend * 0.4),
    };
  }
  
  // DISTRIBUTION: Volume ↑, Price weak/down
  if (volumeTrend > 0.3 && priceVolumeDivergence < -0.5) {
    return {
      phase: 'distribution',
      confidence: Math.min(0.9, 0.5 + consecutiveIncrease * 0.05),
      breakoutLikelihood: 0.3, // Less reliable for shorts
    };
  }
  
  // MARKUP: Volume ↑, Price ↑ (trend confirmed)
  if (volumeTrend > 0.4 && priceVolumeDivergence > -0.2 && priceVolumeDivergence < 0.5) {
    return {
      phase: 'markup',
      confidence: 0.7,
      breakoutLikelihood: 0.5, // Already moving
    };
  }
  
  // MARKDOWN: Volume ↑, Price ↓ fast (dump confirmed)
  if (volumeTrend > 0.3 && priceVolumeDivergence < -0.7) {
    return {
      phase: 'markdown',
      confidence: 0.6,
      breakoutLikelihood: 0.2,
    };
  }
  
  // SILENT ACCUMULATION: Volume gradually increasing, price very stable
  if (volumeTrend > 0.15 && volumeTrend < 0.4 && priceStability > 0.75 && consecutiveIncrease >= 3) {
    return {
      phase: 'accumulation',
      confidence: 0.65,
      breakoutLikelihood: 0.75, // High probability but needs confirmation
    };
  }
  
  return {
    phase: 'none',
    confidence: 0,
    breakoutLikelihood: 0,
  };
}

/**
 * Calculate entry strategy based on accumulation phase
 */
function calculateEntryStrategy(
  phase: AccumulationPhase,
  confidence: number,
  breakoutLikelihood: number,
  consecutiveIncrease: number
): { shouldBoost: boolean; shouldWait: boolean; penalty: number; reason: string } {
  
  switch (phase) {
    case 'accumulation':
      if (confidence > 0.7 && consecutiveIncrease >= 4) {
        // Strong accumulation → BOOST entries
        return {
          shouldBoost: true,
          shouldWait: false,
          penalty: 1.3, // 30% boost
          reason: `Strong accumulation detected (${consecutiveIncrease} periods, conf: ${confidence.toFixed(2)})`,
        };
      } else if (confidence > 0.5) {
        // Moderate accumulation → Small boost
        return {
          shouldBoost: true,
          shouldWait: false,
          penalty: 1.15, // 15% boost
          reason: `Accumulation phase (conf: ${confidence.toFixed(2)})`,
        };
      }
      break;
      
    case 'distribution':
      if (confidence > 0.6) {
        // Distribution → BLOCK longs, penalize heavily
        return {
          shouldBoost: false,
          shouldWait: true,
          penalty: 0.5, // 50% penalty
          reason: `Distribution detected - smart money exiting (conf: ${confidence.toFixed(2)})`,
        };
      }
      break;
      
    case 'markup':
      // Already in markup → Slight boost but be cautious (late entry)
      return {
        shouldBoost: true,
        shouldWait: false,
        penalty: 1.1, // 10% boost
        reason: 'Markup phase - trend confirmed but potentially late',
      };
      
    case 'markdown':
      // Markdown → BLOCK longs completely
      return {
        shouldBoost: false,
        shouldWait: true,
        penalty: 0.3, // 70% penalty
        reason: 'Markdown detected - avoid longs',
      };
  }
  
  // No clear pattern
  return {
    shouldBoost: false,
    shouldWait: false,
    penalty: 1.0,
    reason: 'No accumulation/distribution pattern detected',
  };
}

/**
 * Main detection function: Detect accumulation/distribution patterns
 * 
 * @param symbol - Trading symbol
 * @param snap - Technical snapshot
 * @returns AccumulationSignal with phase, confidence, and entry strategy
 */
export function detectAccumulationPattern(
  symbol: string,
  snap: TechnicalSnapshot
): AccumulationSignal {
  const now = Date.now();
  
  // Update history
  const history = updateVolumeHistory(symbol, snap);
  
  // Need at least 5 periods to detect patterns
  if (history.length < 5) {
    return {
      phase: 'none',
      confidence: 0,
      volumeTrend: 0,
      volumeAcceleration: 0,
      priceVolumeDivergence: 0,
      silentAccumulation: false,
      breakoutLikelihood: 0,
      shouldBoost: false,
      shouldWait: false,
      penalty: 1.0,
      reason: 'Insufficient volume history',
      details: {
        volumeGrowthRate: 0,
        priceStability: 0,
        consecutiveVolumeIncrease: 0,
        avgVolumeRatio: 1,
      },
      timestamp: now,
    };
  }
  
  // Calculate metrics
  const volumeTrend = calculateVolumeTrend(history);
  const volumeAcceleration = calculateVolumeAcceleration(history);
  const priceVolumeDivergence = calculatePriceVolumeDivergence(history);
  const consecutiveIncrease = countConsecutiveVolumeIncrease(history);
  const priceStability = calculatePriceStability(history);
  
  // Calculate average volume ratio
  const avgVolumeRatio = history.reduce((sum, d) => sum + d.volumeRatio, 0) / history.length;
  
  // Calculate volume growth rate
  const firstVolume = history[0].volumeRatio;
  const lastVolume = history[history.length - 1].volumeRatio;
  const periods = history.length;
  const volumeGrowthRate = firstVolume > 0 
    ? ((lastVolume - firstVolume) / firstVolume) / periods * 100 
    : 0;
  
  // Detect phase
  const { phase, confidence, breakoutLikelihood } = detectPhase(
    volumeTrend,
    priceVolumeDivergence,
    consecutiveIncrease,
    priceStability
  );
  
  // Silent accumulation: Volume increasing gradually with high price stability
  const silentAccumulation = 
    volumeTrend > 0.2 && 
    priceStability > 0.7 && 
    consecutiveIncrease >= 3 &&
    Math.abs(priceVolumeDivergence) > 0.5;
  
  // Calculate entry strategy
  const { shouldBoost, shouldWait, penalty, reason } = calculateEntryStrategy(
    phase,
    confidence,
    breakoutLikelihood,
    consecutiveIncrease
  );
  
  return {
    phase,
    confidence,
    volumeTrend,
    volumeAcceleration,
    priceVolumeDivergence,
    silentAccumulation,
    breakoutLikelihood,
    shouldBoost,
    shouldWait,
    penalty,
    reason,
    details: {
      volumeGrowthRate,
      priceStability,
      consecutiveVolumeIncrease: consecutiveIncrease,
      avgVolumeRatio,
    },
    timestamp: now,
  };
}

/**
 * Get accumulation signal for a specific bias
 * Returns appropriate boost/penalty based on phase and trade direction
 */
export function getAccumulationSignalForBias(
  symbol: string,
  snap: TechnicalSnapshot,
  bias: 'long' | 'short'
): { shouldBoost: boolean; penalty: number; reason: string; phase: AccumulationPhase } {
  const signal = detectAccumulationPattern(symbol, snap);
  
  if (bias === 'long') {
    // For longs: Accumulation is good, Distribution is bad
    if (signal.phase === 'accumulation') {
      return {
        shouldBoost: signal.shouldBoost,
        penalty: signal.penalty,
        reason: signal.reason,
        phase: signal.phase,
      };
    } else if (signal.phase === 'distribution' || signal.phase === 'markdown') {
      return {
        shouldBoost: false,
        penalty: signal.penalty,
        reason: signal.reason,
        phase: signal.phase,
      };
    }
  } else {
    // For shorts: Distribution is good, Accumulation is bad
    if (signal.phase === 'distribution' || signal.phase === 'markdown') {
      return {
        shouldBoost: true,
        penalty: Math.min(1.3, 2 - signal.penalty), // Invert penalty for shorts
        reason: `Distribution favors shorts: ${signal.reason}`,
        phase: signal.phase,
      };
    } else if (signal.phase === 'accumulation' || signal.phase === 'markup') {
      return {
        shouldBoost: false,
        penalty: 0.7, // Penalize shorts during accumulation
        reason: `Accumulation detected - avoid shorts`,
        phase: signal.phase,
      };
    }
  }
  
  // No clear pattern or markup phase
  return {
    shouldBoost: false,
    penalty: 1.0,
    reason: signal.reason,
    phase: signal.phase,
  };
}

/**
 * Clear volume history (useful for testing)
 */
export function clearVolumeHistory(symbol?: string): void {
  if (symbol) {
    volumeHistory.delete(symbol);
  } else {
    volumeHistory.clear();
  }
}
