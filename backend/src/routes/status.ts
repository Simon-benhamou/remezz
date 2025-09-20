import { Router } from "express";
import { getConfig } from "../utils/env.js";
import { getUserExchange, resolveSymbol } from "../exchange/ccxtClient.js";
import { computeCoreIndicators } from "../data/market.js";
import { prisma } from "../db/client.js";
import { buildTechSnapshot } from "../ai/tech.js";
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { getUserCredentials } from '../services/userCredentials.js';

export const router = Router();
router.get('/', authenticateUser, async (req: AuthenticatedRequest, res) => {
  const cfg = getConfig();
  
  // Get user credentials for authenticated exchange access
  let ex: any = null;
  try {
    const userCredentials = await getUserCredentials(req.user!.id);
    if (userCredentials) {
      ex = await getUserExchange(req.user!.id, userCredentials);
    }
  } catch (error) {
    console.error('Failed to get user exchange for status:', error);
  }
  
  const sessionId = String(req.query.sessionId || '');
  const s = sessionId
    ? await prisma.agentSession.findUnique({ where: { id: sessionId } })
    : await prisma.agentSession.findFirst({ where:{ stoppedAt:null }, orderBy:{ startedAt:'desc' } });

  const symbol = s?.symbol || cfg.SYMBOL;
  
  // Only fetch balance and orders if user has configured exchange
  const [balance, orders, indic] = await Promise.all([
    ex ? ex.fetchBalance().catch(()=>null) : null,
    ex ? (async ()=>{ try { const s = await resolveSymbol(symbol); return await ex.fetchOpenOrders(s); } catch { return []; } })() : [],
    computeCoreIndicators(symbol).catch(()=>null),
  ]);

  let tech:any = null;
  try { tech = await buildTechSnapshot(symbol); } catch {}

  res.json({
    serverTime: new Date().toISOString(),
    exchangeId: ex?.id || cfg.EXCHANGE_ID,
    symbol,
    balance, orders, 
    // Merge indicators with tech snapshot for complete data
    indicators: indic ? {
      ...indic,
      atrPct: tech?.atrPct ?? 0,  // Add missing atrPct
      adx14: tech?.adx14 ?? 0,    // Add missing adx
      ema20Slope: tech?.ema20Slope ?? 0, // Add missing slope
      price: tech?.last ?? 0,     // Add current price
    } : null,
    session: s,
    sr: tech ? { support: tech.support, resistance: tech.resistance } : null,
    // champs riches pour le front:
    supports: tech?.supports || [],
    resistances: tech?.resistances || [],
    pivots: tech?.pivots || null,
  });
});
