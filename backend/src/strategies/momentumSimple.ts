/**
 * momentumSimple.ts — BARREL RE-EXPORT FILE
 *
 * V5.108: Architectural refactoring — code extracted into focused modules:
 *   - config/momentumConfig.ts   → MomentumConfig, types, constants
 *   - indicators/technicalIndicators.ts → All indicator functions (ATR, BB, ROC, ADX, etc.)
 *   - signals/momentumSignal.ts  → checkMomentumSignal, getMarketConditions, wick breakout
 *   - exits/exitLogic.ts        → shouldExitPosition
 *   - risk/positionSizing.ts    → calculatePositionSize, liquidity, dynamic SL
 *
 * This file re-exports everything so that ALL 45+ existing consumers continue to work
 * with zero import changes. Over time, consumers can import directly from the modules.
 *
 * SINGLE SOURCE OF TRUTH: Each piece of logic now lives in exactly ONE file.
 * Changing a config value, indicator, or exit rule propagates automatically.
 */

// ============================================================================
// CONFIG: MomentumConfig, types, constants
// ============================================================================
export {
  CANDLE_15M_MS,
  calculateExitNowMs,
  MomentumConfig,
  CONFIG,
  type Candle,
  type Position,
  type SignalResult,
  type ExitSignal,
  type MarketConditions,
} from './config/momentumConfig.js';

// ============================================================================
// INDICATORS: All technical indicator functions
// ============================================================================
export {
  calcMA,
  calcSMA,
  calcVolRatio,
  calcBollingerBands,
  calcBB,
  calcBBPosition,
  calcTrendStrength,
  type MarketRegime,
  calcADX,
  detectMarketRegime,
  shouldSkipEntryForRegime,
  getCooldownBars,
  checkMTFAlignment,
  checkBTCVolatility,
  calcROC,
  countConsecUp,
  countConsecDown,
  calcGreenRatio,
  calcAlternation5,
  calcBBTouchCount,
  calcRocAcceleration,
  calcATR,
  determineVolatilityRegime,
  updatePositionWaterMarks,
} from './indicators/technicalIndicators.js';

// ============================================================================
// SIGNALS: Signal detection, market conditions, wick breakout
// ============================================================================
export {
  getMarketConditions,
  type WickBreakoutResult,
  checkWickBreakoutLong,
  checkWickBreakoutShort,
  checkWickBreakout,
  checkMomentumSignal,
} from './_archive/momentum/momentumSignal.js';

// ============================================================================
// EXITS: Position exit logic
// ============================================================================
export {
  shouldExitPosition,
} from './_archive/momentum/exitLogic.js';

// ============================================================================
// RISK: Position sizing, liquidity, dynamic stop loss
// ============================================================================
export {
  LIQUIDATION_CONFIG,
  calcSafeLeverage,
  calcDynamicStopLoss,
  LIQUIDITY_CONFIG,
  getLiquidityTier,
  getMaxSafePositionSize,
  estimateSlippage,
  type PositionSizeInput,
  type PositionSizeResult,
  calculatePositionSize,
  calculatePositionSizeLegacy,
} from './risk/positionSizing.js';
