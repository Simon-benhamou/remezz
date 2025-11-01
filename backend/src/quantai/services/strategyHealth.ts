import { StrategyGuardrail } from '../../services/strategyHealth.js';

export type StrategyHealthSnapshot = {
  expectancy: number;
  winRate: number;
  trades: number;
  maxDrawdown: number;
  ageMinutes: number;
  guardrail: StrategyGuardrail | null;
  guardrailReason: string | null;
  guardrailChanged: boolean;
  refreshRecommended: boolean;
  riskMultiplier: number;
  riskMultiplierReason: string | null;
  riskMultiplierChanged: boolean;
  decisionId: string;
  lastDecisionAt: number;
  lastRegime?: string | null;
};

type TradeSample = {
  timestamp: number;
  pnlR: number;
  regime: string | null;
};

type StrategyHealthOptions = {
  window?: number;
  minTradesForGuard?: number;
  negativeExpectancy?: number;
  refreshCooldownMs?: number;
};

export class StrategyHealth {
  private samples: TradeSample[] = [];
  private readonly window: number;
  private readonly minTradesForGuard: number;
  private readonly negativeExpectancy: number;
  private readonly refreshCooldownMs: number;
  private lastRefreshTs = 0;
  private lastRegime: string | null = null;
  private lowPerformanceActive = false;
  private lastTradesCount = 0;
  private lastRiskMultiplier = 1;
  private lastDecisionId = 'baseline';
  private lastDecisionAt = 0;
  private activeGuard: { reason: string; activeUntil: number } | null = null;

  constructor(opts: StrategyHealthOptions = {}) {
    this.window = Math.max(5, opts.window ?? 20);
    this.minTradesForGuard = Math.max(3, opts.minTradesForGuard ?? 6);
    this.negativeExpectancy = opts.negativeExpectancy ?? -0.12;
    this.refreshCooldownMs = Math.max(5 * 60 * 1000, opts.refreshCooldownMs ?? 15 * 60 * 1000);
  }

  recordTrade(args: { pnlUsd?: number; riskUsd?: number; pnlR?: number; timestamp?: number; regime?: string | null }): void {
    const ts = args.timestamp ?? Date.now();
    let pnlR: number | null = null;
    if (typeof args.pnlR === 'number' && Number.isFinite(args.pnlR)) {
      pnlR = args.pnlR;
    } else if (args.pnlUsd != null && args.riskUsd != null && Math.abs(args.riskUsd) > 1e-6) {
      pnlR = args.pnlUsd / args.riskUsd;
    }
    if (pnlR == null || !Number.isFinite(pnlR)) return;
    this.samples.push({ timestamp: ts, pnlR, regime: args.regime ?? null });
    if (this.samples.length > this.window) {
      this.samples = this.samples.slice(-this.window);
    }
    if (args.regime != null) this.lastRegime = args.regime;
  }

  noteRefresh(): void {
    this.lastRefreshTs = Date.now();
  }

