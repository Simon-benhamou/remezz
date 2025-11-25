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
  ?? '1.3';  // OPPORTUNITY-FIRST: Allow 1.3R minimum (was 1.5) for faster crypto trades
const RR_MIN = (() => {
  const parsed = Number.parseFloat(rrFloorRaw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.3;  // Default 1.3R
})();

const parseEnvNumber = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ONE_R_LOCK_ENABLED = process.env.META_ADAPTIVE_ONE_R_LOCK !== 'false';
const ONE_R_LOCK_TRIGGER_R = Math.max(0.5, parseEnvNumber(process.env.META_ADAPTIVE_ONE_R_LOCK_TRIGGER_R, 1));
const ONE_R_LOCK_RETAIN_R = Math.max(0.25, parseEnvNumber(process.env.META_ADAPTIVE_ONE_R_LOCK_RETAIN_R, 0.9));

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
  peakPrice?: number | null;
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
  peakPrice,
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
  
  // Calculate ATR% context first (needed for volatility adjustment)
  const trailingCfg = cfg.trailingAdaptive;
  const trailingMode = trailingCfg?.mode ?? 'atr';
  const atrPctContext = atr != null && Number.isFinite(atr) && atr > 0 && lastPrice > 0
    ? (atr / lastPrice) * 100
    : null;
  
  // 🎯 ADAPTIVE EXIT THRESHOLDS based on crypto volatility
  // High volatility cryptos (ATR > 5%) get more tolerant thresholds to avoid premature exits
  const baseAtrPct = entryAtrPct ?? atrPctContext ?? 2.0; // Use entry ATR% or current, default 2%
  const volatilityMultiplier = baseAtrPct > 5.0 
    ? 1.5  // High vol (e.g., AERO 9%): 1.5x more tolerant
    : baseAtrPct > 3.0
    ? 1.25 // Medium vol: 1.25x more tolerant  
    : 1.0; // Low vol: standard thresholds
  
  const baseTightenThreshold = cfg.earlyExit.tightenProfitR ?? cfg.earlyExit.tightenOnlyIfProfitGtR ?? 0.2;
  const baseCutThreshold = cfg.earlyExit.cutLossR ?? cfg.earlyExit.cutIfLossGtR ?? 0.5;
  const baseMinHoldMinutes = cfg.earlyExit.minHoldMinutes ?? 15;
  
  // Apply volatility adjustment
  const tightenThreshold = baseTightenThreshold;
  const cutThreshold = baseCutThreshold * volatilityMultiplier; // More tolerant for volatile cryptos
  
  // 🎯 FIX: High vol cryptos move FASTER - need SHORTER minimum hold, not longer!
  // Old logic: minHoldMinutes = base * multiplier (WRONG - made high vol wait longer)
  // New logic: minHoldMinutes = base / multiplier (CORRECT - high vol waits less)
  const minHoldMinutes = Math.max(5, Math.ceil(baseMinHoldMinutes / volatilityMultiplier));
  
  const holdSatisfied =
    minutesOpen == null || !Number.isFinite(minHoldMinutes) || minHoldMinutes <= 0 || minutesOpen >= minHoldMinutes;
  const trailMultiplierBase = resolveTrailMultiplier(cfg, atrPctContext);
  let percentTrail = trailingMode === 'percent'
    ? Math.max(0.05, trailingCfg?.percent ?? 0.35)
    : null;
  
  // 🎯 DYNAMIC TRAILING: Tighten trailing at higher R-multiples to protect big wins
  const getDynamicTrailPercent = (currentR: number): number => {
    const basePercent = percentTrail ?? 0.35;
    if (currentR >= 5.0) return Math.min(basePercent, 0.15);  // 15% trail at 5R+ (tight protection)
    if (currentR >= 3.0) return Math.min(basePercent, 0.20);  // 20% trail at 3R-5R
    if (currentR >= 2.0) return Math.min(basePercent, 0.25);  // 25% trail at 2R-3R
    return basePercent;  // 35% trail at 1R-2R (default)
  };
  
  const entryAtrPctBaseline = entryAtrPct != null && Number.isFinite(entryAtrPct)
    ? Number(entryAtrPct)
    : entryAtr != null && Number.isFinite(entryAtr) && entryPrice > 0
      ? (entryAtr / entryPrice) * 100
      : null;
  const rNow = baselineRisk > 0 ? PositionSizer.rMultiple(entryPrice, baselineStop, lastPrice, side) : 0;

  if (ONE_R_LOCK_ENABLED && baselineRisk > 0 && Number.isFinite(rNow) && rNow >= ONE_R_LOCK_TRIGGER_R) {
    const retainMultiple = Math.min(Math.max(ONE_R_LOCK_RETAIN_R, 0.25), rNow);
    const candidateStop = side === 'long'
      ? entryPrice + baselineRisk * retainMultiple
      : entryPrice - baselineRisk * retainMultiple;
    const improved = side === 'long'
      ? candidateStop > stop + 1e-8
      : candidateStop < stop - 1e-8;
    const withinPrice = side === 'long'
      ? candidateStop <= lastPrice + 1e-9
      : candidateStop >= lastPrice - 1e-9;
    if (improved && withinPrice) {
      return {
        action: 'move_sl',
        reason: `one_r_lock_${retainMultiple.toFixed(2)}R`,
        stop: candidateStop,
      };
    }
  }
  const percentLockCfg = cfg.percentGainLock;
  if (percentLockCfg?.enabled) {
    const activation = Math.max(0, percentLockCfg.activationGainPct ?? 0);
    const lockFraction = Math.min(Math.max(percentLockCfg.lockFraction ?? 0, 0), 1);
    const minGainStepPct = Math.max(0, percentLockCfg.minGainStepPct ?? 0);
    if (entryPrice > 0 && lockFraction > 0) {
      const gainNumerator = side === 'long'
        ? lastPrice - entryPrice
        : entryPrice - lastPrice;
      const gainPct = gainNumerator / entryPrice;
      if (Number.isFinite(gainPct) && gainPct >= activation) {
        const lockedGainPct = gainPct * lockFraction;
        const currentLockedPct = (() => {
          if (side === 'long') {
            return stop > entryPrice ? Math.max(0, (stop - entryPrice) / entryPrice) : 0;
          }
          return stop < entryPrice ? Math.max(0, (entryPrice - stop) / entryPrice) : 0;
        })();
        const improvement = lockedGainPct - currentLockedPct;
        if (improvement >= Math.max(minGainStepPct - 1e-9, 0)) {
          const candidateStop = side === 'long'
            ? entryPrice * (1 + lockedGainPct)
            : entryPrice * (1 - lockedGainPct);
          const improved = side === 'long'
            ? candidateStop > stop + 1e-8
            : candidateStop < stop - 1e-8;
          const withinPrice = side === 'long'
            ? candidateStop <= lastPrice + 1e-9
            : candidateStop >= lastPrice - 1e-9;
          if (improved && withinPrice) {
            return {
              action: 'move_sl',
              reason: `Percent gain lock ${(lockedGainPct * 100).toFixed(2)}% with gain ${(gainPct * 100).toFixed(2)}%`,
              stop: candidateStop,
            };
          }
        }
      }
    }
  }
  const profitLockCfg = cfg.profitLock ?? { minRMultiple: 1, allowPartialBeforeMinR: false };
  // 🎯 ADAPTIVE PROFIT LOCK: Lock profit earlier for volatile cryptos
  // BTC (1.0x): 1.0R, ETH (1.25x): 0.8R, AERO (1.5x): 0.67R
  const baseMinRMultiple = Number.isFinite(profitLockCfg.minRMultiple) ? profitLockCfg.minRMultiple! : 1;
  const minRMultiple = baseMinRMultiple / volatilityMultiplier;
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

  // 🚨 CRITICAL FIX: Direct stop loss check (HIGHEST PRIORITY)
  // This was MISSING causing positions to never exit on stop loss hit!
  const stopHit = side === 'long'
    ? lastPrice <= stop
    : lastPrice >= stop;
  
  if (stopHit) {
    // Calculate how much below stop we are
    const stopPenetration = side === 'long'
      ? ((stop - lastPrice) / stop) * 100
      : ((lastPrice - stop) / stop) * 100;
    
    return {
      action: 'exit',
      reason: `Stop loss hit: price ${lastPrice.toFixed(4)} ${side === 'long' ? '≤' : '≥'} stop ${stop.toFixed(4)} (${stopPenetration.toFixed(2)}% penetration)`,
    };
  }

  // 🚀 PEAK DRAWDOWN PROTECTION: Exit if price drops significantly from peak (HIGH PRIORITY)
  // This check happens BEFORE TP and trailing logic to protect profits from reversals
  if (cfg.peakDrawdown?.enabled && peakPrice != null) {
    // Only check if we have a valid peak above entry (for longs) or below entry (for shorts)
    const hasValidPeak = side === 'long' ? peakPrice > entryPrice : peakPrice < entryPrice;
    if (hasValidPeak && baselineRisk > 0) {
      // Calculate R-multiple at peak to determine which threshold applies
      const peakR = PositionSizer.rMultiple(entryPrice, baselineStop, peakPrice, side);
      
      // Only protect if peak was profitable (at least 1R)
      if (peakR >= 1.0) {
        // Calculate drawdown from peak
        const drawdownPct = side === 'long'
          ? (peakPrice - lastPrice) / peakPrice
          : (lastPrice - peakPrice) / peakPrice;
        
        // Get applicable threshold based on PEAK R-multiple (not current)
        const thresholds = cfg.peakDrawdown.thresholds;
        const applicableRLevels = Object.keys(thresholds)
          .map(Number)
          .filter(r => peakR >= r)
          .sort((a, b) => b - a); // Sort descending to get highest R first
        
        if (applicableRLevels.length > 0) {
          const applicableR = applicableRLevels[0];
          const threshold = thresholds[applicableR];
          
          // Use epsilon tolerance for floating point comparison (avoid precision issues)
          const EPSILON = 0.0001; // 0.01% tolerance
          if (drawdownPct >= threshold - EPSILON) {
            return {
              action: 'exit',
              reason: `Peak drawdown exit: ${(drawdownPct * 100).toFixed(1)}% from peak (threshold ${(threshold * 100).toFixed(1)}%) at ${rNow.toFixed(2)}R current, peaked at ${peakR.toFixed(2)}R`,
            };
          }
        }
      }
    }
  }

  // 🚀 EXIT STRATEGY MODE: partial/trailing/hybrid
  const exitStrategyMode = process.env.EXIT_STRATEGY_MODE ?? 'partial';
  const shouldUsePartialExits = exitStrategyMode === 'partial' || 
                                 (exitStrategyMode === 'hybrid' && triggered.size === 0);

  // Take profit detection (first non-triggered target)
  // OPTIMIZATION: Skip TPs if trailing mode enabled (let trailing capture all gains)
  if (shouldUsePartialExits) {
    for (let i = 0; i < targets.length; i += 1) {
      if (triggered.has(i)) continue;
      
      // Hybrid mode: only take first TP at 2R (50%), rest trails
      if (exitStrategyMode === 'hybrid' && i > 0) break;
      
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

  // 🚀 OPTIMIZED TRAILING: Start earlier for trailing/hybrid modes
  const trailingStartR = exitStrategyMode !== 'partial' 
    ? Number(process.env.TRAILING_START_R ?? 0.8)  // Démarre à 0.8R
    : (preLockMinR ?? 1.2); // Mode partial garde 1.2R
  
  if (!profitLockArmed && rNow >= trailingStartR) {
    const dynamicPercent = getDynamicTrailPercent(rNow);
    const desiredStop = computeTrailCandidate({
      multiplier: trailingMode === 'percent' ? undefined : effectiveTrailMultiplier * preLockTrailFactor,
      percent: trailingMode === 'percent' ? dynamicPercent * preLockTrailFactor : undefined,
    });
    let newStop = applyStopCandidate(desiredStop, false);
    if (baselineRisk > 0) {
      // 🎯 OPTIMIZED BREAKEVEN: Don't choke the trade too early!
      // Step 1: "Soft Breakeven" at 1.2R -> Move stop to -0.5R (halve the risk)
      // Step 2: "Hard Breakeven" at 2.0R -> Move stop to Entry (risk free)
      
      const hardBreakevenR = Number(process.env.BREAKEVEN_AT_R ?? 2.0); // Default raised to 2.0R
      const softBreakevenR = 1.2;
      
      let candidateBreakevenStop: number | null = null;
      
      if (rNow >= hardBreakevenR) {
        // Full breakeven (Entry Price)
        candidateBreakevenStop = entryPrice;
      } else if (rNow >= softBreakevenR) {
        // Soft breakeven (Half Risk)
        candidateBreakevenStop = side === 'long'
          ? entryPrice - (baselineRisk * 0.5)
          : entryPrice + (baselineRisk * 0.5);
      }

      if (candidateBreakevenStop !== null) {
        if (side === 'long' && candidateBreakevenStop > stop + 1e-8) {
          const candidate = newStop != null ? Math.max(newStop, candidateBreakevenStop) : candidateBreakevenStop;
          if (candidate > stop + 1e-8) {
            newStop = candidate;
          }
        }
        if (side === 'short' && candidateBreakevenStop < stop - 1e-8) {
          const candidate = newStop != null ? Math.min(newStop, candidateBreakevenStop) : candidateBreakevenStop;
          if (candidate < stop - 1e-8) {
            newStop = candidate;
          }
        }
      }
    }
    if (newStop != null) {
      return { action: 'move_sl', reason: `Pre-lock trail at ${rNow.toFixed(2)}R`, stop: newStop };
    }
  }

  // 🚀 MAIN TRAILING LOGIC: Active dès que profit locked
  if (effectiveHoldSatisfied && profitLockArmed && rNow >= trailAfter) {
    // OPTIMIZATION: Mode trailing utilise distance plus serrée pour capturer plus
    const trailingMultiplier = exitStrategyMode === 'trailing'
      ? Math.min(effectiveTrailMultiplier, Number(process.env.TRAILING_ATR_MULT ?? 1.0))
      : effectiveTrailMultiplier;
    
    // 🎯 DYNAMIC TRAILING: Use tighter percentages at higher R-multiples
    const dynamicPercent = getDynamicTrailPercent(rNow);
    const trailingPercent = exitStrategyMode === 'trailing'
      ? Math.min(dynamicPercent, Number(process.env.TRAILING_PERCENT_FALLBACK ?? 2.5) / 100)
      : dynamicPercent;
    
    const desiredStop = computeTrailCandidate({
      multiplier: trailingMode === 'percent' ? undefined : trailingMultiplier,
      percent: trailingMode === 'percent' ? trailingPercent ?? undefined : undefined,
    });
    const allowLoosen = volatilitySpike && (cfg.volatilityExit?.widenMultiplier ?? 1) > 1;
    const newStop = applyStopCandidate(desiredStop, allowLoosen);
    if (newStop != null) {
      return { action: 'move_sl', reason: `Trailing after ${rNow.toFixed(2)}R`, stop: newStop };
    }
  }

  const lossR = rNow < 0 ? -rNow : 0;
  
  // 🎯 ADAPTIVE MOMENTUM THRESHOLDS: Lower ADX requirement for volatile cryptos
  // High volatility cryptos naturally have more erratic ADX, so we're more lenient
  // Standard ADX threshold: 18, High vol (AERO): 15, Very high vol: 12
  const baseAdxThreshold = cfg.earlyExit.adxBelow;
  const adaptiveAdxThreshold = baseAtrPct > 7.0
    ? Math.max(12, baseAdxThreshold - 6)  // Very high vol: much more lenient
    : baseAtrPct > 5.0
    ? Math.max(15, baseAdxThreshold - 3)  // High vol (AERO 9%): more lenient
    : baseAdxThreshold;
  
  const momentumFail =
    (adx != null && adx < adaptiveAdxThreshold) ||
    (cfg.earlyExit.cmfNegative && cmf != null && cmf < 0);

  // 🛡️ ADAPTIVE HARD STOP LOSS: Adjusted for crypto volatility
  // High volatility cryptos get wider hard stop to avoid noise exits
  // Low vol: 0.5R, Medium vol: 0.65R, High vol (AERO): 0.75R
  const baseHardStopR = 0.5;
  const hardStopLossR = baseHardStopR * volatilityMultiplier;
  
  if (lossR >= hardStopLossR && effectiveHoldSatisfied) {
    return { 
      action: 'exit', 
      reason: `Hard stop loss: ${lossR.toFixed(2)}R loss exceeded ${hardStopLossR.toFixed(2)}R threshold (volatility-adjusted)` 
    };
  }

  // 🚨 EARLY EXIT: Exit on smaller loss (cutThreshold) if momentum fails
  // cutThreshold is already volatility-adjusted above (more tolerant for high vol)
  // This catches losses early when technical indicators suggest continuation
  if (lossR >= cutThreshold && momentumFail && effectiveHoldSatisfied) {
    return { 
      action: 'exit', 
      reason: `Early exit: loss ${lossR.toFixed(2)}R with momentum failure (threshold ${cutThreshold.toFixed(2)}R, ATR ${baseAtrPct.toFixed(1)}%)` 
    };
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

  // 🎯 ADAPTIVE TIME STOP: Faster exits for volatile cryptos to cut dead capital
  // BTC (1.0x): 90min, ETH (1.25x): 72min, AERO (1.5x): 60min
  const baseMaxHolding = cfg.maxHoldingMin;
  const maxHolding = baseMaxHolding != null && volatilityMultiplier > 1
    ? Math.ceil(baseMaxHolding / volatilityMultiplier)
    : baseMaxHolding;
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
