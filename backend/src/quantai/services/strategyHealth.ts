import { StrategyGuardrail } from '../../services/strategyHealth.js';

export type StrategyHealthSnapshot = {
  expectancy: number;
  winRate: number;
  trades: number;
  ageMinutes: number;
  guardrail: StrategyGuardrail | null;
  refreshRecommended: boolean;
  aggressionMultiplier: number;
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
    this.window = Math.max(5, opts.window ?? 30);
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

  private computeStats(): { expectancy: number; winRate: number; trades: number } {
    const trades = this.samples.length;
    if (!trades) return { expectancy: 0, winRate: 0, trades: 0 };
    let sum = 0;
    let wins = 0;
    for (const sample of this.samples) {
      sum += sample.pnlR;
      if (sample.pnlR > 0) wins += 1;
    }
    return {
      expectancy: sum / trades,
      winRate: wins / trades,
      trades,
    };
  }

  snapshot(currentRegime?: string | null): StrategyHealthSnapshot {
    if (currentRegime != null) this.lastRegime = currentRegime;
    const now = Date.now();
    const { expectancy, winRate, trades } = this.computeStats();
    let guardrail: StrategyGuardrail | null = null;
    if (trades >= this.minTradesForGuard) {
      if (expectancy <= this.negativeExpectancy * 1.5 || winRate <= 0.32) {
        guardrail = { riskMultiplier: 0.45, atrMultiplier: 1.35, cooldownMs: this.refreshCooldownMs, reason: 'health_critical' };
      } else if (expectancy < 0 || winRate < 0.45) {
        guardrail = { riskMultiplier: 0.65, atrMultiplier: 1.15, cooldownMs: this.refreshCooldownMs / 2, reason: 'health_soft_drawdown' };
      }
    }
    const refreshEligible = trades >= this.minTradesForGuard && expectancy < 0;
    const refreshCooldownElapsed = now - this.lastRefreshTs >= this.refreshCooldownMs;
    const refreshRecommended = refreshEligible && refreshCooldownElapsed;
    const aggressionMultiplier = expectancy > 0.25 && winRate > 0.6
      ? 1.12
      : expectancy < 0
        ? 0.85
        : 1;
    const oldest = this.samples[0]?.timestamp ?? now;
    return {
      expectancy,
      winRate,
      trades,
      ageMinutes: (now - oldest) / 60000,
      guardrail,
      refreshRecommended,
      aggressionMultiplier,
      lastRegime: this.lastRegime,
    };
  }
}
