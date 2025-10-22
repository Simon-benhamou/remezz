import { getEnv } from '../../config/env.js';
import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

export interface CostModelParams {
  notionalUsd: PreciseDecimal | number;
  spreadBps: number;
  slipRecentBps?: number;
  passiveFillRate?: number;
}

export function estimateCosts(params: CostModelParams): {
  fees: PreciseDecimal;
  slippage: PreciseDecimal;
  total: PreciseDecimal;
  slipBps: number;
  rawSlipBps: number;
} {
  const env = getEnv();
  const notional = params.notionalUsd instanceof PreciseDecimal
    ? params.notionalUsd
    : new PreciseDecimal(params.notionalUsd);
  const spreadBps = Number.isFinite(params.spreadBps) ? params.spreadBps : 0;
  const slipRecentRaw = typeof params.slipRecentBps === 'number' && Number.isFinite(params.slipRecentBps)
    ? Number(params.slipRecentBps)
    : undefined;
  const slipRecent = slipRecentRaw ?? spreadBps;
  let rawSlipBps = env.SLIP_ALPHA * spreadBps + env.SLIP_BETA * slipRecent;
  if ((params.passiveFillRate ?? 0.5) < 0.3) {
    rawSlipBps *= 1.2;
  }
  const slipBps = Math.min(rawSlipBps, env.SLIP_CAP_BPS);
  const fees = notional.times(new PreciseDecimal((env.FEES_BPS / 10_000).toFixed(6)));
  const slippage = notional.times(new PreciseDecimal((slipBps / 10_000).toFixed(6)));
  const total = fees.plus(slippage);
  return { fees, slippage, total, slipBps, rawSlipBps };
}
