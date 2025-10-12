export type PositionSizingParams = {
  equityUsd: number;
  entryPrice: number;
  stopPrice?: number;
  stopDistanceAbs?: number;
  riskPct?: number;
  qualityMultiplier?: number;
  maxNotionalUsd?: number;
};

export type PositionSizingResult = {
  qty: number;
  notionalUsd: number;
  riskUsd: number;
  riskPct: number;
  stopDistance: number;
  rawQty: number;
  rawNotionalUsd: number;
  qualityMultiplier: number;
};

export class PositionSizer {
  constructor(private readonly baseRiskPerTradePct: number) {}

  computeSize(params: PositionSizingParams): PositionSizingResult {
    const riskPct = params.riskPct && params.riskPct > 0 ? params.riskPct : this.baseRiskPerTradePct;
    const stopDistance = params.stopDistanceAbs != null && params.stopDistanceAbs > 0
      ? params.stopDistanceAbs
      : Math.abs(params.entryPrice - (params.stopPrice ?? 0));
    const qualityMultiplier = params.qualityMultiplier != null && params.qualityMultiplier > 0
      ? params.qualityMultiplier
      : 1;
    if (!(stopDistance > 0) || !(params.entryPrice > 0) || !(params.equityUsd > 0)) {
      return {
        qty: 0,
        notionalUsd: 0,
        riskUsd: 0,
        riskPct,
        stopDistance,
        rawQty: 0,
        rawNotionalUsd: 0,
        qualityMultiplier,
      };
    }
    const riskUsd = params.equityUsd * (riskPct / 100) * qualityMultiplier;
    const rawQty = riskUsd / stopDistance;
    const rawNotionalUsd = rawQty * params.entryPrice;
    const cappedNotional = params.maxNotionalUsd && params.maxNotionalUsd > 0
      ? Math.min(rawNotionalUsd, params.maxNotionalUsd)
      : rawNotionalUsd;
    const adjustedQty = params.entryPrice > 0 ? cappedNotional / params.entryPrice : 0;
    return {
      qty: Math.max(0, adjustedQty),
      notionalUsd: Math.max(0, cappedNotional),
      riskUsd: Math.max(0, riskUsd),
      riskPct,
      stopDistance,
      rawQty: Math.max(0, rawQty),
      rawNotionalUsd: Math.max(0, rawNotionalUsd),
      qualityMultiplier,
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
