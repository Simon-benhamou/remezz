import { loadIntradayConfig } from './config/index.js';
import { RollingWindow } from './rolling.js';
import type { ExecutionDirective, OrderBookSnapshot, RegimeLabel } from './types.js';

export type ExecutionContext = {
  regime: RegimeLabel;
  orderBook: OrderBookSnapshot | null;
  atrPct: number;
  sizeUsd: number;
  slippageBps: number;
};

export type RuntimeExecutionMetrics = {
  fillRate?: number;
  slippageBps?: number;
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
  private readonly fillRateWindow = new RollingWindow(20);
  private readonly slippageWindow = new RollingWindow(50);

  ingest(metrics: RuntimeExecutionMetrics | null | undefined): void {
    if (!metrics) return;
    if (typeof metrics.fillRate === 'number' && Number.isFinite(metrics.fillRate)) {
      const clamped = Math.max(0, Math.min(1, metrics.fillRate));
      this.fillRateWindow.push(clamped);
    }
    if (typeof metrics.slippageBps === 'number' && Number.isFinite(metrics.slippageBps)) {
      this.slippageWindow.push(Math.max(0, metrics.slippageBps));
    }
  }

  private recentFillRate(): number {
    return this.fillRateWindow.length() ? this.fillRateWindow.mean() : 1;
  }

  private observedSlippage(): number {
    if (!this.slippageWindow.length()) return 0;
    return this.slippageWindow.percentile(0.8);
  }

  plan(ctx: ExecutionContext): ExecutionDirective {
    const spreadBps = computeSpreadBps(ctx.orderBook);
    const volAdjust = Math.min(2, Math.max(0.5, ctx.atrPct / 0.002));
    const offsetRange = this.cfg.execution.makerOffsetBps;
    let offset = Math.max(
      offsetRange.min,
      Math.min(offsetRange.max, spreadBps * 0.5 * volAdjust),
    );

    const fillRate = this.recentFillRate();
    const observedSlippage = this.observedSlippage();
    const effectiveSlippage = Math.max(ctx.slippageBps, observedSlippage);

    if (fillRate < 0.7) {
      offset = Math.max(offsetRange.min, offset * 0.75);
    }
    if (fillRate < 0.5) {
      offset = Math.max(offsetRange.min, offset * 0.5);
    }

    if (ctx.sizeUsd >= this.cfg.execution.twapThresholdUsd) {
      return {
        mode: 'twap',
        maxSlippageBps: this.cfg.execution.maxSlippageBps,
      };
    }

    const spreadWide = spreadBps > offsetRange.max * 1.2;
    const slippageTight = effectiveSlippage <= this.cfg.execution.maxSlippageBps;

    if (spreadWide && slippageTight && fillRate >= 0.6) {
      return {
        mode: 'maker',
        passiveOffsetBps: offset,
        fallbackSeconds: this.cfg.execution.fallbackSeconds.max,
        maxSlippageBps: this.cfg.execution.maxSlippageBps,
      };
    }

    let fallbackSeconds = ctx.regime === 'BOM'
      ? this.cfg.execution.fallbackSeconds.min
      : this.cfg.execution.fallbackSeconds.max;

    if (fillRate < 0.65) {
      fallbackSeconds = Math.max(this.cfg.execution.fallbackSeconds.min, fallbackSeconds * 0.7);
    }

    if (effectiveSlippage > this.cfg.execution.maxSlippageBps) {
      return {
        mode: 'taker',
        fallbackSeconds,
        maxSlippageBps: this.cfg.execution.maxSlippageBps,
      };
    }

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
