import type { ContextFeatures } from '../features/featureBuilder.js';

export interface HardGateOptions {
  minVolumeUsd: number;
  maxSpreadBps: number;
  minDepthUsd: number;
  minPassiveFillRate: number;
  atrToTpMin: number;
  atrToTpMax: number;
}

export interface HardGateInput {
  features: ContextFeatures;
  atrPct: number;
  tpPct: number;
}

export function passesHardGates(input: HardGateInput, options: HardGateOptions): { ok: boolean; reason?: string } {
  const micro = input.features.micro;
  if (micro.volume24hUsd < options.minVolumeUsd) {
    return { ok: false, reason: 'volume' };
  }
  if (micro.spreadBps > options.maxSpreadBps) {
    return { ok: false, reason: 'spread' };
  }
  if (micro.bidDepthUsd < options.minDepthUsd || micro.askDepthUsd < options.minDepthUsd) {
    return { ok: false, reason: 'depth' };
  }
  if (micro.passiveFillRate < options.minPassiveFillRate) {
    return { ok: false, reason: 'fill_rate' };
  }
  const ratio = input.tpPct === 0 ? 0 : input.atrPct / input.tpPct;
  if (ratio < options.atrToTpMin || ratio > options.atrToTpMax) {
    return { ok: false, reason: 'atr_alignment' };
  }
  return { ok: true };
}

export interface QuantilePolicyConfig {
  trend: number;
  range: number;
  volatile: number;
  pfLow: number;
  pfHigh: number;
  step: number;
}

export function passesQuantile(regime: 'bull' | 'bear' | 'neutral', probability: number, pfRolling: number, config: QuantilePolicyConfig): boolean {
  const base = regime === 'neutral' ? config.range : regime === 'bull' || regime === 'bear' ? config.trend : config.volatile;
  let threshold = base;
  if (pfRolling < config.pfLow) threshold += config.step;
  if (pfRolling > config.pfHigh) threshold -= config.step;
  threshold = Math.min(Math.max(threshold, 0), 0.99);
  return probability >= threshold;
}
