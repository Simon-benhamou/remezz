import { Router } from "express";
import { prisma } from "../db/client.js";
import { listAggregatedTrades } from "../services/performance/tradeLedger.js";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth.js";
export const router = Router();
router.get("/", authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const sessionId = String(req.query.sessionId || "");
  let where: any = {};
  let sess: any = null;
  
  if (sessionId) {
    where.sessionId = sessionId;
    sess = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    // Security: verify session belongs to user
    if (sess && sess.userId !== req.user.id && req.user.role !== 'admin' && !req.user.isLegacy) {
      return res.status(403).json({ error: 'session_forbidden' });
    }
  } else {
    // Return orders from user's active sessions only
    const sessionWhere: any = { stoppedAt: null };
    if (req.user.role !== 'admin' && !req.user.isLegacy) {
      sessionWhere.userId = req.user.id;
    }
    const activeSessions = await prisma.agentSession.findMany({ 
      where: sessionWhere, 
      select: { id: true } 
    });
    if (activeSessions.length > 0) {
      where.sessionId = { in: activeSessions.map(s => s.id) };
    }
  }
  
  const rows = await prisma.order.findMany({ 
    where, 
    orderBy: { createdAt: 'desc' }, 
    take: 200, 
    include: { fills: true, session: true } 
  });
  
  const out = rows.map((o:any)=>{
    // Use per-order session data for accurate calculations
    const orderSession = o.session || sess;
    const budgetPct = Number((orderSession?.profileJson?.budgetPct) ?? 100);
    const equity = Number(orderSession?.startBalanceUsd || 0);
    const equityAlloc = equity * (budgetPct > 1 ? (budgetPct/100) : (budgetPct||1));
    
    // 🔧 FIX: Robust exit detection using multiple signals instead of clientOrderId suffix
    // An exit order has pctChange (price movement) or non-zero realizedPnl in fills
    const realizedNet = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.realizedPnl || 0), 0) : 0;
    const hasPctChange = o.pctChange != null && o.pctChange !== 0;
    const hasRealizedPnl = realizedNet !== 0;
    const hasExitSuffix = (o.clientOrderId || '').endsWith('.exit');
    const isExit = hasPctChange || hasRealizedPnl || hasExitSuffix;
    
    // For exits: positionSide matches the ORIGINAL position (LONG exit = positionSide 'long')
    // For entries: positionSide matches the side (buy = 'long', sell = 'short')
    const positionSide = isExit
      ? (o.side === 'buy' ? 'short' : 'long')  // Buy to close SHORT, Sell to close LONG
      : (o.side === 'buy' ? 'long' : 'short'); // Buy opens LONG, Sell opens SHORT
    
    const feesUsd = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.fee || 0), 0) : 0;
    const realizedPnlUsd = realizedNet;
    const roePct = isExit && o.leverage && o.pctChange != null ? Number(o.pctChange) * Number(o.leverage) : null;
    const notional = (Number(o.qty||0) * Number(o.price||0));
    // Use stored leverage from order if available, otherwise estimate from notional/equity
    const lev = Number(o.leverage || 0) || null;
    const estLev = lev ?? (equityAlloc > 0 ? (notional / equityAlloc) : null);
    // Notional cap = allocated equity * configured leverage for the order
    const notionalCapUsd = (equityAlloc > 0 && lev) ? (equityAlloc * lev) : null;
    const { fills, session, ...rest } = o;
    // Add 'amount' field as alias for qty for frontend compatibility
    return { ...rest, amount: o.qty, positionSide, realizedPnlUsd, feesUsd, roePct, estLev, notionalCapUsd };
  });
  res.json(out);
});

// Aggregated trades: read directly from Trade table (persisted on every exit)
router.get('/trades', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const sessionId = String(req.query.sessionId || "").trim();
  const modeRaw = String(req.query.mode || "").trim();
  const mode = modeRaw === 'paper' || modeRaw === 'live' ? (modeRaw as 'paper' | 'live') : null;
  const limitRaw = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, Math.floor(limitRaw))) : 200;
  const fromStr = String(req.query.from || '').trim();
  const toStr = String(req.query.to || '').trim();

  const from = fromStr ? new Date(fromStr) : null;
  const to = toStr ? new Date(toStr) : null;

  // Security: verify session belongs to user if sessionId is provided
  if (sessionId) {
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (session && session.userId !== req.user.id && req.user.role !== 'admin' && !req.user.isLegacy) {
      return res.status(403).json({ error: 'session_forbidden' });
    }
  }

  // Build where clause for Trade query
  const where: any = {};
  
  if (sessionId) {
    where.sessionId = sessionId;
  } else if (req.user.role !== 'admin' && !req.user.isLegacy) {
    // Non-admin users: only show their trades (optionally filtered by mode)
    where.session = { userId: req.user.id, ...(mode ? { mode } : {}) };
  } else if (mode) {
    // Admin/legacy: allow optional mode filter when no sessionId is provided
    where.session = { ...(mode ? { mode } : {}) };
  }

  if (from || to) {
    where.exitTs = {};
    if (from && !Number.isNaN(from.getTime())) where.exitTs.gte = from;
    if (to && !Number.isNaN(to.getTime())) where.exitTs.lt = to;
  }

  const [trades, session] = await Promise.all([
    prisma.trade.findMany({
      where,
      orderBy: { exitTs: 'desc' },
      take: limit,
    }),
    sessionId ? prisma.agentSession.findUnique({ where: { id: sessionId } }) : null,
  ]);

  const budgetPct = Number(((session as any)?.profileJson?.budgetPct) ?? 100);
  const equity = Number((session as any)?.startBalanceUsd || 0);
  const equityAlloc = equity * (budgetPct > 1 ? budgetPct / 100 : budgetPct || 1);

  const out = trades.map((trade) => {
    const notional = trade.entryNotional ?? (trade.entryPrice != null ? trade.entryPrice * trade.qty : null);
    const leverage = trade.leverage ?? null;
    // Use stored leverage if available, otherwise estimate from notional/equity
    const estLev = leverage ?? (equityAlloc > 0 && notional != null ? notional / equityAlloc : null);
    const roePct = leverage != null && trade.roiPct != null ? trade.roiPct * leverage : trade.roePct ?? null;
    return {
      id: trade.id,
      createdAt: trade.exitTs, // exitTs is when trade completed
      symbol: trade.symbol,
      positionSide: trade.positionSide,
      qty: trade.qty,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      pctChange: trade.roiPct ?? trade.pctChange,
      roePct,
      leverage,
      estLev,
      realizedPnlUsd: trade.realizedPnlUsd,
      feesUsd: trade.feesUsd,
      status: 'filled',
      orderCount: trade.orderCount,
      // V5.11: New fields for detailed trade analysis
      notionalUsd: notional,
      exitReason: trade.exitReason,
      durationMinutes: trade.durationMinutes,
      maxPnlPct: trade.maxPnlPct,
    };
  });

  res.json(out);
});
