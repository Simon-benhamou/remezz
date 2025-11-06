import { Router, type Response } from 'express';
import { authenticateUser, AuthenticatedRequest, requireRole } from '../middleware/auth.js';
import { prisma } from '../db/client.js';
import { getAllIntelligentOpportunities, getIntelligentAgentStatus } from '../services/smartAgent.js';
import { triggerIntelligentReselection } from '../services/intelligentAgent.js';
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
import { resolveBudgetFraction } from '../utils/budget.js';
import { resolveLeverageCap } from '../risk/leverageCaps.js';
import {
  prepareAgentCreation,
  createSessionFromPrepared,
  activatePreparedAgent,
  startAgentCreation,
  PhaseError,
} from '../services/agentCreationFlow.js';
import { stopSession, activeSession } from '../session/session.js';
import { getUserExchange } from '../exchange/ccxtClient.js';
import { getUserCredentials } from '../services/userCredentials.js';
import { stopAllAgents } from '../services/stopAllAgents.js';
import { resolveRrExpectancyConfig } from '../risk/rrExpectancy.js';
import { getPortfolioSnapshot, updatePortfolioBalance, rebalancePortfolio } from '../services/portfolioManager.js';
import { resolveStrategySnapshot } from '../utils/strategySnapshot.js';
import { getBalanceSnapshot, updateLiveExchangeBalance } from '../services/capitalPool.js';
import type { BalanceSnapshot } from '../core/capital/types.js';

export const router = Router();

// Lightweight cache for /overview to improve dashboard/header refresh
const OVERVIEW_TTL_MS = 3000;
const overviewCache = new Map<string, { ts: number; data: any }>();
const overviewPending = new Map<string, Promise<any>>();

function invalidateOverviewCaches() {
  overviewCache.clear();
  overviewPending.clear();
}

type RequestUser = AuthenticatedRequest['user'];

function isAdminUser(user?: RequestUser | null): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.isLegacy === true;
}

function canAccessSessionOwner(session: { userId?: string | null }, user?: RequestUser | null): boolean {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  if (!session.userId) return false;
  return session.userId === user.id;
}

function logUnauthorizedSessionAccess(
  logger: Pick<typeof console, 'warn'>,
  context: { action: string; sessionId?: string | null; user?: RequestUser | null },
) {
  const userTag = context.user ? `${context.user.id}:${context.user.role}` : 'anonymous';
  logger.warn?.(
    `🚫 [SECURITY] Unauthorized session access attempt during ${context.action} by ${userTag}${
      context.sessionId ? ` on session ${context.sessionId}` : ''
    }`,
  );
}

function securityErrorResponse(res: Response, code: string, message: string, status: number) {
  return res.status(status).json({ ok: false, code, message });
}

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

router.get('/portfolio', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(403).json({ ok: false, code: 'auth_required' });
  }
  const modeRaw = typeof req.query.mode === 'string' ? req.query.mode.toLowerCase() : 'paper';
  const mode = modeRaw === 'live' ? 'live' : 'paper';
  try {
    const snapshot = await getPortfolioSnapshot(req.user.id, mode);
    return res.json(snapshot);
  } catch (error) {
    console.error('Failed to fetch portfolio snapshot:', error);
    return res.status(500).json({ ok: false, error: 'portfolio_snapshot_failed' });
  }
});

router.post('/portfolio/balance', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(403).json({ ok: false, code: 'auth_required' });
  }
  const body = req.body || {};
  const modeRaw = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'paper';
  const mode = modeRaw === 'live' ? 'live' : 'paper';
  const balanceValue = Number(body.balanceUsd);
  if (!Number.isFinite(balanceValue) || balanceValue < 0) {
    return res.status(400).json({ ok: false, code: 'invalid_balance' });
  }
  try {
    await updatePortfolioBalance(req.user.id, mode, balanceValue);
    invalidateOverviewCaches();
    const snapshot = await getPortfolioSnapshot(req.user.id, mode);
    return res.json({ ok: true, snapshot });
  } catch (error) {
    console.error('Failed to update portfolio balance:', error);
    return res.status(500).json({ ok: false, error: 'portfolio_balance_update_failed' });
  }
});

router.post('/portfolio/rebalance', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user?.id) {
    return res.status(403).json({ ok: false, code: 'auth_required' });
  }
  const body = req.body || {};
  const modeRaw = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'paper';
  const mode = modeRaw === 'live' ? 'live' : 'paper';
  try {
    const snapshot = await rebalancePortfolio({ userId: req.user.id, mode, reason: 'manual_rebalance' });
    invalidateOverviewCaches();
    return res.json({ ok: true, snapshot });
  } catch (error) {
    console.error('Failed to rebalance portfolio:', error);
    return res.status(500).json({ ok: false, error: 'portfolio_rebalance_failed' });
  }
});

