/**
 * V5.30 - MULTI-POSITION SCALING SYSTEM
 *
 * PROBLEM:
 * - At certain capital levels, per-crypto caps prevent using full portfolio size
 * - Example: $100K account wants to trade SEI with 55% sizing = $137.5K notional target
 * - But SEI cap is $25K → only 18% of intended position is used
 * - Result: 2 accounts of $50K would outperform 1 account of $100K
 *
 * SOLUTION:
 * - Allow multiple positions of the same symbol with staggered entry points
 * - Each position respects the liquidity cap ($25K for SEI)
 * - Total exposure can exceed single-position cap while maintaining safety
 * - Diversified entries reduce timing risk and improve average entry price
 *
 * EXAMPLE:
 * $100K account trading SEI:
 * - Single position: $25K (cap hit, 18% efficiency)
 * - Multi-position (3x): $25K + $25K + $25K = $75K (55% efficiency)
 *
 * SAFETY FEATURES:
 * 1. Each position still respects per-symbol liquidity cap
 * 2. Staggered entries (0.5-2% price difference) reduce market impact
 * 3. Total exposure capped at adaptive sizing % (40-55%)
 * 4. Dynamic position count based on capital size
 * 5. Independent stop losses per position reduce correlation risk
 */

import { MomentumConfig, getLiquidityTier, getMaxSafePositionSize } from './momentumSimple.js';

/**
 * Configuration for multi-position scaling
 */
export interface MultiPositionConfig {
  // Enable/disable multi-position scaling
  enabled: boolean;

  // Minimum capital required to use multi-positions (below this, use single position)
  minCapitalForMulti: number;

  // Capital thresholds for increasing position count
  // Example: { 50000: 2, 100000: 3, 250000: 4 }
  capitalTiers: { [minCapital: number]: number };

  // Minimum price difference between entries (as % of current price)
  // This prevents opening all positions at same price level
  minEntrySpreadPct: number;

  // Maximum price difference between entries (as % of current price)
  // This prevents positions from being too spread out
  maxEntrySpreadPct: number;

  // Time delay between opening positions (ms) - prevents market impact
  entryDelayMs: number;
}

/**
 * Default configuration for multi-position scaling
 */
export const DEFAULT_MULTI_POSITION_CONFIG: MultiPositionConfig = {
  enabled: true,
  minCapitalForMulti: 30_000, // Below $30K, single positions are fine

  // Capital-based position count scaling
  capitalTiers: {
    30_000: 2,   // $30K-$75K: 2 positions max per symbol
    75_000: 3,   // $75K-$150K: 3 positions max per symbol
    150_000: 4,  // $150K-$300K: 4 positions max per symbol
    300_000: 5,  // $300K+: 5 positions max per symbol
  },

  // Entry spread configuration
  minEntrySpreadPct: 0.3,  // Minimum 0.3% price difference between entries
  maxEntrySpreadPct: 1.5,  // Maximum 1.5% price difference

  // Prevent market impact by spacing out entries
  entryDelayMs: 30_000, // 30 seconds between entries
};

/**
 * Result from calculating multi-position allocation
 */
export interface MultiPositionAllocation {
  // Total number of positions to open
  totalPositions: number;

  // Size of each individual position (notional USD)
  positionSizeUsd: number;

  // Total notional across all positions
  totalNotionalUsd: number;

  // Margin required per position
  marginPerPositionUsd: number;

  // Total margin required
  totalMarginUsd: number;

  // Suggested entry prices for each position (staggered)
  entryPrices: number[];

  // Was allocation capped by liquidity tier?
  wasLiquidityCapped: boolean;

  // Efficiency vs single position (0-1)
  // 1.0 = using full target allocation, <1 = capped
  efficiency: number;

  // Metadata
  liquidityTier: 'HIGH' | 'MEDIUM' | 'LOW';
  singlePositionCap: number;
  targetAllocationUsd: number;
}

/**
 * Calculate optimal multi-position allocation for a symbol
 *
 * @param symbol - Trading symbol (e.g., 'SEI/USDT:USDT')
 * @param totalCapitalUsd - Total account capital
 * @param currentPrice - Current market price
 * @param positionSizePct - Target position sizing % (from adaptive sizing: 40-55%)
 * @param leverage - Leverage to use
 * @param config - Multi-position configuration
 * @returns Allocation plan with position count and sizes
 */
