export interface AdaptiveEvThresholdParams {
  baseThreshold: number;
  stopPct: number;
  tp1RMultiple?: number | null;
  effectiveAtr?: number | null;
  minAtr: number;
}

export function computeAdaptiveEvThreshold({
  baseThreshold,
  stopPct,
  tp1RMultiple,
  effectiveAtr,
  minAtr,
}: AdaptiveEvThresholdParams): number {
  if (!Number.isFinite(baseThreshold) || baseThreshold <= 0) {
    return 0;
  }

  let threshold = baseThreshold;

  if (stopPct > 0 && stopPct <= 1.05) {
    threshold *= 0.7;
  } else if (stopPct > 0 && stopPct <= 1.35) {
    threshold *= 0.85;
  }

  if (tp1RMultiple != null) {
    if (tp1RMultiple >= 2.1) {
      threshold *= 0.7;
    } else if (tp1RMultiple >= 1.75) {
      threshold *= 0.82;
    }
  }

  if (
    effectiveAtr != null &&
    effectiveAtr > 0 &&
    Number.isFinite(effectiveAtr) &&
    minAtr > 0 &&
    effectiveAtr < minAtr
  ) {
    const atrDeficitRatio = Math.max(0, Math.min(0.45, (minAtr - effectiveAtr) / minAtr));
    threshold *= 1 - atrDeficitRatio * 0.4;
  }

  return Math.max(1.5, Math.min(baseThreshold, threshold));
}
