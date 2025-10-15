import { Router } from "express";
import { prisma } from "../db/client.js";
export const router = Router();
router.get("/", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  let where: any = {};
  if (sessionId) where.sessionId = sessionId;
  else {
    const s = await prisma.agentSession.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
    if (s?.id) where.sessionId = s.id;
  }
  const [rows, sess] = await Promise.all([
    prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { fills: true } }),
    sessionId ? prisma.agentSession.findUnique({ where: { id: sessionId } }) : null,
  ]);
  const budgetPct = Number(((sess as any)?.profileJson?.budgetPct) ?? 100);
  const equity = Number((sess as any)?.startBalanceUsd || 0);
  const equityAlloc = equity * (budgetPct > 1 ? (budgetPct/100) : (budgetPct||1));
  const out = rows.map((o:any)=>{
    const isExit = (o.clientOrderId || '').endsWith('.exit');
    const positionSide = isExit
      ? (o.side === 'buy' ? 'short' : 'long')
      : (o.side === 'buy' ? 'long' : 'short');
    const realizedGross = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.realizedPnl || 0), 0) : 0;
    const feesUsd = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.fee || 0), 0) : 0;
    const realizedPnlUsd = realizedGross - feesUsd;
    const roePct = isExit && o.leverage && o.pctChange != null ? Number(o.pctChange) * Number(o.leverage) : null;
    const notional = (Number(o.qty||0) * Number(o.price||0));
    const estLev = equityAlloc > 0 ? (notional / equityAlloc) : null;
    // Notional cap = allocated equity * configured leverage for the order
    const lev = Number(o.leverage || 0) || null;
    const notionalCapUsd = (equityAlloc > 0 && lev) ? (equityAlloc * lev) : null;
    const { fills, ...rest } = o;
    return { ...rest, positionSide, realizedPnlUsd, feesUsd, roePct, estLev, notionalCapUsd };
  });
  res.json(out);
});

// Aggregated trades: one row per exit (partial or full), with reconstructed entry price from realized PnL
router.get('/trades', async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const limitRaw = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 200;
  const fromStr = String(req.query.from || '').trim();
  const toStr = String(req.query.to || '').trim();
  const createdAt: any = {};
  if (fromStr) {
    const from = new Date(fromStr);
    if (!Number.isNaN(from.getTime())) createdAt.gte = from;
  }
  if (toStr) {
    const to = new Date(toStr);
    if (!Number.isNaN(to.getTime())) createdAt.lt = to;
  }

  const where: any = { clientOrderId: { endsWith: '.exit' } };
  if (sessionId) where.sessionId = sessionId;
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

  const [rows, sess] = await Promise.all([
    prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { fills: true } }),
    sessionId ? prisma.agentSession.findUnique({ where: { id: sessionId } }) : null,
  ]);
  const budgetPct = Number(((sess as any)?.profileJson?.budgetPct) ?? 100);
  const equity = Number((sess as any)?.startBalanceUsd || 0);
  const equityAlloc = equity * (budgetPct > 1 ? (budgetPct/100) : (budgetPct||1));
  function posDirFromExitSide(side: string) { return side === 'buy' ? 'short' : 'long'; }
  const out = rows.map((o:any)=>{
    const positionSide = posDirFromExitSide(o.side || '');
    const dir = positionSide === 'long' ? 1 : -1;
    const qty = Number(o.qty || 0);
    const exitPrice = Number(o.price || 0);
    const realizedGross = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.realizedPnl || 0), 0) : 0;
    const feesUsd = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.fee || 0), 0) : 0;
    const realized = realizedGross - feesUsd;
    const entryPrice = (qty>0 && exitPrice>0) ? (exitPrice - (realized / (dir * qty))) : null;
    const roePct = (o.pctChange != null && o.leverage) ? (Number(o.pctChange) * Number(o.leverage)) : null;
    const notional = qty * exitPrice;
    const estLev = equityAlloc > 0 ? (notional / equityAlloc) : null;
    return {
      id: o.id,
      createdAt: o.createdAt,
      symbol: o.symbol,
      positionSide,
      qty,
      entryPrice,
      exitPrice,
      pctChange: o.pctChange,
      roePct,
      estLev,
      leverage: o.leverage,
      realizedPnlUsd: realized,
      feesUsd,
      status: o.status,
    };
  });
  res.json(out);
});
