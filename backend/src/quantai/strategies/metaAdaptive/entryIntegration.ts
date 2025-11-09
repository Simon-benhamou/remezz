/**
 * Meta-Adaptive Entry Integration
 * 
 * Integrates regime-aware thresholds and entry decision visibility
 * into the existing meta-adaptive entry logic.
 */

import { getThresholdsForSymbol, getSymbolTier } from '../../../services/regimeAwareThresholds.js';
import { 
  recordEntryDecision, 
  type EntryDecisionSummary,
  type EntryCheckComponent,
} from '../../../services/entryDecisionVisibility.js';
import type { TechnicalSnapshot } from '../../../ai/tech.js';

export type AggressivenessLevel = 'conservative' | 'reactive' | 'aggressive';

export type EnhancedEntryContext = {
  sessionId: string;
  symbol: string;
  aggressiveness: AggressivenessLevel;
  tech: TechnicalSnapshot & { spreadBps?: number; liquidityScore?: number };
};

export type EnhancedThresholds = {
  confidence: number;
  atr: number;
  adx: number;
  eligibility: number;
  rrMin: number;
  tier: 'A' | 'B' | 'C';
  regimeType: string;
  regimeDirection: string;
};

/**
 * Get enhanced thresholds with regime awareness
 * Now async to support learned parameters
 */
export async function getEnhancedThresholds(context: EnhancedEntryContext): Promise<EnhancedThresholds> {
  try {
    const thresholds = await getThresholdsForSymbol(
      context.symbol,
      context.tech,
      context.aggressiveness
    );

    return {
      confidence: thresholds.confidence,
      atr: thresholds.atr,
      adx: thresholds.adx,
      eligibility: thresholds.eligibility,
      rrMin: thresholds.rrMin,
      tier: thresholds.tier,
      regimeType: thresholds.regime.regime,
      regimeDirection: thresholds.regime.direction,
    };
  } catch (error) {
    console.error('Failed to get enhanced thresholds, using defaults:', error);
    
    // Fallback to current defaults
    return {
      confidence: context.aggressiveness === 'conservative' ? 0.75 :
                  context.aggressiveness === 'aggressive' ? 0.62 : 0.68,
      atr: context.aggressiveness === 'conservative' ? 0.65 :
           context.aggressiveness === 'aggressive' ? 0.45 : 0.55,
      adx: context.aggressiveness === 'conservative' ? 18 :
           context.aggressiveness === 'aggressive' ? 14 : 16,
      eligibility: context.aggressiveness === 'conservative' ? 0.62 :
                   context.aggressiveness === 'aggressive' ? 0.54 : 0.58,
      rrMin: 1.8,
      tier: getSymbolTier(context.symbol),
      regimeType: 'unknown',
      regimeDirection: 'neutral',
    };
  }
}

/**
 * Record entry decision with enhanced details
 */
export async function recordEnhancedEntryDecision(
  context: EnhancedEntryContext,
  decision: {
    allowed: boolean;
    confidence: number;
    overallScore: number;
    components: EntryCheckComponent[];
    blockingReasons: string[];
    warnings: string[];
    thresholds: Partial<EnhancedThresholds>;
  }
): Promise<void> {
  try {
    const summary: EntryDecisionSummary = {
      sessionId: context.sessionId,
      symbol: context.symbol,
      timestamp: Date.now(),
      decision: decision.allowed ? 'allowed' : 'blocked',
      overallScore: decision.overallScore,
      confidence: decision.confidence,
      components: decision.components,
      blockingReasons: decision.blockingReasons,
      warnings: decision.warnings,
      thresholds: decision.thresholds,
      regimeInfo: decision.thresholds.regimeType ? {
        regime: decision.thresholds.regimeType,
        direction: decision.thresholds.regimeDirection || 'neutral',
        volatility: 'normal', // Can be enhanced with actual data
        tags: [],
      } : undefined,
    };

    await recordEntryDecision(context.sessionId, summary);
  } catch (error) {
    console.warn('Failed to record enhanced entry decision:', error);
  }
}

/**
 * Helper to convert existing checklist to EntryCheckComponent format
 */
