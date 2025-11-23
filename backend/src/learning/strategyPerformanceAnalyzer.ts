/**
 * STRATEGY PERFORMANCE ANALYZER
 * 
 * Analyse la performance de chaque stratégie par crypto/conditions
 * pour apprendre quelle stratégie utiliser dans quelles situations
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export type StrategyPerformance = {
  strategy: string;
  totalTrades: number;
  winRate: number;
  avgPnlUsd: number;
  totalPnlUsd: number;
  avgConfidence: number;
  bestConditions: string[];
  worstConditions: string[];
};

export type CryptoStrategyRecommendation = {
  symbol: string;
  recommendedStrategy: string;
  confidence: number;
  reason: string;
  strategies: StrategyPerformance[];
};

/**
 * Analyse la performance des stratégies par crypto
 */
export async function analyzeStrategyPerformance(
  symbol?: string,
  days: number = 30
): Promise<CryptoStrategyRecommendation[]> {
  
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  
  // Get all fills with strategy info
  const fills = await prisma.fill.findMany({
    where: {
      ts: { gte: since },
      strategyUsed: { not: null },
      ...(symbol ? { session: { symbol } } : {}),
    },
    include: {
      session: {
        select: { symbol: true },
      },
      order: {
        select: {
          strategyUsed: true,
          strategyConfidence: true,
          side: true,
        },
      },
    },
  });
  
  // Group by symbol and strategy
  const symbolStrategyMap = new Map<string, Map<string, {
    trades: number;
    wins: number;
    totalPnl: number;
    confidences: number[];
  }>>();
  
  for (const fill of fills) {
    if (!fill.session?.symbol || !fill.strategyUsed) continue;
    
    const sym = fill.session.symbol;
    const strategy = fill.strategyUsed;
    
    if (!symbolStrategyMap.has(sym)) {
      symbolStrategyMap.set(sym, new Map());
    }
    
    const strategyMap = symbolStrategyMap.get(sym)!;
    if (!strategyMap.has(strategy)) {
      strategyMap.set(strategy, {
        trades: 0,
        wins: 0,
        totalPnl: 0,
        confidences: [],
      });
    }
    
    const stats = strategyMap.get(strategy)!;
    stats.trades++;
    if (fill.realizedPnl && fill.realizedPnl > 0) stats.wins++;
    stats.totalPnl += fill.realizedPnl || 0;
    if (fill.order?.strategyConfidence) {
      stats.confidences.push(fill.order.strategyConfidence);
    }
  }
  
  // Build recommendations
  const recommendations: CryptoStrategyRecommendation[] = [];
  
  for (const [sym, strategyMap] of symbolStrategyMap.entries()) {
    const strategies: StrategyPerformance[] = [];
    
    for (const [strategy, stats] of strategyMap.entries()) {
      const winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;
      const avgPnl = stats.trades > 0 ? stats.totalPnl / stats.trades : 0;
      const avgConfidence = stats.confidences.length > 0
        ? stats.confidences.reduce((a, b) => a + b, 0) / stats.confidences.length
        : 0;
      
      strategies.push({
        strategy,
        totalTrades: stats.trades,
        winRate,
        avgPnlUsd: avgPnl,
        totalPnlUsd: stats.totalPnl,
        avgConfidence,
        bestConditions: [], // TODO: Analyze from TradeEvaluation.inputMetrics
        worstConditions: [],
      });
    }
    
    // Sort by total PnL
    strategies.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
    
    const best = strategies[0];
    const confidence = best.totalTrades >= 5 ? Math.min(0.95, best.winRate * 0.7 + (best.totalTrades / 50) * 0.3) : 0.3;
    
    recommendations.push({
      symbol: sym,
      recommendedStrategy: best.strategy,
      confidence,
      reason: `Best performer: ${best.totalTrades} trades, ${(best.winRate * 100).toFixed(0)}% win rate, $${best.totalPnlUsd.toFixed(2)} total PnL`,
      strategies,
    });
  }
  
  return recommendations;
}

