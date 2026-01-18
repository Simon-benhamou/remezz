/**
 * 🧪 TESTS - Bug Fixes P0/P1
 *
 * Tests pour les corrections critiques et majeures:
 * 1. P1: trailingBreachCandles persistence
 * 2. P1: stagnantState JSON.parse error handling
 * 3. P1: WebSocket staleness detection
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ============================================================================
// TEST 1: stagnantState JSON.parse with try-catch
// ============================================================================

describe('stagnantState JSON.parse safety', () => {
  /**
   * Helper function that mimics the FIXED stagnantState parsing logic
   */
  function parseStagnantStateSafe(dbValue: unknown): { triggered: boolean; triggeredAtMinutes?: number; confirmed: boolean; cancelled: boolean; obsPeakPct: number } | undefined {
    try {
      if (!dbValue) return undefined;
      if (typeof dbValue === 'string') {
        return JSON.parse(dbValue);
      }
      return dbValue as { triggered: boolean; triggeredAtMinutes?: number; confirmed: boolean; cancelled: boolean; obsPeakPct: number };
    } catch (e) {
      console.warn(`Failed to parse stagnantState: ${e}`);
      return undefined;
    }
  }

  it('should parse valid JSON string correctly', () => {
    const jsonString = '{"triggered":true,"confirmed":false,"cancelled":false,"obsPeakPct":0.5}';
    const result = parseStagnantStateSafe(jsonString);

    expect(result).toEqual({
      triggered: true,
      confirmed: false,
      cancelled: false,
      obsPeakPct: 0.5
    });
  });

  it('should return object as-is when already parsed', () => {
    const objValue = { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 1.2 };
    const result = parseStagnantStateSafe(objValue);

    expect(result).toEqual(objValue);
  });

  it('should return undefined for null/undefined input', () => {
    expect(parseStagnantStateSafe(null)).toBeUndefined();
    expect(parseStagnantStateSafe(undefined)).toBeUndefined();
  });

  it('should return undefined for invalid JSON without throwing', () => {
    const invalidJson = '{invalid json here}';

    // Should NOT throw
    expect(() => parseStagnantStateSafe(invalidJson)).not.toThrow();

    // Should return undefined
    const result = parseStagnantStateSafe(invalidJson);
    expect(result).toBeUndefined();
  });

  it('should return undefined for malformed JSON without throwing', () => {
    const malformedJson = '{"triggered":true,"confirmed":}'; // Missing value

    expect(() => parseStagnantStateSafe(malformedJson)).not.toThrow();
    expect(parseStagnantStateSafe(malformedJson)).toBeUndefined();
  });
});

// ============================================================================
// TEST 2: trailingBreachCandles persistence logic
// ============================================================================

describe('trailingBreachCandles persistence', () => {
  interface MockPosition {
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    trailingActive: boolean;
    trailingBreachCandles: number;
    highWaterMark?: number;
    lowWaterMark?: number;
  }

  /**
   * Simulates saving position to DB
   */
  function preparePositionForDb(position: MockPosition): Record<string, unknown> {
    return {
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      trailingActive: position.trailingActive ?? false,
      trailingBreachCandles: position.trailingBreachCandles ?? 0,
      highWaterMark: position.highWaterMark ?? null,
      lowWaterMark: position.lowWaterMark ?? null,
    };
  }

  /**
   * Simulates loading position from DB
   */
  function loadPositionFromDb(dbPosition: Record<string, unknown>): MockPosition {
    return {
      symbol: dbPosition.symbol as string,
      side: dbPosition.side as 'long' | 'short',
      entryPrice: dbPosition.entryPrice as number,
      trailingActive: (dbPosition.trailingActive as boolean) ?? false,
      trailingBreachCandles: (dbPosition.trailingBreachCandles as number) ?? 0,
      highWaterMark: dbPosition.highWaterMark as number | undefined,
      lowWaterMark: dbPosition.lowWaterMark as number | undefined,
    };
  }

  it('should persist trailingBreachCandles when saving position', () => {
    const position: MockPosition = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      entryPrice: 100000,
      trailingActive: true,
      trailingBreachCandles: 1, // Mid-confirmation
      highWaterMark: 101000,
    };

    const dbData = preparePositionForDb(position);

    expect(dbData.trailingBreachCandles).toBe(1);
    expect(dbData.trailingActive).toBe(true);
  });

  it('should restore trailingBreachCandles when loading position', () => {
    const dbPosition = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      entryPrice: 100000,
      trailingActive: true,
      trailingBreachCandles: 1,
      highWaterMark: 101000,
      lowWaterMark: null,
    };

    const position = loadPositionFromDb(dbPosition);

    expect(position.trailingBreachCandles).toBe(1);
    expect(position.trailingActive).toBe(true);
  });

  it('should default trailingBreachCandles to 0 if not in DB', () => {
    const dbPosition = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      entryPrice: 100000,
      trailingActive: true,
      // trailingBreachCandles is missing
      highWaterMark: 101000,
      lowWaterMark: null,
    };

    const position = loadPositionFromDb(dbPosition);

    expect(position.trailingBreachCandles).toBe(0);
  });
});

