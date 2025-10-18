import type { ContextFeatures } from '../features/featureBuilder.js';
import type { StrategyKind } from './strategyScorer.js';

export interface StrategyAction { kind: StrategyKind }

export interface BanditContext {
  adx: number;
  emaSlope: number;
  bbWidth: number;
  spreadBps: number;
  passiveFillRate: number;
}

interface BanditArmState {
  alpha: number;
  beta: number;
}

type ContextKey = string;

function toKey(ctx: BanditContext): ContextKey {
  return [
    Math.round(ctx.adx * 10) / 10,
    Math.round(ctx.emaSlope * 100) / 100,
    Math.round(ctx.bbWidth * 1000) / 1000,
    Math.round(ctx.spreadBps),
    Math.round(ctx.passiveFillRate * 100) / 100,
  ].join('|');
}

export class ContextualBandit {
  private readonly state = new Map<ContextKey, Map<StrategyKind, BanditArmState>>();
  private readonly rng: () => number;

  constructor(seed = 42) {
    let s = seed;
    this.rng = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  choose(ctx: BanditContext, actions: StrategyKind[]): StrategyAction {
    const key = toKey(ctx);
    const arms = this.ensureContext(key, actions);
    let best: StrategyKind | null = null;
    let bestSample = -Infinity;
    for (const action of actions) {
      const arm = arms.get(action)!;
      const sample = this.sampleBeta(arm.alpha, arm.beta);
      if (sample > bestSample) {
        bestSample = sample;
        best = action;
      }
    }
    return { kind: best ?? actions[0] };
  }

  update(ctx: BanditContext, action: StrategyKind, reward: number): void {
    const key = toKey(ctx);
    const arms = this.ensureContext(key, [action]);
    const arm = arms.get(action)!;
    const clipped = Math.max(Math.min(reward, 5), -5);
    if (clipped >= 0) {
      arm.alpha += clipped;
    } else {
      arm.beta += Math.abs(clipped);
    }
  }

  private ensureContext(key: ContextKey, actions: StrategyKind[]): Map<StrategyKind, BanditArmState> {
    let arms = this.state.get(key);
    if (!arms) {
      arms = new Map();
      this.state.set(key, arms);
    }
    for (const action of actions) {
      if (!arms.has(action)) {
        arms.set(action, { alpha: 1, beta: 1 });
      }
    }
    return arms;
  }

  private sampleBeta(alpha: number, beta: number): number {
    const a = this.gammaSample(alpha);
    const b = this.gammaSample(beta);
    if (a + b === 0) return 0.5;
    return a / (a + b);
  }

  private gammaSample(shape: number): number {
    if (shape < 1) {
      const u = this.rng();
      return this.gammaSample(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x = this.normalSample();
      let v = 1 + c * x;
      if (v <= 0) continue;
      v = v * v * v;
      const u = this.rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  private normalSample(): number {
    const u1 = this.rng();
    const u2 = this.rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return r * Math.cos(theta);
  }
}

export function selectBanditContext(features: ContextFeatures): BanditContext {
  return {
    adx: features.tf4h.adx14,
    emaSlope: features.tf4h.emaSlope20,
    bbWidth: features.tf4h.bbWidth,
    spreadBps: features.micro.spreadBps,
    passiveFillRate: features.micro.passiveFillRate,
  };
}
