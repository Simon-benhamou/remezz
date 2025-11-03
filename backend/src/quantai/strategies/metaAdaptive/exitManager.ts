import { QuantAIExitConfig } from '../../config.js';
import { PositionSizer } from '../../risk/positionSizing.js';

export type TradeSide = 'long' | 'short';
export type ExitArchetype = 'reversal' | 'impulse';

export type InitialBracket = {
  stop: number;
  targets: number[];
  riskPerUnit: number;
  rr: number;
};

export type ExitDirective =
  | { action: 'hold'; reason: string }
  | { action: 'move_sl'; reason: string; stop: number }
  | { action: 'take_partial'; reason: string; tpHitIndex: number }
  | { action: 'exit'; reason: string };

const rrFloorRaw = process.env.META_ADAPTIVE_MIN_RR
  ?? process.env.META_ADAPTIVE_RR_MIN
  ?? '1.8';
const RR_MIN = (() => {
  const parsed = Number.parseFloat(rrFloorRaw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.8;
})();

function resolveTrailMultiplier(cfg: QuantAIExitConfig, atrPct: number | null): number {
  const adaptive = cfg.trailingAdaptive;
  if (!adaptive || adaptive.mode === 'percent' || atrPct == null || !Number.isFinite(atrPct)) {
    return cfg.trailAtrMult;
  }
  const bands = adaptive.atrBands;
  if (!bands) return cfg.trailAtrMult;
  const base = cfg.trailAtrMult;
  let multiplier = bands.midMultiplier ?? 1;
  if (atrPct <= bands.low) {
    multiplier = bands.lowMultiplier;
  } else if (bands.extreme != null && atrPct >= bands.extreme) {
    multiplier = bands.extremeMultiplier ?? bands.highMultiplier;
  } else if (atrPct >= bands.high) {
    multiplier = bands.highMultiplier;
  }
  let adjusted = base * multiplier;
  if (adaptive.clampMultiplier) {
    const min = adaptive.clampMultiplier.min;
    const max = adaptive.clampMultiplier.max;
    if (min != null && Number.isFinite(min)) adjusted = Math.max(min, adjusted);
    if (max != null && Number.isFinite(max)) adjusted = Math.min(max, adjusted);
  }
  return adjusted;
}

export function computeInitialBracket(
  entryPrice: number,
  atr: number,
  side: TradeSide,
  cfg: QuantAIExitConfig,
  archetype: ExitArchetype = 'impulse',
): InitialBracket {
  if (!(atr > 0)) {
    throw new Error('ATR required for SL/TP computation');
  }
  const slMultOverride =
    archetype === 'reversal'
      ? cfg.slAtrMultReversal ?? cfg.slAtrMult
      : cfg.slAtrMultImpulse ?? cfg.slAtrMult;
  const baseRisk = (slMultOverride ?? cfg.slAtrMult) * atr;
  const minRiskCandidate = (cfg.minStopAtrMult ?? 0) * atr;
  const minRisk = Number.isFinite(minRiskCandidate) && minRiskCandidate > 0 ? minRiskCandidate : 0;
  const risk = Math.max(baseRisk, minRisk, 1e-9);
  const stop =
    side === 'long'
      ? entryPrice - risk
      : entryPrice + risk;
  const dir = side === 'long' ? 1 : -1;
  const targets = cfg.tpRMultiples.map((r) => entryPrice + dir * r * risk);
  if (targets.length > 0) {
    if (side === 'long') {
      targets[0] = Math.max(targets[0], entryPrice + RR_MIN * risk);
    } else {
      targets[0] = Math.min(targets[0], entryPrice - RR_MIN * risk);
    }
  } else {
    targets.push(side === 'long'
      ? entryPrice + RR_MIN * risk
      : entryPrice - RR_MIN * risk);
  }
  const rr = risk > 0
    ? (side === 'long'
      ? (targets[0] - entryPrice) / risk
      : (entryPrice - targets[0]) / risk)
    : 0;
  return { stop, targets, riskPerUnit: risk, rr };
}

type AdjustmentParams = {
  side: TradeSide;
  entryPrice: number;
  stop: number;
  targets: number[];
  lastPrice: number;
  atr?: number | null;
  entryAtr?: number | null;
  entryAtrPct?: number | null;
  initialStopDistance?: number | null;
  adx?: number | null;
  cmf?: number | null;
  cfg: QuantAIExitConfig;
  alreadyTriggeredTargets?: Set<number>;
  archetype?: ExitArchetype;
  minutesOpen?: number;
};

export function maybeAdjustOrExit({
  side,
  entryPrice,
  stop,
  targets,
  lastPrice,
  atr,
  entryAtr,
  entryAtrPct,
  initialStopDistance,
  adx,
  cmf,
  cfg,
  alreadyTriggeredTargets,
  archetype = 'impulse',
  minutesOpen,
}: AdjustmentParams): ExitDirective {
  const riskPerUnit = Math.abs(entryPrice - stop);
  const baselineRisk = initialStopDistance != null && Number.isFinite(initialStopDistance) && initialStopDistance > 0
    ? Number(initialStopDistance)
    : riskPerUnit;
  const baselineStop = side === 'long'
    ? entryPrice - baselineRisk
    : entryPrice + baselineRisk;
  const triggered = alreadyTriggeredTargets ?? new Set<number>();
  const trailAfterBase = cfg.trailAfterR;
  const trailAfter =
    archetype === 'reversal'
      ? cfg.trailAfterRReversal ?? trailAfterBase
      : cfg.trailAfterRImpulse ?? trailAfterBase;
  const tightenThreshold = cfg.earlyExit.tightenProfitR ?? cfg.earlyExit.tightenOnlyIfProfitGtR ?? 0.2;
  const cutThreshold = cfg.earlyExit.cutLossR ?? cfg.earlyExit.cutIfLossGtR ?? 0.5;
  const minHoldMinutes = cfg.earlyExit.minHoldMinutes ?? 0;
  const holdSatisfied =
    minutesOpen == null || !Number.isFinite(minHoldMinutes) || minHoldMinutes <= 0 || minutesOpen >= minHoldMinutes;
  const trailingCfg = cfg.trailingAdaptive;
  const trailingMode = trailingCfg?.mode ?? 'atr';
  const atrPctContext = atr != null && Number.isFinite(atr) && atr > 0 && lastPrice > 0
    ? (atr / lastPrice) * 100
    : null;
  const trailMultiplierBase = resolveTrailMultiplier(cfg, atrPctContext);
  let percentTrail = trailingMode === 'percent'
    ? Math.max(0.05, trailingCfg?.percent ?? 0.35)
    : null;
  const entryAtrPctBaseline = entryAtrPct != null && Number.isFinite(entryAtrPct)
    ? Number(entryAtrPct)
    : entryAtr != null && Number.isFinite(entryAtr) && entryPrice > 0
      ? (entryAtr / entryPrice) * 100
      : null;
  const rNow = baselineRisk > 0 ? PositionSizer.rMultiple(entryPrice, baselineStop, lastPrice, side) : 0;
  const profitLockCfg = cfg.profitLock ?? { minRMultiple: 1, allowPartialBeforeMinR: false };
  const minRMultiple = Number.isFinite(profitLockCfg.minRMultiple) ? profitLockCfg.minRMultiple! : 1;
  const allowPartialBeforeMinR = profitLockCfg.allowPartialBeforeMinR ?? false;
  const preLockMinR = typeof profitLockCfg.preLockMinRMultiple === 'number' && Number.isFinite(profitLockCfg.preLockMinRMultiple)
    ? profitLockCfg.preLockMinRMultiple
    : null;
  const minHoldBypassR = typeof profitLockCfg.minHoldBypassRMultiple === 'number' && Number.isFinite(profitLockCfg.minHoldBypassRMultiple)
    ? profitLockCfg.minHoldBypassRMultiple
    : null;
  const breakevenOffsetR = typeof profitLockCfg.breakevenOffsetR === 'number' && Number.isFinite(profitLockCfg.breakevenOffsetR)
    ? Math.max(0, profitLockCfg.breakevenOffsetR)
    : 0;
  const preLockTrailFactor = typeof profitLockCfg.preLockTrailMultiplier === 'number' && Number.isFinite(profitLockCfg.preLockTrailMultiplier)
    ? Math.max(0, profitLockCfg.preLockTrailMultiplier)
    : 0.8;
  const profitLockArmed = rNow >= minRMultiple;
  const bypassHoldActive = minHoldBypassR != null && rNow >= minHoldBypassR;
  const effectiveHoldSatisfied = holdSatisfied || bypassHoldActive;
  let activeTrailMultiplier = trailMultiplierBase;
  let volatilitySpike = false;
  if (cfg.volatilityExit && atrPctContext != null && entryAtrPctBaseline != null) {
    const spike = atrPctContext - entryAtrPctBaseline;
    if (spike >= cfg.volatilityExit.atrPctSpikeThreshold) {
      const widen = cfg.volatilityExit.widenMultiplier ?? 1;
      if (Number.isFinite(widen) && widen > 0) {
        volatilitySpike = widen > 1;
        if (trailingMode === 'percent' && percentTrail != null) {
          percentTrail = Math.max(percentTrail * widen, percentTrail);
        } else {
          activeTrailMultiplier *= widen;
        }
      }
    }
  }
  const effectiveTrailMultiplier = activeTrailMultiplier;

  // Take profit detection (first non-triggered target)
  for (let i = 0; i < targets.length; i += 1) {
    if (triggered.has(i)) continue;
    const target = targets[i];
    const hit = side === 'long' ? lastPrice >= target : lastPrice <= target;
    if (hit) {
      if (!effectiveHoldSatisfied) {
        return { action: 'hold', reason: 'min_hold_active' };
      }
      const canPartial =
        profitLockArmed ||
        allowPartialBeforeMinR ||
        bypassHoldActive;
      if (!canPartial) {
        return { action: 'hold', reason: 'profit_lock_pending' };
      }
      return { action: 'take_partial', reason: `TP${i + 1} hit at ${target.toFixed(4)}`, tpHitIndex: i };
    }
  }

  const computeTrailCandidate = (options: { multiplier?: number; percent?: number }): number | null => {
    if (trailingMode === 'percent' && percentTrail != null) {
      const pct = options.percent ?? percentTrail;
      const distance = lastPrice * (pct / 100);
      return side === 'long'
        ? lastPrice - distance
        : lastPrice + distance;
    }
    if (atr && atr > 0 && options.multiplier != null) {
      return side === 'long'
        ? lastPrice - options.multiplier * atr
        : lastPrice + options.multiplier * atr;
    }
    return null;
  };

  const applyStopCandidate = (candidate: number | null, allowLoosen: boolean): number | null => {
    if (candidate == null || !Number.isFinite(candidate)) return null;
    if (allowLoosen && baselineRisk > 0) {
      if (side === 'long') {
        const widened = Math.min(stop, Math.max(candidate, baselineStop));
        if (widened < stop - 1e-8) return widened;
      } else {
        const widened = Math.max(stop, Math.min(candidate, baselineStop));
        if (widened > stop + 1e-8) return widened;
      }
      return null;
    }
    const tightened = side === 'long'
      ? Math.max(stop, candidate)
      : Math.min(stop, candidate);
    if ((side === 'long' && tightened > stop + 1e-8) || (side === 'short' && tightened < stop - 1e-8)) {
      return tightened;
    }
    return null;
  };

  if (!profitLockArmed && preLockMinR != null && rNow >= preLockMinR) {
    const desiredStop = computeTrailCandidate({
      multiplier: trailingMode === 'percent' ? undefined : effectiveTrailMultiplier * preLockTrailFactor,
      percent: trailingMode === 'percent' ? (percentTrail ?? 0.35) * preLockTrailFactor : undefined,
    });
    let newStop = applyStopCandidate(desiredStop, false);
    if (baselineRisk > 0) {
      const breakeven = side === 'long'
        ? entryPrice + breakevenOffsetR * baselineRisk
        : entryPrice - breakevenOffsetR * baselineRisk;
      if (side === 'long' && breakeven > stop + 1e-8) {
        const candidate = newStop != null ? Math.max(newStop, breakeven) : breakeven;
        if (candidate > stop + 1e-8) {
          newStop = candidate;
        }
      }
      if (side === 'short' && breakeven < stop - 1e-8) {
        const candidate = newStop != null ? Math.min(newStop, breakeven) : breakeven;
        if (candidate < stop - 1e-8) {
          newStop = candidate;
        }
      }
    }
    if (newStop != null) {
      return { action: 'move_sl', reason: `Pre-lock trail at ${rNow.toFixed(2)}R`, stop: newStop };
    }
  }

  if (effectiveHoldSatisfied && profitLockArmed && rNow >= trailAfter) {
    const desiredStop = computeTrailCandidate({
      multiplier: trailingMode === 'percent' ? undefined : effectiveTrailMultiplier,
      percent: trailingMode === 'percent' ? percentTrail ?? undefined : undefined,
    });
    const allowLoosen = volatilitySpike && (cfg.volatilityExit?.widenMultiplier ?? 1) > 1;
    const newStop = applyStopCandidate(desiredStop, allowLoosen);
    if (newStop != null) {
      return { action: 'move_sl', reason: `Trailing after ${rNow.toFixed(2)}R`, stop: newStop };
    }
  }

  const lossR = rNow < 0 ? -rNow : 0;
  const momentumFail =
    (adx != null && adx < cfg.earlyExit.adxBelow) ||
    (cfg.earlyExit.cmfNegative && cmf != null && cmf < 0);

  if (lossR >= cutThreshold && momentumFail && effectiveHoldSatisfied) {
    return { action: 'exit', reason: `Early exit: loss ${lossR.toFixed(2)}R with momentum failure` };
  }

  if (effectiveHoldSatisfied && profitLockArmed && rNow >= tightenThreshold && momentumFail) {
    const tightenStop = computeTrailCandidate({
      multiplier: trailingMode === 'percent' ? undefined : 0.5 * effectiveTrailMultiplier,
      percent: trailingMode === 'percent' && percentTrail != null ? percentTrail * 0.5 : undefined,
    });
    const newStop = applyStopCandidate(tightenStop, false);
    if (newStop != null) {
      return { action: 'move_sl', reason: 'Tighten stop due to momentum failure', stop: newStop };
    }
  }

  const maxHolding = cfg.maxHoldingMin;
  if (maxHolding != null && Number.isFinite(maxHolding) && maxHolding > 0 && minutesOpen != null) {
    if (minutesOpen >= maxHolding && lossR >= cutThreshold && effectiveHoldSatisfied) {
      return {
        action: 'exit',
        reason: `Time stop: drawdown ${lossR.toFixed(2)}R after ${minutesOpen.toFixed(1)}min`,
      };
    }
  }

  return { action: 'hold', reason: 'holding' };
}
