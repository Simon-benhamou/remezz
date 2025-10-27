import { PreciseDecimal } from '../metaAdaptive/metaAdaptiveAgent.js';
import { loadIntradayConfig } from './config/index.js';
import type { RegimeLabel } from './types.js';
import type { Side } from './history.js';
import { areAgentGuardsDisabled } from '../../../utils/agentGuards.js';
import { getConfig } from '../../../utils/env.js';

export type PositionContext = {
  equityUsd: PreciseDecimal;
  stopLossPct: number;
  regime: RegimeLabel;
  price: PreciseDecimal;
  maxLevInstrument: number;
  maxLevGlobal: number;
  exposureBudget: number;
  slippageBps: number;
  riskReduction?: number;
  riskScale?: number;
  baseRiskPct?: number;
  minNotionalUsd?: number;
  confidenceScore?: number;
  targetNotionalUsd?: number;
};

export type PositionSizingResult = {
  size: PreciseDecimal;
  riskUsd: PreciseDecimal;
  leverage: number;
  minNotionalApplied?: boolean;
  riskPct: number;
  confidenceTargetNotionalUsd?: number;
  confidenceRiskFloorApplied?: boolean;
  confidenceRiskBoostApplied?: boolean;
  droppedReason?: string;
};

type SymbolState = {
  consecutiveLosses: number;
  cooldownUntil: number;
};

type PerformanceWindow = {
  wins: number;
  losses: number;
  expectancy: PreciseDecimal;
  samples: number;
};

export class VolatilitySizer {
  private readonly cfg = loadIntradayConfig();

