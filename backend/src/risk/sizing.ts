const EPSILON = 1e-9;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function smooth(previous: number, next: number, alpha: number): number {
  if (!Number.isFinite(previous)) return next;
  return previous + alpha * (next - previous);
}

export function sizeUsd(balanceUsd: number, riskPct: number, stopPct: number) {
  const riskDollar = balanceUsd * (riskPct / 100);
  return stopPct > 0 ? riskDollar / (stopPct / 100) : 0;
}

export type DynamicLeveragePlaybook = 'trend_following' | 'mean_reversion';

export type DynamicLeverageInput = {
  entry: number;
  stop: number;
  tp1?: number | null;
  ATRpct_LTF: number;
  ATRpct_HTF?: number | null;
  ADX: number;
  RSI?: number | null;
  spreadPct: number;
  volumeUsd24h: number;
  playbook: DynamicLeveragePlaybook;
  envelopeDownside24hPct: number;
  equity: number;
  freeBalance: number;
  maintenanceMargin: number;
  capPerTradeUsd: number;
  riskBudgetPct: number;
  LEVERAGE_MIN: number;
  LEVERAGE_MAX: number;
  prevLev?: number | null;
  kGap?: number;
  minFreeBalancePct?: number;
  maintenanceBufferPct?: number;
  volumeHighThresholdUsd?: number;
  volumeLowThresholdUsd?: number;
  spreadTightThresholdPct?: number;
  spreadLooseThresholdPct?: number;
  marginTightBufferPct?: number;
};

export type DynamicLeverageResult = {
  qty: number;
  targetLev: number;
  worstRiskPct: number;
  flags: {
    reduceOnly: boolean;
    marginWarning: boolean;
  };
  metrics: {
    notionalUsd: number;
    usedMarginUsd: number;
    maintenanceAfterUsd: number;
    freeBalanceAfterUsd: number;
    worstRiskUsd: number;
  };
};

type MarginState = {
  safe: boolean;
  marginWarning: boolean;
  notionalUsd: number;
  usedMarginUsd: number;
  maintenanceAfterUsd: number;
  freeBalanceAfterUsd: number;
  worstRiskUsd: number;
};