function handleCreationError(res: Response, error: unknown) {
  if (error instanceof PhaseError) {
    const code = error.code;
    const status =
      code === 'start.validation_failed'
        ? 400
        : code === 'start.universe_conflict' || code === 'start.universe_empty'
        ? 409
        : code === 'start.context_not_found' || code === 'start.session_missing'
        ? 404
        : 500;
    return res.status(status).json({ error: code, message: error.message, details: error.details });
  }
  console.error('❌ Agent creation error:', error);
  return res.status(500).json({
    error: 'start.unexpected_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

router.post('/start', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await startAgentCreation(req.body ?? {}, req.user?.id);
    res.status(201).json(result);
  } catch (error) {
    handleCreationError(res, error);
  }
});

router.post('/start-agent', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await startAgentCreation(req.body ?? {}, req.user?.id);
    res.status(201).json(result);
  } catch (error) {
    handleCreationError(res, error);
  }
});

router.patch('/:id', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return securityErrorResponse(res, 'auth_required', 'Authentication required', 401);
  }

  const sessionId = String(req.params.id || '').trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, code: 'session_id_required', message: 'Session identifier is required' });
  }

  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      profileJson: true,
      rrFloor: true,
      rrCeil: true,
      rrBaseMin: true,
      rrExpectancy: true,
    },
  });

  if (!session) {
    return res.status(404).json({ ok: false, code: 'session_not_found', message: 'Session not found' });
  }

  if (!canAccessSessionOwner(session, req.user)) {
    logUnauthorizedSessionAccess(console, { action: 'agent.patch_rr', sessionId, user: req.user });
    return securityErrorResponse(res, 'session_forbidden', 'You are not allowed to modify this session', 403);
  }

  const body = (req.body || {}) as {
    rrFloor?: number;
    rrCeil?: number;
    rrBaseMin?: number;
    rrExpectancy?: {
      enabled?: boolean;
      minTrades?: number;
      lookbackDays?: number;
      decay?: number;
      safetyMult?: number;
      blend?: number;
      hysteresis?: number;
    };
  };

  const currentConfig = resolveRrExpectancyConfig({
    rrFloor: session.rrFloor ?? undefined,
    rrCeil: session.rrCeil ?? undefined,
    rrBaseMin: session.rrBaseMin ?? undefined,
    rrExpectancy: session.rrExpectancy ?? undefined,
  });

  const floorCandidate = body.rrFloor ?? currentConfig.rrFloor;
  const ceilCandidate = body.rrCeil ?? currentConfig.rrCeil;
  const baseCandidate = body.rrBaseMin ?? currentConfig.rrBaseMin;
  if (floorCandidate < 0.5 || floorCandidate > 5) {
    return res.status(400).json({ ok: false, code: 'invalid_rr_floor', message: 'rrFloor must be between 0.5 and 5.0' });
  }
  if (ceilCandidate <= floorCandidate || ceilCandidate > 5) {
    return res.status(400).json({ ok: false, code: 'invalid_rr_ceil', message: 'rrCeil must be greater than rrFloor and ≤ 5.0' });
  }
  if (baseCandidate < floorCandidate || baseCandidate > ceilCandidate) {
    return res.status(400).json({ ok: false, code: 'invalid_rr_base', message: 'rrBaseMin must lie between rrFloor and rrCeil' });
  }

  const expectancyPayload = body.rrExpectancy ?? {};
  if (expectancyPayload.minTrades != null && expectancyPayload.minTrades < 1) {
    return res.status(400).json({ ok: false, code: 'invalid_min_trades', message: 'minTrades must be ≥ 1' });
  }
  if (expectancyPayload.lookbackDays != null && expectancyPayload.lookbackDays < 1) {
    return res.status(400).json({ ok: false, code: 'invalid_lookback_days', message: 'lookbackDays must be ≥ 1' });
  }
  if (expectancyPayload.decay != null && (expectancyPayload.decay <= 0 || expectancyPayload.decay > 1)) {
    return res.status(400).json({ ok: false, code: 'invalid_decay', message: 'decay must be in (0, 1]' });
  }
  if (expectancyPayload.blend != null && (expectancyPayload.blend < 0 || expectancyPayload.blend > 1)) {
    return res.status(400).json({ ok: false, code: 'invalid_blend', message: 'blend must be between 0 and 1' });
  }
  if (expectancyPayload.hysteresis != null && (expectancyPayload.hysteresis < 0 || expectancyPayload.hysteresis > 0.2)) {
    return res.status(400).json({ ok: false, code: 'invalid_hysteresis', message: 'hysteresis must be between 0 and 0.2' });
  }
  if (expectancyPayload.safetyMult != null && (expectancyPayload.safetyMult <= 0 || expectancyPayload.safetyMult > 3)) {
    return res.status(400).json({ ok: false, code: 'invalid_safety_mult', message: 'safetyMult must be > 0 and ≤ 3' });
  }

  const nextConfig = resolveRrExpectancyConfig({
    rrFloor: floorCandidate,
    rrCeil: ceilCandidate,
    rrBaseMin: baseCandidate,
    rrExpectancy: {
      enabled: expectancyPayload.enabled ?? currentConfig.enabled,
      minTrades: expectancyPayload.minTrades ?? currentConfig.minTrades,
      lookbackDays: expectancyPayload.lookbackDays ?? currentConfig.lookbackDays,
      decay: expectancyPayload.decay ?? currentConfig.decay,
      safetyMult: expectancyPayload.safetyMult ?? currentConfig.safetyMult,
      blend: expectancyPayload.blend ?? currentConfig.blend,
      hysteresis: expectancyPayload.hysteresis ?? currentConfig.hysteresis,
    },
  });

  const existingProfile = (session.profileJson as any) || {};
  const updatedProfile = {
    ...existingProfile,
    rrFloor: nextConfig.rrFloor,
    rrCeil: nextConfig.rrCeil,
    rrBaseMin: nextConfig.rrBaseMin,
    rrExpectancy: {
      enabled: nextConfig.enabled,
      minTrades: nextConfig.minTrades,
      lookbackDays: nextConfig.lookbackDays,
      decay: nextConfig.decay,
      safetyMult: nextConfig.safetyMult,
      blend: nextConfig.blend,
      hysteresis: nextConfig.hysteresis,
    },
  };

  await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      rrFloor: nextConfig.rrFloor,
      rrCeil: nextConfig.rrCeil,
      rrBaseMin: nextConfig.rrBaseMin,
      rrExpectancy: updatedProfile.rrExpectancy,
      profileJson: updatedProfile,
    },
  });

  const agent = AgentHub.get(sessionId);
  if (agent && typeof agent.updateRrExpectancySettings === 'function') {
    try {
      agent.updateRrExpectancySettings({
        rrFloor: nextConfig.rrFloor,
        rrCeil: nextConfig.rrCeil,
        rrBaseMin: nextConfig.rrBaseMin,
        rrExpectancy: updatedProfile.rrExpectancy,
      });
    } catch (error) {
      console.warn(`⚠️ Failed to update in-memory RR expectancy for session ${sessionId}:`, error);
    }
  }

  return res.json({
    ok: true,
    rrFloor: nextConfig.rrFloor,
    rrCeil: nextConfig.rrCeil,
    rrBaseMin: nextConfig.rrBaseMin,
    rrExpectancy: updatedProfile.rrExpectancy,
  });
});

