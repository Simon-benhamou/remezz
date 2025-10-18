import { PreciseDecimal } from '../../quantai/strategy/metaAdaptiveAgent.js';
import type { ExecutionPlan } from './planBuilder.js';

export interface ExecutionParams {
  plan: ExecutionPlan;
  side: 'long' | 'short';
  notional: number;
  fillPrice: number;
  exitPrice: number;
  timestamp: number;
}

export interface ExecutionResult {
  pnlUsd: PreciseDecimal;
  rMultiple: number;
  log: string;
}

export class SimulatedExecutor {
  private cumulative = new PreciseDecimal('0');

  run(params: ExecutionParams): ExecutionResult {
    const qty = new PreciseDecimal(params.notional).dividedBy(new PreciseDecimal(params.fillPrice));
    const exit = new PreciseDecimal(params.exitPrice);
    const fill = new PreciseDecimal(params.fillPrice);
    const diff = exit.minus(fill);
    const direction = params.side === 'long' ? new PreciseDecimal('1') : new PreciseDecimal('-1');
    const pnl = diff.times(qty).times(direction);
    this.cumulative = this.cumulative.plus(pnl);
    const risk = Math.abs(params.plan.sl - params.fillPrice) || 1;
    const rMultiple = pnl.toNumber() / (risk / params.fillPrice * params.notional || 1);
    const log = `${new Date(params.timestamp).toISOString()} ${params.side.toUpperCase()} qty=${qty.toFixed(4)} price=${fill.toFixed(4)} cumPnl=${this.cumulative.toFixed(2)}`;
    if (!Number.isFinite(rMultiple)) {
      throw new Error('Non-finite r-multiple');
    }
    return { pnlUsd: pnl, rMultiple, log };
  }
}
