import { QuantAIRiskConfig } from '../config.js';

export type CircuitBreakerDecision = {
  allowed: boolean;
  reason?: string;
  cooldownUntil?: Date | null;
};

export type CircuitBreakerState = {
  consecutiveLosses: number;
  tradesToday: number;
  equityStartDay: number | null;
  cooldownUntil: Date | null;
  lastTradeDay: number | null;
};

function dayOfYear(date: Date): number {
  const start = new Date(date.getUTCFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

export class CircuitBreaker {
  private consecutiveLosses = 0;
  private tradesToday = 0;
  private equityStartDay: number | null = null;
  private cooldownUntil: Date | null = null;
  private lastTradeDay: number | null = null;

  constructor(private readonly cfg: QuantAIRiskConfig) {}

  private resetDayIfNeeded(now: Date, equity: number) {
    const currentDay = dayOfYear(now);
    if (this.lastTradeDay === currentDay) return;
    this.tradesToday = 0;
    this.equityStartDay = equity;
    this.lastTradeDay = currentDay;
  }

  canOpenTrade(now: Date, equity: number): CircuitBreakerDecision {
    this.resetDayIfNeeded(now, equity);
    if (this.cooldownUntil && now < this.cooldownUntil) {
      return {
        allowed: false,
        reason: `Cooldown active until ${this.cooldownUntil.toISOString()} after ${this.consecutiveLosses} consecutive losses`,
        cooldownUntil: this.cooldownUntil,
      };
    }
    if (this.tradesToday >= this.cfg.dailyTradeLimit) {
      return {
        allowed: false,
        reason: `Daily trade limit reached (${this.tradesToday}/${this.cfg.dailyTradeLimit})`,
        cooldownUntil: null,
      };
    }
    if (this.equityStartDay != null && this.equityStartDay > 0) {
      const drawdownPct = ((equity - this.equityStartDay) / this.equityStartDay) * 100;
      if (drawdownPct <= -Math.abs(this.cfg.dailyLossLimitPct)) {
        return {
          allowed: false,
          reason: `Daily loss limit hit (${drawdownPct.toFixed(2)}% <= -${this.cfg.dailyLossLimitPct}%)`,
          cooldownUntil: null,
        };
      }
    }
    if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      const until = new Date(now.getTime() + this.cfg.cooldownMinutes * 60 * 1000);
      this.cooldownUntil = until;
      return {
        allowed: false,
        reason: `Consecutive losses threshold reached (${this.consecutiveLosses}/${this.cfg.maxConsecutiveLosses})`,
        cooldownUntil: until,
      };
    }
    return { allowed: true, cooldownUntil: this.cooldownUntil };
  }

  onBeforeOpen(now: Date, equity: number) {
    this.resetDayIfNeeded(now, equity);
    this.tradesToday += 1;
  }

  onTradeResult(now: Date, pnlPct: number, equity: number) {
    this.resetDayIfNeeded(now, equity);
    if (pnlPct < 0) {
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.cooldownUntil = new Date(now.getTime() + this.cfg.cooldownMinutes * 60 * 1000);
      }
    } else {
      this.consecutiveLosses = 0;
      this.cooldownUntil = null;
    }
  }

  sizeMultiplier(): number {
    if (!this.cfg.reduceSizeAfterLosses) return 1;
    if (this.consecutiveLosses >= this.cfg.sizeReductionAfterLosses) {
      return Math.max(0.05, this.cfg.sizeReductionFactor);
    }
    return 1;
  }

  clearCooldown() {
    this.cooldownUntil = null;
  }

  getState(): CircuitBreakerState {
    return {
      consecutiveLosses: this.consecutiveLosses,
      tradesToday: this.tradesToday,
      equityStartDay: this.equityStartDay,
      cooldownUntil: this.cooldownUntil,
      lastTradeDay: this.lastTradeDay,
    };
  }
}
