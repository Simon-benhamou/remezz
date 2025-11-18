/**
 * Utility functions for safe number formatting and operations
 */

/**
 * Safely formats a number to a specified number of decimal places
 * Returns '0.00' (or appropriate format) if the value is null, undefined, or NaN
 */
export function safeToFixed(value: any, decimals: number = 2): string {
  const num = Number(value);
  if (isNaN(num) || !isFinite(num)) {
    return '0.' + '0'.repeat(decimals);
  }
  return num.toFixed(decimals);
}

/**
 * Safely converts a value to a number, returning a default if invalid
 */
export function safeNumber(value: any, defaultValue: number = 0): number {
  const num = Number(value);
  return isNaN(num) || !isFinite(num) ? defaultValue : num;
}

/**
 * Safely formats a percentage with sign
 */
export function safePercent(value: any, decimals: number = 1): string {
  const num = safeNumber(value);
  const formatted = safeToFixed(num, decimals);
  return num >= 0 ? `+${formatted}%` : `${formatted}%`;
}

/**
 * Safely formats a price with currency symbol
 */
export function safePrice(value: any, currency: string = '$', decimals: number = 2): string {
  return `${currency}${safeToFixed(value, decimals)}`;
}

/**
 * Safely calculates a percentage between two values
 */
export function safePercentChange(current: any, reference: any): number {
  const curr = safeNumber(current);
  const ref = safeNumber(reference);
  
  if (ref === 0) return 0;
  return ((curr - ref) / ref) * 100;
}

/**
 * Safely formats a leverage value
 */
export function safeLeverage(value: any): string {
  const num = safeNumber(value, 1);
  return `${safeToFixed(num, 1)}x`;
}

/**
 * Intelligently formats a price based on its magnitude
 * - >= $1000: 2 decimals (e.g., $1,234.56)
 * - >= $1: 4 decimals (e.g., $12.3456)
 * - >= $0.01: 6 decimals (e.g., $0.123456)
 * - < $0.01: 8 decimals (e.g., $0.00384280)
 */
export function formatPriceDisplay(value: any): string {
  const num = safeNumber(value);
  
  if (num === 0) return '0.00';
  
  const absNum = Math.abs(num);
  
  if (absNum >= 1000) {
    return num.toFixed(2);
  } else if (absNum >= 1) {
    return num.toFixed(4);
  } else if (absNum >= 0.01) {
    return num.toFixed(6);
  } else {
    return num.toFixed(8);
  }
}

/**
 * Formats price with appropriate decimals and adds $ prefix
 */
export function formatPriceWithCurrency(value: any, currency: string = '$'): string {
  return `${currency}${formatPriceDisplay(value)}`;
}