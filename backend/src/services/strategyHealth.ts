import { prisma } from '../db/client.js';
import { recordOpsEvent } from '../monitor/ops.js';

export type StrategyExpectancySample = {
  strategyId: string;
  expectancy: number;
  winRate: number;
  trades: number;
  lastSeen: Date;
};

export type SessionHealthSnapshot = {
  expectancy: number;
  winRate: number;
  sample: number;
  guardrails: StrategyGuardrail | null;
};

export type StrategyPerformanceSummary = {
  expectancy: number;
  winRate: number;
  sample: number;
  guardrail: StrategyGuardrail | null;
  best?: { strategyId: string; expectancy: number; winRate: number; trades: number; ageMinutes: number } | null;
  worst?: { strategyId: string; expectancy: number; winRate: number; trades: number; ageMinutes: number } | null;
  positiveCount: number;
  negativeCount: number;
  staleCount: number;
};

export type StrategyGuardrail = {
  riskMultiplier: number;
  atrMultiplier: number;
  cooldownMs?: number;
  reason: string;
};

export type StrategyReuseResolution = {
  strategy: any | null;
  guardrail: StrategyGuardrail | null;
  fallbackReason?: string;
};

function computeReturn(order: any): number {
  const pct = Number(order?.pctChange || 0);
  if (pct !== 0) return pct / 100;
  const fills = Array.isArray(order?.fills) ? order.fills : [];
  const realized = fills.reduce((sum: number, fill: any) => sum + Number(fill?.realizedPnl || 0), 0);
  const notional = Number(order?.qty || 0) * Number(order?.price || 0);
  if (notional > 0 && realized !== 0) return realized / notional;
  return 0;
}

async function loadStrategySamples(sessionId: string | undefined, symbol: string): Promise<Map<string, StrategyExpectancySample>> {
  const exits = await prisma.order.findMany({
    where: {
      symbol,
      clientOrderId: { endsWith: '.exit' },
      ...(sessionId ? { sessionId } : {}),
    },
    include: { fills: true },
    orderBy: { createdAt: 'desc' },
    take: 60,
  });

  const byStrategy = new Map<string, StrategyExpectancySample>();
  for (const exit of exits) {
    const strategyId = exit.strategyId || 'unlinked';
    const ret = computeReturn(exit);
    let sample = byStrategy.get(strategyId);
    if (!sample) {
      sample = {
        strategyId,
        expectancy: 0,
        winRate: 0,
        trades: 0,
        lastSeen: new Date(exit.createdAt),
      };
      byStrategy.set(strategyId, sample);
    }
    const n = sample.trades + 1;
    sample.expectancy = (sample.expectancy * sample.trades + ret) / n;
    const wins = sample.winRate * sample.trades + (ret > 0 ? 1 : 0);
    sample.winRate = wins / n;
    sample.trades = n;
    if (new Date(exit.createdAt) > sample.lastSeen) sample.lastSeen = new Date(exit.createdAt);
  }

  return byStrategy;
}

async function evaluateSessionHealth(sessionId: string | undefined): Promise<SessionHealthSnapshot> {
  if (!sessionId) {
    return { expectancy: 0, winRate: 0, sample: 0, guardrails: null };
  }
  const kpi = await prisma.sessionKpi.findUnique({ where: { sessionId } });
  const stats: any = kpi?.stats || {};
  const expectancy = Number(kpi?.expectancy ?? 0);
  const winRate = Number(kpi?.winRate ?? 0);
  const trades = Number(stats?.trades ?? 0) || 0;

  let guardrails: StrategyGuardrail | null = null;
  if (trades >= 10) {
    if (winRate < 35 || expectancy < -0.18) {
      guardrails = {
        riskMultiplier: 0.45,
        atrMultiplier: 1.35,
        cooldownMs: 15 * 60 * 1000,
        reason: 'performance_drawdown',
      };
    } else if (expectancy < 0) {
      guardrails = {
        riskMultiplier: 0.65,
        atrMultiplier: 1.15,
        cooldownMs: 5 * 60 * 1000,
        reason: 'expectancy_negative',
      };
    }
  }

  return { expectancy, winRate, sample: trades, guardrails };
}

