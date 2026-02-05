/**
 * Walk-Forward Testing Service
 *
 * Slides a train+test window forward in time to validate strategy robustness.
 * Compares in-sample vs out-of-sample performance to detect overfitting.
 */

import { runBacktest, type BacktestParams, type BacktestResult } from './backtestService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('walk-forward');

// ── Types ────────────────────────────────────────────────────────────────

export interface WalkForwardConfig {
  fullStartDate: Date;
  fullEndDate: Date;
  trainWindowMonths: number;   // default 6
  testWindowMonths: number;    // default 2
  stepMonths: number;          // default 2
  symbols: string[];
  initialCapital: number;
  leverage: number;
  signalOverrides?: Record<string, number>;
}

export interface WalkForwardWindow {
  windowIndex: number;
  trainStart: Date;
  trainEnd: Date;
  testStart: Date;
  testEnd: Date;
  trainResult: BacktestResult;
  testResult: BacktestResult;
  degradationRatio: number;   // testSharpe / trainSharpe
}

export interface WalkForwardResult {
  config: WalkForwardConfig;
  windows: WalkForwardWindow[];
  aggregate: {
    avgIsSharpe: number;       // Average in-sample Sharpe
    avgOosSharpe: number;      // Average out-of-sample Sharpe
    avgDegradation: number;    // Average degradation ratio
    oosWinRate: number;        // Combined OOS win rate
    oosPnlPct: number;         // Combined OOS PnL %
    oosTotalTrades: number;    // Total OOS trades
    windowCount: number;
  };
}

// ── Window Generation ────────────────────────────────────────────────────

export function generateWindows(config: WalkForwardConfig): { trainStart: Date; trainEnd: Date; testStart: Date; testEnd: Date }[] {
  const windows: { trainStart: Date; trainEnd: Date; testStart: Date; testEnd: Date }[] = [];

  let trainStart = new Date(config.fullStartDate);

  while (true) {
    const trainEnd = addMonths(trainStart, config.trainWindowMonths);
    const testStart = new Date(trainEnd);
    const testEnd = addMonths(testStart, config.testWindowMonths);

    // Stop if test window exceeds available data
    if (testEnd > config.fullEndDate) break;

    windows.push({ trainStart: new Date(trainStart), trainEnd, testStart, testEnd });

    // Step forward
    trainStart = addMonths(trainStart, config.stepMonths);
  }

  return windows;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

// ── Main Runner ──────────────────────────────────────────────────────────

export async function runWalkForward(config: WalkForwardConfig): Promise<WalkForwardResult> {
  const windowDefs = generateWindows(config);

  if (windowDefs.length === 0) {
    throw new Error('No valid walk-forward windows can be generated with the given date range and window sizes.');
  }

  logger.info(`[walk-forward] Starting with ${windowDefs.length} windows | train=${config.trainWindowMonths}mo test=${config.testWindowMonths}mo step=${config.stepMonths}mo`);

  const windows: WalkForwardWindow[] = [];

  for (let i = 0; i < windowDefs.length; i++) {
    const w = windowDefs[i];

    logger.info(`[walk-forward] Window ${i + 1}/${windowDefs.length}: train=${fmt(w.trainStart)}→${fmt(w.trainEnd)} | test=${fmt(w.testStart)}→${fmt(w.testEnd)}`);

    const baseParams: Omit<BacktestParams, 'startDate' | 'endDate'> = {
      initialCapital: config.initialCapital,
      symbols: config.symbols,
      leverage: config.leverage,
      signalOverrides: config.signalOverrides as any,
    };

    const [trainResult, testResult] = await Promise.all([
      runBacktest({ ...baseParams, startDate: w.trainStart, endDate: w.trainEnd }),
      runBacktest({ ...baseParams, startDate: w.testStart, endDate: w.testEnd }),
    ]);

    const trainSharpe = trainResult.summary.sharpeRatio;
    const testSharpe = testResult.summary.sharpeRatio;
    const degradationRatio = trainSharpe !== 0 ? testSharpe / trainSharpe : 0;

    logger.info(
      `[walk-forward] Window ${i + 1} results: ` +
      `IS Sharpe=${trainSharpe.toFixed(2)} OOS Sharpe=${testSharpe.toFixed(2)} ` +
      `Degradation=${degradationRatio.toFixed(2)} OOS WR=${testResult.summary.winRate.toFixed(1)}%`,
    );

    windows.push({
      windowIndex: i,
      ...w,
      trainResult,
      testResult,
      degradationRatio,
    });
  }

  // Aggregate
  const n = windows.length;
  const avgIsSharpe = windows.reduce((s, w) => s + w.trainResult.summary.sharpeRatio, 0) / n;
  const avgOosSharpe = windows.reduce((s, w) => s + w.testResult.summary.sharpeRatio, 0) / n;
  const avgDegradation = windows.reduce((s, w) => s + w.degradationRatio, 0) / n;

  const oosTotalTrades = windows.reduce((s, w) => s + w.testResult.summary.totalTrades, 0);
  const oosWins = windows.reduce((s, w) => s + w.testResult.summary.wins, 0);
  const oosWinRate = oosTotalTrades > 0 ? (oosWins / oosTotalTrades) * 100 : 0;
  const oosPnlPct = windows.reduce((s, w) => s + w.testResult.summary.totalPnlPct, 0);

  logger.info(
    `[walk-forward] Complete | ${n} windows | ` +
    `Avg IS Sharpe=${avgIsSharpe.toFixed(2)} Avg OOS Sharpe=${avgOosSharpe.toFixed(2)} ` +
    `Degradation=${avgDegradation.toFixed(2)} OOS WR=${oosWinRate.toFixed(1)}%`,
  );

  return {
    config,
    windows,
    aggregate: {
      avgIsSharpe, avgOosSharpe, avgDegradation,
      oosWinRate, oosPnlPct, oosTotalTrades, windowCount: n,
    },
  };
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
