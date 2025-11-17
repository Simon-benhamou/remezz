import { Router } from "express";
import { prisma } from "../db/client.js";
import { listAggregatedTrades } from "../services/performance/tradeLedger.js";
export const router = Router();
router.get("/", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  let where: any = {};
  let sess: any = null;
  
  if (sessionId) {
    where.sessionId = sessionId;
    sess = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  } else {
    // Return orders from ALL active sessions, not just the most recent one
    const activeSessions = await prisma.agentSession.findMany({ 
      where: { stoppedAt: null }, 
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
    
    const isExit = (o.clientOrderId || '').endsWith('.exit');
    const positionSide = isExit
      ? (o.side === 'buy' ? 'short' : 'long')
      : (o.side === 'buy' ? 'long' : 'short');
    const realizedNet = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.realizedPnl || 0), 0) : 0;
    const feesUsd = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.fee || 0), 0) : 0;
    const realizedPnlUsd = realizedNet;
    const roePct = isExit && o.leverage && o.pctChange != null ? Number(o.pctChange) * Number(o.leverage) : null;
    const notional = (Number(o.qty||0) * Number(o.price||0));
    const estLev = equityAlloc > 0 ? (notional / equityAlloc) : null;
    // Notional cap = allocated equity * configured leverage for the order
    const lev = Number(o.leverage || 0) || null;
    const notionalCapUsd = (equityAlloc > 0 && lev) ? (equityAlloc * lev) : null;
    const { fills, session, ...rest } = o;
    // Add 'amount' field as alias for qty for frontend compatibility
    return { ...rest, amount: o.qty, positionSide, realizedPnlUsd, feesUsd, roePct, estLev, notionalCapUsd };
  });
  res.json(out);
});

// Aggregated trades: one row per exit (partial or full), with reconstructed entry price from realized PnL
router.get('/trades', async (req, res) => {
  const sessionId = String(req.query.sessionId || "").trim();
  const limitRaw = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 200;
  const fromStr = String(req.query.from || '').trim();
  const toStr = String(req.query.to || '').trim();

  const from = fromStr ? new Date(fromStr) : null;
  const to = toStr ? new Date(toStr) : null;

  const [trades, session] = await Promise.all([
    listAggregatedTrades({
      sessionId,
      from: from && !Number.isNaN(from.getTime()) ? from : undefined,
      to: to && !Number.isNaN(to.getTime()) ? to : undefined,
      limit,
    }),
    sessionId ? prisma.agentSession.findUnique({ where: { id: sessionId } }) : null,
  ]);

  const budgetPct = Number(((session as any)?.profileJson?.budgetPct) ?? 100);
  const equity = Number((session as any)?.startBalanceUsd || 0);
  const equityAlloc = equity * (budgetPct > 1 ? budgetPct / 100 : budgetPct || 1);

  const out = trades.map((trade) => {
    const notional = trade.entryNotional ?? (trade.entryPrice != null ? trade.entryPrice * trade.qty : null);
    const estLev = equityAlloc > 0 && notional != null ? notional / equityAlloc : null;
    const leverage = trade.leverage ?? null;
    const roePct = leverage != null && trade.roiPct != null ? trade.roiPct * leverage : trade.roePct ?? null;
    return {
      id: trade.id,
      createdAt: trade.createdAt,
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
    };
  });

  res.json(out);
});
