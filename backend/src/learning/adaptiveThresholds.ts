/**
 * 🧠 ADAPTIVE THRESHOLD LEARNING SYSTEM
 * 
 * Learns optimal entry thresholds from actual trading performance.
 * Overrides rigid rules when historical data proves profitability.
 * 
 * KEY INSIGHT: 
 * Don't block trades based on static rules. Instead, track which conditions
 * actually produce wins and dynamically adjust thresholds.
 * 
 * EXAMPLE:
 * - Traditional: "Low volatility (0.76%) → BLOCK"
 * - Adaptive: "Low vol + high predictor confidence (90%) → historical 65% WR → ALLOW"
 */

import { prisma } from '../db/client.js';

export type MarketCondition = {
  volatilityBucket: 'very_low' | 'low' | 'medium' | 'high' | 'very_high';
  trendQuality: 'excellent' | 'good' | 'acceptable' | 'poor' | 'choppy';
  liquidityBucket: 'excellent' | 'good' | 'acceptable' | 'poor';
  compatibilityScore: number; // Raw score before adjustment
  predictorConfidence: number;
  symbol?: string;
};

export type PerformanceStats = {
  totalTrades: number;
  wins: number;
  losses: number;
  neutrals: number;
  winRate: number;
  avgPnl: number;
  avgDuration: number;
  sharpeRatio: number;
  confidence: 'low' | 'medium' | 'high'; // Based on sample size
};

export type AdaptiveThreshold = {
  condition: MarketCondition;
  performance: PerformanceStats;
  recommendedMinCompatibility: number;
  recommendedMinPredictorConf: number;
  shouldAllow: boolean;
  reasoning: string;
};

/**
 * Bucket volatility for pattern matching
 */
function bucketVolatility(atrPct: number): MarketCondition['volatilityBucket'] {
  if (atrPct < 0.5) return 'very_low';
  if (atrPct < 0.8) return 'low';
  if (atrPct < 1.5) return 'medium';
  if (atrPct < 2.5) return 'high';
  return 'very_high';
}

/**
 * Bucket liquidity for pattern matching
 */
function bucketLiquidity(volumeRatio: number, volumeUsd: number): MarketCondition['liquidityBucket'] {
  if (volumeRatio >= 1.5 && volumeUsd >= 100_000_000) return 'excellent';
  if (volumeRatio >= 1.0 && volumeUsd >= 30_000_000) return 'good';
  if (volumeRatio >= 0.8 && volumeUsd >= 10_000_000) return 'acceptable';
  return 'poor';
}

/**
 * Calculate Sharpe ratio from PnL array
 */
function calculateSharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  
  const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnl, 2), 0) / pnls.length;
  const stdDev = Math.sqrt(variance);
  
  return stdDev > 0 ? avgPnl / stdDev : 0;
}

/**
 * Get historical performance for similar market conditions
 */
