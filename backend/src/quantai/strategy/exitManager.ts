import { QuantAIExitConfig } from '../config.js';
import { PositionSizer } from '../risk/positionSizing.js';

export type TradeSide = 'long' | 'short';
export type ExitArchetype = 'reversal' | 'impulse';

export type InitialBracket = {
  stop: number;
  targets: number[];
  riskPerUnit: number;
};

export type ExitDirective =
  | { action: 'hold'; reason: string }
  | { action: 'move_sl'; reason: string; stop: number }
  | { action: 'take_partial'; reason: string; tpHitIndex: number }
  | { action: 'exit'; reason: string };

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
  const risk = (slMultOverride ?? cfg.slAtrMult) * atr;
  const stop =
    side === 'long'
      ? entryPrice - risk
      : entryPrice + risk;
  const dir = side === 'long' ? 1 : -1;
  const targets = cfg.tpRMultiples.map((r) => entryPrice + dir * r * risk);
  return { stop, targets, riskPerUnit: risk };
}

type AdjustmentParams = {
  side: TradeSide;
  entryPrice: number;
  stop: number;
  targets: number[];
  lastPrice: number;
  atr?: number | null;
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
  adx,
  cmf,
  cfg,
  alreadyTriggeredTargets,
  archetype = 'impulse',
  minutesOpen,
}: AdjustmentParams): ExitDirective {
  const riskPerUnit = Math.abs(entryPrice - stop);
  const direction = side === 'long' ? 1 : -1;
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

  // Take profit detection (first non-triggered target)
  for (let i = 0; i < targets.length; i += 1) {
    if (triggered.has(i)) continue;
    const target = targets[i];
    const hit = side === 'long' ? lastPrice >= target : lastPrice <= target;
    if (hit) {
      return { action: 'take_partial', reason: `TP${i + 1} hit at ${target.toFixed(4)}`, tpHitIndex: i };
    }
  }

  const rNow = riskPerUnit > 0 ? PositionSizer.rMultiple(entryPrice, stop, lastPrice, side) : 0;

  if (rNow >= trailAfter && atr && atr > 0) {
    const desiredStop = side === 'long'
      ? lastPrice - cfg.trailAtrMult * atr
      : lastPrice + cfg.trailAtrMult * atr;
    const newStop = side === 'long'
      ? Math.max(stop, desiredStop)
      : Math.min(stop, desiredStop);
    if ((side === 'long' && newStop > stop) || (side === 'short' && newStop < stop)) {
      return { action: 'move_sl', reason: `Trailing after ${rNow.toFixed(2)}R`, stop: newStop };
    }
  }

  const lossR = rNow < 0 ? -rNow : 0;
  const momentumFail =
    (adx != null && adx < cfg.earlyExit.adxBelow) ||
    (cfg.earlyExit.cmfNegative && cmf != null && cmf < 0);

  if (lossR >= cutThreshold && momentumFail && holdSatisfied) {
    return { action: 'exit', reason: `Early exit: loss ${lossR.toFixed(2)}R with momentum failure` };
  }

  if (rNow >= tightenThreshold && momentumFail && atr && atr > 0 && holdSatisfied) {
    const tightenStop = side === 'long'
      ? lastPrice - 0.5 * cfg.trailAtrMult * atr
      : lastPrice + 0.5 * cfg.trailAtrMult * atr;
    const newStop = side === 'long'
      ? Math.max(stop, tightenStop)
      : Math.min(stop, tightenStop);
    if ((side === 'long' && newStop > stop) || (side === 'short' && newStop < stop)) {
      return { action: 'move_sl', reason: 'Tighten stop due to momentum failure', stop: newStop };
    }
  }

  const maxHolding = cfg.maxHoldingMin;
  if (maxHolding != null && Number.isFinite(maxHolding) && maxHolding > 0 && minutesOpen != null) {
    if (minutesOpen >= maxHolding && lossR >= cutThreshold && holdSatisfied) {
      return {
        action: 'exit',
        reason: `Time stop: drawdown ${lossR.toFixed(2)}R after ${minutesOpen.toFixed(1)}min`,
      };
    }
  }

  return { action: 'hold', reason: 'holding' };
}
