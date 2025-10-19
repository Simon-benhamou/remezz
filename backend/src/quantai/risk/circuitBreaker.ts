import { QuantAIRiskConfig } from '../config.js';

export type CircuitBreakerDecision = {
  allowed: boolean;
  reason?: string;
  cooldownUntil?: Date | null;
};

export type CircuitBreakerState = {
  consecutiveLosses: number;
  consecutiveWins: number;
  tradesToday: number;
  equityStartDay: number | null;
  cooldownUntil: Date | null;
  lastTradeDay: number | null;
  dayStartAt: Date | null;
  dailyLossActive: boolean;
  dailyLossTriggeredAt: Date | null;
  dailyLossRecoveryWinsRemaining: number;
};

export type CircuitBreakerOptions = {
  initialState?: Partial<CircuitBreakerState> | null;
  onStateChange?: (state: CircuitBreakerState) => void | Promise<void>;
};

function dayOfYear(date: Date): number {
  const start = new Date(date.getUTCFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

export class CircuitBreaker {
  private consecutiveLosses = 0;
  private consecutiveWins = 0;
  private tradesToday = 0;
  private equityStartDay: number | null = null;
  private cooldownUntil: Date | null = null;
  private lastTradeDay: number | null = null;
  private dayStartAt: Date | null = null;
  private dailyLossActive = false;
  private dailyLossTriggeredAt: Date | null = null;
  private dailyLossRecoveryWinsRemaining = 0;
  private readonly onStateChange?: (state: CircuitBreakerState) => void | Promise<void>;

  constructor(private readonly cfg: QuantAIRiskConfig, opts: CircuitBreakerOptions = {}) {
    this.onStateChange = opts.onStateChange;
    if (opts.initialState) {
      this.hydrateState(opts.initialState);
    }
  }

  private hydrateState(state: Partial<CircuitBreakerState>): void {
    if (typeof state.consecutiveLosses === 'number' && Number.isFinite(state.consecutiveLosses)) {
      this.consecutiveLosses = Math.max(0, Math.floor(state.consecutiveLosses));
    }
    if (typeof state.consecutiveWins === 'number' && Number.isFinite(state.consecutiveWins)) {
      this.consecutiveWins = Math.max(0, Math.floor(state.consecutiveWins));
    }
    if (typeof state.tradesToday === 'number' && Number.isFinite(state.tradesToday)) {
      this.tradesToday = Math.max(0, Math.floor(state.tradesToday));
    }
    if (state.equityStartDay != null && Number.isFinite(state.equityStartDay)) {
      this.equityStartDay = Number(state.equityStartDay);
    }
    if (state.lastTradeDay != null && Number.isFinite(state.lastTradeDay)) {
      this.lastTradeDay = Math.floor(state.lastTradeDay);
    }
    if (state.cooldownUntil) {
      const parsed = new Date(state.cooldownUntil as Date | string);
      if (!Number.isNaN(parsed.getTime())) {
        this.cooldownUntil = parsed;
      }
    }
    if (state.dayStartAt) {
      const parsed = new Date(state.dayStartAt as Date | string);
      if (!Number.isNaN(parsed.getTime())) {
        this.dayStartAt = parsed;
      }
    }
    if (typeof (state as any).dailyLossActive === 'boolean') {
      this.dailyLossActive = Boolean((state as any).dailyLossActive);
    }
    if ((state as any).dailyLossTriggeredAt) {
      const parsed = new Date((state as any).dailyLossTriggeredAt as Date | string);
      if (!Number.isNaN(parsed.getTime())) {
        this.dailyLossTriggeredAt = parsed;
      }
    }
    if (typeof (state as any).dailyLossRecoveryWinsRemaining === 'number' && Number.isFinite((state as any).dailyLossRecoveryWinsRemaining)) {
      this.dailyLossRecoveryWinsRemaining = Math.max(0, Math.floor((state as any).dailyLossRecoveryWinsRemaining));
    }
  }

  private emitStateChange(): void {
    if (!this.onStateChange) return;
    const snapshot = this.getState();
    try {
      const maybePromise = this.onStateChange(snapshot);
      if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
        (maybePromise as Promise<void>).catch((error) => {
          console.warn('Failed to persist circuit breaker state:', error);
        });
      }
    } catch (error) {
      console.warn('Failed to persist circuit breaker state:', error);
    }
  }

  private cloneDate(date: Date | null): Date | null {
    return date ? new Date(date.getTime()) : null;
  }

  private resetDayIfNeeded(now: Date, equity: number) {
    const currentDay = dayOfYear(now);
    if (this.lastTradeDay === currentDay) return;
    this.tradesToday = 0;
    this.equityStartDay = Number.isFinite(equity) ? equity : null;
    this.lastTradeDay = currentDay;
    this.dayStartAt = new Date(now.getTime());
    if (this.dailyLossActive || this.dailyLossRecoveryWinsRemaining > 0 || this.dailyLossTriggeredAt) {
      this.dailyLossActive = false;
      this.dailyLossRecoveryWinsRemaining = 0;
      this.dailyLossTriggeredAt = null;
    }
    this.emitStateChange();
  }

  private computeCooldownUntil(now: Date, overrideMinutes?: number): Date {
    const minutes = Math.max(1, overrideMinutes ?? this.cfg.cooldownMinutes ?? 0);
    return new Date(now.getTime() + minutes * 60 * 1000);
  }

  private startCooldown(now: Date, overrideMinutes?: number): Date {
    const until = this.computeCooldownUntil(now, overrideMinutes);
    this.cooldownUntil = until;
    this.emitStateChange();
    return until;
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
        if (!this.dailyLossActive) {
          this.dailyLossActive = true;
          this.dailyLossTriggeredAt = new Date(now.getTime());
          const recoveryWins = Number.isFinite(this.cfg.dailyLossRecoveryWins)
            ? Math.max(0, Math.floor(this.cfg.dailyLossRecoveryWins ?? 0))
            : 0;
          this.dailyLossRecoveryWinsRemaining = recoveryWins;
          const cooldownMinutes = Number.isFinite(this.cfg.dailyLossCooldownMinutes)
            ? Math.max(0, Math.floor(this.cfg.dailyLossCooldownMinutes ?? 0))
            : 0;
          const until = cooldownMinutes > 0
            ? this.startCooldown(now, cooldownMinutes)
            : this.startCooldown(now);
          return {
            allowed: false,
            reason: `Daily loss limit hit (${drawdownPct.toFixed(2)}% <= -${this.cfg.dailyLossLimitPct}%)`,
            cooldownUntil: until,
          };
        }
        return {
          allowed: true,
          reason: 'Daily loss risk reduction active',
          cooldownUntil: this.cooldownUntil,
        };
      }
    }
    if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      const until = this.startCooldown(now);
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
    this.emitStateChange();
  }

  onTradeResult(now: Date, pnlPct: number, equity: number) {
    this.resetDayIfNeeded(now, equity);
    let changed = false;
    if (pnlPct < 0) {
      this.consecutiveLosses += 1;
      this.consecutiveWins = 0;
      changed = true;
      if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.startCooldown(now);
        changed = true;
      }
    } else {
      const wasLoss = this.consecutiveLosses !== 0;
      this.consecutiveLosses = 0;
      if (pnlPct > 0) {
        this.consecutiveWins += 1;
        if (this.dailyLossActive && this.dailyLossRecoveryWinsRemaining > 0) {
          this.dailyLossRecoveryWinsRemaining -= 1;
          if (this.dailyLossRecoveryWinsRemaining <= 0) {
            this.dailyLossActive = false;
            this.dailyLossTriggeredAt = null;
            changed = true;
          }
        }
      } else {
        this.consecutiveWins = 0;
      }
      if (wasLoss || this.consecutiveWins > 0) changed = true;
      if (this.cooldownUntil) {
        this.cooldownUntil = null;
        changed = true;
      }
    }
    if (pnlPct < 0 && this.dailyLossActive && !this.cooldownUntil) {
      const cooldownMinutes = Number.isFinite(this.cfg.dailyLossCooldownMinutes)
        ? Math.max(0, Math.floor(this.cfg.dailyLossCooldownMinutes ?? 0))
        : 0;
      if (cooldownMinutes > 0) {
        this.startCooldown(now, cooldownMinutes);
      }
    }
    if (changed) this.emitStateChange();
  }

  sizeMultiplier(): number {
    let multiplier = 1;

    if (this.dailyLossActive) {
      const reduction = Number.isFinite(this.cfg.dailyLossRiskReductionMultiplier)
        ? Math.min(1, Math.max(0.05, this.cfg.dailyLossRiskReductionMultiplier ?? 1))
        : 0.35;
      multiplier *= reduction;
    }

    if (this.cfg.reduceSizeAfterLosses && this.cfg.sizeReductionAfterLosses > 0) {
      if (this.consecutiveLosses >= this.cfg.sizeReductionAfterLosses) {
        const baseFactor = Math.max(0.05, this.cfg.sizeReductionFactor);
        const excess = this.consecutiveLosses - this.cfg.sizeReductionAfterLosses;
        const progressive = excess > 0 ? baseFactor * Math.pow(0.85, excess) : baseFactor;
        multiplier *= Math.max(0.05, progressive);
      }
    }

    if (this.consecutiveLosses > 0) {
      return Math.max(0.05, multiplier);
    }

    const winsForIncrease = this.cfg.winStreakForIncrease ?? 0;
    const increaseFactor = this.cfg.sizeIncreaseFactor ?? 1;
    const maxIncrease = this.cfg.sizeIncreaseMaxMultiplier ?? 1;

    if (winsForIncrease > 0 && increaseFactor > 1 && maxIncrease > 1 && this.consecutiveWins >= winsForIncrease) {
      const steps = this.consecutiveWins - winsForIncrease + 1;
      const boost = Math.pow(increaseFactor, Math.max(1, steps));
      multiplier *= Math.min(maxIncrease, boost);
    }

    return Math.max(0.05, multiplier);
  }

  enforceLossCooldown(now: Date, overrideMinutes?: number): Date {
    return this.startCooldown(now, overrideMinutes);
  }

  clearCooldown() {
    if (this.cooldownUntil) {
      this.cooldownUntil = null;
      this.emitStateChange();
    }
  }

  getState(): CircuitBreakerState {
    return {
      consecutiveLosses: this.consecutiveLosses,
      consecutiveWins: this.consecutiveWins,
      tradesToday: this.tradesToday,
      equityStartDay: this.equityStartDay,
      cooldownUntil: this.cloneDate(this.cooldownUntil),
      lastTradeDay: this.lastTradeDay,
      dayStartAt: this.cloneDate(this.dayStartAt),
      dailyLossActive: this.dailyLossActive,
      dailyLossTriggeredAt: this.cloneDate(this.dailyLossTriggeredAt),
      dailyLossRecoveryWinsRemaining: this.dailyLossRecoveryWinsRemaining,
    };
  }
}
