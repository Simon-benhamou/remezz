import { PreciseDecimal } from '../../quantai/strategy/metaAdaptiveAgent.js';

export interface CostModelParams {
  notional: number;
  spreadBps: number;
  slipRecentBps: number;
  passiveFillRate: number;
  feesBps: number;
  alpha: number;
  beta: number;
  capBps: number;
}

export function estimateCosts(params: CostModelParams): { fees: PreciseDecimal; slippage: PreciseDecimal; total: PreciseDecimal } {
  const notional = new PreciseDecimal(params.notional);
  const fees = notional.times(new PreciseDecimal(params.feesBps / 10_000));
  const passiveFactor = Math.max(0.2, Math.min(1, params.passiveFillRate));
  const slipBps = Math.min(params.capBps, params.alpha * params.spreadBps + params.beta * params.slipRecentBps);
  const slipAdj = slipBps / 10_000 / passiveFactor;
  const slippage = notional.times(new PreciseDecimal(slipAdj));
  const total = fees.plus(slippage);
  return { fees, slippage, total };
}
