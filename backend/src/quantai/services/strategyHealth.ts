import { StrategyGuardrail } from '../../services/strategyHealth.js';

export type StrategyHealthSnapshot = {
  expectancy: number;
  winRate: number;
  trades: number;
  maxDrawdown: number;
  ageMinutes: number;
  guardrail: StrategyGuardrail | null;
  refreshRecommended: boolean;
  riskMultiplier: number;
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
    const { expectancy, winRate, trades, maxDrawdown } = this.computeMetrics();
    let guardrail: StrategyGuardrail | null = null;
    let riskMultiplier = 1;
    if (trades >= Math.max(5, this.minTradesForGuard / 2)) {
      if (expectancy > 0.25 && winRate > 0.6 && maxDrawdown >= -1) {
        riskMultiplier *= 1.15;
      } else if (expectancy < 0) {
        riskMultiplier *= 0.7;
      }
      if (winRate > 0.62) {
        riskMultiplier *= 1.1;
      } else if (winRate < 0.35) {
        riskMultiplier *= 0.75;
      }
      if (maxDrawdown < -2) {
        riskMultiplier *= 0.85;
      } else if (maxDrawdown > -0.5) {
        riskMultiplier *= 1.05;
      }
    }
    riskMultiplier = Math.max(0.5, Math.min(1.5, riskMultiplier));

    if (trades >= this.minTradesForGuard && (expectancy < 0 || winRate < 0.35)) {
      guardrail = {
        riskMultiplier: Math.max(0.5, Math.min(riskMultiplier, 0.75)),
        atrMultiplier: 1.25,
        cooldownMs: this.refreshCooldownMs,
        reason: winRate < 0.35 ? 'strategy_health_low_winrate' : 'strategy_health_negative_expectancy',
      };
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
      refreshRecommended,
      riskMultiplier,
      lastRegime: this.lastRegime,
    };
  }
}
