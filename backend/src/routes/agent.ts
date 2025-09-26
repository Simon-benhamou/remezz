import { Router, type Response } from 'express';
import { startSession, stopSession, activeSession } from '../session/session.js';
import { getUserExchange } from '../exchange/ccxtClient.js';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { getUserCredentials } from '../services/userCredentials.js';
import { prisma } from '../db/client.js';
import { selectBestPerp } from '../ai/orchestrator.js';
import { initializeIntelligentSmartAgent, getAllIntelligentOpportunities, getIntelligentAgentStatus } from '../services/smartAgent.js';
import { getBestIntelligentOpportunity, triggerIntelligentReselection } from '../services/intelligentAgent.js';
import type { IntelligentAnalysis } from '../services/intelligentAgent.js';
import { broadcast } from '../ws/hub.js';
import { levels as calcLevels } from '../risk/brackets.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { AgentHub } from '../agent/hub.js';
import { PlanZ } from '../agent/planSchema.js';
import { getAICallsCount, getAIMetrics, setActiveSession } from '../metrics/aiCalls.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { proposePlan } from '../ai/planOrchestrator.js';
import { savePlan } from '../services/planStore.js';

export const router = Router();

async function processSmartReselect(sessionId: string, res: Response) {
  try {
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id_required' });
    }

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const isSmartAgent = (session as any).isSmartAgent || false;
    if (!isSmartAgent) {
      return res.status(400).json({ error: 'Not a Smart Agent session' });
    }

    console.log(`🔄 Manual re-selection triggered for Smart Agent ${sessionId}`);

    const result = await triggerIntelligentReselection(sessionId);

    if (result.success) {
      console.log(`✅ Re-selection successful: ${result.oldSymbol} → ${result.newSymbol}`);
      return res.json({
        success: true,
        oldSymbol: result.oldSymbol,
        newSymbol: result.newSymbol,
        reason: result.reason,
        timestamp: new Date().toISOString()
      });
    }

    console.log(`⚠️ Re-selection skipped: ${result.reason}`);
    return res.json({
      success: false,
      reason: result.reason,
      currentSymbol: result.currentSymbol,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Smart Agent re-selection error:', error);
    return res.status(500).json({
      error: 'Re-selection failed',
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

router.get('/session', async (_req,res)=> res.json(await activeSession()));

router.post('/start', authenticateUser, async (req: AuthenticatedRequest, res)=>{
  try {
    const {  mode, startBalanceUsd } = req.body as {symbol:string, mode:'paper'|'live', startBalanceUsd?:number};
    const body = req.body as { 
      symbol?: string, 
      mode:'paper'|'live', 
      startBalanceUsd?:number, 
      perps?: string[], 
      riskPerTradePct?: number, 
      maxLeverage?: number, 
      dailyLossLimitPct?: number, 
      budgetPct?: number, 
      aggressiveness?: 'conservative'|'reactive'|'aggressive',
      isSmartAgent?: boolean,
      smartAutoMode?: boolean,  // Add support for frontend field name
      smartConfig?: any
    };
    let symbol = body.symbol as string;

    // Smart Agent mode - auto-select best symbol
    const isSmartAgent = body.isSmartAgent || body.smartAutoMode;
    console.log('🔍 Debug: isSmartAgent =', body.isSmartAgent, 'smartAutoMode =', body.smartAutoMode, 'final =', isSmartAgent);
    
    let prefetchedOpportunity: IntelligentAnalysis | null = null;
    let smartInitPromise: Promise<boolean> | null = null;
    let shouldActivate = true;
    if (isSmartAgent) {
      console.log('🎯 Creating Auto-Select Agent - scanning for best opportunity...');
      try {
        prefetchedOpportunity = await getBestIntelligentOpportunity();
        if (prefetchedOpportunity?.symbol) {
          symbol = prefetchedOpportunity.symbol;
          console.log(`✅ Prefetched best symbol: ${symbol}`);
        } else {
          // No confident symbol right now: do NOT fall back to trading
          // Use a placeholder symbol for DB visibility; skip activation
          symbol = symbol || 'SMART/SLEEP';
          shouldActivate = false; // defer activation; session will start in sleep mode via intelligent initializer
        }
      } catch (error) {
        console.warn('⚠️ Prefetch intelligent opportunity failed:', error);
        // As above, set a placeholder symbol but defer activation
        symbol = symbol || 'SMART/SLEEP';
        shouldActivate = false;
      }
    } else {
      // Ensure symbol is provided for non-smart agents
      if (!symbol && process.env.RANK_ON_START === 'true') {
        const list = body.perps ?? ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','AVAX/USDT'];
        const ranked = await selectBestPerp(list);     // may call LLM once
        symbol = ranked[0]?.symbol || 'BTC/USDT';
      } else if (!symbol) {
        return res.status(400).json({ error: 'symbol_required', message: 'Trading symbol is required for non-smart agents' });
      }
    }
    // Ensure we resolve a perpetual market symbol; return descriptive error if not available
    // Skip resolution when Smart agent is starting in sleep mode (placeholder symbol)
    if (!(isSmartAgent && !shouldActivate)) {
      try { const s = await (await import('../exchange/ccxtClient.js')).resolveSymbol(symbol); symbol = s; } catch (e:any) { return res.status(400).json({ error: 'symbol_not_found_perp', details: String(e?.message || e) }); }
    }
  
    let startBal = startBalanceUsd;
    if (mode === 'live') {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'authentication_required_for_live_trading' });
      }
      
      try {
        const userCredentials = await getUserCredentials(req.user.id);
        if (!userCredentials) {
          return res.status(400).json({ error: 'api_keys_required_for_live_trading' });
        }
        const ex = await getUserExchange(req.user.id, userCredentials);
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
    } else {
      // PAPER DEFAULT: if not provided, default to 1000 USD per agent
      if (!startBal || startBal <= 0) {
        startBal = Number(process.env.DEFAULT_PAPER_BALANCE_USD || 1000);
      }
    }
    const s = await startSession(symbol, mode, startBal, {
      riskPerTradePct: body.riskPerTradePct,
      maxLeverage: body.maxLeverage,
      dailyLossLimitPct: body.dailyLossLimitPct,
      budgetPct: body.budgetPct,
      aggressiveness: body.aggressiveness || 'reactive',
      startBalanceUsd: startBal,
    }, req.user!.id);

    // Mark as Smart Agent if requested
    if (isSmartAgent) {
      const defaultSmartConfig = {
        rescanInterval: 21600000, // 6h
        minHoldDuration: 86400000, // 24h
        volumeThreshold: 10000,
        momentumThreshold: 0.5
      };
      
      try {
        console.log(`🎯 Marking session ${s.id} as Smart Agent...`);
        await (prisma.agentSession as any).update({
          where: { id: s.id },
          data: {
            isSmartAgent: true,
            smartConfig: body.smartConfig || defaultSmartConfig
          }
        });
        console.log(`✅ Session ${s.id} marked as Smart Agent successfully`);
        
        // Update the session object we return to frontend
        (s as any).isSmartAgent = true;
        (s as any).smartConfig = body.smartConfig || defaultSmartConfig;
      } catch (error) {
        console.error(`❌ Failed to mark session ${s.id} as Smart Agent:`, error);
        // Continue anyway, the intelligent agent init will still work
      }
    }
    await setActiveSession(s.id);
    // Activate the new agent state machine (profile freeze)
    let budgetFraction = typeof body.budgetPct === 'number' ? body.budgetPct : 1;
    if (budgetFraction > 1) budgetFraction = budgetFraction / 100; // accept 0..1 or 0..100
    budgetFraction = Math.min(1, Math.max(0.1, budgetFraction));
    if (shouldActivate) {
      await AgentHub.activate(s.id, {
      symbol,
      mode,
      maxLeverage: Math.min(10, Math.max(1, body.maxLeverage ?? 4)),
      riskPerTradePct: Math.min(5, Math.max(0.5, body.riskPerTradePct ?? 1.5)),
      dailyLossLimitPct: Math.min(4, Math.max(3, body.dailyLossLimitPct ?? 3.5)),
      timestamp: new Date().toISOString(),
      startBalanceUsd: startBal,
      budgetFraction,
      aggressiveness: (body.aggressiveness === 'reactive' || body.aggressiveness === 'aggressive') ? body.aggressiveness : 'reactive',
      userId: req.user!.id,
      } as any).catch(()=>{});
    } else {
      console.log(`⏸️ Deferring agent activation for ${s.id} (smart sleep startup)`);
    }

    // Initialize Auto-Select Agent BEFORE responding (for better UX)
    if (isSmartAgent) {
      console.log(`🎯 Initializing Auto-Select Agent for session ${s.id}`);
      try {
        smartInitPromise = initializeIntelligentSmartAgent(s.id, prefetchedOpportunity)
          .then((success) => {
            if (success) {
              console.log(`✅ Auto-Select Agent ${s.id} initialized successfully (async)`);
              // If we deferred activation and we found an opportunity, activate now with the selected symbol
              if (!shouldActivate) {
                prisma.agentSession.findUnique({ where: { id: s.id } }).then(async (updated) => {
                  const sym = updated?.symbol;
                  if (sym) {
                    await AgentHub.activate(s.id, {
                      symbol: sym,
                      mode,
                      maxLeverage: Math.min(10, Math.max(1, body.maxLeverage ?? 4)),
                      riskPerTradePct: Math.min(5, Math.max(0.5, body.riskPerTradePct ?? 1.5)),
                      dailyLossLimitPct: Math.min(4, Math.max(3, body.dailyLossLimitPct ?? 3.5)),
                      timestamp: new Date().toISOString(),
                      startBalanceUsd: startBal,
                      budgetFraction,
                      aggressiveness: (body.aggressiveness === 'reactive' || body.aggressiveness === 'aggressive') ? body.aggressiveness : 'reactive',
                      userId: req.user!.id,
                    } as any).catch(()=>{});
                  }
                }).catch(()=>{});
              }
            } else {
              console.warn(`⚠️ Auto-Select Agent ${s.id} initialization returned false`);
            }
            return success;
          })
          .catch((error) => {
            console.error(`❌ Auto-Select Agent ${s.id} initialization error:`, error);
            return false;
          });
      } catch (error) {
        console.error(`❌ Auto-Select Agent ${s.id} initialization scheduling error:`, error);
      }
      prefetchedOpportunity = null;
    }

    // Respond with the session (now with selected symbol if Auto-Select succeeded)
    res.json(s);

    // Continue lighter background work
    setTimeout(async () => {
      try {
        if (isSmartAgent) {
          let success = false;
          if (smartInitPromise) {
            success = await smartInitPromise;
          }
          if (!success) {
            console.log(`🔁 Retrying Auto-Select Agent initialization for ${s.id}`);
            success = await initializeIntelligentSmartAgent(s.id).catch((err) => {
              console.error(`❌ Auto-Select retry failed for ${s.id}:`, err);
              return false;
            }) as boolean;
          }
          if (success) {
            const updatedSession = await prisma.agentSession.findUnique({ where: { id: s.id } });
            if (updatedSession?.symbol) {
              symbol = updatedSession.symbol;
              console.log(`🔄 Updated symbol for background processes: ${symbol}`);
            }
          } else {
            console.warn(`⚠️ Auto-Select Agent ${s.id} initialization still pending errors`);
          }
        }

        // Plan + arm
        const plan = await proposePlan(symbol, { fresh: true, sessionId: s.id });
        // Persist LLM plan JSON on the session so we can re-arm after a reboot without re-calling LLM
        try { await savePlan(s.id, plan as any); } catch (err) { console.warn('Failed to persist plan', err); }
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

// Intelligent Agent status
router.get('/sessions/:id/smart-status', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const status = await getIntelligentAgentStatus(sessionId);
    
    if (!status) {
      return res.json({ isSmartAgent: false });
    }
    
    res.json(status);
  } catch (error) {
    console.error('Error getting intelligent agent status:', error);
    res.status(500).json({ error: 'Failed to get intelligent agent status' });
  }
});

// Get all intelligent opportunities
router.get('/intelligent-opportunities', async (req, res) => {
  try {
    console.log('🧠 API: Fetching intelligent opportunities...');
    const opportunities = await getAllIntelligentOpportunities();
    
    res.json({
      success: true,
      count: opportunities.length,
      data: opportunities,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching intelligent opportunities:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch intelligent opportunities',
      data: []
    });
  }
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

// AI calls count for current session
router.get('/ai-calls', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  res.json({ count: await getAICallsCount(sessionId || undefined) });
});

// Basic status endpoint
router.get('/state', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  const a = sessionId ? AgentHub.get(sessionId) : null;
  let balance: any = null;
  try { balance = await (a as any)?.broker?.balance?.(); } catch {}
  res.json({ state: a?.state, profile: a?.profile, plan: a?.plan, pos: a?.pos, balance, aiMetrics: await getAIMetrics(sessionId || undefined) });
});

// Sessions list
router.get('/sessions', async (req,res)=>{
  const modeRaw = String(req.query.mode || '').toLowerCase();
  const modeFilter = modeRaw === 'live' || modeRaw === 'paper' ? modeRaw : undefined;
  const includeStats = req.query.includeStats === 'true';
  
  // Base query without heavy includes for better performance
  const baseQuery = {
    where: modeFilter ? { mode: modeFilter } : undefined,
    orderBy: { startedAt: 'desc' as const },
    take: 100,
    select: {
      id: true,
      symbol: true,
      mode: true,
      startedAt: true,
      stoppedAt: true,
      startBalanceUsd: true,
      profileJson: true,
      // Only include heavy data if requested
      ...(includeStats ? {
        kpi: {
          select: {
            realizedPnlUsd: true,
            unrealizedPnlUsd: true,
            roiPct: true,
            winRate: true
          }
        },
        positions: {
          select: {
            qty: true
          },
          where: {
            qty: { gt: 0 }
          }
        }
      } : {})
    }
  };

  const rows = await prisma.agentSession.findMany(baseQuery);
  
  const out = rows.map(r => {
    const profile = (r as any).profileJson || {};
    const aggressiveness = profile?.aggressiveness || 'conservative';
    
    // Only calculate stats if included
    let stats = {};
    if (includeStats && (r as any).kpi) {
      const realized = Number((r as any).kpi?.realizedPnlUsd || 0);
      const unrealized = Number((r as any).kpi?.unrealizedPnlUsd || 0);
      stats = {
        pnlUsd: realized + unrealized,
        roiPct: Number((r as any).kpi?.roiPct || 0),
        winRate: Number((r as any).kpi?.winRate || 0),
        openPositions: ((r as any).positions || []).length
      };
    }
    
    return {
      id: r.id,
      symbol: r.symbol,
      mode: r.mode,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      startBalanceUsd: r.startBalanceUsd,
      aggressiveness,
      // Detect Smart Agent from either top-level flag or profileJson
      isSmartAgent: (r as any).isSmartAgent || (r as any).profileJson?.isSmartAgent || profile?.isIntelligent || false,
      smartConfig: (r as any).profileJson?.smartConfig,
      ...stats
    };
  });
  res.json(out);
});

// Overview endpoint
router.get('/overview', authenticateUser, async (req: AuthenticatedRequest, res)=>{
  const modeRaw = String(req.query.mode || '').toLowerCase();
  const modeFilter = modeRaw === 'live' || modeRaw === 'paper' ? modeRaw : undefined;
  
  const sessionWhere: any = { stoppedAt: null };
  if (modeFilter) sessionWhere.mode = modeFilter;
  if (!req.user?.isLegacy && req.user?.id) {
    sessionWhere.userId = req.user.id;
  }
  const [actives, totalSessions] = await Promise.all([
    prisma.agentSession.findMany({ where: sessionWhere, include: { kpi: true, positions: true } }),
    prisma.agentSession.count({ where: modeFilter ? { mode: modeFilter } : undefined }),
  ]);
  const symbols = actives.map(a => a.symbol);
  const aiCallsTotal = actives.reduce((sum, a)=> sum + Number(a.kpi?.aiCallsTotal || 0), 0);
  const pnlUsd = actives.reduce((sum, a)=> sum + Number(a.kpi?.realizedPnlUsd || 0) + Number(a.kpi?.unrealizedPnlUsd || 0), 0);
  const capitalStartUsd = actives.reduce((sum, a)=> sum + Number(a.startBalanceUsd || 0), 0);
  const roiPct = capitalStartUsd > 0 ? (pnlUsd / capitalStartUsd) * 100 : 0;
  const avgWinRate = actives.length > 0 ? (actives.reduce((s,a)=> s + Number(a.kpi?.winRate || 0), 0) / actives.length) : 0;

  // Get live exchange balance for authenticated users
  let exchangeBalance: any = null;
  if (!req.user?.isLegacy && req.user?.id && (modeFilter === 'live' || !modeFilter)) {
    try {
      const userCredentials = await getUserCredentials(req.user.id);
      if (userCredentials) {
        const exchange = await getUserExchange(req.user.id, userCredentials);
        const balance = await exchange.fetchBalance();
        
        // Extract USD balances (compatible with Crypto.com response)
        const totalUsd = Number(balance?.total?.USD || 0);
        const freeUsd = Number(balance?.free?.USD || 0);
        const usedUsd = Number(balance?.used?.USD || 0);
        
        exchangeBalance = {
          totalUsd,
          freeUsd,
          usedUsd: usedUsd || Math.max(0, totalUsd - freeUsd),
          currencies: Object.keys(balance?.total || {}),
          lastUpdated: new Date().toISOString()
        };
        
        console.log(`📊 Live balance for user ${req.user.id}: $${totalUsd.toFixed(2)} USD`);
      }
    } catch (error) {
      console.error('Failed to fetch live exchange balance:', error);
      // Don't fail the entire request, just log the error
    }
  }

  // Get aggregated paper balance from ALL active paper sessions
  let paperBalance: any = null;
  if (modeFilter === 'paper' || !modeFilter) {
    const paperSessions = actives.filter(session => session.mode === 'paper');
    if (paperSessions.length > 0) {
      try {
        // Aggregate balances from ALL paper agents
        let totalEquityUsd = 0;
        let totalFreeUsd = 0;
        let totalCommittedUsd = 0;
        let successfulAgents = 0;
        
        for (const paperSession of paperSessions) {
          try {
            const agent = AgentHub.get(paperSession.id);
            if (agent && (agent as any).broker) {
              const balance = await (agent as any).broker.balance();
              totalEquityUsd += Number(balance?.equityUsd || 0);
              totalFreeUsd += Number(balance?.freeUsd || 0);
              totalCommittedUsd += Number(balance?.committedUsd || 0);
              successfulAgents++;
              console.log(`📊 Agent ${paperSession.symbol}: $${Number(balance?.equityUsd || 0).toFixed(2)} USD`);
            }
          } catch (agentError) {
            console.error(`Failed to fetch balance for agent ${paperSession.symbol}:`, agentError);
          }
        }
        
        if (successfulAgents > 0) {
          paperBalance = {
            equityUsd: totalEquityUsd,
            freeUsd: totalFreeUsd,
            committedUsd: totalCommittedUsd,
            agentsCount: successfulAgents,
            lastUpdated: new Date().toISOString()
          };
          console.log(`📊 Total Paper Balance: $${totalEquityUsd.toFixed(2)} USD from ${successfulAgents} agents`);
        }
      } catch (error) {
        console.error('Failed to fetch aggregated paper balance:', error);
        // Don't fail the entire request, just log the error
      }
    }
  }

  // Format sessions data for frontend
  const sessionsData = actives.map(session => {
    // Get runtime state from AgentHub if available
    const agent = AgentHub.get(session.id);
    const agentState = (agent as any)?.state || 'UNKNOWN'; // Fix: use .state not .phase
    const agentBias = (agent as any)?.bias || 'none';
    
    return {
      id: session.id,
      symbol: session.symbol,
      mode: session.mode,
      state: agentState, // ✅ Now using correct state property
      bias: agentBias,
      aggressiveness: session.profileJson ? (session.profileJson as any)?.aggressiveness : 'conservative',
      pnlUsd: Number(session.kpi?.realizedPnlUsd || 0) + Number(session.kpi?.unrealizedPnlUsd || 0),
      roiPct: (session.startBalanceUsd && session.startBalanceUsd > 0) ? 
        ((Number(session.kpi?.realizedPnlUsd || 0) + Number(session.kpi?.unrealizedPnlUsd || 0)) / Number(session.startBalanceUsd)) * 100 : 0,
      winRate: Number(session.kpi?.winRate || 0),
      trades: Number((session.kpi?.stats as any)?.tradesTotal || 0),
      createdAt: session.startedAt,
      lastActivity: new Date().toISOString()
    };
  });

  res.json({
    activeCount: actives.length,
    sessionsCount: totalSessions,
    symbols,
    pnlUsd,
    capitalStartUsd,
    roiPct,
    avgWinRate,
    aiCallsTotal,
    exchangeBalance,
    paperBalance,
    sessions: sessionsData, // ✅ Ajout des sessions dans la réponse
    updatedAt: new Date().toISOString(),
  });
});

// Triggers log
router.get('/triggers', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.json([]);
  const logs = await prisma.triggerLog.findMany({ 
    where:{ sessionId }, 
    orderBy: { createdAt: 'desc' }, 
    take: 100 
  });
  res.json(logs);
});

// Get trading diagnostics for a session - shows why agent is not trading
router.get('/sessions/:id/diagnostics', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const agent = AgentHub.get(id);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not active' });
    }
    
    const diagnostics = await (agent as any).getDiagnostics();
    res.json(diagnostics);
  } catch (err) {
    console.error('Diagnostics error:', err);
    res.status(500).json({ 
      error: 'Failed to get diagnostics', 
      details: String((err as any)?.message || err) 
    });
  }
});

// New: pass a LLM JSON plan to the agent (validates + arms)
router.post('/propose', async (req,res) => {
  try {
    const { sessionId, ...rest } = req.body || {};
    const plan = PlanZ.parse(rest);
    const a = AgentHub.get(sessionId);
    if (!a) return res.status(400).json({ error: 'no_agent' });
    // Persist the proposed plan on session
    try { 
      await savePlan(sessionId, plan as any); 
    } catch {}
    await a.propose(plan as any);
    await a.validateAndArm();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Update aggressiveness level on the fly
router.post('/aggressiveness', async (req, res) => {
  const { sessionId, level } = (req.body || {}) as { sessionId?: string; level?: string };
  if (!sessionId) return res.status(400).json({ error: 'session_required' });
  const a = AgentHub.get(sessionId) as any;
  if (!a) return res.status(404).json({ error: 'no_agent' });
  const val = String(level || '').toLowerCase();
  if (!['conservative','reactive','aggressive'].includes(val)) return res.status(400).json({ error: 'invalid_level' });
  try {
    a.profile = { ...(a.profile || {}), aggressiveness: val };
    // broadcast new profile snapshot to UI
    const sym = a.profile?.symbol;
    const { broadcast } = await import('../ws/hub.js');
    try { broadcast('agent_state', { state: a.state, profile: a.profile }, sym, sessionId); } catch {}
    // persist hint on session profileJson for restarts
    try {
      const prismaClient = (await import('../db/client.js')).prisma;
      const existing = await prismaClient.agentSession.findUnique({
        where: { id: sessionId },
        select: { profileJson: true }
      });
      const existingProfile = (existing?.profileJson as any) || {};
      const mergedProfile = {
        ...existingProfile,
        aggressiveness: val,
      };
      await prismaClient.agentSession.update({
        where: { id: sessionId },
        data: { profileJson: mergedProfile as any }
      });
    } catch (err) {
      console.error('Failed to persist aggressiveness change:', err);
    }
    res.json({ ok: true, aggressiveness: val });
  } catch (e:any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
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

// Force re-selection for Smart AUTO agents
router.post('/reselect', authenticateUser, async (req: AuthenticatedRequest, res) => {
  const sessionId = (req.body?.sessionId || req.query?.sessionId || '').toString().trim();
  return processSmartReselect(sessionId, res);
});

// Backwards compatibility for legacy path
router.post('/smart/:sessionId/reselect', authenticateUser, async (req: AuthenticatedRequest, res) => {
  return processSmartReselect(req.params.sessionId, res);
});
