export interface QSFeatures {
  regime: 'BOM' | 'MR';
  confidence: number;
  trendAlignment: number;
  volumeZScore: number;
  aggressionRatio: number;
  atrPct: number;
  priceZScore: number;
  imbalance: number;
  wickPct: number;
  payoffRatio: number;
  historyExpectancy: number;
}

export interface QSOutput {
  pWin: number;
  qs: number;
  riskScale: number;
}

export interface EVParams {
  predictedSlippageBps: number;
  feesBps: number;
  tpGridBps: number[];
  slMinBps: number;
  slMaxBps: number;
}

export interface EVChoice {
  stopBps: number;
  takeProfitBps: number;
  evBps: number;
}

export interface IntradayQSLikeConfig {
  enabled: boolean;
  baseRiskPct: number;
  minRiskScale: number;
  maxRiskScale: number;
  qsToScaleSlope: number;
}

const DEFAULT_WEIGHTS: readonly number[] = [
  1.4, // confidence
  0.35, // trendAlignment
  0.6, // volumeZScore
  0.75, // aggressionRatio
  -0.45, // atrPct
  0.25, // priceZScore
  0.2, // imbalance
  0.15, // wickPct
  0.55, // payoffRatio
  0.4, // historyExpectancy
  0.25, // regime bias
];

const DEFAULT_BIAS = -0.15;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (min > max) {
    return clamp(value, max, min);
  }
  return Math.max(min, Math.min(max, value));
}

function normalize(value: number, scale: number, offset = 0): number {
  if (!Number.isFinite(value)) return 0;
  return clamp((value + offset) / scale, -5, 5);
}

function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x > 30) return 1;
  if (x < -30) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function computeQualityScore(features: QSFeatures, cfg: IntradayQSLikeConfig): QSOutput {
  if (!cfg.enabled) {
    const boundedConfidence = clamp(features.confidence, 0.01, 0.99);
    const payoff = Math.max(0.5, Math.min(5, features.payoffRatio || 1));
    const qsFallback = boundedConfidence * payoff - (1 - boundedConfidence);
    return {
      pWin: boundedConfidence,
      qs: qsFallback,
      riskScale: 1,
    };
  }

  const vector: number[] = [
    normalize(features.confidence - 0.5, 0.5),
    normalize(features.trendAlignment, 1),
    normalize(features.volumeZScore, 3),
    normalize(features.aggressionRatio - 0.5, 0.3),
    normalize(features.atrPct - 0.004, 0.006),
    normalize(features.priceZScore, 3),
    normalize(features.imbalance, 0.6),
    normalize(features.wickPct, 0.01),
    normalize(features.payoffRatio - 1, 1),
    normalize(features.historyExpectancy, 0.5),
    features.regime === 'BOM' ? 0.5 : -0.5,
  ];

  const dot = vector.reduce((acc, value, idx) => acc + value * (DEFAULT_WEIGHTS[idx] ?? 0), 0);
  const pWin = clamp(sigmoid(DEFAULT_BIAS + dot), 0.01, 0.99);
  const payoffRatio = Math.max(0.25, Math.min(6, features.payoffRatio || 1));
  const qs = pWin * payoffRatio - (1 - pWin);
  const riskScale = computeRiskScaleFromQS(qs, cfg);
  return { pWin, qs, riskScale };
}

export function computeRiskScaleFromQS(qs: number, cfg: IntradayQSLikeConfig): number {
  if (!cfg.enabled) {
    return 1;
  }
  const base = 1 + cfg.qsToScaleSlope * qs;
  return clamp(base, cfg.minRiskScale, cfg.maxRiskScale);
}

function buildStopCandidates(minBps: number, maxBps: number): number[] {
  const floor = Math.max(5, Math.min(minBps, maxBps));
  const ceiling = Math.max(floor, maxBps);
  const span = ceiling - floor;
  if (span <= 0) {
    return [floor];
  }
  const step = Math.max(5, Math.round(span / 4));
  const stops = new Set<number>();
  for (let sl = floor; sl <= ceiling; sl += step) {
    stops.add(Math.round(sl));
  }
  stops.add(floor);
  stops.add(ceiling);
  return Array.from(stops).sort((a, b) => a - b);
}

export function chooseEV(pWin: number, params: EVParams): EVChoice {
  const clampedWin = clamp(pWin, 0.01, 0.99);
  const totalCost = Math.max(0, params.predictedSlippageBps) + Math.max(0, params.feesBps);
  const tpGrid = params.tpGridBps.length
    ? params.tpGridBps.filter((val) => Number.isFinite(val) && val > 0).map((val) => Math.round(val))
    : [Math.max(20, params.slMinBps * 2)];
  const stopCandidates = buildStopCandidates(params.slMinBps, params.slMaxBps);

  let best: EVChoice = { stopBps: stopCandidates[0] ?? params.slMinBps, takeProfitBps: tpGrid[0] ?? 40, evBps: Number.NEGATIVE_INFINITY };

  for (const stopBps of stopCandidates) {
    const lossBps = stopBps + totalCost;
    for (const tpBps of tpGrid) {
      const rewardBps = Math.max(0, tpBps - totalCost);
      const rawEv = clampedWin * rewardBps - (1 - clampedWin) * lossBps;
      const ratio = rewardBps > 0 ? rewardBps / Math.max(stopBps, 1) : 0;
      const stabilityBonus = clampedWin * ratio * 5;
      const evScore = rawEv + stabilityBonus;
      if (evScore > best.evBps) {
        best = { stopBps, takeProfitBps: tpBps, evBps: evScore };
      }
    }
  }

  return best;
}
