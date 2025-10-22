import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

const BPS_FACTOR = new PreciseDecimal('10000');

export type FeeOrderInput = {
  price: string | number | PreciseDecimal;
  qty: string | number | PreciseDecimal;
  symbol?: string;
};

export type FeeSummary = {
  ordersEvaluated: number;
  totalNotionalUsd: PreciseDecimal;
  totalFeeUsd: PreciseDecimal;
  avgFeePerOrderUsd: PreciseDecimal;
  feeRate: PreciseDecimal;
  feeRateBps: PreciseDecimal;
  bySymbol: Array<{
    symbol: string;
    orders: number;
    totalNotionalUsd: PreciseDecimal;
    totalFeeUsd: PreciseDecimal;
    avgFeeUsd: PreciseDecimal;
  }>;
};

function toDecimal(value: string | number | PreciseDecimal | undefined | null): PreciseDecimal {
  if (value instanceof PreciseDecimal) return value;
  if (value === undefined || value === null) return new PreciseDecimal('0');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return new PreciseDecimal('0');
    return new PreciseDecimal(value.toString());
  }
  const trimmed = value.trim();
  if (!trimmed) return new PreciseDecimal('0');
  return new PreciseDecimal(trimmed);
}

export function computeFeeSummary(
  orders: FeeOrderInput[],
  feeBpsInput: string | number | PreciseDecimal,
): FeeSummary {
  const rawFeeBps = toDecimal(feeBpsInput as any);
  const feeRate = rawFeeBps.dividedBy(BPS_FACTOR);

  let totalNotional = new PreciseDecimal('0');
  let totalFee = new PreciseDecimal('0');
  let evaluated = 0;

  const perSymbol = new Map<string, { orders: number; notional: PreciseDecimal; fees: PreciseDecimal }>();

  for (const order of orders) {
    const price = toDecimal(order.price);
    const qty = toDecimal(order.qty);

    if (price.equals(0) || qty.equals(0)) continue;

    const absPrice = price.abs();
    const absQty = qty.abs();
    if (absPrice.equals(0) || absQty.equals(0)) continue;

    const notional = absPrice.times(absQty);
    const fee = notional.times(feeRate);

    evaluated += 1;
    totalNotional = totalNotional.plus(notional);
    totalFee = totalFee.plus(fee);

    const symbol = order.symbol ?? 'UNKNOWN';
    let stats = perSymbol.get(symbol);
    if (!stats) {
      stats = { orders: 0, notional: new PreciseDecimal('0'), fees: new PreciseDecimal('0') };
      perSymbol.set(symbol, stats);
    }
    stats.orders += 1;
    stats.notional = stats.notional.plus(notional);
    stats.fees = stats.fees.plus(fee);
  }

  const avgFeePerOrder = evaluated > 0 ? totalFee.dividedBy(new PreciseDecimal(evaluated.toString())) : new PreciseDecimal('0');

  const feeRateBps = feeRate.times(BPS_FACTOR);

  const bySymbol = Array.from(perSymbol.entries())
    .map(([symbol, stats]) => ({
      symbol,
      orders: stats.orders,
      totalNotionalUsd: stats.notional,
      totalFeeUsd: stats.fees,
      avgFeeUsd: stats.orders > 0
        ? stats.fees.dividedBy(new PreciseDecimal(stats.orders.toString()))
        : new PreciseDecimal('0'),
    }))
    .sort((a, b) => b.totalFeeUsd.toNumber() - a.totalFeeUsd.toNumber());

  return {
    ordersEvaluated: evaluated,
    totalNotionalUsd: totalNotional,
    totalFeeUsd: totalFee,
    avgFeePerOrderUsd: avgFeePerOrder,
    feeRate,
    feeRateBps,
    bySymbol,
  };
}

export function summarizeFeeImpact(summary: FeeSummary) {
  return {
    ordersEvaluated: summary.ordersEvaluated,
    totalNotionalUsd: summary.totalNotionalUsd.toFixed(2),
    totalFeeUsd: summary.totalFeeUsd.toFixed(2),
    avgFeePerOrderUsd: summary.avgFeePerOrderUsd.toFixed(2),
    feeRate: summary.feeRate.toFixed(6),
    feeRateBps: summary.feeRateBps.toFixed(2),
    bySymbol: summary.bySymbol.map((entry) => ({
      symbol: entry.symbol,
      orders: entry.orders,
      totalNotionalUsd: entry.totalNotionalUsd.toFixed(2),
      totalFeeUsd: entry.totalFeeUsd.toFixed(2),
      avgFeeUsd: entry.avgFeeUsd.toFixed(2),
    })),
  };
}
