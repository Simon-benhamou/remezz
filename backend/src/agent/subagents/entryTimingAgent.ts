/**
 * Entry Timing Subagent
 * 
 * Learns optimal entry timing for each symbol:
 * - Should we enter immediately on breakout?
 * - Should we wait for retest/pullback?
 * - How aggressive should entry be based on volatility?
 * 
 * Uses historical performance to optimize entry decisions.
 */

import { getSubagentTuning, type SubagentLearningRecommendations } from '../../services/subagentLearning.js';
import type { TechnicalSnapshot } from '../../ai/tech.js';

export type EntryTimingRecommendation = {
  action: 'immediate' | 'wait_pullback' | 'wait_confirmation';
  aggressiveness: number; // 0-1, affects position size multiplier
  optimalEntryOffset: number; // BPS from current price (negative = wait for dip)
  confidence: number;
  reason: string;
};

export type EntryAgentLearningRecommendation = {
  defaultAction: 'immediate' | 'wait_pullback' | 'wait_confirmation';
  aggressivenessMultiplier: number; // 0.5-1.5
  pullbackThresholdBps: number; // How much pullback to wait for
  confirmationBars: number; // How many bars to confirm
  confidence: number;
};

export class EntryTimingAgent {
  /**
   * Evaluate optimal entry timing based on market conditions and learning
   */
  async evaluateEntryTiming(
    symbol: string,
    tech: TechnicalSnapshot,
    signalStrength: number
  ): Promise<EntryTimingRecommendation> {
    // Fetch learning recommendations
    const learning = await getSubagentTuning('entry_timing', symbol) as EntryAgentLearningRecommendation | null;
    
    // Analyze current market conditions
    const volatility = (tech.atr14 / tech.last) * 100; // % volatility
    const momentum = this.analyzeMomentum(tech);
    const trendStrength = this.analyzeTrendStrength(tech);
    
    // Default behavior without learning
    if (!learning) {
      return this.getDefaultRecommendation(volatility, momentum, trendStrength, signalStrength);
    }
    
    // Apply learning-based recommendations
    const baseAction = learning.defaultAction;
    let action: EntryTimingRecommendation['action'] = baseAction;
    let aggressiveness = 1.0 * learning.aggressivenessMultiplier;
    let optimalEntryOffset = 0;
    
    // Adjust based on current conditions
    if (volatility > 5 && baseAction === 'immediate') {
      // High volatility + immediate default = wait for pullback
      action = 'wait_pullback';
      optimalEntryOffset = -learning.pullbackThresholdBps;
      aggressiveness *= 0.8;
    } else if (momentum < 0.3 && baseAction !== 'wait_confirmation') {
      // Low momentum = wait for confirmation
      action = 'wait_confirmation';
      aggressiveness *= 0.7;
    } else if (signalStrength > 0.85 && volatility < 3) {
      // Very strong signal + low volatility = be aggressive
      action = 'immediate';
      aggressiveness *= 1.2;
    }
    
    // Calculate confidence
    const confidence = Math.min(1.0, learning.confidence * (signalStrength + 0.2));
    
    return {
      action,
      aggressiveness: Math.max(0.5, Math.min(1.5, aggressiveness)),
      optimalEntryOffset,
      confidence,
      reason: `learning_based: ${baseAction}, vol=${volatility.toFixed(1)}%, momentum=${momentum.toFixed(2)}`,
    };
  }
  
  private getDefaultRecommendation(
    volatility: number,
    momentum: number,
    trendStrength: number,
    signalStrength: number
  ): EntryTimingRecommendation {
    // Conservative defaults
    if (volatility > 6) {
      return {
        action: 'wait_pullback',
        aggressiveness: 0.7,
        optimalEntryOffset: -20, // Wait for 20bps pullback
        confidence: 0.6,
        reason: 'high_volatility_default',
      };
    }
    
    if (momentum < 0.4) {
      return {
        action: 'wait_confirmation',
        aggressiveness: 0.8,
        optimalEntryOffset: 0,
        confidence: 0.7,
        reason: 'low_momentum_default',
      };
    }
    
    return {
      action: 'immediate',
      aggressiveness: 1.0,
      optimalEntryOffset: 0,
      confidence: 0.8,
      reason: 'normal_conditions_default',
    };
  }
  
  private analyzeMomentum(tech: TechnicalSnapshot): number {
    // Use RSI and price velocity
    const rsiMomentum = (tech.rsi14 - 50) / 50; // -1 to 1
    const normalizedMomentum = (rsiMomentum + 1) / 2; // 0 to 1
    return Math.max(0, Math.min(1, normalizedMomentum));
  }
  
  private analyzeTrendStrength(tech: TechnicalSnapshot): number {
    // Use ADX
    const adxStrength = Math.min(100, tech.adx14 || 0) / 100;
    return adxStrength;
  }
}

// Singleton instance
let entryTimingAgent: EntryTimingAgent | null = null;

export function getEntryTimingAgent(): EntryTimingAgent {
  if (!entryTimingAgent) {
    entryTimingAgent = new EntryTimingAgent();
  }
  return entryTimingAgent;
}
