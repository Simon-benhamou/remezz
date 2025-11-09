/**
 * Example Unit Test - Data Validation
 * 
 * This demonstrates how to write unit tests for data validation logic.
 */

import { describe, it, expect } from '@jest/globals';

/**
 * Example function: Validate trading symbol format
 */
function validateSymbol(symbol: string): boolean {
  if (!symbol || typeof symbol !== 'string') return false;
  const parts = symbol.split('/');
  if (parts.length !== 2) return false;
  return parts[0].length > 0 && parts[1].length > 0;
}

/**
 * Example function: Validate order amount
 */
function validateOrderAmount(amount: number, minAmount: number = 0.001, maxAmount: number = 1000000): boolean {
  if (typeof amount !== 'number' || isNaN(amount)) return false;
  if (amount <= 0) return false;
  if (amount < minAmount || amount > maxAmount) return false;
  return true;
}

/**
 * Example function: Validate price
 */
function validatePrice(price: number): boolean {
  if (typeof price !== 'number' || isNaN(price)) return false;
  if (price <= 0) return false;
  if (!isFinite(price)) return false;
  return true;
}

describe('Data Validation Tests', () => {
  describe('validateSymbol', () => {
    it('should accept valid symbol format', () => {
      expect(validateSymbol('BTC/USDT')).toBe(true);
      expect(validateSymbol('ETH/BTC')).toBe(true);
      expect(validateSymbol('SOL/USDT')).toBe(true);
    });

    it('should reject invalid symbol formats', () => {
      expect(validateSymbol('BTCUSDT')).toBe(false);
      expect(validateSymbol('BTC/USDT/EUR')).toBe(false);
      expect(validateSymbol('BTC/')).toBe(false);
      expect(validateSymbol('/USDT')).toBe(false);
    });

    it('should reject non-string inputs', () => {
      expect(validateSymbol(null as any)).toBe(false);
      expect(validateSymbol(undefined as any)).toBe(false);
      expect(validateSymbol(123 as any)).toBe(false);
    });

    it('should reject empty strings', () => {
      expect(validateSymbol('')).toBe(false);
      expect(validateSymbol('/')).toBe(false);
    });
  });

  describe('validateOrderAmount', () => {
    it('should accept valid amounts', () => {
      expect(validateOrderAmount(0.001)).toBe(true);
      expect(validateOrderAmount(1)).toBe(true);
      expect(validateOrderAmount(100)).toBe(true);
      expect(validateOrderAmount(1000)).toBe(true);
    });

    it('should reject zero and negative amounts', () => {
      expect(validateOrderAmount(0)).toBe(false);
      expect(validateOrderAmount(-1)).toBe(false);
      expect(validateOrderAmount(-100)).toBe(false);
    });

    it('should respect minimum amount', () => {
      expect(validateOrderAmount(0.0001, 0.001)).toBe(false);
      expect(validateOrderAmount(0.001, 0.001)).toBe(true);
      expect(validateOrderAmount(0.01, 0.001)).toBe(true);
    });

    it('should respect maximum amount', () => {
      expect(validateOrderAmount(1000001, 0.001, 1000000)).toBe(false);
      expect(validateOrderAmount(1000000, 0.001, 1000000)).toBe(true);
      expect(validateOrderAmount(999999, 0.001, 1000000)).toBe(true);
    });

    it('should reject invalid number types', () => {
      expect(validateOrderAmount(NaN)).toBe(false);
      expect(validateOrderAmount('100' as any)).toBe(false);
      expect(validateOrderAmount(null as any)).toBe(false);
    });
  });

  describe('validatePrice', () => {
    it('should accept valid prices', () => {
      expect(validatePrice(0.01)).toBe(true);
      expect(validatePrice(1)).toBe(true);
      expect(validatePrice(50000)).toBe(true);
      expect(validatePrice(0.000001)).toBe(true);
    });

    it('should reject zero and negative prices', () => {
      expect(validatePrice(0)).toBe(false);
      expect(validatePrice(-1)).toBe(false);
      expect(validatePrice(-100.50)).toBe(false);
    });

    it('should reject invalid numbers', () => {
      expect(validatePrice(NaN)).toBe(false);
      expect(validatePrice(Infinity)).toBe(false);
      expect(validatePrice(-Infinity)).toBe(false);
    });

    it('should reject non-number types', () => {
      expect(validatePrice('50000' as any)).toBe(false);
      expect(validatePrice(null as any)).toBe(false);
      expect(validatePrice(undefined as any)).toBe(false);
    });
  });
});

describe('Integration: Order Validation', () => {
  interface Order {
    symbol: string;
    side: 'buy' | 'sell';
    amount: number;
    price: number;
  }

  function validateOrder(order: Order): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!validateSymbol(order.symbol)) {
      errors.push('Invalid symbol format');
    }

    if (!['buy', 'sell'].includes(order.side)) {
      errors.push('Invalid order side');
    }

    if (!validateOrderAmount(order.amount)) {
      errors.push('Invalid order amount');
    }

    if (!validatePrice(order.price)) {
      errors.push('Invalid price');
    }

    return { valid: errors.length === 0, errors };
  }

  it('should validate complete valid order', () => {
    const order: Order = {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.1,
      price: 50000,
    };

    const result = validateOrder(order);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should collect all validation errors', () => {
    const order: Order = {
      symbol: 'INVALID',
      side: 'long' as any,
      amount: -1,
      price: 0,
    };

    const result = validateOrder(order);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(4);
    expect(result.errors).toContain('Invalid symbol format');
    expect(result.errors).toContain('Invalid order side');
    expect(result.errors).toContain('Invalid order amount');
    expect(result.errors).toContain('Invalid price');
  });

  it('should pass with valid sell order', () => {
    const order: Order = {
      symbol: 'ETH/BTC',
      side: 'sell',
      amount: 1.5,
      price: 0.05,
    };

    const result = validateOrder(order);
    expect(result.valid).toBe(true);
  });
});
