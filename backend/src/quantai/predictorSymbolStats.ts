/**
 * STUB FILE - Predictor symbol stats has been removed
 * This file provides stub implementations to maintain build compatibility
 */

export type PredictorSymbolStats = {
  symbol: string;
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;
  lastUpdated: number;
  winRate: number;
  completedTrades: number;
  lowConfidenceShortLossStreak: number;
};

export function getPredictorSymbolStats(_symbol: string): Promise<PredictorSymbolStats | null> {
  return Promise.resolve(null);
}

export function updatePredictorSymbolStats(
  _symbol: string,
  _wasCorrect: boolean,
  _decision?: string
): void {
  // No-op
}
