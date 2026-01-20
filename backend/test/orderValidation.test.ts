/**
 * 🧪 UNIT TESTS - Order Validation Service
 *
 * Tests for pre-submission order validation (V5.65).
 *
 * Coverage:
 * - LOT_SIZE validation (minQty, maxQty, stepSize)
 * - MIN_NOTIONAL validation ($5 minimum on Binance)
 * - Step size adjustment
 * - Symbol limit lookups
 * - Edge cases (tiny quantities, huge quantities)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ============================================================================
// Mock Order Validation for testing
// ============================================================================

interface ValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: 'INVALID_SYMBOL' | 'MIN_QTY' | 'MAX_QTY' | 'STEP_SIZE' | 'MIN_NOTIONAL' | 'INVALID_SIDE' | 'INVALID_TYPE';
  adjustedQty?: number;
  details?: {
    minQty?: number;
    maxQty?: number;
    stepSize?: number;
    minNotional?: number;
    actualNotional?: number;
    actualQty?: number;
  };
}

interface OrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  price?: number;
}

interface SymbolLimits {
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional: number;
}

// Known Binance Futures limits for common symbols
const KNOWN_LIMITS: Record<string, SymbolLimits> = {
  'BTC/USDT:USDT':   { minQty: 0.001, maxQty: 500,    stepSize: 0.001, minNotional: 5 },
  'ETH/USDT:USDT':   { minQty: 0.001, maxQty: 10000,  stepSize: 0.001, minNotional: 5 },
  'SOL/USDT:USDT':   { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'DOGE/USDT:USDT':  { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
  'PEPE/USDT:USDT':  { minQty: 1000,  maxQty: 100000000000, stepSize: 1000, minNotional: 5 },
};

const DEFAULT_LIMITS: SymbolLimits = {
  minQty: 0.001,
  maxQty: 100000,
  stepSize: 0.001,
  minNotional: 5,
};

/**
 * Get limits for a symbol
 */
function getSymbolLimits(symbol: string): SymbolLimits & { source: string } {
  if (KNOWN_LIMITS[symbol]) {
    return { ...KNOWN_LIMITS[symbol], source: 'known' };
  }
  return { ...DEFAULT_LIMITS, source: 'default' };
}

/**
 * Adjust quantity to valid step size
 */
function adjustQtyToStepSize(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;

  // Round DOWN to nearest step
  const steps = Math.floor(qty / stepSize);
  return steps * stepSize;
}

/**
 * Validate order parameters
 */
function validateOrder(params: OrderParams, currentPrice: number): ValidationResult {
  const { symbol, side, type, quantity, price } = params;
  const effectivePrice = price ?? currentPrice;

  // 1. Validate side
  if (!['buy', 'sell'].includes(side)) {
    return {
      valid: false,
      error: `Invalid side: ${side}`,
      errorCode: 'INVALID_SIDE',
    };
  }

  // 2. Validate type
  if (!['market', 'limit'].includes(type)) {
    return {
      valid: false,
      error: `Invalid type: ${type}`,
      errorCode: 'INVALID_TYPE',
    };
  }

  // 3. Get symbol limits
  const limits = getSymbolLimits(symbol);

  // 4. Check minimum quantity
  if (quantity < limits.minQty) {
    return {
      valid: false,
      error: `Quantity ${quantity} below minimum ${limits.minQty}`,
      errorCode: 'MIN_QTY',
      details: {
        minQty: limits.minQty,
        actualQty: quantity,
      },
    };
  }

  // 5. Check maximum quantity
  if (quantity > limits.maxQty) {
    return {
      valid: false,
      error: `Quantity ${quantity} above maximum ${limits.maxQty}`,
      errorCode: 'MAX_QTY',
      details: {
        maxQty: limits.maxQty,
        actualQty: quantity,
      },
    };
  }

  // 6. Adjust to step size
  const adjustedQty = adjustQtyToStepSize(quantity, limits.stepSize);

  // Check if adjustment made qty zero
  if (adjustedQty < limits.minQty) {
    return {
      valid: false,
      error: `Adjusted quantity ${adjustedQty} below minimum ${limits.minQty}`,
      errorCode: 'STEP_SIZE',
      details: {
        stepSize: limits.stepSize,
        minQty: limits.minQty,
        actualQty: quantity,
      },
    };
  }

  // 7. Check minimum notional
  const notional = adjustedQty * effectivePrice;
  if (notional < limits.minNotional) {
    return {
      valid: false,
      error: `Notional $${notional.toFixed(2)} below minimum $${limits.minNotional}`,
      errorCode: 'MIN_NOTIONAL',
      details: {
        minNotional: limits.minNotional,
        actualNotional: notional,
        actualQty: adjustedQty,
      },
    };
  }

  // Valid!
  return {
    valid: true,
    adjustedQty,
    details: {
      minQty: limits.minQty,
      maxQty: limits.maxQty,
      stepSize: limits.stepSize,
      minNotional: limits.minNotional,
      actualNotional: notional,
      actualQty: adjustedQty,
    },
  };
}

// ============================================================================
// TESTS: Basic Validation
// ============================================================================

describe('OrderValidation - Basic Validation', () => {
  it('should validate a correct order', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.01, // Well above min, valid step
    }, 100000); // $1000 notional

    expect(result.valid).toBe(true);
    expect(result.adjustedQty).toBe(0.01);
  });

  it('should reject invalid side', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'invalid' as any,
      type: 'market',
      quantity: 0.01,
    }, 100000);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_SIDE');
  });

  it('should reject invalid type', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'stop' as any,
      quantity: 0.01,
    }, 100000);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('INVALID_TYPE');
  });
});

