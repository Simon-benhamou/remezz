import { PreciseDecimal } from '../../quantai/strategy/metaAdaptiveAgent.js';
import { estimateCosts } from './costModel.js';

export interface ExpectedValueParams {
  p: number;
  tpUsd: PreciseDecimal | number;
  slUsd: PreciseDecimal | number;
  notionalUsd: PreciseDecimal | number;
  spreadBps: number;
  slipRecentBps?: number;
  passiveFillRate?: number;
}

export function expectedValue(params: ExpectedValueParams): {
  ev: PreciseDecimal;
  components: { gain: PreciseDecimal; loss: PreciseDecimal; costs: PreciseDecimal };
  slipBps: number;
  rawSlipBps: number;
} {
  const prob = Math.min(Math.max(params.p, 0), 1);
  const gain = params.tpUsd instanceof PreciseDecimal ? params.tpUsd : new PreciseDecimal(params.tpUsd);
  const loss = params.slUsd instanceof PreciseDecimal ? params.slUsd : new PreciseDecimal(params.slUsd);
  const costs = estimateCosts({
    notionalUsd: params.notionalUsd,
    spreadBps: params.spreadBps,
    slipRecentBps: params.slipRecentBps,
    passiveFillRate: params.passiveFillRate,
  });
  const probDec = new PreciseDecimal(prob.toFixed(6));
  const lossProb = new PreciseDecimal((1 - prob).toFixed(6));
  const ev = gain.times(probDec).minus(loss.times(lossProb)).minus(costs.total);
  return {
    ev,
    components: {
      gain,
      loss,
      costs: costs.total,
    },
    slipBps: costs.slipBps,
    rawSlipBps: costs.rawSlipBps,
  };
}
