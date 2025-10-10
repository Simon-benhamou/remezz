import { Router } from "express";
import { prisma } from "../db/client.js";
import { computeAdaptiveRisk } from "../risk/adaptive.js";
import type { AdaptiveRiskResult } from "../risk/adaptive.js";

export const router = Router();

// Basic KPIs row (existing)
router.get("/", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(await prisma.sessionKpi.findUnique({ where: { sessionId } }));
});

// Rich breakdown by position direction (long/short) and by symbol
router.get("/breakdown", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  const profileJson: any = session?.profileJson && typeof session.profileJson === 'object' ? session.profileJson : {};
  const baseRiskPct = Number(profileJson?.riskPerTradePct ?? profileJson?.risk_per_trade_pct ?? 1) || 1;
  let adaptiveRisk: AdaptiveRiskResult | null = null;
  try {
    adaptiveRisk = await computeAdaptiveRisk(sessionId, baseRiskPct);
  } catch (err) {
    adaptiveRisk = null;
  }

  // Only exit orders carry pctChange/realized effects for a closed slice
  const exits = await prisma.order.findMany({
    where: { sessionId, status: 'filled', clientOrderId: { endsWith: '.exit' } },
    orderBy: { createdAt: 'asc' },
  });

  // Map: exit order side => original position direction
  function posDirFromExitSide(side: string) {
    return side === 'buy' ? 'short' : 'long';
  }

  type Stat = { n: number; wins: number; losses: number; avgWin: number; avgLoss: number; expectancy: number };
  const zero: Stat = { n: 0, wins: 0, losses: 0, avgWin: 0, avgLoss: 0, expectancy: 0 };
  function agg(stats: Stat, pct: number) {
    stats.n += 1;
    if (pct > 0) stats.wins += 1; else if (pct < 0) stats.losses += 1;
    return stats;
  }
  function finalize(stats: Stat, values: number[]): Stat {
    if (stats.n === 0) return { ...stats };
    const wins = values.filter(v => v > 0);
    const losses = values.filter(v => v < 0);
    stats.avgWin = wins.length ? wins.reduce((a,b)=>a+b,0)/wins.length : 0;
    stats.avgLoss = losses.length ? losses.reduce((a,b)=>a+b,0)/losses.length : 0;
    const winRate = stats.n ? (stats.wins / stats.n) : 0;
    const lossRate = 1 - winRate;
    stats.expectancy = winRate * stats.avgWin + lossRate * stats.avgLoss; // avgLoss is negative
    return stats;
  }

  // Overall and by side
  const valuesAll: number[] = [];
  const valuesLong: number[] = [];
  const valuesShort: number[] = [];
  let all: Stat = { ...zero };
  let longS: Stat = { ...zero };
  let shortS: Stat = { ...zero };

  // By symbol map
  const bySymbol: Record<string, Stat & { values: number[]; long: Stat & { values: number[] }; short: Stat & { values: number[] } }> = {};

  for (const o of exits) {
    const pct = Number(o.pctChange || 0);
    const dir = posDirFromExitSide(o.side || '');
    valuesAll.push(pct); all = agg(all, pct);
    if (dir === 'long') { valuesLong.push(pct); longS = agg(longS, pct); } else { valuesShort.push(pct); shortS = agg(shortS, pct); }
    const s = (bySymbol[o.symbol] ||= { ...zero, values: [], long: { ...zero, values: [] }, short: { ...zero, values: [] } });
    s.values.push(pct); agg(s, pct);
    if (dir === 'long') { s.long.values.push(pct); agg(s.long, pct); } else { s.short.values.push(pct); agg(s.short, pct); }
  }

  all = finalize(all, valuesAll);
  longS = finalize(longS, valuesLong);
  shortS = finalize(shortS, valuesShort);
  const bySymbolOut = Object.fromEntries(Object.entries(bySymbol).map(([k,v])=>{
    const out = { ...v } as any; delete out.values; out.long = finalize(v.long, v.long.values); delete out.long.values; out.short = finalize(v.short, v.short.values); delete out.short.values; return [k, finalize(out, v.values)];
  }));

  res.json({
    totals: all,
    bySide: { long: longS, short: shortS },
    bySymbol: bySymbolOut,
    sample: exits.length,
    adaptiveRisk,
  });
});