/**
 * Get strategy recommendation for current market conditions
 */
export async function getStrategyRecommendation(
  symbol: string,
  marketConditions: {
    atrPct: number;
    adx: number;
    emaCompression: number;
    rsi?: number;
  }
): Promise<{
  recommended: string;
  confidence: number;
  reason: string;
  historical: StrategyPerformance[];
}> {
  
  // Get historical performance
  const recommendations = await analyzeStrategyPerformance(symbol, 30);
  const symbolRec = recommendations.find(r => r.symbol === symbol);
  
  if (!symbolRec || symbolRec.strategies.length === 0) {
    // No historical data, use heuristic
    return {
      recommended: marketConditions.atrPct < 0.8 && marketConditions.adx < 25
        ? 'mean_reversion'
        : 'trend_following',
      confidence: 0.3,
      reason: 'No historical data, using market condition heuristics',
      historical: [],
    };
  }
  
  // Combine historical performance with current conditions
  const historicalBest = symbolRec.recommendedStrategy;
  
  // Check if current conditions match historical best strategy
  const conditionsMatchMeanReversion = 
    marketConditions.atrPct < 0.8 && 
    marketConditions.adx < 25 && 
    marketConditions.emaCompression < 3.5;
  
  const conditionsMatchTrendFollowing = 
    marketConditions.atrPct >= 0.9 && 
    marketConditions.adx >= 20 && 
    marketConditions.emaCompression >= 3.5;
  
  let recommended = historicalBest;
  let confidence = symbolRec.confidence;
  let reason = `Historical best: ${symbolRec.reason}`;
  
  // Adjust if conditions strongly suggest different strategy
  if (conditionsMatchMeanReversion && historicalBest !== 'mean_reversion') {
    const mrPerf = symbolRec.strategies.find(s => s.strategy === 'mean_reversion');
    if (mrPerf && mrPerf.winRate > 0.5) {
      recommended = 'mean_reversion';
      confidence = Math.max(0.6, mrPerf.winRate * 0.8);
      reason = `Current conditions favor mean reversion (ATR ${marketConditions.atrPct.toFixed(2)}%, ADX ${marketConditions.adx})`;
    }
  } else if (conditionsMatchTrendFollowing && historicalBest !== 'trend_following') {
    const tfPerf = symbolRec.strategies.find(s => s.strategy === 'trend_following');
    if (tfPerf && tfPerf.winRate > 0.5) {
      recommended = 'trend_following';
      confidence = Math.max(0.6, tfPerf.winRate * 0.8);
      reason = `Current conditions favor trend following (ATR ${marketConditions.atrPct.toFixed(2)}%, ADX ${marketConditions.adx})`;
    }
  }
  
  return {
    recommended,
    confidence,
    reason,
    historical: symbolRec.strategies,
  };
}

/**
 * Generate performance report
 */
export async function generateStrategyReport(days: number = 30): Promise<string> {
  const recommendations = await analyzeStrategyPerformance(undefined, days);
  
  let report = `\n=== STRATEGY PERFORMANCE REPORT (Last ${days} days) ===\n\n`;
  
  for (const rec of recommendations.slice(0, 10)) {
    report += `📊 ${rec.symbol}:\n`;
    report += `  Recommended: ${rec.recommendedStrategy} (confidence: ${(rec.confidence * 100).toFixed(0)}%)\n`;
    report += `  Reason: ${rec.reason}\n\n`;
    
    for (const strat of rec.strategies) {
      report += `  - ${strat.strategy}:\n`;
      report += `      Trades: ${strat.totalTrades}, Win Rate: ${(strat.winRate * 100).toFixed(0)}%\n`;
      report += `      Avg PnL: $${strat.avgPnlUsd.toFixed(2)}, Total: $${strat.totalPnlUsd.toFixed(2)}\n`;
      report += `      Avg Confidence: ${(strat.avgConfidence * 100).toFixed(0)}%\n`;
    }
    report += '\n';
  }
  
  return report;
}