export async function resolveStrategyHealth(
  sessionId: string | undefined,
  symbol: string,
): Promise<{ health: SessionHealthSnapshot; samples: Map<string, StrategyExpectancySample> }> {
  const [health, samples] = await Promise.all([
    evaluateSessionHealth(sessionId),
    loadStrategySamples(sessionId, symbol),
  ]);
  return { health, samples };
}

function chooseBestStrategy(
  strategies: any[],
  samples: Map<string, StrategyExpectancySample>,
): any | null {
  if (!strategies.length) return null;
  let best: any | null = null;
  let bestScore = -Infinity;
  for (const strat of strategies) {
    const sample = samples.get(strat.id || strat.strategyId || '');
    const expectancy = sample?.expectancy ?? 0;
    const winRate = sample?.winRate ?? 0.5;
    const recencyWeight = sample ? Math.max(0.4, Math.min(1, Math.log10(sample.trades + 1) / 2)) : 0.25;
    const score = expectancy * 100 * 0.6 + (winRate - 0.5) * 20 + recencyWeight * 10;
    if (score > bestScore) {
      bestScore = score;
      best = strat;
    }
  }
  return best;
}

export async function resolveReusableStrategy(
  sessionId: string | undefined,
  symbol: string,
): Promise<StrategyReuseResolution> {
  const { health, samples } = await resolveStrategyHealth(sessionId, symbol);
  const strategies = await prisma.strategy.findMany({
    where: { symbol, ...(sessionId ? { sessionId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  let chosen: any | null = null;
  if (strategies.length) {
    chosen = chooseBestStrategy(strategies, samples);
    if (!chosen) {
      chosen = strategies[0];
    }
  }

  if (chosen && health.guardrails) {
    recordOpsEvent({
      level: 'warn',
      source: 'strategy_health',
      message: 'guardrails_applied',
      sessionId: sessionId || undefined,
      symbol,
      details: {
        guardrail: health.guardrails,
        strategyId: chosen.id,
      },
    });
  }

  return { strategy: chosen, guardrail: health.guardrails };
}

export function mergeGuardrails(base: StrategyGuardrail | null, next: StrategyGuardrail | null): StrategyGuardrail | null {
  if (!base) return next ? { ...next } : null;
  if (!next) return { ...base };
  return {
    riskMultiplier: Math.min(base.riskMultiplier, next.riskMultiplier),
    atrMultiplier: Math.max(base.atrMultiplier, next.atrMultiplier),
    cooldownMs: Math.max(base.cooldownMs ?? 0, next.cooldownMs ?? 0) || undefined,
    reason: `${base.reason}+${next.reason}`,
  };
}

export function buildPerformanceSummary(
  health: SessionHealthSnapshot,
  samples: Map<string, StrategyExpectancySample>,
): StrategyPerformanceSummary {
  const now = Date.now();
  let best: StrategyExpectancySample | null = null;
  let worst: StrategyExpectancySample | null = null;
  let positiveCount = 0;
  let negativeCount = 0;
  let staleCount = 0;

  for (const sample of samples.values()) {
    if (!best || sample.expectancy > best.expectancy) best = sample;
    if (!worst || sample.expectancy < worst.expectancy) worst = sample;
    if (sample.expectancy >= 0) positiveCount += 1; else negativeCount += 1;
    const ageMs = Math.max(0, now - sample.lastSeen.getTime());
    if (ageMs > 45 * 60 * 1000) staleCount += 1;
  }

  const decorate = (
    sample: StrategyExpectancySample | null,
  ): ({ strategyId: string; expectancy: number; winRate: number; trades: number; ageMinutes: number }) | null => {
    if (!sample) return null;
    const ageMinutes = Math.round(Math.max(0, now - sample.lastSeen.getTime()) / 60000);
    return {
      strategyId: sample.strategyId,
      expectancy: sample.expectancy,
      winRate: sample.winRate,
      trades: sample.trades,
      ageMinutes,
    };
  };

  return {
    expectancy: health.expectancy,
    winRate: health.winRate,
    sample: health.sample,
    guardrail: health.guardrails,
    best: decorate(best),
    worst: decorate(worst),
    positiveCount,
    negativeCount,
    staleCount,
  };
}
