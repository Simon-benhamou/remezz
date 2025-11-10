/**
 * Advanced Risk Manager
 * 
 * Provides sophisticated risk management capabilities including:
 * - Dynamic drawdown control with automatic position size reduction
 * - Enhanced circuit breakers for catastrophic losses and black swan events
 * - Regime-aware position sizing based on market conditions
 */

import { prisma } from '../db/client.js';
import { CircuitBreaker, CircuitBreakerDecision } from '../quantai/risk/circuitBreaker.js';
import { classifyRegime, RegimeProfile } from '../ai/regime.js';
import type { TechnicalSnapshot } from '../ai/tech.js';

/**
 * Configuration for advanced risk management
 */
export interface AdvancedRiskConfig {
  // Drawdown control
  maxDrawdownPct: number;              // Maximum drawdown before reducing exposure (default: 10%)
  drawdownLookbackDays: number;        // Days to look back for drawdown calculation (default: 30)
  drawdownRecoveryThreshold: number;   // Recovery threshold to restore full sizing (default: 5%)
  hardDrawdownHaltPct: number;         // Hard halt threshold for critical drawdown (default: 20%)
  
  // Catastrophic loss detection
  catastrophicDailyLossPct: number;    // Single-day loss triggering halt (default: 5%)
  flashCrashDetectionMinutes: number;  // Minutes to detect rapid crashes (default: 15)
  flashCrashThresholdPct: number;      // Price drop % for flash crash (default: 8%)
  
  // Black swan detection
  blackSwanVolatilityThreshold: number; // Price move % in 1 hour (default: 15%)
  blackSwanLookbackMinutes: number;    // Minutes to check for black swan (default: 60)
  
  // Regime-aware sizing
  enableRegimeAwareSizing: boolean;    // Enable regime-based adjustments (default: true)
  lowVolatilityMultiplier: number;     // Multiplier for low volatility (default: 1.2)
  highVolatilityMultiplier: number;    // Multiplier for high volatility (default: 0.6)
  extremeVolatilityMultiplier: number; // Multiplier for extreme volatility (default: 0.35)
  
  // Real-time monitoring
  enableContinuousLiquidityCheck: boolean; // Enable liquidity monitoring during positions (default: true)
  minLiquidityThreshold: number;       // Minimum 24h volume threshold (default: 1000000)
}

/**
 * Drawdown state for a session
 */
export interface DrawdownState {
  peakEquity: number;
  currentDrawdownPct: number;
  isInDrawdown: boolean;
  sizeMultiplier: number;
  lastUpdated: Date;
  hardHaltTriggered?: boolean;
  hardHaltReason?: string;
}

/**
 * Black swan detection result
 */
export interface BlackSwanCheck {
  detected: boolean;
  priceMovePct?: number;
  timeWindowMinutes?: number;
  reason?: string;
}

/**
 * Advanced risk decision combining all checks
 */
export interface AdvancedRiskDecision {
  allowed: boolean;
  sizeMultiplier: number;
  reason?: string;
  drawdownState?: DrawdownState;
  blackSwanDetected?: boolean;
  regimeAdjustment?: number;
  circuitBreakerActive?: boolean;
  hardHaltTriggered?: boolean;
  flashCrashDetected?: boolean;
  liquidityWarning?: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_ADVANCED_RISK_CONFIG: AdvancedRiskConfig = {
  maxDrawdownPct: Number(process.env.ADV_RISK_MAX_DRAWDOWN_PCT ?? '10'),
  drawdownLookbackDays: Number(process.env.ADV_RISK_DRAWDOWN_LOOKBACK_DAYS ?? '30'),
  drawdownRecoveryThreshold: Number(process.env.ADV_RISK_DRAWDOWN_RECOVERY_PCT ?? '5'),
  hardDrawdownHaltPct: Number(process.env.ADV_RISK_HARD_HALT_DRAWDOWN_PCT ?? '20'),
  catastrophicDailyLossPct: Number(process.env.ADV_RISK_CATASTROPHIC_DAILY_LOSS_PCT ?? '5'),
  flashCrashDetectionMinutes: Number(process.env.ADV_RISK_FLASH_CRASH_MINUTES ?? '15'),
  flashCrashThresholdPct: Number(process.env.ADV_RISK_FLASH_CRASH_THRESHOLD_PCT ?? '8'),
  blackSwanVolatilityThreshold: Number(process.env.ADV_RISK_BLACK_SWAN_VOL_THRESHOLD ?? '15'),
  blackSwanLookbackMinutes: Number(process.env.ADV_RISK_BLACK_SWAN_LOOKBACK_MIN ?? '60'),
  enableRegimeAwareSizing: process.env.ADV_RISK_ENABLE_REGIME_SIZING !== 'false',
  lowVolatilityMultiplier: Number(process.env.ADV_RISK_LOW_VOL_MULTIPLIER ?? '1.2'),
  highVolatilityMultiplier: Number(process.env.ADV_RISK_HIGH_VOL_MULTIPLIER ?? '0.6'),
  extremeVolatilityMultiplier: Number(process.env.ADV_RISK_EXTREME_VOL_MULTIPLIER ?? '0.35'),
  enableContinuousLiquidityCheck: process.env.ADV_RISK_CONTINUOUS_LIQUIDITY_CHECK !== 'false',
  minLiquidityThreshold: Number(process.env.ADV_RISK_MIN_LIQUIDITY_THRESHOLD ?? '1000000'),
};

/**
 * Advanced Risk Manager
 * 
 * Extends basic circuit breaker functionality with sophisticated risk controls
 */
export class AdvancedRiskManager {
  private drawdownStates: Map<string, DrawdownState> = new Map();
  