router.get('/start-status', authenticateUser, async (_req: AuthenticatedRequest, res) => {
  res.status(410).json({
    error: 'job_tracking_removed',
    message: 'Agent start jobs are now handled synchronously. Please use the new creation endpoints.',
  });
});

router.post('/creation/prepare', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await prepareAgentCreation(req.body ?? {}, req.user?.id);
    res.json(result);
  } catch (error) {
    handleCreationError(res, error);
  }
});

router.post('/creation/create-session', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const creationId = String((req.body as any)?.creationId || '');
    const symbol = typeof (req.body as any)?.symbol === 'string' ? (req.body as any).symbol : undefined;
    if (!creationId) {
      return res.status(400).json({ error: 'creation_id_required' });
    }
    const result = await createSessionFromPrepared(creationId, symbol ? { symbol } : undefined);
    res.status(201).json(result);
  } catch (error) {
    handleCreationError(res, error);
  }
});

router.post('/creation/activate', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const creationId = String((req.body as any)?.creationId || '');
    if (!creationId) {
      return res.status(400).json({ error: 'creation_id_required' });
    }
    const result = await activatePreparedAgent(creationId);
    res.json(result);
  } catch (error) {
    handleCreationError(res, error);
  }
});

type StopRouteAgentHub = {
  get?: (sessionId: string) => any;
  closeNow: (sessionId: string, reason?: string) => Promise<void> | void;
  halt: (sessionId: string, mode?: 'entries_only' | 'full') => Promise<void> | void;
};

type StopRouteDependencies = {
  prismaClient: typeof prisma;
  agentHub: StopRouteAgentHub;
  stopSessionFn: typeof stopSession;
  activeSessionFn?: typeof activeSession;
  broadcastFn: typeof broadcast;
  logger?: Pick<typeof console, 'error' | 'warn'>;
};

