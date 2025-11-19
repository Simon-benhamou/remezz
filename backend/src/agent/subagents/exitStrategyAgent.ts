/**
 * Exit Strategy Subagent
 * 
 * Learns optimal exit strategies for each symbol:
 * - Best R-multiples for partial exits (scale out)
 * - Optimal trailing stop distance
 * - When to lock in profits vs let winners run
 * 
 * Most impactful learning subagent (+5-8% return improvement)
 */

import { getSubagentTuning } from '../../services/subagentLearning.js';
import type { TechnicalSnapshot } from '../../ai/tech.js';

export type ExitStrategyRecommendation = {
  scaleOutPlan: Array<{ rMultiple: number; exitPct: number }>;
  trailingStopAtrMultiplier: number;
  trailingStopActivationR: number;
  maxHoldTimeMs: number;
  lockProfitThreshold: number; // R-multiple to start being defensive
  confidence: number;
  reason: string;
};

export type ExitAgentLearningRecommendation = {
  // Partial exit recommendations
  firstExitR: number; // R-multiple for first partial exit
  firstExitPct: number; // % to exit
  secondExitR: number;
  secondExitPct: number;
  
  // Trailing stop tuning
  trailingAtrMult: number; // ATR multiplier for trailing distance
  trailingActivationR: number; // R-multiple to activate trailing
  
  // Time-based
  maxHoldHours: number; // Adaptive max hold time
  
  // Risk management
  lockProfitR: number; // Start tightening stop at this R
  
  confidence: number;
};

export class ExitStrategyAgent {
  /**
   * Generate optimal exit strategy based on position state and learning
   */
  async generateExitStrategy(
    symbol: string,
    tech: TechnicalSnapshot,
    currentR: number,
    timeInPositionMs: number,
    volatility: number
  ): Promise<ExitStrategyRecommendation> {
    // Fetch learning recommendations
    const learning = await getSubagentTuning('exit_strategy', symbol) as ExitAgentLearningRecommendation | null;
    
    if (!learning) {
      return this.getDefaultStrategy(volatility);
    }
    
    // Build scale-out plan from learning
    const scaleOutPlan: Array<{ rMultiple: number; exitPct: number }> = [];
    
    if (learning.firstExitR > 0 && learning.firstExitPct > 0) {
      scaleOutPlan.push({
        rMultiple: learning.firstExitR,
        exitPct: learning.firstExitPct,
      });
    }
    
    if (learning.secondExitR > 0 && learning.secondExitPct > 0) {
      scaleOutPlan.push({
        rMultiple: learning.secondExitR,
        exitPct: learning.secondExitPct,
      });
    }
    
    // Add final exit at very high R (let 10-20% run)
    const remainingPct = 1.0 - scaleOutPlan.reduce((sum, exit) => sum + exit.exitPct, 0);
    if (remainingPct > 0.05) {
      scaleOutPlan.push({
        rMultiple: 8.0, // Exit remainder at 8R
        exitPct: remainingPct,
      });
    }
    
    // Adjust trailing stop based on volatility
    const volatilityAdjustment = volatility > 5 ? 1.2 : volatility < 2 ? 0.8 : 1.0;
    const trailingStopAtrMultiplier = learning.trailingAtrMult * volatilityAdjustment;
    
    // Adjust max hold time based on current performance
    const performanceAdjustment = currentR > 1.5 ? 1.5 : currentR < 0 ? 0.7 : 1.0;
    const maxHoldTimeMs = learning.maxHoldHours * 3600_000 * performanceAdjustment;
    
    return {
      scaleOutPlan,
      trailingStopAtrMultiplier: Math.max(0.8, Math.min(2.5, trailingStopAtrMultiplier)),
      trailingStopActivationR: learning.trailingActivationR,
      maxHoldTimeMs,
      lockProfitThreshold: learning.lockProfitR,
      confidence: learning.confidence,
      reason: `learning: first=${learning.firstExitR.toFixed(1)}R(${(learning.firstExitPct*100).toFixed(0)}%), trailing=${trailingStopAtrMultiplier.toFixed(1)}xATR`,
    };
  }
  
  /**
   * Should we take partial profit now?
   */
  shouldTakePartialProfit(
    currentR: number,
    strategy: ExitStrategyRecommendation,
    alreadyExitedPct: number
  ): { shouldExit: boolean; exitPct: number; reason: string } {
    for (const exit of strategy.scaleOutPlan) {
      if (currentR >= exit.rMultiple && alreadyExitedPct < exit.exitPct) {
        const remainingToExit = exit.exitPct - alreadyExitedPct;
        if (remainingToExit > 0.05) { // At least 5% worth exiting
          return {
            shouldExit: true,
            exitPct: remainingToExit,
            reason: `scale_out_at_${exit.rMultiple.toFixed(1)}R`,
          };
        }
      }
    }
    
    return {
      shouldExit: false,
      exitPct: 0,
      reason: 'no_scale_out_target_reached',
    };
  }
  
  /**
   * Should we lock in profits by tightening stop?
   */
  shouldLockProfits(
    currentR: number,
    strategy: ExitStrategyRecommendation,
    currentStopDistance: number
  ): { shouldTighten: boolean; newStopDistance: number; reason: string } {
    if (currentR < strategy.lockProfitThreshold) {
      return {
        shouldTighten: false,
        newStopDistance: currentStopDistance,
        reason: 'below_lock_threshold',
      };
    }
    
    // Above threshold - tighten stop to lock in profits
    const tightenFactor = 0.6; // Reduce stop distance by 40%
    const newStopDistance = currentStopDistance * tightenFactor;
    
    return {
      shouldTighten: true,
      newStopDistance,
      reason: `lock_profits_at_${currentR.toFixed(1)}R`,
    };
  }
  
  private getDefaultStrategy(volatility: number): ExitStrategyRecommendation {
    // Conservative defaults
    return {
      scaleOutPlan: [
        { rMultiple: 2.0, exitPct: 0.33 }, // Exit 33% at 2R
        { rMultiple: 3.5, exitPct: 0.33 }, // Exit 33% at 3.5R
        { rMultiple: 6.0, exitPct: 0.34 }, // Exit remaining at 6R
      ],
      trailingStopAtrMultiplier: volatility > 5 ? 1.5 : 1.0,
      trailingStopActivationR: 2.0,
      maxHoldTimeMs: 24 * 3600_000, // 24 hours
      lockProfitThreshold: 2.5,
      confidence: 0.6,
      reason: 'default_conservative_strategy',
    };
  }
}

// Singleton instance
let exitStrategyAgent: ExitStrategyAgent | null = null;

export function getExitStrategyAgent(): ExitStrategyAgent {
  if (!exitStrategyAgent) {
    exitStrategyAgent = new ExitStrategyAgent();
  }
  return exitStrategyAgent;
}
