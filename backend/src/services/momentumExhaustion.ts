/**
 * Momentum Exhaustion Calculator
 * ==============================
 *
 * Detects when a momentum move is losing steam BEFORE the trailing stop
 * is breached. When exhaustion is confirmed (score >= threshold), a
 * STOP_MARKET order is placed at the trailing stop price on the exchange.
 *
 * This replaces the broken "proactive LIMIT" approach which:
 * - Used a plain LIMIT order that filled immediately (wrong order type)
 * - Only activated within 0.6% of trailing (too late)
 * - Required NFS >= 50 on partial candles (unreliable data)
 *
 * The exhaustion score IS the noise filter. If 5 independent indicators
 * all say "momentum is dying," the stop triggering is signal, not noise.
 *
 * Indicators (5 components, 100 points total):
 * 1. ROC Deceleration  (25pts) - Rate of change declining over 3 windows
 * 2. Volume Dry-Up     (25pts) - Volume declining while price still advancing
 * 3. Body Shrinkage    (20pts) - Candle bodies getting smaller (indecision)
 * 4. Rejection Wicks   (15pts) - Growing wicks against the move direction
 * 5. Proximity          (15pts) - How close price is to trailing stop
 *
 * Used by: realtimeExitHandler.ts (live), backtestService.ts (backtest)
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('exhaustion');

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ExhaustionCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ExhaustionComponents {
  rocDeceleration: number;      // 0-25: Rate of change declining
  volumeDryUp: number;          // 0-25: Volume declining on advances
  bodyShrinkage: number;        // 0-20: Candle bodies shrinking
  rejectionWicks: number;       // 0-15: Rejection wicks growing
  proximityToTrailing: number;  // 0-15: Distance to trailing stop
}

export interface ExhaustionResult {
  score: number;                // 0-100
  shouldPlaceStop: boolean;     // score >= PLACEMENT_THRESHOLD
  components: ExhaustionComponents;
  reason: string;
}

export interface ExhaustionConfig {
  ENABLED: boolean;
  PLACEMENT_THRESHOLD: number;  // Score to place STOP_MARKET (default 65)
  CANCEL_THRESHOLD: number;     // Score to cancel STOP (default 45, hysteresis)
  MIN_CANDLES: number;          // Minimum candles for calculation (default 10)
}

export const DEFAULT_EXHAUSTION_CONFIG: ExhaustionConfig = {
  ENABLED: true,
  PLACEMENT_THRESHOLD: 65,
  CANCEL_THRESHOLD: 45,
  MIN_CANDLES: 10,
};

// ═══════════════════════════════════════════════════════════════════════════
// CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

export class MomentumExhaustionCalculator {
  private config: ExhaustionConfig;

  constructor(config?: Partial<ExhaustionConfig>) {
    this.config = { ...DEFAULT_EXHAUSTION_CONFIG, ...config };
  }

  /**
   * Calculate momentum exhaustion score.
   *
   * @param candles - Last 10-25 candles (1m for live, 15m for backtest)
   * @param side - Trade direction
   * @param trailingStopPrice - Current trailing stop level
   * @param currentPrice - Current price (candle close)
   * @returns ExhaustionResult with score and component breakdown
   */
  calculate(
    candles: ExhaustionCandle[],
    side: 'long' | 'short',
    trailingStopPrice: number,
    currentPrice: number,
  ): ExhaustionResult {
    if (candles.length < this.config.MIN_CANDLES) {
      return {
        score: 0,
        shouldPlaceStop: false,
        components: { rocDeceleration: 0, volumeDryUp: 0, bodyShrinkage: 0, rejectionWicks: 0, proximityToTrailing: 0 },
        reason: `Insufficient candles (${candles.length}/${this.config.MIN_CANDLES})`,
      };
    }

    const components: ExhaustionComponents = {
      rocDeceleration: this.calcRocDeceleration(candles, side),
      volumeDryUp: this.calcVolumeDryUp(candles, side),
      bodyShrinkage: this.calcBodyShrinkage(candles),
      rejectionWicks: this.calcRejectionWicks(candles, side),
      proximityToTrailing: this.calcProximity(currentPrice, trailingStopPrice, side),
    };

    const score = components.rocDeceleration
      + components.volumeDryUp
      + components.bodyShrinkage
      + components.rejectionWicks
      + components.proximityToTrailing;

    const shouldPlaceStop = score >= this.config.PLACEMENT_THRESHOLD;

    return {
      score,
      shouldPlaceStop,
      components,
      reason: shouldPlaceStop
        ? `Exhaustion confirmed (${score.toFixed(0)}/100)`
        : `Monitoring (${score.toFixed(0)}/100)`,
    };
  }

  getConfig(): ExhaustionConfig {
    return this.config;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // COMPONENT 1: ROC Deceleration (0-25 points)
  // Is the rate of price change slowing down?
  //
  // For LONG: positive ROC declining = gains shrinking = momentum dying
  // For SHORT: negative ROC becoming less negative = losses shrinking
  // ═════════════════════════════════════════════════════════════════════════

  private calcRocDeceleration(candles: ExhaustionCandle[], side: 'long' | 'short'): number {
    const closes = candles.map(c => c.close);
    if (closes.length < 10) return 0;

    // Calculate ROC over 3 non-overlapping windows of 3 candles each
    const roc_recent = this.rocWindow(closes, 0, 3);   // Most recent 3 candles
    const roc_mid = this.rocWindow(closes, 3, 3);      // 3 candles before that
    const roc_early = this.rocWindow(closes, 6, 3);    // 3 more before that

    if (side === 'long') {
      // LONG: we want to see positive ROC declining
      // roc_early > roc_mid > roc_recent (each window slower than the last)
      const fullyDeclining = roc_early > roc_mid && roc_mid > roc_recent;
      const partialDeclining = roc_mid > roc_recent;

      if (fullyDeclining && roc_recent <= 0) return 25;  // ROC turned negative after declining
      if (fullyDeclining) return 20;                      // Clear 3-phase deceleration
      if (partialDeclining && roc_recent < roc_mid * 0.5) return 15; // Sharp recent slowdown
      if (partialDeclining) return 8;                     // Some deceleration
    } else {
      // SHORT: we want to see negative ROC becoming less negative
      // roc_early < roc_mid < roc_recent (bearish momentum weakening)
      const fullyDeclining = roc_early < roc_mid && roc_mid < roc_recent;
      const partialDeclining = roc_mid < roc_recent;

      if (fullyDeclining && roc_recent >= 0) return 25;  // ROC turned positive
      if (fullyDeclining) return 20;
      if (partialDeclining && roc_recent > roc_mid * 0.5) return 15;
      if (partialDeclining) return 8;
    }

    return 0;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // COMPONENT 2: Volume Dry-Up (0-25 points)
  // Is volume declining while price is still advancing?
  //
  // Rising price on declining volume = rally running out of buyers
  // Falling price on declining volume = selloff running out of sellers
  // ═════════════════════════════════════════════════════════════════════════

  private calcVolumeDryUp(candles: ExhaustionCandle[], side: 'long' | 'short'): number {
    if (candles.length < 10) return 0;

    const recent = candles.slice(-3);
    const earlier = candles.slice(-10, -3);

    const recentAvgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
    const earlierAvgVol = earlier.reduce((s, c) => s + c.volume, 0) / earlier.length;

    if (earlierAvgVol <= 0) return 0;

    // Check price is still moving in trade direction (exhaustion, not reversal)
    const recentClose = recent[recent.length - 1].close;
    const earlierClose = earlier[earlier.length - 1].close;
    const priceStillAdvancing = side === 'long'
      ? recentClose >= earlierClose
      : recentClose <= earlierClose;

    // If price already reversed, this isn't exhaustion — it's already reversing
    if (!priceStillAdvancing) return 0;

    const ratio = recentAvgVol / earlierAvgVol;

    if (ratio < 0.4) return 25;       // Volume collapsed
    if (ratio < 0.6) return 20;       // Volume significantly lower
    if (ratio < 0.75) return 12;      // Volume moderately lower
    if (ratio < 0.9) return 5;        // Slight decline
    return 0;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // COMPONENT 3: Body Shrinkage (0-20 points)
  // Are candle bodies getting smaller?
  //
  // Shrinking bodies = indecision = neither buyers nor sellers winning
  // ═════════════════════════════════════════════════════════════════════════

  private calcBodyShrinkage(candles: ExhaustionCandle[]): number {
    if (candles.length < 8) return 0;

    const recent = candles.slice(-3);
    const earlier = candles.slice(-8, -3);

    const recentAvgBody = recent.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / recent.length;
    const earlierAvgBody = earlier.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / earlier.length;

    if (earlierAvgBody <= 0) return 0;

    const ratio = recentAvgBody / earlierAvgBody;

    if (ratio < 0.3) return 20;       // Bodies collapsed (extreme indecision)
    if (ratio < 0.5) return 15;       // Bodies significantly smaller
    if (ratio < 0.7) return 8;        // Bodies moderately smaller
    return 0;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // COMPONENT 4: Rejection Wicks (0-15 points)
  // Are rejection wicks growing against the move direction?
  //
  // LONG: upper wicks = sellers rejecting higher prices
  // SHORT: lower wicks = buyers rejecting lower prices
  // ═════════════════════════════════════════════════════════════════════════

  private calcRejectionWicks(candles: ExhaustionCandle[], side: 'long' | 'short'): number {
    if (candles.length < 5) return 0;

    const recent = candles.slice(-5);
    let wickScore = 0;

    for (const c of recent) {
      const range = c.high - c.low;
      if (range <= 0) continue;

      let rejectionWick: number;
      if (side === 'long') {
        // Upper wick = rejection at highs (high - max(open, close))
        rejectionWick = c.high - Math.max(c.open, c.close);
      } else {
        // Lower wick = rejection at lows (min(open, close) - low)
        rejectionWick = Math.min(c.open, c.close) - c.low;
      }

      const wickRatio = rejectionWick / range;
      if (wickRatio > 0.5) wickScore += 3;       // Strong rejection
      else if (wickRatio > 0.3) wickScore += 2;   // Moderate rejection
      else if (wickRatio > 0.15) wickScore += 1;  // Mild rejection
    }

    return Math.min(15, wickScore);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // COMPONENT 5: Proximity to Trailing (0-15 points)
  // How close is price to the trailing stop?
  //
  // Closer = more relevant. Even if other indicators are moderate,
  // being very close to trailing means the stop placement matters more.
  // ═════════════════════════════════════════════════════════════════════════

  private calcProximity(
    currentPrice: number,
    trailingStopPrice: number,
    side: 'long' | 'short',
  ): number {
    const distancePct = side === 'long'
      ? ((currentPrice - trailingStopPrice) / trailingStopPrice) * 100
      : ((trailingStopPrice - currentPrice) / trailingStopPrice) * 100;

    if (distancePct <= 0) return 15;       // Already breaching
    if (distancePct < 0.3) return 15;      // Very close (< 0.3%)
    if (distancePct < 0.6) return 12;      // Close (0.3-0.6%)
    if (distancePct < 1.0) return 8;       // Approaching (0.6-1.0%)
    if (distancePct < 1.5) return 4;       // Somewhat near (1.0-1.5%)
    return 0;                               // Far (> 1.5%)
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Calculate ROC (Rate of Change) over a window ending at `offset` from the end.
   * offset=0 means the most recent window, offset=3 means 3 candles back, etc.
   */
  private rocWindow(closes: number[], offset: number, windowSize: number): number {
    const endIdx = closes.length - 1 - offset;
    const startIdx = endIdx - windowSize;
    if (startIdx < 0 || endIdx < 0 || endIdx >= closes.length) return 0;

    const endPrice = closes[endIdx];
    const startPrice = closes[startIdx];
    if (startPrice === 0) return 0;

    return ((endPrice - startPrice) / startPrice) * 100;
  }
}
