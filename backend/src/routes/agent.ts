import { Router } from 'express';
import { startSession, stopSession, activeSession } from '../session/session.js';
import { exchange } from '../exchange/ccxtClient.js';
import { prisma } from '../db/client.js';
import { selectBestPerp } from '../ai/orchestrator.js';
import { broadcast } from '../ws/hub.js';
import { levels as calcLevels } from '../risk/brackets.js';
import { buildTechSnapshot } from '../ai/tech.js';
// import { Agent } from '../agent/state.js';
import { AgentHub } from '../agent/hub.js';
import { PlanZ } from '../agent/planSchema.js';
import { getAICallsCount, getAIMetrics, setActiveSession } from '../metrics/aiCalls.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { proposePlan } from '../ai/planOrchestrator.js';

export const router = Router();

router.get('/session', async (_req,res)=> res.json(await activeSession()));

router.post('/start', async (req,res)=>{
  try {
    const {  mode, startBalanceUsd } = req.body as {symbol:string, mode:'paper'|'live', startBalanceUsd?:number};
    const body = req.body as { symbol?: string, mode:'paper'|'live', startBalanceUsd?:number, perps?: string[], riskPerTradePct?: number, maxLeverage?: number, dailyLossLimitPct?: number, budgetPct?: number };
    let symbol = body.symbol as string;

  // Optional: ranking only if no symbol provided and RANK_ON_START=true
    if (!symbol && process.env.RANK_ON_START === 'true') {
      const list = body.perps ?? ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT'];
      const ranked = await selectBestPerp(list);     // may call LLM once
      symbol = ranked[0]?.symbol || 'BTC/USDT';
    }
    // Ensure we resolve a perpetual market symbol; return descriptive error if not available
    try { const s = await (await import('../exchange/ccxtClient.js')).resolveSymbol(symbol); symbol = s; } catch (e:any) { return res.status(400).json({ error: 'symbol_not_found_perp', details: String(e?.message || e) }); }
  
    let startBal = startBalanceUsd;
    if (mode === 'live') {
      try {
        const ex = await exchange();
        const b = await ex.fetchBalance();
        const totalUsd = (Number(b?.total?.USDT || 0) + Number(b?.total?.USD || 0));
        const freeUsd = (Number(b?.free?.USDT || 0) + Number(b?.free?.USD || 0));
        if (!startBal || startBal <= 0) {
          startBal = totalUsd > 0 ? totalUsd : (freeUsd > 0 ? freeUsd : undefined);
        } else {
          if (totalUsd > 0) startBal = Math.min(startBal, totalUsd);
        }
      } catch (e:any) {
        return res.status(502).json({ error: 'exchange_balance_failed', details: String(e?.message || e) });
      }
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
    await AgentHub.activate(s.id, {
      symbol,
      mode,
      maxLeverage: Math.min(5, Math.max(1, body.maxLeverage ?? 4)),
      riskPerTradePct: Math.min(2, Math.max(1, body.riskPerTradePct ?? 1.5)),
      dailyLossLimitPct: Math.min(4, Math.max(3, body.dailyLossLimitPct ?? 3.5)),
      timestamp: new Date().toISOString(),
      startBalanceUsd: startBalanceUsd,
      budgetFraction,
    } as any).catch(()=>{});

    // Respond immediately to keep the UI smooth
    res.json(s);

    // Continue heavy work in background without blocking response
    setTimeout(async () => {
      try {
        // Plan + arm
        const plan = await proposePlan(symbol, { fresh: true, sessionId: s.id });
        // Persist LLM plan JSON on the session so we can re-arm after a reboot without re-calling LLM
        try { await prisma.agentSession.update({ where: { id: s.id }, data: { planJson: plan as any } }); } catch {}
        const a = AgentHub.get(s.id);
        if (a) {
          await a.propose(plan as any);
          await a.validateAndArm();
        }
      } catch {}
      try {
        // Strategy preview
        const { strategy: strat, levels: lvls } = await requestStrategy({ symbol, trigger: 'activation', sessionId: s.id, fresh: true, force: true });
        broadcast('strategy', { ...(strat as any), levels: lvls }, s.symbol, s.id);
      } catch {}
      try {
        const tech = await buildTechSnapshot(s.symbol);
        broadcast('analysis', { symbol: s.symbol, technical: tech }, s.symbol, s.id);
      } catch {}
      // Ensure session broadcast after activation
      try { broadcast('session', s, s.symbol, s.id); } catch {}
    }, 0);
  } catch (e:any) {
    res.status(500).json({ error: 'agent_start_failed', details: String(e?.message || e) });
  }
});

router.post('/stop', async (req,res)=>{
  const { sessionId, closePosition } = (req.body || {}) as { sessionId?: string, closePosition?: boolean };
  const s = sessionId ? await prisma.agentSession.findUnique({ where: { id: sessionId } }) : await activeSession();
  if (!s) return res.status(400).json({ error: 'no_active_session' });
  try { if (closePosition) await AgentHub.closeNow(s.id); } catch {}
  await stopSession(s.id);
  broadcast('session', { ...s, stoppedAt: new Date().toISOString() }, s.symbol, s.id);
  await AgentHub.halt(s.id);
  res.json({ok:true});
});

// Change the active session symbol
router.post('/set-symbol', async (req,res)=>{
  const { symbol, sessionId } = req.body as { symbol: string, sessionId: string };
  const s = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!s) return res.status(400).json({ error: 'no_session' });
  const upd = await prisma.agentSession.update({ where: { id: s.id }, data: { symbol } });
  broadcast('session', upd, upd.symbol, upd.id);
  res.json(upd);
});

