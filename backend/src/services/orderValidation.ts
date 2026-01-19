/**
 * Order Validation Service - V5.65
 *
 * Validates orders BEFORE submission to exchange to prevent:
 * - LOT_SIZE errors (minQty, maxQty, stepSize)
 * - MIN_NOTIONAL errors (minimum position value $5 on Binance)
 * - Invalid symbol errors
 * - Precision errors
 *
 * This prevents wasted API calls and protects against edge cases.
 */

import { createLogger } from '../utils/logger.js';
import { areMarketsLoaded } from '../exchange/ccxtClient.js';

const logger = createLogger('order-validation');

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: 'INVALID_SYMBOL' | 'MIN_QTY' | 'MAX_QTY' | 'STEP_SIZE' | 'MIN_NOTIONAL' | 'INVALID_SIDE' | 'INVALID_TYPE';
  adjustedQty?: number;  // Quantity adjusted to valid step size
  details?: {
    minQty?: number;
    maxQty?: number;
    stepSize?: number;
    minNotional?: number;
    actualNotional?: number;
    actualQty?: number;
  };
}

export interface OrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  price?: number;
}

// ============================================================================
// Default Limits (fallback when markets not loaded)
// ============================================================================

// Known Binance Futures limits for common symbols
// Format: symbol -> { minQty, maxQty, stepSize, minNotional }
const KNOWN_LIMITS: Record<string, { minQty: number; maxQty: number; stepSize: number; minNotional: number }> = {
  'BTC/USDT:USDT':   { minQty: 0.001, maxQty: 500,    stepSize: 0.001, minNotional: 5 },
  'ETH/USDT:USDT':   { minQty: 0.001, maxQty: 10000,  stepSize: 0.001, minNotional: 5 },
  'SOL/USDT:USDT':   { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'SUI/USDT:USDT':   { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'SEI/USDT:USDT':   { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
  'IMX/USDT:USDT':   { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'XRP/USDT:USDT':   { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'DOGE/USDT:USDT':  { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
  'ADA/USDT:USDT':   { minQty: 0.1,   maxQty: 10000000, stepSize: 0.1, minNotional: 5 },
  'AVAX/USDT:USDT':  { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'DOT/USDT:USDT':   { minQty: 0.1,   maxQty: 100000, stepSize: 0.1,   minNotional: 5 },
  'LINK/USDT:USDT':  { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'ATOM/USDT:USDT':  { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'APT/USDT:USDT':   { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'LTC/USDT:USDT':   { minQty: 0.001, maxQty: 10000,  stepSize: 0.001, minNotional: 5 },
  'BCH/USDT:USDT':   { minQty: 0.001, maxQty: 10000,  stepSize: 0.001, minNotional: 5 },
  'UNI/USDT:USDT':   { minQty: 0.1,   maxQty: 100000, stepSize: 0.1,   minNotional: 5 },
  'MATIC/USDT:USDT': { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
  'ARB/USDT:USDT':   { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'OP/USDT:USDT':    { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'NEAR/USDT:USDT':  { minQty: 0.1,   maxQty: 100000, stepSize: 0.1,   minNotional: 5 },
  'FIL/USDT:USDT':   { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'AAVE/USDT:USDT':  { minQty: 0.001, maxQty: 10000,  stepSize: 0.001, minNotional: 5 },
  'PEPE/USDT:USDT':  { minQty: 1000,  maxQty: 100000000000, stepSize: 1000, minNotional: 5 },
  'SHIB/USDT:USDT':  { minQty: 1000,  maxQty: 100000000000, stepSize: 1000, minNotional: 5 },
  'FLOKI/USDT:USDT': { minQty: 1000,  maxQty: 100000000000, stepSize: 1000, minNotional: 5 },
  'WIF/USDT:USDT':   { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'BONK/USDT:USDT':  { minQty: 10000, maxQty: 100000000000, stepSize: 10000, minNotional: 5 },
  'INJ/USDT:USDT':   { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'TIA/USDT:USDT':   { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'JUP/USDT:USDT':   { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'PYTH/USDT:USDT':  { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
  'SONIC/USDT:USDT': { minQty: 0.1,   maxQty: 1000000, stepSize: 0.1,  minNotional: 5 },
  'TRX/USDT:USDT':   { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
  'ETC/USDT:USDT':   { minQty: 0.01,  maxQty: 100000, stepSize: 0.01,  minNotional: 5 },
  'XLM/USDT:USDT':   { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
  'HBAR/USDT:USDT':  { minQty: 1,     maxQty: 10000000, stepSize: 1,   minNotional: 5 },
};

// Default limits for unknown symbols
const DEFAULT_LIMITS = {
  minQty: 0.001,
  maxQty: 100000,
  stepSize: 0.001,
  minNotional: 5,
};

// ============================================================================
// Main Validation Functions
// ============================================================================

/**
 * Get limits for a symbol (from exchange markets or fallback)
 */
export function getSymbolLimits(symbol: string, markets?: Record<string, any>): {
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional: number;
  source: 'exchange' | 'known' | 'default';
} {
  // Try to get from exchange markets first
  if (markets && markets[symbol]) {
    const market = markets[symbol];
    const limits = market.limits || {};
    const precision = market.precision || {};

    // Extract step size from precision (CCXT format varies)
    let stepSize = DEFAULT_LIMITS.stepSize;
    if (precision.amount !== undefined) {
      // CCXT can store precision as decimal places (3) or step size (0.001)
      if (Number.isInteger(precision.amount) && precision.amount > 0) {
        stepSize = Math.pow(10, -precision.amount);
      } else if (precision.amount > 0 && precision.amount < 1) {
        stepSize = precision.amount;
      }
    }

    return {
      minQty: limits.amount?.min ?? DEFAULT_LIMITS.minQty,
      maxQty: limits.amount?.max ?? DEFAULT_LIMITS.maxQty,
      stepSize,
      minNotional: limits.cost?.min ?? DEFAULT_LIMITS.minNotional,
      source: 'exchange',
    };
  }

  // Try known limits
  if (KNOWN_LIMITS[symbol]) {
    return { ...KNOWN_LIMITS[symbol], source: 'known' };
  }

  // Default fallback
  logger.warn(`⚠️ [${symbol}] Using default limits (symbol not in known list)`);
  return { ...DEFAULT_LIMITS, source: 'default' };
}

/**
 * Adjust quantity to valid step size
 */
export function adjustQtyToStepSize(qty: number, stepSize: number): number {
  // Use floor to ensure we don't exceed available quantity
  const steps = Math.floor(qty / stepSize);
  const adjusted = steps * stepSize;

  // Handle floating point precision issues
  const decimals = stepSize.toString().split('.')[1]?.length || 0;
  return Number(adjusted.toFixed(decimals));
}

/**
 * Validate an order before submission
 * Returns validation result with potential adjusted quantity
 */
export function validateOrder(
  order: OrderParams,
  markets?: Record<string, any>,
  currentPrice?: number
): ValidationResult {
  const { symbol, side, type, quantity, price } = order;

  // 1. Validate side
  if (!['buy', 'sell'].includes(side)) {
    return {
      valid: false,
      error: `Invalid side: ${side}. Must be 'buy' or 'sell'`,
      errorCode: 'INVALID_SIDE',
    };
  }

  // 2. Validate type
  if (!['market', 'limit'].includes(type)) {
    return {
      valid: false,
      error: `Invalid type: ${type}. Must be 'market' or 'limit'`,
      errorCode: 'INVALID_TYPE',
    };
  }

  // 3. Get limits for this symbol
  const limits = getSymbolLimits(symbol, markets);

  // 4. Validate quantity against limits
  if (quantity <= 0) {
    return {
      valid: false,
      error: `Quantity must be positive: ${quantity}`,
      errorCode: 'MIN_QTY',
      details: { actualQty: quantity, minQty: limits.minQty },
    };
  }

  if (quantity < limits.minQty) {
    return {
      valid: false,
      error: `Quantity ${quantity} below minimum ${limits.minQty} for ${symbol}`,
      errorCode: 'MIN_QTY',
      details: { actualQty: quantity, minQty: limits.minQty, maxQty: limits.maxQty },
    };
  }

  if (quantity > limits.maxQty) {
    return {
      valid: false,
      error: `Quantity ${quantity} exceeds maximum ${limits.maxQty} for ${symbol}`,
      errorCode: 'MAX_QTY',
      details: { actualQty: quantity, minQty: limits.minQty, maxQty: limits.maxQty },
    };
  }

  // 5. Adjust quantity to step size
  const adjustedQty = adjustQtyToStepSize(quantity, limits.stepSize);

  // Check if adjusted quantity is still valid
  if (adjustedQty < limits.minQty) {
    return {
      valid: false,
      error: `Adjusted quantity ${adjustedQty} (from ${quantity}) below minimum ${limits.minQty} for ${symbol}`,
      errorCode: 'STEP_SIZE',
      details: {
        actualQty: quantity,
        minQty: limits.minQty,
        stepSize: limits.stepSize,
      },
    };
  }

  // 6. Validate minimum notional (position value)
  // Use provided price, or estimate from order type
  const effectivePrice = price || currentPrice;

  if (effectivePrice) {
    const notional = adjustedQty * effectivePrice;

    if (notional < limits.minNotional) {
      return {
        valid: false,
        error: `Notional $${notional.toFixed(2)} below minimum $${limits.minNotional} for ${symbol}`,
        errorCode: 'MIN_NOTIONAL',
        details: {
          actualNotional: notional,
          minNotional: limits.minNotional,
          actualQty: adjustedQty,
        },
      };
    }
  }

  // 7. Validation passed
  return {
    valid: true,
    adjustedQty: adjustedQty !== quantity ? adjustedQty : undefined,
    details: {
      minQty: limits.minQty,
      maxQty: limits.maxQty,
      stepSize: limits.stepSize,
      minNotional: limits.minNotional,
      actualQty: adjustedQty,
      actualNotional: effectivePrice ? adjustedQty * effectivePrice : undefined,
    },
  };
}

/**
 * Validate symbol exists on exchange
 */
export function validateSymbol(symbol: string, markets?: Record<string, any>): ValidationResult {
  // If markets not loaded, allow the symbol (will fail at exchange level if invalid)
  if (!markets || !areMarketsLoaded()) {
    logger.debug(`[${symbol}] Markets not loaded, skipping symbol validation`);
    return { valid: true };
  }

  // Check if symbol exists in markets
  if (!markets[symbol]) {
    // Try common variations
    const variations = [
      symbol,
      symbol.replace('/', ''),
      symbol + ':USDT',
      symbol.replace(':USDT', ''),
    ];

    const found = variations.some(v => markets[v]);

    if (!found) {
      return {
        valid: false,
        error: `Symbol ${symbol} not found on exchange`,
        errorCode: 'INVALID_SYMBOL',
      };
    }
  }

  // Check if symbol is active
  const market = markets[symbol];
  if (market && market.active === false) {
    return {
      valid: false,
      error: `Symbol ${symbol} is not active on exchange`,
      errorCode: 'INVALID_SYMBOL',
    };
  }

  return { valid: true };
}

/**
 * Full order validation (symbol + quantity + notional)
 */
export function validateOrderComplete(
  order: OrderParams,
  markets?: Record<string, any>,
  currentPrice?: number
): ValidationResult {
  // 1. Validate symbol first
  const symbolValidation = validateSymbol(order.symbol, markets);
  if (!symbolValidation.valid) {
    return symbolValidation;
  }

  // 2. Validate order parameters
  return validateOrder(order, markets, currentPrice);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate minimum quantity for a given notional value
 */
export function calcMinQtyForNotional(
  symbol: string,
  price: number,
  targetNotional: number = 5,
  markets?: Record<string, any>
): number {
  const limits = getSymbolLimits(symbol, markets);

  // Calculate raw quantity needed for target notional
  const rawQty = targetNotional / price;

  // Adjust to step size (round up to ensure we meet min notional)
  const steps = Math.ceil(rawQty / limits.stepSize);
  const adjustedQty = steps * limits.stepSize;

  // Ensure we're above minQty
  return Math.max(adjustedQty, limits.minQty);
}

/**
 * Log validation error for monitoring
 */
export function logValidationError(
  symbol: string,
  result: ValidationResult,
  context: string
): void {
  if (!result.valid) {
    logger.error(`❌ [${symbol}] VALIDATION FAILED (${context}):`, {
      error: result.error,
      errorCode: result.errorCode,
      details: result.details,
    });
  }
}
