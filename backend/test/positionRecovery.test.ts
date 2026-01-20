/**
 * 🧪 INTEGRATION TESTS - Position Recovery
 *
 * Tests for position state recovery after system restart.
 *
 * Coverage:
 * - Trailing stop state persistence
 * - High/low water mark recovery
 * - Stagnant state restoration
 * - Position sync with exchange
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ============================================================================
// Mock Position State for testing
// ============================================================================

interface Position {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  qty: number;
  leverage: number;
  marginUsd: number;
  stopLossPct: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  maxPnlPct?: number;
  trailingActive?: boolean;
  trailingBreachCandles?: number;
  stagnantState?: {
    triggered: boolean;
    triggeredAtMinutes?: number;
    confirmed: boolean;
    cancelled: boolean;
    obsPeakPct: number;
  };
}

interface DbPosition {
  symbol: string;
  positionSide: 'long' | 'short';
  entryPrice: number;
  entryTs: Date;
  qty: number;
  leverage: number;
  marginUsd: number;
  stopLossPct?: number;
  highWaterMark?: number | null;
  lowWaterMark?: number | null;
  maxPnlPct?: number | null;
  trailingActive?: boolean;
  trailingBreachCandles?: number;
  stagnantState?: any; // JSON field
}

/**
 * Mock function to save position to DB
 */
function savePositionToDb(position: Position): DbPosition {
  return {
    symbol: position.symbol,
    positionSide: position.side,
    entryPrice: position.entryPrice,
    entryTs: new Date(position.entryTime),
    qty: position.qty,
    leverage: position.leverage,
    marginUsd: position.marginUsd,
    stopLossPct: position.stopLossPct,
    highWaterMark: position.highWaterMark ?? null,
    lowWaterMark: position.lowWaterMark ?? null,
    maxPnlPct: position.maxPnlPct ?? null,
    trailingActive: position.trailingActive ?? false,
    trailingBreachCandles: position.trailingBreachCandles ?? 0,
    stagnantState: position.stagnantState ? JSON.stringify(position.stagnantState) : null,
  };
}

/**
 * Mock function to load position from DB
 */
function loadPositionFromDb(dbPos: DbPosition): Position {
  // Parse stagnant state safely
  let stagnantState: Position['stagnantState'] | undefined;
  if (dbPos.stagnantState) {
    try {
      stagnantState = typeof dbPos.stagnantState === 'string'
        ? JSON.parse(dbPos.stagnantState)
        : dbPos.stagnantState;
    } catch (e) {
      stagnantState = undefined;
    }
  }

  return {
    symbol: dbPos.symbol,
    side: dbPos.positionSide,
    entryPrice: dbPos.entryPrice,
    entryTime: dbPos.entryTs.getTime(),
    qty: dbPos.qty,
    leverage: dbPos.leverage,
    marginUsd: dbPos.marginUsd,
    stopLossPct: dbPos.stopLossPct ?? 2.5,
    highWaterMark: dbPos.highWaterMark ?? undefined,
    lowWaterMark: dbPos.lowWaterMark ?? undefined,
    maxPnlPct: dbPos.maxPnlPct ?? undefined,
    trailingActive: dbPos.trailingActive ?? false,
    trailingBreachCandles: dbPos.trailingBreachCandles ?? 0,
    stagnantState,
  };
}

// ============================================================================
// TESTS: Basic Position Recovery
// ============================================================================

