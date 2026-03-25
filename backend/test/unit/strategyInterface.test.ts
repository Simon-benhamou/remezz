import { describe, it, expect } from '@jest/globals';
import type { IStrategy, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, StrategyConfig, Candle } from '../../src/strategies/types.js';

describe('IStrategy interface contract', () => {
  const dummyStrategy: IStrategy = {
    name: 'test-dummy',
    getConfig: () => ({
      name: 'test-dummy',
      version: '1.0',
      symbols: ['BTC/USDT:USDT'],
      leverage: 1,
      maxPositions: 1,
      positionSizePct: 0.02,
      minCandlesRequired: 20,
      timeframeMs: 900_000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    }),
    checkEntry: (_ctx: EntryContext) => null,
    checkExit: (_ctx: ExitContext) => ({ shouldExit: false, reason: 'none' }),
  };

  it('should have a name', () => {
    expect(dummyStrategy.name).toBe('test-dummy');
  });

  it('should return config with required fields', () => {
    const config = dummyStrategy.getConfig();
    expect(config.name).toBeDefined();
    expect(config.symbols.length).toBeGreaterThan(0);
    expect(config.leverage).toBeGreaterThan(0);
    expect(config.fees.tradingPct).toBeGreaterThan(0);
  });

  it('should return null when no entry signal', () => {
    const ctx: EntryContext = {
      symbol: 'BTC/USDT:USDT',
      candles: [],
      btcCandles: [],
      currentPrice: 50000,
      timestamp: Date.now(),
      capital: 1000,
      openPositions: 0,
    };
    expect(dummyStrategy.checkEntry(ctx)).toBeNull();
  });

  it('should return exit signal with shouldExit boolean', () => {
    const ctx: ExitContext = {
      symbol: 'BTC/USDT:USDT',
      position: { symbol: 'BTC/USDT:USDT', side: 'long', entryPrice: 50000, qty: 0.01, entryTime: Date.now() },
      candles: [],
      btcCandles: [],
      currentPrice: 51000,
      timestamp: Date.now(),
      entryPrice: 50000,
      unrealizedPnlPct: 2.0,
      holdingMinutes: 60,
    };
    const exit = dummyStrategy.checkExit(ctx);
    expect(exit).toBeDefined();
    expect(typeof exit.shouldExit).toBe('boolean');
  });
});
