import type { TechnicalSnapshot } from '../ai/tech.js';

export type StrategyZone = { min?: number | null; max?: number | null } | null;

export type RegimeState = {
  label?: string | null;
  confidence?: number | null;
} | null | undefined;

export type StrategyShiftOptions = {
  price: number;
  lastPrice?: number | null;
  zone?: StrategyZone;
  priceThresholdPct: number;
  regime?: RegimeState;
  previousRegime?: RegimeState;
  confidenceThreshold: number;
};

export type StrategyShiftResult = {
  priceShift: boolean;
  regimeShift: boolean;
};

function normalizePrice(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function resolveBaselinePrice(zone: StrategyZone, lastPrice?: number | null): number | null {
  if (zone && normalizePrice(zone.min) && normalizePrice(zone.max)) {
    const min = normalizePrice(zone.min);
    const max = normalizePrice(zone.max);
    if (min != null && max != null && max > 0) {
      return (min + max) / 2;
    }
  }
  const fallback = normalizePrice(lastPrice);
  return fallback;
}

function computePriceShift(price: number, baseline: number | null, thresholdPct: number): boolean {
  const current = normalizePrice(price);
  if (current == null || baseline == null) return false;
  const pctMove = Math.abs(current - baseline) / baseline * 100;
  return pctMove >= Math.max(0, thresholdPct);
}

function resolveLabel(regime: RegimeState): string | null {
  const label = regime && typeof regime === 'object' ? (regime as any).label : null;
  if (typeof label === 'string' && label.trim().length > 0) {
    return label.trim().toUpperCase();
  }
  return null;
}

function resolveConfidence(regime: RegimeState): number | null {
  if (!regime || typeof regime !== 'object') return null;
  const raw = (regime as any).confidence;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}

function computeRegimeShift(
  regime: RegimeState,
  previous: RegimeState,
  confidenceThreshold: number,
): boolean {
  const currentLabel = resolveLabel(regime);
  const previousLabel = resolveLabel(previous);
  if (currentLabel && previousLabel && currentLabel !== previousLabel) {
    return true;
  }
  if (!currentLabel && previousLabel) {
    return true;
  }
  if (currentLabel && !previousLabel) {
    return true;
  }
  const currentConfidence = resolveConfidence(regime);
  const previousConfidence = resolveConfidence(previous);
  if (currentConfidence == null || previousConfidence == null) return false;
  const delta = Math.abs(currentConfidence - previousConfidence);
  return delta >= Math.max(0, confidenceThreshold);
}

export function detectStrategyShift(options: StrategyShiftOptions): StrategyShiftResult {
  const { price, lastPrice, zone, priceThresholdPct, regime, previousRegime, confidenceThreshold } = options;
  const baseline = resolveBaselinePrice(zone ?? null, lastPrice ?? null);
  const priceShift = computePriceShift(price, baseline, priceThresholdPct);
  const regimeShift = computeRegimeShift(regime ?? null, previousRegime ?? null, confidenceThreshold);
  return { priceShift, regimeShift };
}

export function describeShift(result: StrategyShiftResult): string | null {
  if (result.priceShift && result.regimeShift) return 'price+regime';
  if (result.priceShift) return 'price';
  if (result.regimeShift) return 'regime';
  return null;
}

export type StrategyShiftContext = {
  snapshot?: TechnicalSnapshot | null;
  lastZone?: StrategyZone;
  lastPrice?: number | null;
};
