import { prisma } from '../db/client.js';
import { getConfig, getModeParams, type AgentAggressiveness } from '../utils/env.js';

export type RiskContext = {
  sessionId: string;
  dateKey: string; // YYYY-MM-DD
  realizedPnlPctToday: number; // percent of start balance
  consecutiveStops: number;
  tradesToday: number;
  aggressiveness?: AgentAggressiveness; // Agent mode for adaptive limits
};

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

export async function assessRisk(ctx: RiskContext, limits?: RiskLimits): Promise<RiskDecision> {
  // Use mode-specific limits if not provided
  const effectiveLimits = limits || defaultLimits(ctx.aggressiveness);
  
  if (ctx.realizedPnlPctToday <= -effectiveLimits.dailyLossLimitPct) return { ok: false, reason: 'daily_loss_limit', action: 'halt' };
  if (ctx.tradesToday >= effectiveLimits.maxTradesPerDay) return { ok: false, reason: 'trades_cap', action: 'cooldown' };
  if (ctx.consecutiveStops >= effectiveLimits.maxConsecutiveStops) return { ok: false, reason: 'consecutive_stops', action: 'cooldown' };
  return { ok: true };
}

export type SizingInput = {
  balanceUsd: number;
  riskPct: number; // 0.5..5
  stopDistanceAbs: number;
  entryPrice: number;
  maxLev: number;
};

export function computeQtyNotional({ balanceUsd, riskPct, stopDistanceAbs, entryPrice, maxLev }: SizingInput) {
  const riskDollar = balanceUsd * (riskPct/100);
  const stopPct = (stopDistanceAbs/entryPrice)*100;
  const notional = stopPct > 0 ? (riskDollar / (stopPct/100)) : 0;
  const maxNotional = balanceUsd * maxLev;
  return Math.max(0, Math.min(notional, maxNotional));
}
