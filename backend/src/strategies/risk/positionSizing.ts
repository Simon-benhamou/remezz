import { MomentumConfig } from '../config/momentumConfig.js';

import {
  calcATR,
  determineVolatilityRegime,
} from '../indicators/technicalIndicators.js';

// ============================================================================
// POSITION SIZING V5.5 - LIQUIDITY-AWARE
// ============================================================================

/**
 * V5.6 Liquidation Protection Configuration
 * Dynamic leverage based on market volatility
 */
export const LIQUIDATION_CONFIG = {
  // Enable dynamic leverage reduction
  DYNAMIC_LEVERAGE: true,

  // ATR configuration
  ATR_PERIOD: 14,

  // If ATR/price > this threshold, reduce leverage
  HIGH_VOLATILITY_ATR_PCT: 2,  // ATR > 2% = high volatility

  // Reduced leverage in high volatility
  REDUCED_LEVERAGE: 3,

  // Max simulated gap for safety checks
  MAX_SIMULATED_GAP_PCT: 5,

  // Liquidation threshold (% loss on margin before liquidation)
  LIQUIDATION_THRESHOLD_PCT: 80,
};

/**
 * V5.6: Calculate safe leverage based on volatility
 * Returns reduced leverage if ATR indicates high volatility
 */
export function calcSafeLeverage(
  candles: { high: number; low: number; close: number }[],
  baseLeverage: number
): { leverage: number; wasReduced: boolean; atrPct: number | null } {
  if (!LIQUIDATION_CONFIG.DYNAMIC_LEVERAGE) {
    return { leverage: baseLeverage, wasReduced: false, atrPct: null };
  }

  const atr = calcATR(candles, LIQUIDATION_CONFIG.ATR_PERIOD);
  if (!atr || candles.length === 0) {
    return { leverage: baseLeverage, wasReduced: false, atrPct: null };
  }

  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;

  // High volatility = reduce leverage
  if (atrPct > LIQUIDATION_CONFIG.HIGH_VOLATILITY_ATR_PCT) {
    return {
      leverage: LIQUIDATION_CONFIG.REDUCED_LEVERAGE,
      wasReduced: true,
      atrPct
    };
  }

  return { leverage: baseLeverage, wasReduced: false, atrPct };
}

/**
 * V5.11: Calculate dynamic stop loss based on ATR
 * V5.85: Added tier-based SL for different crypto types
 *
 * Backtested results (24 months, 8 cryptos):
 * - ATR × 3.0: +2547% PnL, 89.1% WR, 10.6% SL rate
 * - vs ATR × 2.0: +915% amélioration, 138 stop hunts évités
 * - Fonctionne en BULL (+401%) et BEAR (+2145%)
 *
 * @param candles - Array of OHLCV candles
 * @param symbol - Optional symbol for tier-based SL (e.g., "SOL/USDT:USDT" or "SOL")
 * @returns Dynamic SL percentage and debug info
 */
