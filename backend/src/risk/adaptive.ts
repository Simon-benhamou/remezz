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
  weightedSharpe: number;
  downsideDeviation: number;
  winRate: number;
  lossStreak: number;
  samplePenalty: number;
  notes: string[];
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
      weightedSharpe: 0,
      downsideDeviation: 0,
      winRate: 0,
      lossStreak: 0,
      samplePenalty: 1,
      notes: ['no_session'],
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
      weightedSharpe: 0,
      downsideDeviation: 0,
      winRate: 0,
      lossStreak: 0,
      samplePenalty: 1,
      notes: ['no_trade_history'],
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
      weightedSharpe: 0,
      downsideDeviation: 0,
      winRate: 0,
      lossStreak: 0,
      samplePenalty: 1,
      notes: ['no_valid_returns'],
    };
  }

  const boundedReturns = returns.map((r) => Math.max(-0.6, Math.min(0.6, r)));

  const sharpe = computeSharpe(boundedReturns);
  const maxDrawdownPct = computeDrawdown(boundedReturns);

  // Apply an EWMA to emphasise the last ~6 trades while retaining longer context.
  const halfLife = 6;
  const decay = Math.pow(0.5, 1 / Math.max(halfLife, 1));
  let weight = 1;
  let weightSum = 0;
  let weightedMean = 0;
  for (let i = boundedReturns.length - 1; i >= 0; i--) {
    const r = boundedReturns[i];
    weightedMean += r * weight;
    weightSum += weight;
    weight *= decay;
  }
  weightedMean = weightSum > 0 ? weightedMean / weightSum : 0;

  weight = 1;
  weightSum = 0;
  let weightedVar = 0;
  for (let i = boundedReturns.length - 1; i >= 0; i--) {
    const r = boundedReturns[i];
    const diff = r - weightedMean;
    weightedVar += weight * diff * diff;
    weightSum += weight;
    weight *= decay;
  }
  weightedVar = weightSum > 0 ? weightedVar / weightSum : 0;
  const weightedStdev = Math.sqrt(Math.max(weightedVar, 1e-12));
  const weightedSharpe = weightedStdev === 0 ? 0 : (weightedMean / weightedStdev) * Math.sqrt(boundedReturns.length);

  const downside = boundedReturns.filter((r) => r < 0);
  const downsideDeviation = downside.length
    ? Math.sqrt(downside.reduce((acc, r) => acc + r * r, 0) / downside.length)
    : 0;

  const wins = boundedReturns.filter((r) => r > 0).length;
  const winRate = wins / boundedReturns.length;

  let lossStreak = 0;
  let currentStreak = 0;
  for (const r of boundedReturns) {
    if (r < 0) {
      currentStreak += 1;
      lossStreak = Math.max(lossStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  const notes: string[] = [];

  const sampleSize = boundedReturns.length;
  let samplePenalty = 1;
  if (sampleSize < 5) {
    samplePenalty = 0.6;
    notes.push('low_sample_under_5');
  } else if (sampleSize < 8) {
    samplePenalty = 0.75;
    notes.push('low_sample_under_8');
  } else if (sampleSize < 12) {
    samplePenalty = 0.9;
    notes.push('light_sample_penalty');
  }

  const nearFlatPerformance = (
    Math.abs(weightedSharpe) < 0.3 &&
    Math.abs(weightedMean) < 0.003 &&
    winRate >= 0.45 &&
    winRate <= 0.55
  );


  let riskPct = baseRiskPct;
  const minRisk = Math.max(0.35, baseRiskPct * 0.35);
  const maxRisk = Math.min(2.2, baseRiskPct * 1.8);

  if (maxDrawdownPct <= -9) {
    riskPct = Math.max(minRisk, riskPct * 0.45);
    notes.push('severe_drawdown');
  } else if (maxDrawdownPct <= -6.5) {
    riskPct = Math.max(minRisk, riskPct * 0.6);
    notes.push('elevated_drawdown');
  }

  if (weightedSharpe < -0.15 && !nearFlatPerformance) {
    riskPct = Math.max(minRisk, riskPct * 0.55);
    notes.push('negative_weighted_sharpe');
  } else if (weightedSharpe < 0.25) {
    if (!nearFlatPerformance) {
      riskPct = Math.max(minRisk, riskPct * 0.75);
      notes.push('soft_weighted_sharpe');
    } else {
      notes.push('soft_weighted_sharpe_neutral_skip');
    }
  }

  if (downsideDeviation > 0.055) {
    riskPct = Math.max(minRisk, riskPct * 0.7);
    notes.push('high_downside_vol');
  }

  if (winRate < 0.42) {
    riskPct = Math.max(minRisk, riskPct * 0.65);
    notes.push('low_win_rate');
  }

  if (lossStreak >= 4) {
    riskPct = Math.max(minRisk, riskPct * 0.5);
    notes.push('loss_streak_4_plus');
  } else if (lossStreak === 3) {
    riskPct = Math.max(minRisk, riskPct * 0.7);
    notes.push('loss_streak_3');
  }

  if (nearFlatPerformance && samplePenalty < 1 && sampleSize >= 8) {
    samplePenalty = 1;
    notes.push('neutral_sample_no_penalty');
  }

  riskPct = Math.max(minRisk, riskPct * samplePenalty);

  if (
    weightedSharpe > 1.6 &&
    winRate > 0.6 &&
    maxDrawdownPct > -2.5 &&
    downsideDeviation < 0.035 &&
    sampleSize >= 12
  ) {
    riskPct = Math.min(maxRisk, riskPct * 1.35);
    notes.push('strong_performance_boost');
  } else if (
    weightedSharpe > 1.1 &&
    winRate > 0.55 &&
    maxDrawdownPct > -3.5 &&
    downsideDeviation < 0.045 &&
    sampleSize >= 10
  ) {
    riskPct = Math.min(maxRisk, riskPct * 1.15);
    notes.push('moderate_performance_boost');
  } else if (
    weightedSharpe > 0.8 &&
    winRate > 0.52 &&
    maxDrawdownPct > -4 &&
    downsideDeviation < 0.05 &&
    sampleSize >= 8
  ) {
    riskPct = Math.min(maxRisk, riskPct * 1.05);
    notes.push('conservative_performance_boost');
  }

  const symbolReturns: Record<string, number[]> = {};
  exits.forEach((order) => {
    const symbol = order.symbol;
    if (!symbol) return;
    const r = tradeReturn(order);
    if (Number.isFinite(r) && Math.abs(r) < 5) {
      const bounded = Math.max(-0.6, Math.min(0.6, r));
      (symbolReturns[symbol] ||= []).push(bounded);
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
    notes.push('symbol_bias_boost');
  }

  // Round to two decimals within the computed band
  riskPct = Math.max(minRisk, Math.min(maxRisk, Math.round(riskPct * 100) / 100));

  return {
    riskPct,
    sharpe,
    maxDrawdownPct,
    sampleSize: returns.length,
    baseRiskPct,
    symbolMultipliers,
    dominantSymbol,
    appliedSymbolMultiplier: dominantMultiplier,
    weightedSharpe,
    downsideDeviation,
    winRate,
    lossStreak,
    samplePenalty,
    notes,
  };
}
