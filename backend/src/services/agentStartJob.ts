import { randomUUID } from 'crypto';
import { getConfig } from '../utils/env.js';
import { startSession } from '../session/session.js';
import { setActiveSession } from '../metrics/aiCalls.js';
import { AgentHub } from '../agent/hub.js';
import type { ActivationProfile } from '../agent/state.js';
import { serializeActivationProfile } from '../agent/profilePersistence.js';
import { initializeIntelligentSmartAgent } from './smartAgent.js';
import {
  getBestIntelligentOpportunity,
  type IntelligentAnalysis,
  getOptimizedCryptoList,
  getActiveAgentCountForSymbol,
} from './intelligentAgent.js';
import { selectBestPerp } from '../ai/orchestrator.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { requestStrategy } from '../ai/strategyManager.js';
import { proposePlan } from '../ai/planOrchestrator.js';
import { savePlan } from './planStore.js';
import { updatePortfolioBalance, rebalancePortfolio } from './portfolioManager.js';
import { getTicker } from '../data/market.js';
import { broadcast } from '../ws/hub.js';
import { getOhlcvWarmupState } from '../data/market.js';
import { getUserCredentials } from './userCredentials.js';
import { getUserExchange } from '../exchange/ccxtClient.js';
import { resolveLeverageCap, type ResolvedLeverageCap } from '../risk/leverageCaps.js';
import { DEFAULT_RR_EXPECTANCY_CONFIG } from '../risk/rrExpectancy.js';

type AgentStartPhase =
  | 'queued'
  | 'validating_config'
  | 'building_universe'
  | 'creating_session'
  | 'activating_agent'
  | 'warming'
  | 'complete'
  | 'failed';

type AgentStartJobStatus = 'queued' | 'running' | 'completed' | 'failed';

type StartPayload = Record<string, any>;

type AgentStartJobResult =
  | {
      state: 'ready';
      sessionId: string;
      agentId?: string;
      symbol: string;
    }
  | {
      state: 'warming';
      sessionId: string;
      agentId?: string;
      symbol: string;
      warmup: Record<
        string,
        { availableBars: number; minBarsNeeded: number; firstBarAt?: number | null; lastBarAt?: number | null; retryMs?: number }
      >;
    };

type AgentStartJobError = {
  code: string;
  message: string;
  details?: Record<string, any>;
};

export type AgentStartJobSnapshot = {
  jobId: string;
  agentTempId: string;
  status: AgentStartJobStatus;
  phase: AgentStartPhase;
  phaseDetail?: string;
  startedAt: number;
  updatedAt: number;
  timingsMs: Record<string, number>;
  metrics: {
    universe?: { total?: number; orderable?: number; symbols?: string[] };
    dataWarmup?: Record<string, { availableBars: number; minBarsNeeded: number; retryMs?: number }>;
  };
  result?: AgentStartJobResult;
  error?: AgentStartJobError;
};

type InternalAgentStartJob = AgentStartJobSnapshot & {
  payload: StartPayload;
  userId: string;
  resolve?: () => void;
};

const jobs = new Map<string, InternalAgentStartJob>();

const DEFAULT_PHASE_TIMEOUT_MS: Record<string, number> = {
  validating_config: 1_000,
  building_universe: 3_000,
  creating_session: 1_500,
  activating_agent: 10_000,
};

export function enqueueAgentStartJob(payload: { payload: StartPayload; userId: string | null | undefined }) {
  const jobId = randomUUID();
  const agentTempId = randomUUID();
  const job: InternalAgentStartJob = {
    jobId,
    agentTempId,
    payload: payload.payload,
    userId: payload.userId || '',
    status: 'queued',
    phase: 'queued',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    timingsMs: {},
    metrics: {},
  };
  jobs.set(jobId, job);
  setImmediate(() => {
    runJob(jobId).catch((error) => {
      failJob(jobId, {
        code: 'start.unexpected_error',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      });
    });
  });
  return { jobId, agentTempId };
}

export function getAgentStartJob(jobId: string): AgentStartJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  const { payload: _payload, resolve: _resolve, ...snapshot } = job;
  return snapshot;
}

function updateJob(jobId: string, patch: Partial<InternalAgentStartJob>) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
  job.updatedAt = Date.now();
}

function recordPhaseTiming(job: InternalAgentStartJob, phase: string, duration: number) {
  const current = job.timingsMs[phase] || 0;
  job.timingsMs[phase] = current + duration;
}

