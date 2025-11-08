/**
 * Strategy Optimizer Service
 * Performs grid search to find optimal parameters for each symbol
 */

import { getSymbolEvaluations } from './tradeEvaluationLogger.js';
import { savePersonalityProfile, DEFAULT_PARAMS } from './personalityProfile.js';
import type { OptimalParams } from './personalityProfile.js';
import type { InputMetrics, MarketOutcome } from './tradeEvaluationLogger.js';
import { prisma } from '../db/client.js';
import { Prisma } from '.prisma/client';

type EvaluationData = {
  inputMetrics: InputMetrics;
  marketOutcome: MarketOutcome;
};

/**
 * Grid search parameter ranges
 */
const PARAM_GRID = {
  weights: {
    adx: [0.2, 0.3, 0.4],
    strength: [0.2, 0.3, 0.4],
    alignment: [0.15, 0.2, 0.25],
    slope: [0.05, 0.1, 0.15],
    flow: [0.05, 0.1, 0.15],
  },
  thresholds: {
    adx: [14, 16, 18, 20],
    trendStrength: [0.2, 0.25, 0.3],
    minConfidence: [0.4, 0.45, 0.5, 0.55],
  },
};

/**
 * Calculate confidence score using given parameters
 */
function calculateConfidence(metrics: InputMetrics, params: OptimalParams): number {
  const adx = metrics.adx ?? 0;
  const trendStrength = metrics.trendStrength ?? 0;
  const ema20 = metrics.ema20 ?? 0;
  const ema50 = metrics.ema50 ?? 0;
  const slope = metrics.slope ?? 0;
  const cmf = metrics.cmf ?? 0;

  // Calculate component scores
  const adxScore = Math.max(0, Math.min(1, (adx - 15) / 22));
  const strengthScore = Math.max(0, Math.min(1, (trendStrength - 0.2) / 0.8));
  
  const alignment = ema50 !== 0 ? Math.abs((ema20 - ema50) / ema50) : 0;
  const alignmentScore = Math.max(0, Math.min(1, alignment / 0.018));
  
  const slopeNorm = ema20 !== 0 ? Math.abs(slope / ema20) : 0;
  const slopeScore = Math.max(0, Math.min(1, slopeNorm * 220));
  
  const flowScore = Math.max(0, Math.min(1, (cmf + 0.2) / 0.6));

  // Weighted score using provided parameters
  const score =
    adxScore * params.weights.adx +
    strengthScore * params.weights.strength +
    alignmentScore * params.weights.alignment +
    slopeScore * params.weights.slope +
    flowScore * params.weights.flow;

  return Number(score.toFixed(4));
}

/**
 * Check if trade would pass filters with given parameters
 */
function wouldExecute(metrics: InputMetrics, params: OptimalParams): boolean {
  const adx = metrics.adx ?? 0;
  const trendStrength = metrics.trendStrength ?? 0;
  const confidence = calculateConfidence(metrics, params);

  return (
    adx >= params.thresholds.adx &&
    trendStrength >= params.thresholds.trendStrength &&
    confidence >= params.thresholds.minConfidence
  );
}

/**
 * Calculate fitness score for a parameter combination
 * Uses Sharpe ratio-like metric: (average PnL) / (std dev of PnL)
 */
function calculateFitness(evaluations: EvaluationData[], params: OptimalParams): number {
  const trades: number[] = [];

  for (const evaluation of evaluations) {
    if (wouldExecute(evaluation.inputMetrics, params)) {
      const pnl = evaluation.marketOutcome.pnl_1h ?? 0;
      trades.push(pnl);
    }
  }

  if (trades.length < 20) {
    // Not enough trades to be confident in the parameters
    return -Infinity;
  }

  // Calculate average PnL
  const avgPnl = trades.reduce((sum, pnl) => sum + pnl, 0) / trades.length;

  // Calculate standard deviation
  const variance =
    trades.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnl, 2), 0) / trades.length;
  const stdDev = Math.sqrt(variance);

  // Sharpe-like ratio (annualized assuming 1h trades)
  const sharpe = stdDev > 0 ? avgPnl / stdDev : 0;

  // Also consider win rate and total PnL
  const wins = trades.filter((pnl) => pnl > 0).length;
  const winRate = wins / trades.length;
  const totalPnl = trades.reduce((sum, pnl) => sum + pnl, 0);

  // Combined fitness: weighted combination of Sharpe, win rate, and total PnL
  const fitness = sharpe * 0.5 + winRate * 0.3 + totalPnl * 20 * 0.2;

  return fitness;
}

/**
 * Generate all parameter combinations for grid search
 * Only generates combinations where weights sum to approximately 1.0
 */
