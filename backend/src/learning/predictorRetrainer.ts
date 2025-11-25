/**
 * STUB FILE - Predictor retrainer has been removed
 * This file provides stub implementations to maintain build compatibility
 */

export function triggerManualRetraining(): Promise<{ success: boolean; message: string }> {
  return Promise.resolve({
    success: false,
    message: 'Predictor retraining has been disabled',
  });
}

export function getRetrainingStatus(): { isRetraining: boolean; lastRetrained: number | null; error: string | null } {
  return {
    isRetraining: false,
    lastRetrained: null,
    error: 'Predictor has been disabled',
  };
}
