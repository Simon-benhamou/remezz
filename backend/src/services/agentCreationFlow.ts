import { randomUUID } from 'crypto';
import { getConfig } from '../utils/env.js';
import { resolveBudgetFraction } from '../utils/budget.js';
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
  normalizeUnifiedSymbol,
  type StrategyFilterProfile,
} from './intelligentAgent.js';
import { selectBestOpportunity } from './smartSelectionOrchestrator.js';
import { selectBestPerp } from '../ai/orchestrator.js';
import { prisma } from '../db/client.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { requestStrategy } from '../ai/strategyManager.js';

import { proposePlan } from '../ai/planOrchestrator.js';
import { savePlan } from './planStore.js';
import { getTicker, getOhlcvWarmupState } from '../data/market.js';
import { broadcast } from '../ws/hub.js';
import { getUserCredentials } from './userCredentials.js';
import { getUserExchange } from '../exchange/ccxtClient.js';
import { resolveLeverageCap, type ResolvedLeverageCap } from '../risk/leverageCaps.js';
import { DEFAULT_RR_EXPECTANCY_CONFIG } from '../risk/rrExpectancy.js';
import { updatePortfolioBalance, rebalancePortfolio } from './portfolioManager.js';
import { getPredictionSyncSafe } from '../quantai/pythonPredictor.js';
import { buildPredictorFeatures } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

export type StartPayload = Record<string, any>;

export type AgentCreationStepKey = 'select_symbol' | 'create_session' | 'activate_agent';

export type AgentCreationStepSnapshot = {
  key: AgentCreationStepKey;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  meta?: Record<string, any>;
  error?: { code: string; message: string; details?: Record<string, any> };
};

export type AgentCreationLogLevel = 'info' | 'warn' | 'error' | 'success';

export type AgentCreationLogEntry = {
  timestamp: number;
  level: AgentCreationLogLevel;
  message: string;
  context?: string;
  meta?: Record<string, any>;
};

export type AgentCreationSelectionSummary = {
  symbol: string;
  autoSelected: boolean;
  source: 'manual' | 'prefetched' | 'candidate' | 'perp_ranking';
  candidates: string[];
  prefetchedSymbol?: string | null;
  candidateCount?: number;
  orderableCount?: number;
  analyzedSymbols?: string[];
  orderableSymbols?: string[];
  baselineSymbols?: string[];
  decisionLog: AgentCreationLogEntry[];
};

export type AgentCreationResult = {
  sessionId: string;
  agentId?: string;
  symbol: string;
  mode?: string;
  state: 'ready' | 'warming';
  warmup?: Record<string, { availableBars: number; minBarsNeeded: number; retryMs?: number }>;
  steps: AgentCreationStepSnapshot[];
  selection: AgentCreationSelectionSummary;
};

export class PhaseError extends Error {
  code: string;
  details: Record<string, any>;

  constructor(code: string, message: string, details?: Record<string, any>) {
    super(message);
    this.code = code;
    this.details = details || {};
  }
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
  strategyEngine: 'meta_adaptive';
  rawPayload: StartPayload;
  selectionPolicy: {
    requireSignalAtStart: boolean;
    minStartEdge: number; // between 0 and 1
    minStartConfidence: number; // between 0 and 1
    priorWeight: number; // weighting factor for ranking candidates by predictor prior
  };
};

type UniverseBuildResult = {
  prefetchedOpportunity: IntelligentAnalysis | null;
  candidateCount: number;
  orderableCount: number;
  shouldActivate: boolean;
  topSymbols: string[];
  analyzedSymbols: string[];
  orderableSymbols: string[];
  baselineSymbols: string[];
  diagnostics: AgentCreationLogEntry[];
};

type AgentCreationContext = {
  id: string;
  userId?: string;
  payload: StartPayload;
  normalized: NormalizedStartConfig;
  universe: UniverseBuildResult | null;
  selection: AgentCreationSelectionSummary;
  reservationToken?: string;
  session?: Awaited<ReturnType<typeof startSession>>;
  activation?: AgentActivationResult;
  createdAt: number;
};

const CONTEXT_TTL_MS = 10 * 60 * 1000;
const contexts = new Map<string, AgentCreationContext>();

const SMART_SELECTION_RESERVATION_TTL_MS = 5 * 60 * 1000;
const smartSelectionReservations = new Map<string, { symbol: string; expiresAt: number }>();

const ORDERABILITY_TICKER_TIMEOUT_MS = Number(process.env.ORDERABILITY_TICKER_TIMEOUT_MS ?? 5_000);
const DEFAULT_SMART_ANALYSIS_LIMIT = 25;