  constructor(
    private readonly config: AdvancedRiskConfig = DEFAULT_ADVANCED_RISK_CONFIG
  ) {}

  /**
   * Calculate drawdown for a session based on historical equity
   */
  async calculateDrawdown(sessionId: string, currentEquity: number): Promise<DrawdownState> {
    const cached = this.drawdownStates.get(sessionId);
    
    // Get equity history from database
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - this.config.drawdownLookbackDays);
    
    // Query closed trades to build equity curve
    const orders = await prisma.order.findMany({
      where: {
        sessionId,
        status: 'closed',
        createdAt: { gte: lookbackDate },
      },
      include: { fills: true },
      orderBy: { createdAt: 'asc' },
    });

    // Calculate peak equity from trade history
    let peakEquity = currentEquity;
    let equity = currentEquity;
    
    if (orders.length > 0) {
      // Walk backwards to find peak
      for (let i = orders.length - 1; i >= 0; i--) {
        const order = orders[i];
        const fills = order.fills || [];
        const realizedPnl = fills.reduce((sum, f) => sum + Number(f.realizedPnl || 0), 0);
        
        // Subtract this trade's PnL to get equity before trade
        equity -= realizedPnl;
        
        if (equity > peakEquity) {
          peakEquity = equity;
        }
      }
      
      // Add back to get current
      equity = currentEquity;
    }

    // Use cached peak if higher
    if (cached && cached.peakEquity > peakEquity) {
      peakEquity = cached.peakEquity;
    }

    // If current equity is new peak, update
    if (currentEquity > peakEquity) {
      peakEquity = currentEquity;
    }

    const drawdownPct = peakEquity > 0 
      ? ((currentEquity - peakEquity) / peakEquity) * 100 
      : 0;

    const isInDrawdown = drawdownPct <= -this.config.maxDrawdownPct;
    
    // Check for hard halt threshold
    const hardHaltTriggered = drawdownPct <= -this.config.hardDrawdownHaltPct;
    const hardHaltReason = hardHaltTriggered 
      ? `Critical drawdown ${drawdownPct.toFixed(2)}% exceeds hard halt threshold ${this.config.hardDrawdownHaltPct}%` 
      : undefined;
    
    // Calculate size multiplier based on drawdown severity
    let sizeMultiplier = 1.0;
    if (hardHaltTriggered) {
      // Complete halt at critical drawdown
      sizeMultiplier = 0;
      console.error(`🚨 HARD HALT: Session ${sessionId} triggered critical drawdown halt at ${drawdownPct.toFixed(2)}%`);
    } else if (isInDrawdown) {
      // Halve position sizes when in drawdown
      const excessDrawdown = Math.abs(drawdownPct) - this.config.maxDrawdownPct;
      const severityFactor = Math.min(excessDrawdown / this.config.maxDrawdownPct, 1);
      sizeMultiplier = Math.max(0.25, 0.5 - (severityFactor * 0.25)); // 0.5 to 0.25 range
    } else if (drawdownPct < -this.config.drawdownRecoveryThreshold) {
      // Gradually restore sizing as we recover
      const recoveryPct = (this.config.maxDrawdownPct + drawdownPct) / 
                          (this.config.maxDrawdownPct - this.config.drawdownRecoveryThreshold);
      sizeMultiplier = 0.5 + (recoveryPct * 0.5); // 0.5 to 1.0 range
    }