function* generateParamCombinations(): Generator<OptimalParams> {
  // Pre-filter weight combinations that sum to 1.0
  const validWeightCombos: Array<{
    adx: number;
    strength: number;
    alignment: number;
    slope: number;
    flow: number;
  }> = [];

  for (const adxWeight of PARAM_GRID.weights.adx) {
    for (const strengthWeight of PARAM_GRID.weights.strength) {
      for (const alignmentWeight of PARAM_GRID.weights.alignment) {
        for (const slopeWeight of PARAM_GRID.weights.slope) {
          for (const flowWeight of PARAM_GRID.weights.flow) {
            const total = adxWeight + strengthWeight + alignmentWeight + slopeWeight + flowWeight;
            // Only keep combinations that sum to approximately 1.0
            if (Math.abs(total - 1.0) <= 0.01) {
              validWeightCombos.push({
                adx: adxWeight,
                strength: strengthWeight,
                alignment: alignmentWeight,
                slope: slopeWeight,
                flow: flowWeight,
              });
            }
          }
        }
      }
    }
  }

  // Now generate full parameter combinations using only valid weights
  for (const weights of validWeightCombos) {
    for (const adxThresh of PARAM_GRID.thresholds.adx) {
      for (const strengthThresh of PARAM_GRID.thresholds.trendStrength) {
        for (const confThresh of PARAM_GRID.thresholds.minConfidence) {
          yield {
            weights,
            thresholds: {
              adx: adxThresh,
              trendStrength: strengthThresh,
              minConfidence: confThresh,
            },
          };
        }
      }
    }
  }
}

/**
 * Optimize parameters for a symbol using grid search
 */
export async function optimizeSymbolParameters(symbol: string): Promise<OptimalParams | null> {
  console.log(`🔍 Optimizing parameters for ${symbol}...`);

  // Fetch historical evaluations
  const rawEvaluations = await getSymbolEvaluations(symbol, 1000);

  if (rawEvaluations.length < 50) {
    console.log(`⚠️ Insufficient data for ${symbol}: ${rawEvaluations.length} evaluations`);
    return null;
  }

  // Filter to evaluations with complete data
  const evaluations: EvaluationData[] = rawEvaluations
    .filter((e) => e.marketOutcome && typeof e.marketOutcome === 'object')
    .map((e) => ({
      inputMetrics: e.inputMetrics as InputMetrics,
      marketOutcome: e.marketOutcome as MarketOutcome,
    }));

  if (evaluations.length < 50) {
    console.log(`⚠️ Insufficient complete data for ${symbol}: ${evaluations.length} evaluations`);
    return null;
  }

  console.log(`📊 Running grid search on ${evaluations.length} evaluations...`);

  let bestParams: OptimalParams = DEFAULT_PARAMS;
  let bestFitness = -Infinity;
  let testedCount = 0;

  // Grid search
  for (const params of generateParamCombinations()) {
    const fitness = calculateFitness(evaluations, params);
    testedCount++;

    if (fitness > bestFitness) {
      bestFitness = fitness;
      bestParams = params;
    }
  }

  console.log(
    `✅ ${symbol}: Tested ${testedCount} combinations, best fitness: ${bestFitness.toFixed(4)}`,
  );

  // Only save if we found meaningful improvement
  if (bestFitness > -Infinity) {
    return bestParams;
  }

  return null;
}

/**
 * Run optimization for all symbols with sufficient data
 */
export async function optimizeAllSymbols(): Promise<Map<string, OptimalParams>> {
  console.log('🚀 Starting optimization for all symbols...');

  // Get all distinct symbols from trade evaluations
  const symbols = await getDistinctSymbols();
  console.log(`Found ${symbols.length} symbols to optimize`);

  const results = new Map<string, OptimalParams>();

  for (const symbol of symbols) {
    try {
      const optimalParams = await optimizeSymbolParameters(symbol);
      if (optimalParams) {
        await savePersonalityProfile(symbol, optimalParams);
        results.set(symbol, optimalParams);
        console.log(`✅ Saved optimal parameters for ${symbol}`);
      }
    } catch (error) {
      console.error(`Failed to optimize ${symbol}:`, error);
    }
  }

  console.log(`🎉 Optimization complete: ${results.size}/${symbols.length} symbols updated`);
  return results;
}

/**
 * Get distinct symbols from trade evaluations
 */
async function getDistinctSymbols(): Promise<string[]> {
  const result = await prisma.tradeEvaluation.findMany({
    where: {
      marketOutcome: { not: Prisma.JsonNull },
    },
    select: { symbol: true },
    distinct: ['symbol'],
  });
  return result.map((r) => r.symbol);
}