export function createStopRouteHandler({
  prismaClient,
  agentHub,
  stopSessionFn,
  activeSessionFn,
  broadcastFn,
  logger = console,
}: StopRouteDependencies) {
  return async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      return securityErrorResponse(res, 'auth_required', 'Authentication required', 401);
    }

    const { sessionId, closePosition } = (req.body || {}) as { sessionId?: string; closePosition?: boolean };
    const isAdmin = isAdminUser(req.user);

    let session: Awaited<ReturnType<typeof prisma.agentSession.findUnique>> | null = null;
    if (sessionId) {
      session = await prismaClient.agentSession.findUnique({ where: { id: sessionId } });
      if (!session) {
        return securityErrorResponse(res, 'session_not_found', 'Session not found', 404);
      }
    } else if (activeSessionFn) {
      session = await prismaClient.agentSession.findFirst({
        where: {
          stoppedAt: null,
          ...(isAdmin ? {} : { userId: req.user.id }),
        },
        orderBy: { startedAt: 'desc' },
      });
      if (!session) {
        return securityErrorResponse(res, 'no_active_session', 'No active session available for this account', 404);
      }
    }

    if (!session) {
      return securityErrorResponse(res, 'session_missing', 'Session context is required', 400);
    }

    if (!canAccessSessionOwner(session, req.user)) {
      logUnauthorizedSessionAccess(logger, { action: 'agent.stop', sessionId: session.id, user: req.user });
      return securityErrorResponse(res, 'session_forbidden', 'You are not allowed to control this session', 403);
    }

    const errors: Array<{ phase: string; error: string }> = [];
    const agent = typeof agentHub.get === 'function' ? agentHub.get(session.id) : null;
    const brokerName =
      ((agent as any)?.broker?.id as string | undefined) ||
      ((agent as any)?.broker?.name as string | undefined) ||
      session.mode ||
      'unknown';

    let closeFailure: { phase: string; error: string; broker: string } | null = null;

    if (closePosition) {
      try {
        await agentHub.closeNow(session.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        closeFailure = { phase: 'closeNow', error: message, broker: String(brokerName) };
        logger.error?.(`❌ Failed to close active position for session ${session.id}:`, error);
      }
    }

    try {
      await stopSessionFn(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ phase: 'stopSession', error: message });
      logger.error?.(`❌ stopSession failed for ${session.id}:`, error);
    }

    try {
      broadcastFn('session', { ...session, stoppedAt: new Date().toISOString() }, session.symbol, session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ phase: 'broadcast', error: message });
      logger.error?.(`❌ broadcast failed during stop for ${session.id}:`, error);
    }

    try {
      await agentHub.halt(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ phase: 'halt', error: message });
      logger.error?.(`❌ halt failed for ${session.id}:`, error);
    }

    invalidateOverviewCaches();

    if (closeFailure) {
      return res.status(502).json({
        ok: false,
        code: 'agent_close_failed',
        message: 'Broker rejected the immediate close request',
        phase: closeFailure.phase,
        error: closeFailure.error,
        broker: closeFailure.broker,
        sessionId: session.id,
        errors: errors.length ? errors : undefined,
      });
    }

    if (errors.length) {
      return res.status(500).json({
        ok: false,
        code: 'agent_stop_partial_failure',
        message: 'Agent stop completed with errors',
        sessionId: session.id,
        errors,
      });
    }

    return res.json({ ok: true, sessionId: session.id });
  };
}

router.post(
  '/stop',
  authenticateUser,
  createStopRouteHandler({
    prismaClient: prisma,
    agentHub: AgentHub,
    stopSessionFn: stopSession,
    broadcastFn: broadcast,
  }),
);