// ============================================================================
// TEST 3: WebSocket data freshness detection
// ============================================================================

describe('WebSocket data freshness detection', () => {
  const MAX_STALENESS_MS = 2 * 60 * 1000; // 2 minutes

  interface CandleCache {
    data: unknown[];
    lastUpdateTs: number;
  }

  /**
   * Check if cached data is stale
   */
  function isDataStale(cache: CandleCache | null | undefined, maxStalenessMs: number = MAX_STALENESS_MS): boolean {
    if (!cache) return true;
    if (!cache.lastUpdateTs) return true;

    const now = Date.now();
    return (now - cache.lastUpdateTs) > maxStalenessMs;
  }

  /**
   * Get data with staleness check
   */
  function getDataWithStalenessCheck(
    cache: CandleCache | null | undefined,
    maxStalenessMs: number = MAX_STALENESS_MS
  ): { data: unknown[] | null; isStale: boolean; ageMs: number } {
    if (!cache) {
      return { data: null, isStale: true, ageMs: Infinity };
    }

    const now = Date.now();
    const ageMs = now - (cache.lastUpdateTs || 0);
    const isStale = ageMs > maxStalenessMs;

    return {
      data: isStale ? null : cache.data,
      isStale,
      ageMs,
    };
  }

  it('should detect fresh data as not stale', () => {
    const cache: CandleCache = {
      data: [{ close: 100 }],
      lastUpdateTs: Date.now() - 30000, // 30 seconds ago
    };

    expect(isDataStale(cache)).toBe(false);
  });

  it('should detect old data as stale', () => {
    const cache: CandleCache = {
      data: [{ close: 100 }],
      lastUpdateTs: Date.now() - (3 * 60 * 1000), // 3 minutes ago
    };

    expect(isDataStale(cache)).toBe(true);
  });

  it('should treat null cache as stale', () => {
    expect(isDataStale(null)).toBe(true);
    expect(isDataStale(undefined)).toBe(true);
  });

  it('should treat missing lastUpdateTs as stale', () => {
    const cache: CandleCache = {
      data: [{ close: 100 }],
      lastUpdateTs: 0,
    };

    expect(isDataStale(cache)).toBe(true);
  });

  it('should return null data when stale', () => {
    const cache: CandleCache = {
      data: [{ close: 100 }],
      lastUpdateTs: Date.now() - (3 * 60 * 1000), // 3 minutes ago
    };

    const result = getDataWithStalenessCheck(cache);

    expect(result.isStale).toBe(true);
    expect(result.data).toBeNull();
    expect(result.ageMs).toBeGreaterThan(MAX_STALENESS_MS);
  });

  it('should return data when fresh', () => {
    const cache: CandleCache = {
      data: [{ close: 100 }],
      lastUpdateTs: Date.now() - 30000, // 30 seconds ago
    };

    const result = getDataWithStalenessCheck(cache);

    expect(result.isStale).toBe(false);
    expect(result.data).toEqual([{ close: 100 }]);
    expect(result.ageMs).toBeLessThan(MAX_STALENESS_MS);
  });
});
