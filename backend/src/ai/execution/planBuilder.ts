import { getEnv } from '../../config/env.js';
import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { estimateCosts } from '../ranking/costModel.js';

export interface ExecutionLeg {
  type: 'LIMIT' | 'PA' | 'TWAP' | 'MARKET';
  sizePct: number;
  params?: Record<string, number>;
}

export interface ExecutionPlan {
  legs: ExecutionLeg[];
  notionalUsd: number;
  riskUsd: number;
  slPct: number;
  tpPcts: number[];
  tpUsd: number;
  precise: {
    notionalUsd: PreciseDecimal;
    riskUsd: PreciseDecimal;
    slPct: PreciseDecimal;
    tpPcts: PreciseDecimal[];
    tpUsd: PreciseDecimal;
  };
}

export interface BuildPlanInput {
  equityUsd: number;
  stopPct: number;
  baseNotionalCapUsd?: number;
  tpMultipliers?: number[];
  spreadBps: number;
  passiveFillRate?: number;
  mode?: 'risk' | 'budget';
  budgetUsd?: number;
  atrPct?: number;
  depthUsd?: number;
  slipRecentBps?: number;
}

export function buildExecutionPlan(input: BuildPlanInput): ExecutionPlan | null {
  const env = getEnv();
  const stopPctNumber = Number(input.stopPct);
  if (!Number.isFinite(stopPctNumber) || stopPctNumber <= 0) {
    return null;
  }

  const stopPct = new PreciseDecimal(stopPctNumber);
  const mode = input.mode ?? 'risk';

  let notionalUsd: PreciseDecimal;
  let riskUsd: PreciseDecimal;

  if (mode === 'budget') {
    const budgetCandidate = Number.isFinite(input.budgetUsd)
      ? Number(input.budgetUsd)
      : Number.isFinite(input.baseNotionalCapUsd)
        ? Number(input.baseNotionalCapUsd)
        : NaN;
    if (!Number.isFinite(budgetCandidate) || budgetCandidate <= 0) {
      return null;
    }
    notionalUsd = new PreciseDecimal(budgetCandidate);
    riskUsd = notionalUsd.times(stopPct);
  } else {
    const equity = new PreciseDecimal(Number.isFinite(input.equityUsd) ? input.equityUsd : 0);
    const rawRisk = equity.times(new PreciseDecimal(env.RISK_PCT_PER_TRADE));
    if (rawRisk.toNumber() <= 0) {
      return null;
    }
    notionalUsd = rawRisk.dividedBy(stopPct);
    riskUsd = rawRisk;
  }
  if (input.baseNotionalCapUsd != null && Number.isFinite(input.baseNotionalCapUsd)) {
    const cap = new PreciseDecimal(input.baseNotionalCapUsd);
    if (notionalUsd.gt(cap)) {
      notionalUsd = cap;
    }
  }

  if (notionalUsd.toNumber() <= 0) {
    return null;
  }

  if (mode !== 'budget') {
    riskUsd = notionalUsd.times(stopPct);
  }

  const defaultMultipliers = [env.MIN_RR, env.MIN_RR * 1.5, env.MIN_RR * 2.5];
  const provided = Array.isArray(input.tpMultipliers) && input.tpMultipliers.length
    ? input.tpMultipliers.slice(0, 3)
    : defaultMultipliers;
  const useAsPercent = provided.some((value) => value > 0 && value <= 0.5);
  const multipliers = provided.map((value, index) => {
    if (useAsPercent) return value;
    const minimum = env.MIN_RR * (index === 0 ? 1 : 1 + 0.5 * index);
    return Math.max(value, minimum);
  });

  const tpPcts = multipliers.map((mult) => useAsPercent
    ? new PreciseDecimal(mult)
    : stopPct.times(new PreciseDecimal(mult))
  );
  if (!tpPcts.length) {
    return null;
  }

  const conservativeTpPct = tpPcts[0];
  const tpUsd = notionalUsd.times(conservativeTpPct);
  const tolerance = new PreciseDecimal('0.0005');
  if (tpUsd.plus(tolerance).lt(env.MIN_TARGET_GAIN_USD)) {
    return null;
  }

  const costs = estimateCosts({
    notionalUsd,
    spreadBps: input.spreadBps,
    slipRecentBps: input.slipRecentBps,
    passiveFillRate: input.passiveFillRate,
  });
  const tpUsdNet = tpUsd.minus(costs.total);
  if (tpUsdNet.lt(env.MIN_TARGET_GAIN_USD) || tpUsdNet.lt(0)) {
    return null;
  }

  let limitShare = clamp01(env.ENTRY_SPLIT_LIMIT);
  let activeShare = clamp01(env.ENTRY_SPLIT_PA);
  const baseSum = limitShare + activeShare;
  if (baseSum <= 0) {
    limitShare = 1;
    activeShare = 0;
  }

  const atrPct = Number.isFinite(input.atrPct) ? Number(input.atrPct) : null;
  const depthValue = Number.isFinite(input.depthUsd) ? Math.max(0, Number(input.depthUsd)) : null;
  const impactPct = depthValue && depthValue > 0
    ? notionalUsd.dividedBy(new PreciseDecimal(depthValue)).times(new PreciseDecimal('100'))
    : null;
  const impactPctNumber = impactPct?.toNumber();

  const allowMarket = atrPct != null
    && atrPct >= env.ORDER_MARKET_ATR_PCT
    && impactPctNumber != null
    && impactPctNumber <= env.ORDER_MAX_IMPACT_PCT;

  if (allowMarket && baseSum > 1) {
    limitShare /= baseSum;
    activeShare /= baseSum;
  }

  if (!allowMarket) {
    const normalizer = baseSum > 0 ? baseSum : 1;
    limitShare = limitShare / normalizer;
    activeShare = activeShare / normalizer;
  }

  let limitPct = roundPct(limitShare);
  let activePct = roundPct(activeShare);
  let marketPct = 0;
  if (allowMarket) {
    const assigned = limitPct + activePct;
    marketPct = roundPct(Math.max(0, 1 - assigned));
  } else {
    const assigned = limitPct + activePct;
    if (assigned < 1) {
      const shortfall = 1 - assigned;
      if (limitPct > 0) {
        limitPct = roundPct(limitPct + shortfall);
      } else if (activePct > 0) {
        activePct = roundPct(activePct + shortfall);
      } else {
        limitPct = 1;
      }
    }
  }

  const twapCondition = input.spreadBps > env.ORDER_TWAP_SPREAD_BPS
    || (input.passiveFillRate ?? 0.5) < 0.3;

  const legs: ExecutionLeg[] = [];
  if (twapCondition) {
    legs.push({ type: 'TWAP', sizePct: 1, params: { durationMs: env.ORDER_LIMIT_TIMEOUT_MS } });
  } else {
    if (limitPct > 0) {
      legs.push({ type: 'LIMIT', sizePct: limitPct, params: { timeoutMs: env.ORDER_LIMIT_TIMEOUT_MS } });
    }
    if (activePct > 0) {
      legs.push({ type: 'PA', sizePct: activePct, params: { offsetBps: Math.max(1, input.spreadBps * 0.25) } });
    }
    if (marketPct > 0) {
      legs.push({ type: 'MARKET', sizePct: marketPct, params: {} });
    }
  }

  if (!legs.length) {
    return null;
  }

  const plan: ExecutionPlan = {
    legs,
    notionalUsd: notionalUsd.toNumber(),
    riskUsd: riskUsd.toNumber(),
    slPct: stopPct.toNumber(),
    tpPcts: tpPcts.map((tp) => tp.toNumber()),
    tpUsd: tpUsd.toNumber(),
    precise: {
      notionalUsd,
      riskUsd,
      slPct: stopPct,
      tpPcts,
      tpUsd,
    },
  };

  return plan;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function roundPct(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}