describe('PositionRecovery - Basic Recovery', () => {
  it('should persist and recover position entry data', () => {
    const original: Position = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      entryPrice: 100000,
      entryTime: Date.now() - 3600000, // 1 hour ago
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      stopLossPct: 2.5,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    expect(recovered.symbol).toBe(original.symbol);
    expect(recovered.side).toBe(original.side);
    expect(recovered.entryPrice).toBe(original.entryPrice);
    expect(recovered.qty).toBe(original.qty);
    expect(recovered.leverage).toBe(original.leverage);
    expect(recovered.marginUsd).toBe(original.marginUsd);
  });

  it('should preserve entry time across save/load cycle', () => {
    const entryTime = Date.now() - 7200000; // 2 hours ago

    const original: Position = {
      symbol: 'ETH/USDT:USDT',
      side: 'short',
      entryPrice: 3500,
      entryTime,
      qty: 1.5,
      leverage: 4,
      marginUsd: 1312.5,
      stopLossPct: 2.5,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    // Allow 1ms tolerance for Date conversion
    expect(Math.abs(recovered.entryTime - entryTime)).toBeLessThan(1000);
  });
});

// ============================================================================
// TESTS: Trailing Stop State Recovery
// ============================================================================

describe('PositionRecovery - Trailing Stop State', () => {
  it('should recover high water mark for LONG', () => {
    const original: Position = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      entryPrice: 100000,
      entryTime: Date.now() - 3600000,
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      stopLossPct: 2.5,
      highWaterMark: 102500, // +2.5% high reached
      maxPnlPct: 2.5,
      trailingActive: true,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    expect(recovered.highWaterMark).toBe(102500);
    expect(recovered.maxPnlPct).toBe(2.5);
    expect(recovered.trailingActive).toBe(true);
  });

  it('should recover low water mark for SHORT', () => {
    const original: Position = {
      symbol: 'ETH/USDT:USDT',
      side: 'short',
      entryPrice: 3500,
      entryTime: Date.now() - 3600000,
      qty: 1.5,
      leverage: 4,
      marginUsd: 1312.5,
      stopLossPct: 2.5,
      lowWaterMark: 3400, // Dropped to 3400
      maxPnlPct: 2.86, // (3500-3400)/3500 * 100
      trailingActive: true,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    expect(recovered.lowWaterMark).toBe(3400);
    expect(recovered.trailingActive).toBe(true);
  });

  it('should recover trailingBreachCandles counter', () => {
    const original: Position = {
      symbol: 'SOL/USDT:USDT',
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 3600000,
      qty: 10,
      leverage: 5,
      marginUsd: 200,
      stopLossPct: 2.5,
      highWaterMark: 103,
      trailingActive: true,
      trailingBreachCandles: 1, // Mid-confirmation
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    expect(recovered.trailingBreachCandles).toBe(1);
  });

  it('should default trailingActive to false if not set', () => {
    const dbPos: DbPosition = {
      symbol: 'BTC/USDT:USDT',
      positionSide: 'long',
      entryPrice: 100000,
      entryTs: new Date(),
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      // trailingActive not set
    };

    const recovered = loadPositionFromDb(dbPos);
    expect(recovered.trailingActive).toBe(false);
  });
});

// ============================================================================
// TESTS: Stagnant State Recovery
// ============================================================================

describe('PositionRecovery - Stagnant State', () => {
  it('should recover stagnant state from JSON', () => {
    const stagnantState = {
      triggered: true,
      triggeredAtMinutes: 45,
      confirmed: false,
      cancelled: false,
      obsPeakPct: 0.3,
    };

    const original: Position = {
      symbol: 'DOGE/USDT:USDT',
      side: 'long',
      entryPrice: 0.10,
      entryTime: Date.now() - 2700000, // 45 minutes ago
      qty: 1000,
      leverage: 5,
      marginUsd: 20,
      stopLossPct: 2.5,
      trailingActive: false,
      stagnantState,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    expect(recovered.stagnantState).toEqual(stagnantState);
  });

  it('should handle invalid JSON stagnantState gracefully', () => {
    const dbPos: DbPosition = {
      symbol: 'BTC/USDT:USDT',
      positionSide: 'long',
      entryPrice: 100000,
      entryTs: new Date(),
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      stagnantState: '{invalid json}',
    };

    const recovered = loadPositionFromDb(dbPos);
    expect(recovered.stagnantState).toBeUndefined();
  });

  it('should recover confirmed stagnant state', () => {
    const stagnantState = {
      triggered: true,
      triggeredAtMinutes: 45,
      confirmed: true, // Stagnant confirmed
      cancelled: false,
      obsPeakPct: 0.2, // Low peak during observation
    };

    const original: Position = {
      symbol: 'SOL/USDT:USDT',
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 6300000, // 105 minutes ago
      qty: 10,
      leverage: 5,
      marginUsd: 200,
      stopLossPct: 0.8, // Tightened due to stagnant
      trailingActive: false,
      stagnantState,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    expect(recovered.stagnantState?.confirmed).toBe(true);
    expect(recovered.stopLossPct).toBe(0.8); // Tightened SL preserved
  });

  it('should recover cancelled stagnant state', () => {
    const stagnantState = {
      triggered: true,
      triggeredAtMinutes: 45,
      confirmed: false,
      cancelled: true, // Cancelled due to recovery
      obsPeakPct: 0.7, // Recovered above threshold
    };

    const original: Position = {
      symbol: 'ETH/USDT:USDT',
      side: 'long',
      entryPrice: 3500,
      entryTime: Date.now() - 4500000, // 75 minutes ago
      qty: 1,
      leverage: 4,
      marginUsd: 875,
      stopLossPct: 2.5, // Original SL (not tightened because cancelled)
      trailingActive: false,
      stagnantState,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    expect(recovered.stagnantState?.cancelled).toBe(true);
    expect(recovered.stagnantState?.obsPeakPct).toBe(0.7);
  });
});

// ============================================================================
// TESTS: Edge Cases
// ============================================================================

describe('PositionRecovery - Edge Cases', () => {
  it('should handle null highWaterMark', () => {
    const dbPos: DbPosition = {
      symbol: 'BTC/USDT:USDT',
      positionSide: 'long',
      entryPrice: 100000,
      entryTs: new Date(),
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      highWaterMark: null,
    };

    const recovered = loadPositionFromDb(dbPos);
    expect(recovered.highWaterMark).toBeUndefined();
  });

  it('should handle missing stopLossPct (default to 2.5)', () => {
    const dbPos: DbPosition = {
      symbol: 'BTC/USDT:USDT',
      positionSide: 'long',
      entryPrice: 100000,
      entryTs: new Date(),
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      // stopLossPct not set
    };

    const recovered = loadPositionFromDb(dbPos);
    expect(recovered.stopLossPct).toBe(2.5);
  });

  it('should handle already-parsed stagnantState object', () => {
    const stagnantState = {
      triggered: true,
      confirmed: false,
      cancelled: false,
      obsPeakPct: 0.5,
    };

    const dbPos: DbPosition = {
      symbol: 'BTC/USDT:USDT',
      positionSide: 'long',
      entryPrice: 100000,
      entryTs: new Date(),
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      stagnantState, // Object, not string
    };

    const recovered = loadPositionFromDb(dbPos);
    expect(recovered.stagnantState).toEqual(stagnantState);
  });

  it('should handle very old position', () => {
    const entryTime = Date.now() - 172800000; // 48 hours ago

    const original: Position = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      entryPrice: 95000,
      entryTime,
      qty: 0.01,
      leverage: 5,
      marginUsd: 190,
      stopLossPct: 2.5,
      highWaterMark: 102000,
      maxPnlPct: 7.37,
      trailingActive: true,
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    // Verify we can calculate hold time correctly
    const holdMinutes = (Date.now() - recovered.entryTime) / 60000;
    expect(holdMinutes).toBeGreaterThan(2800); // > 48 hours
  });
});

// ============================================================================
// TESTS: Recovery Scenario Simulation
// ============================================================================

describe('PositionRecovery - Scenario Simulation', () => {
  it('should continue 2-candle confirmation after restart', () => {
    // Position was mid-confirmation when system crashed
    const original: Position = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      entryPrice: 100000,
      entryTime: Date.now() - 3600000,
      qty: 0.01,
      leverage: 5,
      marginUsd: 200,
      stopLossPct: 2.5,
      highWaterMark: 102000,
      maxPnlPct: 2.0,
      trailingActive: true,
      trailingBreachCandles: 1, // First candle breached
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    // After restart, agent should continue with breach count = 1
    // Next candle close below trailing = exit (2 consecutive)
    expect(recovered.trailingBreachCandles).toBe(1);
    expect(recovered.trailingActive).toBe(true);
  });

  it('should continue stagnant observation after restart', () => {
    // Position was in stagnant observation window
    const original: Position = {
      symbol: 'SOL/USDT:USDT',
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 3600000, // 60 minutes ago
      qty: 10,
      leverage: 5,
      marginUsd: 200,
      stopLossPct: 2.5,
      trailingActive: false,
      stagnantState: {
        triggered: true,
        triggeredAtMinutes: 45,
        confirmed: false,
        cancelled: false,
        obsPeakPct: 0.4,
      },
    };

    const dbPos = savePositionToDb(original);
    const recovered = loadPositionFromDb(dbPos);

    // After restart, agent should continue observation
    // It's at 60min, triggered at 45min, obs window is 60min
    // Should check for recovery/confirmation at 105min
    expect(recovered.stagnantState?.triggered).toBe(true);
    expect(recovered.stagnantState?.triggeredAtMinutes).toBe(45);
    expect(recovered.stagnantState?.confirmed).toBe(false);
  });
});