    const state: DrawdownState = {
      peakEquity,
      currentDrawdownPct: drawdownPct,
      isInDrawdown,
      sizeMultiplier,
      lastUpdated: new Date(),
      hardHaltTriggered,
      hardHaltReason,
    };

    this.drawdownStates.set(sessionId, state);
    return state;
  }

  /**
   * Detect catastrophic single-day loss
   */
  async detectCatastrophicDailyLoss(sessionId: string, currentEquity: number): Promise<boolean> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const orders = await prisma.order.findMany({
      where: {
        sessionId,
        status: 'closed',
        createdAt: { gte: today },
      },
      include: { fills: true },
    });

    if (orders.length === 0) return false;

    // Calculate total PnL for today
    let totalPnl = 0;
    for (const order of orders) {
      const fills = order.fills || [];
      const realizedPnl = fills.reduce((sum, f) => sum + Number(f.realizedPnl || 0), 0);
      totalPnl += realizedPnl;
    }

    // Calculate loss percentage relative to current equity
    const lossEquity = currentEquity - totalPnl; // What equity was before today's losses
    if (lossEquity <= 0) return true; // Catastrophic if equity would be zero

    const lossPct = Math.abs((totalPnl / lossEquity) * 100);
    
    return totalPnl < 0 && lossPct >= this.config.catastrophicDailyLossPct;
  }

  /**
   * Detect black swan volatility events
   * 
   * Note: This method requires market data (OHLCV). Since there's no OHLCV table in the schema,
   * this is a placeholder implementation. In production, you would integrate with your market data source.
   */
  async detectBlackSwan(symbol: string): Promise<BlackSwanCheck> {
    try {
      const lookbackTime = new Date();
      lookbackTime.setMinutes(lookbackTime.getMinutes() - this.config.blackSwanLookbackMinutes);

      // TODO: Integrate with actual market data source (e.g., data service, exchange API)
      // For now, we can check recent order prices as a proxy for volatility
      const recentOrders = await prisma.order.findMany({
        where: {
          symbol,
          status: { in: ['filled', 'closed'] },
          price: { not: null },
          createdAt: { gte: lookbackTime },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: { price: true, createdAt: true },
      });

      if (recentOrders.length < 2) {
        return { detected: false, reason: 'insufficient_data' };
      }

      // Find max price move in the time window using order prices
      const prices = recentOrders.map(o => Number(o.price || 0)).filter(p => p > 0);
      if (prices.length < 2) {
        return { detected: false, reason: 'insufficient_data' };
      }

      const startPrice = prices[0];
      const maxPrice = Math.max(...prices);
      const minPrice = Math.min(...prices);

      const upMovePct = ((maxPrice - startPrice) / startPrice) * 100;
      const downMovePct = Math.abs(((minPrice - startPrice) / startPrice) * 100);
      const maxMovePct = Math.max(upMovePct, downMovePct);

      const detected = maxMovePct >= this.config.blackSwanVolatilityThreshold;

      return {
        detected,
        priceMovePct: maxMovePct,
        timeWindowMinutes: this.config.blackSwanLookbackMinutes,
        reason: detected ? `${maxMovePct.toFixed(2)}% move in ${this.config.blackSwanLookbackMinutes}min` : undefined,
      };
    } catch (error) {
      console.error('Error detecting black swan:', error);
      return { detected: false, reason: 'error_checking' };
    }
  }

  /**
   * Calculate regime-aware position sizing multiplier
   */
  calculateRegimeMultiplier(regime: RegimeProfile): number {
    if (!this.config.enableRegimeAwareSizing) {
      return 1.0;
    }

    // Use regime's risk modifier if available
    if (regime.riskModifier) {
      return regime.riskModifier.sizingMultiplier || 1.0;
    }

    // Fallback to volatility-based multiplier
    switch (regime.volatility) {
      case 'low':
        return this.config.lowVolatilityMultiplier;
      case 'high':
        return this.config.highVolatilityMultiplier;
      case 'medium':
      default:
        return 1.0;
    }
  }

  /**
   * Calculate regime-aware multiplier from technical snapshot
   */
  calculateRegimeMultiplierFromSnapshot(snapshot: TechnicalSnapshot & {
    realizedVol?: number;
    hurst?: number;
    adxSlope?: number;
    trendStrength?: number;
  }): number {
    const regime = classifyRegime(snapshot);
    return this.calculateRegimeMultiplier(regime);
  }

  /**
   * Detect flash crash: rapid price drops in short timeframe
   * This provides faster detection than black swan for immediate crashes
   */
  async detectFlashCrash(symbol: string): Promise<{ detected: boolean; priceMovePct?: number; reason?: string }> {
    try {
      const lookbackTime = new Date();
      lookbackTime.setMinutes(lookbackTime.getMinutes() - this.config.flashCrashDetectionMinutes);

      // Check recent order prices for rapid drops
      const recentOrders = await prisma.order.findMany({
        where: {
          symbol,
          status: { in: ['filled', 'closed'] },
          price: { not: null },
          createdAt: { gte: lookbackTime },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: { price: true, createdAt: true },
      });

      if (recentOrders.length < 2) {
        return { detected: false, reason: 'insufficient_data' };
      }

      const prices = recentOrders.map(o => Number(o.price || 0)).filter(p => p > 0);
      if (prices.length < 2) {
        return { detected: false, reason: 'insufficient_data' };
      }

      // Calculate max drop from any point to subsequent low
      let maxDrop = 0;
      for (let i = 0; i < prices.length - 1; i++) {
        for (let j = i + 1; j < prices.length; j++) {
          const drop = ((prices[i] - prices[j]) / prices[i]) * 100;
          if (drop > maxDrop) {
            maxDrop = drop;
          }
        }
      }

      const detected = maxDrop >= this.config.flashCrashThresholdPct;

      if (detected) {
        console.warn(`🚨 Flash crash detected on ${symbol}: ${maxDrop.toFixed(2)}% drop in ${this.config.flashCrashDetectionMinutes} minutes`);
      }

      return {
        detected,
        priceMovePct: maxDrop,
        reason: detected ? `${maxDrop.toFixed(2)}% drop in ${this.config.flashCrashDetectionMinutes}min` : undefined,
      };
    } catch (error) {
      console.error('Error detecting flash crash:', error);
      return { detected: false, reason: 'error_checking' };
    }
  }

  /**
   * Check liquidity for a symbol to detect liquidity traps
   * Returns true if liquidity is acceptable, false if too low
   */
  async checkLiquidity(symbol: string): Promise<{ adequate: boolean; volume24h?: number; reason?: string }> {
    if (!this.config.enableContinuousLiquidityCheck) {
      return { adequate: true, reason: 'liquidity_check_disabled' };
    }

    try {
      // Get recent volume from database via orders
      const oneDayAgo = new Date();
      oneDayAgo.setHours(oneDayAgo.getHours() - 24);

      const recentFills = await prisma.fill.findMany({
        where: {
          ts: { gte: oneDayAgo },
          order: {
            symbol,
          },
        },
        select: {
          qty: true,
          price: true,
        },
      });

      if (recentFills.length === 0) {
        // No data available, assume adequate
        return { adequate: true, reason: 'no_data_available' };
      }

      // Calculate approximate 24h volume in USD
      const volume24h = recentFills.reduce((sum, fill) => {
        return sum + (Number(fill.qty || 0) * Number(fill.price || 0));
      }, 0);

      const adequate = volume24h >= this.config.minLiquidityThreshold;

      if (!adequate) {
        console.warn(`⚠️ Low liquidity detected on ${symbol}: $${volume24h.toFixed(0)} (threshold: $${this.config.minLiquidityThreshold})`);
      }

      return {
        adequate,
        volume24h,
        reason: adequate ? undefined : `Volume ${volume24h.toFixed(0)} below threshold ${this.config.minLiquidityThreshold}`,
      };
    } catch (error) {
      console.error('Error checking liquidity:', error);
      // On error, assume adequate to avoid false positives
      return { adequate: true, reason: 'error_checking' };
    }
  }

  /**
   * Comprehensive risk check combining all advanced risk controls
   */
  async checkRisk(params: {
    sessionId: string;
    symbol: string;
    currentEquity: number;
    circuitBreaker?: CircuitBreaker;
    technicalSnapshot?: TechnicalSnapshot & {
      realizedVol?: number;
      hurst?: number;
      adxSlope?: number;
      trendStrength?: number;
    };
  }): Promise<AdvancedRiskDecision> {
    const { sessionId, symbol, currentEquity, circuitBreaker, technicalSnapshot } = params;

    // 1. Check basic circuit breaker first
    let circuitBreakerActive = false;
    if (circuitBreaker) {
      const cbDecision = circuitBreaker.canOpenTrade(new Date(), currentEquity);
      if (!cbDecision.allowed) {
        return {
          allowed: false,
          sizeMultiplier: 0,
          reason: cbDecision.reason,
          circuitBreakerActive: true,
        };
      }
      circuitBreakerActive = false;
    }

    // 2. Check for flash crash (faster than black swan)
    const flashCrash = await this.detectFlashCrash(symbol);
    if (flashCrash.detected) {
      return {
        allowed: false,
        sizeMultiplier: 0,
        reason: `Flash crash detected: ${flashCrash.reason}`,
        flashCrashDetected: true,
      };
    }

    // 3. Check for catastrophic daily loss
    const catastrophicLoss = await this.detectCatastrophicDailyLoss(sessionId, currentEquity);
    if (catastrophicLoss) {
      return {
        allowed: false,
        sizeMultiplier: 0,
        reason: `Catastrophic daily loss detected (>${this.config.catastrophicDailyLossPct}% of equity)`,
      };
    }

    // 4. Check for black swan volatility
    const blackSwan = await this.detectBlackSwan(symbol);
    if (blackSwan.detected) {
      return {
        allowed: false,
        sizeMultiplier: 0,
        reason: `Black swan detected: ${blackSwan.reason}`,
        blackSwanDetected: true,
      };
    }

    // 5. Calculate drawdown-based size adjustment
    const drawdownState = await this.calculateDrawdown(sessionId, currentEquity);
    
    // Check for hard halt condition
    if (drawdownState.hardHaltTriggered) {
      return {
        allowed: false,
        sizeMultiplier: 0,
        reason: drawdownState.hardHaltReason,
        drawdownState,
        hardHaltTriggered: true,
      };
    }
    
    let sizeMultiplier = drawdownState.sizeMultiplier;

    // 6. Check liquidity (warning only, doesn't block but reduces size)
    const liquidityCheck = await this.checkLiquidity(symbol);
    let liquidityWarning = false;
    if (!liquidityCheck.adequate) {
      liquidityWarning = true;
      sizeMultiplier *= 0.5; // Reduce size by 50% in low liquidity
      console.warn(`⚠️ Reducing position size by 50% due to low liquidity on ${symbol}`);
    }

    // 7. Apply regime-aware sizing if technical snapshot provided
    let regimeMultiplier = 1.0;
    if (technicalSnapshot) {
      regimeMultiplier = this.calculateRegimeMultiplierFromSnapshot(technicalSnapshot);
      sizeMultiplier *= regimeMultiplier;
    }

    // 8. Apply circuit breaker size multiplier
    if (circuitBreaker) {
      const cbSizeMultiplier = circuitBreaker.sizeMultiplier();
      sizeMultiplier *= cbSizeMultiplier;
    }

    // Ensure minimum size multiplier
    sizeMultiplier = Math.max(0.1, sizeMultiplier);

    const reasons: string[] = [];
    if (drawdownState.isInDrawdown) {
      reasons.push(`Drawdown control: ${drawdownState.currentDrawdownPct.toFixed(2)}% from peak`);
    }
    if (regimeMultiplier < 1.0) {
      reasons.push(`Regime adjustment: ${regimeMultiplier.toFixed(2)}x`);
    }
    if (liquidityWarning) {
      reasons.push(`Low liquidity warning: size reduced 50%`);
    }

    return {
      allowed: true,
      sizeMultiplier,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
      drawdownState,
      blackSwanDetected: false,
      regimeAdjustment: regimeMultiplier,
      circuitBreakerActive,
      hardHaltTriggered: false,
      flashCrashDetected: false,
      liquidityWarning,
    };
  }

  /**
   * Clear cached state for a session (useful when session ends)
   */
  clearSession(sessionId: string): void {
    this.drawdownStates.delete(sessionId);
  }

  /**
   * Get current drawdown state for a session
   */
  getDrawdownState(sessionId: string): DrawdownState | undefined {
    return this.drawdownStates.get(sessionId);
  }
}
