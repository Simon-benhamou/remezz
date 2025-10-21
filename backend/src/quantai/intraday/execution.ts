import { loadIntradayConfig } from './config/index.js';
import type { ExecutionDirective, OrderBookSnapshot, RegimeLabel } from './types.js';

export type ExecutionContext = {
  regime: RegimeLabel;
  orderBook: OrderBookSnapshot | null;
  atrPct: number;
  sizeUsd: number;
  slippageBps: number;
};

function computeSpreadBps(orderBook: OrderBookSnapshot | null): number {
  if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) return 0;
  const bestBid = orderBook.bids[0].price;
  const bestAsk = orderBook.asks[0].price;
  if (!bestBid || !bestAsk) return 0;
  const mid = (bestBid + bestAsk) / 2;
  if (mid === 0) return 0;
  return ((bestAsk - bestBid) / mid) * 10_000;
}

export class ExecutionPlanner {
  private readonly cfg = loadIntradayConfig();

  plan(ctx: ExecutionContext): ExecutionDirective {
    const spreadBps = computeSpreadBps(ctx.orderBook);
    const volAdjust = Math.min(2, Math.max(0.5, ctx.atrPct / 0.002));
    const offsetRange = this.cfg.execution.makerOffsetBps;
    const offset = Math.max(
      offsetRange.min,
      Math.min(offsetRange.max, spreadBps * 0.5 * volAdjust),
    );

    if (ctx.sizeUsd >= this.cfg.execution.twapThresholdUsd) {
      return {
        mode: 'twap',
        maxSlippageBps: this.cfg.execution.maxSlippageBps,
      };
    }

    const spreadWide = spreadBps > offsetRange.max * 1.2;
    const slippageTight = ctx.slippageBps <= this.cfg.execution.maxSlippageBps;

    if (spreadWide && slippageTight) {
      return {
        mode: 'maker',
        passiveOffsetBps: offset,
        fallbackSeconds: this.cfg.execution.fallbackSeconds.max,
        maxSlippageBps: this.cfg.execution.maxSlippageBps,
      };
    }

    const fallbackSeconds = ctx.regime === 'BOM'
      ? this.cfg.execution.fallbackSeconds.min
      : this.cfg.execution.fallbackSeconds.max;

    const passiveOffset = spreadWide
      ? offset
      : Math.max(offsetRange.min, offset * 0.5);

    return {
      mode: slippageTight ? 'maker' : 'taker',
      passiveOffsetBps: passiveOffset,
      fallbackSeconds,
      maxSlippageBps: this.cfg.execution.maxSlippageBps,
    };
  }
}
