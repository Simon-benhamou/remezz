import { Router } from 'express';
import { startSession, stopSession, activeSession } from '../session/session.js';
import { prisma } from '../db/client.js';
import { generateStrategy, selectBestPerp } from '../ai/orchestrator.js';
import { broadcast } from '../ws/hub.js';
import { levels as calcLevels } from '../risk/brackets.js';
import { buildTechSnapshot } from '../ai/tech.js';

export const router = Router();

router.get('/session', async (_req,res)=> res.json(await activeSession()));

router.post('/start', async (req,res)=>{
  const {  mode, startBalanceUsd } = req.body as {symbol:string, mode:'paper'|'live', startBalanceUsd?:number};
  const body = req.body as { symbol?: string, mode:'paper'|'live', startBalanceUsd?:number, perps?: string[] };
  let symbol = body.symbol as string;

  // Ranking UNIQUEMENT si pas de symbole fourni
  if (!symbol && process.env.RANK_ON_START === 'true') {
    const list = body.perps ?? ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT'];
    const ranked = await selectBestPerp(list);     // 1 appel IA ici
    symbol = ranked[0]?.symbol || 'BTC/USDT';
  }
  
  const s = await startSession(symbol, mode, startBalanceUsd);

  // Stratégie immédiate
  const strat = await generateStrategy(symbol, 'activation');
  const entryPrice = strat.entry.price ?? ((strat.entry.zone?.min ?? 0) + (strat.entry.zone?.max ?? 0)) / 2;
  let lvls: any = undefined;
  if (entryPrice && isFinite(entryPrice)) {
    const side = strat.bias === 'long' ? 'buy' : 'sell';
    lvls = calcLevels(entryPrice, side as any, strat.risk.stop as any, strat.risk.target as any);
  }
  try {
    await prisma.strategy.create({ data: {
      id: strat.strategyId, sessionId: s.id, symbol: strat.symbol, bias: strat.bias,
      confidence: strat.confidence, entryJson: strat.entry, riskJson: strat.risk,
      validityFrom: strat.validity?.from ? new Date(strat.validity.from) : undefined,
      validityTo: strat.validity?.to ? new Date(strat.validity.to) : undefined,
      rationale: strat.rationale, trigger: 'activation'
    }});
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }

  // Push session + strategy + analysis
  broadcast('session', s, s.symbol);
  broadcast('strategy', { ...strat, levels: lvls }, s.symbol);

  try {
    const tech = await buildTechSnapshot(s.symbol);
    broadcast('analysis', { symbol: s.symbol, technical: tech }, s.symbol);
  } catch {}

  res.json(s);
});

router.post('/stop', async (_req,res)=>{
  const s = await activeSession(); if(!s) return res.status(400).json({error:'no active session'});
  await stopSession(s.id);
  broadcast('session', { ...s, stoppedAt: new Date().toISOString() }, s.symbol);
  res.json({ok:true});
});

// Changer le symbole de la session
router.post('/set-symbol', async (req,res)=>{
  const { symbol } = req.body as { symbol: string };
  const s = await activeSession();
  if (!s) return res.status(400).json({ error: 'no active session' });
  const upd = await prisma.agentSession.update({ where: { id: s.id }, data: { symbol } });
  broadcast('session', upd, upd.symbol);
  res.json(upd);
});

// Triggers log
router.get('/triggers', async (_req,res)=>{
  const s = await activeSession(); if(!s) return res.json([]);
  const logs = await prisma.triggerLog.findMany({ where:{ sessionId: s.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(logs);
});
