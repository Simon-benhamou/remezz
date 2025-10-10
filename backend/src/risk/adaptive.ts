import { prisma } from '../db/client.js';

export type SymbolRiskAdjustment = {
  multiplier: number;
  sharpe: number;
  maxDrawdownPct: number;
  sampleSize: number;
  weight: number;
};

export type AdaptiveRiskResult = {
  riskPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  sampleSize: number;
  baseRiskPct: number;
  symbolMultipliers: Record<string, SymbolRiskAdjustment>;
  dominantSymbol: string | null;
  appliedSymbolMultiplier: number;
};

function computeSharpe(returns: number[]) {
  if (!returns.length) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + Math.pow(r - mean, 2), 0) / returns.length;
  const stdev = Math.sqrt(Math.max(variance, 1e-12));
  return stdev === 0 ? 0 : (mean / stdev) * Math.sqrt(returns.length);
}

function computeDrawdown(returns: number[]) {
  if (!returns.length) return 0;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of returns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak; // negative value
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

function tradeReturn(order: any): number {
  const fills = Array.isArray(order?.fills) ? order.fills : [];
  const realized = fills.reduce((sum: number, f: any) => sum + Number(f?.realizedPnl || 0), 0);
  const qty = Number(order?.qty || 0);
  const price = Number(order?.price || 0);
  const notional = Math.abs(qty * price);
  if (notional > 0 && realized !== 0) {
    return realized / notional;
  }
  const pct = Number(order?.pctChange || 0);
  if (pct !== 0) {
    const lev = Number(order?.leverage || 1) || 1;
    return (pct / 100) * lev;
  }
  return 0;
}

export async function computeAdaptiveRisk(sessionId: string | null | undefined, baseRiskPct: number): Promise<AdaptiveRiskResult> {
  if (!sessionId) {
    return {
      riskPct: baseRiskPct,
      sharpe: 0,
      maxDrawdownPct: 0,
      sampleSize: 0,
      baseRiskPct,
      symbolMultipliers: {},
      dominantSymbol: null,
      appliedSymbolMultiplier: 1,
    };
  }
  const exits = await prisma.order.findMany({
    where: { sessionId, clientOrderId: { endsWith: '.exit' } },
    include: { fills: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  if (!exits.length) {
    return {
      riskPct: baseRiskPct,
      sharpe: 0,
      maxDrawdownPct: 0,
      sampleSize: 0,
      baseRiskPct,
      symbolMultipliers: {},
      dominantSymbol: null,
      appliedSymbolMultiplier: 1,
    };
  }
  const returns = exits
    .map(tradeReturn)
    .filter((r) => Number.isFinite(r) && Math.abs(r) < 5);
  if (!returns.length) {
    return {
      riskPct: baseRiskPct,
      sharpe: 0,
      maxDrawdownPct: 0,
      sampleSize: 0,
      baseRiskPct,
      symbolMultipliers: {},
      dominantSymbol: null,
      appliedSymbolMultiplier: 1,
    };
  }

  const sharpe = computeSharpe(returns);
  const maxDrawdownPct = computeDrawdown(returns);

  let riskPct = baseRiskPct;
  const minRisk = Math.max(0.4, baseRiskPct * 0.4);
  const maxRisk = Math.min(2, baseRiskPct * 1.5);

  if (maxDrawdownPct <= -7 || sharpe < -0.5) {
    riskPct = Math.max(minRisk, baseRiskPct * 0.4);
  } else if (maxDrawdownPct <= -5 || sharpe < 0) {
    riskPct = Math.max(minRisk, baseRiskPct * 0.6);
  } else if (sharpe > 1.2 && maxDrawdownPct > -2) {
    riskPct = Math.min(maxRisk, baseRiskPct * 1.3);
  } else if (sharpe > 0.6 && maxDrawdownPct > -3) {
    riskPct = Math.min(maxRisk, baseRiskPct * 1.1);
  } else {
    riskPct = Math.max(minRisk, Math.min(maxRisk, baseRiskPct));
  }

  const symbolReturns: Record<string, number[]> = {};
  exits.forEach((order) => {
    const symbol = order.symbol;
    if (!symbol) return;
    const r = tradeReturn(order);
    if (Number.isFinite(r) && Math.abs(r) < 5) {
      (symbolReturns[symbol] ||= []).push(r);
    }
  });

  const symbolMultipliers: Record<string, SymbolRiskAdjustment> = {};
  let dominantSymbol: string | null = null;
  let dominantMultiplier = 1;
  const totalSample = returns.length;

  for (const [symbol, symbolRets] of Object.entries(symbolReturns)) {
    if (!symbolRets.length) continue;
    const symbolSharpe = computeSharpe(symbolRets);
    const symbolDd = computeDrawdown(symbolRets);
    const sampleSize = symbolRets.length;
    const weight = totalSample > 0 ? sampleSize / totalSample : 0;
    let multiplier = 1;

    if (sampleSize >= 6 && weight >= 0.25 && symbolSharpe > 1.4 && symbolDd > -1.5) {
      multiplier = 1.25;
    } else if (sampleSize >= 5 && weight >= 0.2 && symbolSharpe > 1.15 && symbolDd > -2.5) {
      multiplier = 1.15;
    } else if (sampleSize >= 3 && symbolSharpe > 0.8 && symbolDd > -3) {
      multiplier = 1.1;
    }

    symbolMultipliers[symbol] = {
      multiplier,
      sharpe: symbolSharpe,
      maxDrawdownPct: symbolDd,
      sampleSize,
      weight,
    };

    if (multiplier > dominantMultiplier) {
      dominantMultiplier = multiplier;
      dominantSymbol = symbol;
    }
  }

  if (dominantMultiplier > 1 && riskPct >= baseRiskPct) {
    const allowedBoost = Math.min(dominantMultiplier, maxRisk / Math.max(riskPct, 1e-9));
    riskPct = Math.min(maxRisk, riskPct * allowedBoost);
  }

  // Round to two decimals
  riskPct = Math.max(0.4, Math.min(2, Math.round(riskPct * 100) / 100));

  return {
    riskPct,
    sharpe,
    maxDrawdownPct,
    sampleSize: returns.length,
    baseRiskPct,
    symbolMultipliers,
    dominantSymbol,
    appliedSymbolMultiplier: dominantMultiplier,
  };
}