async function runJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  updateJob(jobId, { status: 'running', phase: 'validating_config' });

  let normalized: NormalizedStartConfig;
  try {
    normalized = await runPhase(jobId, 'validating_config', async () => validateAndNormalize(job.payload, job.userId));
  } catch (error) {
    return failJob(jobId, formatPhaseError('start.validation_failed', error));
  }

  let universeInfo: UniverseBuildResult | null = null;
  if (normalized.isSmartAgent) {
    try {
      universeInfo = await runPhase(jobId, 'building_universe', async () => buildSmartUniverse(normalized));
      if (!universeInfo || !universeInfo.prefetchedOpportunity) {
        throw new PhaseError('start.universe_empty', 'No qualifying opportunities available', {
          candidateCount: universeInfo?.candidateCount ?? 0,
        });
      }
      updateJob(jobId, {
        metrics: {
          ...job.metrics,
          universe: {
            total: universeInfo.candidateCount,
            orderable: universeInfo.orderableCount,
            symbols: universeInfo.topSymbols,
          },
        },
      });
    } catch (error) {
      return failJob(jobId, formatPhaseError('start.universe_empty', error));
    }
  }

  let sessionRecord: Awaited<ReturnType<typeof startSession>>;
  try {
    sessionRecord = await runPhase(jobId, 'creating_session', async () =>
      createSession(normalized, universeInfo ?? null, job.userId)
    );
  } catch (error) {
    return failJob(jobId, formatPhaseError('start.session_failed', error));
  }

  // Persist smart agent flags now that session exists
  try {
    await finalizeSmartAgentMetadata(sessionRecord.id, normalized);
  } catch (error) {
    console.warn('⚠️ Failed to persist smart agent metadata:', error);
  }

  let activationResult: AgentActivationResult;
  try {
    activationResult = await runPhase(jobId, 'activating_agent', async () =>
      activateAgent({
        normalized,
        session: sessionRecord,
        opportunity: universeInfo?.prefetchedOpportunity || null,
        shouldActivate: universeInfo?.shouldActivate ?? !normalized.isSmartAgent,
      })
    );
  } catch (error) {
    return failJob(jobId, formatPhaseError('start.activation_failed', error));
  }

  const warmup = gatherWarmupDiagnostics(sessionRecord.symbol);
  if (warmup) {
    updateJob(jobId, { metrics: { ...jobs.get(jobId)!.metrics, dataWarmup: warmup } });
  }

  if (job.userId) {
    const targetBalance = Number.isFinite(normalized.portfolioBalanceUsd)
      ? normalized.portfolioBalanceUsd
      : normalized.startBalanceUsd;
    try {
      if (Number.isFinite(targetBalance) && targetBalance >= 0) {
        await updatePortfolioBalance(job.userId, normalized.mode, Number(targetBalance));
      }
      await rebalancePortfolio({ userId: job.userId, mode: normalized.mode, reason: 'agent_start_job' });
    } catch (error) {
      console.warn('⚠️ Portfolio update failed during agent start job:', error);
    }
  }

  const result: AgentStartJobResult =
    activationResult.state === 'ready'
      ? {
          state: 'ready',
          sessionId: sessionRecord.id,
          agentId: activationResult.agentId,
          symbol: sessionRecord.symbol,
        }
      : {
          state: 'warming',
          sessionId: sessionRecord.id,
          agentId: activationResult.agentId,
          symbol: sessionRecord.symbol,
          warmup: warmup || {},
        };

  updateJob(jobId, {
    status: 'completed',
    phase: activationResult.state === 'ready' ? 'complete' : 'warming',
    result,
  });
}

async function runPhase<T>(jobId: string, phase: Exclude<AgentStartPhase, 'queued' | 'complete' | 'warming' | 'failed'>, fn: () => Promise<T>) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('job_not_found');
  updateJob(jobId, { phase });

  const timeoutMs = DEFAULT_PHASE_TIMEOUT_MS[phase] ?? 5000;
  const started = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new PhaseError('start.timeout', `Phase ${phase} exceeded ${timeoutMs}ms`, { phase })), timeoutMs)
      ),
    ]);
    const elapsed = Date.now() - started;
    recordPhaseTiming(job, phase, elapsed);
    return result;
  } catch (error) {
    const elapsed = Date.now() - started;
    recordPhaseTiming(job, phase, elapsed);
    throw error;
  }
}

