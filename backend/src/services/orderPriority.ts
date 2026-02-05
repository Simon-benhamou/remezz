/**
 * Order Priority Calculator
 *
 * Determines execution priority for order queue (0-100)
 * Higher priority = executed first
 *
 * Priority Tiers:
 * - 90-100: CRITICAL (liquidation protection, deep stop losses)
 * - 70-89:  HIGH (trailing stops, take profits)
 * - 50-69:  MEDIUM (regime changes, time-based exits)
 * - 20-49:  NORMAL (new entries, low-urgency exits)
 * - 0-19:   LOW (optional operations, cleanup)
 *
 * When 100 agents receive simultaneous exit signal:
 * - Stop losses execute first (protect capital)
 * - Trailing stops next (lock profits)
 * - Normal exits last (no rush)
 * - New entries wait until exits complete
 */

export type ExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit'
  | 'regime_change'
  | 'max_hold'
  | 'stagnant'
  | 'manual'
  | 'liquidation_risk'
  | 'partial_fill_cleanup'
  | 'formatting_residual_cleanup'
  | 'dust_position_cleanup';

export type OrderPriorityContext = {
  // Order type
  isEntry: boolean;
  reason: 'signal_entry' | ExitReason;
  urgency?: 'low' | 'medium' | 'high' | 'critical';

  // Position context (for exits)
  positionPnlPct?: number;          // Current PnL percentage
  positionHoldTimeMs?: number;      // How long position has been open
  positionLeverage?: number;        // Position leverage (higher = higher priority)

  // Market context
  volatility?: 'low' | 'medium' | 'high';
  liquidationRisk?: number;         // 0-100 (distance to liquidation %)

  // Signal context (for entries)
  signalScore?: number;             // Signal quality score (0-100)
  signalConfidence?: number;        // Signal confidence (0-100)
};

/**
 * Calculate order execution priority
 *
 * @param context - Order context
 * @returns Priority score 0-100 (higher = more urgent)
 */
export function calculateOrderPriority(context: OrderPriorityContext): number {
  let priority = 50; // Base priority (MEDIUM)

  // ========================================================================
  // TIER 1: CRITICAL - Liquidation protection & deep losses (90-100)
  // ========================================================================

  if (context.reason === 'liquidation_risk') {
    priority = 100; // MAXIMUM PRIORITY - prevent account liquidation

    if (context.liquidationRisk !== undefined && context.liquidationRisk > 80) {
      priority = 100; // Emergency liquidation protection
    }
  }

  if (context.reason === 'stop_loss') {
    priority = 90; // Very high priority - protect capital

    // Boost if deep in loss
    if (context.positionPnlPct !== undefined && context.positionPnlPct < -5) {
      priority = 95; // URGENT - substantial loss protection
    }

    // Boost if near liquidation
    if (context.liquidationRisk !== undefined && context.liquidationRisk > 70) {
      priority = 98; // CRITICAL - approaching liquidation
    }

    // Boost if high leverage (more risk)
    if (context.positionLeverage !== undefined && context.positionLeverage >= 10) {
      priority = Math.min(100, priority + 3); // High leverage = higher risk
    }
  }

  // ========================================================================
  // TIER 2: HIGH - Profit protection (70-89)
  // ========================================================================

  if (context.reason === 'trailing_stop') {
    priority = 75; // High priority - lock in profits

    // Boost if large profit at risk
    if (context.positionPnlPct !== undefined) {
      if (context.positionPnlPct > 10) {
        priority = 85; // Very high - big gains at risk
      } else if (context.positionPnlPct > 5) {
        priority = 80; // High - substantial profit
      }
    }

    // Boost if high volatility (profits can evaporate quickly)
    if (context.volatility === 'high') {
      priority = Math.min(100, priority + 5);
    }
  }

  if (context.reason === 'take_profit') {
    priority = 70; // High priority - realize gains

    // Boost if target profit is large
    if (context.positionPnlPct !== undefined && context.positionPnlPct > 8) {
      priority = 75; // Lock in exceptional gains
    }
  }

  // ========================================================================
  // TIER 3: MEDIUM - Strategic exits (50-69)
  // ========================================================================

  if (context.reason === 'regime_change') {
    priority = 60; // Medium-high priority

    // Boost if in loss (regime change + losing = bad combo)
    if (context.positionPnlPct !== undefined && context.positionPnlPct < -2) {
      priority = 65;
    }
  }

  if (context.reason === 'max_hold') {
    priority = 55; // Medium priority

    // Boost if position has been open for very long time
    if (context.positionHoldTimeMs !== undefined) {
      const hoursOpen = context.positionHoldTimeMs / (1000 * 60 * 60);
      if (hoursOpen > 72) {
        priority = 60; // Been open >3 days, exit sooner
      }
    }
  }

  if (context.reason === 'stagnant') {
    priority = 50; // Medium priority

    // Lower priority if in profit (let it run)
    if (context.positionPnlPct !== undefined && context.positionPnlPct > 0) {
      priority = 45;
    }
  }

  if (context.reason === 'manual') {
    priority = 65; // Medium-high (user requested)
  }

  // ========================================================================
  // TIER 4: NORMAL - New entries (20-49)
  // ========================================================================

  if (context.isEntry) {
    priority = 30; // Lower priority than any exit

    // Boost based on urgency
    if (context.urgency === 'critical') {
      priority = 50; // Exceptional signal
    } else if (context.urgency === 'high') {
      priority = 40; // Strong signal
    } else if (context.urgency === 'medium') {
      priority = 30; // Normal signal
    } else {
      priority = 20; // Weak signal
    }

    // Boost based on signal quality
    if (context.signalScore !== undefined && context.signalScore > 80) {
      priority = Math.min(70, priority + 15); // Excellent signal
    } else if (context.signalScore !== undefined && context.signalScore > 60) {
      priority = Math.min(60, priority + 10); // Good signal
    }

    // Boost based on confidence
    if (context.signalConfidence !== undefined && context.signalConfidence > 80) {
      priority = Math.min(70, priority + 10); // High confidence
    }
  }

  // ========================================================================
  // ADJUSTMENTS: Market conditions
  // ========================================================================

  // High volatility → boost exit priorities (prices move fast)
  if (!context.isEntry && context.volatility === 'high') {
    priority = Math.min(100, priority + 5);
  }

  // High leverage → boost all priorities (more risk)
  if (context.positionLeverage !== undefined && context.positionLeverage >= 15) {
    priority = Math.min(100, priority + 5);
  }

  // Clamp to valid range
  return Math.max(0, Math.min(100, Math.round(priority)));
}

/**
 * Convert reason to urgency level (for entries)
 */
export function reasonToUrgency(score: number, confidence: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 80 && confidence >= 80) return 'critical';
  if (score >= 70 || confidence >= 70) return 'high';
  if (score >= 50 || confidence >= 50) return 'medium';
  return 'low';
}

/**
 * Get priority tier name (for logging)
 */
export function getPriorityTier(priority: number): string {
  if (priority >= 90) return 'CRITICAL';
  if (priority >= 70) return 'HIGH';
  if (priority >= 50) return 'MEDIUM';
  if (priority >= 20) return 'NORMAL';
  return 'LOW';
}