export async function getHistoricalPerformance(
  condition: MarketCondition,
  lookbackDays: number = 30
): Promise<PerformanceStats | null> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  
  try {
    // Get predictor decisions with outcomes calculated
    const decisions = await prisma.predictorDecision.findMany({
      where: {
        createdAt: { gte: since },
        decision: { not: 'none' }, // Only actual trades
        // Match symbol if specified
        ...(condition.symbol ? { symbol: condition.symbol } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 500, // Limit for performance
    });
    
    if (decisions.length === 0) return null;
    
    // Calculate outcomes by looking at next decision
    const analyzed: Array<{
      confidence: number;
      outcome: 'good' | 'bad' | 'neutral';
      pnl: number;
      duration: number;
    }> = [];
    
    for (let i = 0; i < decisions.length - 1; i++) {
      const curr = decisions[i];
      const next = decisions[i + 1];
      
      const entryPrice = curr.price;
      const exitPrice = next.price;
      const priceChange = ((exitPrice - entryPrice) / entryPrice) * 100;
      const duration = Math.floor((next.createdAt.getTime() - curr.createdAt.getTime()) / 60000);
      
      // Calculate PnL based on direction
      let pnl: number;
      let outcome: 'good' | 'bad' | 'neutral';
      
      if (curr.decision === 'long') {
        pnl = priceChange;
        outcome = pnl > 0 ? 'good' : (pnl < -0.1 ? 'bad' : 'neutral');
      } else {
        pnl = -priceChange;
        outcome = pnl > 0 ? 'good' : (pnl < -0.1 ? 'bad' : 'neutral');
      }
      
      // Filter by confidence range
      const confDiff = Math.abs(curr.confidence - condition.predictorConfidence);
      if (confDiff <= 0.2) { // Within 20% confidence range
        analyzed.push({
          confidence: curr.confidence,
          outcome,
          pnl,
          duration,
        });
      }
    }
    
    if (analyzed.length < 5) return null; // Need minimum sample
    
    const totalTrades = analyzed.length;
    const wins = analyzed.filter(d => d.outcome === 'good').length;
    const losses = analyzed.filter(d => d.outcome === 'bad').length;
    const neutrals = analyzed.filter(d => d.outcome === 'neutral').length;
    
    const pnls = analyzed.map(d => d.pnl);
    const durations = analyzed.map(d => d.duration);
    
    const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const sharpeRatio = calculateSharpe(pnls);
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    
    // Confidence based on sample size
    const confidence: PerformanceStats['confidence'] = 
      totalTrades >= 30 ? 'high' :
      totalTrades >= 10 ? 'medium' : 'low';
    
    return {
      totalTrades,
      wins,
      losses,
      neutrals,
      winRate,
      avgPnl,
      avgDuration,
      sharpeRatio,
      confidence,
    };
  } catch (error) {
    console.error('[AdaptiveThresholds] Error fetching performance:', error);
    return null;
  }
}

/**
 * Calculate adaptive thresholds based on performance
 */
export function calculateAdaptiveThresholds(
  condition: MarketCondition,
  performance: PerformanceStats | null,
  baseCompatibilityThreshold: number = 0.60,
  basePredictorThreshold: number = 0.70
): AdaptiveThreshold {
  // 🚀 COLD START MODE: No historical data → LOWER thresholds to enable exploration
  // This creates an "exploration phase" where the system can gather initial data
  if (!performance || performance.totalTrades === 0) {
    const explorationCompatibility = baseCompatibilityThreshold * 0.85; // -15%
    const explorationPredictor = basePredictorThreshold * 0.90; // -10%
    
    return {
      condition,
      performance: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        neutrals: 0,
        winRate: 0,
        avgPnl: 0,
        avgDuration: 0,
        sharpeRatio: 0,
        confidence: 'low',
      },
      recommendedMinCompatibility: explorationCompatibility,
      recommendedMinPredictorConf: explorationPredictor,
      shouldAllow: condition.compatibilityScore >= explorationCompatibility &&
                   condition.predictorConfidence >= explorationPredictor,
      reasoning: `🔍 Exploration mode (no data yet) - LOWERED thresholds to ${(explorationCompatibility * 100).toFixed(0)}% compat, ${(explorationPredictor * 100).toFixed(0)}% predictor to gather initial data`,
    };
  }
  
  // 🌱 EARLY LEARNING MODE: Few trades (< 10) → Keep relaxed thresholds
  if (performance.confidence === 'low' && performance.totalTrades < 10) {
    const learningCompatibility = baseCompatibilityThreshold * 0.90; // -10%
    const learningPredictor = basePredictorThreshold * 0.95; // -5%
    
    return {
      condition,
      performance,
      recommendedMinCompatibility: learningCompatibility,
      recommendedMinPredictorConf: learningPredictor,
      shouldAllow: condition.compatibilityScore >= learningCompatibility &&
                   condition.predictorConfidence >= learningPredictor,
      reasoning: `🌱 Early learning (${performance.totalTrades} trades) - Relaxed thresholds to gather more data. WR: ${(performance.winRate * 100).toFixed(0)}%`,
    };
  }
  
  // ADAPTIVE LOGIC: Adjust thresholds based on proven performance
  let compatibilityAdjustment = 0;
  let predictorAdjustment = 0;
  let reasoning = '';
  
  // Strong performance → relax thresholds
  if (performance.winRate >= 0.60 && performance.sharpeRatio > 0.5) {
    compatibilityAdjustment = -0.15; // Allow 0.15 lower compatibility
    predictorAdjustment = -0.10; // Allow 0.10 lower predictor conf
    reasoning = `🚀 Strong performance (${(performance.winRate * 100).toFixed(0)}% WR, Sharpe ${performance.sharpeRatio.toFixed(2)}) - relaxed thresholds`;
  }
  // Good performance → moderate relaxation
  else if (performance.winRate >= 0.50 && performance.avgPnl > 0) {
    compatibilityAdjustment = -0.08;
    predictorAdjustment = -0.05;
    reasoning = `✅ Good performance (${(performance.winRate * 100).toFixed(0)}% WR) - slightly relaxed`;
  }
  // Mediocre performance → keep defaults
  else if (performance.winRate >= 0.40) {
    compatibilityAdjustment = 0;
    predictorAdjustment = 0;
    reasoning = `⚠️ Mediocre performance (${(performance.winRate * 100).toFixed(0)}% WR) - standard thresholds`;
  }
  // Poor performance → tighten thresholds
  else {
    compatibilityAdjustment = 0.10;
    predictorAdjustment = 0.10;
    reasoning = `❌ Poor performance (${(performance.winRate * 100).toFixed(0)}% WR) - tightened thresholds`;
  }
  
  // Special boost for high predictor confidence (proven edge)
  if (condition.predictorConfidence >= 0.85 && performance.winRate >= 0.55) {
    compatibilityAdjustment -= 0.10; // Extra relaxation for high-confidence trades
    reasoning += ' + high predictor confidence boost';
  }
  
  const recommendedMinCompatibility = Math.max(0.30, Math.min(0.80, 
    baseCompatibilityThreshold + compatibilityAdjustment
  ));
  
  const recommendedMinPredictorConf = Math.max(0.50, Math.min(0.90,
    basePredictorThreshold + predictorAdjustment
  ));
  
  const shouldAllow = 
    condition.compatibilityScore >= recommendedMinCompatibility &&
    condition.predictorConfidence >= recommendedMinPredictorConf;
  
  return {
    condition,
    performance,
    recommendedMinCompatibility,
    recommendedMinPredictorConf,
    shouldAllow,
    reasoning,
  };
}