function failJob(jobId: string, error: AgentStartJobError) {
  const job = jobs.get(jobId);
  if (!job) return;
  updateJob(jobId, {
    status: 'failed',
    phase: 'failed',
    error,
  });
}

type NormalizedStartConfig = {
  mode: 'paper' | 'live';
  startBalanceUsd: number;
  portfolioBalanceUsd: number;
  isSmartAgent: boolean;
  smartConfig: Record<string, any>;
  aggressiveness: 'conservative' | 'reactive' | 'aggressive';
  riskPerTradePct: number;
  maxLeverage: number;
  requestedMaxLeverage: number;
  leverageCap?: ResolvedLeverageCap;
  dailyLossLimitPct: number;
  budgetFraction: number;
  perps?: string[];
  symbol?: string;
  smartAutoMode?: boolean;
  volumeThresholdUsd?: number;
  momentumThreshold?: number;
  userId?: string;
  rawPayload: StartPayload;
};

async function validateAndNormalize(payload: StartPayload, userId?: string | null): Promise<NormalizedStartConfig> {
  const cfg = getConfig();
  const mode = (payload.mode === 'live' ? 'live' : 'paper') as 'paper' | 'live';

  const isSmartAgent = !!(payload.isSmartAgent || payload.smartAutoMode);
  const aggressiveness =
    payload.aggressiveness === 'conservative' || payload.aggressiveness === 'reactive' || payload.aggressiveness === 'aggressive'
      ? payload.aggressiveness
      : 'reactive';

  const maxLeverage = Math.min(10, Math.max(1, Number(payload.maxLeverage ?? 4)));
  const dailyLossLimitPct = Math.min(4, Math.max(3, Number(payload.dailyLossLimitPct ?? 3.5)));
  const rawRiskPct = payload.riskPerTradePct ?? cfg.DEFAULT_RISK_PCT ?? 1.5;
  const riskPerTradePct = Math.min(5, Math.max(0.5, Number(rawRiskPct)));

  let budgetPctValue = Number(payload.budgetPct ?? 100);
  if (!Number.isFinite(budgetPctValue) || budgetPctValue <= 0) budgetPctValue = 100;
  let budgetFraction = budgetPctValue;
  if (budgetFraction > 1) budgetFraction = budgetFraction / 100;
  budgetFraction = Math.min(1, Math.max(0.1, budgetFraction));

  const startBalanceUsd =
    typeof payload.startBalanceUsd === 'number' && payload.startBalanceUsd > 0
      ? Number(payload.startBalanceUsd)
      : mode === 'paper'
      ? 1000
      : 0;

  const requestedPortfolioBalance =
    typeof payload.portfolioBalanceUsd === 'number' && payload.portfolioBalanceUsd >= 0
      ? Number(payload.portfolioBalanceUsd)
      : undefined;
  const portfolioBalanceUsd =
    requestedPortfolioBalance != null
      ? requestedPortfolioBalance
      : startBalanceUsd;

  const smartConfig = {
    minHoldDuration: Number(payload.smartConfig?.minHoldDuration ?? 86_400_000),
    rescanInterval: Number(payload.smartConfig?.rescanInterval ?? 21_600_000),
    momentumThreshold: Number(payload.smartConfig?.momentumThreshold ?? 0.5),
    volumeThreshold: Number(payload.smartConfig?.volumeThreshold ?? 250_000),
  };

  if (smartConfig.minHoldDuration <= 0 || smartConfig.rescanInterval <= 0) {
    throw new PhaseError('start.validation_failed', 'Invalid smartConfig durations', { smartConfig });
  }

  const volumeThresholdUsd = Math.max(10_000, smartConfig.volumeThreshold);

  const perps = Array.isArray(payload.perps) ? payload.perps.slice(0, 100) : undefined;
  const symbol = typeof payload.symbol === 'string' ? payload.symbol : undefined;

  return {
    mode,
    startBalanceUsd,
    portfolioBalanceUsd,
    isSmartAgent,
    smartConfig,
    aggressiveness,
    riskPerTradePct,
    maxLeverage,
    requestedMaxLeverage: maxLeverage,
    dailyLossLimitPct,
    budgetFraction,
    perps,
    symbol,
    smartAutoMode: payload.smartAutoMode,
    volumeThresholdUsd,
    momentumThreshold: smartConfig.momentumThreshold,
    userId: userId || undefined,
    rawPayload: payload,
  };
}

