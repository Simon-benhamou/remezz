import { Router } from "express";
import { getConfig } from "../utils/env.js";
import { exchange, resolveSymbol } from "../exchange/ccxtClient.js";
import { computeCoreIndicators } from "../data/market.js";
import { prisma } from "../db/client.js";
import { buildTechSnapshot } from "../ai/tech.js";

export const router = Router();
router.get('/', async (req, res) => {
  const cfg = getConfig();
  const ex = await exchange();
  const sessionId = String(req.query.sessionId || '');
  const s = sessionId
    ? await prisma.agentSession.findUnique({ where: { id: sessionId } })
    : await prisma.agentSession.findFirst({ where:{ stoppedAt:null }, orderBy:{ startedAt:'desc' } });

  const symbol = s?.symbol || cfg.SYMBOL;
  const [balance, orders, indic] = await Promise.all([
    ex.fetchBalance().catch(()=>null),
    (async ()=>{ try { const s = await resolveSymbol(symbol); return await ex.fetchOpenOrders(s); } catch { return []; } })(),
    computeCoreIndicators(symbol).catch(()=>null),
  ]);

  let tech:any = null;
  try { tech = await buildTechSnapshot(symbol); } catch {}

  res.json({
    serverTime: new Date().toISOString(),
    exchangeId: ex.id,
    symbol,
    balance, orders, indicators: indic,
    session: s,
    sr: tech ? { support: tech.support, resistance: tech.resistance } : null,
    // champs riches pour le front:
    supports: tech?.supports || [],
    resistances: tech?.resistances || [],
    pivots: tech?.pivots || null,
  });
});
