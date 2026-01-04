/**
 * Multi-Position Scaling Configuration
 *
 * This config controls how the system handles capital allocation for large accounts.
 * See MULTI_POSITION_SCALING.md for full documentation.
 */

import { type MultiPositionConfig } from '../strategies/multiPositionScaling.js';

/**
 * Enable/disable multi-position scaling globally
 *
 * Set to false to revert to single-position behavior (legacy V5.18)
 * Set to true to enable multi-position scaling (V5.30)
 */
export const MULTI_POSITION_ENABLED = process.env.MULTI_POSITION_ENABLED === 'true';

/**
 * Multi-Position Configuration
 *
 * Adjust these values to control:
 * - When multi-position kicks in (minCapitalForMulti)
 * - How many positions per symbol based on capital (capitalTiers)
 * - Entry price spread (minEntrySpreadPct, maxEntrySpreadPct)
 * - Timing between entries (entryDelayMs)
 */
export const MULTI_POSITION_CONFIG: MultiPositionConfig = {
  // Enable/disable (can also use MULTI_POSITION_ENABLED flag above)
  enabled: MULTI_POSITION_ENABLED,

  // Minimum capital to activate multi-position
  // Below this threshold, use single positions (no benefit for small accounts)
  minCapitalForMulti: Number(process.env.MULTI_POSITION_MIN_CAPITAL) || 30_000,

  /**
   * Capital-based position scaling tiers
   *
   * Format: { [minCapital]: maxPositions }
   *
   * Example:
   * - $30K account: 2 positions max per symbol
   * - $75K account: 3 positions max per symbol
   * - $150K account: 4 positions max per symbol
   * - $300K+ account: 5 positions max per symbol
   *
   * Why these tiers?
   * - Below $30K: Single positions work fine (no liquidity issues)
   * - $30K-$75K: 2 positions overcome LOW-tier caps ($25K)
   * - $75K-$150K: 3 positions maximize MEDIUM-tier usage
   * - $150K+: 4-5 positions for optimal HIGH-tier allocation
   */
  capitalTiers: {
    30_000: 2,   // $30K-$75K: 2 positions
    75_000: 3,   // $75K-$150K: 3 positions
    150_000: 4,  // $150K-$300K: 4 positions
    300_000: 5,  // $300K+: 5 positions
  },

  /**
   * Entry price spread configuration
   *
   * Controls how far apart entry prices are for multiple positions.
   *
   * Benefits of price spreading:
   * 1. Better average entry price (dollar-cost averaging effect)
   * 2. Reduced timing risk (not all eggs in one basket)
   * 3. Lower market impact (entries spread across price levels)
   *
   * Example with SEI @ $0.45:
   * - minSpreadPct: 0.3% → entries at $0.4500, $0.4486, $0.4473
   * - maxSpreadPct: 1.5% → entries at $0.4500, $0.4467, $0.4433
   */
  minEntrySpreadPct: Number(process.env.MULTI_POSITION_MIN_SPREAD) || 0.3,  // 0.3% minimum
  maxEntrySpreadPct: Number(process.env.MULTI_POSITION_MAX_SPREAD) || 1.5,  // 1.5% maximum

  /**
   * Time delay between placing orders (milliseconds)
   *
   * Prevents market impact by spacing out order submissions.
   * Also helps avoid exchange rate limits.
   *
   * Recommended:
   * - 30 seconds: Good balance (default)
   * - 60 seconds: Conservative (very low liquidity)
   * - 15 seconds: Aggressive (high liquidity only)
   */
  entryDelayMs: Number(process.env.MULTI_POSITION_ENTRY_DELAY) || 30_000, // 30 seconds
};

/**
 * Advanced: Per-symbol position overrides
 *
 * Use this to customize multi-position behavior for specific symbols.
 * Useful if certain cryptos need different configuration.
 *
 * Example:
 * 'SEI/USDT:USDT': { maxPositions: 3, minSpreadPct: 0.5 }
 */
export const SYMBOL_OVERRIDES: Record<string, Partial<MultiPositionConfig>> = {
  // Example: Force BTC to always use single position (it rarely hits caps anyway)
  // 'BTC/USDT:USDT': { enabled: false },

  // Example: Use wider spread for very volatile coins
  // 'DOGE/USDT:USDT': { minEntrySpreadPct: 0.5, maxEntrySpreadPct: 2.0 },
};

/**
 * Get multi-position config for a specific symbol
 *
 * @param symbol - Trading symbol
 * @returns Config with symbol-specific overrides applied
 */
export function getMultiPositionConfig(symbol: string): MultiPositionConfig {
  const override = SYMBOL_OVERRIDES[symbol];
  if (!override) {
    return MULTI_POSITION_CONFIG;
  }

  return {
    ...MULTI_POSITION_CONFIG,
    ...override,
  };
}

/**
 * Environment variable reference:
 *
 * MULTI_POSITION_ENABLED=true|false
 *   - Enable/disable multi-position scaling globally
 *
 * MULTI_POSITION_MIN_CAPITAL=30000
 *   - Minimum capital (USD) to activate multi-position
 *
 * MULTI_POSITION_MIN_SPREAD=0.3
 *   - Minimum entry price spread (%)
 *
 * MULTI_POSITION_MAX_SPREAD=1.5
 *   - Maximum entry price spread (%)
 *
 * MULTI_POSITION_ENTRY_DELAY=30000
 *   - Delay between orders (milliseconds)
 *
 * Example .env:
 * ```
 * MULTI_POSITION_ENABLED=true
 * MULTI_POSITION_MIN_CAPITAL=50000
 * MULTI_POSITION_MIN_SPREAD=0.5
 * MULTI_POSITION_MAX_SPREAD=2.0
 * MULTI_POSITION_ENTRY_DELAY=60000
 * ```
 */