  compute(ctx: PositionContext): PositionSizingResult {
    const clamp01 = (value: number | undefined): number => {
      if (value == null || !Number.isFinite(value)) return 0;
      if (value <= 0) return 0;
      if (value >= 1) return 1;
      return value;
    };
    const stopPct = Math.max(1e-6, ctx.stopLossPct);
    const baseRiskPct = Math.max(1e-6, ctx.baseRiskPct ?? this.cfg.risk.baseRiskPct);
    const regimeMult = ctx.regime === 'BOM' ? this.cfg.risk.bomMultiplier : this.cfg.risk.mrMultiplier;
    const riskReduction = Math.max(0.1, Math.min(1, ctx.riskReduction ?? 1));
    const riskScale = Math.max(0.1, ctx.riskScale ?? 1);
    const hasConfidenceInput = ctx.confidenceScore != null && Number.isFinite(ctx.confidenceScore);
    const confidenceScore = clamp01(hasConfidenceInput ? ctx.confidenceScore : 0);
    const envCfg = getConfig();
    const minShare = Math.max(0, Math.min(1, Number(envCfg.CONFIDENCE_RISK_FLOOR_MIN_SHARE ?? 0.35)));
    const maxShare = Math.max(minShare, Math.min(1.2, Number(envCfg.CONFIDENCE_RISK_FLOOR_MAX_SHARE ?? 0.85)));
    const boostShare = Math.max(0, Number(envCfg.CONFIDENCE_RISK_BOOST_SHARE ?? 0.45));
    const boostThreshold = Math.min(0.95, Math.max(0, Number(envCfg.CONFIDENCE_RISK_BOOST_THRESHOLD ?? 0.6)));
    const baseRatio = Math.max(0.1, Number(envCfg.TARGET_NOTIONAL_BASE_RATIO ?? 0.5));
    const bonusRatio = Math.max(0, Number(envCfg.TARGET_NOTIONAL_CONF_BONUS ?? 2));
    const maxRatio = Math.max(baseRatio, Number(envCfg.TARGET_NOTIONAL_MAX_RATIO ?? 1.6));
    let riskPct = baseRiskPct * riskScale * regimeMult * riskReduction;
    let riskFloorApplied = false;
    let riskBoostApplied = false;
    const equityNumber = ctx.equityUsd.toNumber();
    let confidenceTargetNotionalUsd = ctx.targetNotionalUsd;
    if (hasConfidenceInput && !(confidenceTargetNotionalUsd != null && confidenceTargetNotionalUsd > 0) && equityNumber > 0) {
      const ratio = baseRatio * (1 + bonusRatio * confidenceScore);
      const cappedRatio = Math.max(baseRatio, Math.min(maxRatio, ratio));
      confidenceTargetNotionalUsd = equityNumber * cappedRatio;
    } else if (!hasConfidenceInput && confidenceTargetNotionalUsd == null) {
      confidenceTargetNotionalUsd = 0;
    }
    if (hasConfidenceInput && confidenceScore > 0) {
      const floorShare = minShare + (maxShare - minShare) * confidenceScore;
      const riskFloorPct = baseRiskPct * floorShare;
      if (riskFloorPct > riskPct + 1e-9) {
        riskPct = riskFloorPct;
        riskFloorApplied = true;
      }
      if (confidenceScore > boostThreshold) {
        const progress = (confidenceScore - boostThreshold) / Math.max(1e-6, 1 - boostThreshold);
        const boostedRiskPct = baseRiskPct * (1 + boostShare * Math.min(1, Math.max(0, progress)));
        if (boostedRiskPct > riskPct + 1e-9) {
          riskPct = boostedRiskPct;
          riskBoostApplied = true;
        }
      }
    }
    if (
      confidenceTargetNotionalUsd != null &&
      confidenceTargetNotionalUsd > 0 &&
      stopPct > 0 &&
      equityNumber > 0
    ) {
      const requiredRiskPct = (confidenceTargetNotionalUsd * stopPct) / Math.max(equityNumber, 1e-9);
      if (requiredRiskPct > riskPct + 1e-9) {
        riskPct = requiredRiskPct;
      }
    }
    const riskUsd = ctx.equityUsd.times(new PreciseDecimal(riskPct.toString())).abs();
    const stopDecimal = new PreciseDecimal(stopPct);
    const sizeNotional = riskUsd.dividedBy(stopDecimal);
    const rawLeverage = ctx.equityUsd.raw === 0n ? 0 : Number(sizeNotional.dividedBy(ctx.equityUsd).toFixed(6));
    const slippageOk = ctx.slippageBps <= this.cfg.execution.maxSlippageBps;
    const leverageCap = slippageOk ? Number.POSITIVE_INFINITY : 1;
    const cappedLeverage = Math.min(rawLeverage, ctx.maxLevInstrument, ctx.maxLevGlobal, ctx.exposureBudget, leverageCap);
    const leverageScalar = rawLeverage <= 0 ? 0 : cappedLeverage / rawLeverage;
    let adjustedSize = sizeNotional.times(new PreciseDecimal(leverageScalar));
    let adjustedRiskUsd = riskUsd.times(new PreciseDecimal(leverageScalar));
    let leverage = cappedLeverage;
    const baseMinNotionalUsd = ctx.minNotionalUsd ?? 0;
    const hasConfidenceFloor = confidenceTargetNotionalUsd != null && confidenceTargetNotionalUsd > baseMinNotionalUsd + 1e-9;
    const effectiveMinNotional = Math.max(baseMinNotionalUsd, confidenceTargetNotionalUsd ?? 0);
    let minNotionalApplied = false;
    const priceAbs = ctx.price.abs();
    if (effectiveMinNotional > 0 && priceAbs.raw !== 0n) {
      const minNotionalDec = new PreciseDecimal(effectiveMinNotional);
      const currentNotional = adjustedSize.times(priceAbs).abs();
      if (currentNotional.lt(minNotionalDec)) {
        const minSize = minNotionalDec.dividedBy(priceAbs);
        const stopPctDec = new PreciseDecimal(stopPct);
        const minLeverage = ctx.equityUsd.raw === 0n
          ? 0
          : Number(minNotionalDec.dividedBy(ctx.equityUsd).toFixed(6));
        const maxAllowedLeverage = Math.min(ctx.maxLevInstrument, ctx.maxLevGlobal, ctx.exposureBudget);
        if (minLeverage <= maxAllowedLeverage + 1e-9) {
          adjustedSize = minSize;
          adjustedRiskUsd = minNotionalDec.times(stopPctDec);
          leverage = Math.max(leverage, minLeverage);
          minNotionalApplied = true;
          if (ctx.equityUsd.raw !== 0n) {
            const recalculated = adjustedRiskUsd.dividedBy(ctx.equityUsd);
            riskPct = Number(recalculated.toFixed(6));
          }
        } else {
          if (!hasConfidenceFloor) {
            return {
              size: PreciseDecimal.fromRaw(0n),
              riskUsd: PreciseDecimal.fromRaw(0n),
              leverage: 0,
              riskPct,
              confidenceTargetNotionalUsd,
              confidenceRiskFloorApplied: riskFloorApplied || undefined,
              confidenceRiskBoostApplied: riskBoostApplied || undefined,
              droppedReason: 'below_min_notional',
            };
          }
          // Confidence-driven floor cannot be met — fall back to maximum allowed size.
          const maxAllowedNotional = ctx.equityUsd.times(new PreciseDecimal(maxAllowedLeverage.toString()));
          const fallbackNotional = maxAllowedNotional.lt(minNotionalDec) ? maxAllowedNotional : minNotionalDec;
          if (fallbackNotional.raw <= 0n) {
            return {
              size: PreciseDecimal.fromRaw(0n),
              riskUsd: PreciseDecimal.fromRaw(0n),
              leverage: 0,
              riskPct,
              confidenceTargetNotionalUsd,
              confidenceRiskFloorApplied: riskFloorApplied || undefined,
              confidenceRiskBoostApplied: riskBoostApplied || undefined,
              droppedReason: 'below_min_notional',
            };
          }
          adjustedSize = fallbackNotional.dividedBy(priceAbs);
          adjustedRiskUsd = fallbackNotional.times(stopPctDec);
          leverage = Math.min(maxAllowedLeverage, Number(fallbackNotional.dividedBy(ctx.equityUsd).toFixed(6)));
          minNotionalApplied = true;
          if (ctx.equityUsd.raw !== 0n) {
            const recalculated = adjustedRiskUsd.dividedBy(ctx.equityUsd);
            riskPct = Number(recalculated.toFixed(6));
          }
        }
      }
    }
    return {
      size: adjustedSize,
      riskUsd: adjustedRiskUsd,
      leverage,
      minNotionalApplied,
      riskPct,
      confidenceTargetNotionalUsd,
      confidenceRiskFloorApplied: riskFloorApplied || undefined,
      confidenceRiskBoostApplied: riskBoostApplied || undefined,
    };
  }
}