export function computeDynamicLeverageSizing(ctx: DynamicLeverageInput): DynamicLeverageResult {
  const entry = Math.max(0, Number(ctx.entry) || 0);
  const stop = Math.max(0, Number(ctx.stop) || 0);
  const atrLtf = Math.max(0, Number(ctx.ATRpct_LTF) || 0);
  const adx = Number(ctx.ADX) || 0;
  const spreadPct = Math.max(0, Number(ctx.spreadPct) || 0);
  const volumeUsd24h = Math.max(0, Number(ctx.volumeUsd24h) || 0);
  const envelopeDownside = Math.max(0, Number(ctx.envelopeDownside24hPct) || 0);
  const equity = Math.max(0, Number(ctx.equity) || 0);
  const freeBalance = Math.max(0, Number(ctx.freeBalance) || 0);
  const maintenanceMargin = Math.max(0, Number(ctx.maintenanceMargin) || 0);
  const capPerTradeUsd = Math.max(0, Number(ctx.capPerTradeUsd) || 0);
  const riskBudgetPct = Math.max(0, Number(ctx.riskBudgetPct) || 0);
  const leverageMin = Math.max(1, Number(ctx.LEVERAGE_MIN) || 1);
  const leverageMax = Math.max(leverageMin, Number(ctx.LEVERAGE_MAX) || leverageMin);
  const prevLev = ctx.prevLev == null ? null : Math.max(leverageMin, Math.min(leverageMax, Number(ctx.prevLev) || leverageMin));
  const rawKGap = ctx.kGap;
  const kGap = Number.isFinite(rawKGap) && (rawKGap as number) > 0 ? Number(rawKGap) : 1.75;
  const minFreeBalancePct = Math.max(0, Math.min(1, Number(ctx.minFreeBalancePct) || 0.2));
  const maintenanceBufferPct = Math.max(0, Number(ctx.maintenanceBufferPct) || 0.5);
  const volumeHighThresholdUsd = Math.max(0, Number(ctx.volumeHighThresholdUsd) || 5e8);
  const volumeLowThresholdUsd = Math.max(0, Number(ctx.volumeLowThresholdUsd) || 1.5e8);
  const spreadTightThresholdPct = Math.max(0, Number(ctx.spreadTightThresholdPct) || 0.0008);
  const spreadLooseThresholdPct = Math.max(spreadTightThresholdPct, Number(ctx.spreadLooseThresholdPct) || 0.0016);
  const marginTightBufferPct = Math.max(0, Number(ctx.marginTightBufferPct) || 0.15);

  const stopRiskPct = entry > EPSILON && stop > 0 ? Math.abs(entry - stop) / entry : 0;
  const gapRiskPct = kGap * atrLtf;
  const envRiskPct = clamp(envelopeDownside, 0, 0.25);
  const worstRiskPct = Math.max(stopRiskPct, gapRiskPct, envRiskPct, EPSILON);

  const riskBudgetRatio = worstRiskPct > EPSILON ? riskBudgetPct / worstRiskPct : leverageMin;
  let targetLev = clamp(riskBudgetRatio, leverageMin, leverageMax);

  const spreadTight = spreadPct <= spreadTightThresholdPct + EPSILON;
  const spreadLoose = spreadPct >= spreadLooseThresholdPct;
  const volumeHigh = volumeUsd24h >= volumeHighThresholdUsd;
  const volumeLow = volumeUsd24h > 0 && volumeUsd24h <= volumeLowThresholdUsd;

  if (ctx.playbook === 'trend_following' && adx >= 25 && spreadTight && volumeHigh) {
    targetLev = clamp(targetLev * 1.2, leverageMin, leverageMax);
  } else {
    const degrade = ctx.playbook === 'mean_reversion' || spreadLoose || volumeLow;
    if (degrade) {
      targetLev = clamp(targetLev * 0.8, leverageMin, leverageMax);
    }
  }

  const baseMaintenance = maintenanceMargin;

  const computeNotional = (lev: number) => {
    if (!(lev > 0) || !(entry > EPSILON)) return 0;
    const riskBound = worstRiskPct > EPSILON ? (equity * riskBudgetPct) / worstRiskPct : 0;
    const cappedByRisk = Math.max(0, riskBound);
    const cappedByTradeCap = capPerTradeUsd > 0 ? Math.min(cappedByRisk, capPerTradeUsd) : cappedByRisk;
    const cappedByLeverage = equity > 0 ? Math.min(cappedByTradeCap, equity * lev) : cappedByTradeCap;
    const cappedByFreeBalance = freeBalance > 0 ? Math.min(cappedByLeverage, freeBalance * lev) : cappedByLeverage;
    return Math.max(0, cappedByFreeBalance);
  };

  const evaluateMargin = (lev: number): MarginState => {
    const boundedLev = clamp(lev, leverageMin, leverageMax);
    const notionalUsd = computeNotional(boundedLev);
    const usedMarginUsd = boundedLev > EPSILON ? notionalUsd / boundedLev : 0;
    const maintenanceAfterUsd = baseMaintenance + usedMarginUsd * maintenanceBufferPct;
    const maintenanceIncrease = Math.max(0, maintenanceAfterUsd - baseMaintenance);
    const totalReserve = usedMarginUsd + maintenanceIncrease;
    const freeAfter = freeBalance - totalReserve;
    const minFreeRequired = equity * minFreeBalancePct;
    const safe = freeAfter >= minFreeRequired;
    const marginWarning = safe && freeAfter < minFreeRequired * (1 + marginTightBufferPct);
    const worstRiskUsd = notionalUsd * worstRiskPct;
    return {
      safe,
      marginWarning,
      notionalUsd,
      usedMarginUsd,
      maintenanceAfterUsd,
      freeBalanceAfterUsd: freeAfter,
      worstRiskUsd,
    };
  };

  let marginState = evaluateMargin(targetLev);
  let adjustedLev = targetLev;

  while (!marginState.safe && adjustedLev > leverageMin + EPSILON) {
    const nextLev = clamp(adjustedLev * 0.9, leverageMin, adjustedLev - EPSILON);
    if (Math.abs(nextLev - adjustedLev) < EPSILON) {
      adjustedLev = leverageMin;
    } else {
      adjustedLev = nextLev;
    }
    marginState = evaluateMargin(adjustedLev);
    if (adjustedLev <= leverageMin + EPSILON) break;
  }

  let finalLev = adjustedLev;
  if (prevLev != null) {
    const smoothed = clamp(smooth(prevLev, adjustedLev, 0.3), leverageMin, leverageMax);
    const smoothedState = evaluateMargin(smoothed);
    if (smoothedState.safe || adjustedLev === smoothed) {
      finalLev = smoothed;
      marginState = smoothedState;
    }
  }

  const reduceOnly = !marginState.safe;
  const marginWarning = marginState.safe ? marginState.marginWarning : true;

  const qty = entry > EPSILON ? marginState.notionalUsd / entry : 0;

  return {
    qty,
    targetLev: finalLev,
    worstRiskPct,
    flags: {
      reduceOnly,
      marginWarning,
    },
    metrics: {
      notionalUsd: marginState.notionalUsd,
      usedMarginUsd: marginState.usedMarginUsd,
      maintenanceAfterUsd: marginState.maintenanceAfterUsd,
      freeBalanceAfterUsd: marginState.freeBalanceAfterUsd,
      worstRiskUsd: marginState.worstRiskUsd,
    },
  };
}