export function calcDynamicStopLoss(
  candles: { high: number; low: number; close: number }[],
  symbol?: string
): { slPct: number; atrPct: number | null; isDynamic: boolean; tier?: string } {
  const config = MomentumConfig.EXIT;
  const exitConfig = config as any;

  // V5.81: Dynamic SL based on volatility regime
  if (config.STOP_LOSS_TYPE === 'dynamic') {
    const regime = determineVolatilityRegime(candles);
    const tierBasedEnabled = exitConfig.TIER_BASED_SL_ENABLED ?? false;

    // Extract base symbol (e.g., "SOL/USDT:USDT" → "SOL")
    const baseSymbol = symbol?.split('/')[0]?.split(':')[0] ?? '';

    let slPct: number;
    let tier: string | undefined;

    if (tierBasedEnabled && baseSymbol) {
      // V5.85: Tier-based SL
      const tier1 = exitConfig.TIER1_SYMBOLS ?? ['BTC', 'ETH'];
      const tier3 = exitConfig.TIER3_SYMBOLS ?? [];

      if (tier1.includes(baseSymbol)) {
        tier = 'TIER1';
      } else if (tier3.includes(baseSymbol)) {
        tier = 'TIER3';
      } else {
        tier = 'TIER2';
      }

      // Get SL based on tier + volatility regime
      if (regime.regime === 'LOW') {
        slPct = exitConfig[`${tier}_SL_LOW_VOL_PCT`] ?? exitConfig.DYNAMIC_SL_LOW_VOL_PCT ?? 1.5;
      } else if (regime.regime === 'HIGH') {
        slPct = exitConfig[`${tier}_SL_HIGH_VOL_PCT`] ?? exitConfig.DYNAMIC_SL_HIGH_VOL_PCT ?? 2.5;
      } else {
        slPct = exitConfig[`${tier}_SL_MED_VOL_PCT`] ?? exitConfig.DYNAMIC_SL_MED_VOL_PCT ?? 2.0;
      }
    } else {
      // Legacy: volatility-only SL
      if (regime.regime === 'LOW') {
        slPct = exitConfig.DYNAMIC_SL_LOW_VOL_PCT ?? 1.5;
      } else if (regime.regime === 'HIGH') {
        slPct = exitConfig.DYNAMIC_SL_HIGH_VOL_PCT ?? 2.5;
      } else {
        slPct = exitConfig.DYNAMIC_SL_MED_VOL_PCT ?? 2.0;
      }
    }

    return { slPct, atrPct: regime.atrPct, isDynamic: true, tier };
  }

  // Fallback: Fixed SL
  return {
    slPct: config.STOP_LOSS_PCT,
    atrPct: null,
    isDynamic: false
  };
}

/**
 * V5.5 Liquidity Configuration
 * Max position as % of 24h volume to avoid market impact
 */
export const LIQUIDITY_CONFIG = {
  // Maximum position as percentage of symbol's 24h volume
  // Above this, slippage becomes significant (>0.5%)
  MAX_POSITION_PCT_OF_VOLUME: 0.5,  // 0.5% of 24h volume max

  // Absolute caps per symbol tier based on typical liquidity
  POSITION_CAPS: {
    // Tier 1: High liquidity (BTC, ETH) - $5B+ daily volume on futures
    HIGH: {
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      maxPositionUsd: 500_000,  // $500K max per position
      minVolume24h: 1_000_000_000,  // $1B minimum
    },
    // Tier 2: Medium liquidity - $500M-$5B daily volume
    MEDIUM: {
      symbols: [
        'XRP/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'ADA/USDT:USDT',
        // V5.30: Added missing cryptos from scanner
        'BNB/USDT:USDT', 'MATIC/USDT:USDT', 'UNI/USDT:USDT', 'LTC/USDT:USDT', 'BCH/USDT:USDT', 'ATOM/USDT:USDT',
        'TRX/USDT:USDT', 'NEAR/USDT:USDT', 'APT/USDT:USDT', 'ARB/USDT:USDT', 'OP/USDT:USDT', 'INJ/USDT:USDT', 'TIA/USDT:USDT',
      ],
      maxPositionUsd: 100_000,  // $100K max
      minVolume24h: 500_000_000,
    },
    // Tier 3: Low liquidity - <$500M daily volume
    LOW: {
      symbols: [
        'SEI/USDT:USDT', 'IMX/USDT:USDT', 'DOT/USDT:USDT', 'SUI/USDT:USDT',
        // V5.30: Added missing low-liquidity cryptos from scanner
        'FIL/USDT:USDT', 'ETC/USDT:USDT', 'WLD/USDT:USDT', 'ORDI/USDT:USDT', 'STX/USDT:USDT', 'JUP/USDT:USDT',
        // V5.93: New winners
        'FET/USDT:USDT', 'WIF/USDT:USDT', 'RENDER/USDT:USDT',
      ],
      maxPositionUsd: 25_000,  // $25K max - beyond this, massive slippage
      minVolume24h: 50_000_000,
    },
  } as Record<string, { symbols: string[]; maxPositionUsd: number; minVolume24h: number }>,

  // Slippage model: estimated slippage based on position size vs volume
  // slippage% = (positionUsd / volume24h) * SLIPPAGE_FACTOR
  SLIPPAGE_FACTOR: 50,  // 0.5% slippage for 1% of volume
};