function resolveTimeoutMs(raw: unknown, fallback: number, floor: number, ceil: number): number {
  const parsed = typeof raw === 'string' ? Number(raw) : Number(raw ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(ceil, Math.max(floor, Math.floor(parsed)));
}

const SMART_UNIVERSE_BUILD_TIMEOUT_MS = resolveTimeoutMs(
  process.env.SMART_UNIVERSE_BUILD_TIMEOUT_MS,
  45_000,
  10_000,
  5 * 60_000,
);

const SMART_PREFETCH_TIMEOUT_MS = resolveTimeoutMs(
  process.env.SMART_PREFETCH_TIMEOUT_MS,
  30_000,
  5_000,
  3 * 60_000,
);

export function resolveSmartAnalysisLimit(envValue: unknown = process.env.SMART_AUTO_ANALYSIS_LIMIT): number {
  const parsed = typeof envValue === 'string' ? Number(envValue) : Number(envValue ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SMART_ANALYSIS_LIMIT;
  }
  const bounded = Math.floor(parsed);
  return Math.min(60, Math.max(5, bounded));
}

class OrderabilityTickerTimeoutError extends Error {
  symbol: string;
  timeoutMs: number;

  constructor(symbol: string, timeoutMs: number) {
    super(`Orderability ticker fetch timed out for ${symbol} after ${timeoutMs}ms`);
    this.name = 'OrderabilityTickerTimeoutError';
    this.symbol = symbol;
    this.timeoutMs = timeoutMs;
  }
}

function isOrderabilityTickerTimeoutError(error: unknown): error is OrderabilityTickerTimeoutError {
  return error instanceof OrderabilityTickerTimeoutError;
}

async function fetchTickerWithTimeout(
  symbol: string,
  timeoutMs: number,
  fetcher: typeof getTicker = getTicker
): Promise<Awaited<ReturnType<typeof getTicker>>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetcher(symbol);
  }

  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      fetcher(symbol),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new OrderabilityTickerTimeoutError(symbol, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runWithTimeout<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; result?: T; error?: unknown }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    try {
      const value = await factory();
      return { timedOut: false, result: value };
    } catch (error) {
      return { timedOut: false, error };
    }
  }

  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const outcome = await Promise.race([
      factory().then((value) => ({ kind: 'value' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    ]);
    if (outcome.kind === 'timeout') {
      return { timedOut: true };
    }
    return { timedOut: false, result: outcome.value };
  } catch (error) {
    return { timedOut: false, error };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

type OrderabilityEvaluationOptions = {
  timeoutMs?: number;
  tickerFetcher?: typeof getTicker;
};

async function evaluateOrderability(
  symbol: string,
  config: NormalizedStartConfig,
  pushDiagnostic: (level: AgentCreationLogLevel, message: string, meta?: Record<string, any>) => void,
  options?: OrderabilityEvaluationOptions
): Promise<{ symbol: string; orderable: boolean; volumeUsd: number }> {
  const timeoutMs = options?.timeoutMs ?? ORDERABILITY_TICKER_TIMEOUT_MS;
  const tickerFetcher = options?.tickerFetcher ?? getTicker;

  try {
    const ticker = await fetchTickerWithTimeout(symbol, timeoutMs, tickerFetcher);
    const price = Number((ticker as any)?.last ?? 0);
    const notional = price * config.startBalanceUsd * (config.riskPerTradePct / 100);
    const rawVolume = Number((ticker as any)?.quoteVolume ?? (ticker as any)?.info?.quoteVolume ?? 0);
    const volumeUsd = Number.isFinite(rawVolume) && rawVolume > 0 ? rawVolume : 0;
    return { symbol, orderable: Number.isFinite(notional) && notional >= 10, volumeUsd };
  } catch (error) {
    if (isOrderabilityTickerTimeoutError(error)) {
      pushDiagnostic('warn', 'Orderability check timed out for symbol', {
        symbol,
        timeoutMs,
      });
    } else {
      pushDiagnostic('warn', 'Orderability check failed for symbol', {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { symbol, orderable: false, volumeUsd: 0 };
  }
}

function normalizeReservationSymbol(symbol: string): string {
  if (!symbol) return symbol;
  try {
    return normalizeUnifiedSymbol(symbol).toUpperCase();
  } catch {
    return symbol.toUpperCase();
  }
}

function cleanupSmartReservations() {
  const now = Date.now();
  for (const [token, entry] of smartSelectionReservations.entries()) {
    if (!entry || !entry.symbol || entry.expiresAt <= now) {
      smartSelectionReservations.delete(token);
    }
  }
}

function releaseSmartReservation(token?: string) {
  if (!token) return;
  smartSelectionReservations.delete(token);
}

function tryReserveSmartSymbol(symbol: string, token?: string): boolean {
  if (!token) return true;
  cleanupSmartReservations();
  const normalized = normalizeReservationSymbol(symbol);
  for (const [existingToken, entry] of smartSelectionReservations.entries()) {
    if (existingToken !== token && entry.symbol === normalized) {
      return false;
    }
  }
  smartSelectionReservations.set(token, {
    symbol: normalized,
    expiresAt: Date.now() + SMART_SELECTION_RESERVATION_TTL_MS,
  });
  return true;
}

export function isSmartSymbolReserved(symbol: string, excludeToken?: string): boolean {
  cleanupSmartReservations();
  if (!symbol) return false;
  const normalized = normalizeReservationSymbol(symbol);
  for (const [token, entry] of smartSelectionReservations.entries()) {
    if (token === excludeToken) continue;
    if (entry.symbol === normalized) {
      return true;
    }
  }
  return false;
}

function cleanupContexts() {
  const now = Date.now();
  for (const [id, ctx] of contexts.entries()) {
    if (now - ctx.createdAt > CONTEXT_TTL_MS) {
      releaseSmartReservation(ctx.reservationToken);
      contexts.delete(id);
    }
  }
}

function getContextOrThrow(creationId: string): AgentCreationContext {
  cleanupContexts();
  const ctx = contexts.get(creationId);
  if (!ctx) {
    throw new PhaseError('start.context_not_found', 'Agent creation context expired or unknown', {
      creationId,
    });
  }
  return ctx;
}

export async function prepareAgentCreation(payload: StartPayload, userId?: string | null) {
  const normalized = await validateAndNormalize(payload, userId);
  const universe = normalized.isSmartAgent ? await buildSmartUniverse(normalized) : null;
  const reservationToken = normalized.isSmartAgent ? randomUUID() : undefined;
  const selection = await selectSymbol(normalized, universe, { reservationToken });

  if (reservationToken && !selection.autoSelected) {
    releaseSmartReservation(reservationToken);
  }

  const creationId = randomUUID();
  const ctx: AgentCreationContext = {
    id: creationId,
    userId: userId || undefined,
    payload,
    normalized,
    universe,
    selection,
    reservationToken: selection.autoSelected ? reservationToken : undefined,
    createdAt: Date.now(),
  };
  contexts.set(creationId, ctx);

  if (!selection.autoSelected) {
    ctx.reservationToken = undefined;
  }

  return {
    creationId,
    selection,
    normalizedPreview: {
      mode: normalized.mode,
      startBalanceUsd: normalized.startBalanceUsd,
      aggressiveness: normalized.aggressiveness,
      riskPerTradePct: normalized.riskPerTradePct,
      maxLeverage: normalized.maxLeverage,
      dailyLossLimitPct: normalized.dailyLossLimitPct,
      budgetPct: Math.round(normalized.budgetFraction * 100),
      smartAutoMode: !!normalized.smartAutoMode,
    },
    universeSummary: universe
      ? {
          candidateCount: universe.candidateCount,
          orderableCount: universe.orderableCount,
          topSymbols: universe.topSymbols,
          analyzedSymbols: universe.analyzedSymbols,
          orderableSymbols: universe.orderableSymbols,
        }
      : null,
  };
}

export async function createSessionFromPrepared(creationId: string, opts?: { symbol?: string }) {
  const ctx = getContextOrThrow(creationId);
  const symbol = opts?.symbol || ctx.selection.symbol;
  if (!symbol) {
    throw new PhaseError('start.universe_conflict', 'No symbol provided for session creation', {});
  }

  try {
    const { session, symbol: resolvedSymbol } = await createSessionRecord(
      ctx.normalized,
      symbol,
      ctx.userId
    );
    ctx.session = session;
    ctx.selection = {
      ...ctx.selection,
      symbol: resolvedSymbol,
    };
    releaseSmartReservation(ctx.reservationToken);
    ctx.reservationToken = undefined;

    return {
      creationId,
      sessionId: session.id,
      symbol: resolvedSymbol,
      profile: {
        mode: session.mode,
        startBalanceUsd: session.startBalanceUsd,
        aggressiveness: (session as any).profileJson?.aggressiveness,
      },
    };
  } catch (error) {
    releaseSmartReservation(ctx.reservationToken);
    ctx.reservationToken = undefined;
    throw error;
  }
}

export async function activatePreparedAgent(creationId: string) {
  const ctx = getContextOrThrow(creationId);
  if (!ctx.session) {
    throw new PhaseError('start.session_missing', 'No session has been created for this agent creation', {});
  }

  await finalizeSmartAgentMetadata(ctx.session.id, ctx.normalized);

  const activation = await activateAgent({
    normalized: ctx.normalized,
    session: ctx.session,
    opportunity: ctx.universe?.prefetchedOpportunity || null,
    shouldActivate: ctx.universe?.shouldActivate ?? !ctx.normalized.isSmartAgent,
  });

  ctx.activation = activation;
  
  const warmup = gatherWarmupDiagnostics(ctx.session.symbol);

  releaseSmartReservation(ctx.reservationToken);
  ctx.reservationToken = undefined;
  contexts.delete(creationId);

  return {
    creationId,
    sessionId: ctx.session.id,
    agentId: activation.agentId,
    symbol: ctx.session.symbol,
    state: activation.state,
    warmup,
    selection: ctx.selection,
  };
}

export async function startAgentCreation(
  payload: StartPayload,
  userId?: string | null,
  options?: { onProgress?: (snapshot: AgentCreationStepSnapshot) => void }
): Promise<AgentCreationResult> {
  console.log(`🚀 DEBUG: startAgentCreation called for userId=${userId}, isSmartAgent=${payload.isSmartAgent}`);
  
  const steps: AgentCreationStepSnapshot[] = [
    { key: 'select_symbol', status: 'pending' },
    { key: 'create_session', status: 'pending' },
    { key: 'activate_agent', status: 'pending' },
  ];

  const report = (key: AgentCreationStepKey, patch: Partial<AgentCreationStepSnapshot>) => {
    const idx = steps.findIndex((s) => s.key === key);
    if (idx === -1) return;
    steps[idx] = { ...steps[idx], ...patch };
    if (patch.startedAt && patch.finishedAt && typeof patch.finishedAt === 'number') {
      steps[idx].durationMs = patch.finishedAt - patch.startedAt;
    }
    options?.onProgress?.(steps[idx]);
  };

  let normalized: NormalizedStartConfig;
  let universe: UniverseBuildResult | null = null;
  let selection: AgentCreationSelectionSummary;
  let sessionRecord: Awaited<ReturnType<typeof startSession>>;
  let activation: AgentActivationResult;
  let selectionReservationToken: string | undefined;
  let hasActiveReservation = false;

  const stepStart = Date.now();
  report('select_symbol', { status: 'running', startedAt: stepStart });
  try {
    normalized = await validateAndNormalize(payload, userId);
    universe = normalized.isSmartAgent ? await buildSmartUniverse(normalized) : null;
    selectionReservationToken = normalized.isSmartAgent ? randomUUID() : undefined;
    selection = await selectSymbol(normalized, universe, {
      reservationToken: selectionReservationToken,
    });
    hasActiveReservation = !!(selectionReservationToken && selection.autoSelected);
    if (selectionReservationToken && !selection.autoSelected) {
      releaseSmartReservation(selectionReservationToken);
      selectionReservationToken = undefined;
    }
    const finishedAt = Date.now();
    report('select_symbol', {
      status: 'completed',
      finishedAt,
      durationMs: finishedAt - stepStart,
      meta: { selection, universe },
    });
  } catch (error) {
    const finishedAt = Date.now();
    if (hasActiveReservation && selectionReservationToken) {
      releaseSmartReservation(selectionReservationToken);
      hasActiveReservation = false;
      selectionReservationToken = undefined;
    }
    report('select_symbol', {
      status: 'failed',
      finishedAt,
      error: formatError(error),
    });
    throw error;
  }

  const createStart = Date.now();
  report('create_session', { status: 'running', startedAt: createStart });
  try {
    const created = await createSessionRecord(normalized!, selection!.symbol, userId || undefined);
    sessionRecord = created.session;
    selection = {
      ...selection!,
      symbol: created.symbol,
    };
    if (hasActiveReservation && selectionReservationToken) {
      releaseSmartReservation(selectionReservationToken);
      hasActiveReservation = false;
      selectionReservationToken = undefined;
    }
    const finishedAt = Date.now();
    report('create_session', {
      status: 'completed',
      finishedAt,
      durationMs: finishedAt - createStart,
      meta: { sessionId: created.session.id },
    });
  } catch (error) {
    const finishedAt = Date.now();
    if (hasActiveReservation && selectionReservationToken) {
      releaseSmartReservation(selectionReservationToken);
      hasActiveReservation = false;
      selectionReservationToken = undefined;
    }
    report('create_session', {
      status: 'failed',
      finishedAt,
      error: formatError(error),
    });
    throw error;
  }

  const activateStart = Date.now();
  report('activate_agent', { status: 'running', startedAt: activateStart });
  try {
    await finalizeSmartAgentMetadata(sessionRecord!.id, normalized!);
    
    // ✅ Ensure symbol profile exists BEFORE activation
    const { ensureSymbolProfile } = await import('./symbolSpecificOptimization.js');
    await ensureSymbolProfile(sessionRecord!.symbol);
    console.log(`✅ Symbol profile ensured for ${sessionRecord!.symbol}`);
    
    activation = await activateAgent({
      normalized: normalized!,
      session: sessionRecord!,
      opportunity: universe?.prefetchedOpportunity || null,
      shouldActivate: universe?.shouldActivate ?? !normalized!.isSmartAgent,
    });
    const finishedAt = Date.now();
    report('activate_agent', {
      status: 'completed',
      finishedAt,
      durationMs: finishedAt - activateStart,
      meta: { state: activation.state },
    });
  } catch (error) {
    const finishedAt = Date.now();
    report('activate_agent', {
      status: 'failed',
      finishedAt,
      error: formatError(error),
    });
    throw error;
  }

  console.log(`🎯 DEBUG: Reached code after activate_agent try-catch block`);

  // Warmup predictor cache immediately after activation
  // This ensures diagnostics API has data even before first tick
  console.log(`🔍 DEBUG: After activate_agent step - selection=${selection?.symbol}, state=${activation.state}, normalized=${!!normalized}`);
  
  if (selection?.symbol) {
    console.log(`🔥 DEBUG: Condition passed - triggering warmup for ${selection.symbol}`);
    
    // Fire and forget - don't await to avoid blocking agent creation
    setImmediate(() => {
      console.log(`🔥 DEBUG: Inside setImmediate - about to warmup ${selection.symbol}`);
      (async () => {
      try {
        const { warmupSymbol } = await import('../quantai/predictorCache.js');
        const { buildTechSnapshot } = await import('../ai/tech.js');
        const { buildPredictorFeatures } = await import('../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
        
        console.log(`🔥 Fetching technical snapshot for ${selection.symbol}...`);
        
        // Get fresh technical snapshot for the symbol
        const snapshot = await buildTechSnapshot(selection.symbol, normalized!.userId);
        const features = buildPredictorFeatures(snapshot);
        
        if (features) {
          await warmupSymbol(selection.symbol, features);
          console.log(`✅ Predictor cache warmup completed for ${selection.symbol}`);
        } else {
          console.warn(`⚠️  Predictor cache warmup: No features generated for ${selection.symbol}`);
        }
      } catch (err) {
        console.warn(`⚠️  Predictor cache warmup failed for ${selection?.symbol}:`, (err as Error).message);
        // Don't block agent creation if warmup fails
      }
      })();
    });
  }

  const warmup = gatherWarmupDiagnostics(sessionRecord.symbol);

  if (userId && normalized) {
    const targetBalance = Number.isFinite(normalized.portfolioBalanceUsd)
      ? normalized.portfolioBalanceUsd
      : normalized.startBalanceUsd;
    try {
      if (Number.isFinite(targetBalance) && targetBalance >= 0) {
        await updatePortfolioBalance(userId, normalized.mode, Number(targetBalance));
      }
      await rebalancePortfolio({ userId, mode: normalized.mode, reason: 'agent_start' });
    } catch (error) {
      console.warn('⚠️ Portfolio update failed during agent start:', error);
    }
  }

  return {
    sessionId: sessionRecord.id,
    agentId: activation.agentId,
    symbol: sessionRecord.symbol,
    mode: sessionRecord.mode,
    state: activation.state,
    warmup,
    steps,
    selection: selection!,
  };
}

function formatError(error: unknown) {
  if (error instanceof PhaseError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: 'start.unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

async function validateAndNormalize(payload: StartPayload, userId?: string | null): Promise<NormalizedStartConfig> {
  const cfg = getConfig();
  const mode = (payload.mode === 'live' ? 'live' : 'paper') as 'paper' | 'live';

  const isSmartAgent = !!(payload.isSmartAgent || payload.smartAutoMode);
  const aggressiveness =
    payload.aggressiveness === 'conservative' ||
    payload.aggressiveness === 'reactive' ||
    payload.aggressiveness === 'aggressive'
      ? payload.aggressiveness
      : 'reactive';

  const rawStrategyEngine = typeof payload.strategyEngine === 'string' ? payload.strategyEngine.toLowerCase() : '';
  const strategyEngine: 'meta_adaptive' = 'meta_adaptive'; // Only meta_adaptive supported

  // Use DEFAULT_MAX_LEVERAGE from config (12) but cap at 10 if not explicitly provided
  const defaultLeverage = Math.min(10, cfg.DEFAULT_MAX_LEVERAGE || 10);
  const maxLeverage = Math.min(10, Math.max(1, Number(payload.maxLeverage ?? defaultLeverage)));
  const dailyLossLimitPct = Math.min(4, Math.max(3, Number(payload.dailyLossLimitPct ?? 3.5)));
  const rawRiskPct = payload.riskPerTradePct ?? cfg.DEFAULT_RISK_PCT ?? 1.5;
  const riskPerTradePct = Math.min(5, Math.max(0.5, Number(rawRiskPct)));

  let budgetPctValue = Number(payload.budgetPct ?? 100);
  if (!Number.isFinite(budgetPctValue) || budgetPctValue <= 0) budgetPctValue = 100;
  let budgetFractionInput = budgetPctValue;
  if (budgetFractionInput > 1) budgetFractionInput = budgetFractionInput / 100;
  const budgetFraction = resolveBudgetFraction(budgetFractionInput, cfg);

  // For paper mode, get balance from capital pool; for live mode, fetch from exchange later
  const startBalanceUsd =
    typeof payload.startBalanceUsd === 'number' && payload.startBalanceUsd > 0
      ? Number(payload.startBalanceUsd)
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

  // Selection policy (optional)
  const rawPolicy = (payload.selectionPolicy || {}) as Partial<{
    requireSignalAtStart: boolean;
    minStartEdge: number;
    minStartConfidence: number;
    priorWeight: number;
  }>;
  const selectionPolicy = {
    requireSignalAtStart: Boolean(rawPolicy.requireSignalAtStart ?? false),
    minStartEdge: Math.min(Math.max(Number(rawPolicy.minStartEdge ?? 0.02), 0), 1),
    minStartConfidence: Math.min(Math.max(Number(rawPolicy.minStartConfidence ?? 0.55), 0), 1),
    priorWeight: Math.max(0, Number(rawPolicy.priorWeight ?? 0)),
  } as const;

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
    strategyEngine,
    rawPayload: payload,
    selectionPolicy,
  };
}

async function buildSmartUniverse(config: NormalizedStartConfig): Promise<UniverseBuildResult> {
  const agg = config.aggressiveness;
  let candidateSymbols: string[] = [];
  const diagnostics: AgentCreationLogEntry[] = [];
  const strategyProfile = deriveStrategyFilterProfile(config);
  const majorPriorityList = [
    'BTC/USDT:USDT',
    'ETH/USDT:USDT',
    'SOL/USDT:USDT',
    'BNB/USDT:USDT',
    'XRP/USDT:USDT',
    'ADA/USDT:USDT',
  ];
  const altVolumeFloor = Math.max(Number(config.volumeThresholdUsd ?? 50_000_000), 120_000_000);

  const pushDiagnostic = (
    level: AgentCreationLogLevel,
    message: string,
    meta?: Record<string, any>
  ) => {
    diagnostics.push({
      timestamp: Date.now(),
      level,
      message,
      context: 'universe_build',
      meta,
    });
  };

  pushDiagnostic('info', 'Fetching optimized crypto universe', {
    aggressiveness: agg,
    minVolumeUsd: config.volumeThresholdUsd,
  });

  // Use smart selection orchestrator for optimized selection
  const [listOutcome, prefetchedOutcome] = await Promise.all([
    runWithTimeout(() => getOptimizedCryptoList(undefined, 1, { strategy: strategyProfile }), SMART_UNIVERSE_BUILD_TIMEOUT_MS),
    runWithTimeout(
      async () => {
        try {
          // Try smart orchestrator first (cached, context-aware, faster)
          const smartResult = await selectBestOpportunity(undefined);
          // Return full analysis object as expected by caller
          return smartResult.analysis;
        } catch (error) {
          console.warn('Smart orchestrator failed, falling back to legacy:', error);
          // Fallback to legacy method
          return getBestIntelligentOpportunity(undefined, {
            aggressiveness: agg,
            maxUsage: 0,
          });
        }
      },
      SMART_PREFETCH_TIMEOUT_MS,
    ),
  ]);

  if (listOutcome.timedOut) {
    pushDiagnostic('warn', 'Optimized universe build timed out', {
      timeoutMs: SMART_UNIVERSE_BUILD_TIMEOUT_MS,
    });
    candidateSymbols = majorPriorityList.slice();
  } else if (listOutcome.error) {
    console.warn('⚠️ Failed to fetch optimized crypto list:', listOutcome.error);
    pushDiagnostic('warn', 'Failed to fetch optimized crypto list', {
      error: listOutcome.error instanceof Error ? listOutcome.error.message : String(listOutcome.error),
    });
    candidateSymbols = [];
  } else {
    candidateSymbols = Array.isArray(listOutcome.result) ? listOutcome.result : [];
    pushDiagnostic('info', 'Applied liquidity and performance filters', {
      survivors: candidateSymbols.length,
      aggressiveness: strategyProfile.aggressiveness,
    });
  }

  let prefetchedOpportunity = prefetchedOutcome.result ?? null;
  if (prefetchedOutcome.timedOut) {
    prefetchedOpportunity = null;
    pushDiagnostic('warn', 'Prefetched AI opportunity request timed out', {
      timeoutMs: SMART_PREFETCH_TIMEOUT_MS,
    });
  } else if (prefetchedOutcome.error) {
    console.warn('⚠️ Failed to evaluate prefetched opportunity:', prefetchedOutcome.error);
    pushDiagnostic('warn', 'Failed to evaluate prefetched AI opportunity', {
      error:
        prefetchedOutcome.error instanceof Error
          ? prefetchedOutcome.error.message
          : String(prefetchedOutcome.error),
    });
    prefetchedOpportunity = null;
  } else if (prefetchedOpportunity) {
    pushDiagnostic('info', 'Evaluated prefetched AI opportunity', {
      symbol: prefetchedOpportunity.symbol,
      score: (prefetchedOpportunity as any)?.score,
    });
  }

  if (prefetchedOpportunity && !candidateSymbols.includes(prefetchedOpportunity.symbol)) {
    candidateSymbols.unshift(prefetchedOpportunity.symbol);
  }
  candidateSymbols = Array.from(new Set(candidateSymbols));

  const testMode = process.env.UNIT_TEST_MODE === 'true';
  if (testMode) {
    const fallbackCandidates = candidateSymbols.length
      ? candidateSymbols
      : ['ETH/USDT:USDT', 'SOL/USDT:USDT', 'ADA/USDT:USDT'];
    const baselineSymbols = fallbackCandidates.filter((sym) => majorPriorityList.includes(sym));
    return {
      prefetchedOpportunity,
      candidateCount: fallbackCandidates.length,
      orderableCount: fallbackCandidates.length,
      shouldActivate: fallbackCandidates.length > 0,
      topSymbols: fallbackCandidates.slice(0, 5),
      analyzedSymbols: fallbackCandidates,
      orderableSymbols: fallbackCandidates,
      baselineSymbols: baselineSymbols.length ? baselineSymbols : majorPriorityList,
      diagnostics,
    };
  }

  if (!candidateSymbols.length) {
    pushDiagnostic('warn', 'No candidates returned by AI ranking');
    return {
      prefetchedOpportunity,
      candidateCount: 0,
      orderableCount: 0,
      shouldActivate: false,
      topSymbols: [],
      analyzedSymbols: [],
      orderableSymbols: [],
      baselineSymbols: majorPriorityList,
      diagnostics,
    };
  }

  const analysisLimit = resolveSmartAnalysisLimit();
  const analysisUniverse = candidateSymbols.slice(0, analysisLimit);
  pushDiagnostic('info', 'Running orderability checks on AI-ranked shortlist', {
    shortlistSize: analysisUniverse.length,
    analysisLimit,
  });

  const orderabilityChecks = await Promise.all(
    analysisUniverse.map((sym) => evaluateOrderability(sym, config, pushDiagnostic))
  );

  const orderableSymbols = orderabilityChecks.filter((c) => c.orderable).map((c) => c.symbol);
  const baselineMajors = majorPriorityList.filter((sym) => orderableSymbols.includes(sym) || candidateSymbols.includes(sym));
  const baselineSymbols = baselineMajors.length ? Array.from(new Set(baselineMajors)) : majorPriorityList;
  const baselineSet = new Set(baselineSymbols);

  const qualifiedAlts = orderabilityChecks
    .filter((c) => !baselineSet.has(c.symbol) && c.orderable && c.volumeUsd >= altVolumeFloor)
    .map((c) => c.symbol);

  const prioritized = Array.from(new Set([
    ...baselineSymbols,
    ...qualifiedAlts,
    ...orderableSymbols,
    ...candidateSymbols,
  ]));

  if (!orderableSymbols.length) {
    pushDiagnostic('warn', 'No orderable symbols cleared risk thresholds', {
      analyzedSymbols: analysisUniverse.slice(0, 10),
    });
  } else {
    pushDiagnostic('success', 'Found orderable symbols above liquidity floor', {
      symbols: orderableSymbols.slice(0, 10),
    });
  }

  return {
    prefetchedOpportunity,
    candidateCount: candidateSymbols.length,
    orderableCount: orderableSymbols.length,
    shouldActivate: orderableSymbols.length > 0 || candidateSymbols.length > 0,
    topSymbols: prioritized.slice(0, 10),
    analyzedSymbols: analysisUniverse,
    orderableSymbols,
    baselineSymbols,
    diagnostics,
  };
}

function deriveStrategyFilterProfile(config: NormalizedStartConfig): StrategyFilterProfile {
  const env = getConfig();
  const minTp = Number(env.MIN_TP_PCT ?? 1.2);
  const targetTpRaw = env.TARGET_TP1_PCT ?? env.MIN_TP_PCT ?? 1.2;
  const targetTp = Number(targetTpRaw);
  const stopFloor = Number(env.MIN_STOP_PCT ?? 0.5);
  const requestedStop = Number((config.rawPayload as any)?.minStopPct);
  return {
    aggressiveness: config.aggressiveness,
    targetTpPct: Math.max(minTp, targetTp || minTp),
    stopLossPct: Math.max(stopFloor, Number.isFinite(requestedStop) ? requestedStop : stopFloor),
  };
}

async function selectSymbol(
  config: NormalizedStartConfig,
  universe: UniverseBuildResult | null,
  options?: { reservationToken?: string }
): Promise<AgentCreationSelectionSummary> {
  let symbol = config.symbol;
  const reservationToken = options?.reservationToken;
  const decisionLog: AgentCreationLogEntry[] = [];
  const summary: AgentCreationSelectionSummary = {
    symbol: symbol || '',
    autoSelected: false,
    source: symbol ? 'manual' : 'candidate',
    candidates: [],
    prefetchedSymbol: universe?.prefetchedOpportunity?.symbol ?? null,
    candidateCount: universe?.candidateCount,
    orderableCount: universe?.orderableCount,
    analyzedSymbols: universe?.analyzedSymbols ?? [],
    orderableSymbols: universe?.orderableSymbols ?? [],
    baselineSymbols: universe?.baselineSymbols ?? [],
    decisionLog,
  };

  if (config.isSmartAgent) {
    const prefetched = universe?.prefetchedOpportunity ?? null;
    const candidates = universe?.topSymbols ?? [];
    summary.candidates = candidates;
    decisionLog.push({
      timestamp: Date.now(),
      level: 'info',
      message: 'Evaluating smart auto-select candidates',
      context: 'selection',
      meta: {
        candidateCount: universe?.candidateCount ?? candidates.length,
        orderableCount: universe?.orderableCount ?? candidates.length,
      },
    });

    for (const diagnostic of universe?.diagnostics ?? []) {
      decisionLog.push({ ...diagnostic });
    }

    if (!symbol && prefetched) {
      // Filter out opportunities with unclear bias (none)
      if (prefetched.autoBias?.bias === 'none' || !prefetched.autoBias || prefetched.autoBias.confidence < 0.5) {
        decisionLog.push({
          timestamp: Date.now(),
          level: 'warn',
          message: `Prefetched opportunity ${prefetched.symbol} has unclear signal (bias: ${prefetched.autoBias?.bias || 'unknown'}, confidence: ${prefetched.autoBias?.confidence || 0})`,
          context: 'selection',
          meta: { reason: 'unclear_signal' },
        });
      } else if (reservationToken && isSmartSymbolReserved(prefetched.symbol, reservationToken)) {
        decisionLog.push({
          timestamp: Date.now(),
          level: 'warn',
          message: `Prefetched opportunity ${prefetched.symbol} temporarily reserved by another creation`,
          context: 'selection',
          meta: { reason: 'reserved' },
        });
      } else {
        // Try to reserve FIRST to prevent race conditions
        const reserved = tryReserveSmartSymbol(prefetched.symbol, reservationToken);
        if (!reserved) {
          decisionLog.push({
            timestamp: Date.now(),
            level: 'warn',
            message: `Prefetched opportunity ${prefetched.symbol} reserved in parallel`,
            context: 'selection',
            meta: { reason: 'reservation_conflict' },
          });
        } else {
          // Only check DB + in-memory reservations after successful reservation
          const usage = await getActiveAgentCountForSymbol(prefetched.symbol, undefined, reservationToken);
          if (usage === 0) {
            symbol = prefetched.symbol;
            summary.autoSelected = true;
            summary.source = 'prefetched';
            decisionLog.push({
              timestamp: Date.now(),
              level: 'success',
              message: `Prefetched opportunity ${prefetched.symbol} selected`,
              context: 'selection',
            });
          } else {
            // Release reservation since symbol is already in use
            releaseSmartReservation(reservationToken);
            console.log(
              `🚫 Prefetched opportunity ${prefetched.symbol} already has ${usage} active agent(s) – seeking alternative`
            );
            decisionLog.push({
              timestamp: Date.now(),
              level: 'warn',
              message: `Prefetched opportunity ${prefetched.symbol} already used`,
              context: 'selection',
              meta: { activeAgents: usage },
            });
          }
        }
      }
    }

    // Helper to evaluate predictor start signal for a symbol
    const evaluateStartSignal = async (sym: string) => {
      try {
        const snap = await buildTechSnapshot(sym, config.userId);
        const features = buildPredictorFeatures(snap);
        if (!features) return { ok: false, reason: 'features_unavailable' } as const;
        const pred = getPredictionSyncSafe(features, { allowFallback: true });
        const pLong = pred.probabilities.long;
        const pShort = pred.probabilities.short;
        const pNone = pred.probabilities.none;
        const primary = Math.max(pLong, pShort);
        const top: 'long' | 'short' | 'none' = pNone >= primary && pNone >= Math.max(pLong, pShort) ? 'none' : (pLong >= pShort ? 'long' : 'short');
        const edge = Math.abs(pLong - pShort);
        const confidence = pred.confidence;
        const meets = top !== 'none' && primary >= config.selectionPolicy.minStartEdge && confidence >= config.selectionPolicy.minStartConfidence;
        const priorScore = (primary - pNone) * Math.max(confidence, 0);
        return { ok: true, top, primary, edge, confidence, priorScore } as const;
      } catch (error) {
        return { ok: false, reason: (error as Error).message || 'predict_failed' } as const;
      }
    };

    if (!symbol) {
      // Optionally reorder candidates by predictor prior if priorWeight > 0
      let orderedCandidates = candidates.slice();
      if (config.selectionPolicy.priorWeight > 0 && orderedCandidates.length) {
        const sample = orderedCandidates.slice(0, Math.min(8, orderedCandidates.length));
        const scored: Array<{ sym: string; score: number }> = [];
        for (const sym of sample) {
          const evalRes = await evaluateStartSignal(sym);
          const score = evalRes.ok ? evalRes.priorScore : 0;
          scored.push({ sym, score });
        }
        const byScore = scored.sort((a,b) => b.score - a.score).map(s => s.sym);
        const rest = orderedCandidates.filter(s => !byScore.includes(s));
        orderedCandidates = [...byScore, ...rest];
      }

      for (const candidate of orderedCandidates) {
        try {
          if (reservationToken && isSmartSymbolReserved(candidate, reservationToken)) {
            decisionLog.push({
              timestamp: Date.now(),
              level: 'info',
              message: `Skipped ${candidate} because it is reserved by another creation`,
              context: 'selection',
              meta: { reason: 'reserved' },
            });
            continue;
          }
          
          // Try to reserve FIRST to prevent race conditions
          const reserved = tryReserveSmartSymbol(candidate, reservationToken);
          if (!reserved) {
            decisionLog.push({
              timestamp: Date.now(),
              level: 'info',
              message: `Skipped ${candidate} due to simultaneous reservation conflict`,
              context: 'selection',
              meta: { reason: 'reservation_conflict' },
            });
            continue;
          }
          
          // Only check DB + in-memory reservations after successful reservation
          const usage = await getActiveAgentCountForSymbol(candidate, undefined, reservationToken);
          let passSignal = true;
          if (config.selectionPolicy.requireSignalAtStart) {
            const evalRes = await evaluateStartSignal(candidate);
            passSignal = evalRes.ok && evalRes.top !== 'none' && evalRes.primary >= config.selectionPolicy.minStartEdge && evalRes.confidence >= config.selectionPolicy.minStartConfidence;
            decisionLog.push({
              timestamp: Date.now(),
              level: passSignal ? 'info' : 'warn',
              message: passSignal ? `Candidate ${candidate} meets start signal thresholds` : `Candidate ${candidate} failed start signal thresholds`,
              context: 'selection',
            });
          }

          if (usage === 0 && passSignal) {
            symbol = candidate;
            summary.autoSelected = true;
            summary.source = 'candidate';
            decisionLog.push({
              timestamp: Date.now(),
              level: 'success',
              message: `Selected ${candidate} after availability and signal scan`,
              context: 'selection',
            });
            break;
          } else {
            // Release reservation since symbol is already in use
            releaseSmartReservation(reservationToken);
            decisionLog.push({
              timestamp: Date.now(),
              level: 'info',
              message: usage > 0 ? `Skipped ${candidate} because it has ${usage} active agent(s)` : `Skipped ${candidate} due to unmet signal thresholds`,
              context: 'selection',
              meta: { activeAgents: usage },
            });
          }
        } catch (error) {
          // Release reservation on error
          releaseSmartReservation(reservationToken);
          console.warn(`⚠️ Failed to check active count for ${candidate}:`, error);
          decisionLog.push({
            timestamp: Date.now(),
            level: 'warn',
            message: `Failed to check active agent count for ${candidate}`,
            context: 'selection',
            meta: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }

    if (!symbol) {
      if (config.selectionPolicy.requireSignalAtStart) {
        decisionLog.push({
          timestamp: Date.now(),
          level: 'error',
          message: 'No candidate met start signal thresholds',
          context: 'selection',
        });
        throw new PhaseError('start.signal_not_ready', 'no_candidate_met_start_signal_thresholds', {
          minStartEdge: config.selectionPolicy.minStartEdge,
          minStartConfidence: config.selectionPolicy.minStartConfidence,
        });
      }
      const activeCount = await prisma.agentSession.count({ where: { stoppedAt: null } });
      decisionLog.push({
        timestamp: Date.now(),
        level: 'error',
        message: 'No unused symbol available for smart agent',
        context: 'selection',
        meta: {
          activeAgents: activeCount,
          candidateCount: universe?.candidateCount ?? 0,
        },
      });
      throw new PhaseError('start.universe_conflict', 'no_unused_symbol_available', {
        activeAgents: activeCount,
        candidateCount: universe?.candidateCount ?? 0,
      });
    }
  } else if (!symbol && config.perps && config.perps.length) {
    const ranked = await selectBestPerp(config.perps);
    symbol = ranked[0]?.symbol;
    if (!symbol) {
      throw new PhaseError('start.universe_conflict', 'no_symbol_selected', {});
    }
    summary.autoSelected = true;
    summary.source = 'perp_ranking';
    summary.candidates = config.perps;
    decisionLog.push({
      timestamp: Date.now(),
      level: 'info',
      message: `Selected ${symbol} from provided perp list`,
      context: 'selection',
    });
  }

  if (!symbol) {
    throw new PhaseError('start.universe_conflict', 'no_symbol_selected', {});
  }

  summary.symbol = symbol;

  if (config.symbol) {
    // If manual symbol specified and selection requires signal at start, validate now
    if (config.selectionPolicy.requireSignalAtStart) {
      const evalRes = await (async () => {
        try {
          const snap = await buildTechSnapshot(symbol, config.userId);
          const features = buildPredictorFeatures(snap);
          if (!features) return { ok: false } as const;
          const pred = getPredictionSyncSafe(features, { allowFallback: true });
          const pLong = pred.probabilities.long;
          const pShort = pred.probabilities.short;
          const pNone = pred.probabilities.none;
          const primary = Math.max(pLong, pShort);
          const top: 'long' | 'short' | 'none' = pNone >= primary && pNone >= Math.max(pLong, pShort) ? 'none' : (pLong >= pShort ? 'long' : 'short');
          const confidence = pred.confidence;
          const ok = top !== 'none' && primary >= config.selectionPolicy.minStartEdge && confidence >= config.selectionPolicy.minStartConfidence;
          return { ok } as const;
        } catch {
          return { ok: false } as const;
        }
      })();
      if (!evalRes.ok) {
        decisionLog.push({
          timestamp: Date.now(),
          level: 'error',
          message: `Manual symbol ${symbol} failed start signal thresholds`,
          context: 'selection',
        });
        throw new PhaseError('start.signal_not_ready', 'manual_symbol_signal_threshold_not_met', {
          symbol,
          minStartEdge: config.selectionPolicy.minStartEdge,
          minStartConfidence: config.selectionPolicy.minStartConfidence,
        });
      }
    }
    decisionLog.push({
      timestamp: Date.now(),
      level: 'info',
      message: `Using manually specified symbol ${symbol}`,
      context: 'selection',
    });
  }

  if (!decisionLog.some((entry) => entry.level === 'success')) {
    decisionLog.push({
      timestamp: Date.now(),
      level: 'success',
      message: `Selected ${symbol} for new session`,
      context: 'selection',
    });
  }

  return summary;
}

async function createSessionRecord(
  config: NormalizedStartConfig,
  chosenSymbol: string,
  userId?: string
) {
  let symbol = chosenSymbol;

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
  } else if (config.mode === 'paper') {
    // Use capital pool balance for paper mode
    if (config.startBalanceUsd <= 0) {
      try {
        const { getBalanceSnapshot } = await import('./capitalPool.js');
        const poolSnapshot = await getBalanceSnapshot('paper');
        const poolBalance = poolSnapshot.freeUSD.toNumber();
        config.startBalanceUsd = Math.max(100, poolBalance); // Minimum 100$ to ensure orderability
        console.log(`💰 Using capital pool balance for paper session: $${config.startBalanceUsd.toFixed(2)}`);
      } catch (error) {
        console.warn('⚠️ Failed to fetch capital pool balance, using minimum:', error);
        config.startBalanceUsd = 100; // Emergency fallback
      }
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
    userId: config.userId,
    sizingMode: config.rawPayload?.sizingMode,
    dynamicLeverage: config.rawPayload?.dynamicLeverage !== false,
    minLeverage,
    strategyEngine: config.strategyEngine,
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
  return { session, symbol };
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

  // For smart agents, delay activation until after smart selection completes
  // This prevents orders from being placed on temporary placeholder symbols
  const shouldDelayActivation = normalized.isSmartAgent;

  if (params.shouldActivate && !shouldDelayActivation) {
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
      strategyEngine: normalized.strategyEngine,
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
    
    // Fetch the updated session to get the correct symbol after smart selection
    const updatedSession = await prisma.agentSession.findUnique({
      where: { id: session.id },
      select: { symbol: true, currentSymbol: true }
    });
    const finalSymbol = updatedSession?.currentSymbol || updatedSession?.symbol || session.symbol;
    
    // Now that smart selection is complete and symbol is set, activate the agent hub
    // This ensures no orders are placed before the correct symbol is selected
    console.log(`🚀 Smart selection complete (${finalSymbol}), activating agent hub for session ${session.id}`);
    try {
      await AgentHub.activate(session.id, {
        symbol: finalSymbol,
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
        strategyEngine: normalized.strategyEngine,
      } as any);
      agentId = session.id;
      
      // Force first tick in background and validate signal (fire-and-forget)
      console.log(`⚡ Scheduling immediate first tick for ${session.id}`);
      (async () => {
        try {
          await new Promise(resolve => setTimeout(resolve, 500));
          await AgentHub.onTick(session.id);
          console.log(`✅ First tick completed for ${session.id}`);
          
          // Wait for predictor to update
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Validate signal clarity
          const agent = AgentHub.get(session.id);
          const signal = (agent as any)?.pythonSignal;
          
          if (signal?.decision === 'none' || 
              !signal?.decision || 
              (signal?.probabilities?.none ?? 0) > 0.7) {
            console.log(`❌ Agent ${session.id} (${finalSymbol}) has unclear signal (decision: ${signal?.decision}, none: ${signal?.probabilities?.none}) - stopping agent`);
            await AgentHub.closeNow(session.id, 'unclear_signal_after_first_tick');
          } else {
            console.log(`✅ Agent ${session.id} (${finalSymbol}) has clear signal: ${signal?.decision} (none: ${signal?.probabilities?.none})`);
          }
        } catch (error) {
          console.error(`⚠️ First tick or validation failed for ${session.id}:`, error);
        }
      })().catch(err => console.error(`Background tick error for ${session.id}:`, err));
      
      // Schedule post-activation tasks with the final symbol
      schedulePostActivationTasks(session.id, finalSymbol, normalized);
    } catch (error) {
      console.error('❌ Failed to activate agent hub after smart selection:', error);
      return { state: 'warming', agentId, reason: 'agent_activation_failed' };
    }
    
    return { state: 'ready', agentId };
  }

  // Force first tick for non-smart agents too (fire-and-forget)
  if (agentId) {
    console.log(`⚡ Scheduling immediate first tick for ${session.id}`);
    (async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        await AgentHub.onTick(session.id);
        console.log(`✅ First tick completed for ${session.id}`);
        
        // Wait for predictor to update
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Validate signal clarity
        const agent = AgentHub.get(session.id);
        const signal = (agent as any)?.pythonSignal;
        
        if (signal?.decision === 'none' || 
            !signal?.decision || 
            (signal?.probabilities?.none ?? 0) > 0.7) {
          console.log(`❌ Agent ${session.id} (${session.symbol}) has unclear signal (decision: ${signal?.decision}, none: ${signal?.probabilities?.none}) - stopping agent`);
          await AgentHub.closeNow(session.id, 'unclear_signal_after_first_tick');
        } else {
          console.log(`✅ Agent ${session.id} (${session.symbol}) has clear signal: ${signal?.decision} (none: ${signal?.probabilities?.none})`);
        }
      } catch (error) {
        console.error(`⚠️ First tick or validation failed for ${session.id}:`, error);
      }
    })().catch(err => console.error(`Background tick error for ${session.id}:`, err));
  }

  schedulePostActivationTasks(session.id, session.symbol, normalized);
  return { state: 'ready', agentId };
}

function schedulePostActivationTasks(sessionId: string, symbol: string, config: NormalizedStartConfig) {
  setTimeout(async () => {
    try {
      const plan = await proposePlan(symbol, { fresh: true, sessionId });
      await savePlan(sessionId, plan as any);
      // Plan generation for persistence only
    } catch (error) {
      console.warn('⚠️ Failed to generate plan during post activation:', error);
    }
    try {
      const { strategy: strat, levels: lvls } = await requestStrategy({
        symbol,
        trigger: 'activation',
        sessionId,
        fresh: true,
        force: true,
      });
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

export const __agentCreationTestHooks = {
  fetchTickerWithTimeout,
  evaluateOrderability,
  isOrderabilityTickerTimeoutError,
  OrderabilityTickerTimeoutError,
  runWithTimeout,
};

