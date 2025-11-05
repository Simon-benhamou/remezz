/**
 * Smart Trade Limits
 * 
 * Dynamic daily trade limits that adapt based on performance and opportunity quality
 * to avoid missing good opportunities while still maintaining risk controls.
 */

export type SmartTradeLimitConfig = {
  baseLimit: number;
  minLimit: number;
  maxLimit: number;
  winRateThresholds: {
    excellent: number;  // e.g., 0.70 - allow more trades
    good: number;       // e.g., 0.55 - keep base limit
    poor: number;       // e.g., 0.40 - reduce limit
  };
  opportunityQualityBonus: {
    enabled: boolean;
    maxBonus: number;   // e.g., 3 - allow up to 3 extra trades for high quality
  };
};

export type SmartTradeLimitState = {
  currentLimit: number;
  reason: string;
  winRate: number;
  tradesConsidered: number;
  qualityBonus: number;
};

export class SmartTradeLimits {
  private readonly config: SmartTradeLimitConfig;

  constructor(config: Partial<SmartTradeLimitConfig> = {}) {
    this.config = {
      baseLimit: config.baseLimit ?? 7,
      minLimit: config.minLimit ?? 3,
      maxLimit: config.maxLimit ?? 15,
      winRateThresholds: {
        excellent: config.winRateThresholds?.excellent ?? 0.70,
        good: config.winRateThresholds?.good ?? 0.55,
        poor: config.winRateThresholds?.poor ?? 0.40,
      },
      opportunityQualityBonus: {
        enabled: config.opportunityQualityBonus?.enabled ?? true,
        maxBonus: config.opportunityQualityBonus?.maxBonus ?? 3,
      },
    };
  }

  /**
   * Calculate smart daily trade limit based on performance and opportunity quality
   */
  calculateLimit(params: {
    recentWinRate: number;
    recentTradesCount: number;
    currentTradesToday: number;
    opportunityQuality?: number; // 0-1 scale, 1 being exceptional
  }): SmartTradeLimitState {
    const { recentWinRate, recentTradesCount, currentTradesToday, opportunityQuality = 0.5 } = params;
    
    let limit = this.config.baseLimit;
    let reason = 'base_limit';
    
    // Only adjust based on win rate if we have enough sample size
    if (recentTradesCount >= 5) {
      if (recentWinRate >= this.config.winRateThresholds.excellent) {
        // Excellent performance - increase limit
        const increase = Math.floor((this.config.maxLimit - this.config.baseLimit) * 0.6);
        limit = Math.min(this.config.maxLimit, this.config.baseLimit + increase);
        reason = `excellent_performance_${(recentWinRate * 100).toFixed(0)}pct_winrate`;
      } else if (recentWinRate >= this.config.winRateThresholds.good) {
        // Good performance - slight increase
        const increase = Math.floor((this.config.maxLimit - this.config.baseLimit) * 0.3);
        limit = Math.min(this.config.maxLimit, this.config.baseLimit + increase);
        reason = `good_performance_${(recentWinRate * 100).toFixed(0)}pct_winrate`;
      } else if (recentWinRate < this.config.winRateThresholds.poor) {
        // Poor performance - reduce limit
        const reduction = Math.floor((this.config.baseLimit - this.config.minLimit) * 0.5);
        limit = Math.max(this.config.minLimit, this.config.baseLimit - reduction);
        reason = `poor_performance_${(recentWinRate * 100).toFixed(0)}pct_winrate`;
      }
    }

    // Quality bonus: Allow exceptional opportunities even near limit
    let qualityBonus = 0;
    if (this.config.opportunityQualityBonus.enabled && opportunityQuality >= 0.8) {
      const bonusMultiplier = (opportunityQuality - 0.8) / 0.2; // 0.8-1.0 -> 0-1
      qualityBonus = Math.floor(this.config.opportunityQualityBonus.maxBonus * bonusMultiplier);
      
      // Only apply bonus if we're near the limit
      const nearLimit = currentTradesToday >= limit - 2;
      if (nearLimit && qualityBonus > 0) {
        reason += `_plus_${qualityBonus}_quality_bonus`;
      } else {
        qualityBonus = 0; // Don't apply bonus if not near limit
      }
    }

    return {
      currentLimit: limit + qualityBonus,
      reason,
      winRate: recentWinRate,
      tradesConsidered: recentTradesCount,
      qualityBonus,
    };
  }

  /**
   * Check if trade is allowed with smart limit logic
   */
  canTrade(params: {
    currentTradesToday: number;
    recentWinRate: number;
    recentTradesCount: number;
    opportunityQuality?: number;
  }): {
    allowed: boolean;
    reason: string;
    limitState: SmartTradeLimitState;
  } {
    const limitState = this.calculateLimit(params);
    const allowed = params.currentTradesToday < limitState.currentLimit;

    let reason = '';
    if (!allowed) {
      reason = `Daily smart limit reached (${params.currentTradesToday}/${limitState.currentLimit}): ${limitState.reason}`;
    }

    return {
      allowed,
      reason,
      limitState,
    };
  }

  /**
   * Get recommended action when approaching limit
   */
  getApproachingLimitGuidance(params: {
    currentTradesToday: number;
    recentWinRate: number;
    recentTradesCount: number;
  }): {
    approaching: boolean;
    message: string;
    remainingTrades: number;
  } {
    const limitState = this.calculateLimit({
      ...params,
      opportunityQuality: 0.5, // Use average quality for guidance
    });

    const remainingTrades = Math.max(0, limitState.currentLimit - params.currentTradesToday);
    const approaching = remainingTrades <= 2;

    let message = '';
    if (approaching) {
      message = `${remainingTrades} trade(s) remaining today (limit: ${limitState.currentLimit}, reason: ${limitState.reason})`;
      if (params.recentWinRate < this.config.winRateThresholds.good && params.recentTradesCount >= 5) {
        message += ` - Improve win rate to increase limit`;
      }
    }

    return {
      approaching,
      message,
      remainingTrades,
    };
  }
}