// Triggers log
router.get('/triggers', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.json([]);
  const logs = await prisma.triggerLog.findMany({ where:{ sessionId }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(logs);
});

// AI calls count for current session
router.get('/ai-calls', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  res.json({ count: await getAICallsCount(sessionId || undefined) });
});

// New: pass a LLM JSON plan to the agent (validates + arms)
router.post('/propose', async (req,res) => {
  try {
    const { sessionId, ...rest } = req.body || {};
    const plan = PlanZ.parse(rest);
    const a = AgentHub.get(sessionId);
    if (!a) return res.status(400).json({ error: 'no_agent' });
    // Persist the proposed plan on session
    try { await prisma.agentSession.update({ where: { id: sessionId }, data: { planJson: plan as any } }); } catch {}
    await a.propose(plan as any);
    await a.validateAndArm();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

router.get('/state', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  const a = sessionId ? AgentHub.get(sessionId) : null;
  let balance: any = null;
  try { balance = await (a as any)?.broker?.balance?.(); } catch {}
  // Enhance with live unrealized PnL if we have a position
  try {
    if (a?.pos && a?.profile) {
      const snap = await buildTechSnapshot(a.profile.symbol);
      const last = snap.last;
      const dir = a.pos.side === 'buy' ? 1 : -1;
      const upnlUsd = dir * (last - a.pos.entry) * a.pos.qty;
      const equityLive = Number(balance?.equityUsd ?? 0) + upnlUsd;
      const upnlPct = a.pos.entry ? (dir * (last - a.pos.entry) / a.pos.entry) * 100 : 0;
      balance = { ...(balance||{}), equityUsd: equityLive, upnlUsd, upnlPct };
    }
  } catch {}
  res.json({ state: a?.state, profile: a?.profile, plan: a?.plan, pos: a?.pos, balance, aiMetrics: await getAIMetrics(sessionId || undefined) });
});

router.post('/ack-halt', async (req,res)=>{
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) return res.status(400).json({ error: 'session_required' });
  const agent = AgentHub.get(sessionId) as any;
  if (!agent) return res.status(404).json({ error: 'no_agent' });
  try {
    if (typeof agent.acknowledgeHalt === 'function') agent.acknowledgeHalt();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// List recent sessions (active first), with open position count
router.get('/sessions', async (req,res)=>{
  const modeRaw = String(req.query.mode || '').toLowerCase();
  const modeFilter = modeRaw === 'live' || modeRaw === 'paper' ? modeRaw : undefined;
  const rows = await prisma.agentSession.findMany({
    where: modeFilter ? { mode: modeFilter } : undefined,
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: { positions: true, kpi: true },
  });
  const out = rows.map(r => {
    const realized = Number(r.kpi?.realizedPnlUsd || 0);
    const unrealized = Number(r.kpi?.unrealizedPnlUsd || 0);
    const pnlUsd = realized + unrealized;
    const roiPct = Number(r.kpi?.roiPct || 0);
    return {
      id: r.id,
      symbol: r.symbol,
      mode: r.mode,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      startBalanceUsd: r.startBalanceUsd,
      openPositions: (r.positions || []).filter(p => (p.qty ?? 0) > 0).length,
      profile: (r as any).profileJson || null,
      pnlUsd,
      roiPct,
    };
  });
  res.json(out);
});

// Aggregated view across active sessions for multi-agent header
router.get('/overview', async (req,res)=>{
  const modeRaw = String(req.query.mode || '').toLowerCase();
  const modeFilter = modeRaw === 'live' || modeRaw === 'paper' ? modeRaw : undefined;
  const sessionWhere: any = { stoppedAt: null };
  if (modeFilter) sessionWhere.mode = modeFilter;
  const [actives, totalSessions, recentAlerts] = await Promise.all([
    prisma.agentSession.findMany({ where: sessionWhere, include: { kpi: true, positions: true } }),
    prisma.agentSession.count({ where: modeFilter ? { mode: modeFilter } : undefined }),
    (async ()=>{ try { return await (prisma as any).alert.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }); } catch { return []; } })(),
  ]);
  const symbols = actives.map(a => a.symbol);
  const aiCallsTotal = actives.reduce((sum, a)=> sum + Number(a.kpi?.aiCallsTotal || 0), 0);
  const pnlUsd = actives.reduce((sum, a)=> sum + Number(a.kpi?.realizedPnlUsd || 0) + Number(a.kpi?.unrealizedPnlUsd || 0), 0);
  const capitalStartUsd = actives.reduce((sum, a)=> sum + Number(a.startBalanceUsd || 0), 0);
  const roiPct = capitalStartUsd > 0 ? (pnlUsd / capitalStartUsd) * 100 : (
    actives.length > 0 ? (actives.reduce((s,a)=> s + Number(a.kpi?.roiPct || 0), 0) / actives.length) : 0
  );
  const avgWinRate = actives.length > 0 ? (actives.reduce((s,a)=> s + Number(a.kpi?.winRate || 0), 0) / actives.length) : 0;
  // Global exchange balance (live account)
  let exchangeBalance: any = null;
  if (!modeFilter || modeFilter === 'live') {
    try {
      const ex = await exchange();
      const b = await ex.fetchBalance();
      const raw = Array.isArray(b?.info?.result?.data) ? b.info.result.data[0] : undefined;
      const num = (v:any)=>{ const n = Number(v); return Number.isFinite(n) ? n : undefined; };
      const equityUsd = num(raw?.total_margin_balance) ?? num(raw?.total_collateral_value) ?? (Number(b?.total?.USDT || 0) + Number(b?.total?.USD || 0));
      const freeUsd = num(raw?.total_available_balance) ?? (Number(b?.free?.USDT || 0) + Number(b?.free?.USD || 0));
      const committedUsd = num(raw?.total_position_cost) ?? (Number.isFinite(equityUsd) && Number.isFinite(freeUsd) ? Math.max(0, (equityUsd ?? 0) - (freeUsd ?? 0)) : 0);
      exchangeBalance = {
        totalUsd: Number.isFinite(equityUsd) ? equityUsd : 0,
        freeUsd: Number.isFinite(freeUsd) ? freeUsd : 0,
        usedUsd: Number.isFinite(committedUsd) ? committedUsd : 0,
      };
    } catch {}
  }

  // Aggregate paper balances and per-mode budgets
  let paperBalance = { equityUsd: 0, freeUsd: 0, committedUsd: 0 };
  let liveBudgetTotal = 0;
  let liveCommittedTotal = 0;
  let paperBudgetTotal = 0;
  let paperCommittedTotal = 0;
  try {
    for (const s of actives) {
      const agent = AgentHub.get(s.id) as any;
      const profile = agent?.profile;
      const cfgBudget = (() => {
        const raw = (s as any).profileJson?.budgetPct;
        if (typeof raw === 'number') return raw > 1 ? raw / 100 : raw;
        return undefined;
      })();
      const budgetFraction = profile?.budgetFraction ?? Math.max(0.1, Math.min(1, cfgBudget ?? 1));
      const startBal = Number(s.startBalanceUsd || 0);
      const budgetUsd = startBal > 0 ? startBal * budgetFraction : undefined;
      const bal = await agent?.broker?.balance?.();
      if (s.mode === 'paper') {
        if (budgetUsd != null) paperBudgetTotal += budgetUsd;
        if (bal) {
          paperBalance.equityUsd += Number(bal.equityUsd || 0);
          paperBalance.freeUsd += Number(bal.freeUsd || 0);
          paperBalance.committedUsd += Number(bal.committedUsd || 0);
          paperCommittedTotal += Number(bal.committedUsd || 0);
        }
      } else {
        if (budgetUsd != null) liveBudgetTotal += budgetUsd;
        if (bal) liveCommittedTotal += Number(bal.committedUsd || 0);
      }
    }
  } catch {}
  const bySession = await Promise.all(actives.map(async a => {
    const agent = AgentHub.get(a.id) as any;
    const state = agent?.state || 'IDLE';
    const bias = agent?.plan?.bias || null;
    const pos = agent?.pos || null;
    const openQty = Array.isArray((a as any).positions) ? (a as any).positions.reduce((s:number,p:any)=> s + Number(p?.qty||0), 0) : 0;
    return {
      id: a.id,
      symbol: a.symbol,
      mode: a.mode,
      startedAt: a.startedAt,
      pnlUsd: Number(a.kpi?.realizedPnlUsd || 0) + Number(a.kpi?.unrealizedPnlUsd || 0),
      roiPct: Number(a.kpi?.roiPct || 0),
      aiCalls: Number(a.kpi?.aiCallsTotal || 0),
      state,
      bias,
      openQty,
      hasPos: !!pos,
      posSide: pos?.side || null,
      posQty: pos?.qty || null,
    };
  }));
  // Total open risk (approx): sum of |qty * last| across active positions
  let totalOpenRiskUsd = 0;
  try {
    for (const s of actives) {
      const agent = AgentHub.get(s.id) as any;
      if (agent?.pos && agent?.profile?.symbol) {
        const snap = await buildTechSnapshot(agent.profile.symbol);
        totalOpenRiskUsd += Math.abs((agent.pos.qty||0) * (snap.last||0));
      }
    }
  } catch {}
  // Alerts summary
  const activeIds = new Set(actives.map(a => a.id));
  const alertsFiltered = (recentAlerts as any[]).filter((a:any) => {
    if (!modeFilter) return true;
    if (!a.sessionId) return true;
    return activeIds.has(a.sessionId);
  });
  const severityCounts = (alertsFiltered as any[]).reduce((m:any,a:any)=>{ m[a.severity] = (m[a.severity]||0)+1; return m; }, { high:0, med:0, low:0 });
  const alertsSlim = alertsFiltered.map(a => ({ id:a.id, sessionId:a.sessionId, symbol:a.symbol, kind:a.kind, severity:a.severity, createdAt:a.createdAt }));
  res.json({
    activeCount: actives.length,
    sessionsCount: totalSessions,
    symbols,
    pnlUsd,
    capitalStartUsd,
    roiPct,
    avgRoiPct: roiPct,
    avgWinRate,
    aiCallsTotal,
    exchangeBalance,
    paperBalance,
    budget: {
      liveTotalUsd: liveBudgetTotal,
      liveCommittedUsd: liveCommittedTotal,
      liveRemainingUsd: Math.max(0, liveBudgetTotal - liveCommittedTotal),
      paperTotalUsd: paperBudgetTotal,
      paperCommittedUsd: paperCommittedTotal,
      paperRemainingUsd: Math.max(0, paperBudgetTotal - paperCommittedTotal),
    },
    sessions: bySession,
    alerts: { severityCounts, recent: alertsSlim },
    updatedAt: new Date().toISOString(),
    totalOpenRiskUsd,
  });
});

// Overview: active agents count, average ROI, sessions count
// (removed duplicate /overview route)

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
