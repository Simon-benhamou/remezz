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