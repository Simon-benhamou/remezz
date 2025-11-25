/**
 * STUB FILE - Predictor functionality has been removed
 * This file provides stub implementations to maintain build compatibility
 */

export type PythonPredictionProbabilities = {
  long: number;
  short: number;
  none: number;
};

export type PythonPredictionResult = {
  decision: 'long' | 'short' | 'none';
  confidence: number;
  probabilities: PythonPredictionProbabilities;
  probabilityLong: number;
  probabilityShort: number;
  probabilityNone: number;
  primaryProbability: number;
  entryWeight: number;
  riskMultiplier: number;
  cooldown: { active: boolean; reason: string | null; seconds: number | null };
  meta?: Record<string, unknown>;
  classOrder?: string[];
};

const STUB_RESULT: PythonPredictionResult = {
  decision: 'none',
  confidence: 0,
  probabilities: { long: 0.33, short: 0.33, none: 0.34 },
  probabilityLong: 0.33,
  probabilityShort: 0.33,
  probabilityNone: 0.34,
  primaryProbability: 0.34,
  entryWeight: 1,
  riskMultiplier: 1,
  cooldown: { active: false, reason: null, seconds: null },
  meta: { source: 'disabled' },
  classOrder: [],
};

// Stub - always returns disabled/neutral result
export function getPrediction(_features: Record<string, number>): Promise<PythonPredictionResult> {
  return Promise.resolve(STUB_RESULT);
}

export function getPredictionSync(_features: Record<string, number>): PythonPredictionResult {
  return STUB_RESULT;
}

export function getPredictionSyncSafe(_features: Record<string, number>, _opts?: { allowFallback?: boolean }): PythonPredictionResult {
  return STUB_RESULT;
}

export function isPythonPredictorAvailable(): boolean {
  return false; // Always disabled
}

export function getPredictorReliabilityMetrics() {
  return {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    reliabilityRate: 0,
    isReliable: false,
    consecutiveFailures: 0,
    lastErrorTimestamp: null,
    lastErrorMessage: null,
  };
}

export function getPythonResolutionError(): Error | null {
  return new Error('Predictor has been disabled');
}
