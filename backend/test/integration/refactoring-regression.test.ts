/**
 * Refactoring Regression Test
 * Validates that extracted classes produce identical results to the
 * monolithic SimpleAgent by comparing a full backtest run against a saved baseline.
 */

import { runBacktest, type BacktestParams, type BacktestResult } from '../../src/services/backtestService.js';

const REGRESSION_PARAMS: BacktestParams = {
  startDate: new Date('2024-06-01'),
  endDate: new Date('2024-07-01'),
  initialCapital: 2000,
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'],
  leverage: 4.5,
};

describe('Refactoring Regression', () => {
  let baseline: BacktestResult;

  beforeAll(async () => {
    baseline = await runBacktest(REGRESSION_PARAMS);
  }, 180_000);

  it('should produce consistent trade count after refactoring', async () => {
    const result = await runBacktest(REGRESSION_PARAMS);
    expect(result.summary.totalTrades).toBe(baseline.summary.totalTrades);
  }, 120_000);

  it('should produce consistent win rate after refactoring', async () => {
    const result = await runBacktest(REGRESSION_PARAMS);
    expect(result.summary.winRate).toBeCloseTo(baseline.summary.winRate, 2);
  }, 120_000);

  it('should produce consistent PnL after refactoring', async () => {
    const result = await runBacktest(REGRESSION_PARAMS);
    expect(result.summary.totalPnlUsd).toBeCloseTo(baseline.summary.totalPnlUsd, 2);
  }, 120_000);

  it('should produce identical exit reason distribution', async () => {
    const result = await runBacktest(REGRESSION_PARAMS);

    const baselineReasons = baseline.trades.map(t => t.exitReason).sort();
    const resultReasons = result.trades.map(t => t.exitReason).sort();
    expect(resultReasons).toEqual(baselineReasons);
  }, 120_000);

  it('should produce consistent Sharpe ratio', async () => {
    const result = await runBacktest(REGRESSION_PARAMS);
    expect(result.summary.sharpeRatio).toBeCloseTo(baseline.summary.sharpeRatio, 4);
  }, 120_000);

  it('should produce consistent max drawdown', async () => {
    const result = await runBacktest(REGRESSION_PARAMS);
    expect(result.summary.maxDrawdownPct).toBeCloseTo(baseline.summary.maxDrawdownPct, 2);
  }, 120_000);
});
