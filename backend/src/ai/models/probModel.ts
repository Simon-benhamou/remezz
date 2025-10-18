import type { ContextFeatures } from '../features/featureBuilder.js';
import { flattenFeatures } from '../features/featureBuilder.js';
import type { LabeledRow } from '../labeling/tripleBarrier.js';

export interface ProbModelConfig {
  learningRate?: number;
  iterations?: number;
  regularization?: number;
}

export interface ProbaResult {
  raw: number;
  p_win_cal: number;
}

const DEFAULT_CONFIG: Required<ProbModelConfig> = {
  learningRate: 0.05,
  iterations: 400,
  regularization: 1e-4,
};

function sigmoid(x: number): number {
  if (x < -30) return 1e-13;
  if (x > 30) return 1 - 1e-13;
  return 1 / (1 + Math.exp(-x));
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export class ProbModel {
  private weights: number[] = [];
  private bias = 0;
  private calibration: { a: number; b: number } | null = null;
  private featureSize = 0;
  private readonly cfg: Required<ProbModelConfig>;

  constructor(config: ProbModelConfig = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  fit(dataset: LabeledRow[]): void {
    const filtered = dataset.filter(row => row.y === 0 || row.y === 1);
    if (!filtered.length) {
      throw new Error('No labeled rows to train probability model');
    }
    const vectors = filtered.map(row => flattenFeatures(row.x));
    this.featureSize = vectors[0].length;
    this.weights = new Array(this.featureSize).fill(0);
    this.bias = 0;
    for (let iter = 0; iter < this.cfg.iterations; iter++) {
      const grad = new Array(this.featureSize).fill(0);
      let biasGrad = 0;
      for (let i = 0; i < vectors.length; i++) {
        const vec = vectors[i];
        const target = filtered[i].y as number;
        const pred = sigmoid(dot(this.weights, vec) + this.bias);
        const error = pred - target;
        for (let j = 0; j < this.featureSize; j++) {
          grad[j] += error * vec[j];
        }
        biasGrad += error;
      }
      for (let j = 0; j < this.featureSize; j++) {
        grad[j] = grad[j] / vectors.length + this.cfg.regularization * this.weights[j];
        this.weights[j] -= this.cfg.learningRate * grad[j];
      }
      this.bias -= this.cfg.learningRate * (biasGrad / vectors.length);
    }
    this.calibrate(filtered, vectors.map(vec => sigmoid(dot(this.weights, vec) + this.bias)));
  }

  private calibrate(dataset: LabeledRow[], rawProbs: number[]): void {
    if (!dataset.length) {
      this.calibration = null;
      return;
    }
    let a = 1;
    let b = 0;
    const lr = 0.01;
    const iters = 200;
    for (let iter = 0; iter < iters; iter++) {
      let gradA = 0;
      let gradB = 0;
      for (let i = 0; i < dataset.length; i++) {
        const target = dataset[i].y as number;
        const p = sigmoid(a * logit(rawProbs[i]) + b);
        const error = p - target;
        const base = sigmoidDerivative(a * logit(rawProbs[i]) + b);
        gradA += error * base * logit(rawProbs[i]);
        gradB += error * base;
      }
      a -= lr * gradA / dataset.length;
      b -= lr * gradB / dataset.length;
    }
    this.calibration = { a, b };
  }

  predictProba(x: ContextFeatures): ProbaResult {
    if (!this.weights.length) {
      throw new Error('ProbModel not fitted');
    }
    const vec = flattenFeatures(x);
    if (vec.length !== this.featureSize) {
      throw new Error(`Unexpected feature size ${vec.length}, expected ${this.featureSize}`);
    }
    const raw = sigmoid(dot(this.weights, vec) + this.bias);
    const calibrated = this.calibration ? sigmoid(this.calibration.a * logit(raw) + this.calibration.b) : raw;
    return { raw, p_win_cal: calibrated };
  }
}

function logit(p: number): number {
  const clipped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(clipped / (1 - clipped));
}

function sigmoidDerivative(x: number): number {
  const s = sigmoid(x);
  return s * (1 - s);
}