router.post('/stop-all', authenticateUser, requireRole(['admin']), async (req: AuthenticatedRequest, res) => {
  try {
    const outcome = await stopAllAgents({
      actorId: req.user?.id,
      actorUsername: req.user?.username,
      reason: 'stop_all',
    });

    invalidateOverviewCaches();

    const updatedSessions = outcome.updatedSessions.length
      ? outcome.updatedSessions
      : outcome.stoppedSessionIds.length
        ? await prisma.agentSession.findMany({ where: { id: { in: outcome.stoppedSessionIds } } })
        : [];

    for (const session of updatedSessions) {
      broadcast('session', session, session.symbol, session.id);
    }

    broadcast('agent_stop_all', {
      ts: new Date().toISOString(),
      actor: req.user?.username || null,
      sessionIds: outcome.stoppedSessionIds,
      results: outcome.results,
    });

    res.json({
      ok: true,
      stopped: outcome.stoppedSessionIds.length,
      results: outcome.results,
      auditLogId: outcome.auditLogId,
    });
  } catch (error) {
    console.error('❌ Stop-all error:', error);
    res.status(500).json({
      error: 'stop_all_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
      strategyEngine?: 'meta_adaptive';
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

    const leverageCap = await resolveLeverageCap({
      symbol: existing.symbol,
      requestedMaxLeverage: safeMaxLev,
      mode: existing.mode as 'paper' | 'live',
    });
    const resolvedMaxLev = leverageCap.resolved;

    let budgetPctValue = Number(body.budgetPct ?? currentProfile.budgetPct ?? 100);
    if (!Number.isFinite(budgetPctValue) || budgetPctValue <= 0) budgetPctValue = 100;
    let budgetFractionInput = budgetPctValue;
    if (budgetFractionInput > 1) budgetFractionInput = budgetFractionInput / 100;
    const budgetFraction = resolveBudgetFraction(budgetFractionInput);
    const storedBudgetPct = Math.round(budgetFraction * 100);

    const requestedAggressiveness = body.aggressiveness ?? currentProfile.aggressiveness;
    const aggressiveness: 'conservative' | 'reactive' | 'aggressive' =
      requestedAggressiveness === 'conservative' || requestedAggressiveness === 'reactive' || requestedAggressiveness === 'aggressive'
        ? requestedAggressiveness
        : (currentProfile.aggressiveness ?? 'reactive');

    const startBal = typeof body.startBalanceUsd === 'number' && body.startBalanceUsd > 0
      ? body.startBalanceUsd
      : Number(existing.startBalanceUsd ?? currentProfile.startBalanceUsd ?? 0) || undefined;

    const strategyEngine = 'meta_adaptive';

    const updatedProfileJson = {
      ...currentProfile,
      riskPerTradePct: safeRiskPct,
      maxLeverage: resolvedMaxLev,
      requestedMaxLeverage: safeMaxLev,
      leverageCap,
      dailyLossLimitPct: safeDailyLoss,
      budgetPct: storedBudgetPct,
      budgetFraction,
      aggressiveness,
      startBalanceUsd: startBal,
      sizingMode: (body.sizingMode === 'budget' || body.sizingMode === 'risk')
        ? body.sizingMode
        : (currentProfile.sizingMode || (getConfig().SIZING_DEFAULT_MODE === 'risk' ? 'risk' : 'budget')),
      dynamicLeverage: body.dynamicLeverage !== undefined ? !!body.dynamicLeverage : (currentProfile.dynamicLeverage !== false),
      minLeverage: (()=>{ const m = Number(body.minLeverage ?? currentProfile.minLeverage ?? 1); return Math.max(1, Math.min(m, resolvedMaxLev)); })(),
      strategyEngine,
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
      maxLeverage: resolvedMaxLev,
      requestedMaxLeverage: safeMaxLev,
      leverageCap,
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
      strategyEngine,
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

    // Skip plan restoration - not used in meta-adaptive

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
router.get('/sessions/:id/smart-status', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return securityErrorResponse(res, 'auth_required', 'Authentication required', 401);
  }

  try {
    const sessionId = req.params.id;
    const session = await prisma.agentSession.findUnique({ where: { id: sessionId }, select: { id: true, userId: true } });
    if (!session) {
      return res.status(404).json({ ok: false, code: 'session_not_found', message: 'Session not found' });
    }
    if (!canAccessSessionOwner(session, req.user)) {
      logUnauthorizedSessionAccess(console, { action: 'agent.smart-status', sessionId, user: req.user });
      return securityErrorResponse(res, 'session_forbidden', 'You are not allowed to inspect this session', 403);
    }

    const status = await getIntelligentAgentStatus(sessionId);

    if (!status) {
      return res.json({ ok: true, isSmartAgent: false });
    }

    res.json({ ok: true, ...status });
  } catch (error) {
    console.error('Error getting intelligent agent status:', error);
    res.status(500).json({ ok: false, code: 'smart_status_error', message: 'Failed to get intelligent agent status' });
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
router.post('/set-symbol', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return securityErrorResponse(res, 'auth_required', 'Authentication required', 401);
  }

  const { symbol, sessionId } = req.body as { symbol: string; sessionId: string };
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ ok: false, code: 'session_id_required', message: 'sessionId is required' });
  }

  const s = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!s) {
    return res.status(404).json({ ok: false, code: 'session_not_found', message: 'Session not found' });
  }

  if (!canAccessSessionOwner(s, req.user)) {
    logUnauthorizedSessionAccess(console, { action: 'agent.set-symbol', sessionId, user: req.user });
    return securityErrorResponse(res, 'session_forbidden', 'You are not allowed to modify this session', 403);
  }

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
  invalidateOverviewCaches();
  res.json({ ok: true, session: upd });
});

// Clear circuit breaker cooldown for an agent
router.post('/clear-cooldown', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return securityErrorResponse(res, 'auth_required', 'Authentication required', 401);
  }

  const { sessionId } = req.body as { sessionId: string };
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ ok: false, code: 'session_id_required', message: 'sessionId is required' });
  }

  const s = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!s) {
    return res.status(404).json({ ok: false, code: 'session_not_found', message: 'Session not found' });
  }

  if (!canAccessSessionOwner(s, req.user)) {
    logUnauthorizedSessionAccess(console, { action: 'agent.clear-cooldown', sessionId, user: req.user });
    return securityErrorResponse(res, 'session_forbidden', 'You are not allowed to modify this session', 403);
  }

  const agent = AgentHub.get(sessionId);
  if (!agent) {
    return res.status(404).json({ ok: false, code: 'agent_not_active', message: 'Agent is not currently running' });
  }

  // Clear the cooldown
  (agent as any).circuitBreaker?.clearCooldown();

  const state = (agent as any).circuitBreaker?.getState() || {};
  
  res.json({ 
    ok: true, 
    message: 'Circuit breaker cooldown cleared',
    circuitBreakerState: state
  });
});

