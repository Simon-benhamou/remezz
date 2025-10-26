import { prisma } from '../db/client.js';
import { getConfig, getModeParams, type AgentAggressiveness } from '../utils/env.js';
import { resolveLeverageCap, type ResolvedLeverageCap } from './leverageCaps.js';

export type RiskLimits = {
  riskPctPerTrade: { min: number; max: number };
  dailyLossLimitPct: number; // kill switch
  maxLeverage: number;
  maxTradesPerDay: number;
  maxConsecutiveStops: number;
};

export const defaultLimits = (aggressiveness: AgentAggressiveness = 'reactive'): RiskLimits => {
  const cfg = getConfig();
  const modeParams = getModeParams(aggressiveness);
  
  return {
    riskPctPerTrade: { 
      min: 0.5, 
      max: modeParams.riskPct 
    },
    dailyLossLimitPct: modeParams.dailyLossLimitPct,
    maxLeverage: 10,
    maxTradesPerDay: modeParams.maxTradesPerDay,
    maxConsecutiveStops: modeParams.maxConsecutiveStops,
  };
};

export type RiskDecision = {
  ok: boolean;
  reason?: string;
  action?: 'halt'|'cooldown'|'warn';
};

export type SizingInput = {
  balanceUsd: number;
  riskPct: number; // 0.5..5
  stopDistanceAbs: number;
  entryPrice: number;
  requestedLeverage: number;
  symbol: string;
  mode?: 'paper' | 'live';
  leverageCap?: ResolvedLeverageCap;
  tp1DistanceAbs?: number | null;
  minTp1PnlUsd?: number;
  tp1RMultiple?: number | null;
};

export type SizingResult = {
  notional: number;
  leverageCap: ResolvedLeverageCap;
  desiredNotional: number;
  minPnLNotional?: number | null;
  meetsMinPnLTarget: boolean;
};

export async function computeQtyNotional({
  balanceUsd,
  riskPct,
  stopDistanceAbs,
  entryPrice,
  requestedLeverage,
  symbol,
  mode,
  leverageCap: inputCap,
  tp1DistanceAbs,
  minTp1PnlUsd,
  tp1RMultiple,
}: SizingInput): Promise<SizingResult> {
  const leverageCap = inputCap ?? await resolveLeverageCap({ symbol, requestedMaxLeverage: requestedLeverage, mode });
  const riskDollar = balanceUsd * (riskPct/100);
  const stopPct = entryPrice > 0 ? (stopDistanceAbs/entryPrice)*100 : 0;
  const notionalByRisk = stopPct > 0 ? (riskDollar / (stopPct/100)) : 0;
  const effectiveTp1Distance = (() => {
    if (tp1DistanceAbs != null && tp1DistanceAbs > 0) return tp1DistanceAbs;
    if (stopDistanceAbs > 0 && tp1RMultiple != null && Number.isFinite(tp1RMultiple) && tp1RMultiple > 0) {
      return stopDistanceAbs * tp1RMultiple;
    }
    if (stopDistanceAbs > 0) {
      // Fall back to assuming at least a 1R move when no explicit TP is provided.
      return stopDistanceAbs;
    }
    return 0;
  })();
  const tp1Pct = entryPrice > 0 && effectiveTp1Distance > 0
    ? (effectiveTp1Distance / entryPrice) * 100
    : 0;
  const minTargetUsd = Number.isFinite(minTp1PnlUsd) && (minTp1PnlUsd as number) > 0 ? Number(minTp1PnlUsd) : 0;
  const notionalByPnL = tp1Pct > 0 && minTargetUsd > 0 ? (minTargetUsd / (tp1Pct / 100)) : 0;
  const desiredNotional = Math.max(notionalByRisk, notionalByPnL);
  const maxNotional = balanceUsd * leverageCap.resolved;
  const clamped = Math.max(0, Math.min(desiredNotional, maxNotional));
  const minPnLNotional = notionalByPnL > 0 ? notionalByPnL : null;
  const meetsMinPnLTarget = !(minPnLNotional && minPnLNotional > 0) || clamped + 1e-6 >= (minPnLNotional as number);
  return { notional: clamped, leverageCap, desiredNotional, minPnLNotional, meetsMinPnLTarget };
}
