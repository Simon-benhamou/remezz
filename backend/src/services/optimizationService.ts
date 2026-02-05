/**
 * Grid Search / Optimization Service
 *
 * Runs walk-forward for each parameter combination and ranks by
 * out-of-sample Sharpe ratio to find robust parameter sets.
 */

import { runWalkForward, type WalkForwardConfig, type WalkForwardResult } from './walkForwardService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('optimization');

// ── Types ────────────────────────────────────────────────────────────────

export interface ParameterGrid {
  [key: string]: number[];  // e.g., { ROC_MIN: [0.015, 0.0175, 0.02] }
}

export interface OptimizationConfig {
  grid: ParameterGrid;
  walkForward: Omit<WalkForwardConfig, 'signalOverrides'>;
  topN?: number;  // Return top N results (default 5)
}

export interface ParameterSetResult {
  params: Record<string, number>;
  walkForwardResult: WalkForwardResult;
  osSharpe: number;
  osWinRate: number;
  osPnlPct: number;
  degradationRatio: number;
}

export interface OptimizationResult {
  totalCombinations: number;
  completedCombinations: number;
  parameterSets: ParameterSetResult[];
  bestParams: Record<string, number>;
  elapsedMs: number;
}

// ── Grid Generation ──────────────────────────────────────────────────────

export function generateParameterCombinations(grid: ParameterGrid): Record<string, number>[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];

  const combos: Record<string, number>[] = [];

  function recurse(idx: number, current: Record<string, number>) {
    if (idx === keys.length) {
      combos.push({ ...current });
      return;
    }
    const key = keys[idx];
    for (const value of grid[key]) {
      current[key] = value;
      recurse(idx + 1, current);
    }
  }

  recurse(0, {});
  return combos;
}

// ── Main Runner ──────────────────────────────────────────────────────────

export async function runOptimization(config: OptimizationConfig): Promise<OptimizationResult> {
  const startTime = Date.now();
  const topN = config.topN ?? 5;
  const combinations = generateParameterCombinations(config.grid);

  logger.info(`[optimization] Starting grid search | ${combinations.length} combinations | topN=${topN}`);

  const results: ParameterSetResult[] = [];

  for (let i = 0; i < combinations.length; i++) {
    const params = combinations[i];
    const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');

    logger.info(`[optimization] Combo ${i + 1}/${combinations.length}: ${paramStr}`);

    try {
      const wfResult = await runWalkForward({
        ...config.walkForward,
        signalOverrides: params,
      });

      results.push({
        params,
        walkForwardResult: wfResult,
        osSharpe: wfResult.aggregate.avgOosSharpe,
        osWinRate: wfResult.aggregate.oosWinRate,
        osPnlPct: wfResult.aggregate.oosPnlPct,
        degradationRatio: wfResult.aggregate.avgDegradation,
      });

      logger.info(
        `[optimization] Combo ${i + 1} result: ` +
        `OOS Sharpe=${wfResult.aggregate.avgOosSharpe.toFixed(2)} ` +
        `OOS WR=${wfResult.aggregate.oosWinRate.toFixed(1)}% ` +
        `Degradation=${wfResult.aggregate.avgDegradation.toFixed(2)}`,
      );
    } catch (error) {
      logger.warn(`[optimization] Combo ${i + 1} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Sort by OOS Sharpe (descending)
  results.sort((a, b) => b.osSharpe - a.osSharpe);

  const topResults = results.slice(0, topN);
  const bestParams = topResults.length > 0 ? topResults[0].params : {};

  const elapsedMs = Date.now() - startTime;

  logger.info(
    `[optimization] Complete | ${results.length}/${combinations.length} successful ` +
    `| Best OOS Sharpe=${topResults[0]?.osSharpe.toFixed(2) ?? 'N/A'} ` +
    `| Elapsed=${(elapsedMs / 1000).toFixed(1)}s`,
  );

  return {
    totalCombinations: combinations.length,
    completedCombinations: results.length,
    parameterSets: topResults,
    bestParams,
    elapsedMs,
  };
}
