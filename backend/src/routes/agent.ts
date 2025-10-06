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
import { savePlan, extractPersistedPlan } from '../services/planStore.js';
import { getTicker } from '../data/market.js';
import { getConfig } from '../utils/env.js';

export const router = Router();

// Lightweight cache for /overview to improve dashboard/header refresh
const OVERVIEW_TTL_MS = 3000;
const overviewCache = new Map<string, { ts: number; data: any }>();
const overviewPending = new Map<string, Promise<any>>();

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
    const { mode, startBalanceUsd } = req.body as { mode:'paper'|'live', startBalanceUsd?:number };
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
    let symbol = body.symbol;

    // Smart Agent mode - auto-select best symbol
    const isSmartAgent = body.isSmartAgent || body.smartAutoMode;
    console.log('🔍 Debug: isSmartAgent =', body.isSmartAgent, 'smartAutoMode =', body.smartAutoMode, 'final =', isSmartAgent);
    
    // UNIT TEST MODE: skip heavy prefetch/ccxt resolution
    if (process.env.UNIT_TEST_MODE === 'true') {
      console.log('🧪 UNIT_TEST_MODE enabled: skipping intelligent prefetch and symbol resolution');
      symbol = symbol || 'BTC/USDT';
    }

    let prefetchedOpportunity: IntelligentAnalysis | null = null;
    let smartInitPromise: Promise<boolean> | null = null;
    let shouldActivate = true;
    if (isSmartAgent && process.env.UNIT_TEST_MODE !== 'true') {
      // Defer any symbol selection to the intelligent initializer (with WS warm-up)
      // This avoids cold-start bias and majors fallback
      symbol = symbol || 'SMART/SLEEP';
      shouldActivate = false;
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
    if (!(isSmartAgent && !shouldActivate) && process.env.UNIT_TEST_MODE !== 'true') {
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
        // 🚀 WebSocket for Binance (0 weight)
        let b: any;
        let exchange: any = null;
        if (userCredentials.exchange === 'binance') {
          try {
            const { getBalanceFromWebSocket, subscribeToUserData, seedBalanceCache, runExclusiveBalanceFetch } = await import('../services/binanceWebSocket.js');
            await subscribeToUserData(req.user.id, userCredentials.apiKey, userCredentials.apiSecret);
            const wsBalance = await getBalanceFromWebSocket(req.user.id, 'USDT');
            if (wsBalance) {
              b = {
                total: { USDT: wsBalance.total, USD: 0 },
                free: { USDT: wsBalance.free, USD: 0 },
                used: { USDT: wsBalance.locked, USD: 0 }
              };
              console.log(`✅ [WebSocket] Balance fetched - 0 weight`);
            } else {
              exchange = await getUserExchange(req.user.id, userCredentials);
              b = await runExclusiveBalanceFetch(req.user.id, 'USDT', () => exchange.fetchBalance());
              console.log(`⚠️ [REST] Balance fetched - 40 weight (WebSocket not ready)`);
              try {
                const total = Number(b?.total?.USDT ?? 0);
                const free = Number(b?.free?.USDT ?? 0);
                const locked = Number(b?.used?.USDT ?? 0);
                if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
                  seedBalanceCache(req.user.id, 'USDT', { total, free, locked });
                }
              } catch {}
            }
          } catch (error) {
            console.warn('⚠️ WebSocket balance failed, using REST:', error);
            exchange = await getUserExchange(req.user.id, userCredentials);
            const { runExclusiveBalanceFetch, seedBalanceCache } = await import('../services/binanceWebSocket.js');
            b = await runExclusiveBalanceFetch(req.user.id, 'USDT', () => exchange.fetchBalance());
            try {
              const total = Number(b?.total?.USDT ?? 0);
              const free = Number(b?.free?.USDT ?? 0);
              const locked = Number(b?.used?.USDT ?? 0);
              if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
                seedBalanceCache(req.user.id, 'USDT', { total, free, locked });
              }
            } catch {}
          }
        } else {
          exchange = await getUserExchange(req.user.id, userCredentials);
          b = await exchange.fetchBalance();
        }
        
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
      // PAPER DEFAULT: force 1000 USD per agent for crypto trading
      startBal = 1000;
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
      aggressiveness: (['conservative','reactive','aggressive'].includes(String(body.aggressiveness)))
        ? (body.aggressiveness as any)
        : 'reactive',
  userId: req.user!.id,
  // Optional frontend-configurable sizing and leverage behavior
  sizingMode: ((body as any).sizingMode === 'budget' || (body as any).sizingMode === 'risk')
    ? (body as any).sizingMode
    : (getConfig().SIZING_DEFAULT_MODE === 'risk' ? 'risk' : 'budget'),
  dynamicLeverage: (body as any).dynamicLeverage !== false,
  minLeverage: Math.min(Math.max(1, Number((body as any).minLeverage || 1)), Math.min(10, Math.max(1, body.maxLeverage ?? 4))),
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
                      aggressiveness: (['conservative','reactive','aggressive'].includes(String(body.aggressiveness)))
                        ? (body.aggressiveness as any)
                        : 'reactive',
                      userId: req.user!.id,
                      sizingMode: ((body as any).sizingMode === 'budget' || (body as any).sizingMode === 'risk')
                        ? (body as any).sizingMode
                        : (getConfig().SIZING_DEFAULT_MODE === 'risk' ? 'risk' : 'budget'),
                      dynamicLeverage: (body as any).dynamicLeverage !== false,
                      minLeverage: Math.min(Math.max(1, Number((body as any).minLeverage || 1)), Math.min(10, Math.max(1, body.maxLeverage ?? 4))),
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
      // In UNIT_TEST_MODE, skip network/LLM heavy background tasks to keep tests fast and silent
      if (process.env.UNIT_TEST_MODE === 'true') return;
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

        // Plan + arm (only if symbol is defined)
        if (symbol) {
          const plan = await proposePlan(symbol, { fresh: true, sessionId: s.id });
          // Persist LLM plan JSON on the session so we can re-arm after a reboot without re-calling LLM
          try { await savePlan(s.id, plan as any); } catch (err) { console.warn('Failed to persist plan', err); }
          const a = AgentHub.get(s.id);
          if (a) {
            await a.propose(plan as any);
            await a.validateAndArm();
          }
        } else {
          console.log(`⏳ Skipping plan generation - symbol not yet determined for Smart Agent ${s.id}`);
        }
      } catch {}
      try {
        // Strategy preview (only if symbol is defined)
        if (symbol) {
          const { strategy: strat, levels: lvls } = await requestStrategy({ symbol, trigger: 'activation', sessionId: s.id, fresh: true, force: true });
          broadcast('strategy', { ...(strat as any), levels: lvls }, s.symbol, s.id);
        } else {
          console.log(`⏳ Skipping strategy generation - symbol not yet determined for Smart Agent ${s.id}`);
        }
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

router.post('/restart', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const body = req.body as {
      sessionId?: string;
      riskPerTradePct?: number;
      maxLeverage?: number;
      dailyLossLimitPct?: number;
      budgetPct?: number;
      aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
      startBalanceUsd?: number;
      sizingMode?: 'risk'|'budget';
      dynamicLeverage?: boolean;
      minLeverage?: number;
    };

    const sessionId = body.sessionId;
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id_required' });
    }

    const existing = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!existing) {
      return res.status(404).json({ error: 'session_not_found' });
    }

    if (!existing.stoppedAt) {
      return res.status(400).json({ error: 'session_already_active' });
    }

    const currentProfile = ((existing as any).profileJson || {}) as Record<string, any>;

    const safeRiskPct = Math.min(5, Math.max(0.5, Number(body.riskPerTradePct ?? currentProfile.riskPerTradePct ?? 1.5)));
    const safeMaxLev = Math.min(10, Math.max(1, Number(body.maxLeverage ?? currentProfile.maxLeverage ?? 4)));
    const safeDailyLoss = Math.min(4, Math.max(3, Number(body.dailyLossLimitPct ?? currentProfile.dailyLossLimitPct ?? 3.5)));

    let budgetPctValue = Number(body.budgetPct ?? currentProfile.budgetPct ?? 100);
    if (!Number.isFinite(budgetPctValue) || budgetPctValue <= 0) budgetPctValue = 100;
    let budgetFraction = budgetPctValue;
    if (budgetFraction > 1) budgetFraction = budgetFraction / 100;
    budgetFraction = Math.min(1, Math.max(0.1, budgetFraction));
    const storedBudgetPct = Math.round(budgetFraction * 100);

    const requestedAggressiveness = body.aggressiveness ?? currentProfile.aggressiveness;
    const aggressiveness: 'conservative' | 'reactive' | 'aggressive' =
      requestedAggressiveness === 'conservative' || requestedAggressiveness === 'reactive' || requestedAggressiveness === 'aggressive'
        ? requestedAggressiveness
        : (currentProfile.aggressiveness ?? 'reactive');

    const startBal = typeof body.startBalanceUsd === 'number' && body.startBalanceUsd > 0
      ? body.startBalanceUsd
      : Number(existing.startBalanceUsd ?? currentProfile.startBalanceUsd ?? 0) || undefined;

    const updatedProfileJson = {
      ...currentProfile,
      riskPerTradePct: safeRiskPct,
      maxLeverage: safeMaxLev,
      dailyLossLimitPct: safeDailyLoss,
      budgetPct: storedBudgetPct,
      aggressiveness,
      startBalanceUsd: startBal,
      sizingMode: (body.sizingMode === 'budget' || body.sizingMode === 'risk')
        ? body.sizingMode
        : (currentProfile.sizingMode || (getConfig().SIZING_DEFAULT_MODE === 'risk' ? 'risk' : 'budget')),
      dynamicLeverage: body.dynamicLeverage !== undefined ? !!body.dynamicLeverage : (currentProfile.dynamicLeverage !== false),
      minLeverage: (()=>{ const m = Number(body.minLeverage ?? currentProfile.minLeverage ?? 1); return Math.max(1, Math.min(m, safeMaxLev)); })(),
      timestamp: new Date().toISOString()
    };

    const updateData: any = {
      stoppedAt: null,
      profileJson: updatedProfileJson as any,
    };
    if (typeof startBal === 'number') updateData.startBalanceUsd = startBal;

    const updated = await prisma.agentSession.update({
      where: { id: sessionId },
      data: updateData,
    });

    await setActiveSession(sessionId);

    const ownerUserId = updated.userId || req.user?.id || undefined;
    const agentProfile = {
      symbol: updated.symbol,
      mode: updated.mode as 'paper' | 'live',
      maxLeverage: safeMaxLev,
      riskPerTradePct: safeRiskPct,
      dailyLossLimitPct: safeDailyLoss,
      timestamp: new Date().toISOString(),
      startBalanceUsd: startBal,
      budgetFraction,
      aggressiveness,
      userId: ownerUserId,
      sizingMode: updatedProfileJson.sizingMode,
      dynamicLeverage: updatedProfileJson.dynamicLeverage,
      minLeverage: updatedProfileJson.minLeverage,
    } as any;

    await AgentHub.activate(sessionId, agentProfile).catch((err) => {
      console.error(`Failed to activate agent ${sessionId} on restart:`, err);
    });

    const agent = AgentHub.get(sessionId);
    let plan = extractPersistedPlan((updated as any).planJson);
    if (!plan && updated.symbol) {
      try {
        plan = await proposePlan(updated.symbol, { sessionId, fresh: true });
        if (plan) {
          await savePlan(sessionId, plan as any, { planMeta: { reason: 'restart' } });
        }
      } catch (error) {
        console.warn(`Failed to generate plan during restart for ${sessionId}:`, error);
      }
    }

    if (agent && plan) {
      try {
        await agent.propose(plan as any);
        await agent.validateAndArm();
      } catch (error) {
        console.warn(`Failed to re-arm agent ${sessionId} with persisted plan:`, error);
      }
    }

    if (updated.symbol) {
      try {
        const { strategy: strat, levels: lvls } = await requestStrategy({
          symbol: updated.symbol,
          trigger: 'restart',
          sessionId,
          fresh: true,
          force: true,
        });
        broadcast('strategy', { ...(strat as any), levels: lvls }, updated.symbol, sessionId);
      } catch (error) {
        console.warn(`Strategy refresh failed during restart for ${sessionId}:`, error);
      }
    }

    broadcast('session', { ...updated, stoppedAt: null }, updated.symbol, sessionId);
    res.json({ ...updated, stoppedAt: null });
  } catch (error) {
    console.error('agent_restart_failed:', error);
    res.status(500).json({
      error: 'agent_restart_failed',
      details: error instanceof Error ? error.message : String(error)
    });
  }
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
  
  // For smart agents, validate that the symbol meets volume requirements
  const isSmartAgent = (s as any).isSmartAgent || (s as any).profileJson?.isIntelligent || false;
  if (isSmartAgent) {
    try {
      const ticker = await getTicker(symbol);
      const volumeUsd = Number(ticker?.quoteVolume || 0) || (Number(ticker?.baseVolume || 0) * Number(ticker?.last || 0));
      
      const cfg = getConfig();
      const aggressiveness = (s as any).profileJson?.aggressiveness || 'reactive';
      const minVolume = aggressiveness === 'conservative' ? cfg.AUTO_MIN_USD_VOLUME_CONSERVATIVE :
                        aggressiveness === 'aggressive' ? cfg.AUTO_MIN_USD_VOLUME_AGGRESSIVE :
                        cfg.AUTO_MIN_USD_VOLUME_REACTIVE;
      
      if (volumeUsd < minVolume) {
        return res.status(400).json({ 
          error: 'insufficient_volume_for_smart_agent', 
          message: `Symbol ${symbol} has insufficient volume ($${volumeUsd.toLocaleString()}) for smart agent. Minimum required: $${minVolume.toLocaleString()}`,
          currentVolume: volumeUsd,
          requiredVolume: minVolume
        });
      }
      
      console.log(`✅ Smart agent symbol validation passed for ${symbol}: $${volumeUsd.toLocaleString()} >= $${minVolume.toLocaleString()}`);
    } catch (error) {
      console.warn(`⚠️ Could not validate volume for ${symbol}, proceeding anyway:`, error);
    }
  }
  
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
    // Prefer runtime aggressiveness from AgentHub when available
    let aggressiveness: any = 'reactive';
    try {
      const rt = AgentHub.get(r.id) as any;
      aggressiveness = rt?.profile?.aggressiveness || profile?.aggressiveness || 'reactive';
    } catch {
      aggressiveness = profile?.aggressiveness || 'reactive';
    }
    
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
  const cacheKey = `${req.user?.id || 'legacy'}:${modeFilter || 'all'}`;
  try {
    const c = overviewCache.get(cacheKey);
    if (c && (Date.now() - c.ts) < OVERVIEW_TTL_MS) {
      return res.json(c.data);
    }
  } catch {}
  const pending = overviewPending.get(cacheKey);
  if (pending) {
    try {
      const data = await pending;
      return res.json(data);
    } catch (error) {
      overviewPending.delete(cacheKey);
      throw error;
    }
  }
  const buildPromise = (async () => {
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

    // Calculate global win rate across all agents (not average of individual win rates)
    const totalWins = actives.reduce((sum, a)=> sum + Number((a.kpi?.stats as any)?.wins || 0), 0);
    const totalTrades = actives.reduce((sum, a)=> sum + Number((a.kpi?.stats as any)?.trades || 0), 0);
    const avgWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

    // Get live exchange balance for authenticated users
    let exchangeBalance: any = null;
    if (!req.user?.isLegacy && req.user?.id && (modeFilter === 'live' || !modeFilter)) {
      try {
        const userCredentials = await getUserCredentials(req.user.id);
        if (userCredentials) {
          // 🚀 WebSocket for Binance (0 weight)
          let balance: any;
          let exchange: any = null;
          if (userCredentials.exchange === 'binance') {
            try {
              const { getBalanceFromWebSocket, subscribeToUserData, seedBalanceCache, runExclusiveBalanceFetch } = await import('../services/binanceWebSocket.js');
              await subscribeToUserData(req.user.id, userCredentials.apiKey, userCredentials.apiSecret);
              const wsBalance = await getBalanceFromWebSocket(req.user.id, 'USDT');
              if (wsBalance) {
                balance = {
                  total: { USD: 0, USDT: wsBalance.total },
                  free: { USD: 0, USDT: wsBalance.free },
                  used: { USD: 0, USDT: wsBalance.locked }
                };
                console.log(`✅ [WebSocket] Balance fetched for dashboard - 0 weight`);
              } else {
                exchange = await getUserExchange(req.user.id, userCredentials);
                balance = await runExclusiveBalanceFetch(req.user.id, 'USDT', () => exchange.fetchBalance());
                console.log(`⚠️ [REST] Balance fetched for dashboard - 40 weight`);
                try {
                  const total = Number(balance?.total?.USDT ?? 0);
                  const free = Number(balance?.free?.USDT ?? 0);
                  const locked = Number(balance?.used?.USDT ?? 0);
                  if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
                    seedBalanceCache(req.user.id, 'USDT', { total, free, locked });
                  }
                } catch {}
              }
            } catch (error) {
              console.warn('⚠️ WebSocket balance failed for dashboard, using REST:', error);
              exchange = await getUserExchange(req.user.id, userCredentials);
              const { runExclusiveBalanceFetch, seedBalanceCache } = await import('../services/binanceWebSocket.js');
              balance = await runExclusiveBalanceFetch(req.user.id, 'USDT', () => exchange.fetchBalance());
              try {
                const total = Number(balance?.total?.USDT ?? 0);
                const free = Number(balance?.free?.USDT ?? 0);
                const locked = Number(balance?.used?.USDT ?? 0);
                if (Number.isFinite(total) || Number.isFinite(free) || Number.isFinite(locked)) {
                  seedBalanceCache(req.user.id, 'USDT', { total, free, locked });
                }
              } catch {}
            }
          } else {
            exchange = await getUserExchange(req.user.id, userCredentials);
            balance = await exchange.fetchBalance();
          }

          // Extract USD balances (compatible with Crypto.com response) - now includes USDC
          const totalUsd = Number(balance?.total?.USD || 0) + Number(balance?.total?.USDT || 0) + Number(balance?.total?.USDC || 0);
          const freeUsd = Number(balance?.free?.USD || 0) + Number(balance?.free?.USDT || 0) + Number(balance?.free?.USDC || 0);
          const usedUsd = Number(balance?.used?.USD || 0) + Number(balance?.used?.USDT || 0) + Number(balance?.used?.USDC || 0);

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

    // Get aggregated paper balance from ALL active paper sessions (derived from session KPIs)
    let paperBalance: any = null;
    if (modeFilter === 'paper' || !modeFilter) {
      const paperSessions = actives.filter(session => session.mode === 'paper');
      if (paperSessions.length > 0) {
        const startSum = paperSessions.reduce((s, ps)=> s + Number(ps.startBalanceUsd || 0), 0);
        const pnlSum = paperSessions.reduce((s, ps)=> s + Number(ps.kpi?.realizedPnlUsd || 0) + Number(ps.kpi?.unrealizedPnlUsd || 0), 0);
        const eq = startSum + pnlSum;
        paperBalance = {
          equityUsd: eq,
          freeUsd: eq,          // paper accounts are unconstrained; no reserved margin stored here
          committedUsd: 0,
          agentsCount: paperSessions.length,
          lastUpdated: new Date().toISOString()
        };
        console.log(`📊 Total Paper Balance (derived): $${eq.toFixed(2)} USD from ${paperSessions.length} agents`);
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

    const payload = {
      activeCount: actives.length,
      sessionsCount: totalSessions,
      symbols,
      pnlUsd,
      capitalStartUsd,
      equityUsd: Number(capitalStartUsd) + Number(pnlUsd),
      roiPct,
      avgWinRate,
      aiCallsTotal,
      exchangeBalance,
      paperBalance,
      sessions: sessionsData, // ✅ Ajout des sessions dans la réponse
      updatedAt: new Date().toISOString(),
    };
    return payload;
  })();

  overviewPending.set(cacheKey, buildPromise);

  try {
    const payload = await buildPromise;
    try { overviewCache.set(cacheKey, { ts: Date.now(), data: payload }); } catch {}
    res.json(payload);
  } finally {
    overviewPending.delete(cacheKey);
  }
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
    
    let diagnostics = await (agent as any).getDiagnostics();
    // Safety: ensure trigger.entryReady exists for integration tests
    try {
      const t = (diagnostics as any)?.trigger;
      if (!t || typeof t.entryReady !== 'boolean') {
        const fallback = {
          entryReady: false,
          phase: 'unknown',
          bias: (agent as any)?.plan?.bias || 'none',
          price: undefined,
          zone: (agent as any)?.plan?.zone || null,
          inZone: false,
          confirmationOk: false,
          momentumOk: false,
          qualityOk: false,
          profitOk: false,
          tp1ProfitPct: 0,
          minProfitPct: (await import('../utils/env.js')).getConfig().MIN_TRADE_PROFIT_PCT,
          dir: ((agent as any)?.plan?.bias === 'short') ? -1 : 1,
        };
        diagnostics = { ...(diagnostics||{}), trigger: fallback };
      }
    } catch {}
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
