import { PreciseDecimal } from '../strategy/metaAdaptiveAgent.js';
import { loadIntradayConfig } from './config/index.js';
import type { RegimeLabel } from './types.js';

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
};

export type PositionSizingResult = {
  size: PreciseDecimal;
  riskUsd: PreciseDecimal;
  leverage: number;
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
    const stopPct = Math.max(1e-6, ctx.stopLossPct);
    const baseRiskPct = this.cfg.risk.baseRiskPct;
    const regimeMult = ctx.regime === 'BOM' ? this.cfg.risk.bomMultiplier : this.cfg.risk.mrMultiplier;
    const riskReduction = Math.max(0.1, Math.min(1, ctx.riskReduction ?? 1));
    const riskPct = baseRiskPct * regimeMult * riskReduction;
    const riskUsd = ctx.equityUsd.times(new PreciseDecimal(riskPct.toString())).abs();
    const stopDecimal = new PreciseDecimal(stopPct);
    const sizeNotional = riskUsd.dividedBy(stopDecimal);
    const rawLeverage = ctx.equityUsd.raw === 0n ? 0 : Number(sizeNotional.dividedBy(ctx.equityUsd).toFixed(6));
    const slippageOk = ctx.slippageBps <= this.cfg.execution.maxSlippageBps;
    const leverageCap = slippageOk ? Number.POSITIVE_INFINITY : 1;
    const cappedLeverage = Math.min(rawLeverage, ctx.maxLevInstrument, ctx.maxLevGlobal, ctx.exposureBudget, leverageCap);
    const leverageScalar = rawLeverage <= 0 ? 0 : cappedLeverage / rawLeverage;
    const adjustedSize = sizeNotional.times(new PreciseDecimal(leverageScalar));
    const adjustedRiskUsd = riskUsd.times(new PreciseDecimal(leverageScalar));
    return {
      size: adjustedSize,
      riskUsd: adjustedRiskUsd,
      leverage: cappedLeverage,
    };
  }
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

  resetIfNeeded(timestamp: number): void {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    if (day !== this.lastResetDay) {
      this.lastResetDay = day;
      this.dailyPnLPct = new PreciseDecimal(0);
      this.symbolState.clear();
    }
  }

  recordTrade(symbol: string, pnlUsd: PreciseDecimal, riskUsd: PreciseDecimal, equityUsd: PreciseDecimal, timestamp: number): void {
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
      if (state.consecutiveLosses >= this.cfg.risk.cooldownLosses) {
        state.cooldownUntil = timestamp + this.cfg.risk.cooldownMinutes * 60_000;
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
    this.resetIfNeeded(timestamp);
    if (this.dailyPnLPct.toNumber() <= -this.cfg.risk.dailyStopPct) {
      return { allowed: false, reason: 'Daily stop reached' };
    }
    const state = this.symbolState.get(symbol);
    if (state && timestamp < state.cooldownUntil) {
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
}