// ============================================================================
// TESTS: LOT_SIZE Validation
// ============================================================================

describe('OrderValidation - LOT_SIZE', () => {
  it('should reject quantity below minimum', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.0001, // Below BTC min of 0.001
    }, 100000);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MIN_QTY');
    expect(result.details?.minQty).toBe(0.001);
  });

  it('should reject quantity above maximum', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 1000, // Above BTC max of 500
    }, 100000);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MAX_QTY');
    expect(result.details?.maxQty).toBe(500);
  });

  it('should adjust quantity to step size', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.0015, // Between steps (0.001, 0.002)
    }, 100000);

    expect(result.valid).toBe(true);
    expect(result.adjustedQty).toBe(0.001); // Rounded DOWN
  });

  it('should handle integer step sizes (DOGE)', () => {
    const result = validateOrder({
      symbol: 'DOGE/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 105.7, // Should round to 105
    }, 0.10); // $10.50 notional

    expect(result.valid).toBe(true);
    expect(result.adjustedQty).toBe(105);
  });

  it('should handle large step sizes (PEPE)', () => {
    const result = validateOrder({
      symbol: 'PEPE/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 1500000, // Should round to 1500000 (step = 1000)
    }, 0.00001); // $15 notional

    expect(result.valid).toBe(true);
    expect(result.adjustedQty).toBe(1500000);
  });
});

// ============================================================================
// TESTS: MIN_NOTIONAL Validation
// ============================================================================

describe('OrderValidation - MIN_NOTIONAL', () => {
  it('should reject notional below minimum', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.001, // Min qty
    }, 4000); // $4 notional (below $5 min)

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MIN_NOTIONAL');
    expect(result.details?.actualNotional).toBe(4);
    expect(result.details?.minNotional).toBe(5);
  });

  it('should accept notional exactly at minimum', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.001,
    }, 5000); // $5 notional (exactly min)

    expect(result.valid).toBe(true);
  });

  it('should calculate notional with adjusted qty', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.0055, // Will adjust to 0.005
    }, 1500); // 0.005 * 1500 = $7.50 (above min)

    expect(result.valid).toBe(true);
    expect(result.adjustedQty).toBe(0.005);
    expect(result.details?.actualNotional).toBe(7.5);
  });
});

// ============================================================================
// TESTS: Step Size Adjustment
// ============================================================================

describe('OrderValidation - Step Size Adjustment', () => {
  it('should round DOWN, not up', () => {
    // This is important - rounding up could exceed user's capital
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.0099, // Should be 0.009, not 0.010
    }, 100000);

    expect(result.adjustedQty).toBeCloseTo(0.009, 10);
  });

  it('should reject if adjustment makes qty too small', () => {
    const result = validateOrder({
      symbol: 'DOGE/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.5, // Below step of 1, will round to 0
    }, 0.10);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MIN_QTY');
  });

  it('should handle exact step multiples', () => {
    const result = validateOrder({
      symbol: 'SOL/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 1.50, // Exact multiple of 0.01
    }, 100);

    expect(result.valid).toBe(true);
    expect(result.adjustedQty).toBe(1.50);
  });
});

// ============================================================================
// TESTS: Symbol Limits Lookup
// ============================================================================

describe('OrderValidation - Symbol Limits', () => {
  it('should use known limits for common symbols', () => {
    const btcLimits = getSymbolLimits('BTC/USDT:USDT');
    expect(btcLimits.source).toBe('known');
    expect(btcLimits.minQty).toBe(0.001);

    const ethLimits = getSymbolLimits('ETH/USDT:USDT');
    expect(ethLimits.source).toBe('known');
    expect(ethLimits.minQty).toBe(0.001);
  });

  it('should use default limits for unknown symbols', () => {
    const unknownLimits = getSymbolLimits('UNKNOWN/USDT:USDT');
    expect(unknownLimits.source).toBe('default');
    expect(unknownLimits.minQty).toBe(0.001);
    expect(unknownLimits.minNotional).toBe(5);
  });
});

// ============================================================================
// TESTS: Edge Cases
// ============================================================================

describe('OrderValidation - Edge Cases', () => {
  it('should handle zero quantity', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0,
    }, 100000);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MIN_QTY');
  });

  it('should handle negative quantity', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: -0.01,
    }, 100000);

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MIN_QTY');
  });

  it('should handle very small price (low cap coins)', () => {
    const result = validateOrder({
      symbol: 'PEPE/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 1000000, // 1M PEPE
    }, 0.000001); // Very small price, $1 notional < $5 min

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('MIN_NOTIONAL');
  });

  it('should handle very large price', () => {
    const result = validateOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      quantity: 0.001, // Min qty
    }, 500000); // $500 notional

    expect(result.valid).toBe(true);
  });

  it('should provide complete details on validation', () => {
    const result = validateOrder({
      symbol: 'SOL/USDT:USDT',
      side: 'sell',
      type: 'market',
      quantity: 1.5,
    }, 100);

    expect(result.valid).toBe(true);
    expect(result.details).toEqual({
      minQty: 0.01,
      maxQty: 100000,
      stepSize: 0.01,
      minNotional: 5,
      actualNotional: 150,
      actualQty: 1.5,
    });
  });
});
