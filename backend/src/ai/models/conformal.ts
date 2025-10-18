import type { ContextFeatures } from '../features/featureBuilder.js';
import type { LabeledRow } from '../labeling/tripleBarrier.js';
import { ProbModel } from './probModel.js';

export interface ConformalInterval {
  p_low: number;
  p_high: number;
}

export interface ConformalConfig {
  alpha?: number;
}

const DEFAULT_ALPHA = 0.1;

export class Conformal {
  private residuals: number[] = [];
  private readonly alpha: number;
  private readonly model: ProbModel;

  constructor(model: ProbModel, config: ConformalConfig = {}) {
    this.model = model;
    this.alpha = config.alpha ?? DEFAULT_ALPHA;
  }

  calibrate(dataset: LabeledRow[]): void {
    const residuals: number[] = [];
    for (const row of dataset) {
      if (row.y === null) continue;
      const prediction = this.model.predictProba(row.x);
      residuals.push(Math.abs((row.y as number) - prediction.p_win_cal));
    }
    if (!residuals.length) {
      this.residuals = [0.25];
      return;
    }
    residuals.sort((a, b) => a - b);
    const index = Math.min(residuals.length - 1, Math.floor((1 - this.alpha) * residuals.length));
    const q = residuals[index];
    this.residuals = [q];
  }

  interval(features: ContextFeatures): ConformalInterval {
    const { p_win_cal } = this.model.predictProba(features);
    const radius = this.residuals[0] ?? 0.25;
    const p_low = Math.max(0, p_win_cal - radius);
    const p_high = Math.min(1, p_win_cal + radius);
    return { p_low, p_high };
  }
}