  private computeMetrics(): { expectancy: number; winRate: number; trades: number; maxDrawdown: number } {
    const trades = this.samples.length;
    if (!trades) {
      return { expectancy: 0, winRate: 0, trades: 0, maxDrawdown: 0 };
    }
    let sum = 0;
    let wins = 0;
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const sample of this.samples) {
      sum += sample.pnlR;
      if (sample.pnlR > 0) wins += 1;
      cumulative += sample.pnlR;
      if (cumulative > peak) {
        peak = cumulative;
      }
      const drawdown = cumulative - peak;
      if (drawdown < maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
    return {
      expectancy: sum / trades,
      winRate: wins / trades,
      trades,
      maxDrawdown,
    };
  }

  snapshot(currentRegime?: string | null): StrategyHealthSnapshot {
    if (currentRegime != null) this.lastRegime = currentRegime;
    const now = Date.now();
    if (this.lastDecisionAt === 0) {
      this.lastDecisionAt = now;
    }
    const { expectancy, winRate, trades, maxDrawdown } = this.computeMetrics();
    const newTradeArrived = trades !== this.lastTradesCount;

    let riskMultiplier = 1;
    const reasons: string[] = [];
    if (trades >= Math.max(5, this.minTradesForGuard / 2)) {
      if (expectancy > 0.25 && winRate > 0.6 && maxDrawdown >= -1) {
        riskMultiplier *= 1.15;
        reasons.push('expectancy_positive');
      } else if (expectancy < 0) {
        riskMultiplier *= 0.7;
        reasons.push('low_expectancy');
      }
      if (winRate > 0.62) {
        riskMultiplier *= 1.1;
        reasons.push('high_winrate');
      } else if (winRate < 0.35) {
        riskMultiplier *= 0.75;
        reasons.push('low_winrate');
      }
      if (maxDrawdown < -2) {
        riskMultiplier *= 0.85;
        reasons.push('drawdown_elevated');
      } else if (maxDrawdown > -0.5) {
        riskMultiplier *= 1.05;
        reasons.push('drawdown_relief');
      }
    }

    const lowWinrateTrigger = trades >= this.minTradesForGuard && winRate < 0.35;
    const lowExpectancyTrigger = trades >= this.minTradesForGuard && expectancy <= 0;
    if (this.lowPerformanceActive) {
      if (winRate > 0.45 && expectancy > 0) {
        this.lowPerformanceActive = false;
      }
    }
    if (!this.lowPerformanceActive && (lowWinrateTrigger || lowExpectancyTrigger)) {
      this.lowPerformanceActive = true;
    }
    if (this.lowPerformanceActive) {
      riskMultiplier = Math.min(riskMultiplier, 0.7);
      if (lowWinrateTrigger) {
        reasons.push('low_winrate');
      } else if (lowExpectancyTrigger) {
        reasons.push('low_expectancy');
      } else {
        reasons.push('low_performance');
      }
    }

    const clampedRiskMultiplier = Math.max(0.5, Math.min(1.5, riskMultiplier));
    let riskMultiplierReason: string | null = null;
    if (this.lowPerformanceActive) {
      if (lowWinrateTrigger) {
        riskMultiplierReason = 'low_winrate';
      } else if (lowExpectancyTrigger) {
        riskMultiplierReason = 'low_expectancy';
      } else {
        riskMultiplierReason = 'low_performance';
      }
    } else if (reasons.length) {
      const tail = reasons[reasons.length - 1];
      riskMultiplierReason = tail;
    } else if (Math.abs(clampedRiskMultiplier - 1) > 1e-3) {
      riskMultiplierReason = clampedRiskMultiplier > 1 ? 'positive_adjustment' : 'negative_adjustment';
    }

    const decisionId = riskMultiplierReason ?? 'baseline';
    let riskMultiplierChanged = false;
    if (newTradeArrived) {
      riskMultiplierChanged = decisionId !== this.lastDecisionId
        || Math.abs(clampedRiskMultiplier - this.lastRiskMultiplier) > 1e-3;
      this.lastTradesCount = trades;
      if (riskMultiplierChanged) {
        this.lastDecisionId = decisionId;
        this.lastRiskMultiplier = clampedRiskMultiplier;
        this.lastDecisionAt = now;
      } else {
        this.lastRiskMultiplier = clampedRiskMultiplier;
      }
    }

    let guardrail: StrategyGuardrail | null = null;
    let guardrailReason: string | null = null;
    let guardrailChanged = false;
    const guardTriggered = trades >= this.minTradesForGuard && (expectancy < 0 || winRate < 0.35);
    if (guardTriggered) {
      guardrailReason = winRate < 0.35 ? 'strategy_health_low_winrate' : 'strategy_health_negative_expectancy';
      const cooldownMs = this.refreshCooldownMs;
      const activeUntil = now + cooldownMs;
      guardrail = {
        riskMultiplier: Math.max(0.5, Math.min(clampedRiskMultiplier, 0.75)),
        atrMultiplier: 1.25,
        cooldownMs,
        reason: guardrailReason,
      };
      if (!this.activeGuard || this.activeGuard.reason !== guardrailReason || this.activeGuard.activeUntil <= now) {
        this.activeGuard = { reason: guardrailReason, activeUntil };
        guardrailChanged = true;
      } else {
        guardrail = {
          ...guardrail,
          cooldownMs: Math.max(0, this.activeGuard.activeUntil - now),
        };
      }
    } else if (this.activeGuard) {
      if (now >= this.activeGuard.activeUntil || (winRate > 0.45 && expectancy > 0)) {
        guardrailChanged = true;
        this.activeGuard = null;
      } else {
        guardrail = {
          riskMultiplier: Math.max(0.5, Math.min(clampedRiskMultiplier, 0.75)),
          atrMultiplier: 1.25,
          cooldownMs: Math.max(0, this.activeGuard.activeUntil - now),
          reason: this.activeGuard.reason,
        };
        guardrailReason = this.activeGuard.reason;
      }
    }

    const refreshEligible = trades >= this.minTradesForGuard && expectancy < 0;
    const refreshCooldownElapsed = now - this.lastRefreshTs >= this.refreshCooldownMs;
    const refreshRecommended = refreshEligible && refreshCooldownElapsed;
    const oldest = this.samples[0]?.timestamp ?? now;
    return {
      expectancy,
      winRate,
      trades,
      maxDrawdown,
      ageMinutes: (now - oldest) / 60000,
      guardrail,
      guardrailReason,
      guardrailChanged,
      refreshRecommended,
      riskMultiplier: clampedRiskMultiplier,
      riskMultiplierReason,
      riskMultiplierChanged,
      decisionId,
      lastDecisionAt: this.lastDecisionAt,
      lastRegime: this.lastRegime,
    };
  }
}
