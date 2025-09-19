import { prisma } from '../db/client.js';
import { getConfig } from '../utils/env.js';

export type RiskContext = {
  sessionId: string;
  dateKey: string; // YYYY-MM-DD
  realizedPnlPctToday: number; // percent of start balance
  consecutiveStops: number;
  tradesToday: number;
};

export type RiskLimits = {
  riskPctPerTrade: { min: number; max: number };
  dailyLossLimitPct: number; // kill switch
  maxLeverage: number;
  maxTradesPerDay: number;
  maxConsecutiveStops: number;
};

export const defaultLimits = (): RiskLimits => ({
  riskPctPerTrade: { min: 0.5, max: 5 },
  dailyLossLimitPct: Math.min(5, Math.max(1, getConfig().DAILY_LOSS_LIMIT_PCT)),
  maxLeverage: 10,
  maxTradesPerDay: 8, // Increased from 3 to allow more quality setups
  maxConsecutiveStops: 2, // Reduced from 3 to be more protective
});

export type RiskDecision = {
  ok: boolean;
  reason?: string;
  action?: 'halt'|'cooldown'|'warn';
};

export async function assessRisk(ctx: RiskContext, limits = defaultLimits()): Promise<RiskDecision> {
  if (ctx.realizedPnlPctToday <= -limits.dailyLossLimitPct) return { ok: false, reason: 'daily_loss_limit', action: 'halt' };
  if (ctx.tradesToday >= limits.maxTradesPerDay) return { ok: false, reason: 'trades_cap', action: 'cooldown' };
  if (ctx.consecutiveStops >= limits.maxConsecutiveStops) return { ok: false, reason: 'consecutive_stops', action: 'cooldown' };
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
