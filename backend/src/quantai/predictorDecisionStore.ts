/**
 * STUB FILE - Predictor decision store has been removed
 * This file provides stub implementations to maintain build compatibility
 */

export type StoredPredictorDecision = {
  decision: 'long' | 'short' | 'none';
  confidence: number;
  timestamp: number;
};

export function storePredictorDecisionIfChanged(
  _symbol: string,
  _decision: string,
  _confidence: number
): Promise<boolean> {
  return Promise.resolve(false); // No-op
}

export function getCachedPredictorDecision(_symbol: string, _maxAgeMs?: number): 'long' | 'short' | 'none' | null {
  return null;
}
