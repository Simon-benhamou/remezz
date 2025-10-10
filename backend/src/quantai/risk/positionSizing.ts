export type PositionSizingParams = {
  equityUsd: number;
  entryPrice: number;
  stopPrice: number;
  riskPct?: number;
  maxNotionalUsd?: number;
};

export type PositionSizingResult = {
  qty: number;
  notionalUsd: number;
  riskUsd: number;
  riskPct: number;
  stopDistance: number;
};

export class PositionSizer {
  constructor(private readonly baseRiskPerTradePct: number) {}

  computeSize(params: PositionSizingParams): PositionSizingResult {
    const riskPct = params.riskPct && params.riskPct > 0 ? params.riskPct : this.baseRiskPerTradePct;
    const stopDistance = Math.abs(params.entryPrice - params.stopPrice);
    if (!(stopDistance > 0) || !(params.entryPrice > 0) || !(params.equityUsd > 0)) {
      return {
        qty: 0,
        notionalUsd: 0,
        riskUsd: 0,
        riskPct,
        stopDistance,
      };
    }
    const riskUsd = params.equityUsd * (riskPct / 100);
    const qty = riskUsd / stopDistance;
    const notionalUsd = qty * params.entryPrice;
    const cappedNotional = params.maxNotionalUsd && params.maxNotionalUsd > 0
      ? Math.min(notionalUsd, params.maxNotionalUsd)
      : notionalUsd;
    const adjustedQty = params.entryPrice > 0 ? cappedNotional / params.entryPrice : 0;
    return {
      qty: Math.max(0, adjustedQty),
      notionalUsd: Math.max(0, cappedNotional),
      riskUsd: Math.max(0, riskUsd),
      riskPct,
      stopDistance,
    };
  }

  static rMultiple(entry: number, stop: number, price: number, side: 'long' | 'short'): number {
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return 0;
    if (side === 'long') {
      return (price - entry) / risk;
    }
    return (entry - price) / risk;
  }
}