/**
 * Main function: Evaluate if trade should be allowed based on adaptive learning
 */
export async function evaluateAdaptiveEntry(params: {
  symbol: string;
  compatibilityScore: number;
  predictorConfidence: number;
  atrPct: number;
  volumeRatio: number;
  volumeUsd: number;
  trendQuality: MarketCondition['trendQuality'];
  lookbackDays?: number;
}): Promise<{
  allowed: boolean;
  threshold: AdaptiveThreshold;
  override?: string;
}> {
  const condition: MarketCondition = {
    volatilityBucket: bucketVolatility(params.atrPct),
    trendQuality: params.trendQuality,
    liquidityBucket: bucketLiquidity(params.volumeRatio, params.volumeUsd),
    compatibilityScore: params.compatibilityScore,
    predictorConfidence: params.predictorConfidence,
    symbol: params.symbol,
  };
  
  // Get historical performance for this condition
  const performance = await getHistoricalPerformance(
    condition, 
    params.lookbackDays || 30
  );
  
  // Calculate adaptive thresholds
  const threshold = calculateAdaptiveThresholds(condition, performance);
  
  // Check for override scenarios
  let override: string | undefined;
  
  // Override 1: Very high predictor confidence + proven track record
  if (params.predictorConfidence >= 0.88 && 
      performance && 
      performance.winRate >= 0.60 &&
      performance.confidence !== 'low') {
    override = `🎯 High-confidence override: ${(params.predictorConfidence * 100).toFixed(0)}% predictor + ${(performance.winRate * 100).toFixed(0)}% historical WR`;
    return { allowed: true, threshold, override };
  }
  
  // Override 2: Low volatility BUT excellent predictor performance
  if (params.atrPct < 0.8 &&
      params.predictorConfidence >= 0.80 &&
      performance &&
      performance.winRate >= 0.55 &&
      performance.totalTrades >= 10) {
    override = `📊 Low-vol override: Proven ${(performance.winRate * 100).toFixed(0)}% WR in similar conditions (${performance.totalTrades} trades)`;
    return { allowed: true, threshold, override };
  }
  
  return {
    allowed: threshold.shouldAllow,
    threshold,
  };
}

/**
 * Get adaptive threshold summary for monitoring
 */
export async function getAdaptiveThresholdSummary(
  symbol: string,
  lookbackDays: number = 30
): Promise<{
  symbol: string;
  volatilityBuckets: Record<string, { trades: number; winRate: number; avgCompatibility: number }>;
  overallRecommendation: string;
}> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  
  const decisions = await prisma.predictorDecision.findMany({
    where: {
      symbol,
      createdAt: { gte: since },
      decision: { not: 'none' },
    },
    orderBy: { createdAt: 'asc' },
  });
  
  // Group by confidence buckets (proxy for conditions)
  const buckets: Record<string, { trades: number; wins: number; totalConf: number }> = {
    'high_conf': { trades: 0, wins: 0, totalConf: 0 },
    'medium_conf': { trades: 0, wins: 0, totalConf: 0 },
    'low_conf': { trades: 0, wins: 0, totalConf: 0 },
  };
  
  // Calculate outcomes
  for (let i = 0; i < decisions.length - 1; i++) {
    const curr = decisions[i];
    const next = decisions[i + 1];
    
    const bucket = curr.confidence >= 0.75 ? 'high_conf' :
                   curr.confidence >= 0.55 ? 'medium_conf' : 'low_conf';
    
    const entryPrice = curr.price;
    const exitPrice = next.price;
    const priceChange = ((exitPrice - entryPrice) / entryPrice) * 100;
    
    let pnl: number;
    if (curr.decision === 'long') {
      pnl = priceChange;
    } else {
      pnl = -priceChange;
    }
    
    buckets[bucket].trades++;
    buckets[bucket].totalConf += curr.confidence;
    if (pnl > 0) buckets[bucket].wins++;
  }
  
  const volatilityBuckets = Object.fromEntries(
    Object.entries(buckets).map(([key, data]) => [
      key,
      {
        trades: data.trades,
        winRate: data.trades > 0 ? data.wins / data.trades : 0,
        avgCompatibility: data.trades > 0 ? data.totalConf / data.trades : 0,
      },
    ])
  );
  
  // Generate recommendation
  const highConfWR = buckets.high_conf.trades >= 5 
    ? buckets.high_conf.wins / buckets.high_conf.trades 
    : 0;
  
  const overallRecommendation = 
    highConfWR >= 0.60 ? `✅ Strong edge on ${symbol} - can trade aggressively with high predictor confidence` :
    highConfWR >= 0.45 ? `⚠️ Moderate edge - be selective on ${symbol}` :
    `❌ Weak performance on ${symbol} - consider avoiding or paper trading only`;
  
  return {
    symbol,
    volatilityBuckets,
    overallRecommendation,
  };
}
