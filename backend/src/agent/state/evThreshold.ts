export interface AdaptiveEvThresholdParams {
  baseThreshold: number;
  stopPct: number;
  tp1RMultiple?: number | null;
  effectiveAtr?: number | null;
  minAtr: number;
  riskUsd?: number | null;
  rewardMultiplier?: number | null;
}

export function computeAdaptiveEvThreshold({
  baseThreshold,
  stopPct,
  tp1RMultiple,
  effectiveAtr,
  minAtr,
  riskUsd,
  rewardMultiplier,
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

  const adjusted = Math.max(1.5, Math.min(baseThreshold, threshold));
  const riskFloor = (() => {
    if (riskUsd == null || rewardMultiplier == null) return null;
    if (!Number.isFinite(riskUsd) || !Number.isFinite(rewardMultiplier)) return null;
    if (riskUsd <= 0 || rewardMultiplier <= 0) return null;
    const atrScale = (() => {
      if (
        effectiveAtr != null &&
        Number.isFinite(effectiveAtr) &&
        effectiveAtr > 0 &&
        minAtr > 0 &&
        Number.isFinite(minAtr)
      ) {
        const ratio = effectiveAtr / minAtr;
        return Math.max(0.6, Math.min(1.2, ratio));
      }
      return 1;
    })();
    return riskUsd * rewardMultiplier * atrScale;
  })();

  return riskFloor != null && Number.isFinite(riskFloor)
    ? Math.max(adjusted, riskFloor)
    : adjusted;
}
