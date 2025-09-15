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
  const rows = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { fills: true } });
  const out = rows.map((o:any)=>{
    const isExit = (o.clientOrderId || '').endsWith('.exit');
    const positionSide = isExit
      ? (o.side === 'buy' ? 'short' : 'long')
      : (o.side === 'buy' ? 'long' : 'short');
    const realizedPnlUsd = Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.realizedPnl || 0), 0) : 0;
    const roePct = isExit && o.leverage && o.pctChange != null ? Number(o.pctChange) * Number(o.leverage) : null;
    const { fills, ...rest } = o;
    return { ...rest, positionSide, realizedPnlUsd, roePct };
  });
  res.json(out);
});

// Aggregated trades: one row per exit (partial or full), with reconstructed entry price from realized PnL
router.get('/trades', async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  let where: any = { clientOrderId: { endsWith: '.exit' } };
  if (sessionId) where.sessionId = sessionId;
  const rows = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { fills: true } });
  function posDirFromExitSide(side: string) { return side === 'buy' ? 'short' : 'long'; }
  const out = rows.map((o:any)=>{
    const positionSide = posDirFromExitSide(o.side || '');
    const dir = positionSide === 'long' ? 1 : -1;
    const qty = Number(o.qty || 0);
    const exitPrice = Number(o.price || 0);
    const realized = (Array.isArray(o.fills) ? o.fills.reduce((s:number,f:any)=> s + Number(f?.realizedPnl || 0), 0) : 0);
    const entryPrice = (qty>0 && exitPrice>0) ? (exitPrice - (realized / (dir * qty))) : null;
    const roePct = (o.pctChange != null && o.leverage) ? (Number(o.pctChange) * Number(o.leverage)) : null;
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
      leverage: o.leverage,
      realizedPnlUsd: realized,
      status: o.status,
    };
  });
  res.json(out);
});
