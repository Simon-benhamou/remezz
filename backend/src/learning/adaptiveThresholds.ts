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
 * NOW USING: TradeEvaluation (strategy decisions) instead of PredictorDecision
 * This tracks ACTUAL trades placed, not just predictor signals
 * 
 * ALSO: Checks recent blockages to detect if system is stuck
 */
export async function getHistoricalPerformance(
  condition: MarketCondition,
  lookbackDays: number = 30
): Promise<PerformanceStats | null> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  
  try {
    // Get ACTUAL strategy decisions (trades placed)
    const trades = await prisma.tradeEvaluation.findMany({
      where: {
        timestamp: { gte: since },
        decision: 'order_placed', // Only actual placed orders
        // Match symbol if specified
        ...(condition.symbol ? { symbol: condition.symbol } : {}),
      },
      orderBy: { timestamp: 'asc' },
      take: 500, // Limit for performance
    });
    
    // 🚨 REACTIVE BLOCKAGE DETECTION: Check recent blocks
    const recentBlockages = await prisma.tradeEvaluation.findMany({
      where: {
        timestamp: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // Last 2 hours
        decision: { in: ['filter_blocked', 'order_blocked_capital'] },
        ...(condition.symbol ? { symbol: condition.symbol } : {}),
      },
    });
    
    const blockedCount = recentBlockages.length;
    
    // If NO trades but MANY blocks → we're stuck, return special signal
    if (trades.length === 0 && blockedCount > 5) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        neutrals: 0,
        winRate: 0,
        avgPnl: 0,
        avgDuration: 0,
        sharpeRatio: 0,
        confidence: 'low',
        // @ts-ignore - Add custom flag
        isStuck: true,
        blockedCount,
      } as PerformanceStats;
    }
    
    if (trades.length === 0) return null;
    
    // Calculate outcomes from marketOutcome data
    const analyzed: Array<{
      confidence: number;
      outcome: 'good' | 'bad' | 'neutral';
      pnl: number;
      duration: number;
    }> = [];
    
    for (const trade of trades) {
      const outcome = trade.marketOutcome as any;
      if (!outcome) continue; // Skip trades without outcome data
      
      // Extract PnL from marketOutcome
      const pnl1h = outcome.pnl_1h || outcome.pnl_15m || 0;
      const confidence = trade.confidenceScore;
      
      // Determine outcome quality
      let outcomeType: 'good' | 'bad' | 'neutral';
      if (pnl1h > 0.3) outcomeType = 'good'; // > 0.3% profit
      else if (pnl1h < -0.3) outcomeType = 'bad'; // > 0.3% loss
      else outcomeType = 'neutral';
      
      // Filter by confidence range (±20%)
      const confDiff = Math.abs(confidence - condition.predictorConfidence);
      if (confDiff <= 0.2) {
        analyzed.push({
          confidence,
          outcome: outcomeType,
          pnl: pnl1h,
          duration: 60, // Approximate 1h
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
 * 🎯 WIN-FIRST ADAPTIVE LEARNING
 * 
 * Philosophy: Only trade when there's PROVEN edge, not just to "get data"
 * - Cold start: Use conservative defaults, wait for quality setups
 * - Historical wins: Relax thresholds to capture more profitable opportunities
 * - Historical losses: Tighten thresholds to protect capital
 * - Blockages: DON'T blindly lower - check if predictor is reliable first
 */
export function calculateAdaptiveThresholds(
  condition: MarketCondition,
  performance: PerformanceStats | null,
  baseCompatibilityThreshold: number = 0.60,
  basePredictorThreshold: number = 0.70
): AdaptiveThreshold {
  
  // 🔍 COLD START: No historical trades yet
  if (!performance || performance.totalTrades === 0) {
    // @ts-ignore - Check custom flag
    const isStuck = performance?.isStuck;
    // @ts-ignore
    const blockedCount = performance?.blockedCount || 0;
    
    // 🚫 BLOCKED + NO DATA = Market probably bad, DON'T force trades
    if (isStuck && blockedCount > 5) {
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
        recommendedMinCompatibility: baseCompatibilityThreshold,
        recommendedMinPredictorConf: basePredictorThreshold,
        shouldAllow: false, // Block everything until proven edge
        reasoning: `🚫 NO PROVEN EDGE (${blockedCount} blocks, 0 historical wins) - Waiting for quality setup. Market conditions unfavorable.`,
      };
    }
    
    // Normal cold start: Conservative defaults, wait for HIGH confidence signals
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
      recommendedMinCompatibility: baseCompatibilityThreshold,
      recommendedMinPredictorConf: basePredictorThreshold,
      shouldAllow: condition.compatibilityScore >= baseCompatibilityThreshold &&
                   condition.predictorConfidence >= basePredictorThreshold,
      reasoning: `🔍 Cold start - Using conservative defaults (${(baseCompatibilityThreshold * 100).toFixed(0)}% compat, ${(basePredictorThreshold * 100).toFixed(0)}% predictor). Will trade only high-confidence setups.`,
    };
  }
  
  // 🌱 EARLY LEARNING: Few trades (1-9) - Check if they're WINNING
  if (performance.totalTrades < 10) {
    // 🎯 WIN-FIRST CHECK: Are early trades profitable?
    const isProfitable = performance.winRate >= 0.55 && performance.avgPnl > 0;
    
    if (isProfitable) {
      // ✅ Good start → Relax thresholds to capture more opportunities
      const learningCompatibility = baseCompatibilityThreshold * 0.85; // -15%
      const learningPredictor = basePredictorThreshold * 0.90; // -10%
      
      return {
        condition,
        performance,
        recommendedMinCompatibility: learningCompatibility,
        recommendedMinPredictorConf: learningPredictor,
        shouldAllow: condition.compatibilityScore >= learningCompatibility &&
                     condition.predictorConfidence >= learningPredictor,
        reasoning: `✅ Early wins detected (${performance.totalTrades} trades, ${(performance.winRate * 100).toFixed(0)}% WR, avg PnL: ${performance.avgPnl.toFixed(2)}%) - Relaxing thresholds to capture more profitable setups`,
      };
    } else {
      // ❌ Poor start → TIGHTEN thresholds, be more selective
      const cautiousCompatibility = baseCompatibilityThreshold * 1.05; // +5% stricter
      const cautiousPredictor = basePredictorThreshold * 1.05; // +5% stricter
      
      return {
        condition,
        performance,
        recommendedMinCompatibility: cautiousCompatibility,
        recommendedMinPredictorConf: cautiousPredictor,
        shouldAllow: condition.compatibilityScore >= cautiousCompatibility &&
                     condition.predictorConfidence >= cautiousPredictor,
        reasoning: `⚠️ Poor early results (${performance.totalTrades} trades, ${(performance.winRate * 100).toFixed(0)}% WR) - TIGHTENING thresholds to ${(cautiousCompatibility * 100).toFixed(0)}% compat, ${(cautiousPredictor * 100).toFixed(0)}% predictor for quality`,
      };
    }
  }
  
  // 🎯 ADAPTIVE MODE: 10+ trades - Adjust based on PROVEN performance
  let compatibilityAdjustment = 0;
  let predictorAdjustment = 0;
  let reasoning = '';
  
  // 🏆 EXCELLENT PERFORMANCE (60%+ WR, positive Sharpe) → Relax thresholds
  if (performance.winRate >= 0.60 && performance.sharpeRatio > 0.5 && performance.avgPnl > 0.5) {
    compatibilityAdjustment = -0.15; // -15% allows more trades
    predictorAdjustment = -0.10; // -10% 
    reasoning = `🏆 PROVEN EDGE (${performance.totalTrades} trades, ${(performance.winRate * 100).toFixed(0)}% WR, +${performance.avgPnl.toFixed(2)}% avg PnL, Sharpe ${performance.sharpeRatio.toFixed(2)}) - Capturing more profitable setups`;
  }
  // ✅ GOOD PERFORMANCE (50-60% WR, positive PnL) → Slight relaxation
  else if (performance.winRate >= 0.50 && performance.avgPnl > 0.3) {
    compatibilityAdjustment = -0.08;
    predictorAdjustment = -0.05;
    reasoning = `✅ Profitable track record (${(performance.winRate * 100).toFixed(0)}% WR, +${performance.avgPnl.toFixed(2)}% avg) - Slightly relaxed`;
  }
  // ⚠️ BREAKEVEN (40-50% WR) → Keep strict standards
  else if (performance.winRate >= 0.40 && performance.avgPnl >= -0.1) {
    compatibilityAdjustment = 0;
    predictorAdjustment = 0;
    reasoning = `⚠️ Breakeven performance (${(performance.winRate * 100).toFixed(0)}% WR) - Maintaining strict thresholds`;
  }
  // ❌ LOSING (< 40% WR or negative PnL) → TIGHTEN significantly
  else {
    compatibilityAdjustment = 0.15; // +15% STRICTER
    predictorAdjustment = 0.15; // +15% STRICTER
    reasoning = `❌ LOSING TRADES (${performance.totalTrades} trades, ${(performance.winRate * 100).toFixed(0)}% WR, ${performance.avgPnl.toFixed(2)}% avg PnL) - TIGHTENING to ${((baseCompatibilityThreshold + compatibilityAdjustment) * 100).toFixed(0)}% to stop losses!`;
  }
  
  // 🎯 HIGH CONFIDENCE OVERRIDE: If predictor is very confident AND historically accurate
  if (condition.predictorConfidence >= 0.85 && performance.winRate >= 0.55) {
    compatibilityAdjustment -= 0.10; // Extra -10% for high-confidence proven trades
    reasoning += ` + High confidence override (${(condition.predictorConfidence * 100).toFixed(0)}% predictor)`;
  }
  
  // Apply adjustments with safety bounds
  const recommendedMinCompatibility = Math.max(0.40, Math.min(0.85, 
    baseCompatibilityThreshold + compatibilityAdjustment
  ));
  
  const recommendedMinPredictorConf = Math.max(0.55, Math.min(0.90,
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
