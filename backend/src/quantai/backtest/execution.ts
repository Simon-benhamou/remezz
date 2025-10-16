import { QuantAIFeesConfig } from '../config.js';

export type LiquidityType = 'maker' | 'taker';

export type FillAdjustmentOptions = {
  side: 'buy' | 'sell';
  liquidity?: LiquidityType;
  slippageBps?: number;
};

const BPS_DIVISOR = 10_000;

export function applyFeesAndSlippage(
  price: number,
  cfg: QuantAIFeesConfig,
  options: FillAdjustmentOptions,
): number {
  const liquidity = options.liquidity ?? 'taker';
  const feeBps = liquidity === 'maker' ? cfg.makerFeeBps : cfg.takerFeeBps;
  const slippageBps = options.slippageBps ?? cfg.defaultSlippageBps;
  const totalBps = (feeBps + slippageBps) / BPS_DIVISOR;

  if (options.side === 'buy') {
    return price * (1 + totalBps);
  }
  return price * (1 - totalBps);
}

export function calculateFeeUsd(
  price: number,
  qty: number,
  cfg: QuantAIFeesConfig,
  options: FillAdjustmentOptions,
): number {
  if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) {
    return 0;
  }
  const liquidity = options.liquidity ?? 'taker';
  const feeBps = liquidity === 'maker' ? cfg.makerFeeBps : cfg.takerFeeBps;
  const feeRate = feeBps / BPS_DIVISOR;
  const notional = Math.abs(price * qty);
  return notional * feeRate;
}