export function convertChecklistToComponents(
  checklist: any,
  thresholds: EnhancedThresholds
): EntryCheckComponent[] {
  const components: EntryCheckComponent[] = [];

  // MTF component
  if (checklist.components?.mtf) {
    components.push({
      key: 'mtf',
      label: 'Multi-Timeframe Bias',
      status: checklist.components.mtf.status as any,
      detail: checklist.components.mtf.reason || '',
      score: checklist.components.mtf.score,
      impact: checklist.components.mtf.status === 'fail' ? 'blocker' : 'minor',
    });
  }

  // ADX component
  if (checklist.components?.adx) {
    components.push({
      key: 'adx',
      label: 'ADX (Trend Strength)',
      status: checklist.components.adx.status as any,
      detail: checklist.components.adx.reason || '',
      score: checklist.components.adx.score,
      threshold: thresholds.adx,
      impact: checklist.components.adx.status === 'fail' ? 'moderate' : 'minor',
    });
  }

  // ATR component
  if (checklist.components?.atr) {
    components.push({
      key: 'atr',
      label: 'ATR (Volatility)',
      status: checklist.components.atr.status as any,
      detail: checklist.components.atr.reason || '',
      score: checklist.components.atr.score,
      threshold: thresholds.atr,
      impact: checklist.components.atr.status === 'fail' ? 'blocker' : 'minor',
    });
  }

  // Flow component
  if (checklist.components?.flow) {
    components.push({
      key: 'flow',
      label: 'Flow (CMF/Volume)',
      status: checklist.components.flow.status as any,
      detail: checklist.components.flow.reason || '',
      score: checklist.components.flow.score,
      impact: checklist.components.flow.status === 'fail' ? 'moderate' : 'minor',
    });
  }

  // Confidence gate
  components.push({
    key: 'confidence',
    label: 'Confidence Gate',
    status: checklist.confidence?.passed ? 'pass' : 'fail',
    detail: `confidence=${(checklist.confidence?.value || 0).toFixed(4)}>=${checklist.confidence?.threshold || thresholds.confidence}`,
    score: checklist.confidence?.value || null,
    threshold: thresholds.confidence,
    impact: 'blocker',
  });

  // Eligibility score
  components.push({
    key: 'eligibility',
    label: 'Eligibility Score',
    status: checklist.entryEligibility?.passed ? 'pass' : 'fail',
    detail: `score=${(checklist.entryEligibility?.score || 0).toFixed(4)}>=${checklist.entryEligibility?.threshold || thresholds.eligibility}`,
    score: checklist.entryEligibility?.score || null,
    threshold: thresholds.eligibility,
    impact: 'blocker',
  });

  // RR check
  if (checklist.rr) {
    components.push({
      key: 'rr',
      label: 'Risk/Reward Ratio',
      status: checklist.rr.passed ? 'pass' : checklist.rr.value === null ? 'n/a' : 'fail',
      detail: checklist.rr.value !== null 
        ? `rr=${checklist.rr.value.toFixed(2)}>=${checklist.rr.threshold || thresholds.rrMin}`
        : 'rr=n/a',
      score: checklist.rr.value,
      threshold: thresholds.rrMin,
      impact: checklist.rr.passed === false ? 'blocker' : 'minor',
    });
  }

  return components;
}

/**
 * Determine blocking reasons from components
 */
export function extractBlockingReasons(components: EntryCheckComponent[]): string[] {
  const reasons: string[] = [];

  components.forEach(comp => {
    if (comp.status === 'fail' && comp.impact === 'blocker') {
      reasons.push(comp.key);
    }
  });

  return reasons;
}

/**
 * Determine warnings from components
 */
export function extractWarnings(components: EntryCheckComponent[]): string[] {
  const warnings: string[] = [];

  components.forEach(comp => {
    if (comp.status === 'fail' && comp.impact === 'moderate') {
      warnings.push(`${comp.label}: ${comp.detail}`);
    }
    if (comp.status === 'warning') {
      warnings.push(`${comp.label}: ${comp.detail}`);
    }
  });

  return warnings;
}
