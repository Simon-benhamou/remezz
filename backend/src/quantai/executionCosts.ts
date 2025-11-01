const BPS_DIVISOR = 10_000;

export type LiquidityType = 'maker' | 'taker';

export type FeeModel = {
  makerFeeBps: number;
  takerFeeBps: number;
};

export type CostInputs = {
  price: number;
  qty: number;
  side: 'buy' | 'sell';
  liquidity: LiquidityType;
  fees: FeeModel;
  impactBpsPerMillion?: number;
  fundingAnnualPct?: number;
  holdMs?: number;
  latencyMs?: number;
  atr?: number;
  lastPrice?: number;
};

export type CostBreakdown = {
  feeUsd: number;
  impactUsd: number;
  fundingUsd: number;
  latencyUsd: number;
  totalUsd: number;
};

export function calculateFeeUsd(inputs: CostInputs): number {
  const feeBps = inputs.liquidity === 'maker' ? inputs.fees.makerFeeBps : inputs.fees.takerFeeBps;
  const notional = Math.abs(inputs.price * inputs.qty);
  return notional * (feeBps / BPS_DIVISOR);
}

export function calculateImpactUsd(inputs: CostInputs): number {
  const bps = inputs.impactBpsPerMillion ?? 0;
  if (!(bps > 0)) return 0;
  const notional = Math.abs(inputs.price * inputs.qty);
  const ratio = notional / 1_000_000;
  return notional * (bps / BPS_DIVISOR) * ratio;
}

export function calculateFundingUsd(inputs: CostInputs): number {
  const fundingAnnualPct = inputs.fundingAnnualPct ?? 0;
  const holdMs = inputs.holdMs ?? 0;
  if (!(fundingAnnualPct > 0) || !(holdMs > 0)) return 0;
  const ratePerMs = (fundingAnnualPct / 100) / (365 * 24 * 60 * 60 * 1000);
  const notional = Math.abs(inputs.price * inputs.qty);
  return notional * ratePerMs * holdMs;
}

export function calculateLatencyUsd(inputs: CostInputs): number {
  const latencyMs = inputs.latencyMs ?? 0;
  if (!(latencyMs > 0)) return 0;
  const atr = inputs.atr ?? 0;
  const reference = inputs.lastPrice ?? inputs.price;
  if (!(atr > 0) || !(reference > 0)) return 0;
  const atrPct = atr / reference;
  const driftPct = atrPct * (latencyMs / 60_000);
  const notional = Math.abs(inputs.price * inputs.qty);
  return notional * driftPct;
}

export function calculateExecutionCosts(inputs: CostInputs): CostBreakdown {
  const feeUsd = calculateFeeUsd(inputs);
  const impactUsd = calculateImpactUsd(inputs);
  const fundingUsd = calculateFundingUsd(inputs);
  const latencyUsd = calculateLatencyUsd(inputs);
  const totalUsd = feeUsd + impactUsd + fundingUsd + latencyUsd;
  return { feeUsd, impactUsd, fundingUsd, latencyUsd, totalUsd };
}
