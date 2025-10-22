import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import type { ExecutionPlan } from './planBuilder.js';

export interface ExecutionParams {
  plan: ExecutionPlan;
  side: 'long' | 'short';
  fillPrice: number;
  exitPrice: number;
  timestamp: number;
  notional?: number | PreciseDecimal;
}

export interface ExecutionResult {
  pnlUsd: PreciseDecimal;
  rMultiple: number;
  log: string;
}

export class SimulatedExecutor {
  private cumulative = new PreciseDecimal('0');

  run(params: ExecutionParams): ExecutionResult {
    const planNotional = params.plan.precise.notionalUsd;
    const notional = params.notional instanceof PreciseDecimal
      ? params.notional
      : new PreciseDecimal(params.notional ?? planNotional.toNumber());
    const qty = notional.dividedBy(new PreciseDecimal(params.fillPrice));
    const exit = new PreciseDecimal(params.exitPrice);
    const fill = new PreciseDecimal(params.fillPrice);
    const diff = exit.minus(fill);
    const direction = params.side === 'long' ? new PreciseDecimal('1') : new PreciseDecimal('-1');
    const pnl = diff.times(qty).times(direction);
    this.cumulative = this.cumulative.plus(pnl);

    const riskUsd = params.plan.precise.riskUsd;
    const riskValue = riskUsd.toNumber();
    const pnlValue = pnl.toNumber();
    const rMultiple = riskValue !== 0 ? pnlValue / riskValue : 0;
    if (!Number.isFinite(rMultiple)) {
      throw new Error('Non-finite r-multiple');
    }

    const log = `${new Date(params.timestamp).toISOString()} ${params.side.toUpperCase()} qty=${qty.toFixed(4)} price=${fill.toFixed(4)} cumPnl=${this.cumulative.toFixed(2)}`;
    return { pnlUsd: pnl, rMultiple, log };
  }
}