type UniverseBuildResult = {
  prefetchedOpportunity: IntelligentAnalysis | null;
  candidateCount: number;
  orderableCount: number;
  shouldActivate: boolean;
  topSymbols: string[];
};

async function buildSmartUniverse(config: NormalizedStartConfig): Promise<UniverseBuildResult> {
  const agg = config.aggressiveness;
  let candidateSymbols: string[] = [];
  try {
    candidateSymbols = await getOptimizedCryptoList(undefined);
  } catch (error) {
    console.warn('⚠️ Failed to fetch optimized crypto list:', error);
  }

  const prefetchedOpportunity = await getBestIntelligentOpportunity(undefined, {
    aggressiveness: agg,
    maxUsage: 0,
  });
  if (prefetchedOpportunity && !candidateSymbols.includes(prefetchedOpportunity.symbol)) {
    candidateSymbols.unshift(prefetchedOpportunity.symbol);
  }

  const testMode = process.env.UNIT_TEST_MODE === 'true';
  if (testMode) {
    const fallbackCandidates = candidateSymbols.length
      ? candidateSymbols
      : ['ETH/USDT:USDT', 'SOL/USDT:USDT', 'ADA/USDT:USDT'];
    return {
      prefetchedOpportunity,
      candidateCount: fallbackCandidates.length,
      orderableCount: fallbackCandidates.length,
      shouldActivate: false,
      topSymbols: fallbackCandidates.slice(0, 5),
    };
  }

  if (!candidateSymbols.length) {
    return {
      prefetchedOpportunity,
      candidateCount: 0,
      orderableCount: 0,
      shouldActivate: false,
      topSymbols: [],
    };
  }

  const orderabilityChecks = await Promise.all(
    candidateSymbols.slice(0, 40).map(async (sym) => {
      try {
        const ticker = await getTicker(sym);
        const price = Number(ticker?.last || 0);
        const notional = price * config.startBalanceUsd * (config.riskPerTradePct / 100);
        return { symbol: sym, orderable: Number.isFinite(notional) && notional >= 10 };
      } catch {
        return { symbol: sym, orderable: false };
      }
    })
  );

  const orderableSymbols = orderabilityChecks.filter((c) => c.orderable).map((c) => c.symbol);

  return {
    prefetchedOpportunity,
    candidateCount: candidateSymbols.length,
    orderableCount: orderableSymbols.length,
    shouldActivate: false,
    topSymbols: (orderableSymbols.length ? orderableSymbols : candidateSymbols).slice(0, 10),
  };
}