export type Regime = 'BOM' | 'MR';
export type SRKey = `${Regime}:${Side}`;

export class DirectionalPressure {
  private readonly buckets = new Map<string, Map<SRKey, number[]>>();
  private static readonly HALF_LIFE_MS = 30 * 60_000;
  private static readonly MAX_SAMPLES = 5;

  recordStop(symbol: string, regime: Regime, side: Side, ts: number): void {
    const key = `${regime}:${side}` as SRKey;
    const store = this.getStore(symbol);
    const list = store.get(key) ?? [];
    list.push(ts);
    while (list.length > DirectionalPressure.MAX_SAMPLES) {
      list.shift();
    }
    store.set(key, list);
  }

  recentPressure(symbol: string, regime: Regime, side: Side, now: number): number {
    const key = `${regime}:${side}` as SRKey;
    const store = this.buckets.get(symbol);
    if (!store) return 0;
    const list = store.get(key);
    if (!list || !list.length) return 0;
    let acc = 0;
    for (const ts of list) {
      const age = Math.max(0, now - ts);
      const weight = Math.pow(0.5, age / DirectionalPressure.HALF_LIFE_MS);
      acc += weight;
    }
    return Math.max(0, Math.min(1, acc));
  }

  private getStore(symbol: string): Map<SRKey, number[]> {
    const existing = this.buckets.get(symbol);
    if (existing) {
      return existing;
    }
    const map = new Map<SRKey, number[]>();
    this.buckets.set(symbol, map);
    return map;
  }
}

export function computeSidePenalty(pressure: number): number {
  const clamped = Math.max(0, Math.min(1, pressure));
  return Math.max(0.6, Math.min(1, 1 - 0.25 * clamped));
}

