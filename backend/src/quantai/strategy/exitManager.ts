import { QuantAIExitConfig } from '../config.js';
import { PositionSizer } from '../risk/positionSizing.js';

export type TradeSide = 'long' | 'short';

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

export function computeInitialBracket(entryPrice: number, atr: number, side: TradeSide, cfg: QuantAIExitConfig): InitialBracket {
  if (!(atr > 0)) {
    throw new Error('ATR required for SL/TP computation');
  }
  const risk = cfg.slAtrMult * atr;
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
}: AdjustmentParams): ExitDirective {
  const riskPerUnit = Math.abs(entryPrice - stop);
  const direction = side === 'long' ? 1 : -1;
  const triggered = alreadyTriggeredTargets ?? new Set<number>();

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

  if (rNow >= cfg.trailAfterR && atr && atr > 0) {
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

  if (lossR >= cfg.earlyExit.cutIfLossGtR && momentumFail) {
    return { action: 'exit', reason: `Early exit: loss ${lossR.toFixed(2)}R with momentum failure` };
  }

  if (rNow >= cfg.earlyExit.tightenOnlyIfProfitGtR && momentumFail && atr && atr > 0) {
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

  return { action: 'hold', reason: 'holding' };
}
