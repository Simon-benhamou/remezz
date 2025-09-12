import { Router } from 'express';
import { startSession, stopSession, activeSession } from '../session/session.js';
import { exchange } from '../exchange/ccxtClient.js';
import { prisma } from '../db/client.js';
import { selectBestPerp } from '../ai/orchestrator.js';
import { broadcast } from '../ws/hub.js';
import { levels as calcLevels } from '../risk/brackets.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { Agent } from '../agent/state.js';
import { PlanZ } from '../agent/planSchema.js';
import { getAICallsCount, getAIMetrics, setActiveSession } from '../metrics/aiCalls.js';
import { requestStrategy } from '../ai/strategyManager.js';

export const router = Router();

router.get('/session', async (_req,res)=> res.json(await activeSession()));

router.post('/start', async (req,res)=>{
  const {  mode, startBalanceUsd } = req.body as {symbol:string, mode:'paper'|'live', startBalanceUsd?:number};
  const body = req.body as { symbol?: string, mode:'paper'|'live', startBalanceUsd?:number, perps?: string[], riskPerTradePct?: number, maxLeverage?: number, dailyLossLimitPct?: number, budgetPct?: number };
  let symbol = body.symbol as string;

  // Enforce single active session
  const existing = await prisma.agentSession.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
  if (existing) return res.status(400).json({ error: 'active_session_exists', session: existing });

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
  const s = await startSession(symbol, mode, startBal, {
    riskPerTradePct: body.riskPerTradePct,
    maxLeverage: body.maxLeverage,
    dailyLossLimitPct: body.dailyLossLimitPct,
    budgetPct: body.budgetPct,
    startBalanceUsd: startBal,
  });
  await setActiveSession(s.id);
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

  // Classic strategy generation for preview (optional) via manager (throttled)
  const { strategy: strat, levels: lvls } = await requestStrategy({ symbol, trigger: 'activation', sessionId: s.id });
  // Push session + strategy + analysis
  broadcast('session', s, s.symbol);
  broadcast('strategy', { ...(strat as any), levels: lvls }, s.symbol);

  try {
    const tech = await buildTechSnapshot(s.symbol);
    broadcast('analysis', { symbol: s.symbol, technical: tech }, s.symbol);
  } catch {}

  res.json(s);
});

router.post('/stop', async (req,res)=>{
  const s = await activeSession(); if(!s) return res.status(400).json({error:'no active session'});
  const { closePosition } = (req.body || {}) as { closePosition?: boolean };
  // Optionally close current position first
  try { if (closePosition) await Agent.closeNow(); } catch {}
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
  res.json({ count: await getAICallsCount(s?.id || undefined) });
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
  // Enhance with live unrealized PnL if we have a position
  try {
    if (Agent.pos && Agent.profile) {
      const snap = await buildTechSnapshot(Agent.profile.symbol);
      const last = snap.last;
      const dir = Agent.pos.side === 'buy' ? 1 : -1;
      const upnlUsd = dir * (last - Agent.pos.entry) * Agent.pos.qty;
      const equityLive = Number(balance?.equityUsd ?? 0) + upnlUsd;
      const upnlPct = Agent.pos.entry ? (dir * (last - Agent.pos.entry) / Agent.pos.entry) * 100 : 0;
      balance = { ...(balance||{}), equityUsd: equityLive, upnlUsd, upnlPct };
    }
  } catch {}
  res.json({ state: Agent.state, profile: Agent.profile, plan: Agent.plan, pos: Agent.pos, balance, aiMetrics: await getAIMetrics() });
});

// List recent sessions (active first), with open position count
router.get('/sessions', async (_req,res)=>{
  const rows = await prisma.agentSession.findMany({ orderBy: { startedAt: 'desc' }, take: 100, include: { positions: true } });
  const out = rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    mode: r.mode,
    startedAt: r.startedAt,
    stoppedAt: r.stoppedAt,
    startBalanceUsd: r.startBalanceUsd,
    openPositions: (r.positions || []).filter(p => (p.qty ?? 0) > 0).length,
    profile: (r as any).profileJson || null,
  }));
  res.json(out);
});

// Overview: active agents count, average ROI, sessions count
router.get('/overview', async (_req,res)=>{
  const sessions = await prisma.agentSession.findMany({ include: { kpi: true } });
  const activeCount = sessions.filter(s => !s.stoppedAt).length;
  const withKpi = sessions.filter(s => s.kpi != null);
  const avgRoiPct = withKpi.length ? (withKpi.reduce((acc, s)=> acc + (Number(s.kpi?.roiPct || 0)), 0) / withKpi.length) : 0;
  const avgWinRate = withKpi.length ? (withKpi.reduce((acc, s)=> acc + (Number(s.kpi?.winRate || 0)), 0) / withKpi.length) : 0;
  res.json({ activeCount, sessionsCount: sessions.length, avgRoiPct, avgWinRate });
});

// Delete a session and all associated records (requires session to be stopped)
router.delete('/sessions/:id', async (req,res)=>{
  const { id } = req.params as { id: string };
  const active = await activeSession();
  if (active?.id === id) return res.status(400).json({ error: 'stop_active_session_first' });
  // Hard delete children then session
  await prisma.fill.deleteMany({ where: { sessionId: id } });
  await prisma.order.deleteMany({ where: { sessionId: id } });
  await prisma.position.deleteMany({ where: { sessionId: id } });
  await prisma.strategy.deleteMany({ where: { sessionId: id } });
  await prisma.triggerLog.deleteMany({ where: { sessionId: id } });
  await prisma.sentimentSnapshot.deleteMany({ where: { sessionId: id } });
  await prisma.sessionKpi.deleteMany({ where: { sessionId: id } });
  await prisma.agentSession.delete({ where: { id } });
  res.json({ ok: true });
});