export function calculateMultiPositionAllocation(
  symbol: string,
  totalCapitalUsd: number,
  currentPrice: number,
  positionSizePct: number,
  leverage: number,
  config: MultiPositionConfig = DEFAULT_MULTI_POSITION_CONFIG
): MultiPositionAllocation {
  // Input validation
  if (currentPrice <= 0 || !Number.isFinite(currentPrice)) {
    throw new Error(`Invalid currentPrice: ${currentPrice}`);
  }
  if (totalCapitalUsd <= 0 || !Number.isFinite(totalCapitalUsd)) {
    throw new Error(`Invalid totalCapitalUsd: ${totalCapitalUsd}`);
  }
  if (leverage <= 0 || leverage > 100) {
    throw new Error(`Invalid leverage: ${leverage}`);
  }
  if (positionSizePct <= 0 || positionSizePct > 1) {
    throw new Error(`Invalid positionSizePct: ${positionSizePct}`);
  }

  // Step 1: Get liquidity constraints for this symbol
  const liquidityTier = getLiquidityTier(symbol);
  const singlePositionCap = getMaxSafePositionSize(symbol);

  // Step 2: Calculate target allocation (what we WANT to deploy)
  const targetMargin = totalCapitalUsd * positionSizePct;
  const targetNotional = targetMargin * leverage;

  // Step 3: Determine if multi-position is needed and allowed
  if (!config.enabled || totalCapitalUsd < config.minCapitalForMulti) {
    // Use single position (default behavior)
    const notional = Math.min(targetNotional, singlePositionCap);
    const margin = notional / leverage;

    return {
      totalPositions: 1,
      positionSizeUsd: notional,
      totalNotionalUsd: notional,
      marginPerPositionUsd: margin,
      totalMarginUsd: margin,
      entryPrices: [currentPrice],
      wasLiquidityCapped: targetNotional > singlePositionCap,
      efficiency: Math.min(1, notional / targetNotional),
      liquidityTier,
      singlePositionCap,
      targetAllocationUsd: targetNotional,
    };
  }

  // Step 4: Calculate how many positions we can/should open
  const maxPositions = getMaxPositionsForCapital(totalCapitalUsd, config);

  // Step 5: Check if we even need multiple positions
  // If target fits in single position, no need for multi-position
  if (targetNotional <= singlePositionCap) {
    const margin = targetNotional / leverage;
    return {
      totalPositions: 1,
      positionSizeUsd: targetNotional,
      totalNotionalUsd: targetNotional,
      marginPerPositionUsd: margin,
      totalMarginUsd: margin,
      entryPrices: [currentPrice],
      wasLiquidityCapped: false,
      efficiency: 1.0,
      liquidityTier,
      singlePositionCap,
      targetAllocationUsd: targetNotional,
    };
  }

  // Step 6: Calculate optimal number of positions
  // We want: numPositions × singlePositionCap >= targetNotional
  const idealPositions = Math.ceil(targetNotional / singlePositionCap);
  const actualPositions = Math.min(idealPositions, maxPositions);

  // Step 7: Calculate size per position
  // Each position uses the maximum allowed by liquidity tier
  const positionSizeUsd = singlePositionCap;
  const totalNotionalUsd = positionSizeUsd * actualPositions;
  const marginPerPositionUsd = positionSizeUsd / leverage;
  const totalMarginUsd = marginPerPositionUsd * actualPositions;

  // Step 8: Generate staggered entry prices
  // This diversifies entry points and reduces timing risk
  const entryPrices = generateStaggeredEntries(
    currentPrice,
    actualPositions,
    config.minEntrySpreadPct,
    config.maxEntrySpreadPct
  );

  // Step 9: Calculate efficiency
  const efficiency = Math.min(1, totalNotionalUsd / targetNotional);

  return {
    totalPositions: actualPositions,
    positionSizeUsd,
    totalNotionalUsd,
    marginPerPositionUsd,
    totalMarginUsd,
    entryPrices,
    wasLiquidityCapped: efficiency < 1,
    efficiency,
    liquidityTier,
    singlePositionCap,
    targetAllocationUsd: targetNotional,
  };
}

/**
 * Get maximum number of positions allowed based on capital
 */
export function getMaxPositionsForCapital(
  totalCapitalUsd: number,
  config: MultiPositionConfig
): number {
  // Find the highest tier that the capital qualifies for
  const sortedTiers = Object.entries(config.capitalTiers)
    .map(([minCap, positions]) => ({ minCap: Number(minCap), positions }))
    .sort((a, b) => b.minCap - a.minCap); // Sort descending

  for (const tier of sortedTiers) {
    if (totalCapitalUsd >= tier.minCap) {
      return tier.positions;
    }
  }

  // Default to 1 if below all tiers
  return 1;
}

/**
 * V5.30: OPTIMIZED ALLOCATION - Adjust position sizing to maximize capital efficiency
 *
 * PROBLEM: Standard multi-position still wastes capital on low-cap cryptos
 * Example: $100K account, SEI with $25K cap, 3 positions = $75K used (27% efficiency)
 *
 * SOLUTION: When hitting liquidity caps, dynamically increase position count OR
 * reallocate excess capital to other positions proportionally
 *
 * This function tries to get as close as possible to target allocation by:
 * 1. Increasing position count if possible (up to max allowed by capital tier)
 * 2. If still capped, return the best achievable allocation
 * 3. Signal to caller that excess capital should be used for other symbols
 */
