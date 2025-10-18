import { PreciseDecimal } from '../../quantai/strategy/metaAdaptiveAgent.js';
import { estimateCosts } from './costModel.js';

export interface ExpectedValueParams {
  p: number;
  tpUsd: number;
  slUsd: number;
  notional: number;
  spreadBps: number;
  slipRecentBps: number;
  passiveFillRate: number;
  feesBps: number;
  alpha: number;
  beta: number;
  capBps: number;
}

export function expectedValue(params: ExpectedValueParams): { ev: PreciseDecimal; components: { gain: PreciseDecimal; loss: PreciseDecimal; costs: PreciseDecimal } } {
  const prob = Math.min(Math.max(params.p, 0), 1);
  const gain = new PreciseDecimal(params.tpUsd).abs();
  const loss = new PreciseDecimal(params.slUsd).abs();
  const costs = estimateCosts({
    notional: params.notional,
    spreadBps: params.spreadBps,
    slipRecentBps: params.slipRecentBps,
    passiveFillRate: params.passiveFillRate,
    feesBps: params.feesBps,
    alpha: params.alpha,
    beta: params.beta,
    capBps: params.capBps,
  }).total;
  const ev = gain.times(new PreciseDecimal(prob.toFixed(6))).minus(
    loss.times(new PreciseDecimal((1 - prob).toFixed(6))),
  ).minus(costs);
  return {
    ev,
    components: {
      gain,
      loss,
      costs,
    },
  };
}
