import { getEnv } from '../../config/env.js';
import { PreciseDecimal } from '../../quantai/strategy/metaAdaptiveAgent.js';

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
}

export function buildExecutionPlan(input: BuildPlanInput): ExecutionPlan | null {
  const env = getEnv();
  const stopPctNumber = Number(input.stopPct);
  if (!Number.isFinite(stopPctNumber) || stopPctNumber <= 0) {
    return null;
  }

  const equity = new PreciseDecimal(Number.isFinite(input.equityUsd) ? input.equityUsd : 0);
  const riskUsd = equity.times(new PreciseDecimal(env.RISK_PCT_PER_TRADE));
  if (riskUsd.toNumber() <= 0) {
    return null;
  }

  const stopPct = new PreciseDecimal(stopPctNumber);
  let notionalUsd = riskUsd.dividedBy(stopPct);
  if (input.baseNotionalCapUsd != null && Number.isFinite(input.baseNotionalCapUsd)) {
    const cap = new PreciseDecimal(input.baseNotionalCapUsd);
    if (notionalUsd.gt(cap)) {
      notionalUsd = cap;
    }
  }

  if (notionalUsd.toNumber() <= 0) {
    return null;
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

  let limitShare = clamp01(env.ENTRY_SPLIT_LIMIT);
  let activeShare = clamp01(env.ENTRY_SPLIT_PA);
  const sumShares = limitShare + activeShare;
  if (sumShares > 1) {
    limitShare /= sumShares;
    activeShare /= sumShares;
  }
  const twapCondition = input.spreadBps > env.ENTRY_TWAP_TRIGGER_SPREAD_BPS
    || (input.passiveFillRate ?? 0.5) < 0.3;

  const limitPct = roundPct(limitShare);
  const activePct = roundPct(activeShare);
  const remainder = Math.max(0, 1 - limitPct - activePct);
  const legs: ExecutionLeg[] = [];
  legs.push({ type: 'LIMIT', sizePct: limitPct, params: { timeoutMs: env.ENTRY_LIMIT_TIMEOUT_MS } });

  if (twapCondition) {
    const twapSize = roundPct(activePct + remainder);
    if (twapSize > 0) {
      legs.push({ type: 'TWAP', sizePct: twapSize, params: { durationMs: env.ENTRY_LIMIT_TIMEOUT_MS } });
    }
  } else {
    if (activePct > 0) {
      legs.push({ type: 'PA', sizePct: activePct, params: { offsetBps: Math.max(1, input.spreadBps * 0.25) } });
    }
    const leftover = roundPct(Math.max(0, 1 - limitPct - (activePct > 0 ? activePct : 0)));
    if (leftover > 0 && (activePct === 0 || leftover > 1e-4)) {
      legs.push({ type: 'MARKET', sizePct: leftover, params: {} });
    }
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
