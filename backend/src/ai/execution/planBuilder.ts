export interface ExecutionLeg {
  type: 'LIMIT' | 'PA' | 'TWAP' | 'MARKET';
  sizePct: number;
  params: Record<string, number>;
}

export interface ExecutionPlan {
  legs: ExecutionLeg[];
  sl: number;
  tp: number[];
  trailing?: { activateAtR: number; trailPct: number };
}

export interface PlanBuilderConfig {
  entryLimitSplit: number;
  entryPaSplit: number;
  limitTimeoutMs: number;
  twapTriggerSpreadBps: number;
  trailActivateR: number;
  trailPct: number;
}

export interface PlanBuilderInput {
  side: 'long' | 'short';
  price: number;
  atrPct: number;
  slMult: number;
  tpMultipliers: number[];
  conformalWidth: number;
  spreadBps: number;
  config: PlanBuilderConfig;
}

export function buildExecutionPlan(input: PlanBuilderInput): ExecutionPlan {
  const { side, price, atrPct, slMult, tpMultipliers, conformalWidth, spreadBps, config } = input;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Invalid price for plan builder');
  }
  const atrDistance = atrPct * price;
  const stopDistance = atrDistance * slMult;
  const sl = side === 'long' ? price - stopDistance : price + stopDistance;
  const tp = tpMultipliers.map(mult => side === 'long' ? price + atrDistance * mult : price - atrDistance * mult);

  const legs: ExecutionLeg[] = [];
  const limitSize = clamp01(config.entryLimitSplit);
  const paSize = clamp01(config.entryPaSplit);
  const residual = Math.max(0, 1 - limitSize - paSize);
  legs.push({ type: 'LIMIT', sizePct: limitSize, params: { timeoutMs: config.limitTimeoutMs } });
  legs.push({ type: 'PA', sizePct: paSize, params: { offsetBps: Math.max(1, spreadBps * 0.25) } });
  if (spreadBps > config.twapTriggerSpreadBps || conformalWidth > 0.2) {
    legs.push({ type: 'TWAP', sizePct: residual, params: { durationMs: config.limitTimeoutMs } });
  } else if (residual > 0) {
    legs.push({ type: 'MARKET', sizePct: residual, params: {}});
  }

  const trailing = conformalWidth > 0.18 ? undefined : { activateAtR: config.trailActivateR, trailPct: config.trailPct };

  return {
    legs,
    sl,
    tp,
    trailing,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