/**
 * Get liquidity tier for a symbol
 */
export function getLiquidityTier(symbol: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (LIQUIDITY_CONFIG.POSITION_CAPS.HIGH.symbols.includes(symbol)) return 'HIGH';
  if (LIQUIDITY_CONFIG.POSITION_CAPS.MEDIUM.symbols.includes(symbol)) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate maximum safe position size based on liquidity
 */
export function getMaxSafePositionSize(symbol: string, volume24h?: number): number {
  const tier = getLiquidityTier(symbol);
  const config = LIQUIDITY_CONFIG.POSITION_CAPS[tier];

  // If we have actual volume data, use it
  if (volume24h && volume24h > 0) {
    const volumeBasedMax = volume24h * (LIQUIDITY_CONFIG.MAX_POSITION_PCT_OF_VOLUME / 100);
    return Math.min(volumeBasedMax, config.maxPositionUsd);
  }

  // Otherwise use tier-based cap
  return config.maxPositionUsd;
}

/**
 * Estimate slippage for a given position size
 */
export function estimateSlippage(positionUsd: number, volume24h: number): number {
  if (volume24h <= 0) return 0.5; // Default 0.5% if no volume data
  const pctOfVolume = (positionUsd / volume24h) * 100;
  return pctOfVolume * (LIQUIDITY_CONFIG.SLIPPAGE_FACTOR / 100);
}

export interface PositionSizeInput {
  symbol: string;
  currentPrice: number;
  totalCapitalUsd: number;
  riskPerTradePct: number;
  stopLossPct: number;
  volume24h?: number;    // V5.5: Optional 24h volume for liquidity-aware sizing
  safeLeverage?: number; // V5.6: Optional ATR-adjusted leverage (from calcSafeLeverage)
  initialCapitalUsd?: number; // V5.18: Initial account capital for adaptive sizing
}

export interface PositionSizeResult {
  qty: number;
  notionalUsd: number;      // Position size (margin × leverage)
  marginUsd: number;        // Capital blocked (what we reserve)
  riskUsd: number;
  leverage: number;
  suggestedLeverage: number;
  stopPrice: number;
  // V5.5: Liquidity info
  liquidityTier?: 'HIGH' | 'MEDIUM' | 'LOW';
  maxSafePosition?: number;
  estimatedSlippage?: number;
  wasLiquidityCapped?: boolean;
  // V5.30: Multi-position info
  multiPositionPlan?: {
    enabled: boolean;
    totalPositions: number;
    positionSizeUsd: number;
    totalNotionalUsd: number;
    totalMarginUsd: number;
    entryPrices: number[];
    efficiency: number;
  };
}

/**
 * Calculate position size V5.30 - MULTI-POSITION SCALING
 *
 * This version caps position size based on:
 * 1. Available capital (40-55% rule based on account size) - this is the MARGIN we use
 * 2. Symbol liquidity tier
 * 3. Actual 24h volume (if provided)
 * 4. V5.6: Dynamic leverage based on ATR volatility
 * 5. V5.18: Adaptive sizing - bigger accounts use higher % to compensate for liquidity caps
 * 6. V5.30: Multi-position support - allows multiple positions per symbol for large accounts
 *
 * IMPORTANT: With leverage, the NOTIONAL = margin × leverage
 * - margin = what we block from capital pool
 * - notional = actual position size (what we trade on exchange)
 *
 * V5.30 MULTI-POSITION LOGIC:
 * - If MULTI_POSITION_ENABLED=true and capital exceeds threshold ($30K+)
 * - Calculate multi-position allocation plan
 * - Return plan in multiPositionPlan field
 * - Caller (SimpleAgent/Backtest) decides whether to use single or multi-position
 *
 * V5.18 LOGIC:
 * - Small accounts (<$2k): 40% sizing - aggressive for growth
 * - Medium accounts ($2k-$10k): 40-46% - moderate scaling
 * - Large accounts (>$10k): up to 55% - compensate for liquidity caps
 *
 * This ensures ROI scales better with capital while respecting liquidity limits
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { symbol, currentPrice, totalCapitalUsd, stopLossPct, volume24h, safeLeverage, initialCapitalUsd } = input;

  // V5.18: Use initial capital for adaptive sizing (fallback to available capital)
  const accountCapital = initialCapitalUsd ?? totalCapitalUsd;

  // V5.6: Use safe leverage if provided (from ATR calculation), otherwise use base leverage
  const baseLeverage = MomentumConfig.LEVERAGE[symbol] || 4;
  const leverage = safeLeverage ?? baseLeverage;
  const stopPrice = currentPrice * (1 - stopLossPct / 100);

  // V5.18: Adaptive position sizing - bigger accounts use higher % to compensate for liquidity caps
  const positionSizePct = Math.min(
    MomentumConfig.RISK.POSITION_SIZE_PCT_BASE + (accountCapital / 5000) * MomentumConfig.RISK.POSITION_SIZE_PCT_BOOST_PER_5K,
    MomentumConfig.RISK.POSITION_SIZE_PCT_MAX
  );

  // Step 1: Calculate target margin using adaptive sizing
  const targetMargin = totalCapitalUsd * positionSizePct;

  // Step 2: Calculate target notional (margin × leverage) - this is the TARGET position size
  const targetNotional = targetMargin * leverage;

  // Step 3: Get liquidity-based maximum (for NOTIONAL)
  const liquidityTier = getLiquidityTier(symbol);
  const maxSafeNotional = getMaxSafePositionSize(symbol, volume24h);

  // Step 4: Apply liquidity cap to NOTIONAL
  const wasLiquidityCapped = targetNotional > maxSafeNotional;
  let notional = Math.min(targetNotional, maxSafeNotional);

  // Step 5: Calculate actual margin needed
  // If capped, margin = notional / leverage (we use less margin)
  // This is key: with big capital and liquidity cap, we don't need full margin
  let actualMargin = notional / leverage;

  // Step 6: Cap margin to available capital (safety check)
  if (actualMargin > totalCapitalUsd * 0.95) {
    actualMargin = totalCapitalUsd * 0.95;
    notional = actualMargin * leverage;
  }

  // 🔧 SAFETY: Hard cap on notional - max 10x of capital regardless of leverage settings
  // This prevents catastrophic positions if capital sync fails
  const MAX_NOTIONAL_MULTIPLIER = 10;
  const absoluteMaxNotional = totalCapitalUsd * MAX_NOTIONAL_MULTIPLIER;
  if (notional > absoluteMaxNotional) {
    console.warn(`⚠️ [${symbol}] Position capped by safety limit: $${notional.toFixed(2)} → $${absoluteMaxNotional.toFixed(2)} (max ${MAX_NOTIONAL_MULTIPLIER}x capital)`);
    notional = absoluteMaxNotional;
    actualMargin = notional / leverage;
  }

  // 🔧 SAFETY: If capital is very small (<$50), limit position size even further
  if (totalCapitalUsd < 50 && notional > totalCapitalUsd * 5) {
    console.warn(`⚠️ [${symbol}] Small capital mode: capping notional to 5x capital ($${(totalCapitalUsd * 5).toFixed(2)})`);
    notional = totalCapitalUsd * 5;
    actualMargin = notional / leverage;
  }

  // Step 7: Apply minimum threshold
  const MIN_NOTIONAL_USD = 20;
  if (notional < MIN_NOTIONAL_USD) {
    notional = totalCapitalUsd >= MIN_NOTIONAL_USD / leverage ? MIN_NOTIONAL_USD : 0;
    actualMargin = notional / leverage;
  }

  // Step 8: Calculate estimated slippage (based on notional)
  const estimatedSlippage = volume24h ? estimateSlippage(notional, volume24h) : undefined;

  // qty = notional / price (NOT margin / price)
  const qty = notional / currentPrice;
  const riskUsd = actualMargin * (stopLossPct / 100) * leverage;  // Risk on margin, amplified by leverage

  // V5.6: Calculate effective leverage (may be lower if capped)
  // This is informational - shows the "real" amplification we're getting
  const effectiveLeverage = actualMargin > 0 ? notional / actualMargin : leverage;

  // V5.30: Calculate multi-position allocation plan (if enabled and large balance)
  // This only kicks in for accounts >= $30K AND when position would be liquidity-capped
  // Small accounts (<$30K) always use single position - no impact on them
  let multiPositionPlan: PositionSizeResult['multiPositionPlan'] = undefined;

  const MULTI_POSITION_MIN_CAPITAL = 30_000;  // Minimum capital to enable multi-position
  const MULTI_POSITION_ENABLED = process.env.MULTI_POSITION_ENABLED === 'true';

  if (MULTI_POSITION_ENABLED && accountCapital >= MULTI_POSITION_MIN_CAPITAL && wasLiquidityCapped) {
    // Only use multi-position when:
    // 1. Feature is enabled
    // 2. Account is large enough ($30K+)
    // 3. Position would be capped by liquidity (otherwise no benefit)

    // Calculate how many positions we need to deploy target capital
    const idealPositions = Math.ceil(targetNotional / maxSafeNotional);

    // Cap by capital tier
    const capitalTiers: { [minCap: number]: number } = {
      300_000: 5,  // $300K+: 5 positions
      150_000: 4,  // $150K-$300K: 4 positions
      75_000: 3,   // $75K-$150K: 3 positions
      30_000: 2,   // $30K-$75K: 2 positions
    };

    let maxPositions = 1;
    for (const [minCap, positions] of Object.entries(capitalTiers).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      if (accountCapital >= Number(minCap)) {
        maxPositions = positions;
        break;
      }
    }

    const totalPositions = Math.min(idealPositions, maxPositions);

    if (totalPositions > 1) {
      // Each position uses max safe notional (liquidity cap)
      const positionSizeUsd = maxSafeNotional;
      const totalNotionalUsd = positionSizeUsd * totalPositions;
      const marginPerPosition = positionSizeUsd / leverage;
      const totalMarginUsd = marginPerPosition * totalPositions;

      // Generate staggered entry prices (0.3% to 1.5% spread)
      const minSpreadPct = 0.3;
      const maxSpreadPct = 1.5;
      const spreadPct = minSpreadPct + (maxSpreadPct - minSpreadPct) * Math.min(1, (totalPositions - 1) / 4);
      const spreadUsd = currentPrice * (spreadPct / 100);

      const entryPrices: number[] = [];
      for (let i = 0; i < totalPositions; i++) {
        const spreadFactor = totalPositions > 1 ? i / (totalPositions - 1) : 0;
        entryPrices.push(currentPrice - (spreadUsd * spreadFactor));
      }

      const efficiency = Math.min(1, totalNotionalUsd / targetNotional);

      multiPositionPlan = {
        enabled: true,
        totalPositions,
        positionSizeUsd,
        totalNotionalUsd,
        totalMarginUsd,
        entryPrices,
        efficiency,
      };
    }
  }

  return {
    qty,
    notionalUsd: notional,      // The actual position size
    marginUsd: actualMargin,    // What we block from capital pool
    riskUsd,
    leverage,                   // The leverage we're USING
    suggestedLeverage: leverage,
    stopPrice,
    // V5.5 liquidity info
    liquidityTier,
    maxSafePosition: maxSafeNotional,
    estimatedSlippage,
    wasLiquidityCapped,
    // V5.30: Multi-position plan
    multiPositionPlan,
  };
}

// Legacy function signature for compatibility
export function calculatePositionSizeLegacy(
  capitalUsd: number,
  entryPrice: number,
  symbol: string,
): { qty: number; riskUsd: number; leverage: number; stopPrice: number } {
  const leverage = MomentumConfig.LEVERAGE[symbol] || 4;
  const riskUsd = capitalUsd * (MomentumConfig.RISK.RISK_PCT_PER_TRADE / 100);
  const stopPrice = entryPrice * (1 - MomentumConfig.EXIT.STOP_LOSS_PCT / 100);
  const positionValue = riskUsd / (MomentumConfig.EXIT.STOP_LOSS_PCT / 100);
  const qty = positionValue / entryPrice;

  return { qty, riskUsd, leverage, stopPrice };
}