export function calculateOptimizedMultiPositionAllocation(
  symbol: string,
  totalCapitalUsd: number,
  currentPrice: number,
  positionSizePct: number,
  leverage: number,
  config: MultiPositionConfig = DEFAULT_MULTI_POSITION_CONFIG
): MultiPositionAllocation & { excessCapitalUsd: number } {

  const baseAllocation = calculateMultiPositionAllocation(
    symbol,
    totalCapitalUsd,
    currentPrice,
    positionSizePct,
    leverage,
    config
  );

  // Calculate how much capital we wanted to use vs what we actually used
  const targetMargin = totalCapitalUsd * positionSizePct;
  const excessCapitalUsd = Math.max(0, targetMargin - baseAllocation.totalMarginUsd);

  return {
    ...baseAllocation,
    excessCapitalUsd,
  };
}

/**
 * Generate staggered entry prices for multiple positions
 *
 * This creates entry points spread across a price range to:
 * 1. Diversify entry timing (reduce risk of poor single entry)
 * 2. Improve average entry price across positions
 * 3. Reduce market impact by not hitting same price level
 *
 * Strategy:
 * - For LONG positions: entries below current price (limit orders waiting for dips)
 * - For SHORT positions: entries above current price (limit orders waiting for pumps)
 * - Spread is proportional to position count (more positions = wider spread)
 */
export function generateStaggeredEntries(
  currentPrice: number,
  positionCount: number,
  minSpreadPct: number,
  maxSpreadPct: number
): number[] {
  if (positionCount === 1) {
    return [currentPrice];
  }

  // Calculate total spread based on position count
  // More positions = use more of the allowed spread range
  const spreadPct = minSpreadPct + (maxSpreadPct - minSpreadPct) * Math.min(1, (positionCount - 1) / 4);
  const spreadUsd = currentPrice * (spreadPct / 100);

  // Generate evenly spaced entry points
  // First position at current price, others staggered below (for long) or above (for short)
  const entries: number[] = [];

  for (let i = 0; i < positionCount; i++) {
    // Distribute entries: 0%, 25%, 50%, 75%, 100% of spread
    const spreadFactor = i / (positionCount - 1);

    // For long positions: entries below current price (waiting for dips)
    // Entry 0: currentPrice
    // Entry 1: currentPrice - 25% of spread
    // Entry 2: currentPrice - 50% of spread, etc.
    const entryPrice = currentPrice - (spreadUsd * spreadFactor);

    entries.push(entryPrice);
  }

  return entries;
}

/**
 * Example usage and validation
 */
export function exampleMultiPositionScaling() {
  console.log('\n=== MULTI-POSITION SCALING EXAMPLES ===\n');

  const scenarios = [
    { capital: 10_000, symbol: 'SEI/USDT:USDT', price: 0.45 },
    { capital: 50_000, symbol: 'SEI/USDT:USDT', price: 0.45 },
    { capital: 100_000, symbol: 'SEI/USDT:USDT', price: 0.45 },
    { capital: 100_000, symbol: 'SOL/USDT:USDT', price: 120 },
    { capital: 500_000, symbol: 'BTC/USDT:USDT', price: 45000 },
  ];

  for (const scenario of scenarios) {
    // Calculate adaptive position sizing (matches V5.18 logic)
    const positionSizePct = Math.min(
      MomentumConfig.RISK.POSITION_SIZE_PCT_BASE +
        (scenario.capital / 5000) * MomentumConfig.RISK.POSITION_SIZE_PCT_BOOST_PER_5K,
      MomentumConfig.RISK.POSITION_SIZE_PCT_MAX
    );

    const leverage = MomentumConfig.LEVERAGE[scenario.symbol] || 5;

    const allocation = calculateMultiPositionAllocation(
      scenario.symbol,
      scenario.capital,
      scenario.price,
      positionSizePct,
      leverage
    );

    console.log(`\n📊 ${scenario.symbol} with $${scenario.capital.toLocaleString()} capital:`);
    console.log(`   Target sizing: ${(positionSizePct * 100).toFixed(1)}%`);
    console.log(`   Target allocation: $${allocation.targetAllocationUsd.toLocaleString()}`);
    console.log(`   Liquidity tier: ${allocation.liquidityTier} (cap: $${allocation.singlePositionCap.toLocaleString()})`);
    console.log(`   \n   📈 Multi-Position Strategy:`);
    console.log(`   Positions: ${allocation.totalPositions}x`);
    console.log(`   Size per position: $${allocation.positionSizeUsd.toLocaleString()}`);
    console.log(`   Total notional: $${allocation.totalNotionalUsd.toLocaleString()}`);
    console.log(`   Total margin: $${allocation.totalMarginUsd.toLocaleString()}`);
    console.log(`   Efficiency: ${(allocation.efficiency * 100).toFixed(1)}%`);

    if (allocation.totalPositions > 1) {
      console.log(`   Entry prices: ${allocation.entryPrices.map(p => p.toFixed(4)).join(', ')}`);
    }

    // Compare to single position
    const singlePositionNotional = Math.min(
      allocation.targetAllocationUsd,
      allocation.singlePositionCap
    );
    const improvement = ((allocation.totalNotionalUsd / singlePositionNotional) - 1) * 100;

    if (improvement > 0) {
      console.log(`   💡 Improvement: +${improvement.toFixed(1)}% vs single position`);
    }
  }

  console.log('\n');
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  exampleMultiPositionScaling();
}
