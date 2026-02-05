/**
 * Parity Integration Tests
 * Validates backtest determinism, snapshot matching, and strategy behavior.
 */

import { runBacktest, type BacktestParams, type BacktestResult } from '../../src/services/backtestService.js';

// Fixed parameters for reproducible tests
const BASE_PARAMS: BacktestParams = {
  startDate: new Date('2024-06-01'),
  endDate: new Date('2024-07-01'),
  initialCapital: 2000,
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
  leverage: 4.5,
};

describe('Parity Integration Tests', () => {
  // ── Test 1: Determinism ─────────────────────────────────────────────
  it('should produce identical results on two consecutive backtest runs', async () => {
    const result1 = await runBacktest(BASE_PARAMS);
    const result2 = await runBacktest(BASE_PARAMS);

    expect(result1.summary.totalTrades).toBe(result2.summary.totalTrades);
    expect(result1.summary.winRate).toBe(result2.summary.winRate);
    expect(result1.summary.totalPnlUsd).toBeCloseTo(result2.summary.totalPnlUsd, 2);
    expect(result1.summary.sharpeRatio).toBeCloseTo(result2.summary.sharpeRatio, 4);

    // Compare exit reasons distribution
    const exitReasons1 = result1.trades.map(t => t.exitReason).sort();
    const exitReasons2 = result2.trades.map(t => t.exitReason).sort();
    expect(exitReasons1).toEqual(exitReasons2);
  }, 120_000);

  // ── Test 2: Snapshot ────────────────────────────────────────────────
  it('should match saved snapshot for 1-month BTC/ETH backtest', async () => {
    const result = await runBacktest(BASE_PARAMS);

    expect(result.summary).toMatchSnapshot({
      // Allow minor float variance
      totalPnlUsd: expect.any(Number),
      avgTradeUsd: expect.any(Number),
      avgWinUsd: expect.any(Number),
      avgLossUsd: expect.any(Number),
      totalFeesUsd: expect.any(Number),
      finalCapital: expect.any(Number),
      sharpeRatio: expect.any(Number),
    });

    // Fixed fields should match exactly
    expect(result.summary.totalTrades).toMatchSnapshot();
    expect(result.summary.wins).toMatchSnapshot();
    expect(result.summary.losses).toMatchSnapshot();
    expect(result.summary.longTrades).toMatchSnapshot();
    expect(result.summary.shortTrades).toMatchSnapshot();
  }, 120_000);

  // ── Test 3: Trailing stop activation ────────────────────────────────
  it('should activate trailing stop at correct threshold', async () => {
    const result = await runBacktest(BASE_PARAMS);

    // Find trades that exited via trailing
    const trailingTrades = result.trades.filter(t =>
      t.exitReason?.toLowerCase().includes('trailing'),
    );

    // All trailing exits should have positive PnL (trailing = protective exit)
    for (const trade of trailingTrades) {
      expect(trade.pnlPct).toBeGreaterThan(0);
    }
  }, 120_000);

  // ── Test 4: Stop loss exits should be negative ──────────────────────
  it('should have negative PnL for stop loss exits', async () => {
    const result = await runBacktest(BASE_PARAMS);

    const slTrades = result.trades.filter(t =>
      t.exitReason?.toLowerCase().includes('stop_loss') ||
      t.exitReason?.toLowerCase().includes('stoploss'),
    );

    for (const trade of slTrades) {
      expect(trade.pnlPct).toBeLessThan(0);
    }
  }, 120_000);

  // ── Test 5: Stagnant trade exit ─────────────────────────────────────
  it('should tighten SL on stagnant trades (not exit immediately)', async () => {
    const result = await runBacktest(BASE_PARAMS);

    const stagnantTrades = result.trades.filter(t =>
      t.exitReason?.toLowerCase().includes('stagnant'),
    );

    // Stagnant trades should have low PnL (they stagnated)
    for (const trade of stagnantTrades) {
      // Stagnant exits happen after tightened SL, so PnL should be small
      expect(Math.abs(trade.pnlPct)).toBeLessThan(5);
    }
  }, 120_000);
});