// AI calls count for current session
router.get('/ai-calls', async (req,res)=>{
  const sessionId = String(req.query.sessionId || '');
  res.json({ count: await getAICallsCount(sessionId || undefined) });
});

// Basic status endpoint
router.get('/state', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return securityErrorResponse(res, 'auth_required', 'Authentication required', 401);
  }

  let sessionId = String(req.query.sessionId || '').trim();
  const isAdmin = isAdminUser(req.user);
  let sessionRecord: {
    id: string;
    userId: string | null;
    profileJson: unknown;
    rrFloor: number | null;
    rrCeil: number | null;
    rrBaseMin: number | null;
    rrExpectancy: unknown;
  } | null = null;

  if (sessionId) {
    sessionRecord = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, profileJson: true, rrFloor: true, rrCeil: true, rrBaseMin: true, rrExpectancy: true },
    });
    if (!sessionRecord) {
      return res.status(404).json({ ok: false, code: 'session_not_found', message: 'Session not found' });
    }
    if (!canAccessSessionOwner(sessionRecord, req.user)) {
      logUnauthorizedSessionAccess(console, { action: 'agent.state', sessionId, user: req.user });
      return securityErrorResponse(res, 'session_forbidden', 'You are not allowed to inspect this session', 403);
    }
  } else {
    sessionRecord = await prisma.agentSession.findFirst({
      where: {
        stoppedAt: null,
        ...(isAdmin ? {} : { userId: req.user.id }),
      },
      select: { id: true, userId: true, profileJson: true, rrFloor: true, rrCeil: true, rrBaseMin: true, rrExpectancy: true },
      orderBy: { startedAt: 'desc' },
    });
    if (!sessionRecord) {
      return res.status(404).json({ ok: false, code: 'no_active_session', message: 'No managed session for this account' });
    }
    sessionId = sessionRecord.id;
  }

  const agent = sessionId ? AgentHub.get(sessionId) : null;
  let balance: any = null;
  try {
    balance = await (agent as any)?.broker?.balance?.();
  } catch {}
  let profile = (agent as any)?.profile || null;
  if (!profile) {
    profile = (sessionRecord?.profileJson as any) || null;
  }

  const strategySnapshot = await resolveStrategySnapshot(
    agent,
    (profile && typeof profile === 'object' ? profile : sessionRecord?.profileJson) as Record<string, any> | null,
    { includeChecklist: true },
  );
  const rrConfig = resolveRrExpectancyConfig({
    rrFloor: (profile as any)?.rrFloor ?? sessionRecord?.rrFloor ?? undefined,
    rrCeil: (profile as any)?.rrCeil ?? sessionRecord?.rrCeil ?? undefined,
    rrBaseMin: (profile as any)?.rrBaseMin ?? sessionRecord?.rrBaseMin ?? undefined,
    rrExpectancy: (profile as any)?.rrExpectancy ?? sessionRecord?.rrExpectancy ?? undefined,
  });
  if (profile && typeof profile === 'object') {
    (profile as any).rrFloor = rrConfig.rrFloor;
    (profile as any).rrCeil = rrConfig.rrCeil;
    (profile as any).rrBaseMin = rrConfig.rrBaseMin;
    (profile as any).rrExpectancy = {
      enabled: rrConfig.enabled,
      minTrades: rrConfig.minTrades,
      lookbackDays: rrConfig.lookbackDays,
      decay: rrConfig.decay,
      safetyMult: rrConfig.safetyMult,
      blend: rrConfig.blend,
      hysteresis: rrConfig.hysteresis,
    };
  }

  res.json({
    ok: true,
    sessionId,
    state: agent?.state,
    profile,
    plan: agent?.plan,
    pos: agent?.pos,
    balance,
    aiMetrics: await getAIMetrics(sessionId || undefined),
    rrFloor: rrConfig.rrFloor,
    rrCeil: rrConfig.rrCeil,
    rrBaseMin: rrConfig.rrBaseMin,
    rrExpectancy: {
      enabled: rrConfig.enabled,
      minTrades: rrConfig.minTrades,
      lookbackDays: rrConfig.lookbackDays,
      decay: rrConfig.decay,
      safetyMult: rrConfig.safetyMult,
      blend: rrConfig.blend,
      hysteresis: rrConfig.hysteresis,
    },
    strategy: strategySnapshot,
    strategyEngine: strategySnapshot.engine,
  });
});

