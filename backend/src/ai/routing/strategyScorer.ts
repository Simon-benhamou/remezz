import type { ContextFeatures } from '../features/featureBuilder.js';

export type StrategyKind = 'PULLBACK' | 'BREAKOUT' | 'MR';

export interface StrategyScore {
  kind: StrategyKind;
  score: number;
  reasons: string[];
}

export function scoreStrategies(features: ContextFeatures): StrategyScore[] {
  const scores: StrategyScore[] = [
    scorePullback(features),
    scoreBreakout(features),
    scoreMeanReversion(features),
  ];
  return scores.sort((a, b) => b.score - a.score);
}

function scorePullback(features: ContextFeatures): StrategyScore {
  const reasons: string[] = [];
  let score = 0;
  if (features.tf4h.trendBias === 'bull' || features.tf4h.trendBias === 'bear') {
    score += 0.3;
    reasons.push(`trendBias=${features.tf4h.trendBias}`);
  }
  const slopeSign = Math.sign(features.tf1h.emaSlope20);
  if (slopeSign > 0 && features.tf4h.trendBias === 'bull') {
    score += 0.25;
    reasons.push('aligned slopes');
  }
  if (slopeSign < 0 && features.tf4h.trendBias === 'bear') {
    score += 0.25;
    reasons.push('aligned slopes');
  }
  if (features.micro.spreadBps < 12) {
    score += 0.2;
    reasons.push('tight spread');
  }
  if (features.tf1h.volRatio > 1.1) {
    score += 0.1;
    reasons.push('volume pickup');
  }
  return { kind: 'PULLBACK', score, reasons };
}

function scoreBreakout(features: ContextFeatures): StrategyScore {
  const reasons: string[] = [];
  let score = 0;
  if (features.tf4h.bbWidth < 0.02) {
    score += 0.3;
    reasons.push('compressed 4h bands');
  }
  if (features.tf1h.volRatio > 1.2) {
    score += 0.25;
    reasons.push('volume expansion');
  }
  if (Math.abs(features.tf15m.roc12) > 0.01) {
    score += 0.2;
    reasons.push('impulse move');
  }
  if (features.micro.passiveFillRate < 0.4) {
    score -= 0.1;
    reasons.push('low passive fill');
  }
  return { kind: 'BREAKOUT', score, reasons };
}

function scoreMeanReversion(features: ContextFeatures): StrategyScore {
  const reasons: string[] = [];
  let score = 0;
  if (features.tf4h.trendBias === 'neutral' && features.tf4h.adx14 < 20) {
    score += 0.35;
    reasons.push('range regime');
  }
  const rsi = features.tf15m.rsi;
  if (rsi < 35 || rsi > 65) {
    score += 0.2;
    reasons.push('RSI extreme');
  }
  if (features.micro.spreadBps < 8) {
    score += 0.15;
    reasons.push('tight micro spread');
  }
  return { kind: 'MR', score, reasons };
}