async function createSession(
  config: NormalizedStartConfig,
  universe: UniverseBuildResult | null,
  userId?: string
) {
  let symbol = config.symbol;

  if (config.isSmartAgent) {
    const prefetched = universe?.prefetchedOpportunity ?? null;
    if (!symbol && prefetched) {
      const usage = await getActiveAgentCountForSymbol(prefetched.symbol);
      if (usage === 0) {
        symbol = prefetched.symbol;
      } else {
        console.log(
          `🚫 Prefetched opportunity ${prefetched.symbol} already has ${usage} active agent(s) – seeking alternative`
        );
      }
    }

    if (!symbol) {
      const candidates = universe?.topSymbols ?? [];
      for (const candidate of candidates) {
        try {
          const usage = await getActiveAgentCountForSymbol(candidate);
          if (usage === 0) {
            symbol = candidate;
            break;
          }
        } catch (error) {
          console.warn(`⚠️ Failed to check active count for ${candidate}:`, error);
        }
      }
    }

  } else if (!symbol && config.perps && config.perps.length) {
    const ranked = await selectBestPerp(config.perps);
    symbol = ranked[0]?.symbol;
  }

  if (!symbol) {
    const activeCount = await prisma.agentSession.count({ where: { stoppedAt: null } });
    throw new PhaseError('start.universe_conflict', 'no_unused_symbol_available', {
      activeAgents: activeCount,
    });
  }

  if (process.env.UNIT_TEST_MODE !== 'true') {
    const resolved = await (await import('../exchange/ccxtClient.js')).resolveSymbol(symbol);
    symbol = resolved;
  }

  const leverageCap = await resolveLeverageCap({
    symbol,
    requestedMaxLeverage: config.requestedMaxLeverage,
    mode: config.mode,
  });
  config.leverageCap = leverageCap;
  config.maxLeverage = leverageCap.resolved;

  if (config.mode === 'live') {
    if (!userId) {
      throw new PhaseError('start.validation_failed', 'authentication_required_for_live_trading', {});
    }
    const userCredentials = await getUserCredentials(userId);
    if (!userCredentials) {
      throw new PhaseError('start.validation_failed', 'api_keys_required_for_live_trading', {});
    }
    try {
      const exchange = await getUserExchange(userId, userCredentials);
      const balance = await exchange.fetchBalance();
      const totalUsd = Number(balance?.total?.USDT || 0) + Number(balance?.total?.USD || 0);
      const freeUsd = Number(balance?.free?.USDT || 0) + Number(balance?.free?.USD || 0);
      const startBal = config.startBalanceUsd > 0 ? Math.min(config.startBalanceUsd, totalUsd || freeUsd) : totalUsd || freeUsd;
      if (!startBal || startBal <= 0) {
        throw new PhaseError('start.validation_failed', 'balance_unavailable', {});
      }
      config.startBalanceUsd = startBal;
    } catch (error) {
      throw new PhaseError('start.exchange_unavailable', 'Failed to fetch live balance', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const activationTimestamp = new Date().toISOString();
  const minLeverage = Math.max(1, Math.min(leverageCap.resolved, Number(config.rawPayload?.minLeverage ?? 1)));
  const activationProfile: ActivationProfile = {
    symbol,
    mode: config.mode,
    maxLeverage: leverageCap.resolved,
    requestedMaxLeverage: config.requestedMaxLeverage,
    leverageCap,
    riskPerTradePct: config.riskPerTradePct,
    dailyLossLimitPct: config.dailyLossLimitPct,
    timestamp: activationTimestamp,
    startBalanceUsd: config.startBalanceUsd,
    budgetFraction: config.budgetFraction,
    aggressiveness: config.aggressiveness,
    userId,
    sizingMode: config.rawPayload?.sizingMode,
    dynamicLeverage: config.rawPayload?.dynamicLeverage !== false,
    minLeverage,
    rrFloor: DEFAULT_RR_EXPECTANCY_CONFIG.rrFloor,
    rrCeil: DEFAULT_RR_EXPECTANCY_CONFIG.rrCeil,
    rrBaseMin: DEFAULT_RR_EXPECTANCY_CONFIG.rrBaseMin,
    rrExpectancy: {
      enabled: DEFAULT_RR_EXPECTANCY_CONFIG.enabled,
      minTrades: DEFAULT_RR_EXPECTANCY_CONFIG.minTrades,
      lookbackDays: DEFAULT_RR_EXPECTANCY_CONFIG.lookbackDays,
      decay: DEFAULT_RR_EXPECTANCY_CONFIG.decay,
      safetyMult: DEFAULT_RR_EXPECTANCY_CONFIG.safetyMult,
      blend: DEFAULT_RR_EXPECTANCY_CONFIG.blend,
      hysteresis: DEFAULT_RR_EXPECTANCY_CONFIG.hysteresis,
    },
  };

  const session = await startSession(
    symbol,
    config.mode,
    config.startBalanceUsd,
    serializeActivationProfile(activationProfile, { budgetPct: Math.round(config.budgetFraction * 100) }),
    userId,
    {
      rrFloor: activationProfile.rrFloor,
      rrCeil: activationProfile.rrCeil,
      rrBaseMin: activationProfile.rrBaseMin,
      rrExpectancy: activationProfile.rrExpectancy,
    }
  );

  await setActiveSession(session.id);
  return session;
}

async function finalizeSmartAgentMetadata(sessionId: string, config: NormalizedStartConfig) {
  if (!config.isSmartAgent) return;
  const defaultSmartConfig = {
    rescanInterval: config.smartConfig.rescanInterval,
    minHoldDuration: config.smartConfig.minHoldDuration,
    volumeThreshold: config.smartConfig.volumeThreshold,
    momentumThreshold: config.smartConfig.momentumThreshold,
  };
  await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      isSmartAgent: true,
      smartConfig: defaultSmartConfig,
    },
  });
}

type AgentActivationResult =
  | { state: 'ready'; agentId?: string }
  | { state: 'warming'; agentId?: string; reason?: string };