// Sessions list
router.get('/sessions', authenticateUser, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    return securityErrorResponse(res, 'auth_required', 'Authentication required', 401);
  }

  const modeRaw = String(req.query.mode || '').toLowerCase();
  const modeFilter = modeRaw === 'live' || modeRaw === 'paper' ? modeRaw : undefined;
  const includeStats = req.query.includeStats === 'true';
  const isAdmin = isAdminUser(req.user);

  const where: Record<string, unknown> = {};
  if (modeFilter) {
    where.mode = modeFilter;
  }
  if (!isAdmin) {
    where.userId = req.user.id;
  }

  // Base query without heavy includes for better performance
  const baseQuery = {
    where: Object.keys(where).length ? where : undefined,
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
      ...(includeStats
        ? {
            kpi: {
              select: {
                realizedPnlUsd: true,
                unrealizedPnlUsd: true,
                roiPct: true,
                winRate: true,
              },
            },
            positions: {
              select: {
                qty: true,
              },
              where: {
                qty: { gt: 0 },
              },
            },
          }
        : {}),
    },
  };

  const rows = await prisma.agentSession.findMany(baseQuery);

  const out = await Promise.all(rows.map(async (r) => {
    const profile = ((r as any).profileJson || {}) as Record<string, any>;
    let agent: any = null;
    try {
      agent = AgentHub.get(r.id);
    } catch {}

    let aggressiveness: any = 'reactive';
    if (agent?.profile?.aggressiveness) {
      aggressiveness = agent.profile.aggressiveness;
    } else if (typeof profile.aggressiveness === 'string') {
      aggressiveness = profile.aggressiveness;
    }

    const strategySnapshot = await resolveStrategySnapshot(agent, profile, { includeChecklist: false });

    // Only calculate stats if included
    let stats = {} as Record<string, unknown>;
    if (includeStats && (r as any).kpi) {
      const realized = Number((r as any).kpi?.realizedPnlUsd || 0);
      const unrealized = Number((r as any).kpi?.unrealizedPnlUsd || 0);
      const start = Number(r.startBalanceUsd || 0);
      const realizedRoi = Number((r as any).kpi?.roiPct || (start > 0 ? (realized / start) * 100 : 0));
      const netRoiPct = Number(((r as any).kpi?.stats as any)?.netRoiPct ?? (start > 0 ? ((realized + unrealized) / start) * 100 : realizedRoi));
      stats = {
        pnlUsd: realized + unrealized,
        roiPct: realizedRoi,
        netRoiPct,
        winRate: Number((r as any).kpi?.winRate || 0),
        openPositions: ((r as any).positions || []).length,
      };
    }

    return {
      id: r.id,
      symbol: r.symbol,
      mode: r.mode,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      haltedAt: (r as any).haltedAt ?? null,
      haltReason: (r as any).haltReason ?? null,
      startBalanceUsd: r.startBalanceUsd,
      aggressiveness,
      strategyEngine: strategySnapshot.engine,
      strategy: strategySnapshot,
      // Detect Smart Agent from either top-level flag or profileJson
      isSmartAgent: (r as any).isSmartAgent || (r as any).profileJson?.isSmartAgent || profile?.isIntelligent || false,
      smartConfig: (r as any).profileJson?.smartConfig,
      ...stats,
    };
  }));
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
    const realizedUsd = actives.reduce((sum, a)=> sum + Number(a.kpi?.realizedPnlUsd || 0), 0);
    const unrealizedUsd = actives.reduce((sum, a)=> sum + Number(a.kpi?.unrealizedPnlUsd || 0), 0);
    const pnlUsd = realizedUsd + unrealizedUsd;
    const capitalStartUsd = actives.reduce((sum, a)=> sum + Number(a.startBalanceUsd || 0), 0);
    const roiPct = capitalStartUsd > 0 ? (realizedUsd / capitalStartUsd) * 100 : 0;
    const netRoiPct = capitalStartUsd > 0 ? (pnlUsd / capitalStartUsd) * 100 : roiPct;

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

          if (Number.isFinite(totalUsd) && Number.isFinite(freeUsd)) {
            updateLiveExchangeBalance({ totalUsd, freeUsd, timestamp: Date.now() });
          }

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
      const profile = (session.profileJson as any) || {};
      const leverageMeta = (profile.leverageCap as any) || null;
      const requestedMaxLev = Number(profile.requestedMaxLeverage ?? leverageMeta?.requested ?? profile.maxLeverage ?? 1);
      const resolvedMaxLev = Number(leverageMeta?.resolved ?? profile.maxLeverage ?? requestedMaxLev);

      return {
        id: session.id,
        symbol: session.symbol,
        mode: session.mode,
        state: agentState, // ✅ Now using correct state property
        bias: agentBias,
        aggressiveness: session.profileJson ? (session.profileJson as any)?.aggressiveness : 'conservative',
        pnlUsd: Number(session.kpi?.realizedPnlUsd || 0) + Number(session.kpi?.unrealizedPnlUsd || 0),
        roiPct: (session.startBalanceUsd && session.startBalanceUsd > 0) ?
          (Number(session.kpi?.realizedPnlUsd || 0) / Number(session.startBalanceUsd)) * 100 : 0,
        netRoiPct: (session.startBalanceUsd && session.startBalanceUsd > 0) ?
          ((Number(session.kpi?.realizedPnlUsd || 0) + Number(session.kpi?.unrealizedPnlUsd || 0)) / Number(session.startBalanceUsd)) * 100 : 0,
        winRate: Number(session.kpi?.winRate || 0),
        trades: Number((session.kpi?.stats as any)?.tradesTotal || 0),
        createdAt: session.startedAt,
        lastActivity: new Date().toISOString(),
        leverage: {
          requested: requestedMaxLev,
          resolved: resolvedMaxLev,
          trimmed: resolvedMaxLev + 1e-9 < requestedMaxLev,
          cap: leverageMeta,
        },
      };
    });

    function serializeSnapshot(snapshot: BalanceSnapshot | null) {
      if (!snapshot) return null;
      return {
        totalUsd: snapshot.totalUSD.toNumber(),
        freeUsd: snapshot.freeUSD.toNumber(),
        reservedUsd: snapshot.reservedUSD.toNumber(),
        inPositionsUsd: snapshot.inPositionsUSD.toNumber(),
        ts: snapshot.ts,
      };
    }

    let paperCapital: ReturnType<typeof serializeSnapshot> | null = null;
    let liveCapital: ReturnType<typeof serializeSnapshot> | null = null;
    try {
      const [paperSnap, liveSnap] = await Promise.all([
        getBalanceSnapshot('paper'),
        getBalanceSnapshot('live'),
      ]);
      paperCapital = serializeSnapshot(paperSnap);
      liveCapital = serializeSnapshot(liveSnap);
    } catch (error) {
      console.warn('⚠️ Failed to resolve capital pool snapshot for overview:', error);
    }

    const selectedPool = modeFilter === 'live' ? liveCapital : paperCapital;
    const poolEquityUsd = selectedPool?.totalUsd;

    const payload = {
      activeCount: actives.length,
      sessionsCount: totalSessions,
      symbols,
      pnlUsd,
      capitalStartUsd,
      equityUsd: poolEquityUsd != null ? poolEquityUsd : Number(capitalStartUsd) + Number(pnlUsd),
      roiPct,
      avgWinRate,
      aiCallsTotal,
      exchangeBalance,
      paperBalance: paperCapital
        ? {
            equityUsd: paperCapital.totalUsd,
            freeUsd: paperCapital.freeUsd,
            committedUsd: paperCapital.reservedUsd,
            agentsCount: actives.filter((session) => session.mode === 'paper').length,
            lastUpdated: paperCapital.ts ? new Date(paperCapital.ts).toISOString() : new Date().toISOString(),
          }
        : paperBalance,
      capitalPool: {
        paper: paperCapital,
        live: liveCapital,
      },
      sessions: sessionsData, // ✅ Ajout des sessions dans la réponse
      netRoiPct,
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
