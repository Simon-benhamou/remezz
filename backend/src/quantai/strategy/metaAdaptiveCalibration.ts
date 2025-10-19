import type { StrategyFamily } from './strategyTypes.js';

export type CalibrationProfile = {
  familyScoreAdjustments: Record<StrategyFamily, number>;
  minConfidence: number;
  explorationFloor: number;
};

export const defaultCalibrationProfile: CalibrationProfile = {
  familyScoreAdjustments: {
    trend: 0,
    breakout: 0,
    mean_reversion: 0,
    momentum: 0,
  },
  minConfidence: 0.2,
  explorationFloor: 0.02,
};
