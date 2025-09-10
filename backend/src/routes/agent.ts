import { Router } from 'express';
import { startSession, stopSession, activeSession } from '../session/session.js';
import { exchange } from '../exchange/ccxtClient.js';
import { prisma } from '../db/client.js';
import { generateStrategy, selectBestPerp } from '../ai/orchestrator.js';
import { broadcast } from '../ws/hub.js';
import { levels as calcLevels } from '../risk/brackets.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { Agent } from '../agent/state.js';
import { PlanZ } from '../agent/planSchema.js';
import { getAICallsCount, getAIMetrics, setActiveSession } from '../metrics/aiCalls.js';

export const router = Router();

router.get('/session', async (_req,res)=> res.json(await activeSession()));

router.post('/start', async (req,res)=>{
  const {  mode, startBalanceUsd } = req.body as {symbol:string, mode:'paper'|'live', startBalanceUsd?:number};
  const body = req.body as { symbol?: string, mode:'paper'|'live', startBalanceUsd?:number, perps?: string[], riskPerTradePct?: number, maxLeverage?: number, dailyLossLimitPct?: number, budgetPct?: number };
  let symbol = body.symbol as string;

  // Optional: ranking only if no symbol provided and RANK_ON_START=true
  if (!symbol && process.env.RANK_ON_START === 'true') {
    const list = body.perps ?? ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT'];
    const ranked = await selectBestPerp(list);     // may call LLM once
    symbol = ranked[0]?.symbol || 'BTC/USDT';
  }
  
  let startBal = startBalanceUsd;
  if (mode === 'live' && (!startBal || startBal <= 0)) {
    try {
      const ex = await exchange();
      const b = await ex.fetchBalance();
      const totalUsd = (Number(b?.total?.USDT || 0) + Number(b?.total?.USD || 0));
      startBal = totalUsd > 0 ? totalUsd : undefined;
    } catch {}
  }
  const s = await startSession(symbol, mode, startBal);
  setActiveSession(s.id);
  // Activate the new agent state machine (profile freeze)
  let budgetFraction = typeof body.budgetPct === 'number' ? body.budgetPct : 1;
  if (budgetFraction > 1) budgetFraction = budgetFraction / 100; // accept 0..1 or 0..100
  budgetFraction = Math.min(1, Math.max(0.1, budgetFraction));
  await Agent.activate({
    symbol,
    mode,
    maxLeverage: Math.min(5, Math.max(1, body.maxLeverage ?? 4)),
    riskPerTradePct: Math.min(2, Math.max(1, body.riskPerTradePct ?? 1.5)),
    dailyLossLimitPct: Math.min(4, Math.max(3, body.dailyLossLimitPct ?? 3.5)),
    timestamp: new Date().toISOString(),
    startBalanceUsd: startBalanceUsd,
    budgetFraction,
  }).catch(()=>{});

  // Classic strategy generation for preview (optional)
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
  Agent.halt();
  setActiveSession(null);
  res.json({ok:true});
});

// Change the active session symbol
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

// AI calls count for current session
router.get('/ai-calls', async (_req,res)=>{
  const s = await activeSession().catch(()=>null);
  res.json({ count: getAICallsCount(s?.id || undefined) });
});

// New: pass a LLM JSON plan to the agent (validates + arms)
router.post('/propose', async (req,res) => {
  try {
    const plan = PlanZ.parse(req.body);
    await Agent.propose(plan as any);
    await Agent.validateAndArm();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

router.get('/state', async (_req,res)=>{
  let balance: any = null;
  try { balance = await (Agent as any).broker?.balance?.(); } catch {}
  res.json({ state: Agent.state, profile: Agent.profile, plan: Agent.plan, pos: Agent.pos, balance, aiMetrics: getAIMetrics() });
});