async function activateAgent(params: {
  normalized: NormalizedStartConfig;
  session: Awaited<ReturnType<typeof startSession>>;
  opportunity: IntelligentAnalysis | null;
  shouldActivate: boolean;
}): Promise<AgentActivationResult> {
  const { normalized, session, opportunity } = params;

  let agentId: string | undefined;

  const leverageCap = normalized.leverageCap
    ?? await resolveLeverageCap({
      symbol: session.symbol,
      requestedMaxLeverage: normalized.requestedMaxLeverage,
      mode: normalized.mode,
    });
  const effectiveMaxLev = leverageCap.resolved;
  const requestedMaxLev = normalized.requestedMaxLeverage;
  const minLeverage = Math.max(1, Math.min(effectiveMaxLev, Number(normalized.rawPayload?.minLeverage ?? 1)));

  if (params.shouldActivate) {
    await AgentHub.activate(session.id, {
      symbol: session.symbol,
      mode: normalized.mode,
      maxLeverage: effectiveMaxLev,
      requestedMaxLeverage: requestedMaxLev,
      leverageCap,
      riskPerTradePct: normalized.riskPerTradePct,
      dailyLossLimitPct: normalized.dailyLossLimitPct,
      timestamp: new Date().toISOString(),
      startBalanceUsd: normalized.startBalanceUsd,
      budgetFraction: normalized.budgetFraction,
      aggressiveness: normalized.aggressiveness,
      userId: normalized.userId,
      sizingMode: normalized.rawPayload?.sizingMode,
      dynamicLeverage: normalized.rawPayload?.dynamicLeverage !== false,
      minLeverage,
    } as any);
    agentId = session.id;
  }

  if (normalized.isSmartAgent) {
    const initTimeoutMs = Math.max(10_000, Number(process.env.SMART_AGENT_INIT_RESPONSE_TIMEOUT_MS || 15_000));
    const success = await Promise.race([
      initializeIntelligentSmartAgent(session.id, opportunity),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), initTimeoutMs)),
    ]);
    if (!success) {
      return { state: 'warming', agentId, reason: 'smart_agent_initialization_pending' };
    }
  }

  schedulePostActivationTasks(session.id, session.symbol, normalized);
  return { state: 'ready', agentId };
}

function schedulePostActivationTasks(sessionId: string, symbol: string, config: NormalizedStartConfig) {
  setTimeout(async () => {
    try {
      const plan = await proposePlan(symbol, { fresh: true, sessionId });
      await savePlan(sessionId, plan as any);
      const agent = AgentHub.get(sessionId);
      if (agent) {
        await agent.propose(plan as any);
        await agent.validateAndArm();
      }
    } catch (error) {
      console.warn('⚠️ Failed to generate plan during post activation:', error);
    }
    try {
      const { strategy: strat, levels: lvls } = await requestStrategy({ symbol, trigger: 'activation', sessionId, fresh: true, force: true });
      broadcast('strategy', { ...(strat as any), levels: lvls }, symbol, sessionId);
    } catch (error) {
      console.warn('⚠️ Failed to generate strategy during post activation:', error);
    }
    try {
      const tech = await buildTechSnapshot(symbol);
      broadcast('analysis', { symbol, technical: tech }, symbol, sessionId);
    } catch (error) {
      console.warn('⚠️ Failed to broadcast analysis snapshot:', error);
    }
    try {
      broadcast('session', await prisma.agentSession.findUnique({ where: { id: sessionId } }), symbol, sessionId);
    } catch (error) {
      console.warn('⚠️ Failed to broadcast session snapshot:', error);
    }
  }, 0);
}

function gatherWarmupDiagnostics(symbol: string) {
  const warmup = getOhlcvWarmupState(symbol, '15m');
  if (!warmup) return undefined;
  return {
    '15m': {
      availableBars: warmup.fulfilled ? 0 : 0,
      minBarsNeeded: Number(getConfig().DIAGNOSTICS_MIN_BARS_15M || 120),
      retryMs: warmup.nextRetryTs ? Math.max(0, warmup.nextRetryTs - Date.now()) : undefined,
    },
  };
}

class PhaseError extends Error {
  code: string;
  details: Record<string, any>;
  constructor(code: string, message: string, details: Record<string, any>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function formatPhaseError(defaultCode: string, error: unknown): AgentStartJobError {
  if (error instanceof PhaseError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: defaultCode, message: error.message };
  }
  return { code: defaultCode, message: String(error) };
}
