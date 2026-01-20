import { Router } from "express";
import { prisma } from "../db/client.js";
import { getSessionPerformanceMetrics } from "../services/performance.js";
import { computeAdaptiveRisk } from "../risk/adaptive.js";
import type { AdaptiveRiskResult } from "../risk/adaptive.js";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.js";

export const router = Router();

// Basic KPIs row (existing)
router.get("/", authenticateUser, async (req: AuthenticatedRequest, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  
  // Security: verify session belongs to user
  if (req.user?.id) {
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (session && session.userId !== req.user.id && req.user.role !== 'admin' && !req.user.isLegacy) {
      return res.status(403).json({ error: 'session_forbidden' });
    }
  }
  
  res.json(await prisma.sessionKpi.findUnique({ where: { sessionId } }));
});

// Rich breakdown by position direction (long/short) and by symbol
router.get("/breakdown", authenticateUser, async (req: AuthenticatedRequest, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  // Security: verify session belongs to user
  const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!session) return res.status(404).json({ error: "session not found" });
  if (req.user?.id && session.userId !== req.user.id && req.user.role !== 'admin' && !req.user.isLegacy) {
    return res.status(403).json({ error: 'session_forbidden' });
  }
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

// V5.72: Normalize exit reason for display
function normalizeExitReasonForDisplay(reason: string | null): string {
  if (!reason) return 'N/A';
  const r = reason.toUpperCase();
  if (r.includes('TRAIL')) return 'TRAILING';
  if (r.includes('STOP') || r === 'SL') return 'STOP_LOSS';
  if (r.includes('STAGNANT')) return 'STAGNANT';
  if (r.includes('TIME') || r.includes('MAX_HOLD')) return 'TIMEOUT';
  if (r.includes('REGIME')) return 'REGIME_CHANGE';
  if (r.includes('MOMENTUM') || r.includes('REVERSAL')) return 'MOMENTUM_REVERSAL';
  return reason.toUpperCase();
}

// V5.72: Get parity verification summary for a session
router.get("/parity", authenticateUser, async (req: AuthenticatedRequest, res) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  // Security: verify session belongs to user
  const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!session) return res.status(404).json({ error: "session not found" });
  if (req.user?.id && session.userId !== req.user.id && req.user.role !== 'admin' && !req.user.isLegacy) {
    return res.status(403).json({ error: 'session_forbidden' });
  }

  try {
    // Get all trades for this session
    const trades = await prisma.trade.findMany({
      where: { sessionId },
      select: { id: true },
    });
    const tradeIds = trades.map(t => t.id);

    if (tradeIds.length === 0) {
      return res.json({
        totalTrades: 0,
        verifiedTrades: 0,
        matchedTrades: 0,
        matchRate: 100,
        mismatches: [],
        status: 'healthy',
      });
    }

    // Get parity results for these trades
    const parityResults = await prisma.tradeParityResult.findMany({
      where: { tradeId: { in: tradeIds } },
      orderBy: { verifiedAt: 'desc' },
    });

    const verifiedTrades = parityResults.length;
    const matchedTrades = parityResults.filter(r => r.overallMatch).length;
    const matchRate = verifiedTrades > 0 ? (matchedTrades / verifiedTrades) * 100 : 100;

    // Get mismatch details with normalized exit reasons
    const mismatches = parityResults
      .filter(r => !r.overallMatch)
      .slice(0, 10)
      .map(r => {
        const normalizedLive = normalizeExitReasonForDisplay(r.liveExitReason);
        const normalizedBt = normalizeExitReasonForDisplay(r.btExitReason);
        return {
          tradeId: r.tradeId,
          symbol: r.symbol,
          side: r.side,
          liveExitReason: normalizedLive,
          btExitReason: normalizedBt,
          // If normalized reasons match, this is actually a match (naming difference only)
          isActualMismatch: normalizedLive !== normalizedBt,
          livePnlPct: r.livePnlPct,
          btPnlPct: r.btPnlPct,
          pnlDiff: r.btPnlPct != null ? r.livePnlPct - r.btPnlPct : null,
          details: r.mismatchDetails,
        };
      })
      // Filter out false mismatches where only naming differs
      .filter(m => m.isActualMismatch);

    // Determine status based on match rate
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (matchRate < 70) {
      status = 'critical';
    } else if (matchRate < 90) {
      status = 'warning';
    }

    res.json({
      totalTrades: tradeIds.length,
      verifiedTrades,
      matchedTrades,
      matchRate,
      mismatches,
      status,
    });
  } catch (error) {
    console.error("Failed to get parity results:", error);
    res.status(500).json({ error: "failed_to_get_parity" });
  }
});

router.get("/session-metrics", authenticateUser, async (req: AuthenticatedRequest, res) => {
  const rawIds = (req.query.sessionId ?? (req.query["sessionId[]"] as any)) as
    | string
    | string[]
    | undefined;
  const requested = Array.isArray(rawIds)
    ? rawIds
        .map((id) => String(id).trim())
        .filter((id) => id.length > 0)
    : typeof rawIds === "string"
    ? String(rawIds)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : [];
  if (!requested.length) {
    return res.status(400).json({ error: "sessionId(s) required" });
  }

  // Security: filter to only user's sessions
  if (req.user?.id && req.user.role !== 'admin' && !req.user.isLegacy) {
    const userSessions = await prisma.agentSession.findMany({
      where: { userId: req.user.id, id: { in: requested } },
      select: { id: true },
    });
    const allowedIds = new Set(userSessions.map(s => s.id));
    const filtered = requested.filter(id => allowedIds.has(id));
    if (filtered.length === 0) {
      return res.status(403).json({ error: 'no_authorized_sessions' });
    }
    const metrics = await getSessionPerformanceMetrics(filtered);
    return res.json({ metrics });
  }

  // Admin/legacy users: return all requested sessions
  try {
    const metrics = await getSessionPerformanceMetrics(requested);
    res.json({ metrics });
  } catch (error) {
    console.error("Failed to load session metrics", error);
    res.status(500).json({ error: "failed_to_compute_metrics" });
  }
});
