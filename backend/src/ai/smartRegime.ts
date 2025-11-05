/**
 * Smart Market Regime
 * 
 * More intelligent regime checks that allow trading with risk adjustments
 * instead of completely blocking opportunities.
 */

import type { RegimeProfile } from './regime.js';

export type SmartRegimeDecision = {
  canTrade: boolean;
  reason: string;
  riskMultiplier: number;      // Position size adjustment (0.5 = half size, 1.0 = normal)
  stopMultiplier: number;       // Stop distance adjustment (0.8 = tighter, 1.2 = wider)
  requireHigherQuality: boolean; // Require higher quality setups (e.g., better R:R)
  minQualityScore?: number;     // Minimum quality score if requireHigherQuality is true
};

export class SmartRegimeAnalyzer {
  /**
   * Evaluate if trading should be allowed with smart risk adjustments
   */
  evaluateRegime(regime: RegimeProfile | null | undefined): SmartRegimeDecision {
    // No regime data - allow with caution
    if (!regime) {
      return {
        canTrade: true,
        reason: 'no_regime_data_proceeding_with_caution',
        riskMultiplier: 0.8,
        stopMultiplier: 1.0,
        requireHigherQuality: true,
        minQualityScore: 0.65,
      };
    }

    // Check original shouldTrade flag
    if (regime.shouldTrade === false) {
      // Analyze why it's blocked and if we can still trade with adjustments
      return this.analyzeBlockedRegime(regime);
    }

    // Regime allows trading - apply risk modifiers if present
    if (regime.riskModifier) {
      return {
        canTrade: true,
        reason: regime.riskModifier.reason || 'regime_risk_modifier_applied',
        riskMultiplier: regime.riskModifier.sizingMultiplier ?? 1.0,
        stopMultiplier: regime.riskModifier.stopMultiplier ?? 1.0,
        requireHigherQuality: regime.riskModifier.level === 'extreme',
        minQualityScore: regime.riskModifier.level === 'extreme' ? 0.75 : undefined,
      };
    }

    // Normal trading conditions
    return {
      canTrade: true,
      reason: 'normal_regime',
      riskMultiplier: 1.0,
      stopMultiplier: 1.0,
      requireHigherQuality: false,
    };
  }

  /**
   * Analyze blocked regime and determine if we can trade with strict conditions
   */
  private analyzeBlockedRegime(regime: RegimeProfile): SmartRegimeDecision {
    const { playbook, volatility, trendStrength, adxSlope, hurst } = regime;

    // Violent spike - truly dangerous, but allow for exceptional opportunities only
    if (playbook === 'standby' && regime.notes && regime.notes.indexOf('disorderly_spike') !== -1) {
      return {
        canTrade: true, // Changed from false - allow exceptional setups
        reason: 'violent_spike_exceptional_only',
        riskMultiplier: 0.15, // Very small size
        stopMultiplier: 1.2,  // Wider stops for volatility
        requireHigherQuality: true,
        minQualityScore: 0.90, // Only top 10% quality setups
      };
    }

    // Catastrophic volatility with structure collapse
    if (regime.notes && regime.notes.indexOf('catastrophic_volatility') !== -1) {
      return {
        canTrade: true, // Changed from blocking - allow with extreme caution
        reason: 'catastrophic_vol_high_quality_only',
        riskMultiplier: 0.25, // Quarter size
        stopMultiplier: 1.1,  // Slightly wider stops
        requireHigherQuality: true,
        minQualityScore: 0.85, // Top 15% quality
      };
    }

    // High volatility scenarios
    if (volatility === 'high') {
      // Assess if momentum is strong enough to trade breakouts
      const strongMomentum = trendStrength > 0.35 && Math.abs(adxSlope) > 0.5;
      const trendPersistence = hurst > 0.55;

      if (strongMomentum || trendPersistence) {
        return {
          canTrade: true,
          reason: 'high_vol_strong_momentum_allowed',
          riskMultiplier: 0.6,
          stopMultiplier: 1.15,
          requireHigherQuality: true,
          minQualityScore: 0.70,
        };
      }

      // Weak structure but not catastrophic - allow defensive trading
      return {
        canTrade: true,
        reason: 'high_vol_defensive_trading',
        riskMultiplier: 0.4,
        stopMultiplier: 1.0,
        requireHigherQuality: true,
        minQualityScore: 0.75,
      };
    }

    // Generic standby - likely structural issues but not catastrophic
    if (playbook === 'standby') {
      return {
        canTrade: true,
        reason: 'standby_regime_selective_trading',
        riskMultiplier: 0.5,
        stopMultiplier: 1.0,
        requireHigherQuality: true,
        minQualityScore: 0.72,
      };
    }

    // Default for any blocked regime - allow with heavy restrictions
    return {
      canTrade: true,
      reason: 'blocked_regime_override_with_restrictions',
      riskMultiplier: 0.4,
      stopMultiplier: 1.05,
      requireHigherQuality: true,
      minQualityScore: 0.75,
    };
  }

  /**
   * Get human-readable explanation of regime decision
   */
  explainDecision(decision: SmartRegimeDecision): string {
    const parts: string[] = [];

    if (!decision.canTrade) {
      parts.push('❌ Trading blocked');
    } else if (decision.requireHigherQuality) {
      parts.push('⚠️ Trading allowed with restrictions');
    } else {
      parts.push('✅ Normal trading conditions');
    }

    parts.push(`Risk: ${(decision.riskMultiplier * 100).toFixed(0)}% of normal`);
    
    if (decision.stopMultiplier !== 1.0) {
      const stopAdj = decision.stopMultiplier > 1.0 ? 'wider' : 'tighter';
      parts.push(`Stops: ${(decision.stopMultiplier * 100).toFixed(0)}% (${stopAdj})`);
    }

    if (decision.requireHigherQuality && decision.minQualityScore) {
      parts.push(`Min quality: ${(decision.minQualityScore * 100).toFixed(0)}%`);
    }

    parts.push(`(${decision.reason})`);

    return parts.join(' | ');
  }

  /**
   * Check if a specific opportunity meets regime requirements
   */
  meetsRegimeRequirements(
    decision: SmartRegimeDecision,
    opportunityQuality: number
  ): {
    allowed: boolean;
    reason: string;
  } {
    if (!decision.canTrade) {
      return {
        allowed: false,
        reason: 'Regime blocks all trading',
      };
    }

    if (decision.requireHigherQuality && decision.minQualityScore) {
      if (opportunityQuality < decision.minQualityScore) {
        return {
          allowed: false,
          reason: `Quality ${(opportunityQuality * 100).toFixed(0)}% below required ${(decision.minQualityScore * 100).toFixed(0)}%`,
        };
      }
    }

    return {
      allowed: true,
      reason: 'Meets regime requirements',
    };
  }
}

// Singleton instance
export const smartRegimeAnalyzer = new SmartRegimeAnalyzer();