export class GuardrailMonitor {
  private readonly cfg = loadIntradayConfig();
  private readonly symbolState = new Map<string, SymbolState>();
  private performance: PerformanceWindow = {
    wins: 0,
    losses: 0,
    expectancy: new PreciseDecimal(0),
    samples: 0,
  };
  private dailyPnLPct = new PreciseDecimal(0);
  private lastResetDay = '';
  private healthReduced = false;
  private readonly guardsDisabled = areAgentGuardsDisabled();

  resetIfNeeded(timestamp: number): void {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    if (day !== this.lastResetDay) {
      this.lastResetDay = day;
      this.dailyPnLPct = new PreciseDecimal(0);
      this.symbolState.clear();
    }
  }

  recordTrade(symbol: string, pnlUsd: PreciseDecimal, riskUsd: PreciseDecimal, equityUsd: PreciseDecimal, timestamp: number): void {
    if (this.guardsDisabled) return;
    this.resetIfNeeded(timestamp);
    const equitySafe = equityUsd.raw === 0n ? new PreciseDecimal(1) : equityUsd;
    const pnlPct = pnlUsd.dividedBy(equitySafe);
    this.dailyPnLPct = this.dailyPnLPct.plus(pnlPct);
    const state = this.symbolState.get(symbol) ?? { consecutiveLosses: 0, cooldownUntil: 0 };
    const pnlSign = pnlUsd.raw >= 0 ? 1 : -1;
    if (pnlSign > 0) {
      state.consecutiveLosses = 0;
      this.performance.wins += 1;
    } else {
      state.consecutiveLosses += 1;
      this.performance.losses += 1;
      if (!this.isCooldownDisabled() && state.consecutiveLosses >= this.cfg.risk.cooldownLosses) {
        state.cooldownUntil = timestamp + this.cfg.risk.cooldownMinutes * 60_000;
      } else if (this.isCooldownDisabled()) {
        state.cooldownUntil = 0;
      }
    }
    this.symbolState.set(symbol, state);
    this.performance.samples += 1;
    const rMultiple = pnlUsd.dividedBy(riskUsd.abs());
    const prevExp = this.performance.expectancy;
    const totalSamples = this.performance.samples;
    const newExp = prevExp.plus(rMultiple.minus(prevExp).dividedBy(new PreciseDecimal(totalSamples)));
    this.performance.expectancy = newExp;
    this.updateHealthStatus();
  }

  canEnter(symbol: string, timestamp: number, regime: RegimeLabel): { allowed: boolean; reason?: string; riskReduction?: number } {
    if (this.guardsDisabled) {
      return { allowed: true };
    }
    this.resetIfNeeded(timestamp);
    if (this.dailyPnLPct.toNumber() <= -this.cfg.risk.dailyStopPct) {
      return { allowed: false, reason: 'Daily stop reached' };
    }
    const state = this.symbolState.get(symbol);
    if (!this.isCooldownDisabled() && state && timestamp < state.cooldownUntil) {
      return { allowed: false, reason: 'Symbol cooldown active' };
    }
    if (this.healthReduced) {
      if (regime === 'MR') {
        return { allowed: false, reason: 'MR disabled due to health drawdown' };
      }
      return {
        allowed: true,
        reason: 'Risk reduced due to health',
        riskReduction: this.cfg.risk.strategyHealth.riskPctReduction,
      };
    }
    return { allowed: true };
  }

  private updateHealthStatus(): void {
    if (this.guardsDisabled) {
      this.healthReduced = false;
      return;
    }
    const totalTrades = this.performance.wins + this.performance.losses;
    if (totalTrades >= 10) {
      const hitRate = totalTrades === 0 ? 0 : this.performance.wins / totalTrades;
      const expectancyNum = this.performance.expectancy.toNumber();
      this.healthReduced =
        expectancyNum <= this.cfg.risk.strategyHealth.expectancyFloor &&
        hitRate < this.cfg.risk.strategyHealth.hitRateFloor;
    } else {
      this.healthReduced = false;
    }
  }

  private isCooldownDisabled(): boolean {
    return this.cfg.risk.cooldownLosses <= 0 || this.cfg.risk.cooldownMinutes <= 0;
  }
}
