import { proposePlan } from '../../ai/planOrchestrator.js';
import { predictor } from '../../ai/predictor.js';
import type { RegimeProfile } from '../../ai/regime.js';
import { buildTechSnapshot, TechnicalSnapshot } from '../../ai/tech.js';
import { getCapacityPressure, inspectExposure, LiveBroker } from '../../broker/live.js';
import { PaperBroker } from '../../broker/paper.js';
import type { Broker, PlacedOrder, BrokerMarginSnapshot } from '../../broker/types.js';
import { InsufficientDataError, isInsufficientDataError } from '../../data/errors.js';
import { getTicker } from '../../data/market.js';
import { getAICallsCount } from '../../metrics/aiCalls.js';
import { recordOpsEvent } from '../../monitor/ops.js';
import { AdaptiveRiskResult, computeAdaptiveRisk } from '../../risk/adaptive.js';
import type { ResolvedLeverageCap } from '../../risk/leverageCaps.js';
import { computeQtyNotional, defaultLimits, RiskDecision } from '../../risk/manager.js';
import { getUserCredentials } from '../../services/userCredentials.js';
import { getAgentRecentWinRate } from '../../services/performance/winrate.js';
import { getConfig, getModeParams, type AgentAggressiveness, type ModeParams } from '../../utils/env.js';
import { clampBudgetFraction, resolveBudgetFraction } from '../../utils/budget.js';
import { computeLeverageGuardForSymbol } from '../../utils/riskGuards.js';
import { applyHysteresis, blendRR, DEFAULT_RR_EXPECTANCY_CONFIG, resolveRrExpectancyConfig, rrMinFromWinrate, type RRExpectancyConfig } from '../../risk/rrExpectancy.js';
import { broadcast } from '../../ws/hub.js';
import { loadActivePosition, recordEnter, recordExit, loadCircuitBreakerState, persistCircuitBreakerState } from '../persistence.js';
import { PlanJson } from '../planSchema.js';
import { ValidatedPlan, validatePlan } from '../validator.js';
import { getQuantAIConfig, reloadQuantAIConfig, CircuitBreaker, EntryFilters, PositionSizer, applyFeesAndSlippage, maybeAdjustOrExit, computeInitialBracket } from '../../quantai/index.js';
import { evaluateRecognizedStrategies, RecognizedStrategySignal } from '../../quantai/strategy/recognizedStrategies.js';
import { chooseExecutionPlan, ExecutionPlan } from '../executionPlanner.js';
import type { EntryRelaxation } from '../../quantai/strategy/entryFilters.js';
import type { CircuitBreakerDecision, CircuitBreakerState, ExitArchetype } from '../../quantai/index.js';
import { createMarginAdvisor } from '../../risk/marginTools.js';
import type {
  AccountSnapshot,
  ActivationProfile,
  ActivePosition,
  AgentMode,
  AgentState,
  DiagnosticBlocker,
  DiagnosticCheckRef,
  ExitDiagnosticsPayload,
  MarketContext,
  MomentumAwaitContext,
  MomentumGateEvaluation,
  PerformanceMetrics,
  ProtectiveSnapshot,
  QualityAssessmentSnapshot,
  QualityScoreProfile,
  StrategyPerformance,
  StrongTrendAssessment,
  TradeCadenceConfig,
  TradeCadenceStageConfig,
  TradeCadenceState,
  VolumeContext,
} from './types.js';
import { createMomentumAwaitContext } from './types.js';
import { applyPortfolioAllocation as applyPortfolioAllocationHelper, type PortfolioAllocationUpdate } from './portfolioAllocation.js';
import { entryZoneMethods } from './rebound/entryZone.js';
import { liquidityMethods } from './rebound/liquidity.js';

export class ReboundRejectionAgent {
  public static readonly memeSymbols = new Set<string>([
    'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'WIF', 'BONK', 'PUMP', 'AVNT', 'MEW', 'WEN',
  ]);
  private static readonly TIER_PERFORMANCE_RETENTION_MS = 72 * 60 * 60 * 1000; // 72h rolling window
  private static readonly TIER_PERFORMANCE_MAX = 30;
  state: AgentState = 'IDLE';
  profile: ActivationProfile | null = null;
  plan: ValidatedPlan | null = null;
  broker: Broker | null = null;
  pos: ActivePosition | null = null;
  extendedOnce = false;
  public lastExitTime = 0; // Track last exit time for cooldown
  public entering = false;
  sessionId: string | null = null;
  public breakoutTicks = 0; // consecutive ticks confirming breakout
  public invalidationTicks = 0; // consecutive ticks price outside entry zone
  regime: RegimeProfile | null = null;
  public adaptiveRisk: AdaptiveRiskResult | null = null;
  public protectiveErrorCount = 0;
  public killSwitchContext: { reason: string; details?: any } | null = null;
  public haltAckRequired = false;
  public marginHaltState: {
    active: boolean;
    mode: 'entries_only' | 'full' | null;
    activatedAt: number;
    lastBreachTs: number;
  } = {
    active: false,
    mode: null,
    activatedAt: 0,
    lastBreachTs: 0,
  };
  public lastMarginSnapshot: BrokerMarginSnapshot | null = null;
  public recoveryTimer: NodeJS.Timeout | null = null;
  public cooldownTimer: NodeJS.Timeout | null = null;
  public cooldownContext: { reason: string; guard?: RiskDecision; triggeredAt: number } | null = null;
  public lastExitCooldownMs = 0;
  public maxNotionalCapUsd = Infinity;
  public orderAttemptLogCount = 0;
  public lastDiagnosticCanTrade: boolean | null = null;
  public lastQualityFilterFailure: { code: string; message?: string; details?: any } | null = null;
  public lastMomentumGateResult: MomentumGateEvaluation | null = null;
  public previewQualityDiagnostics: {
    snapshotKey: string | number | null;
    data: any;
    assessment: QualityAssessmentSnapshot;
  } | null = null;
  public marketContext: MarketContext | null = null;
  public lastMarketContextSignature: { direction: 'long' | 'short' | 'none'; playbook: string; updatedAt: number } | null = null;

  // Entry zone intelligence helpers
  public confirmEntrySignal = entryZoneMethods.confirmEntrySignal;
  public resetVolumeRatioHistory = entryZoneMethods.resetVolumeRatioHistory;
  public resetMomentumAwaitContext = entryZoneMethods.resetMomentumAwaitContext;
  public updateVolumeRatioHistory = entryZoneMethods.updateVolumeRatioHistory;
  public normalizeToUnitInterval = entryZoneMethods.normalizeToUnitInterval;
  public resolveSessionLiquidityContext = entryZoneMethods.resolveSessionLiquidityContext;
  public resolveProbeFeedback = entryZoneMethods.resolveProbeFeedback;
  public clampValue = entryZoneMethods.clampValue;
  public isZoneExpired = entryZoneMethods.isZoneExpired;
  public handleGapDetection = entryZoneMethods.handleGapDetection;
  public calculateRecentSlope = entryZoneMethods.calculateRecentSlope;
  public ensureMinimumZoneWidth = entryZoneMethods.ensureMinimumZoneWidth;
  public shouldRecalculateProgressiveZone = entryZoneMethods.shouldRecalculateProgressiveZone;
  public isExtremeVolatility = entryZoneMethods.isExtremeVolatility;
  public isConsolidating = entryZoneMethods.isConsolidating;
  public hasValidTechnicalData = entryZoneMethods.hasValidTechnicalData;
  public hasAdequateLiquidity = entryZoneMethods.hasAdequateLiquidity;
  public priceInZoneWithEpsilon = entryZoneMethods.priceInZoneWithEpsilon;
  public computeVolatilityAdjustedZone = entryZoneMethods.computeVolatilityAdjustedZone;
  public capMaximumZoneWidth = entryZoneMethods.capMaximumZoneWidth;
  public detectConsolidationBreakout = entryZoneMethods.detectConsolidationBreakout;
  public getVolatilityStrategy = entryZoneMethods.getVolatilityStrategy;
  public getAdaptiveConfirmationTime = entryZoneMethods.getAdaptiveConfirmationTime;
  public calculatePositionForTargetProfit = entryZoneMethods.calculatePositionForTargetProfit;
  public getMultiTimeframeScore = entryZoneMethods.getMultiTimeframeScore;
  public evaluateAntiWhaleFilters = liquidityMethods.evaluateAntiWhaleFilters;
  public passesAntiWhaleFilters = liquidityMethods.passesAntiWhaleFilters;
  public executeVolumeProbe = liquidityMethods.executeVolumeProbe;
  public finalizeVolumeProbe = liquidityMethods.finalizeVolumeProbe;

  // simplistic counters for risk
  consecutiveStops = 0;
  tradesToday = 0;
  realizedPnlTodayPct = 0;

  public tradeCadenceConfig: TradeCadenceConfig | null = null;
  public tradeCadenceState: TradeCadenceState = {
    stageIndex: 0,
    stageLabel: 'base',
    maxTradesPerDay: 7,
    cooldownMs: 30_000,
    lastWinRate: 0,
    sampleSize: 0,
    lastUpdated: Date.now(),
    reason: 'init',
  };
  
  // ✅ ULTRA-INTELLIGENT: Performance tracking BY TIER (contextualized learning)
  public recentTradesByTier: Map<string, { symbol: string; win: boolean; pnlPct: number; timestamp: number }[]> = new Map([
    ['tier1', []],  // BTC, ETH, SOL - Ultra stable
    ['tier2', []],  // Major alts - Stable
    ['tier3', []]   // Volatile alts - High risk
  ]);

  // ✅ PHASE 1 FIXES: Entry Zone Critical Improvements
  public priceInZoneStartTime = 0;           // Whipsaw protection: timestamp when price entered zone
  public gapEntryOverride = false;            // Gap detection: override entry validation if gap favorable
  public zoneCalculatedForBias: 'long' | 'short' | 'none' = 'none'; // Bias mismatch: track bias used for zone
  public lastZoneCalculation = 0;             // Zone expiration: timestamp of last zone calculation
  public requireStrongerConfirmation = false; // Support break: flag when price near weak support
  public volumeRatioHistory: number[] = [];
  public lastWhaleSpikeTs = 0;
  public whaleQuarantine: {
    active: boolean;
    triggeredAt: number;
    until: number;
    reason: string;
    adxAtTrigger: number;
    atrPctAtTrigger: number;
    spikeRatio: number;
    threshold: number;
    logged: boolean;
  } | null = null;
  public volumeProbeState: {
    active: boolean;
    lastAttemptTs: number;
    orderId: string | null;
    side: 'buy' | 'sell';
    status: 'new' | 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected';
    targetNotional: number;
    timeoutMs: number;
    readiness?: number;
    lastFillTs?: number;
    fillNotional?: number;
  } | null = null;
  public volumeProbeTimeout: NodeJS.Timeout | null = null;
  public momentumAwaitContext: MomentumAwaitContext = createMomentumAwaitContext();
  public aiBiasOverride: {
    bias: 'long' | 'short';
    originalBias: 'long' | 'short' | 'none';
    confidence: number;
    appliedAt: number;
    expiresAt: number;
  } | null = null;
  public lastConfirmationSnapshot: {
    reason: string;
    timestamp: number;
    meta?: {
      timeThresholdMs: number;
      timeInZoneMs: number;
      mode: 'standard' | 'momentum';
      confirmationMode: 'adaptive' | 'fast_track' | 'timeout' | 'momentum' | 'probe' | null;
    };
  } | null = null;
  
  // ✅ Quality threshold adjustment BY TIER (independent learning per category)
  public qualityAdjustmentByTier: Map<string, number> = new Map([
    ['tier1', 0],
    ['tier2', 0],
    ['tier3', 0]
  ]);

  // ✅ Cooldown tracking BY TIER (one tier paused doesn't affect others)
  public cooldownByTier: Map<string, number> = new Map([
    ['tier1', 0],
    ['tier2', 0],
    ['tier3', 0]
  ]);
  
  // Legacy global tracking (deprecated, kept for compatibility)
  public recentTrades: { win: boolean; pnlPct: number; timestamp: number }[] = [];
  public qualityThresholdAdjustment = 0; // Dynamic adjustment to quality thresholds
  public lastLossStreakNotified = 0;
  public lastMomentumTimeoutTs = 0;
  
  // 🆕 Breakout mode tracking
  public lastTradeWasWin = false;
  public lastZoneRecalcTime = 0;
  public lastZoneCheckTime = 0;
  public breakoutModeActive = false;
  public runtimeEntryZone: { from: number; to: number; mid: number } | null = null;
  public runtimeZoneDiagnostics: {
    anchor: number;
    k: number;
    atr: number;
    atrPct: number;
    atrPctBase: number;
    hysteresis: number;
    breakoutDistancePct: number;
    breakoutActive: boolean;
    breakoutDirection: 'above' | 'below' | 'none';
  } | null = null;
  public lastBiasRouting: {
    playbook: string;
    planBias: string;
    adaptiveBias: string;
    activeBias: string;
    reason: string | null;
  } | null = null;

  public drySpellState: {
    rejections: number;
    steps: number;
    lastStepTs: number;
    lastTradeTs: number;
  } = {
    rejections: 0,
    steps: 0,
    lastStepTs: 0,
    lastTradeTs: 0,
  };

  public filterRejectionStats: {
    total: number;
    failCounts: Map<string, number>;
    lastLogTs: number;
  } = {
    total: 0,
    failCounts: new Map<string, number>(),
    lastLogTs: 0,
  };

  public lastPortfolioAllocationUpdate = 0;

  applyPortfolioAllocation(update: PortfolioAllocationUpdate): void {
    const result = applyPortfolioAllocationHelper(
      {
        profile: this.profile,
        broker: this.broker,
        sessionId: this.sessionId,
      },
      update,
    );
    if (result.updatedAt != null) {
      this.lastPortfolioAllocationUpdate = result.updatedAt;
    }
  }

  public getQualitySnapshotKey(snap: TechnicalSnapshot): string | number | null {
    return (snap as any)?.id ?? (snap as any)?.snapshotId ?? null;
  }

  public resetQualityPreview(): void {
    this.previewQualityDiagnostics = null;
  }

  public trendReversalContext: { direction: 'bullish' | 'bearish'; count: number; lastSignal: number } | null = null;

  // Advanced performance tracking by strategy and bias
  public performanceMetrics: PerformanceMetrics | null = null;
  public strategyPerformance: Map<string, StrategyPerformance> = new Map();
  public quantConfig = getQuantAIConfig();
  public circuitBreaker = this.createCircuitBreaker();
  public entryFilters = new EntryFilters(this.quantConfig.filters);
  public positionSizer = new PositionSizer(this.quantConfig.risk.baseRiskPerTradePct);
  public lastKnownEquityUsd = 0;
  public rrExpectancyConfig: RRExpectancyConfig = resolveRrExpectancyConfig();
  public rrExpectancyState: { lastEffective?: number; lastWinRate?: number } = {};
  public currentRrMin: number | null = null;
  public lastRrSnapshot: {
    effective: number;
    dynamic?: number;
    winRate?: number;
    trades: number;
    mode: 'base' | 'dynamic';
    hysteresisApplied: boolean;
  } | null = null;

  public createCircuitBreaker(initialState?: Partial<CircuitBreakerState> | null): CircuitBreaker {
    return new CircuitBreaker(this.quantConfig.risk, {
      initialState,
      onStateChange: (state) => this.handleCircuitBreakerStateChange(state),
    });
  }

  public handleCircuitBreakerStateChange(state: CircuitBreakerState): Promise<void> | void {
    if (!this.sessionId) return;
    return persistCircuitBreakerState(this.sessionId, state).catch((error) => {
      console.warn(`Failed to persist circuit breaker state for session ${this.sessionId}:`, error);
    });
  }

  async activate(profile: ActivationProfile) {
    // PREFLIGHT
    this.state = 'PREFLIGHT';
    this.quantConfig = reloadQuantAIConfig();
    this.tradeCadenceConfig = null;
    const mode = profile.aggressiveness ?? 'reactive';
    const modeParams = getModeParams(mode);
    this.tradeCadenceConfig = this.buildTradeCadenceConfig(modeParams, mode);
    const baseCadenceStage = this.tradeCadenceConfig.stages[0] ?? {
      maxTrades: modeParams.maxTradesPerDay,
      cooldownMs: Math.max(1_000, modeParams.tradeCooldownMs),
      winRateThreshold: 0,
      minTrades: 0,
      label: 'base',
    };
    this.tradeCadenceState = {
      stageIndex: 0,
      stageLabel: baseCadenceStage.label,
      maxTradesPerDay: baseCadenceStage.maxTrades,
      cooldownMs: baseCadenceStage.cooldownMs,
      lastWinRate: 0,
      sampleSize: 0,
      lastUpdated: Date.now(),
      reason: 'activation',
    };
    const mergedRisk = {
      ...this.quantConfig.risk,
      maxConsecutiveLosses: Math.max(1, modeParams.maxConsecutiveStops),
      dailyLossLimitPct: Math.max(0.5, profile.dailyLossLimitPct ?? modeParams.dailyLossLimitPct),
      baseRiskPerTradePct: profile.riskPerTradePct,
    };
    mergedRisk.dailyTradeLimit = baseCadenceStage.maxTrades;
    if (mergedRisk.reduceSizeAfterLosses) {
      const lossTriggerFloor = Math.max(1, mergedRisk.maxConsecutiveLosses - 1);
      mergedRisk.sizeReductionAfterLosses = Math.max(
        1,
        Math.min(mergedRisk.sizeReductionAfterLosses, lossTriggerFloor),
      );
    }
    if (mergedRisk.winStreakForIncrease != null && mergedRisk.winStreakForIncrease < 1) {
      mergedRisk.winStreakForIncrease = 0;
    }
    if (mergedRisk.sizeIncreaseFactor != null && mergedRisk.sizeIncreaseFactor < 1) {
      mergedRisk.sizeIncreaseFactor = 1;
    }
    if (mergedRisk.sizeIncreaseMaxMultiplier != null && mergedRisk.sizeIncreaseMaxMultiplier < 1) {
      mergedRisk.sizeIncreaseMaxMultiplier = 1;
    }
    this.quantConfig = {
      ...this.quantConfig,
      risk: mergedRisk,
    };
    this.rrExpectancyConfig = resolveRrExpectancyConfig({
      rrFloor: profile.rrFloor,
      rrCeil: profile.rrCeil,
      rrBaseMin: profile.rrBaseMin,
      rrExpectancy: profile.rrExpectancy,
    });
    this.quantConfig = {
      ...this.quantConfig,
      filters: {
        ...this.quantConfig.filters,
        minRr: this.rrExpectancyConfig.rrBaseMin,
      },
    };
    let restoredCircuit: CircuitBreakerState | null = null;
    if (this.sessionId) {
      try {
        restoredCircuit = await loadCircuitBreakerState(this.sessionId);
        if (restoredCircuit) {
          console.log(
            `♻️ Restored circuit breaker state for ${this.sessionId}: ${restoredCircuit.consecutiveLosses} losses, ${restoredCircuit.tradesToday} trades today`,
          );
        }
      } catch (error) {
        console.warn(`Failed to load circuit breaker state for session ${this.sessionId}:`, error);
      }
    }
    this.circuitBreaker = this.createCircuitBreaker(restoredCircuit ?? undefined);
    if (this.sessionId && !restoredCircuit) {
      void this.handleCircuitBreakerStateChange(this.circuitBreaker.getState());
    }
    this.entryFilters = new EntryFilters(this.quantConfig.filters);
    this.positionSizer = new PositionSizer(this.quantConfig.risk.baseRiskPerTradePct);
    this.lastKnownEquityUsd = 0;
    this.rrExpectancyState = {};
    this.currentRrMin = null;
    this.lastRrSnapshot = null;
    this.drySpellState = {
      rejections: 0,
      steps: 0,
      lastStepTs: 0,
      lastTradeTs: Date.now(),
    };
    this.resetFilterRejectionStats(this.drySpellState.lastTradeTs);
    profile.rrFloor = this.rrExpectancyConfig.rrFloor;
    profile.rrCeil = this.rrExpectancyConfig.rrCeil;
    profile.rrBaseMin = this.rrExpectancyConfig.rrBaseMin;
    profile.rrExpectancy = {
      enabled: this.rrExpectancyConfig.enabled,
      minTrades: this.rrExpectancyConfig.minTrades,
      lookbackDays: this.rrExpectancyConfig.lookbackDays,
      decay: this.rrExpectancyConfig.decay,
      safetyMult: this.rrExpectancyConfig.safetyMult,
      blend: this.rrExpectancyConfig.blend,
      hysteresis: this.rrExpectancyConfig.hysteresis,
    };
    this.ensurePerformanceMetricsSkeleton(profile);
    this.syncCircuitBreakerTelemetry();
    this.evaluateTradeCadence('activation');
    const existingCap = profile.leverageCap as ResolvedLeverageCap | undefined;
    const existingCategory = existingCap?.category ?? '';
    const requestedMaxLev = Math.max(1, Math.min(10, Number(profile.requestedMaxLeverage ?? profile.maxLeverage ?? existingCap?.requested ?? 1)));
    const resolvedMaxLev = Math.max(1, Math.min(10, Number(existingCap?.resolved ?? profile.maxLeverage ?? requestedMaxLev)));
    const leverageCapMeta: ResolvedLeverageCap = existingCap
      ? {
          ...existingCap,
          requested: requestedMaxLev,
          resolved: resolvedMaxLev,
          trimmed: resolvedMaxLev + 1e-9 < requestedMaxLev,
        }
      : {
          symbol: profile.symbol,
          category: existingCategory,
          requested: requestedMaxLev,
          resolved: resolvedMaxLev,
          modeCap: resolvedMaxLev,
          categoryCap: resolvedMaxLev,
          constraintCap: null,
          constraintTarget: null,
          constraintSource: 'fallback',
          trimmed: resolvedMaxLev + 1e-9 < requestedMaxLev,
        };
    profile.maxLeverage = resolvedMaxLev;
    profile.requestedMaxLeverage = requestedMaxLev;
    profile.leverageCap = leverageCapMeta;
    if (profile.minLeverage != null) {
      profile.minLeverage = Math.max(1, Math.min(resolvedMaxLev, profile.minLeverage));
    }
    this.profile = profile;
    this.haltAckRequired = false;
    if (this.recoveryTimer) { try { clearTimeout(this.recoveryTimer); } catch {} this.recoveryTimer = null; }
    if (this.cooldownTimer) { try { clearTimeout(this.cooldownTimer); } catch {} this.cooldownTimer = null; }
    this.cooldownContext = null;
    this.orderAttemptLogCount = 0;
    if (profile.maxLeverage > 10) throw new Error('maxLeverage>10 not allowed');
    if (profile.riskPerTradePct < 0.5 || profile.riskPerTradePct > 5) throw new Error('risk/trade must be 0.5-5%');
    if (profile.dailyLossLimitPct < 3 || profile.dailyLossLimitPct > 4) throw new Error('daily loss must be 3-4%');

    // init broker (paper only for now)
    this.broker = profile.mode === 'live'
      ? new LiveBroker(profile.userId || '')
      : new PaperBroker(profile.startBalanceUsd);

    const budgetFractionRaw = typeof profile.budgetFraction === 'number'
      ? profile.budgetFraction
      : (typeof (profile as any).budgetPct === 'number'
        ? ((profile as any).budgetPct > 1 ? (profile as any).budgetPct / 100 : (profile as any).budgetPct)
        : 1);
    const safeBudgetFraction = resolveBudgetFraction(budgetFractionRaw);
    const leverageCap = Math.max(1, Math.min(10, profile.maxLeverage || resolvedMaxLev || 1));
    const baselineBalance = typeof profile.startBalanceUsd === 'number' && profile.startBalanceUsd > 0
      ? profile.startBalanceUsd
      : undefined;
    this.maxNotionalCapUsd = baselineBalance != null
      ? Math.max(0, baselineBalance * leverageCap * safeBudgetFraction)
      : Infinity;

    this.state = 'SCAN';
    this.logMovement('Agent activated', `Mode=${profile.mode}, symbol=${profile.symbol}`, {
      tags: ['agent', 'activation'],
      context: { profile },
      severity: 'low',
    }).catch(()=>{});
    
    // Initialize adaptive ATR cache for this symbol
    if (profile.symbol) {
      this.updateAdaptiveATRCache(profile.symbol, 1.0).catch(err =>
        console.warn('Initial ATR cache update failed:', err)
      );
    }
  }

  updateRrExpectancySettings(settings: Partial<Pick<ActivationProfile, 'rrFloor' | 'rrCeil' | 'rrBaseMin' | 'rrExpectancy'>>): void {
    if (!this.profile) return;
    if (settings.rrFloor != null) this.profile.rrFloor = settings.rrFloor;
    if (settings.rrCeil != null) this.profile.rrCeil = settings.rrCeil;
    if (settings.rrBaseMin != null) this.profile.rrBaseMin = settings.rrBaseMin;
    if (settings.rrExpectancy) {
      this.profile.rrExpectancy = {
        ...(this.profile.rrExpectancy ?? {}),
        ...settings.rrExpectancy,
      };
    }
    this.rrExpectancyConfig = resolveRrExpectancyConfig({
      rrFloor: this.profile.rrFloor,
      rrCeil: this.profile.rrCeil,
      rrBaseMin: this.profile.rrBaseMin,
      rrExpectancy: this.profile.rrExpectancy,
    });
    this.quantConfig = {
      ...this.quantConfig,
      filters: { ...this.quantConfig.filters, minRr: this.rrExpectancyConfig.rrBaseMin },
    };
    this.entryFilters = new EntryFilters(this.quantConfig.filters);
    this.rrExpectancyState = {};
    this.currentRrMin = null;
    this.lastRrSnapshot = null;
  }

  async propose(plan: PlanJson) {
    if (this.state !== 'SCAN' && this.state !== 'PROPOSE') return;
    this.state = 'PROPOSE';
    this.plan = await validatePlan(plan);
    this.aiBiasOverride = null;
    this.regime = this.plan.regime ?? null;
    this.state = 'VALIDATE';
  }

  async validateAndArm() {
    if (!this.profile || !this.plan) throw new Error('no plan');
    await this.restorePersistedPosition();
    this.regime = this.plan.regime ?? null;
    if (this.regime && this.regime.playbook === 'standby') {
      this.state = 'COOLDOWN';
      broadcast('agent_state', { state: this.state, plan: this.plan, reason: 'regime_standby' }, this.profile.symbol, this.sessionId || undefined);
      recordOpsEvent({ level: 'info', source: 'regime', message: 'Standby regime detected - pausing entries', sessionId: this.sessionId || undefined, symbol: this.profile.symbol, details: this.regime });
      return;
    }
    // If a position already exists, don't re-arm — keep managing
    if (this.pos) {
      this.state = 'MANAGE';
      broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
      await this.syncProtectiveOrders('startup');
      return;
    }
    // Bypass risk / spread / leverage gating per user request
    this.state = 'ARMED';
    const aiCalls = await getAICallsCount(this.sessionId || undefined);
    broadcast('agent_state', { state: this.state, plan: this.plan, regime: this.regime, aiCalls }, this.profile.symbol, this.sessionId || undefined);

    // Live exposure inspection: if in live mode and a position already exists, adopt it and switch to MANAGE
    if (this.profile.mode === 'live' && !this.pos) {
      try {
        const expo = await inspectExposure(this.profile.symbol, this.profile.userId);
        if (expo && expo.qty > 0) {
          const side = expo.side;
          const entry = expo.entry || (await buildTechSnapshot(this.profile.symbol)).last;
          const stop = side === 'buy' ? (entry - this.plan.stopDistance) : (entry + this.plan.stopDistance);
          // Rebase TP ladder from entry using R multiples
          const dir = side === 'buy' ? 1 : -1;
          const tp = (this.plan.rPrices || []).map(x => entry + dir * x.r * this.plan!.stopDistance);
          const now = Date.now();
          const planAny = this.plan as any;
          const leverageRaw = (expo as { leverage?: number } | null)?.leverage;
          const openLeverage = typeof leverageRaw === 'number' && Number.isFinite(leverageRaw)
            ? leverageRaw
            : this.profile.maxLeverage;

          this.pos = {
            side,
            entry,
            qty: expo.qty,
            stop,
            tp,
            openedAt: now,
            extended: false,
            partialTaken: false,
            slOrderId: undefined,
            tpOrderId: undefined,
            trail: [{ ts: now, price: stop }],
            breakeven: entry,
            partialInfo: null,
            initialStopDistance: Math.max(1e-12, Math.abs(entry - stop)),
            archetype: (this.plan?.plan?.meta?.playbook || this.regime?.playbook) === 'momentum_breakout' ? 'impulse' : 'reversal',
            tp1Fraction: planAny._tp1Fraction ?? 0.3,
            flowSnapshot: planAny._flowSnapshot ?? null,
            initialQty: expo.qty,
            initialNotional: expo.qty * entry,
            addOnFilledQty: 0,
            scaleInTriggered: false,
            trailConfig: {
              mode: 'atr',
              multiplier: this.quantConfig.exits.trailAtrMult,
              armed: false,
              highWatermark: entry,
              lastUpdateTs: now,
            },
            openLeverage,
          } as any;
          this.state = 'MANAGE';
          broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined);
          await this.syncProtectiveOrders('adopt');
        }
      } catch {}
    }
  }

  // On new candles/ticks, check trigger and possibly enter
  async onTick() {
    if (!this.profile || !this.plan) return;
    if (this.state !== 'ARMED' && this.state !== 'MANAGE') return;
    const snap = await buildTechSnapshot(this.profile.symbol);
    if (snap.regime) this.regime = snap.regime;
    if (this.regime && !this.regime.shouldTrade) {
      if (this.state === 'ARMED') {
        this.state = 'COOLDOWN';
        broadcast('agent_state', { state: this.state, plan: this.plan, reason: 'regime_standby' }, this.profile.symbol, this.sessionId || undefined);
      }
      return;
    }
    const price = snap.last;
    const { from, to, mid } = this.plan.zone;
    const { playbook, context } = this.getContextualPlaybook(snap, this.plan.bias ?? 'none');
    const normalizedPlaybook = String(playbook);
    if (context && context.basePlaybook !== context.effectivePlaybook) {
      console.log(
        `🧭 Context shift: ${context.basePlaybook} → ${context.effectivePlaybook} | regime=${context.regime}` +
        ` notes=${context.notes.join(',')}`
      );
    }

    if (this.state === 'ARMED') {
      // 🔥 PHASE 1 FIX #3: Check for gaps at cycle start
      if (this.plan.bias !== 'none') {
        const gapCheck = this.handleGapDetection(snap, price, this.plan.zone, this.plan.bias);
        if (gapCheck.action === 'invalidate') {
          console.warn(`🔥 ${gapCheck.reason} - Invalidating plan`);
          this.clearAiBiasOverride('gap_invalidated');
          this.state = 'SCAN';
          broadcast('agent_state', { state: this.state, reason: gapCheck.reason }, this.profile.symbol, this.sessionId || undefined);
          return;
        } else if (gapCheck.action === 'enter') {
          console.log(`🔥 ${gapCheck.reason}`);
          await this.enter(price, snap);
          return;
        }
      }

      // 🔥 PHASE 1 FIX #2: Check zone expiration
      const expirationCheck = this.isZoneExpired(this.plan.zone, price);
      if (expirationCheck.expired) {
        console.log(`🔥 ${expirationCheck.reason} - Recalculating zone`);
        const newZone = await this.calculateDynamicEntryZone(snap, price, this.plan.bias);
        this.plan.zone = newZone;
        this.lastZoneCalculation = Date.now();
        this.zoneCalculatedForBias = this.plan.bias; // Track bias for mismatch detection
        this.clearAiBiasOverride('zone_recalculated');
        console.log(`🔥 New zone: [${newZone.from.toFixed(4)}, ${newZone.to.toFixed(4)}] mid: ${newZone.mid.toFixed(4)}`);
      }

      // 🔥 PHASE 1 FIX #4: Check bias mismatch
      if (this.zoneCalculatedForBias !== 'none' && this.zoneCalculatedForBias !== this.plan.bias) {
        console.warn(`🔥 Bias mismatch: zone calculated for ${this.zoneCalculatedForBias}, current bias ${this.plan.bias} - Recalculating`);
        const newZone = await this.calculateDynamicEntryZone(snap, price, this.plan.bias);
        this.plan.zone = newZone;
        this.lastZoneCalculation = Date.now();
        this.zoneCalculatedForBias = this.plan.bias;
        this.clearAiBiasOverride('zone_bias_mismatch');
        console.log(`🔥 Bias-corrected zone: [${newZone.from.toFixed(4)}, ${newZone.to.toFixed(4)}]`);
      }

      // 🟡 PHASE 2 FIX #2: Check pullback timeout (6h without touching zone)
      if (this.plan.bias !== 'none') {
        const timeoutCheck = this.shouldRecalculateProgressiveZone(this.plan.zone, price);
        if (timeoutCheck.shouldRecalc) {
          console.log(`🟡 ${timeoutCheck.reason}`);
          const newZone = await this.calculateDynamicEntryZone(snap, price, this.plan.bias);
          this.plan.zone = newZone;
          this.lastZoneCalculation = Date.now();
          this.clearAiBiasOverride('zone_timeout_refresh');
          console.log(`🟡 Progressive zone: [${newZone.from.toFixed(4)}, ${newZone.to.toFixed(4)}]`);
        }
      }

      // 🆕 Recalculate entry zone periodically (every 30 min) to check breakout conditions
      await this.maybeRecalculateEntryZone().catch(err => console.warn('Zone recalc failed:', err));
      
      // ✅ Safety: MANAGE state only if position truly exists and valid
      if (this.pos && this.pos.qty > 0) { 
        this.state = 'MANAGE'; 
        broadcast('agent_state', { state: this.state, pos: this.pos }, this.profile.symbol, this.sessionId || undefined); 
        return; 
      } else if (this.pos) {
        // ✅ Position object exists but qty invalid
        console.warn(`⚠️  Invalid position qty (${this.pos.qty}) for ${this.profile.symbol}, clearing`);
        this.pos = null;
        this.trendReversalContext = null;
        this.state = 'SCAN';
      }
      if (this.plan.bias === 'none') return;
      this.applyActiveAIBiasOverride(price, snap);
      // PHASE 3 FIX #1: Use epsilon tolerance for zone check
      const inZone = this.priceInZoneWithEpsilon(price, this.plan.zone);

      // 🧠 AI Prediction for short-term moves (optimisé)
      let aiPrediction: any = null;
      const baselinePlanBias = this.aiBiasOverride?.originalBias ?? this.plan.bias;

      // Conditions pour appeler l'IA (optimisation coût)
      const shouldCallAI = this.shouldCallAIPrediction(snap, price);
      
      if (shouldCallAI) {
        try {
          aiPrediction = await predictor.predictMove(this.profile.symbol, price, snap);

          // Mettre à jour le suivi des prédictions IA
          (this as any).lastAIPredictionTime = Date.now();
          (this as any).lastAIPredictionPrice = price;

          if (aiPrediction && aiPrediction.confidence >= 0.75 && aiPrediction.direction !== 'neutral') {
            console.log(`🧠 AI Prediction: ${aiPrediction.direction} (${(aiPrediction.confidence * 100).toFixed(1)}% confidence) - ${aiPrediction.reasoning}`);
            const overrideBias = aiPrediction.direction === 'up' ? 'long' : 'short';
            const now = Date.now();
            const ttl = this.resolveAiBiasOverrideTtlMs();
            const existingOverride = this.aiBiasOverride;
            const originalBias = existingOverride?.originalBias ?? baselinePlanBias;

            if (!existingOverride || existingOverride.bias !== overrideBias) {
              this.aiBiasOverride = {
                bias: overrideBias,
                originalBias,
                confidence: aiPrediction.confidence,
                appliedAt: now,
                expiresAt: now + ttl,
              };
              console.log(`🧠 AI overriding to ${overrideBias.toUpperCase()} bias for ${(ttl / 60000).toFixed(1)}m window`);
            } else {
              existingOverride.confidence = Math.max(existingOverride.confidence, aiPrediction.confidence);
              existingOverride.appliedAt = now;
              existingOverride.expiresAt = now + ttl;
              this.aiBiasOverride = existingOverride;
              console.log(`🧠 AI reaffirming ${overrideBias.toUpperCase()} bias (conf ${(existingOverride.confidence * 100).toFixed(1)}%)`);
            }
            this.plan.bias = overrideBias;
          } else if (aiPrediction && aiPrediction.direction !== 'neutral' && this.aiBiasOverride) {
            const suggestedBias = aiPrediction.direction === 'up' ? 'long' : 'short';
            const now = Date.now();
            const needsFlip = suggestedBias !== this.aiBiasOverride.bias
              && aiPrediction.confidence >= Math.max(0.7, this.aiBiasOverride.confidence - 0.05);
            if (needsFlip) {
              if (suggestedBias === this.aiBiasOverride.originalBias) {
                this.clearAiBiasOverride('ai_confirms_original_bias');
                this.plan.bias = suggestedBias;
              } else {
                const ttl = this.resolveAiBiasOverrideTtlMs();
                this.aiBiasOverride = {
                  bias: suggestedBias,
                  originalBias: this.aiBiasOverride.originalBias ?? baselinePlanBias,
                  confidence: aiPrediction.confidence,
                  appliedAt: now,
                  expiresAt: now + ttl,
                };
                this.plan.bias = suggestedBias;
                console.log(`🧠 AI flipping override to ${suggestedBias.toUpperCase()} bias (conf ${(aiPrediction.confidence * 100).toFixed(1)}%)`);
              }
            }
          } else if (aiPrediction && aiPrediction.direction === 'neutral' && this.aiBiasOverride && aiPrediction.confidence >= 0.7) {
            this.clearAiBiasOverride('ai_neutral_signal');
          }
        } catch (error) {
          console.warn('AI prediction failed:', error);
        }
      }

      // Entry filters: basic RSI/ADX gates to avoid weak/contrarian entries (aggressiveness-adjusted)
      const cfg = this.effectiveEntryThresholds();
      if (this.plan.bias === 'short') {
        if ((snap as any).adx14 != null && (snap as any).adx14 < cfg.ENTRY_SHORT_MIN_ADX) return;
        if ((snap as any).rsi14 != null && (snap as any).rsi14 < cfg.ENTRY_SHORT_MIN_RSI) return;
      } else if (this.plan.bias === 'long') {
        if ((snap as any).adx14 != null && (snap as any).adx14 < cfg.ENTRY_LONG_MIN_ADX) return;
        if ((snap as any).rsi14 != null && (snap as any).rsi14 > cfg.ENTRY_LONG_MAX_RSI) return;
      }
      if (playbook === 'momentum_breakout') {
        const upper = Math.max(from, to);
        const lower = Math.min(from, to);
        const breakoutLong = this.plan.bias === 'long' && price > upper;
        const breakoutShort = this.plan.bias === 'short' && price < lower;
        if (breakoutLong || breakoutShort) await this.enter(price, snap);
      } else {
    // Enhanced confirmation logic for better win rate with market regime detection
        const confirmRequired = this.plan.plan.entry_rule.confirm_close;
        const marketRegime = this.detectMarketRegime(snap);
        
        // Adapt confirmation requirements based on market regime
        let confirmationNeeded = confirmRequired;
        if (marketRegime === 'trending_strong') {
          // In strong trends, allow faster entries
          confirmationNeeded = false;
        } else if (marketRegime === 'choppy' || marketRegime === 'ranging') {
          // In choppy markets, require strict confirmation
          confirmationNeeded = true;
        }
        
        if (confirmationNeeded) {
          const confirm = (this.plan.bias === 'long' && price > mid) || (this.plan.bias === 'short' && price < mid);
          if (!confirm) return; // No entry without confirmation
        }
        
        // Additional quality check: price should be near zone edge for better R:R
        const zoneWidth = Math.abs(to - from);
        const distanceFromEntry = this.plan.bias === 'long' ? 
          (price - Math.min(from, to)) / zoneWidth : 
          (Math.max(from, to) - price) / zoneWidth;
          
        // Entry positioning based on market regime
        let maxDistanceAllowed = 0.4;
        if (marketRegime === 'trending_strong') {
          maxDistanceAllowed = 0.6; // Allow deeper entries in strong trends
        } else if (marketRegime === 'volatile') {
          maxDistanceAllowed = 0.3; // Require better entries in volatile markets
        }
          
        // Enhanced entry logic: support both mean reversion AND breakout entries
        const shouldEnterMeanReversion = inZone && distanceFromEntry <= maxDistanceAllowed;
        
        // Allow breakout entries slightly above/below zone for better opportunity capture
        const zoneMax = Math.max(from, to);
        const zoneMin = Math.min(from, to);
        const breakoutThreshold = 0.02; // 2% maximum distance from zone edge
        
        const shouldEnterBreakout = (
          (this.plan.bias === 'long' && price > zoneMax && 
           (price - zoneMax) / price < breakoutThreshold) ||
          (this.plan.bias === 'short' && price < zoneMin && 
           (zoneMin - price) / price < breakoutThreshold)
        );
        
        if (shouldEnterMeanReversion || shouldEnterBreakout) {
          await this.enter(price, snap);
        }
      }
    } else if (this.state === 'MANAGE') {
      await this.manage(price, snap);
    }
  }

  async enter(mktPrice: number, _snap?: TechnicalSnapshot) {
    if (!this.broker || !this.plan || !this.profile) return;
    if (this.regime && !this.regime.shouldTrade) {
      this.noteSignalDrop('regime_guard_blocked', 'info', { regime: (this.regime as any)?.label || 'regime_disallows_trade' });
      return;
    }
    if (this.pos || this.entering) return;

    let marginSnapshot: BrokerMarginSnapshot | null = null;
    if (this.isEntriesOnlyHaltActive()) {
      try {
        marginSnapshot = await this.broker.balance();
        this.maybeReleaseMarginHalt(marginSnapshot);
      } catch (error) {
        console.warn('Failed to refresh margin snapshot while halt active:', error);
      }
      if (this.isEntriesOnlyHaltActive()) {
        this.noteSignalDrop('margin_halt_entries_only', 'warn', {
          reason: 'entries_only_halt_active',
        });
        return;
      }
    }

    this.resetQualityPreview();

    // � PHASE 1 FIX #1: Whipsaw protection - 3-stage confirmation
    // Get snap for validations
    let snapForValidation = _snap;
    if (!snapForValidation) {
      const { buildTechSnapshot } = await import('../../ai/tech.js');
      snapForValidation = await buildTechSnapshot(this.profile.symbol, this.profile.userId);
    }

    // PHASE 2 FIX #6: Liquidity validation
    // Use realistic position size based on actual balance, not plan's placeholder 10k
    if (this.plan && this.plan.sizing) {
      const bal = await this.broker.balance();
      const budgetFrac = resolveBudgetFraction(this.profile.budgetFraction);
      const startBudget = (this.profile.startBalanceUsd && this.profile.startBalanceUsd > 0)
        ? this.profile.startBalanceUsd
        : bal.freeUsd;
      const usableBalance = Math.max(0, startBudget * budgetFrac);
      
      // Estimate realistic position size: balance × riskPct × leverage / stopPct
      const riskPct = this.profile.riskPerTradePct || 1.5;
      const leverage = Math.min(10, this.profile.maxLeverage || 10);
      const stopPct = 0.5; // Conservative estimate
      const estimatedNotional = (usableBalance * (riskPct / 100) * leverage) / (stopPct / 100);
      
      const liquidityCheck = this.hasAdequateLiquidity(snapForValidation, estimatedNotional);
      if (!liquidityCheck.adequate) {
        console.warn(`PHASE 2: ${liquidityCheck.reason} - Skipping entry to avoid slippage`);
        this.noteSignalDrop('liquidity_guard_blocked', 'info', {
          reason: liquidityCheck.reason,
          estimatedNotional,
        });
        return;
      }
    }

    const planBias = this.plan.bias;
    const { playbook, context } = this.getContextualPlaybook(snapForValidation, planBias ?? 'none');
    if (context && context.basePlaybook !== context.effectivePlaybook) {
      recordOpsEvent({
        level: 'watch',
        source: 'entry_context',
        message: 'playbook_adjusted',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          base: context.basePlaybook,
          effective: context.effectivePlaybook,
          regime: context.regime,
          direction: context.direction,
          confidence: context.confidence,
        },
      });
    }
    const validationSnap = snapForValidation!;
    const { zone: adaptiveZone, meta: entryZoneMeta } = this.computeVolatilityAdjustedZone(validationSnap, {
      planZone: this.plan.zone,
      bias: planBias,
      playbook,
      price: validationSnap.last,
    });
    const zoneMinValidation = Math.min(adaptiveZone.from, adaptiveZone.to);
    const zoneMaxValidation = Math.max(adaptiveZone.from, adaptiveZone.to);
    const inZoneValidation = validationSnap.last >= zoneMinValidation - entryZoneMeta.hysteresis &&
      validationSnap.last <= zoneMaxValidation + entryZoneMeta.hysteresis;
    const overHighValidation = planBias === 'long' && validationSnap.last > zoneMaxValidation
      ? (validationSnap.last - zoneMaxValidation) / validationSnap.last
      : 0;
    const underLowValidation = planBias === 'short' && validationSnap.last < zoneMinValidation
      ? (zoneMinValidation - validationSnap.last) / validationSnap.last
      : 0;
    const atrPctFractionValidation = entryZoneMeta.atrPct > 0 ? entryZoneMeta.atrPct / 100 : 0;
    let breakoutToleranceValidation = 0.25 * atrPctFractionValidation;
    if (atrPctFractionValidation > 0) {
      const breakoutMinValidation = atrPctFractionValidation * 0.2;
      const breakoutMaxValidation = atrPctFractionValidation * 0.3;
      breakoutToleranceValidation = Math.max(
        breakoutMinValidation,
        Math.min(breakoutToleranceValidation, breakoutMaxValidation),
      );
    }
    const momentumGateValidation = this.lastMomentumGateResult ?? this.evaluateMomentumGates(validationSnap, 'enter', false);
    const breakoutActiveValidation = playbook === 'momentum_breakout'
      && momentumGateValidation.status !== 'FAIL'
      && ((planBias === 'long' && overHighValidation > 0 && overHighValidation <= breakoutToleranceValidation)
        || (planBias === 'short' && underLowValidation > 0 && underLowValidation <= breakoutToleranceValidation));
    const breakoutDistanceValidation = planBias === 'long'
      ? overHighValidation
      : planBias === 'short'
        ? underLowValidation
        : 0;
    this.plan.zone = adaptiveZone;
    this.runtimeEntryZone = adaptiveZone;
    this.runtimeZoneDiagnostics = {
      anchor: entryZoneMeta.anchor,
      k: entryZoneMeta.k,
      atr: entryZoneMeta.atr,
      atrPct: entryZoneMeta.atrPct,
      atrPctBase: entryZoneMeta.atrPctBase,
      hysteresis: entryZoneMeta.hysteresis,
      breakoutDistancePct: breakoutDistanceValidation,
      breakoutActive: breakoutActiveValidation,
      breakoutDirection: breakoutActiveValidation
        ? planBias === 'long' ? 'above' : 'below'
        : 'none',
    };
    const usingBreakoutEntry = breakoutActiveValidation && !inZoneValidation;

    if (this.plan.bias !== 'none' && !this.gapEntryOverride) {
      if (usingBreakoutEntry) {
        console.log('Breakout entry: skipping pullback confirmation due to momentum strength');
      } else {
        const confirmation = this.confirmEntrySignal(validationSnap, mktPrice, adaptiveZone, this.plan.bias);
        if (!confirmation.confirmed) {
          if (confirmation.shouldLog !== false) {
            console.log(`Entry not confirmed: ${confirmation.reason}`);
          }
          this.noteSignalDrop('bias_confirmation_failed', 'info', { reason: confirmation.reason });
          return; // Skip entry until all confirmations pass
        }
        console.log(`Entry confirmed: ${confirmation.reason}`);
        const holdMs = this.getAdaptiveConfirmationTime(validationSnap, { playbook, bias: this.plan.bias ?? 'none' });
        const elapsedMs = this.priceInZoneStartTime > 0 ? Date.now() - this.priceInZoneStartTime : holdMs;
        const reasonLower = confirmation.reason.toLowerCase();
        const confirmationMode = reasonLower.includes('timeout')
          ? 'timeout'
          : reasonLower.includes('fast track')
            ? 'fast_track'
            : reasonLower.includes('momentum')
              ? 'momentum'
              : null;
        const timeMode = reasonLower.includes('momentum fast-track') ? 'momentum' : 'standard';
        const normalizedMode = confirmationMode ?? 'adaptive';
        this.lastConfirmationSnapshot = {
          reason: confirmation.reason,
          timestamp: Date.now(),
          meta: {
            timeThresholdMs: holdMs,
            timeInZoneMs: elapsedMs,
            mode: timeMode as 'standard' | 'momentum',
            confirmationMode: normalizedMode as 'adaptive' | 'fast_track' | 'timeout' | 'momentum',
          },
        };
      }
    }
    
    // Reset gap override after use
    this.gapEntryOverride = false;
    
    // �🚨 COOLDOWN CHECK: Prevent entries too soon after last exit
    const envMod = await import('../../utils/env.js');
    const envCfg = envMod.getConfig();
    const modeParams = envMod.getModeParams(this.profile.aggressiveness || 'reactive');
    const cadenceSnapshot = this.evaluateTradeCadence('readiness');
    const baseCooldownMs = cadenceSnapshot.cooldownMs || modeParams?.tradeCooldownMs || envCfg.TRADE_COOLDOWN_MS;
    const cooldownMs = this.lastExitCooldownMs > 0 ? this.lastExitCooldownMs : baseCooldownMs;
    const timeSinceLastExit = Date.now() - this.lastExitTime;

    if (this.lastExitTime > 0 && timeSinceLastExit < cooldownMs) {
      const cooldownRemaining = (cooldownMs - timeSinceLastExit) / 1000;
      console.log(`⏳ Trade cooldown: ${cooldownRemaining.toFixed(0)}s remaining - skipping entry`);
      this.noteSignalDrop('cooldown_active', 'info', { cooldownRemainingSec: Number(cooldownRemaining.toFixed(0)) });
      return;
    }
    this.lastExitCooldownMs = 0;
    
    this.entering = true;
    let snap = _snap;
    if (!snap) {
      try {
        snap = await buildTechSnapshot(this.profile.symbol, this.profile.userId);
      } catch (err) {
        recordOpsEvent({
          level: 'warn',
          source: 'entry_gate',
          message: 'snapshot_failed',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: { error: String((err as any)?.message || err) },
        });
        this.entering = false;
        return;
      }
    }
    if (snap) {
      const zoneLowNow = Math.min(adaptiveZone.from, adaptiveZone.to);
      const zoneHighNow = Math.max(adaptiveZone.from, adaptiveZone.to);
      const priceNow = snap.last;
      const breakoutDistanceNow = planBias === 'long' && priceNow > zoneHighNow
        ? (priceNow - zoneHighNow) / priceNow
        : planBias === 'short' && priceNow < zoneLowNow
          ? (zoneLowNow - priceNow) / priceNow
          : 0;
      if (this.runtimeZoneDiagnostics) {
        this.runtimeZoneDiagnostics = {
          ...this.runtimeZoneDiagnostics,
          breakoutDistancePct: breakoutDistanceNow,
          breakoutActive: usingBreakoutEntry || breakoutDistanceNow > 0,
          breakoutDirection: (usingBreakoutEntry || breakoutDistanceNow > 0)
            ? planBias === 'long'
              ? 'above'
              : planBias === 'short'
                ? 'below'
                : 'none'
            : this.runtimeZoneDiagnostics.breakoutDirection,
        };
      }
    }
    // Enhanced quality filters for 60%+ win rate
    // Use quality score system instead of binary pass/fail per filter
    if (!snap) {
      this.noteSignalDrop('snapshot_unavailable', 'warn');
      this.entering = false;
      return;
    }
    const rrSnapshot = await this.computeEffectiveRrThreshold();
    if (!this.passesEntryMomentumGates(snap, 'enter')) {
      this.noteSignalDrop('momentum_gate_blocked', 'info');
      this.entering = false;
      return;
    }
    if (!this.passesAntiWhaleFilters(snap)) {
      this.noteSignalDrop('anti_whale_filter_blocked', 'info');
      this.entering = false;
      return;
    }
    
    // Check quality score (allows trading with 2-3 filters passing instead of requiring all 5)
    const qualityFilters = this.getQualityFiltersDiagnostics(snap);
    const mode = this.profile?.aggressiveness || 'reactive';
    const normalizedPlaybook = String(playbook);
    const tierForQuality = this.profile ? this.getTierForSymbol(this.profile.symbol) : null;
    const qualityProfile = this.getQualityScoreProfile(normalizedPlaybook, mode);
    const quantArchetype: ExitArchetype = playbook === 'momentum_breakout' ? 'impulse' : 'reversal';
    const minTradingPoints = this.computeQualityScoreThreshold(normalizedPlaybook, mode, tierForQuality);
    const qualityAssessment = this.assessQualityScore(qualityFilters, minTradingPoints, {
      weights: qualityProfile.weights,
      majorityRatio: qualityProfile.majorityRatio,
      partialCredit: qualityProfile.partialCredit,
      minPassCount: qualityProfile.minPassCount,
      comboTolerance: qualityProfile.comboTolerance,
    });

    let rrEffectiveForFilters = rrSnapshot.effective;

    if (!qualityAssessment.allow) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'quality_score_insufficient',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          totalPoints: qualityAssessment.totalPoints,
          effectivePoints: qualityAssessment.effectivePoints,
          required: minTradingPoints,
          bonus: qualityAssessment.bonus,
          passCount: qualityAssessment.passCount,
          failCount: qualityAssessment.failCount,
          failingKeys: qualityAssessment.failingKeys,
          mode,
          filters: qualityFilters,
        },
      });
      this.entering = false;
      return;
    }

    if (qualityAssessment.compensated) {
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'quality_score_compensated',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          totalPoints: qualityAssessment.totalPoints,
          effectivePoints: qualityAssessment.effectivePoints,
          bonus: qualityAssessment.bonus,
          required: minTradingPoints,
          failingKeys: qualityAssessment.failingKeys,
          mode,
        },
      });
    }
    let bal = marginSnapshot ?? await this.broker.balance();
    marginSnapshot = bal;
    let marginAdvisor = createMarginAdvisor(bal);
    const utilNowSnapshot = marginAdvisor.utilisationPct();
    const hasCommittedExposure = (bal?.committedUsd ?? 0) > 1
      || (Array.isArray(bal?.positions) && bal.positions.some(pos => Math.abs(pos?.notionalUsd ?? 0) > 1));
    const snapshotAgeMs = bal?.timestamp != null ? Math.max(0, Date.now() - bal.timestamp) : null;
    const snapshotIsStale = snapshotAgeMs != null && snapshotAgeMs > 5_000;
    if (snapshotIsStale || !Number.isFinite(utilNowSnapshot) || (utilNowSnapshot <= 0 && hasCommittedExposure)) {
      try {
        const fresh = await this.broker.balance();
        if (fresh && (!bal?.timestamp || (fresh.timestamp ?? 0) >= (bal.timestamp ?? 0))) {
          const previousSnapshot = bal;
          bal = fresh;
          marginSnapshot = fresh;
          marginAdvisor = createMarginAdvisor(fresh);
          recordOpsEvent({
            level: 'info',
            source: 'margin_guard',
            message: 'margin_snapshot_refreshed',
            sessionId: this.sessionId || undefined,
            symbol: this.profile?.symbol,
            details: {
              previousTimestamp: previousSnapshot?.timestamp ?? null,
              snapshotAgeMs,
              refreshedAt: fresh.timestamp ?? Date.now(),
              previousUtilisation: utilNowSnapshot,
              hadCommittedExposure: hasCommittedExposure,
            },
          });
        }
      } catch (error) {
        recordOpsEvent({
          level: 'warn',
          source: 'margin_guard',
          message: 'margin_snapshot_refresh_failed',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: {
            snapshotAgeMs,
            error: error instanceof Error ? error.message : String(error),
            previousUtilisation: utilNowSnapshot,
            hadCommittedExposure: hasCommittedExposure,
          },
        });
      }
    }
    this.maybeReleaseMarginHalt(bal);
    const equityCandidate = Number.isFinite(bal?.equityUsd) ? Number(bal.equityUsd) : Number(bal?.freeUsd ?? this.profile.startBalanceUsd ?? 0);
    this.lastKnownEquityUsd = Number.isFinite(equityCandidate) && equityCandidate > 0 ? equityCandidate : Math.max(0, Number(this.profile.startBalanceUsd ?? 0));
    const nowDate = new Date();
    const circuitDecision = this.circuitBreaker.canOpenTrade(nowDate, this.lastKnownEquityUsd);
    this.syncCircuitBreakerTelemetry(circuitDecision);
    if (!circuitDecision.allowed) {
      const state = this.circuitBreaker.getState();
      recordOpsEvent({
        level: 'warn',
        source: 'circuit_breaker',
        message: 'entry_blocked_circuit_breaker',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          reason: circuitDecision.reason,
          cooldownUntil: circuitDecision.cooldownUntil?.toISOString() ?? null,
          consecutiveLosses: state.consecutiveLosses,
          tradesToday: state.tradesToday,
        },
      });
      this.noteSignalDrop('circuit_breaker_blocked', 'warn', {
        reason: circuitDecision.reason,
        cooldownUntil: circuitDecision.cooldownUntil?.toISOString(),
      });
      this.entering = false;
      return;
    }
    let marketTicker = await getTicker(this.profile.symbol).catch(() => null as any);
    let spreadBps = marketTicker?.bid && marketTicker?.ask
      ? ((marketTicker.ask - marketTicker.bid) / ((marketTicker.ask + marketTicker.bid) / 2)) * 10_000
      : undefined;
    const side = this.plan.bias === 'long' ? 'buy' : 'sell';
    const entry = mktPrice;
    const round4 = (n:number)=> Math.round(n*1e4)/1e4;
    const roundR = (n:number)=> Math.round(n*100)/100;
    const regimeRisk = this.regime?.riskModifier;
    const planAny = this.plan as any;
    const volumeNow = Number((snap as any)?.volume ?? 0);
    const volumeMANow = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? 0);
    const volumeRatio = volumeMANow > 0 ? volumeNow / volumeMANow : undefined;
    const adxValue = Number((snap as any)?.adx14 ?? validationSnap.adx14 ?? 0);
    const emaValue = Number((snap as any)?.ema20 ?? validationSnap.ema20 ?? mktPrice);
    const emaSlope = Number((snap as any)?.ema20Slope ?? validationSnap?.ema20Slope ?? 0);
    const slopeFraction = emaValue !== 0 ? emaSlope / emaValue : 0;
    const slopeDirectionalPct = this.plan.bias === 'none' ? 0 : slopeFraction * 100 * (this.plan.bias === 'short' ? -1 : 1);
    const slopeAbsPct = Math.abs(slopeFraction) * 100;
    const cmfVal = typeof (snap as any)?.cmf20 === 'number' ? Number((snap as any).cmf20) : undefined;
    const adxSlopeVal = typeof (snap as any)?.adxSlope === 'number' ? Number((snap as any).adxSlope) : undefined;
    const fastTrackCfg = this.quantConfig.filters.dynamic?.momentumFastTrack;
    const strongMomentumStopEligible = adxValue >= 30
      && Number.isFinite(slopeDirectionalPct) && slopeDirectionalPct >= (fastTrackCfg?.minSlopePct ?? 0.2)
      && volumeRatio != null && volumeRatio >= 1.1
      && (cmfVal == null || cmfVal >= 0);
    let stopBasis: 'structure' | 'atr' | 'momentum_atr' | 'adaptive_atr' = 'structure';
    let stopAtrMult: number | null = null;
    let momentumStopDistance: number | null = null;
    let momentumStopApplied = false;
    let adaptiveStopApplied = false;
    let adaptiveStopMeta: { distance: number; multiplier: number; confidence: number } | null = null;
    const baseStopDistance = typeof planAny._baseStopDistance === 'number'
      ? planAny._baseStopDistance
      : this.plan.stopDistance;
    if (planAny._baseStopDistance == null) {
      planAny._baseStopDistance = baseStopDistance;
    }
    let effectiveStopDistance = baseStopDistance;
    if (playbook === 'momentum_breakout') {
      effectiveStopDistance *= 0.85;
    }
    const atrForBreakoutStops = entryZoneMeta.atr > 0 ? entryZoneMeta.atr : Math.max(1e-8, Math.abs(mktPrice - adaptiveZone.mid));
    if (usingBreakoutEntry) {
      const atrMultiple = adxValue >= 35 ? 2.0 : adxValue >= 25 ? 1.75 : 1.5;
      const atrStopDistance = atrForBreakoutStops * atrMultiple;
      const ema20Now = Number((snap as any)?.ema20 ?? validationSnap.ema20 ?? mktPrice);
      if (planBias === 'long') {
        const emaStopPrice = Number.isFinite(ema20Now) && ema20Now > 0
          ? Math.min(ema20Now, mktPrice - atrStopDistance)
          : mktPrice - atrStopDistance;
        const breakoutStopPrice = Math.min(mktPrice - atrStopDistance, emaStopPrice);
        const breakoutDistance = Math.max(1e-8, mktPrice - breakoutStopPrice);
        effectiveStopDistance = Math.max(effectiveStopDistance, breakoutDistance);
      } else if (planBias === 'short') {
        const emaStopPrice = Number.isFinite(ema20Now) && ema20Now > 0
          ? Math.max(ema20Now, mktPrice + atrStopDistance)
          : mktPrice + atrStopDistance;
        const breakoutStopPrice = Math.max(mktPrice + atrStopDistance, emaStopPrice);
        const breakoutDistance = Math.max(1e-8, breakoutStopPrice - mktPrice);
        effectiveStopDistance = Math.max(effectiveStopDistance, breakoutDistance);
      }
    }
    if (regimeRisk?.stopMultiplier != null && Number.isFinite(regimeRisk.stopMultiplier)) {
      const clamp = Math.max(0.4, Math.min(1, regimeRisk.stopMultiplier));
      effectiveStopDistance *= clamp;
    }
    if (strongMomentumStopEligible && atrForBreakoutStops > 0) {
      let momentumAtrMult = 0.75;
      if (adxValue >= 42 && slopeDirectionalPct >= 0.35 && (volumeRatio ?? 0) >= 1.3) momentumAtrMult = 0.6;
      else if (adxValue >= 36 && slopeDirectionalPct >= 0.28 && (volumeRatio ?? 0) >= 1.22) momentumAtrMult = 0.68;
      else if (adxValue >= 32 && slopeDirectionalPct >= 0.24 && (volumeRatio ?? 0) >= 1.15) momentumAtrMult = 0.72;
      momentumAtrMult = Math.max(0.6, Math.min(0.8, momentumAtrMult));
      const atrTightDistance = Math.max(1e-8, atrForBreakoutStops * momentumAtrMult);
      const tightened = Math.min(effectiveStopDistance, atrTightDistance);
      if (tightened < effectiveStopDistance - 1e-8) {
        momentumStopApplied = tightened < baseStopDistance - 1e-8;
      }
      effectiveStopDistance = tightened;
      momentumStopDistance = tightened;
    }

    let structurePivotApplied = false;
    const ema50Candidate = Number((snap as any)?.ema50 ?? validationSnap?.ema50 ?? mktPrice);
    const supports = Array.isArray((snap as any)?.supports) ? (snap as any).supports : [];
    const resistances = Array.isArray((snap as any)?.resistances) ? (snap as any).resistances : [];
    const nearestSupport = supports
      .filter(level => level && typeof level.price === 'number' && level.price < mktPrice)
      .map(level => level.price as number)
      .reduce((best: number | null, price) => (best == null || mktPrice - price < mktPrice - best ? price : best), null as number | null);
    const nearestResistance = resistances
      .filter(level => level && typeof level.price === 'number' && level.price > mktPrice)
      .map(level => level.price as number)
      .reduce((best: number | null, price) => (best == null || price - mktPrice < best - mktPrice ? price : best), null as number | null);
    let swingDistance: number | null = null;
    if (planBias === 'long' && nearestSupport != null) {
      const diff = mktPrice - nearestSupport;
      if (diff > 0) swingDistance = diff;
    } else if (planBias === 'short' && nearestResistance != null) {
      const diff = nearestResistance - mktPrice;
      if (diff > 0) swingDistance = diff;
    }
    let emaDistance: number | null = null;
    if (Number.isFinite(ema50Candidate) && ema50Candidate > 0) {
      if ((planBias === 'long' && ema50Candidate <= mktPrice) || (planBias === 'short' && ema50Candidate >= mktPrice)) {
        const diff = Math.abs(mktPrice - ema50Candidate);
        if (diff > 0) emaDistance = diff;
      }
    }
    let structureDistance: number | null = null;
    let structureBasis: 'swing' | 'ema50' | null = null;
    if (swingDistance != null) {
      structureDistance = swingDistance;
      structureBasis = 'swing';
    }
    if (emaDistance != null && (structureDistance == null || emaDistance < structureDistance)) {
      structureDistance = emaDistance;
      structureBasis = 'ema50';
    }
    if (structureDistance != null && structureDistance > 0) {
      const trendQualified = adxValue >= 25 || Math.abs(slopeDirectionalPct) >= 0.2;
      const distanceFloor = baseStopDistance > 0 ? baseStopDistance * 0.55 : 0;
      if (trendQualified && structureDistance >= distanceFloor && structureDistance < effectiveStopDistance) {
        const tightened = structureDistance;
        effectiveStopDistance = tightened;
        if (momentumStopDistance != null) {
          momentumStopDistance = Math.min(momentumStopDistance, tightened);
        }
        planAny._structureStopPivot = { basis: structureBasis, distance: tightened };
        recordOpsEvent({
          level: 'info',
          source: 'risk_engine',
          message: 'structure_stop_pivot',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            basis: structureBasis,
            distance: tightened,
            baseStopDistance,
            adx: adxValue,
          },
        });
        structurePivotApplied = true;
      }
    }
    const momentumDetails = this.lastMomentumGateResult?.details as any;
    if (!structurePivotApplied && planAny._structureStopPivot) {
      delete planAny._structureStopPivot;
    }
    let recognizedConfidence: number | null = null;
    if (momentumDetails?.recognizedOverrideConfidence != null) {
      const candidate = Number(momentumDetails.recognizedOverrideConfidence);
      recognizedConfidence = Number.isFinite(candidate) ? candidate : null;
    } else if (Array.isArray(momentumDetails?.context?.recognizedStrategies)) {
      const first = momentumDetails.context.recognizedStrategies[0];
      if (first && typeof first.confidence === 'number' && Number.isFinite(first.confidence)) {
        recognizedConfidence = first.confidence;
      }
    }
    let qualitySizingPreview = 1.0;
    try {
      const rawPreview = this.computeQualityBasedSizing(snap!);
      qualitySizingPreview = Math.max(0.6, Math.min(1.6, rawPreview));
    } catch {}
    const riskContextPct = this.adaptiveRisk?.riskPct ?? this.profile.riskPerTradePct;
    const stopBeforeAdaptive = effectiveStopDistance;
    const adaptiveStop = this.computeAdaptiveStopDistance({
      baseDistance: effectiveStopDistance,
      atrDistance: atrForBreakoutStops,
      atrPct: Number(entryZoneMeta?.atrPct ?? this.plan?.atrPct ?? 0),
      riskContextPct,
      qualityMultiplier: qualitySizingPreview,
      recognizedConfidence,
    });
    if (adaptiveStop && Math.abs(adaptiveStop.distance - stopBeforeAdaptive) > 1e-8) {
      adaptiveStopApplied = true;
      adaptiveStopMeta = adaptiveStop;
      effectiveStopDistance = adaptiveStop.distance;
      if (momentumStopDistance != null && adaptiveStop.distance < momentumStopDistance) {
        momentumStopDistance = adaptiveStop.distance;
      }
      planAny._adaptiveStopMeta = {
        distance: adaptiveStop.distance,
        multiplier: adaptiveStop.multiplier,
        confidence: adaptiveStop.confidence,
        atrDistance: atrForBreakoutStops,
      };
      recordOpsEvent({
        level: 'watch',
        source: 'risk_engine',
        message: 'adaptive_atr_stop_applied',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          previousDistance: stopBeforeAdaptive,
          adjustedDistance: adaptiveStop.distance,
          atrDistance: atrForBreakoutStops,
          multiplier: adaptiveStop.multiplier,
          confidence: adaptiveStop.confidence,
          kellyMultiplier: this.adaptiveRisk?.kellyMultiplier ?? null,
        },
      });
    }
    if (!adaptiveStopApplied && planAny._adaptiveStopMeta) {
      delete planAny._adaptiveStopMeta;
    }
    this.plan.stopDistance = effectiveStopDistance;
    const stopRaw = this.plan.bias === 'long'
      ? entry - this.plan.stopDistance
      : entry + this.plan.stopDistance;
    let stop = round4(stopRaw);
    const dir0 = side === 'buy' ? 1 : -1;
    const targetSizingCfg = getConfig();
    const minFirstR = Math.max(1, Number(targetSizingCfg.MIN_FIRST_R ?? 1.5));
    const targetTp1BasePct = Math.max(0, Number(targetSizingCfg.TARGET_TP1_PCT ?? targetSizingCfg.MIN_TP_PCT ?? 0));
    const targetTp2BasePct = Math.max(0, Number(targetSizingCfg.TARGET_TP2_PCT ?? 0));
    const targetTp3BasePct = Math.max(0, Number(targetSizingCfg.TARGET_TP3_PCT ?? 0));
    const targetMinTp1PnlUsd = Math.max(0, Number(targetSizingCfg.TARGET_TP1_MIN_PNL_USD ?? 0));
    const targetSizingEnabled = targetMinTp1PnlUsd > 0
      || targetTp1BasePct > 0
      || targetTp2BasePct > 0
      || targetTp3BasePct > 0;
    if (playbook === 'momentum_breakout') {
      const momentumTargets = [1.0, 2.0, 3.0];
      this.plan.plan.risk.tp = momentumTargets.map(value => ({ type: 'R', value }));
      this.plan.rPrices = momentumTargets.map(r => ({ r, price: round4(entry + dir0 * r * this.plan!.stopDistance) }));
    }
    let tp = this.plan.rPrices.map(x => round4(entry + dir0 * x.r * this.plan!.stopDistance));
    const atrForBracket = typeof (snap as any)?.atr14 === 'number' ? Number((snap as any).atr14) : this.plan.atr;
    if (atrForBracket && atrForBracket > 0) {
      try {
        const bracket = computeInitialBracket(
          entry,
          atrForBracket,
          side === 'buy' ? 'long' : 'short',
          this.quantConfig.exits,
          quantArchetype,
        );
        let quantStopPrice = round4(bracket.stop);
        let quantDistance = Math.abs(entry - quantStopPrice);
        if (momentumStopDistance != null && quantDistance > momentumStopDistance + 1e-8) {
          quantDistance = momentumStopDistance;
          quantStopPrice = round4(side === 'buy' ? entry - quantDistance : entry + quantDistance);
        }
        if (quantDistance > this.plan.stopDistance + 1e-8) {
          this.plan.stopDistance = quantDistance;
          stop = quantStopPrice;
          const targets = momentumStopDistance != null && Math.abs(quantDistance - momentumStopDistance) <= 1e-8
            ? this.quantConfig.exits.tpRMultiples.map((r) => round4(entry + dir0 * r * quantDistance))
            : bracket.targets.map(target => round4(target));
          tp = targets;
          const stopForRLocal = Math.max(this.plan.stopDistance, 1e-9);
          this.plan.rPrices = tp.map((price, idx) => {
            const rRaw = Math.abs(price - entry) / stopForRLocal;
            const fallback = this.quantConfig.exits.tpRMultiples[idx] ?? (idx + 1);
            const r = Number.isFinite(rRaw) && rRaw > 0 ? rRaw : fallback;
            return { r: roundR(r), price };
          });
          this.plan.plan.risk.tp = this.plan.rPrices.map(({ r }) => ({ type: 'R', value: r }));
        }
      } catch (error) {
        console.debug('QuantAI bracket computation failed:', error);
      }
    }
    if (usingBreakoutEntry) {
      const atrPctFraction = entryZoneMeta.atrPct / 100;
      const breakoutTargetPct = Math.min(0.01, Math.max(0.006, atrPctFraction > 0 ? atrPctFraction * 0.5 : 0.008));
      const breakoutTpPrice = this.plan.bias === 'long'
        ? round4(entry * (1 + breakoutTargetPct))
        : round4(entry * (1 - breakoutTargetPct));
      tp[0] = breakoutTpPrice;
      const stopForR = Math.max(this.plan.stopDistance, Math.abs(entry - stop), 1e-8);
      let breakoutR = Math.abs(breakoutTpPrice - entry) / stopForR;
      if (!Number.isFinite(breakoutR) || breakoutR <= 0) {
        breakoutR = minFirstR;
      }
      breakoutR = Math.max(minFirstR, Math.min(1.8, breakoutR));
      if (Array.isArray(this.plan.rPrices) && this.plan.rPrices.length > 0) {
        this.plan.rPrices[0] = { r: roundR(breakoutR), price: breakoutTpPrice };
      }
      this.plan.plan.risk.tp = this.plan.rPrices.map(({ r }) => ({ type: 'R', value: r }));
      recordOpsEvent({
        level: 'info',
        source: 'take_profit',
        message: 'breakout_tp_adjusted',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          breakoutTargetPct: breakoutTargetPct * 100,
          breakoutR,
        },
      });
    }
    if (adaptiveStopApplied && adaptiveStopMeta) {
      stopBasis = 'adaptive_atr';
    } else if (momentumStopDistance != null && this.plan.stopDistance <= momentumStopDistance + 1e-8 && momentumStopDistance < baseStopDistance - 1e-8) {
      stopBasis = 'momentum_atr';
    } else if (this.plan.stopDistance > baseStopDistance + 1e-8) {
      stopBasis = 'atr';
    } else {
      stopBasis = 'structure';
    }
    if (atrForBracket && atrForBracket > 0) {
      stopAtrMult = this.plan.stopDistance / atrForBracket;
    } else if (atrForBreakoutStops > 0) {
      stopAtrMult = this.plan.stopDistance / atrForBreakoutStops;
    }
    const riskAbs = Math.max(1e-9, Math.abs(entry - stop));
    const stopForR = Math.max(this.plan.stopDistance, Math.abs(entry - stop), 1e-8);
    let forcedTpPercents: number[] | null = null;
    if (targetSizingEnabled) {
      const baseTp1Pct = targetTp1BasePct > 0 ? targetTp1BasePct : 1.5;
      const baseTp2Pct = targetTp2BasePct > 0 ? targetTp2BasePct : 3;
      const baseTp3Pct = targetTp3BasePct > 0 ? targetTp3BasePct : 5;
      const ratio2 = baseTp1Pct > 0 ? baseTp2Pct / baseTp1Pct : 2;
      const ratio3 = baseTp1Pct > 0 ? baseTp3Pct / baseTp1Pct : (baseTp3Pct > 0 ? baseTp3Pct / 1.5 : 10 / 3);
      const atrCandidates = [
        typeof this.plan?.atrPct === 'number' ? this.plan.atrPct : null,
        typeof snap?.atrPct === 'number' ? snap.atrPct : null,
        typeof (validationSnap as any)?.atrPct === 'number' ? (validationSnap as any).atrPct : null,
      ];
      const atrPctContext = atrCandidates.find((value): value is number => value != null && Number.isFinite(value) && value > 0) ?? 0;
      const atrBoostPct = atrPctContext > 0 ? atrPctContext * 0.6 : 0;
      const tp1Pct = Math.max(baseTp1Pct, atrBoostPct);
      const tp2Pct = Math.max(baseTp2Pct, tp1Pct * (ratio2 > 0 ? ratio2 : 2));
      const tp3Pct = Math.max(baseTp3Pct, tp1Pct * (ratio3 > 0 ? ratio3 : 10 / 3));
      forcedTpPercents = [tp1Pct, tp2Pct, tp3Pct];
    }
    if (forcedTpPercents) {
      const forcedTpPrices = forcedTpPercents.map((pct) => {
        const pctFraction = pct / 100;
        const price = entry * (1 + dir0 * pctFraction);
        const safePrice = dir0 > 0 ? price : Math.max(price, 1e-8);
        return round4(safePrice);
      });
      tp = forcedTpPrices;
      this.plan.rPrices = forcedTpPrices.map((price) => {
        const diff = Math.abs(price - entry);
        const r = stopForR > 0 ? diff / stopForR : 0;
        return { r: roundR(Math.max(r, 1e-6)), price };
      });
      this.plan.plan.risk.tp = this.plan.rPrices.map(({ r }) => ({ type: 'R', value: r }));
    }
    if (Array.isArray(this.plan.rPrices) && this.plan.rPrices.length > 0 && stopForR > 0) {
      const currentFirstR = Number(this.plan.rPrices[0].r);
      if (!(currentFirstR >= minFirstR - 1e-6)) {
        const adjustedR = roundR(minFirstR);
        const adjustedPrice = round4(entry + dir0 * adjustedR * stopForR);
        this.plan.rPrices[0] = { r: adjustedR, price: adjustedPrice };
        tp[0] = adjustedPrice;
        if (Array.isArray(this.plan.plan.risk?.tp) && this.plan.plan.risk.tp.length > 0) {
          this.plan.plan.risk.tp = this.plan.plan.risk.tp.map((target, idx) => (
            idx === 0 ? { type: 'R', value: adjustedR } : target
          ));
        }
      }
    }
    const flowStrongForTp = adxValue >= 35
      && slopeDirectionalPct >= (fastTrackCfg?.minSlopePct ?? 0.2)
      && (volumeRatio ?? 0) >= 1.15
      && (cmfVal == null || cmfVal >= 0);
    if (
      flowStrongForTp &&
      atrForBracket && atrForBracket > 0 &&
      stopForR > 0 &&
      Array.isArray(this.plan.rPrices) &&
      this.plan.rPrices.length > 0
    ) {
      const extraAtrMult = adxValue >= 42 && (volumeRatio ?? 0) >= 1.28 ? 0.25 : 0.18;
      const extraR = (atrForBracket * extraAtrMult) / stopForR;
      if (extraR > 0.05) {
        const baseR = typeof this.plan.rPrices[0].r === 'number'
          ? this.plan.rPrices[0].r
          : Math.abs(tp[0] - entry) / stopForR;
        const newR = baseR + extraR;
        const newPrice = round4(entry + dir0 * newR * stopForR);
        this.plan.rPrices[0] = { r: roundR(newR), price: newPrice };
        tp[0] = newPrice;
        this.plan.plan.risk.tp = this.plan.rPrices.map(({ r }) => ({ type: 'R', value: r }));
      }
    }
    const firstR = this.plan.rPrices?.[0]?.r ?? (tp.length > 0 ? Math.abs(tp[0] - entry) / stopForR : undefined);
    const snapAtrPct = typeof (snap as any)?.atrPct === 'number'
      ? Number((snap as any).atrPct)
      : undefined;
    const planAtrPct = Number.isFinite(this.plan?.atrPct)
      ? Number(this.plan?.atrPct)
      : undefined;
    const atrBaselinePct = planAtrPct ?? snapAtrPct ?? undefined;
    const spreadPercent = spreadBps != null ? Math.max(0, spreadBps / 100) : null;
    const spreadAtrRatio = spreadPercent != null && atrBaselinePct != null && atrBaselinePct > 0
      ? spreadPercent / atrBaselinePct
      : null;
    const rrRelaxEligible = adxValue >= 25
      && (spreadBps == null || spreadBps <= 1)
      && (spreadAtrRatio != null && spreadAtrRatio <= 0.2)
      && (volumeRatio == null || Math.abs(volumeRatio - 1) <= 0.25);
    if (rrRelaxEligible) {
      const deviation = volumeRatio != null ? Math.abs(volumeRatio - 1) : 0;
      const rrRelaxedTarget = 1.2 + Math.min(0.05, Math.max(0, deviation * 0.2));
      if (rrRelaxedTarget < rrEffectiveForFilters) {
        rrEffectiveForFilters = rrRelaxedTarget;
        recordOpsEvent({
          level: 'info',
          source: 'entry_filters',
          message: 'rr_dynamic_relaxed',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            base: rrSnapshot.effective,
            applied: rrEffectiveForFilters,
            adx: adxValue,
            spreadBps,
            spreadAtrRatio,
            volumeRatio,
          },
        });
      }
    }

    const rMultiples = Array.isArray(this.plan.rPrices)
      ? this.plan.rPrices
        .map(({ r, price }) => {
          if (typeof r === 'number' && Number.isFinite(r)) return Number(r);
          if (Number.isFinite(price)) return Math.abs((price as number) - entry) / stopForR;
          return null;
        })
        .filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
      : [];
    let rrWeighted: number | undefined;
    // Structured configuration for TP weight profiles and their threshold conditions
    const tpWeightProfilesConfig = [
      {
        profile: [0.2, 0.3, 0.5],
        condition: () =>
          adxValue >= 25 &&
          (spreadAtrRatio != null && spreadAtrRatio <= 0.2) &&
          (volumeRatio ?? 0) >= 0.85,
      },
      {
        profile: [0.3, 0.35, 0.35],
        condition: () =>
          adxValue >= 35 &&
          (volumeRatio ?? 0) >= 1.2 &&
          slopeDirectionalPct >= (fastTrackCfg?.minSlopePct ?? 0.2),
      },
      {
        profile: [0.3, 0.35, 0.35], // default
        condition: () => true,
      },
    ];
    const defaultProfile = tpWeightProfilesConfig[tpWeightProfilesConfig.length - 1]!.profile;
    const matchingProfile = tpWeightProfilesConfig.find(cfg => cfg.condition());
    const tpWeightProfile: number[] = matchingProfile?.profile ?? defaultProfile;
    if (rMultiples.length > 0) {
      const baseWeights = tpWeightProfile;
      const fallbackWeight = baseWeights[baseWeights.length - 1] ?? 0.1;
      const weights = rMultiples.map((_, idx) => {
        if (idx < baseWeights.length) return baseWeights[idx]!;
        const decay = Math.pow(0.5, idx - baseWeights.length + 1);
        return fallbackWeight * decay;
      });
      const weightSum = weights.reduce((acc, value) => acc + value, 0);
      if (weightSum > 0) {
        rrWeighted = rMultiples.reduce((acc, value, idx) => acc + value * (weights[idx]! / weightSum), 0);
      }
    }
    const planRuntime: any = this.plan;
    if (typeof rrWeighted === 'number' && Number.isFinite(rrWeighted)) {
      planRuntime._initialWeightedR = rrWeighted;
    }
    const tpWeightedAbs = rrWeighted != null ? rrWeighted * stopForR : undefined;
    const tpWeightedPct = tpWeightedAbs != null && entry > 0 ? (tpWeightedAbs / entry) * 100 : undefined;
    const tp1Fraction = Math.max(0.15, Math.min(0.4, tpWeightProfile[0] ?? 0.3));
    planAny._tpWeightProfile = tpWeightProfile;
    planAny._tp1Fraction = tp1Fraction;
    planAny._stopBasis = stopBasis;
    planAny._stopAtrMult = stopAtrMult;
    planAny._momentumStopTarget = momentumStopDistance;
    planAny._flowSnapshot = {
      adx: Number.isFinite(adxValue) ? adxValue : null,
      slopePct: Number.isFinite(slopeDirectionalPct) ? slopeDirectionalPct : null,
      volRatio: Number.isFinite(volumeRatio ?? NaN) ? volumeRatio : null,
      cmf: cmfVal ?? null,
      spreadAtrRatio: spreadAtrRatio ?? null,
    };
    const firstTpProfitPct = tp.length > 0 && entry !== 0 ? Math.abs((tp[0] - entry) / entry) * 100 : 0;
    const planMeta = (this.plan.plan.meta || {}) as Record<string, unknown>;
    const modelConfidence =
      typeof planMeta.confidenceScore === 'number'
        ? planMeta.confidenceScore
        : typeof planMeta.confidence === 'number'
          ? planMeta.confidence
          : typeof (planMeta as any)?.probability === 'number'
            ? Number((planMeta as any).probability)
            : undefined;
    const firstTpPrice = tp.length > 0 ? tp[0] : this.plan.rPrices?.[0]?.price ?? null;
    if (firstTpPrice != null && Number.isFinite(firstTpPrice) && entry > 0) {
      const tp1Dist = Math.abs(firstTpPrice - entry) / entry;
      const atrPctForGate = atrBaselinePct;
      const atrFloor = atrPctForGate != null && Number.isFinite(atrPctForGate)
        ? Math.max(0, 0.006 * (atrPctForGate as number))
        : 0;
      const minTp1Dist = Math.max(atrFloor, 0.0008);
      if (tp1Dist < minTp1Dist) {
        this.noteSignalDrop('tp_too_close', 'info', {
          tp1Dist,
          minRequired: minTp1Dist,
          atrPct: atrPctForGate,
          entry,
          tp1: firstTpPrice,
        });
        this.entering = false;
        return;
      }
    }
    const tier = this.getTierForSymbol(this.profile.symbol);
    const aggressiveness = this.profile.aggressiveness || null;
    const { playbook: previewPlaybook } = this.getContextualPlaybook(snap, this.plan?.bias ?? 'none');
    const previewProfile = this.getQualityScoreProfile(previewPlaybook, aggressiveness || 'reactive');
    const volatilityProfileForFilters = this.resolveVolatilityProfileForFilters();
    let qualityPassHint: boolean | undefined;
    try {
      const previewDiagnostics = this.getQualityFiltersDiagnostics(snap);
      const previewAssessment = this.assessQualityScore(previewDiagnostics, 0, {
        weights: previewProfile.weights,
        majorityRatio: previewProfile.majorityRatio,
        partialCredit: previewProfile.partialCredit,
        minPassCount: previewProfile.minPassCount,
        comboTolerance: previewProfile.comboTolerance,
      }) as QualityAssessmentSnapshot;
      this.previewQualityDiagnostics = {
        snapshotKey: this.getQualitySnapshotKey(snap),
        data: previewDiagnostics,
        assessment: previewAssessment,
      };
      qualityPassHint = previewAssessment.allow;
    } catch (error) {
      console.warn('Quality preview failed:', error);
      this.resetQualityPreview();
    }
    const rrSummaryParts = [
      `RR=${typeof firstR === 'number' ? firstR.toFixed(2) : 'n/a'}`,
      `RR_MIN_EFF=${rrSnapshot.effective.toFixed(2)}`,
      `RR_MIN_USED=${rrEffectiveForFilters.toFixed(2)}`,
      `mode=${rrSnapshot.mode}`,
      rrSnapshot.winRate != null ? `p=${rrSnapshot.winRate.toFixed(2)}` : 'p=n/a',
      `RRw=${typeof rrWeighted === 'number' ? rrWeighted.toFixed(2) : 'n/a'}`,
      `TPw%=${typeof tpWeightedPct === 'number' ? tpWeightedPct.toFixed(2) : 'n/a'}`,
      `trades=${rrSnapshot.trades}`,
      `rrDyn=${rrSnapshot.dynamic != null ? rrSnapshot.dynamic.toFixed(2) : 'n/a'}`,
      `blend=${this.rrExpectancyConfig.blend.toFixed(2)}`,
      `hysteresisApplied=${rrSnapshot.hysteresisApplied ? 'yes' : 'no'}`,
      `qualityHint=${qualityPassHint === true ? 'pass' : qualityPassHint === false ? 'fail' : 'n/a'}`,
      `volRatio=${volumeRatio != null ? volumeRatio.toFixed(2) : 'n/a'}`,
    ].join(', ');
    const drySpellRelaxation = this.resolveDrySpellRelaxation();
    const filterEvaluation = this.entryFilters.evaluateEntry({
      price: entry,
      atr: typeof (snap as any)?.atr14 === 'number' ? Number((snap as any).atr14) : this.plan.atr,
      atrPct: snapAtrPct,
      atrBaselinePct,
      adx: typeof (snap as any)?.adx14 === 'number' ? Number((snap as any).adx14) : undefined,
      spreadBps,
      dollarVolume: typeof (marketTicker as any)?.quoteVolume === 'number'
        ? Number((marketTicker as any).quoteVolume)
        : typeof (snap as any)?.volume24h === 'number'
          ? Number((snap as any).volume24h)
          : undefined,
      rrToTp1: typeof firstR === 'number' ? firstR : undefined,
      rrWeighted: typeof rrWeighted === 'number' ? rrWeighted : undefined,
      tpWeightedPct: typeof tpWeightedPct === 'number' ? tpWeightedPct : undefined,
      stopDistance: stopForR,
      qualityPassHint,
      volumeRatio: typeof volumeRatio === 'number' ? volumeRatio : undefined,
      modelConfidence: typeof modelConfidence === 'number' ? modelConfidence : undefined,
      slopeDirectionalPct: Number.isFinite(slopeDirectionalPct) ? slopeDirectionalPct : undefined,
      slopeAbsPct: Number.isFinite(slopeAbsPct) ? slopeAbsPct : undefined,
      cmf: typeof cmfVal === 'number' ? cmfVal : undefined,
      adxSlope: typeof adxSlopeVal === 'number' ? adxSlopeVal : undefined,
    }, {
      minRr: rrEffectiveForFilters,
      rrSummary: rrSummaryParts,
      tier,
      symbol: this.profile.symbol,
      aggressiveness,
      atrBaselinePct,
      volatilityProfile: volatilityProfileForFilters,
      relaxation: drySpellRelaxation ?? undefined,
    });
    const entryFilterSizePenalty = typeof filterEvaluation.modifiers?.sizeMultiplier === 'number'
      ? filterEvaluation.modifiers.sizeMultiplier
      : undefined;
    const waitSeconds = this.priceInZoneStartTime > 0 ? Math.round((Date.now() - this.priceInZoneStartTime) / 1000) : null;
    const confirmMode = usingBreakoutEntry ? 'breakout' : 'pullback';
    const rrDetails = {
      tp1: typeof firstR === 'number' ? firstR : null,
      rrw: typeof rrWeighted === 'number' ? rrWeighted : null,
      minBase: rrSnapshot.effective,
      minApplied: filterEvaluation.meta?.minRrUsed ?? rrSnapshot.effective,
      floor: filterEvaluation.meta?.minRrFloor ?? null,
      strongFlow: filterEvaluation.meta?.strongFlow ?? false,
      fastTrack: filterEvaluation.meta?.fastTrackApplied ?? false,
      near: filterEvaluation.meta?.rrNearThreshold ?? false,
      quality: filterEvaluation.meta?.qualityHint ?? (qualityPassHint ?? null),
    };
    const stopsDetails = {
      pct: entry > 0 ? (stopForR / entry) * 100 : null,
      atrMult: stopAtrMult,
      basis: stopBasis,
      distance: stopForR,
    };
    const tpDetails = {
      tp1PctDist: firstTpProfitPct,
      tpMix: tpWeightProfile,
      weightedPct: typeof tpWeightedPct === 'number' ? tpWeightedPct : null,
    };
    const flowDetails = {
      adx: Number.isFinite(adxValue) ? adxValue : null,
      slopePct: Number.isFinite(slopeDirectionalPct) ? slopeDirectionalPct : null,
      volRatio: volumeRatio ?? null,
      cmf: cmfVal ?? null,
      adxSlope: adxSlopeVal ?? null,
    };
    const confirmDetails = {
      mode: confirmMode,
      waitSec: waitSeconds,
    };
    recordOpsEvent({
      level: 'watch',
      source: 'entry_filters',
      message: 'rr_gate_evaluated',
      sessionId: this.sessionId || undefined,
      symbol: this.profile.symbol,
      details: {
        rr: rrDetails,
        stops: stopsDetails,
        tp: tpDetails,
        flow: flowDetails,
        confirm: confirmDetails,
        summary: rrSummaryParts,
      },
    });
    planAny._strongFlow = filterEvaluation.meta?.strongFlow ?? false;
    planAny._rrFloor = filterEvaluation.meta?.minRrFloor ?? null;
    planAny._rrApplied = filterEvaluation.meta?.minRrUsed ?? rrEffectiveForFilters;
    planAny._confirmWaitSec = waitSeconds;
    if (filterEvaluation.meta?.spread) {
      const spreadMeta = filterEvaluation.meta.spread;
      recordOpsEvent({
        level: spreadMeta.absFail && spreadMeta.relFail ? 'warn' : 'watch',
        source: 'entry_filters',
        message: 'spread_gate_evaluated',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          spreadBps: spreadMeta.spreadBps ?? spreadBps ?? null,
          maxSpreadBps: spreadMeta.maxSpreadBps ?? null,
          spreadAtrRatio: spreadMeta.spreadAtrRatio ?? null,
          spreadAtrRatioLimit: spreadMeta.spreadAtrRatioLimit ?? null,
          absFail: spreadMeta.absFail,
          relFail: spreadMeta.relFail,
          penaltyApplied: spreadMeta.penaltyApplied ?? null,
        },
      });
    }
    if (!filterEvaluation.ok) {
      this.registerFilterRejection(filterEvaluation.reasons);
      recordOpsEvent({
        level: 'info',
        source: 'entry_filters',
        message: 'quantai_entry_rejected',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: filterEvaluation.reasons,
      });
      this.noteSignalDrop('quantai_filter_blocked', 'info', filterEvaluation.reasons);
      this.resetQualityPreview();
      this.entering = false;
      return;
    }
    this.registerFilterPass();

    // CRYPTO PROFIT FILTER: Minimum profit threshold
    const cfgProfit = getConfig();
    // Aggressiveness-aware min profitability
    let minProfitPct = cfgProfit.MIN_TRADE_PROFIT_PCT;
    const levelProfit = this.profile?.aggressiveness || 'conservative';
    if (levelProfit === 'reactive') minProfitPct = Math.max(0.55, minProfitPct - 0.15);
    if (levelProfit === 'aggressive') minProfitPct = Math.max(0.45, minProfitPct - 0.25);
    const memeProfitRelax = this.isMemeCoin(this.profile?.symbol);
    const atrContextPct = atrBaselinePct ?? snapAtrPct;
    if (typeof atrContextPct === 'number' && atrContextPct > 0) {
      if (atrContextPct < 0.1) {
        minProfitPct = Math.min(minProfitPct, 0.3);
      } else if (atrContextPct < 0.16) {
        minProfitPct = Math.min(minProfitPct, 0.32);
      } else if (atrContextPct < 0.25) {
        minProfitPct = Math.min(minProfitPct, 0.35);
      } else if (atrContextPct < 0.4) {
        minProfitPct = Math.min(minProfitPct, 0.4);
      }
    }
    if (memeProfitRelax) {
      minProfitPct = Math.min(minProfitPct, 0.33);
    }
    const profitRelaxEligible = adxValue >= 25
      && (spreadBps == null || spreadBps <= 1.2)
      && (spreadAtrRatio != null && spreadAtrRatio <= 0.2)
      && (volumeRatio == null || (volumeRatio >= 0.85 && volumeRatio <= 1.35))
      && qualityAssessment.allow;
    if (profitRelaxEligible) {
      const relaxedFloor = Math.max(0.26, Math.min(0.32, minProfitPct));
      if (relaxedFloor < minProfitPct) {
        minProfitPct = relaxedFloor;
        recordOpsEvent({
          level: 'info',
          source: 'profit_filter',
          message: 'profit_threshold_relaxed',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            applied: relaxedFloor,
            base: cfgProfit.MIN_TRADE_PROFIT_PCT,
            adx: adxValue,
            spreadBps,
            spreadAtrRatio,
            volumeRatio,
          },
        });
      }
    }
    // Single profitability gate is enough; movement check duplicates the same quantity
    if (firstTpProfitPct < minProfitPct) {
      recordOpsEvent({
        level: 'info',
        source: 'profit_filter',
        message: 'Trade rejected - insufficient profit potential',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { 
          expectedProfitPct: firstTpProfitPct,
          minRequired: minProfitPct,
          tp1: tp[0],
          entry
        },
      });
      this.resetQualityPreview();
      this.entering = false;
      return;
    }
    const budgetFrac = resolveBudgetFraction(this.profile.budgetFraction);
    const marginCapacity = Math.max(0, marginAdvisor.marginCapacityUsd());
    const availableMargin = marginCapacity > 0 ? marginCapacity : Math.max(0, bal.equityUsd - bal.committedUsd);
    // Hard budget cap: allow growth beyond initial balance by considering live equity
    const startBalance = Number.isFinite(this.profile.startBalanceUsd)
      ? Math.max(0, Number(this.profile.startBalanceUsd))
      : 0;
    const equityNow = Number.isFinite(bal.equityUsd) ? Math.max(0, Number(bal.equityUsd)) : 0;
    const freeNow = Number.isFinite(bal.freeUsd) ? Math.max(0, Number(bal.freeUsd)) : 0;
    const budgetBase = Math.max(startBalance, equityNow, freeNow);
    const capBalance = budgetBase > 0 ? budgetBase * budgetFrac : 0;
    const usableBalance = Math.max(
      0,
      Math.min(
        freeNow,
        availableMargin > 0 ? availableMargin : freeNow,
        capBalance > 0 ? capBalance : freeNow,
      ),
    );
    const planPosition: any = this.plan.plan?.position || {};
    let planRiskMinPct: number | undefined;
    let planRiskMaxPct: number | undefined;
    let planRiskRecommendedPct: number | undefined;
    if (typeof planPosition?.risk_fraction === 'number') {
      planRiskRecommendedPct = planPosition.risk_fraction * 100;
    }
    if (planPosition?.risk_fraction_range) {
      const range = planPosition.risk_fraction_range;
      if (typeof range.min === 'number') planRiskMinPct = range.min * 100;
      if (typeof range.max === 'number') planRiskMaxPct = range.max * 100;
      if (typeof range.recommended === 'number') planRiskRecommendedPct = range.recommended * 100;
    }
    if (planRiskMinPct != null) planRiskMinPct = Math.min(planRiskMinPct, this.profile.riskPerTradePct);
    if (planRiskMaxPct != null) planRiskMaxPct = Math.max(planRiskMaxPct, this.profile.riskPerTradePct);
    const baseProfileRisk = this.profile.riskPerTradePct > 0 ? this.profile.riskPerTradePct : 1.5;
    let dynamicRiskPct = baseProfileRisk;
    let pendingKellyMultiplier = 1;
    let pendingKellyFloor = 0;
    let pendingKellyFraction = 0;

    if (planRiskRecommendedPct != null && planRiskRecommendedPct > 0) {
      dynamicRiskPct = Math.max(dynamicRiskPct, planRiskRecommendedPct);
    }

    let tierAdjustedRisk = dynamicRiskPct;
    if (tier === 'tier1') {
      tierAdjustedRisk = Math.max(2.5, Math.min(3.0, dynamicRiskPct + 1.0));
    } else if (tier === 'tier2') {
      const boost = Math.max(0.5, Math.min(1.0, 0.75));
      tierAdjustedRisk = dynamicRiskPct + boost;
    }
    if (tierAdjustedRisk !== dynamicRiskPct) {
      recordOpsEvent({
        level: 'watch',
        source: 'position_sizing',
        message: 'tier_risk_adjustment',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          tier,
          baseRisk: dynamicRiskPct,
          adjustedRisk: tierAdjustedRisk,
        },
      });
      dynamicRiskPct = tierAdjustedRisk;
    }

    if (planRiskMinPct != null) dynamicRiskPct = Math.max(dynamicRiskPct, planRiskMinPct);
    if (planRiskMaxPct != null) dynamicRiskPct = Math.min(dynamicRiskPct, planRiskMaxPct);

    if (entryFilterSizePenalty != null && entryFilterSizePenalty > 0 && entryFilterSizePenalty < 1) {
      dynamicRiskPct *= entryFilterSizePenalty;
      recordOpsEvent({
        level: 'watch',
        source: 'position_sizing',
        message: 'entry_filter_size_penalty',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          sizeMultiplier: entryFilterSizePenalty,
          origin: filterEvaluation.meta?.spread?.absFail && !filterEvaluation.meta?.spread?.relFail
            ? 'spread_abs_soft_cap'
            : 'entry_filter_penalty',
        },
      });
    }

    // Apply quality-based position sizing
    let qualityMultiplier = 1.0;
    try {
      const rawQualityAdjustment = this.computeQualityBasedSizing(snap!);
      const qualityFloor = targetSizingEnabled ? 1.0 : 0.9;
      qualityMultiplier = Math.max(qualityFloor, Math.min(1.4, rawQualityAdjustment));
      dynamicRiskPct *= qualityMultiplier;
      recordOpsEvent({
        level: 'watch',
        source: 'position_sizing',
        message: 'quality_adjustment_applied',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          baseRisk: this.profile.riskPerTradePct,
          rawQualityMultiplier: rawQualityAdjustment,
          qualityMultiplier,
          finalRisk: dynamicRiskPct,
          aggressiveness: this.profile.aggressiveness
        },
      });
    } catch {
      qualityMultiplier = 1.0;
    }
    
    try {
      this.adaptiveRisk = await computeAdaptiveRisk(this.sessionId, this.profile.riskPerTradePct);
      pendingKellyMultiplier = this.adaptiveRisk.kellyMultiplier;
      pendingKellyFloor = this.adaptiveRisk.kellyFloorPct;
      pendingKellyFraction = this.adaptiveRisk.kellyFraction;
      const adaptiveCap = this.adaptiveRisk.preKellyRiskPct ?? this.adaptiveRisk.riskPct;
      if (adaptiveCap != null && adaptiveCap + 1e-6 < dynamicRiskPct) {
        recordOpsEvent({
          level: 'watch',
          source: 'risk_engine',
          message: 'adaptive_risk_capped',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            cappedRiskPct: adaptiveCap,
            sharpe: this.adaptiveRisk.weightedSharpe,
            sampleSize: this.adaptiveRisk.sampleSize,
            winRate: this.adaptiveRisk.winRate,
          },
        });
        dynamicRiskPct = adaptiveCap;
      }
    } catch {
      this.adaptiveRisk = null;
    }
    dynamicRiskPct = await this.applyDailyRoiThrottle(dynamicRiskPct);
    const memeGuard = this.isMemeCoin(this.profile?.symbol);
    if (memeGuard) {
      const memeMultiplier = 0.65;
      dynamicRiskPct *= memeMultiplier;
      recordOpsEvent({
        level: 'watch',
        source: 'position_sizing',
        message: 'meme_coin_risk_cap',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { memeMultiplier },
      });
    }
    if (this.profile.mode === 'live') {
      const pressure = getCapacityPressure(this.profile.symbol);
      if (pressure > 0) {
        const reduction = Math.min(0.5, 0.2 * pressure);
        dynamicRiskPct *= (1 - reduction);
      }
    }
    if (planRiskMinPct != null) dynamicRiskPct = Math.max(planRiskMinPct, dynamicRiskPct);
    if (planRiskMaxPct != null) dynamicRiskPct = Math.min(planRiskMaxPct, dynamicRiskPct);
    if (this.adaptiveRisk) this.adaptiveRisk = { ...this.adaptiveRisk, riskPct: dynamicRiskPct };

    if (regimeRisk && regimeRisk.level === 'caution') {
      recordOpsEvent({
        level: 'info',
        source: 'regime_risk_modifier',
        message: regimeRisk.reason,
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          sizingMultiplier: regimeRisk.sizingMultiplier,
          stopMultiplier: regimeRisk.stopMultiplier,
        },
      });
    }

    if (regimeRisk?.sizingMultiplier != null && Number.isFinite(regimeRisk.sizingMultiplier)) {
      const clamp = Math.max(0.05, Math.min(1, regimeRisk.sizingMultiplier));
      dynamicRiskPct *= clamp;
    }

    const circuitSizeMultiplier = this.circuitBreaker.sizeMultiplier();
    if (circuitSizeMultiplier !== 1) {
      dynamicRiskPct *= circuitSizeMultiplier;
      recordOpsEvent({
        level: 'watch',
        source: 'circuit_breaker',
        message: circuitSizeMultiplier < 1 ? 'size_reduced_due_to_losses' : 'size_increased_due_to_wins',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          multiplier: circuitSizeMultiplier,
          adjustedRiskPct: dynamicRiskPct,
        },
      });
    }
    if (planRiskMaxPct != null) {
      dynamicRiskPct = Math.min(dynamicRiskPct, planRiskMaxPct);
    }

    if (usingBreakoutEntry) {
      const adxValue = Number((snap as any)?.adx14 ?? validationSnap.adx14 ?? 0);
      let breakoutSizeMultiplier = 0.8;
      if (adxValue >= 35) breakoutSizeMultiplier = 0.85;
      else if (adxValue >= 25) breakoutSizeMultiplier = 0.82;
      else breakoutSizeMultiplier = 0.78;
      breakoutSizeMultiplier = Math.max(0.75, Math.min(0.85, breakoutSizeMultiplier));
      dynamicRiskPct *= breakoutSizeMultiplier;
      recordOpsEvent({
        level: 'watch',
        source: 'position_sizing',
        message: 'breakout_size_adjustment',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          breakoutSizeMultiplier,
          adx: adxValue,
          breakoutDistancePct: breakoutDistanceValidation,
        },
      });
    }

    if (pendingKellyMultiplier !== 1 || pendingKellyFloor > 0) {
      const beforeKelly = dynamicRiskPct;
      const multiplier = Math.max(0, pendingKellyMultiplier);
      const applied = Math.max(pendingKellyFloor, beforeKelly * multiplier);
      if (applied + 1e-6 < beforeKelly) {
        recordOpsEvent({
          level: 'watch',
          source: 'risk_engine',
          message: 'kelly_fraction_applied',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            beforeKelly,
            appliedRiskPct: applied,
            multiplier,
            floorPct: pendingKellyFloor,
            fraction: pendingKellyFraction,
          },
        });
      }
      dynamicRiskPct = Math.max(pendingKellyFloor > 0 ? pendingKellyFloor : 0, Math.min(beforeKelly, applied));
    }

    const stopDistanceAbs = Math.abs(entry - stop);
    const stopPct = entry > 0 ? (stopDistanceAbs / entry) * 100 : 0;
    const tp1Price = Array.isArray(tp) && tp.length > 0
      ? tp[0]
      : (this.plan.rPrices?.[0]?.price ?? null);
    const tp1DistanceAbs = tp1Price != null && Number.isFinite(tp1Price)
      ? Math.abs(tp1Price - entry)
      : null;
    const tp1RMultiple = (() => {
      const raw = this.plan.rPrices?.[0]?.r;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw;
      }
      if (tp1DistanceAbs != null && tp1DistanceAbs > 0 && stopDistanceAbs > 0) {
        return tp1DistanceAbs / stopDistanceAbs;
      }
      return null;
    })();
    const quantSizerResult = this.positionSizer.computeSize({
      equityUsd: Math.max(this.lastKnownEquityUsd, usableBalance),
      entryPrice: entry,
      stopPrice: stop,
      stopDistanceAbs,
      riskPct: dynamicRiskPct,
      qualityMultiplier,
      maxNotionalUsd: Number.isFinite(this.maxNotionalCapUsd) && this.maxNotionalCapUsd > 0
        ? this.maxNotionalCapUsd
        : undefined,
    });

    // Compute requested size
    let notional = 0;
    // Determine effective leverage for this trade (risk-aware if enabled)
    const profileMaxLev = Math.max(1, this.profile.maxLeverage || 1);
    let baseLev = profileMaxLev;
    const appliedCaps: Array<{ source: string; cap: number; reason?: string | null; riskLevel?: string }> = [];

    const planCapRaw = Number(this.plan?.sizing?.maxLev);
    if (Number.isFinite(planCapRaw) && planCapRaw > 0) {
      const planCap = Math.max(1, Math.min(10, planCapRaw));
      baseLev = Math.min(baseLev, planCap);
      if (planCap < profileMaxLev - 1e-6) {
        appliedCaps.push({ source: 'plan_max_leverage', cap: planCap });
      }
    }

    const planAtr = this.plan?.atrPct;
    const guardAtr = Number.isFinite(planAtr)
      ? Number(planAtr)
      : Number.isFinite(snap?.atrPct) ? Number(snap?.atrPct) : undefined;
    const volatilityTag = (this.plan?.plan.meta as any)?.volatility || (this.regime as any)?.volatility || null;
    const guardInfo = computeLeverageGuardForSymbol({
      symbol: this.profile.symbol,
      atrPct: guardAtr,
      volatilityTag: typeof volatilityTag === 'string' ? volatilityTag : null,
    });

    if (guardInfo.cap != null) {
      const guardCap = Math.max(1, Math.min(10, guardInfo.cap));
      baseLev = Math.min(baseLev, guardCap);
      if (guardCap < profileMaxLev - 1e-6 || guardCap < planCapRaw - 1e-6) {
        appliedCaps.push({
          source: 'volatility_guard',
          cap: guardCap,
          reason: guardInfo.reason,
          riskLevel: guardInfo.riskLevel,
        });
      }
    }

    if (appliedCaps.length) {
      recordOpsEvent({
        level: appliedCaps.some(c => c.riskLevel === 'extreme') ? 'warn' : 'info',
        source: 'leverage_guard',
        message: 'volatility_guard_applied',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          profileMaxLeverage: profileMaxLev,
          appliedCaps,
          finalCap: baseLev,
        },
      });
      if (this.plan) {
        this.plan.sizing.maxLev = baseLev;
        if (guardInfo.cap != null) {
          const meta = { ...(this.plan.plan.meta || {}) } as any;
          meta.leverageGuard = {
            cap: baseLev,
            reason: guardInfo.reason,
            riskLevel: guardInfo.riskLevel,
          };
          this.plan.plan.meta = meta;
        }
      }
    }

    const dynLevEnabled = this.profile.dynamicLeverage !== false; // default true
    let minLevCfg = Math.max(1, Number(this.profile.minLeverage || 1));
    if (targetSizingEnabled && stopPct <= 1.05 && dynamicRiskPct <= 2.05) {
      minLevCfg = Math.max(minLevCfg, 2);
    }
    const spreadLimitBps = this.quantConfig?.filters?.maxSpreadBps ?? 16;
    const spreadIsOk = spreadBps == null || spreadBps <= spreadLimitBps;
    const adxNow = Number((snap as any)?.adx14 ?? validationSnap.adx14 ?? 0);
    const atrPctForLev = typeof guardAtr === 'number' ? guardAtr : undefined;
    const volatilityHigh = atrPctForLev != null && atrPctForLev > 2.5;
    const atrWindowOk = atrPctForLev != null && atrPctForLev >= 0.7 && atrPctForLev <= 2.5;
    const rrWeightedOk = typeof rrWeighted === 'number' ? rrWeighted >= 0.9 : false;
    const supportiveRegime = Boolean(this.regime?.shouldTrade !== false && (this.regime?.playbook || '') !== 'standby');
    const favourableLeverageSetup = dynLevEnabled && supportiveRegime && atrWindowOk && adxNow >= 25 && spreadIsOk && rrWeightedOk;
    const utilisationForCap = marginAdvisor.utilisationPct();
    const allowLeverageBoost = !volatilityHigh && (guardInfo?.riskLevel ?? null) !== 'extreme';
    const dynamicPreferredCap = (() => {
      const baseCap = 3;
      if (!allowLeverageBoost) return baseCap;
      let bonus = 0;
      if (utilisationForCap < 40) bonus += 2;
      else if (utilisationForCap < 55) bonus += 1;
      if (strongMomentumStopEligible && rrWeightedOk) bonus += 1;
      return Math.min(7, baseCap + bonus);
    })();
    if (favourableLeverageSetup) {
      const appliedCap = Math.min(baseLev, dynamicPreferredCap);
      baseLev = appliedCap;
      recordOpsEvent({
        level: 'info',
        source: 'leverage_guard',
        message: 'favourable_leverage_window',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          atrPct: atrPctForLev,
          adx: adxNow,
          spreadIsOk,
          rrWeightedOk,
          utilisation: utilisationForCap,
          cap: appliedCap,
          dynamicPreferredCap,
          allowLeverageBoost,
        },
      });
    } else {
      const fallbackCap = Math.max(3, dynamicPreferredCap);
      const floorCap = Math.min(baseLev, Math.max(minLevCfg, 2));
      baseLev = Math.max(Math.min(baseLev, fallbackCap), floorCap);
      if (fallbackCap > 3 && allowLeverageBoost) {
        recordOpsEvent({
          level: 'watch',
          source: 'leverage_guard',
          message: 'dynamic_leverage_boost_applied',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            utilisation: utilisationForCap,
            fallbackCap,
            floorCap,
            rrWeightedOk,
            strongMomentumStopEligible,
            dynamicPreferredCap,
            allowLeverageBoost,
          },
        });
      }
    }
    const levGuard = volatilityHigh ? Math.min(baseLev, 3) : baseLev;
    let effectiveLev = Math.max(Math.min(levGuard, baseLev), Math.min(levGuard, Math.max(minLevCfg, 1)));
    if (dynLevEnabled) {
      const safeBase = Math.max(baseLev, 1);
      const minFactor = Math.min(1, Math.max(minLevCfg, 1) / safeBase);
      const qualityForLev = Math.max(0.8, Math.min(1.5, qualityMultiplier));
      const qNorm = (qualityForLev - 0.8) / (1.5 - 0.8);
      const qualFactor = minFactor + (1 - minFactor) * Math.max(0, Math.min(1, qNorm));
      const stopFactor = stopPct > 2.5 ? Math.max(0.6, 1 - (stopPct - 2.5) / 7.5) : 1;
      const baseRisk = Math.max(1e-6, this.profile.riskPerTradePct);
      const riskFactor = Math.max(0.5, Math.min(1.1, dynamicRiskPct / baseRisk));
      const scaled = safeBase * qualFactor * stopFactor * riskFactor;
      effectiveLev = Math.max(Math.min(levGuard, scaled), Math.min(levGuard, Math.max(minLevCfg, 1)));
    }
    const sizingCfg = getConfig();
    const defaultSizing = (sizingCfg.SIZING_DEFAULT_MODE === 'risk' ? 'risk' : 'budget');
    const sizingMode = (this.profile.sizingMode || defaultSizing);
    let minPnLTargetWarning: Record<string, unknown> | null = null;
    const sizing = await computeQtyNotional({
      balanceUsd: usableBalance,
      riskPct: dynamicRiskPct,
      stopDistanceAbs,
      entryPrice: entry,
      requestedLeverage: effectiveLev,
      symbol: this.profile.symbol,
      mode: this.profile.mode,
      leverageCap: this.profile.leverageCap,
      tp1DistanceAbs,
      minTp1PnlUsd: targetSizingEnabled ? targetMinTp1PnlUsd : undefined,
      tp1RMultiple,
    });
    if (targetSizingEnabled && !sizing.meetsMinPnLTarget && targetMinTp1PnlUsd > 0) {
      minPnLTargetWarning = {
        desiredNotional: sizing.desiredNotional,
        allowedNotional: sizing.notional,
        minPnLNotional: sizing.minPnLNotional,
        targetMinTp1PnlUsd,
      };
      recordOpsEvent({
        level: 'watch',
        source: 'position_sizing',
        message: 'min_pnl_target_warning',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: minPnLTargetWarning,
      });
    }
    this.profile.leverageCap = sizing.leverageCap;
    effectiveLev = Math.min(effectiveLev, sizing.leverageCap.resolved);
    if (sizingMode === 'budget') {
      // Budget-based sizing: use budget allocation times effective leverage (respect resolved cap)
      notional = Math.max(0, usableBalance * effectiveLev);
    } else {
      // Risk-based sizing: cap by effective leverage, not maximum
      notional = sizing.notional;
    }
    if (sizingMode === 'risk' && quantSizerResult.notionalUsd > 0 && notional > 0) {
      const quantNotional = quantSizerResult.notionalUsd;
      if (quantNotional < notional) {
        recordOpsEvent({
          level: 'info',
          source: 'position_sizing',
          message: 'quantai_risk_cap_applied',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            requestedNotional: notional,
            quantNotional,
          },
        });
        notional = quantNotional;
      }
    }

    const requestedNotionalBeforeCaps = notional;
    const sizingSnapshot: AccountSnapshot = {
      equityUsd: Number.isFinite(bal?.equityUsd) ? Number(bal?.equityUsd) : null,
      freeUsd: Number.isFinite(bal?.freeUsd) ? Number(bal?.freeUsd) : null,
      committedUsd: Number.isFinite(bal?.committedUsd) ? Number(bal?.committedUsd) : null,
      availableMarginUsd: availableMargin,
      budgetCapUsd: capBalance,
      usableBalanceUsd: usableBalance,
      requestedNotionalUsd: requestedNotionalBeforeCaps,
    };

    const marginEquity = marginAdvisor.equityUsd();
    const freeCapAtGuard = marginAdvisor.maxAdditionalNotionalAt(levGuard);
    const notionalCapByLev = marginEquity > 0 ? marginEquity * levGuard : 0;
    const dynamicNotionalCap = Math.max(0, Math.min(notionalCapByLev > 0 ? notionalCapByLev : Infinity, freeCapAtGuard > 0 ? freeCapAtGuard : Infinity));
    if (dynamicNotionalCap > 0 && notional > dynamicNotionalCap) {
      recordOpsEvent({
        level: 'info',
        source: 'position_sizing',
        message: 'dynamic_notional_cap',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          requestedNotional: notional,
          cap: dynamicNotionalCap,
          levGuard,
          marginEquity,
          freeCapAtGuard,
        },
      });
      notional = dynamicNotionalCap;
    }
    
    const configMinNotional = Number(getConfig().MIN_ORDER_NOTIONAL_USD || 0);
    const equityFloor = bal.equityUsd * 0.005;
    const dynamicFloor = Math.max(500, equityFloor);
    const minTradeNotional = Math.max(configMinNotional, dynamicFloor);
    const HALT_CRITICAL = 90;
    const HALT_TARGET = 80;
    const ENTRY_PROJ_CAP = 85;
    const FLOOR_TOLERANCE = 5;
    const FLOOR_UTIL_LIMIT = 88;

    if (notional > 0) {
      const leverageForUtil = Math.max(levGuard, 1);
      const utilNowRaw = marginAdvisor.utilisationPct();
      const utilNow = Number.isFinite(utilNowRaw) ? utilNowRaw : 0;
      const utilIf = (value: number) => marginAdvisor.utilisationPctIf(value, leverageForUtil);

      let adjustedNotional = notional;
      sizingSnapshot.finalNotionalUsd = adjustedNotional;
      let utilAfter = utilIf(adjustedNotional);
      if (utilAfter >= HALT_CRITICAL) {
        this.noteSignalDrop('margin_block', 'warn', {
          utilNow,
          utilAfter,
          entryCap: ENTRY_PROJ_CAP,
          reason: 'initial_util_above_critical',
        });
        this.entering = false;
        return;
      }

      if (adjustedNotional < minTradeNotional) {
        const utilWithFloor = utilIf(minTradeNotional);
        if (utilWithFloor <= HALT_TARGET + FLOOR_TOLERANCE && utilWithFloor < HALT_CRITICAL) {
          recordOpsEvent({
            level: 'info',
            source: 'position_sizing',
            message: 'minimum_notional_floor_enforced',
            sessionId: this.sessionId || undefined,
            symbol: this.profile.symbol,
            details: {
              previousNotional: adjustedNotional,
              newNotional: minTradeNotional,
              utilWithFloor,
              minTradeNotional,
            },
          });
          adjustedNotional = minTradeNotional;
          sizingSnapshot.finalNotionalUsd = adjustedNotional;
          utilAfter = utilWithFloor;
        } else {
          this.noteSignalDrop('min_notional_floor_block', 'info', {
            requestedNotional: adjustedNotional,
            minTradeNotional,
            utilWithFloor,
            tolerance: HALT_TARGET + FLOOR_TOLERANCE,
          });
          this.entering = false;
          return;
        }
      }

      if (utilAfter >= HALT_CRITICAL) {
        this.noteSignalDrop('margin_block', 'warn', {
          utilNow,
          utilAfter,
          entryCap: ENTRY_PROJ_CAP,
          reason: 'post_floor_util_above_critical',
        });
        this.entering = false;
        return;
      }

      if (utilAfter > ENTRY_PROJ_CAP) {
        const denom = utilAfter - utilNow;
        const scaleFactor = denom > 0 ? (ENTRY_PROJ_CAP - utilNow) / denom : 0;
        const clamp = Math.max(0, Math.min(1, scaleFactor));
        if (!(clamp > 0)) {
          this.noteSignalDrop('margin_block', 'warn', {
            utilNow,
            utilAfter,
            entryCap: ENTRY_PROJ_CAP,
            reason: 'scale_factor_non_positive',
          });
          this.entering = false;
          return;
        }
        const scaledNotional = adjustedNotional * clamp;
        const floorCandidate = Math.max(scaledNotional, minTradeNotional);
        let candidateNotional = scaledNotional;
        let floorApplied = false;
        if (floorCandidate > scaledNotional) {
          const utilFloor = utilIf(floorCandidate);
          if (utilFloor <= Math.min(FLOOR_UTIL_LIMIT, HALT_CRITICAL)) {
            candidateNotional = floorCandidate;
            floorApplied = true;
            utilAfter = utilFloor;
          }
        }
        if (!floorApplied) {
          utilAfter = utilIf(candidateNotional);
        }
        if (utilAfter >= HALT_CRITICAL) {
          this.noteSignalDrop('margin_block', 'warn', {
            utilNow,
            utilAfter,
            entryCap: ENTRY_PROJ_CAP,
            reason: 'scaled_util_above_critical',
          });
          this.entering = false;
          return;
        }
        if (candidateNotional < minTradeNotional && !floorApplied) {
          this.noteSignalDrop('min_notional_floor_block', 'info', {
            requestedNotional: adjustedNotional,
            scaledNotional,
            minTradeNotional,
            utilAfter,
          });
          this.entering = false;
          return;
        }
        recordOpsEvent({
          level: 'warn',
          source: 'margin_guard',
          message: 'margin_projection_scaled',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: {
            utilNow,
            utilBefore: utilIf(adjustedNotional),
            utilAfter,
            entryCap: ENTRY_PROJ_CAP,
            requestedNotional: adjustedNotional,
            scaledNotional: candidateNotional,
            minTradeNotional,
            floorApplied,
          },
        });
        adjustedNotional = candidateNotional;
        sizingSnapshot.finalNotionalUsd = adjustedNotional;
      }

      if (utilAfter >= HALT_CRITICAL) {
        this.noteSignalDrop('margin_block', 'warn', {
          utilNow,
          utilAfter,
          entryCap: ENTRY_PROJ_CAP,
          reason: 'final_util_above_critical',
        });
        this.entering = false;
        return;
      }

      const maxAdditional = marginAdvisor.maxAdditionalNotionalAt(leverageForUtil);
      const freeCapRatio = adjustedNotional > 0 ? maxAdditional / adjustedNotional : 1;
      const marginClamp = Math.min(1, Math.max(0, freeCapRatio));
      if (marginClamp <= 0) {
        this.noteSignalDrop('margin_capacity_block', 'warn', {
          reason: 'insufficient_free_margin',
          leverage: effectiveLev,
          utilisationPct: utilNow,
        });
        this.entering = false;
        return;
      }
      if (marginClamp < 1) {
        const scaledNotional = adjustedNotional * marginClamp;
        if (scaledNotional < minTradeNotional) {
          this.noteSignalDrop('min_notional_floor_block', 'info', {
            requestedNotional: adjustedNotional,
            scaledNotional,
            minTradeNotional,
            utilAfter: utilIf(scaledNotional),
          });
          this.entering = false;
          return;
        }
        adjustedNotional = scaledNotional;
        utilAfter = utilIf(adjustedNotional);
        recordOpsEvent({
          level: 'warn',
          source: 'margin_guard',
          message: 'margin_capacity_scaled',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: {
            requestedNotional: notional,
            allowedNotional: adjustedNotional,
            leverage: effectiveLev,
            utilisationPct: utilAfter,
            ratio: marginClamp,
          },
        });
        sizingSnapshot.finalNotionalUsd = adjustedNotional;
      }

      notional = adjustedNotional;
    }

    let qty = notional / Math.max(entry, 1e-8);

    const equityCapNotional = Math.max(0, bal.equityUsd * (effectiveLev || 1));
    const budgetCapNotional = Math.max(0, capBalance * (effectiveLev || 1));
    const hardNotionalCap = Math.min(equityCapNotional || Infinity, budgetCapNotional || Infinity);
    const configuredCapNotional = Number.isFinite(this.maxNotionalCapUsd) && this.maxNotionalCapUsd > 0
      ? this.maxNotionalCapUsd
      : Infinity;
    const effectiveNotionalCap = Math.min(
      hardNotionalCap > 0 ? hardNotionalCap : Infinity,
      configuredCapNotional > 0 ? configuredCapNotional : Infinity,
    );

    if (Number.isFinite(effectiveNotionalCap) && effectiveNotionalCap > 0 && notional > effectiveNotionalCap) {
      const cappedQty = effectiveNotionalCap / Math.max(entry, 1e-8);
      recordOpsEvent({
        level: 'warn',
        source: 'position_sizing',
        message: 'leverage_cap_applied',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          requestedNotional: notional,
          cappedNotional: effectiveNotionalCap,
          requestedQty: qty,
          cappedQty,
          equityUsd: bal.equityUsd,
          maxLeverage: this.profile.maxLeverage,
          startBalanceUsd: this.profile.startBalanceUsd,
          configuredCapNotional,
        },
      });
      qty = cappedQty;
      sizingSnapshot.finalNotionalUsd = effectiveNotionalCap;
    }
    // Optionally estimate fillable quantity (liquidity guard)
    const useLiqGuard = this.profile.liquidityGuard !== false; // default true
    if (useLiqGuard && typeof (this.broker as any)?.estimateFillableQty === 'function') {
      try {
        const cfg = getConfig();
        const maxImpact = this.profile.mode === 'live' ? cfg.ORDER_MAX_IMPACT_PCT : cfg.PAPER_MAX_IMPACT_PCT;
        const estimate = await (this.broker as any).estimateFillableQty({ symbol: this.profile.symbol, side, desiredQty: qty, maxImpactPct: maxImpact });
        if (estimate?.fillableQty != null) {
          if (estimate.fillableQty < qty) {
            const reductionNote = `Liquidity limit reduced qty from ${qty.toFixed(6)} to ${estimate.fillableQty.toFixed(6)} (impact ${(estimate.impactPct ?? 0).toFixed(2)}%).`;
            const planJson = this.plan.plan;
            planJson.notes = planJson.notes ? `${planJson.notes}\n${reductionNote}` : reductionNote;
            recordOpsEvent({
              level: 'info',
              source: 'liquidity_guard',
              message: 'qty_reduced_due_to_impact',
              sessionId: this.sessionId || undefined,
              symbol: this.profile.symbol,
              details: { requestedQty: qty, fillableQty: estimate.fillableQty, impactPct: estimate.impactPct }
            });
          }
          qty = estimate.fillableQty;
          if (estimate.minQty != null && qty < estimate.minQty) {
            this.noteSignalDrop('liquidity_min_qty_block', 'info', {
              requestedQty: qty,
              minQty: estimate.minQty,
            });
            this.entering = false;
            return;
          }
        }
      } catch {}
    }
    const minNotional = minTradeNotional;
    if (!(qty > 0)) {
      this.noteSignalDrop('position_size_non_positive', 'warn', { qty, entry, minNotional });
      this.entering = false;
      return;
    }
    const currentNotional = qty * entry;
    if (currentNotional + 1e-6 < minNotional) {
      const adjustedQty = minNotional / Math.max(entry, 1e-8);
      const utilWithAdjust = marginAdvisor.utilisationPctIf(minNotional, Math.max(effectiveLev, 1));
      if (utilWithAdjust <= HALT_TARGET + FLOOR_TOLERANCE && utilWithAdjust < HALT_CRITICAL) {
        this.noteSignalDrop('position_size_bumped_to_min_notional', 'info', {
          previousQty: qty,
          previousNotional: currentNotional,
          minNotional,
          adjustedQty,
          utilWithAdjust,
        });
        qty = adjustedQty;
        notional = qty * entry;
        sizingSnapshot.finalNotionalUsd = notional;
      } else {
        this.noteSignalDrop('min_notional_floor_block', 'info', {
          currentNotional,
          minNotional,
          utilWithAdjust,
        });
        this.entering = false;
        return;
      }
    }

    const sizingFloorUsd = 30;
    if (sizingFloorUsd > 0 && entry > 0) {
      const notionalAfterFloors = qty * entry;
      if (notionalAfterFloors + 1e-6 < sizingFloorUsd) {
        const floorQty = sizingFloorUsd / Math.max(entry, 1e-8);
        const utilWithFloor = marginAdvisor.utilisationPctIf(sizingFloorUsd, Math.max(effectiveLev, 1));
        if (utilWithFloor <= HALT_TARGET + FLOOR_TOLERANCE && utilWithFloor < HALT_CRITICAL) {
          const previousQty = qty;
          const previousNotional = notionalAfterFloors;
          qty = floorQty;
          notional = qty * entry;
          sizingSnapshot.finalNotionalUsd = notional;
          recordOpsEvent({
            level: 'info',
            source: 'position_sizing',
            message: 'floor-bumped',
            sessionId: this.sessionId || undefined,
            symbol: this.profile.symbol,
            details: {
              previousQty,
              previousNotional,
              floorNotional: sizingFloorUsd,
              adjustedQty: qty,
              adjustedNotional: notional,
              utilisationPct: utilWithFloor,
            },
          });
        } else {
          this.noteSignalDrop('sizing_floor_block', 'info', {
            previousNotional: notionalAfterFloors,
            floorNotional: sizingFloorUsd,
            utilisationPct: utilWithFloor,
          });
          this.entering = false;
          return;
        }
      }
    }

    sizingSnapshot.finalNotionalUsd = qty * entry;

    recordOpsEvent({
      level: 'info',
      source: 'position_sizing',
      message: 'pre_entry_sizing_snapshot',
      sessionId: this.sessionId || undefined,
      symbol: this.profile.symbol,
      details: {
        riskPct: dynamicRiskPct,
        stopPct,
        effectiveLeverage: effectiveLev,
        budgetFraction: budgetFrac,
        snapshot: sizingSnapshot,
      },
    });

    const tp1ForEv = tp.length > 0 ? tp[0] : this.plan.rPrices?.[0]?.price ?? null;
    if (tp1ForEv != null && Number.isFinite(tp1ForEv)) {
      const dir = side === 'buy' ? 1 : -1;
      const priceDiff = dir * (tp1ForEv - entry);
      const expectedPnL1 = qty > 0 && priceDiff > 0 ? qty * priceDiff : 0;
      const minExpectedTp1Pnl = targetSizingEnabled && targetMinTp1PnlUsd > 0 ? targetMinTp1PnlUsd : 3;
      if (expectedPnL1 + 1e-6 < minExpectedTp1Pnl) {
        const notionalUsd = qty * entry;
        const tp1PctDist = entry > 0 ? Math.abs((tp1ForEv - entry) / entry) * 100 : null;
        this.logEntryDecision('SKIP', {
          reason: 'ev_dollar_below_min',
          side,
          qty,
          notionalUsd,
          leverage: Math.max(1, effectiveLev),
          rr: tp1RMultiple ?? null,
          adx: Number.isFinite(adxValue) ? adxValue : null,
          atrPct: typeof entryZoneMeta?.atrPct === 'number' ? entryZoneMeta.atrPct : null,
          tp1Pct: tp1PctDist,
          level: 'warn',
        }, {
          decision_pipeline: {
            requestedQty: quantSizerResult.rawQty,
            finalQty: qty,
            caps: {
              preferred: profileMaxLev,
              guards: appliedCaps,
              volatilityGuard: guardInfo.cap ?? null,
              final: effectiveLev,
            },
            minNotional,
            minFloorUsd: sizingFloorUsd,
            expectedPnL1,
            evThresholdUsd: minExpectedTp1Pnl,
            warnings: {
              minPnLTarget: minPnLTargetWarning,
            },
          },
          market: {
            entry,
            tp1: tp1ForEv,
            stop,
            spreadBps,
            adx: adxValue,
            atrPct: entryZoneMeta?.atrPct ?? null,
          },
        });
        this.entering = false;
        return;
      }
    }

    marketTicker = await getTicker(this.profile.symbol).catch(() => null as any);
    spreadBps = marketTicker?.bid && marketTicker?.ask
      ? ((marketTicker.ask - marketTicker.bid) / ((marketTicker.ask + marketTicker.bid) / 2)) * 10_000
      : spreadBps;
    let notionalUsd = qty * entry;
    if (notionalUsd > 0) {
      const marginCfg = getConfig();
      const criticalCandidate = Number(marginCfg.MARGIN_UTIL_CRITICAL_PCT);
      const critical = Number.isFinite(criticalCandidate) && criticalCandidate > 0 ? criticalCandidate : 75;
      const targetCandidate = Number(marginCfg.MARGIN_UTIL_TARGET_PCT);
      const target = Number.isFinite(targetCandidate)
        ? Math.max(0, Math.min(critical, targetCandidate))
        : Math.min(critical, 62);
      const bufferCandidate = Number(marginCfg.MARGIN_UTIL_BUFFER_PCT);
      const buffer = Number.isFinite(bufferCandidate)
        ? Math.max(0, bufferCandidate)
        : 2;
      const capUtil = Math.max(0, Math.min(critical - buffer, target));
      const utilNowRaw = marginAdvisor.utilisationPct();
      const utilAfterRaw = marginAdvisor.utilisationPctIf(notionalUsd, effectiveLev);
      const utilNow = Number.isFinite(utilNowRaw) ? utilNowRaw : 0;
      const utilAfter = Number.isFinite(utilAfterRaw) ? utilAfterRaw : utilNow;
      if (capUtil <= 0 || utilNow >= capUtil) {
        this.noteSignalDrop('margin_projection_block', 'warn', {
          utilNow,
          utilNowRaw,
          utilAfter,
          utilAfterRaw,
          critical,
          capUtil,
          target,
          buffer,
          reason: 'target_reached',
          requestedNotional: notionalUsd,
          effectiveLeverage: effectiveLev,
        });
        this.entering = false;
        return;
      }
      if (utilAfter > capUtil) {
        const denom = utilAfter - utilNow;
        const scaleRaw = denom > 0 ? (capUtil - utilNow) / denom : 0;
        const minScaleCandidate = Number(marginCfg.MARGIN_PROJECTION_MIN_SCALE);
        const minScale = Number.isFinite(minScaleCandidate)
          ? Math.max(0, Math.min(1, minScaleCandidate))
          : 0.15;
        const clamp = Math.max(0, Math.min(1, scaleRaw));
        if (clamp > minScale) {
          const requestedNotional = notionalUsd;
          const adjustedNotional = requestedNotional * clamp;
          qty = adjustedNotional / Math.max(entry, 1e-8);
          notional = adjustedNotional;
          notionalUsd = adjustedNotional;
          recordOpsEvent({
            level: 'warn',
            source: 'margin_guard',
            message: 'margin_projection_scaled',
            sessionId: this.sessionId || undefined,
            symbol: this.profile?.symbol,
            details: {
              utilNow,
              utilNowRaw,
              utilAfter,
              utilAfterRaw,
              critical,
              target,
              buffer,
              capUtil,
              scale: clamp,
              minScale,
              requestedNotional,
              adjustedNotional,
            },
          });
        } else {
          this.noteSignalDrop('margin_projection_block', 'warn', {
            utilNow,
            utilNowRaw,
            utilAfter,
            utilAfterRaw,
            critical,
            capUtil,
            target,
            buffer,
            minScale,
            scale: clamp,
            reason: 'scale_below_threshold',
            requestedNotional: notionalUsd,
            effectiveLeverage: effectiveLev,
          });
          this.entering = false;
          return;
        }
      }
    }
    const finalNotionalUsd = qty * entry;
    const utilAfterFinal = marginAdvisor.utilisationPctIf(finalNotionalUsd, Math.max(effectiveLev, 1));
    const tpPct = (price: number | undefined) => (price != null && entry > 0 ? Math.abs(price - entry) / entry * 100 : undefined);
    const tp1Pct = tpPct(tp[0]);
    const tp2Pct = tpPct(tp[1]);
    const volGuardCap = guardInfo.cap != null && Number.isFinite(guardInfo.cap)
      ? guardInfo.cap.toFixed(2)
      : '∞';
    const freeCapDisplay = Number.isFinite(freeCapAtGuard) ? freeCapAtGuard.toFixed(2) : '∞';
    const concentrationCap = Number.isFinite(this.maxNotionalCapUsd) && (this.maxNotionalCapUsd ?? 0) > 0
      ? (this.maxNotionalCapUsd as number).toFixed(2)
      : '∞';
    const sizingLogParts = [
      `equity=${bal.equityUsd.toFixed(2)}`,
      `risk%=${dynamicRiskPct.toFixed(3)}`,
      `riskUsd=${quantSizerResult.riskUsd.toFixed(2)}`,
      `stop=${stop.toFixed(4)}/${stopPct.toFixed(2)}%`,
      `qty_desired=${quantSizerResult.rawQty.toFixed(6)}`,
      `caps={volGuard:${volGuardCap},maxLev:${effectiveLev.toFixed(2)},freeCap:${freeCapDisplay},concentration:${concentrationCap}}`,
      `final_qty=${qty.toFixed(6)}`,
      `notional=${finalNotionalUsd.toFixed(2)}`,
      `util_after=${utilAfterFinal.toFixed(2)}%`,
      `TP1%=${tp1Pct != null ? tp1Pct.toFixed(2) : 'n/a'}`,
      `TP2%=${tp2Pct != null ? tp2Pct.toFixed(2) : 'n/a'}`,
      `trail=ATRx${this.quantConfig.exits.trailAtrMult.toFixed(2)}`,
    ];
    recordOpsEvent({
      level: 'debug',
      source: 'position_sizing',
      message: 'sizing_breakdown',
      sessionId: this.sessionId || undefined,
      symbol: this.profile.symbol,
      details: {
        log: sizingLogParts.join(', '),
        requestedNotional: requestedNotionalBeforeCaps,
        finalNotional: finalNotionalUsd,
        qualityMultiplier,
      },
    });

    this.logEntryDecision('ENTER', {
      reason: 'enter',
      side,
      qty,
      notionalUsd: finalNotionalUsd,
      leverage: Math.max(1, effectiveLev),
      rr: tp1RMultiple ?? null,
      adx: Number.isFinite(adxValue) ? adxValue : null,
      atrPct: typeof entryZoneMeta?.atrPct === 'number' ? entryZoneMeta.atrPct : null,
      tp1Pct: tp1Pct ?? null,
      level: 'info',
    }, {
      decision_pipeline: {
        requestedQty: quantSizerResult.rawQty,
        finalQty: qty,
        caps: {
          preferred: profileMaxLev,
          guards: appliedCaps,
          volatilityGuard: guardInfo.cap ?? null,
          final: effectiveLev,
        },
        minNotional,
        minFloorUsd: sizingFloorUsd,
        expectedPnL1: tp1Pct != null && entry > 0 ? qty * entry * (tp1Pct / 100) : null,
        warnings: {
          minPnLTarget: minPnLTargetWarning,
        },
      },
      market: {
        entry,
        tp,
        stop,
        spreadBps,
        adx: adxValue,
        atrPct: entryZoneMeta?.atrPct ?? null,
      },
    });

    const confirmationMeta = this.lastConfirmationSnapshot?.meta;
    const confirmationUrgent = confirmationMeta?.confirmationMode === 'timeout';
    const plan = chooseExecutionPlan({
      symbol: this.profile.symbol,
      side,
      qty,
      notionalUsd,
      entryPrice: entry,
      ticker: marketTicker || undefined,
      atrPct: Number((snap as any)?.atrPct ?? null),
      spreadBps,
      volatilityProfile: (snap as any)?.volatilityProfile ?? this.regime?.volatilityProfile ?? null,
      playbook,
      volumeRatio: typeof volumeRatio === 'number' ? volumeRatio : null,
      confirmationUrgent,
    });
    const estimatedSlippagePct = (() => {
      if (plan.mode === 'market') {
        return spreadBps != null ? (spreadBps / 2) / 100 : 0.05;
      }
      if (plan.mode === 'limit') {
        const offset = plan.passiveOffsetBps ?? 0;
        return Math.max(0, offset / 100);
      }
      return spreadBps != null ? Math.min(0.1, spreadBps / 100) : 0.05;
    })();
    const slippageBudgetCandidates: number[] = [];
    if (firstTpProfitPct != null && Number.isFinite(firstTpProfitPct) && firstTpProfitPct > 0) {
      slippageBudgetCandidates.push(firstTpProfitPct * 0.25);
    }
    if (atrBaselinePct != null && Number.isFinite(atrBaselinePct) && atrBaselinePct > 0) {
      slippageBudgetCandidates.push(atrBaselinePct * 0.15);
    }
    const slippageBudgetPct = slippageBudgetCandidates.length > 0
      ? Math.min(...slippageBudgetCandidates)
      : null;
    if (slippageBudgetPct != null && Number.isFinite(slippageBudgetPct) && estimatedSlippagePct > slippageBudgetPct + 1e-6) {
      recordOpsEvent({
        level: 'info',
        source: 'execution',
        message: 'slippage_budget_exceeded',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          estimatedSlippagePct: Number(estimatedSlippagePct.toFixed(4)),
          slippageBudgetPct: Number(slippageBudgetPct.toFixed(4)),
          spreadBps,
          tp1Pct,
          atrBaselinePct,
          mode: plan.mode,
        },
      });
      this.noteSignalDrop('slippage_budget_block', 'info', {
        estimatedSlippagePct,
        slippageBudgetPct,
        spreadBps,
        tp1Pct,
      });
      this.entering = false;
      return;
    }
    const startTs = Date.now();

    if (plan.mode !== 'market' || plan.fallbacks.length > 0) {
      recordOpsEvent({
        level: 'info',
        source: 'execution',
        message: `plan_${plan.mode}`,
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          reason: plan.reason,
          spreadBps,
          qty,
          notional: notionalUsd,
          playbook,
          fallbacks: plan.fallbacks.length,
        },
      });
    }

    const attemptIndex = this.orderAttemptLogCount + 1;
    const attemptDetails = {
      attempt: attemptIndex,
      executionMode: plan.mode,
      side,
      qty,
      notional: notionalUsd,
      leverage: effectiveLev,
      entry,
      stop,
      takeProfit: tp[0],
      planReason: plan.reason,
      spreadBps,
    };
    this.orderAttemptLogCount = attemptIndex;
    if (attemptIndex <= 10) {
      recordOpsEvent({
        level: 'info',
        source: 'order_attempt',
        message: 'order_attempt',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: attemptDetails,
      });
    }

    let placed: PlacedOrder | null = null;
    try {
      placed = await this.executeWithPlan(plan, {
        side,
        qty,
        stop,
        tp,
        entry,
        leverage: effectiveLev,
        ticker: marketTicker || undefined,
      });
      if (!placed) {
        throw new Error('execution_plan_failed');
      }
    } catch (error) {
      this.noteSignalDrop('order_attempt_failed', 'warn', {
        executionMode: plan.mode,
        qty,
        error: String((error as any)?.message || error),
        attempt: attemptIndex,
      });
      this.entering = false;
      throw error;
    }

    if (!placed || placed.status === 'rejected' || !placed.filledQty || placed.filledQty <= 0) {
      this.noteSignalDrop('order_rejected', 'warn', {
        status: placed?.status || 'unknown',
        requestedQty: qty,
        executionMode: plan.mode,
      });
      this.state = 'COOLDOWN';
      broadcast('agent_state', { state: this.state, reason: 'execution_failed' }, this.profile.symbol, this.sessionId || undefined);
      this.entering = false;
      return;
    }

    const telemetry = this.computeTelemetry(startTs, placed, { expectedPrice: entry, requestedQty: qty, side });
    const openedAt = Date.now();
    const executionPrice = placed.avgPrice ?? entry;
    sizingSnapshot.filledNotionalUsd = (placed.avgPrice ?? entry) * placed.filledQty;
    const initialStopDistance = Math.max(1e-12,
      Math.abs(executionPrice - stop) || Math.abs(entry - stop) || Math.abs(this.plan.stopDistance));
    this.pos = {
      side,
      entry: executionPrice,
      qty: placed.filledQty,
      stop,
      tp,
      openedAt,
      extended: false,
      partialTaken: false,
      slOrderId: (placed as any).slOrderId,
      tpOrderId: (placed as any).tpOrderId,
      trail: [{ ts: openedAt, price: stop }],
      maeR: 0,
      mfeR: 0,
      breakeven: executionPrice,
      partialInfo: null,
      initialStopDistance,
      hitTargets: [],
      archetype: quantArchetype,
      tp1Fraction: planAny._tp1Fraction ?? 0.3,
      flowSnapshot: planAny._flowSnapshot ?? null,
      initialQty: placed.filledQty,
      initialNotional: placed.filledQty * executionPrice,
      addOnFilledQty: 0,
      scaleInTriggered: false,
      trailConfig: {
        mode: 'atr',
        multiplier: this.quantConfig.exits.trailAtrMult,
        armed: false,
        highWatermark: executionPrice,
        lastUpdateTs: openedAt,
      },
      openLeverage: effectiveLev,
      equityAtEntryUsd: this.lastKnownEquityUsd,
      accountSnapshot: sizingSnapshot,
    };
    this.circuitBreaker.onBeforeOpen(new Date(openedAt), this.lastKnownEquityUsd);
    this.syncCircuitBreakerTelemetry();
    if (!Array.isArray(this.pos.tp) || this.pos.tp.length === 0) {
      // CRYPTO ADAPTATION: Use 4-5R targets minimum for crypto volatility
      const baseTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 4)) : (this.pos.entry - (this.plan.stopDistance * 4));
      this.pos.tp = [baseTp];
    }
    if (this.pos.tp.length === 1) {
      // Runner TP at 5R for crypto
      const runnerTp = side === 'buy' ? (this.pos.entry + (this.plan.stopDistance * 5)) : (this.pos.entry - (this.plan.stopDistance * 5));
      this.pos.tp.push(runnerTp);
    }

    await this.enforceMarginAfterFill(effectiveLev, executionPrice);

    if (!this.pos || this.pos.qty <= 0) {
      this.noteSignalDrop('margin_auto_reduce_closed', 'warn', {
        reason: 'position_reduced_to_zero_after_margin_guard',
      });
      this.entering = false;
      return;
    }

    try {
      await recordEnter({
        sessionId: this.sessionId!,
        symbol: this.profile.symbol,
        side,
        qty: this.pos.qty,
        entryPrice: this.pos.entry,
        stop: this.pos.stop,
        tp: this.pos.tp,
  leverage: effectiveLev,
        requestedPrice: telemetry.requestedPrice,
        requestedQty: qty,
        latencyMs: telemetry.latencyMs,
        slippageBps: telemetry.slippageBps,
        fillRatio: telemetry.fillRatio,
        cancelCount: telemetry.cancelCount,
        attempts: telemetry.attempts,
        slOrderId: this.pos.slOrderId,
        tpOrderId: this.pos.tpOrderId,
      });
    } catch {}

    this.logMovement('Position entered', `${side.toUpperCase()} ${this.profile.symbol} qty=${this.pos.qty.toFixed(6)} @ ${this.formatPrice(this.pos.entry)}`, {
      tags: ['movement', 'entry'],
      context: {
        sessionId: this.sessionId,
        symbol: this.profile.symbol,
        side,
        qty: this.pos.qty,
        entry: this.pos.entry,
        stop: this.pos.stop,
        tp: this.pos.tp,
        mode: 'manual',
      },
      severity: 'medium',
    }).catch(()=>{});

    this.state = 'MANAGE';
    this.tradesToday += 1;
    this.noteDrySpellTrade();
    broadcast('agent_state', { state: this.state, pos: this.pos, regime: this.regime, adaptiveRisk: this.adaptiveRisk, tradeCadence: this.getTradeCadenceSnapshot(), aiCalls: await getAICallsCount(this.sessionId || undefined) }, this.profile.symbol, this.sessionId || undefined);
    await this.syncProtectiveOrders('entry');
    this.entering = false;
  }

  public noteTrail(price: number) {
    if (!this.pos) return;
    const now = Date.now();
    if (!this.pos.trail) this.pos.trail = [];
    const last = this.pos.trail[this.pos.trail.length - 1];
    if (!last || Math.abs(last.price - price) > 1e-6) {
      this.pos.trail.push({ ts: now, price });
      if (this.pos.trail.length > 200) this.pos.trail = this.pos.trail.slice(-200);
    } else {
      last.ts = now;
    }
  }

  public computePassivePrice(side: 'buy'|'sell', reference: number, ticker?: { bid?: number; ask?: number }) {
    const tolerance = 0.0005;
    if (!ticker) return reference;
    if (side === 'buy') {
      const bid = ticker.bid ?? reference;
      return Math.max(0, Math.min(reference, bid * (1 - tolerance)));
    }
    const ask = ticker.ask ?? reference;
    return Math.max(reference, ask * (1 + tolerance));
  }

  public computeDynamicTrail(price: number, snap: { atr14?: number; ema20?: number; ema20Slope?: number; realizedVol?: number }, upR: number, elapsedMs: number): number | null {
    if (!this.pos || !this.plan) return null;
    const side = this.pos.side;
    const dir = side === 'buy' ? 1 : -1;
    const planMeta: any = (this.plan.plan as any)?.meta || {};
    const playbook = planMeta.trailingTemplate || planMeta.playbook || this.regime?.playbook || 'mean_reversion';
    const stopDistance = this.plan.stopDistance || Math.max(1e-8, Math.abs(this.pos.entry * 0.005));
    const atrVal = Math.max(stopDistance * 0.6, snap.atr14 || stopDistance);
    const slope = snap.ema20Slope || 0;
    const realizedVol = snap.realizedVol || 0;

    let trailConfig = this.pos.trailConfig;
    if (trailConfig) {
      const highWater = side === 'buy'
        ? Math.max(trailConfig.highWatermark ?? price, price)
        : Math.min(trailConfig.highWatermark ?? price, price);
      if (highWater !== trailConfig.highWatermark) {
        trailConfig = this.pos.trailConfig = {
          ...trailConfig,
          highWatermark: highWater,
          lastUpdateTs: Date.now(),
        };
      }
    }
    if (trailConfig?.mode === 'percent' && trailConfig.armed) {
      const pct = Math.max(0.0025, Math.min(0.0075, trailConfig.fromHighPct ?? this.resolveRunnerTrailPercent()));
      const base = trailConfig.highWatermark ?? price;
      const percentDesired = side === 'buy'
        ? base * (1 - pct)
        : base * (1 + pct);
      const adjusted = side === 'buy'
        ? Math.max(this.pos.stop, percentDesired)
        : Math.min(this.pos.stop, percentDesired);
      if ((side === 'buy' && adjusted > this.pos.stop + 1e-6) || (side === 'sell' && adjusted < this.pos.stop - 1e-6)) {
        this.pos.trailConfig = {
          ...trailConfig,
          fromHighPct: pct,
          highWatermark: base,
          lastUpdateTs: Date.now(),
        };
        return adjusted;
      }
    }
    if (trailConfig?.armed) {
      const mult = trailConfig.multiplier ?? 1;
      const desired = side === 'buy'
        ? price - atrVal * mult
        : price + atrVal * mult;
      const adjusted = side === 'buy'
        ? Math.max(this.pos.stop, desired)
        : Math.min(this.pos.stop, desired);
      if ((side === 'buy' && adjusted > this.pos.stop + 1e-6) || (side === 'sell' && adjusted < this.pos.stop - 1e-6)) {
        const highWater = side === 'buy'
          ? Math.max(trailConfig.highWatermark ?? price, price)
          : Math.min(trailConfig.highWatermark ?? price, price);
        this.pos.trailConfig = { ...trailConfig, highWatermark: highWater, lastUpdateTs: Date.now() };
        return adjusted;
      }
    }

    // Special logic for normal 2-3% moves - optimize timing
    const unrealizedPct = Math.abs((price - this.pos.entry) / this.pos.entry) * 100;
    const isNormalMove = unrealizedPct >= 1.5 && unrealizedPct <= 4.0;
    
    // 🔧 AJUSTÉ : Multipliers plus généreux pour laisser respirer les positions
    let multiplier = playbook === 'momentum_breakout' ? 0.85 : playbook === 'mean_reversion' ? 1.3 : 1.1;

    // 🟢 Early-grace window: rendre le trailing plus permissif en début de trade
    const cfg = getConfig();
    const earlyGraceMs = Math.min(12 * 60 * 1000, Math.max(5 * 60 * 1000, Math.floor((cfg.MIN_HOLD_TIME_MS || 30 * 60 * 1000) / 3)));
    const earlyStage = elapsedMs < earlyGraceMs;
    const adx = Number((snap as any)?.adx14 ?? 0);
    const cmf20 = Number((snap as any)?.cmf20 ?? 0);
    const cmfAligned = (side === 'buy' && cmf20 >= 0.1) || (side === 'sell' && cmf20 <= -0.1);
    const trendAligned = (slope || 0) * dir > 0;
    if (earlyStage) {
      // Laisser plus de marge au démarrage pour éviter les sorties sur simple bruit
      multiplier *= 1.2; // +20% d'espace par rapport au trailing standard
    }
    
    // ✅ FIX: Aggressive tightening when losing (prevents -1.27% ETH losses)
    if (upR < 0) {
      // 🚨 LOSING POSITION
      if (earlyStage && upR > -0.4) {
        // Perdre légèrement au démarrage → on tolère la volatilité
        multiplier = Math.max(multiplier, 1.15);
      } else {
        // Perte confirmée → resserrer
        multiplier = 0.7; // 70% of stop distance
        if (upR < -0.5) {
          multiplier = 0.5; // 50% - very tight stop
          console.log(`🔴 Aggressive trail: R=${upR.toFixed(2)}, mult=${multiplier} (tight stop)`);
        }
      }
    }
    
    // CRYPTO MOONSHOT: Adaptive trailing based on profit level
    const currentProfitPct = Math.abs((price - this.pos.entry) / this.pos.entry) * 100;
    const isBreakoutMode = currentProfitPct >= (cfg.CRYPTO_BREAKOUT_THRESHOLD || 5.0);
    const isMoonshotMode = currentProfitPct >= (cfg.CRYPTO_MOONSHOT_THRESHOLD || 15.0);
    
    if (isMoonshotMode) {
      multiplier *= (cfg.CRYPTO_MOONSHOT_TRAILING || 3.0);
      recordOpsEvent({
        level: 'info',
        source: 'crypto_moonshot',
        message: 'MOONSHOT mode - ultra loose trailing',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { currentProfitPct, multiplier, mode: 'moonshot' },
      });
    } else if (isBreakoutMode) {
      multiplier *= (cfg.CRYPTO_BREAKOUT_TRAILING || 2.0);
      recordOpsEvent({
        level: 'info',
        source: 'crypto_breakout',
        message: 'BREAKOUT mode - loose trailing',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { currentProfitPct, multiplier, mode: 'breakout' },
      });
    }

    // 📈 Confiance de tendance: ADX/CMF alignés → trailing plus lâche pour laisser courir
    if (adx >= 22 && cmfAligned && trendAligned && upR >= 0) {
      multiplier *= 1.12; // +12% d'espace
    }
    // 🔧 AJUSTÉ : Resserrer moins agressivement pour laisser se développer les gains
    if (upR > 2.0) multiplier *= 0.90; // Seulement au-delà de +2R (au lieu de 1.5R)
    if (upR > 3.5) multiplier *= 0.80; // Au-delà de +3.5R (au lieu de 2.5R)
    
    // 🔧 SUPPRIMÉ : Le resserrement sur mouvements normaux causait des sorties prématurées
    // On laisse maintenant respirer la position jusqu'à +3% unrealized
    if (unrealizedPct > 3.0 && upR >= 2.5) {
      multiplier *= 0.85; // Resserrement léger uniquement après +3% unrealized
      recordOpsEvent({
        level: 'info',
        source: 'trail_optimizer',
        message: 'Trailing ajusté après +3% unrealized pour sécuriser gains',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { unrealizedPct: unrealizedPct.toFixed(2), upR: upR.toFixed(2), newMultiplier: multiplier.toFixed(3) },
      });
    }
    
    if (playbook === 'momentum_breakout') {
      if (slope * dir > 0) multiplier *= 0.9;
      else multiplier *= 1.15;
    }
    if (realizedVol > 80) multiplier *= 0.85;
    const atrTrail = price - dir * (atrVal * multiplier);
    let candidate = atrTrail;

    if (snap.ema20) {
      const emaBuffer = snap.ema20 - dir * (atrVal * 0.3);
      candidate = side === 'buy' ? Math.max(candidate, emaBuffer) : Math.min(candidate, emaBuffer);
    }

    const entry = this.pos.entry;
    if (elapsedMs > 30 * 60 * 1000) {
      const tighten = entry + dir * (stopDistance * Math.min(0.5, Math.max(0.2, upR * 0.3)));
      candidate = side === 'buy' ? Math.max(candidate, tighten) : Math.min(candidate, tighten);
    }
    if (elapsedMs > 90 * 60 * 1000) {
      const deepTighten = entry + dir * (stopDistance * Math.min(1, upR));
      candidate = side === 'buy' ? Math.max(candidate, deepTighten) : Math.min(candidate, deepTighten);
    }

    // 🔒 Verrouillage des gains seulement après un minimum de temps (évite BE trop tôt)
    const minHoldForLock = Math.min((cfg.MIN_HOLD_TIME_MS || 30 * 60 * 1000) * 0.5, 15 * 60 * 1000);
    if (elapsedMs > minHoldForLock && upR > 1) {
      const lock = entry + dir * stopDistance * Math.min(1.5, upR);
      candidate = side === 'buy' ? Math.max(candidate, lock) : Math.min(candidate, lock);
    }

    if (upR > 0) {
      const strongTrend = trendAligned && adx >= 32;
      let pctOffset = upR >= 2 ? 0.0042 : upR >= 1 ? 0.0034 : 0;
      if (strongTrend) {
        pctOffset += 0.0008;
      }
      if (this.pos.partialTaken) {
        pctOffset = Math.min(0.0055, pctOffset * 1.15);
      }
      if (pctOffset > 0) {
        const pctTrailPrice = side === 'buy'
          ? price * (1 - pctOffset)
          : price * (1 + pctOffset);
        candidate = side === 'buy'
          ? Math.max(candidate, pctTrailPrice)
          : Math.min(candidate, pctTrailPrice);
      }
    }

    const progressAbs = Math.max(0, dir * (price - entry));
    const halfR = stopDistance * 0.5;
    if (progressAbs < halfR) {
      const guard = entry - dir * (stopDistance * 0.25);
      if (side === 'buy' && candidate > guard) {
        candidate = Math.max(entry - stopDistance, guard);
      } else if (side === 'sell' && candidate < guard) {
        candidate = Math.min(entry + stopDistance, guard);
      }
    }

    return candidate;
  }

  public resolvePartialFraction(): number {
    const tier = this.profile ? this.getTierForSymbol(this.profile.symbol) : 'tier3';
    if (tier === 'tier1') return 0.8;
    if (tier === 'tier2') return 0.82;
    return 0.85;
  }

  public resolveScaleInFraction(): number {
    const tier = this.profile ? this.getTierForSymbol(this.profile.symbol) : 'tier3';
    if (tier === 'tier1') return 0.2;
    if (tier === 'tier2') return 0.25;
    return 0.3;
  }

  public computeWeightedRFromPosition(): number | null {
    if (!this.pos || !this.plan) return null;
    const entry = this.pos.entry;
    const stop = this.pos.stop;
    const targets = this.pos.tp || [];
    const stopDistance = Math.max(1e-9, Math.abs(entry - stop));
    if (!(stopDistance > 0)) return null;
    const baseWeights = [0.35, 0.35, 0.3];
    const fallback = baseWeights[baseWeights.length - 1] ?? 0.1;
    let weightSum = 0;
    let accum = 0;
    targets.forEach((target, idx) => {
      if (target == null || !Number.isFinite(target)) return;
      const rMultiple = Math.abs(target - entry) / stopDistance;
      if (!(rMultiple > 0)) return;
      const weight = idx < baseWeights.length ? baseWeights[idx]! : fallback * Math.pow(0.5, idx - baseWeights.length + 1);
      accum += rMultiple * weight;
      weightSum += weight;
    });
    if (weightSum <= 0) return null;
    return accum / weightSum;
  }

  public resolveRunnerTrailPercent(): number {
    const aggressiveness = this.profile?.aggressiveness ?? 'conservative';
    if (aggressiveness === 'aggressive') return 0.005;
    if (aggressiveness === 'reactive') return 0.004;
    return 0.0035;
  }

  public async maybeScaleInAfterPartial(): Promise<void> {
    if (!this.pos || !this.plan || !this.profile || !this.broker) return;
    if (!this.pos.partialTaken || this.pos.scaleInTriggered) return;

    const baselineWeighted = (this.plan as any)?._initialWeightedR;
    const currentWeighted = this.computeWeightedRFromPosition();
    if (currentWeighted == null || currentWeighted < 1.0) return;
    if (baselineWeighted != null && currentWeighted <= baselineWeighted + 0.05) return;

    const initialQty = this.pos.initialQty ?? this.pos.qty;
    const remainingCapQty = Math.max(0, initialQty * 0.35 - (this.pos.addOnFilledQty ?? 0));
    let desiredQty = Math.min(initialQty * this.resolveScaleInFraction(), remainingCapQty);
    if (!(desiredQty > 0)) return;

    let balance: BrokerMarginSnapshot;
    try {
      balance = await this.broker.balance();
    } catch {
      return;
    }
    const advisor = createMarginAdvisor(balance);
    const utilNow = advisor.utilisationPct();
    if (utilNow >= 60) return;

    const leverageHint = Math.max(1, this.pos.openLeverage ?? this.profile.maxLeverage ?? 1);
    let ticker: any = null;
    try { ticker = await getTicker(this.profile.symbol); } catch {}
    const price = ticker?.last && Number.isFinite(ticker.last) ? Number(ticker.last) : this.pos.entry;
    const additionalNotional = desiredQty * price;
    if (!(additionalNotional > 0)) return;

    const utilAfter = advisor.utilisationPctIf(additionalNotional, leverageHint);
    if (utilAfter >= 72) return;

    const concentrationCapUsd = Number.isFinite(this.maxNotionalCapUsd) && (this.maxNotionalCapUsd ?? 0) > 0
      ? (this.maxNotionalCapUsd as number)
      : Infinity;
    const currentNotional = this.pos.qty * price;
    if (currentNotional + additionalNotional > concentrationCapUsd) {
      const allowable = concentrationCapUsd - currentNotional;
      if (!(allowable > price * 1e-8)) return;
      desiredQty = Math.min(desiredQty, allowable / price);
    }
    if (!(desiredQty > 0)) return;

    try {
      const addOrder = await this.broker.place({
        symbol: this.profile.symbol,
        side: this.pos.side,
        type: 'market',
        qty: Number(desiredQty.toFixed(8)),
        leverage: leverageHint,
        reduceOnly: false,
      });
      if (addOrder?.filledQty && addOrder.filledQty > 0) {
        const fillPrice = addOrder.avgPrice || price;
        this.pos.qty += addOrder.filledQty;
        this.pos.addOnFilledQty = (this.pos.addOnFilledQty ?? 0) + addOrder.filledQty;
        this.pos.scaleInTriggered = true;
        this.pos.initialNotional = (this.pos.initialNotional ?? 0) + addOrder.filledQty * fillPrice;
        const trailConfig = this.pos.trailConfig;
        if (trailConfig) {
          const highWater = this.pos.side === 'buy'
            ? Math.max(trailConfig.highWatermark ?? fillPrice, fillPrice)
            : Math.min(trailConfig.highWatermark ?? fillPrice, fillPrice);
          this.pos.trailConfig = { ...trailConfig, highWatermark: highWater, lastUpdateTs: Date.now() };
        }
        recordOpsEvent({
          level: 'info',
          source: 'scale_in',
          message: 'scale_in_add_on_executed',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            addQty: addOrder.filledQty,
            price: fillPrice,
            utilBefore: utilNow,
            utilAfter,
            weightedR: currentWeighted,
          },
        });
        await this.syncProtectiveOrders('scale_in');
      }
    } catch (error) {
      recordOpsEvent({
        level: 'warn',
        source: 'scale_in',
        message: 'scale_in_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { error: String((error as any)?.message || error) },
      });
    }
  }

  // Helper function to check if price is near key support/resistance levels
  public checkNearKeyLevel(price: number, snap: TechnicalSnapshot): boolean {
    try {
      const threshold = 0.008; // 0.8% threshold for "near"
      
      // Check support levels
      if (snap.supports) {
        for (const support of snap.supports.slice(0, 3)) { // Check top 3 supports
          if (support && support.price) {
            const distance = Math.abs((price - support.price) / price);
            if (distance <= threshold) return true;
          }
        }
      }
      
      // Check resistance levels  
      if (snap.resistances) {
        for (const resistance of snap.resistances.slice(0, 3)) { // Check top 3 resistances
          if (resistance && resistance.price) {
            const distance = Math.abs((price - resistance.price) / price);
            if (distance <= threshold) return true;
          }
        }
      }
      
      // Check pivot levels
      if (snap.pivots) {
        const pivotLevels = [snap.pivots.P, snap.pivots.S1, snap.pivots.S2, snap.pivots.R1, snap.pivots.R2];
        for (const level of pivotLevels) {
          if (level && typeof level === 'number') {
            const distance = Math.abs((price - level) / price);
            if (distance <= threshold) return true;
          }
        }
      }
      
      return false;
    } catch {
      return false;
    }
  }

  public effectiveEntryThresholds() {
    const cfg = getConfig();
    const level = this.profile?.aggressiveness || 'conservative';
    const modeParams = getModeParams(level);
    
    let ENTRY_SHORT_MIN_ADX = cfg.ENTRY_SHORT_MIN_ADX;
    let ENTRY_LONG_MIN_ADX = cfg.ENTRY_LONG_MIN_ADX;
    let ENTRY_SHORT_MIN_RSI = cfg.ENTRY_SHORT_MIN_RSI;
    let ENTRY_LONG_MAX_RSI = cfg.ENTRY_LONG_MAX_RSI;
    let ENTRY_MIN_ATR_PCT = modeParams.minAtrPct; // Use mode-specific ATR threshold
    let ENTRY_MIN_SLOPE_ABS_PCT = cfg.ENTRY_MIN_SLOPE_ABS_PCT;

    if (ENTRY_MIN_ATR_PCT > 0.2) {
      const reduction = level === 'conservative'
        ? 0.1
        : level === 'reactive'
          ? 0.04
          : 0.02;
      ENTRY_MIN_ATR_PCT = Math.max(0.2, ENTRY_MIN_ATR_PCT - reduction);
    } else if (level !== 'conservative') {
      const floor = level === 'aggressive' ? 0.1 : 0.14;
      ENTRY_MIN_ATR_PCT = Math.max(floor, ENTRY_MIN_ATR_PCT);
    }

    if (ENTRY_MIN_SLOPE_ABS_PCT > 0.08) {
      ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.08, ENTRY_MIN_SLOPE_ABS_PCT - 0.02);
    }
    
    if (level === 'reactive') {
      ENTRY_SHORT_MIN_ADX = Math.max(10, ENTRY_SHORT_MIN_ADX - 2);
      ENTRY_LONG_MIN_ADX = Math.max(8, ENTRY_LONG_MIN_ADX - 2);
      ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.008, ENTRY_MIN_SLOPE_ABS_PCT * 0.67);
      // Wider RSI bands for crypto on reactive mode
      ENTRY_SHORT_MIN_RSI = Math.max(35, ENTRY_SHORT_MIN_RSI - 5);
      ENTRY_LONG_MAX_RSI = Math.min(75, ENTRY_LONG_MAX_RSI + 5);
    } else if (level === 'aggressive') {
      ENTRY_SHORT_MIN_ADX = Math.max(8, ENTRY_SHORT_MIN_ADX - 4);
      ENTRY_LONG_MIN_ADX = Math.max(6, ENTRY_LONG_MIN_ADX - 4);
      ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.006, ENTRY_MIN_SLOPE_ABS_PCT * 0.5);
      // Claude-style RSI flexibility for aggressive mode
      ENTRY_SHORT_MIN_RSI = Math.max(30, ENTRY_SHORT_MIN_RSI - 10);
      ENTRY_LONG_MAX_RSI = Math.min(80, ENTRY_LONG_MAX_RSI + 10);
    }
    ENTRY_MIN_SLOPE_ABS_PCT = Math.max(0.00005, ENTRY_MIN_SLOPE_ABS_PCT / 100);

    return { ENTRY_SHORT_MIN_ADX, ENTRY_LONG_MIN_ADX, ENTRY_SHORT_MIN_RSI, ENTRY_LONG_MAX_RSI, ENTRY_MIN_ATR_PCT, ENTRY_MIN_SLOPE_ABS_PCT };
  }

  public static readonly adaptiveATRCache = new Map<string, { threshold: number; lastUpdated: number; baselineATR: number }>();
  public static readonly volatilityProfileCache = new Map<string, 'LOW_VOLATILITY' | 'MODERATE_VOLATILITY' | 'HIGH_VOLATILITY' | 'EXTREME_VOLATILITY' | 'MEME_VOLATILITY'>();
  
  // 🧠 NEW: AI-Powered Dynamic Thresholds Cache System
  public static readonly dynamicThresholdsCache = new Map<string, {
    rsiZones: { long: { min: number; max: number }; short: { min: number; max: number } };
    adxThresholds: { minimum: number; moderate: number; strong: number };
    emaSpreadRequired: number;
    volatilityProfile: string;
    marketRegime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE';
    confidenceScore: number; // 0-1, how confident the AI is in these thresholds
    lastUpdated: number;
    dataPoints: number; // How many data points were used for analysis
    performanceScore?: number; // How well these thresholds performed historically
  }>();
  
  public static readonly intelligentVolatilityCache = new Map<string, {
    currentVolatility: number;
    volatilityTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
    volumeProfile: 'HIGH' | 'NORMAL' | 'LOW';
    priceStability: number; // 0-1 score
    marketCap?: number;
    lastAnalysis: number;
    rawMetrics: {
      atr30d: number;
      volumeCV: number; // Coefficient of variation
      priceCV: number;
      trendStrength: number;
    };
  }>();
  public static readonly volumeContextCache = new Map<string, VolumeContext>();
  
  public static readonly MAX_CACHE_SIZE = 200; // Limit cache size to prevent memory issues
  public static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h cache validity
  public static readonly INTELLIGENT_CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8h for AI analysis
  public static readonly VOLATILITY_ANALYSIS_TTL_MS = 12 * 60 * 60 * 1000; // 12h for volatility metrics
  public static readonly VOLATILITY_CHANGE_THRESHOLD = 0.5; // 50% change triggers update
  public static cacheStats = { hits: 0, misses: 0, updates: 0 };
  public static intelligentCacheStats = { hits: 0, misses: 0, updates: 0, aiAnalysis: 0 };

  public updateVolumeContext(symbol: string, ratio: number, usd: number, blocked: boolean): VolumeContext | undefined {
    if (!symbol) return undefined;
    const now = Date.now();
    let ctx = ReboundRejectionAgent.volumeContextCache.get(symbol);
    const validRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
    const validUsd = Number.isFinite(usd) && usd > 0 ? usd : undefined;

    if (!ctx) {
      ctx = {
        emaRatio: validRatio ?? 0.6,
        emaUsd: validUsd ?? 0,
        rejectionScore: blocked ? 0.2 : 0.05,
        sampleCount: 0,
        lastUpdated: now,
      };
    }

    const alpha = ctx.sampleCount >= 25 ? 0.08 : 0.18;
    if (validRatio !== undefined) {
      ctx.emaRatio = ctx.sampleCount ? ctx.emaRatio + alpha * (validRatio - ctx.emaRatio) : validRatio;
    }
    if (validUsd !== undefined) {
      ctx.emaUsd = ctx.sampleCount ? ctx.emaUsd + alpha * (validUsd - ctx.emaUsd) : validUsd;
    }
    ctx.rejectionScore = Math.max(0, Math.min(1, ctx.rejectionScore * 0.85 + (blocked ? 0.15 : 0)));
    ctx.sampleCount = Math.min(ctx.sampleCount + 1, 500);
    ctx.lastUpdated = now;
    ReboundRejectionAgent.volumeContextCache.set(symbol, ctx);

    if (ReboundRejectionAgent.volumeContextCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [key, val] of ReboundRejectionAgent.volumeContextCache.entries()) {
        if (val.lastUpdated < oldestTs) {
          oldestTs = val.lastUpdated;
          oldestKey = key;
        }
      }
      if (oldestKey) ReboundRejectionAgent.volumeContextCache.delete(oldestKey);
    }

    return ctx;
  }

  /*
   * Clear cache if it gets too large (maintenance)
   */
  /*
  public static clearCacheIfNeeded(): void {
    if (ReboundRejectionAgent.adaptiveATRCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      console.log(`🧹 Clearing ATR cache (${ReboundRejectionAgent.adaptiveATRCache.size} entries) - Stats: ${ReboundRejectionAgent.cacheStats.hits} hits, ${ReboundRejectionAgent.cacheStats.misses} misses`);
      ReboundRejectionAgent.adaptiveATRCache.clear();
      ReboundRejectionAgent.cacheStats = { hits: 0, misses: 0 }; // Reset stats
    }
    if (ReboundRejectionAgent.volatilityProfileCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      console.log(`🧹 Clearing volatility profile cache (${ReboundRejectionAgent.volatilityProfileCache.size} entries)`);
      ReboundRejectionAgent.volatilityProfileCache.clear();
    }
  }
  */

  /**
   * Check if cache needs update based on current market volatility vs cached baseline
   */
  public async shouldUpdateATRCache(symbol: string): Promise<{ needsUpdate: boolean; currentATR: number }> {
    const cached = ReboundRejectionAgent.adaptiveATRCache.get(symbol);
    
    // Get current market ATR for comparison
    let currentATR = 0;
    try {
      const target = symbol || this.profile?.symbol || '';
      if (target) {
        const snapshot = await buildTechSnapshot(target);
        currentATR = Number((snapshot as any)?.atrPct ?? 0);
      }
    } catch (error) {
      console.warn(`Failed to get current ATR for ${symbol}:`, error);
      // If we can't get current data, use cache if available
      if (cached) {
        return { needsUpdate: false, currentATR: cached.baselineATR };
      }
    }
    
    if (!cached) return { needsUpdate: true, currentATR }; // No cache = needs update
    
    const now = Date.now();
    const ageMs = now - cached.lastUpdated;
    
    // Force update if cache is too old (24h)
    if (ageMs > ReboundRejectionAgent.CACHE_TTL_MS) {
      console.log(`🕐 Cache expired for ${symbol} (${(ageMs / (1000 * 60 * 60)).toFixed(1)}h old)`);
      return { needsUpdate: true, currentATR };
    }
    
    // Update if volatility changed significantly
    if (cached.baselineATR > 0 && currentATR > 0) {
      const volatilityChange = Math.abs(currentATR - cached.baselineATR) / cached.baselineATR;
      if (volatilityChange > ReboundRejectionAgent.VOLATILITY_CHANGE_THRESHOLD) {
        console.log(`📈 Volatility changed significantly for ${symbol}: ${cached.baselineATR.toFixed(3)}% → ${currentATR.toFixed(3)}% (${(volatilityChange * 100).toFixed(1)}% change)`);
        return { needsUpdate: true, currentATR };
      }
    }
    
    return { needsUpdate: false, currentATR };
  }

  /**
   * 🆕 Check if should switch to breakout mode (capture ongoing trends)
   */
  public shouldSwitchToBreakoutMode(snap: TechnicalSnapshot, currentPrice: number): boolean {
    if (!this.plan?.zone) return false;
    if (this.breakoutModeActive) return true; // Already in breakout
    
    const { from, to } = this.plan.zone;
    const zoneMax = Math.max(from, to);
    const priceAboveZonePct = ((currentPrice - zoneMax) / zoneMax) * 100;
    
    // ✅ FIX: Conditions assouplies pour capturer breakouts plus tôt
    const farAboveZone = priceAboveZonePct > 1.5; // +1.5% au-dessus zone (était 3%)
    const strongTrend = (snap.adx14 || 0) > 25; // ADX > 25 (était 30)
    const significantMove = Math.abs((snap as any).change24h || 0) > 3.0; // +3% move 24h (était 4%)
    const lastTradeWin = this.lastTradeWasWin === true;
    
    // Durée hors zone (éviter switch trop rapide)
    const now = Date.now();
    if (this.lastZoneCheckTime === 0) this.lastZoneCheckTime = now;
    const timeOutOfZone = now - this.lastZoneCheckTime;
    const minDuration = 30 * 60 * 1000; // 30 minutes (était 2h)
    
    const shouldSwitch = farAboveZone && strongTrend && significantMove && timeOutOfZone > minDuration;
    
    // ✅ FIX: Ne plus bloquer sur last trade LOSS si le move est très fort (>8%)
    const veryStrongMove = Math.abs((snap as any).change24h || 0) > 8.0;
    if (shouldSwitch && !lastTradeWin && !veryStrongMove) {
      console.log('⚠️ Breakout conditions met but last trade was LOSS - staying conservative (unless move >8%)');
      return false;
    }
    
    if (shouldSwitch) {
      console.log('🚀 SWITCHING TO BREAKOUT MODE:');
      console.log(`  Price ${currentPrice.toFixed(4)} > zone max ${zoneMax.toFixed(4)} (+${priceAboveZonePct.toFixed(1)}%)`);
      console.log(`  ADX: ${(snap.adx14 || 0).toFixed(1)} > 25 ✅`);
      console.log(`  Move 24h: ${Math.abs((snap as any).change24h || 0).toFixed(1)}% ✅`);
      console.log(`  Time out of zone: ${(timeOutOfZone / 60000).toFixed(0)} min ✅`);
      this.breakoutModeActive = true;
      
      recordOpsEvent({
        level: 'info',
        source: 'breakout_mode',
        message: 'Switched to breakout mode - capturing ongoing trend',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { priceAboveZonePct, adx: snap.adx14, move24h: (snap as any).change24h, timeOutOfZoneHours: timeOutOfZone / 3600000 },
      });
    }
    
    return shouldSwitch;
  }
  
  /**
   * Calculate dynamic entry zone based on current market conditions and bias
   */
  /**
   * Determine optimal bias based on current market context, trend strength, and key levels
   * Enhanced logic for trend continuation scenarios (rebounds on resistance, rejections on support)
   */
  public determineContextualBias(snap: TechnicalSnapshot, currentPrice: number): 'long' | 'short' | 'none' {
    const supports = snap.supports || [];
    const resistances = snap.resistances || [];
    
    // Find nearest support and resistance
    const nearestSupport = supports
      .filter(s => s.price < currentPrice)
      .sort((a, b) => Math.abs(currentPrice - b.price) - Math.abs(currentPrice - a.price))[0];
      
    const nearestResistance = resistances
      .filter(r => r.price > currentPrice)
      .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];
    
    const supportDistance = nearestSupport ? Math.abs(currentPrice - nearestSupport.price) / currentPrice : 1;
    const resistanceDistance = nearestResistance ? Math.abs(currentPrice - nearestResistance.price) / currentPrice : 1;
    
    // Enhanced technical analysis with trend strength evaluation
    const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
    const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const adx = Number((snap as any)?.adx14 ?? 0);
    const ema20Slope = Number((snap as any)?.ema20Slope ?? 0);
    const atrPct = Number((snap as any)?.atrPct ?? 1.0);
    
    // Calculate trend metrics
    const emaSpread = Math.abs((ema20 - ema50) / ema50) * 100;
    const trendUp = ema20 > ema50;
    const strongTrend = adx > 25 && emaSpread > 1.0; // Both ADX and EMA spread confirm trend
    const moderateTrend = adx > 15 && emaSpread > 0.5;
    const trendStrength = strongTrend ? 'strong' : moderateTrend ? 'moderate' : 'weak';
    
    // Slope direction confirmation (trend acceleration/deceleration)
    const slopeAligned = trendUp ? ema20Slope > 0 : ema20Slope < 0;
    const slopeMagnitude = Math.abs(ema20Slope / ema20); // Fractional slope

    console.log(`🧠 TREND ANALYSIS: ${trendUp ? 'UP' : 'DOWN'} trend (${trendStrength}), ADX: ${adx.toFixed(1)}, EMA spread: ${emaSpread.toFixed(2)}%, Slope: ${(slopeMagnitude * 100).toFixed(3)}%`);
    
    // SCENARIO 1: Near Support - Context-dependent behavior
    if (supportDistance < 0.04 && nearestSupport) { // Increased to 4% for more opportunities
      const supportStrength = nearestSupport.touches || 1;
      const rsiOversold = rsi < 35;
      const rsiNeutral = rsi >= 35 && rsi <= 65;
      
      if (strongTrend && trendUp && slopeAligned) {
        // STRONG UPTREND: High probability support bounce
        console.log(`📈 SCENARIO: STRONG UPTREND + Support (${(supportDistance*100).toFixed(1)}%) → LONG (trend continuation bounce)`);
        return 'long';
      } else if (strongTrend && !trendUp && !slopeAligned) {
        // STRONG DOWNTREND: Support likely to break (rejection scenario)
        console.log(`📉 SCENARIO: STRONG DOWNTREND + Support (${(supportDistance*100).toFixed(1)}%) → SHORT (support break continuation)`);
        return 'short';
      } else if (supportStrength >= 2 && (rsiOversold || (rsiNeutral && moderateTrend && trendUp))) {
        // MODERATE CONDITIONS: Traditional support bounce
        console.log(`📈 SCENARIO: Support bounce (strength: ${supportStrength}, RSI: ${rsi.toFixed(1)}) → LONG`);
        return 'long';
      }
    }
    
    // SCENARIO 2: Near Resistance - Enhanced with trend continuation logic
    if (resistanceDistance < 0.04 && nearestResistance) { // Increased to 4%
      const resistanceStrength = nearestResistance.touches || 1;
      const rsiOverbought = rsi > 65;
      const rsiNeutral = rsi >= 35 && rsi <= 65;
      
      if (strongTrend && trendUp && slopeAligned) {
        // STRONG UPTREND: Resistance break scenario (continuation)
        console.log(`📈 SCENARIO: STRONG UPTREND + Resistance (${(resistanceDistance*100).toFixed(1)}%) → LONG (resistance break continuation)`);
        return 'long';
      } else if (strongTrend && !trendUp && !slopeAligned) {
        // STRONG DOWNTREND: High probability resistance rejection
        console.log(`📉 SCENARIO: STRONG DOWNTREND + Resistance (${(resistanceDistance*100).toFixed(1)}%) → SHORT (trend continuation rejection)`);
        return 'short';
      } else if (resistanceStrength >= 2 && (rsiOverbought || (rsiNeutral && moderateTrend && !trendUp))) {
        // MODERATE CONDITIONS: Traditional resistance rejection
        console.log(`📉 SCENARIO: Resistance rejection (strength: ${resistanceStrength}, RSI: ${rsi.toFixed(1)}) → SHORT`);
        return 'short';
      }
    }
    
    // SCENARIO 3: Trend Following in Middle Zone (enhanced)
    if (strongTrend && slopeAligned) {
      if (trendUp && rsi < 70 && emaSpread > 1.5) {
        console.log(`📈 SCENARIO: STRONG UPTREND continuation (ADX: ${adx.toFixed(1)}, spread: ${emaSpread.toFixed(1)}%) → LONG`);
        return 'long';
      } else if (!trendUp && rsi > 30 && emaSpread > 1.5) {
        console.log(`📉 SCENARIO: STRONG DOWNTREND continuation (ADX: ${adx.toFixed(1)}, spread: ${emaSpread.toFixed(1)}%) → SHORT`);
        return 'short';
      }
    }
    
    // SCENARIO 4: Momentum-based entries (when trend is developing)
    if (moderateTrend && slopeMagnitude > 0.05) { // Accelerating trend
      if (trendUp && rsi >= 45 && rsi <= 65) {
        console.log(`📈 SCENARIO: Developing uptrend momentum → LONG`);
        return 'long';
      } else if (!trendUp && rsi >= 35 && rsi <= 55) {
        console.log(`📉 SCENARIO: Developing downtrend momentum → SHORT`);
        return 'short';
      }
    }
    
    // SCENARIO 5: High volatility mean reversion (when no clear trend)
    if (atrPct > 3.0 && trendStrength === 'weak' && Math.abs(rsi - 50) > 15) {
      if (rsi < 35 && supportDistance < 0.06) {
        console.log(`� SCENARIO: High volatility oversold bounce → LONG`);
        return 'long';
      } else if (rsi > 65 && resistanceDistance < 0.06) {
        console.log(`📉 SCENARIO: High volatility overbought rejection → SHORT`);
        return 'short';
      }
    }
    
    console.log(`🔄 SCENARIO: CONSOLIDATION/NEUTRAL - No clear directional edge (trend: ${trendStrength}, RSI: ${rsi.toFixed(1)})`);
    return 'none';
  }  public async calculateDynamicEntryZone(snap: TechnicalSnapshot, currentPrice: number, bias: 'long' | 'short' | 'none'): Promise<{ from: number; to: number; mid: number }> {
    // 🟡 PHASE 2 FIX #5: Validate technical data before proceeding
    const dataValidation = this.hasValidTechnicalData(snap);
    if (!dataValidation.valid) {
      console.warn(`🟡 ${dataValidation.reason} - Cannot calculate reliable entry zone`);
      // Return breakout-style zone as fallback
      const fallbackRange = currentPrice * 0.005;
      return {
        from: currentPrice - fallbackRange,
        to: currentPrice + fallbackRange,
        mid: currentPrice
      };
    }

    // 🟡 PHASE 2 FIX #4: Skip if consolidating (no edge)
    const consolidationCheck = this.isConsolidating(snap);
    if (consolidationCheck.consolidating) {
      console.warn(`🟡 ${consolidationCheck.reason} - Skipping setup (no edge in ranging market)`);
      // Create a minimal but valid zone (ensure non-zero width) to avoid degenerate zones in diagnostics
      let tmp = {
        from: currentPrice * 0.95,
        to: currentPrice * 0.95,
        mid: currentPrice * 0.95
      };
      // Ensure at least a minimal width so the zone is reachable
      tmp = this.ensureMinimumZoneWidth(tmp, snap);
      return tmp;
    }

    // 🆕 CHECK: Faut-il switcher en mode breakout ?
    const useBreakoutMode = this.shouldSwitchToBreakoutMode(snap, currentPrice);
    
    if (useBreakoutMode && bias !== 'none') {
      console.log('🚀 BREAKOUT MODE - Entry zone around current price');
      
      // Entry zone serrée autour du prix actuel pour entrée immédiate
      const range = currentPrice * 0.003; // ±0.3% de chaque côté
      
      return {
        from: currentPrice - range,
        to: currentPrice + range,
        mid: currentPrice
      };
    }
    
    if (bias === 'none') {
      // No bias, create a small zone around current price
      const range = currentPrice * 0.005; // 0.5% range
      return {
        from: currentPrice - range,
        to: currentPrice + range,
        mid: currentPrice
      };
    }
    
    // Get current support and resistance levels
    const supports = snap.supports || [];
    const resistances = snap.resistances || [];
    const atrPct = Number((snap as any)?.atrPct ?? 1.0);
    
    // Calculate dynamic zone based on bias and proximity to key levels
    if (bias === 'long') {
      // 🚀 NEW: Detect MOMENTUM TREND and allow immediate entry at current price
      const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
      const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
      const emaSpread = ema50 > 0 ? ((ema20 - ema50) / ema50) * 100 : 0;
      const priceTo20 = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 1;
      const adx = Number((snap as any)?.adx14 ?? 0);
      
      // Strong uptrend: EMA20 > EMA50 with >0.8% spread, price near EMA20, ADX > 25
      const strongTrendUp = ema20 > ema50 && emaSpread > 0.8 && priceTo20 < 0.025 && adx > 25;
      
      // Moderate uptrend: EMA20 > EMA50 with >0.4% spread, price within 3% of EMA20
      const moderateTrendUp = ema20 > ema50 && emaSpread > 0.4 && priceTo20 < 0.03;
      
      if (strongTrendUp || moderateTrendUp) {
        const trendType = strongTrendUp ? 'STRONG' : 'MODERATE';
        console.log(`🚀 ${trendType} MOMENTUM LONG TREND - Entry at current price`);
        console.log(`   EMA20: ${ema20.toFixed(4)}, EMA50: ${ema50.toFixed(4)}, Spread: ${emaSpread.toFixed(2)}%`);
        console.log(`   Price distance from EMA20: ${(priceTo20 * 100).toFixed(2)}%`);
        
        // Entry zone around current price for momentum entry
        const range = strongTrendUp ? currentPrice * 0.008 : currentPrice * 0.012; // ±0.8% or ±1.2%
        
        return {
          from: currentPrice - range,
          to: currentPrice + range,
          mid: currentPrice
        };
      }
      
      // LONG SCENARIO: Target support areas for bounce entries (traditional mean reversion)
      // 🔥 PHASE 1 FIX #5: Validate support strength (min 3 touches, max 7 days old)
      const validSupports = supports
        .filter(s => s.price < currentPrice)
        .filter(s => {
          // Require minimum 3 touches for strong support
          if (s.touches < 3) {
            this.requireStrongerConfirmation = true; // Flag for whipsaw protection
            return false;
          }
          return true;
        });

      const nearestSupport = validSupports
        .sort((a, b) => Math.abs(currentPrice - b.price) - Math.abs(currentPrice - a.price))[0];
      
      // Warn if price is very close to support (<1%) - might break through
      if (nearestSupport && Math.abs(currentPrice - nearestSupport.price) / currentPrice < 0.01) {
        console.warn(`⚠️ Price ${currentPrice.toFixed(4)} very close to support ${nearestSupport.price.toFixed(4)} - risk of break`);
        this.requireStrongerConfirmation = true;
      }
      
      let targetLevel = nearestSupport?.price;
      let zoneLabel = 'pullback';
      
      // If no nearby support or too far, use technical levels
      if (!targetLevel || Math.abs(currentPrice - targetLevel) / currentPrice > 0.08) {
        // Use EMA levels as dynamic support
        const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
        const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
        
        // Priority: EMA20 > EMA50 > calculated pullback (ensure levels are BELOW current price for LONG)
        if (currentPrice > ema20 && ema20 > 0 && (currentPrice - ema20) / currentPrice < 0.05) {
          targetLevel = ema20;
          zoneLabel = 'EMA20 support';
        } else if (currentPrice > ema50 && ema50 > 0 && (currentPrice - ema50) / currentPrice < 0.08) {
          targetLevel = ema50;
          zoneLabel = 'EMA50 support';
        } else {
          // Calculate optimal pullback level (2-4% based on volatility) - BELOW current price
          const pullbackPct = Math.max(0.02, Math.min(0.04, atrPct / 100));
          targetLevel = currentPrice * (1 - pullbackPct);
          zoneLabel = `${(pullbackPct*100).toFixed(1)}% pullback`;
        }
      } else {
        zoneLabel = 'support bounce';
      }
      
      // Validation: Ensure LONG targetLevel is BELOW current price
      if (targetLevel >= currentPrice) {
        console.warn(`⚠️ LONG bias inconsistency: targetLevel ${targetLevel.toFixed(4)} >= currentPrice ${currentPrice.toFixed(4)}, forcing pullback below`);
        const fallbackPullbackPct = 0.025; // 2.5% below
        targetLevel = currentPrice * (1 - fallbackPullbackPct);
        zoneLabel = 'fallback pullback (corrected)';
      }
      
      // Create zone around target level with adaptive width
      const baseWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3); // Min 0.5% or 30% of ATR
      const supportStrength = nearestSupport?.touches || 1;
      const strengthMultiplier = Math.min(1.5, 1 + (supportStrength - 1) * 0.2); // Stronger support = wider zone
      const zoneWidth = baseWidth * strengthMultiplier;
      
      console.log(`📈 LONG entry zone: ${zoneLabel} at ${targetLevel.toFixed(4)} ±${zoneWidth.toFixed(4)}`);
      
      let zone = {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };

      // 🟡 PHASE 2 FIX #1: Ensure minimum width
      zone = this.ensureMinimumZoneWidth(zone, snap);
      
      // 🟢 PHASE 3 FIX #2: Cap maximum width
      zone = this.capMaximumZoneWidth(zone, snap);
      
      // � PHASE 4 FIX #2: Adaptive Volatility Strategy
      const volStrategyLong = this.getVolatilityStrategy(snap);
      if (volStrategyLong.strategy !== 'aggressive') {
        console.log(`� Volatility strategy: ${volStrategyLong.strategy}`);
        console.log(`   Zone width: ${volStrategyLong.adjustments.zoneWidthMultiplier.toFixed(2)}x, Position: ${(volStrategyLong.adjustments.positionSizeReduction*100).toFixed(0)}%`);
        
        const currentWidth = Math.abs(zone.to - zone.from);
        const adjustment = volStrategyLong.adjustments.zoneWidthMultiplier;
        if (adjustment !== 1.0) {
          const expansion = currentWidth * (adjustment - 1) / 2;
          zone = {
            from: zone.from - expansion,
            to: zone.to + expansion,
            mid: zone.mid
          };
        }
      }

      return zone;
      
    } else if (bias === 'short') {
      // 🚀 NEW: Detect MOMENTUM DOWNTREND and allow immediate entry at current price
      const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
      const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
      const emaSpread = ema50 > 0 ? ((ema20 - ema50) / ema50) * 100 : 0;
      const priceTo20 = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 1;
      const adx = Number((snap as any)?.adx14 ?? 0);
      
      // Strong downtrend: EMA20 < EMA50 with <-0.8% spread, price near EMA20, ADX > 25
      const strongTrendDown = ema20 < ema50 && emaSpread < -0.8 && priceTo20 < 0.025 && adx > 25;
      
      // Moderate downtrend: EMA20 < EMA50 with <-0.4% spread, price within 3% of EMA20
      const moderateTrendDown = ema20 < ema50 && emaSpread < -0.4 && priceTo20 < 0.03;
      
      if (strongTrendDown || moderateTrendDown) {
        const trendType = strongTrendDown ? 'STRONG' : 'MODERATE';
        console.log(`🚀 ${trendType} MOMENTUM SHORT TREND - Entry at current price`);
        console.log(`   EMA20: ${ema20.toFixed(4)}, EMA50: ${ema50.toFixed(4)}, Spread: ${emaSpread.toFixed(2)}%`);
        console.log(`   Price distance from EMA20: ${(priceTo20 * 100).toFixed(2)}%`);
        
        // Entry zone around current price for momentum entry
        const range = strongTrendDown ? currentPrice * 0.008 : currentPrice * 0.012; // ±0.8% or ±1.2%
        
        return {
          from: currentPrice - range,
          to: currentPrice + range,
          mid: currentPrice
        };
      }
      
      // SHORT SCENARIO: Target resistance areas for rejection entries (traditional mean reversion)
      // 🔥 PHASE 1 FIX #5: Validate resistance strength (min 3 touches, max 7 days old)
      const validResistances = resistances
        .filter(r => r.price > currentPrice)
        .filter(r => {
          // Require minimum 3 touches for strong resistance
          if (r.touches < 3) {
            this.requireStrongerConfirmation = true; // Flag for whipsaw protection
            return false;
          }
          return true;
        });

      const nearestResistance = validResistances
        .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price))[0];
      
      // Warn if price is very close to resistance (<1%) - might break through
      if (nearestResistance && Math.abs(currentPrice - nearestResistance.price) / currentPrice < 0.01) {
        console.warn(`⚠️ Price ${currentPrice.toFixed(4)} very close to resistance ${nearestResistance.price.toFixed(4)} - risk of break`);
        this.requireStrongerConfirmation = true;
      }
      
      let targetLevel = nearestResistance?.price;
      let zoneLabel = 'bounce';
      
      // If no nearby resistance or too far, use technical levels
      if (!targetLevel || Math.abs(currentPrice - targetLevel) / currentPrice > 0.08) {
        // Use EMA levels as dynamic resistance
        const ema20 = Number((snap as any)?.ema20 ?? currentPrice);
        const ema50 = Number((snap as any)?.ema50 ?? currentPrice);
        
        // Priority: EMA20 > EMA50 > calculated bounce (ensure levels are ABOVE current price for SHORT)
        if (currentPrice < ema20 && ema20 > 0 && (ema20 - currentPrice) / currentPrice < 0.05) {
          targetLevel = ema20;
          zoneLabel = 'EMA20 resistance';
        } else if (currentPrice < ema50 && ema50 > 0 && (ema50 - currentPrice) / currentPrice < 0.08) {
          targetLevel = ema50;
          zoneLabel = 'EMA50 resistance';
        } else {
          // Calculate optimal bounce level (2-4% based on volatility) - ABOVE current price
          const bouncePct = Math.max(0.02, Math.min(0.04, atrPct / 100));
          targetLevel = currentPrice * (1 + bouncePct);
          zoneLabel = `${(bouncePct*100).toFixed(1)}% bounce`;
        }
      } else {
        zoneLabel = 'resistance rejection';
      }
      
      // Validation: Ensure SHORT targetLevel is ABOVE current price
      if (targetLevel <= currentPrice) {
        console.warn(`⚠️ SHORT bias inconsistency: targetLevel ${targetLevel.toFixed(4)} <= currentPrice ${currentPrice.toFixed(4)}, forcing bounce above`);
        const fallbackBouncePct = 0.025; // 2.5% above
        targetLevel = currentPrice * (1 + fallbackBouncePct);
        zoneLabel = 'fallback bounce (corrected)';
      }
      
      // Create zone around target level with adaptive width
      const baseWidth = Math.max(targetLevel * 0.005, targetLevel * (atrPct / 100) * 0.3); // Min 0.5% or 30% of ATR
      const resistanceStrength = nearestResistance?.touches || 1;
      const strengthMultiplier = Math.min(1.5, 1 + (resistanceStrength - 1) * 0.2); // Stronger resistance = wider zone
      const zoneWidth = baseWidth * strengthMultiplier;
      
      console.log(`📉 SHORT entry zone: ${zoneLabel} at ${targetLevel.toFixed(4)} ±${zoneWidth.toFixed(4)}`);
      
      let zone = {
        from: targetLevel - zoneWidth,
        to: targetLevel + zoneWidth,
        mid: targetLevel
      };

      // 🟡 PHASE 2 FIX #1: Ensure minimum width
      zone = this.ensureMinimumZoneWidth(zone, snap);
      
      // 🟢 PHASE 3 FIX #2: Cap maximum width
      zone = this.capMaximumZoneWidth(zone, snap);
      
      // � PHASE 4 FIX #2: Adaptive Volatility Strategy
      const volStrategyShort = this.getVolatilityStrategy(snap);
      if (volStrategyShort.strategy !== 'aggressive') {
        console.log(`� Volatility strategy: ${volStrategyShort.strategy}`);
        console.log(`   Zone width: ${volStrategyShort.adjustments.zoneWidthMultiplier.toFixed(2)}x, Position: ${(volStrategyShort.adjustments.positionSizeReduction*100).toFixed(0)}%`);
        
        const currentWidth = Math.abs(zone.to - zone.from);
        const adjustment = volStrategyShort.adjustments.zoneWidthMultiplier;
        if (adjustment !== 1.0) {
          const expansion = currentWidth * (adjustment - 1) / 2;
          zone = {
            from: zone.from - expansion,
            to: zone.to + expansion,
            mid: zone.mid
          };
        }
      }

      return zone;
    }
    
    // Fallback: small zone around current price
    const range = currentPrice * 0.01; // 1% range
    return {
      from: currentPrice - range,
      to: currentPrice + range,
      mid: currentPrice
    };
  }

  /**
   * ✅ ULTRA-INTELLIGENT: Classify crypto by tier for contextualized learning
   * Tier 1: Ultra stable majors (BTC, ETH, SOL) - 55% target win rate
   * Tier 2: Established alts (ADA, XRP, AVAX, MATIC, etc.) - 50% target
   * Tier 3: Volatile alts (ENA, EIGEN, AVNT, etc.) - 45% target
   */
  public getTierForSymbol(symbol: string): string {
    const baseCrypto = symbol.split('/')[0].toUpperCase();
    
    // Tier 1: Ultra stable majors - Blue chip cryptos
    const tier1 = ['BTC', 'ETH', 'SOL'];
    if (tier1.includes(baseCrypto)) return 'tier1';
    
    // Tier 2: Established major alts - Good liquidity, proven track record
    const tier2 = [
      'XRP', 'BNB', 'ADA', 'AVAX', 'MATIC', 'DOT', 'LINK',
      'UNI', 'ATOM', 'LTC', 'BCH', 'NEAR', 'APT', 'ARB',
      'OP', 'FIL', 'ICP', 'VET', 'ALGO', 'AAVE', 'MKR'
    ];
    if (tier2.includes(baseCrypto)) return 'tier2';
    
    // Tier 3: Everything else - High volatility, lower liquidity
    return 'tier3';
  }
  
  /**
   * ✅ Get target win rate for a tier (contextualized expectations)
   */
  public getTargetWinRateForTier(tier: string): number {
    if (tier === 'tier1') return 0.55; // BTC/ETH/SOL: More predictable
    if (tier === 'tier2') return 0.50; // Major alts: Medium volatility
    return 0.45; // Volatile alts: Higher risk, lower expectations
  }

  /**
   * Public method to test ATR thresholds for debugging
   */
  public testAdaptiveATRThreshold(symbol: string, baseThreshold: number): number {
    return this.getAdaptiveATRThresholdSync(symbol, baseThreshold);
  }

  /**
   * Public method to test dynamic entry zone calculation for debugging
   */
  public async testCalculateDynamicEntryZone(snap: TechnicalSnapshot, currentPrice: number, bias: 'long' | 'short' | 'none'): Promise<{ from: number; to: number; mid: number }> {
    return this.calculateDynamicEntryZone(snap, currentPrice, bias);
  }

  /**
   * Synchronous version that uses cached values (for momentum gates and quality filters)
   */
  public getAdaptiveATRThresholdSync(symbol: string, baseThreshold: number): number {
    if (!symbol) return baseThreshold;
    
    const baseCrypto = symbol.split('/')[0]?.toUpperCase();
    if (!baseCrypto) return baseThreshold;
    
    // Check cache first
    const cached = ReboundRejectionAgent.adaptiveATRCache.get(symbol);
    if (cached) {
      const now = Date.now();
      const ageMs = now - cached.lastUpdated;
      
      // Use cache if not too old (prefer slightly stale data over blocking)
      if (ageMs < ReboundRejectionAgent.CACHE_TTL_MS * 2) { // 48h tolerance for sync calls
        ReboundRejectionAgent.cacheStats.hits++;
        return cached.threshold;
      }
    }
    
    // Fallback to static classification if no cache
    let adaptiveThreshold = baseThreshold;
    
    // Static classification by crypto type
    switch (baseCrypto) {
      case 'CRO':
      case 'ADA': 
      case 'XRP':
      case 'TRX':
      case 'MATIC':
      case 'DOT':
        adaptiveThreshold = Math.max(0.15, baseThreshold * 0.3); // Low volatility
        break;
        
      case 'ETH':
      case 'SOL':
      case 'LINK':
      case 'UNI':
      case 'AVAX':
        adaptiveThreshold = Math.max(0.25, baseThreshold * 0.5); // Moderate volatility
        break;
        
      case 'DOGE':
      case 'SHIB':
      case 'PEPE':
      case 'AVNT':
      case 'WIF':
        adaptiveThreshold = Math.max(0.4, baseThreshold * 0.7); // High volatility
        break;
        
      case 'BTC':
      case 'BCH':
        adaptiveThreshold = baseThreshold; // Bitcoin family
        break;
        
      default:
        adaptiveThreshold = Math.max(0.25, baseThreshold * 0.5); // Unknown cryptos
        break;
    }
    
    // Apply performance-based adaptation multipliers
    if (this.performanceMetrics && this.plan) {
      const strategy = this.plan.bias || 'long';
      const bias = strategy === 'long' ? 'long' : 'short';
      const multipliers = this.getAdaptationMultipliers(strategy, bias);
      
      // Apply ATR multiplier based on strategy performance
      adaptiveThreshold *= multipliers.atr;
      
      console.log(`🎯 Performance-adapted ATR for ${symbol} (${strategy}_${bias}): ${baseThreshold.toFixed(3)}% → ${adaptiveThreshold.toFixed(3)}% (multiplier: ${multipliers.atr.toFixed(2)})`);
    }
    
    return adaptiveThreshold;
  }

  /**
   * Public method to force update adaptive ATR cache for a symbol
   */
  public async forceUpdateAdaptiveATR(symbol: string): Promise<void> {
    if (!symbol) return;
    try {
      await this.updateAdaptiveATRCache(symbol, 1.0);
    } catch (err) {
      console.error('Error forcing adaptive ATR update:', err);
    }
  }

  // ========================================================================
  /**
   * Async version for cache updates (called periodically or on demand)
   */
  async updateAdaptiveATRCache(symbol: string, baseThreshold: number): Promise<void> {
    if (!symbol) return;
    
    const baseCrypto = symbol.split('/')[0]?.toUpperCase();
    if (!baseCrypto) return;
    
    // Check if we need to update cache
    const { needsUpdate, currentATR } = await this.shouldUpdateATRCache(symbol);
    const cached = ReboundRejectionAgent.adaptiveATRCache.get(symbol);
    
    if (cached && !needsUpdate) {
      return; // No update needed
    }
    
    // Calculate new adaptive threshold (same logic as sync version)
    let adaptiveThreshold = this.getAdaptiveATRThresholdSync(symbol, baseThreshold);
    
    // Dynamic adjustment based on recent market conditions
    if (currentATR > 0) {
      // If current volatility is very high, be more permissive
      if (currentATR > 3.0) {
        adaptiveThreshold *= 1.2; // 20% higher threshold in extreme volatility
      }
      // If current volatility is very low, be more strict
      else if (currentATR < 0.5) {
        adaptiveThreshold *= 0.8; // 20% lower threshold in low volatility
      }
    }
    
    // Update cache with new data
    ReboundRejectionAgent.adaptiveATRCache.set(symbol, {
      threshold: adaptiveThreshold,
      lastUpdated: Date.now(),
      baselineATR: currentATR
    });
    
    ReboundRejectionAgent.cacheStats.misses++;
    if (needsUpdate && cached) {
      ReboundRejectionAgent.cacheStats.updates++;
      console.log(`🔄 Updated ATR threshold for ${symbol}: ${cached.threshold.toFixed(3)}% → ${adaptiveThreshold.toFixed(3)}%`);
    }
    
    // Clear cache if it gets too large
    if (ReboundRejectionAgent.adaptiveATRCache.size > ReboundRejectionAgent.MAX_CACHE_SIZE) {
      this.clearOldCacheEntries();
    }
  }

  /**
   * Clear old cache entries based on LRU and age
   */
  public clearOldCacheEntries(): void {
    const now = Date.now();
    const entries = Array.from(ReboundRejectionAgent.adaptiveATRCache.entries());
    
    // Sort by age (oldest first)
    entries.sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
    
    // Remove oldest 25% of entries
    const toRemove = Math.floor(entries.length * 0.25);
    for (let i = 0; i < toRemove; i++) {
      ReboundRejectionAgent.adaptiveATRCache.delete(entries[i][0]);
    }
    
    console.log(`🧹 Cleared ${toRemove} old ATR cache entries (${ReboundRejectionAgent.adaptiveATRCache.size} remaining)`);
  }

  /**
   * Get cache statistics for monitoring
   */
  static getATRCacheStats() {
    const cacheSize = ReboundRejectionAgent.adaptiveATRCache.size;
    const hitRate = ReboundRejectionAgent.cacheStats.hits + ReboundRejectionAgent.cacheStats.misses > 0 
      ? (ReboundRejectionAgent.cacheStats.hits / (ReboundRejectionAgent.cacheStats.hits + ReboundRejectionAgent.cacheStats.misses) * 100)
      : 0;
    
    return {
      cacheSize,
      hits: ReboundRejectionAgent.cacheStats.hits,
      misses: ReboundRejectionAgent.cacheStats.misses,
      updates: ReboundRejectionAgent.cacheStats.updates,
      hitRate: hitRate.toFixed(1) + '%',
      maxSize: ReboundRejectionAgent.MAX_CACHE_SIZE
    };
  }

  /*
   * AI-powered crypto volatility classification (cached for performance)
   */
  /*
  public classifyCryptoVolatility(baseCrypto: string): 'LOW_VOLATILITY' | 'MODERATE_VOLATILITY' | 'HIGH_VOLATILITY' | 'EXTREME_VOLATILITY' {
    // Check cache first - these classifications are static
    if (ReboundRejectionAgent.volatilityProfileCache.has(baseCrypto)) {
      return ReboundRejectionAgent.volatilityProfileCache.get(baseCrypto)!;
    }
    
    // Simplified robust classification without complex Sets
    const crypto = baseCrypto.toUpperCase();
    let profile: 'LOW_VOLATILITY' | 'MODERATE_VOLATILITY' | 'HIGH_VOLATILITY' | 'EXTREME_VOLATILITY';
    
    // Low volatility - stablecoins and large caps
    if (crypto === 'CRO' || crypto === 'BNB' || crypto === 'ADA' || crypto === 'XRP' || 
        crypto === 'TRX' || crypto === 'MATIC' || crypto === 'DOT' || crypto === 'ALGO' ||
        crypto === 'ATOM' || crypto === 'XLM' || crypto === 'LTC' || crypto === 'AVAX') {
      profile = 'LOW_VOLATILITY';
    }
    // Moderate volatility - established protocols  
    else if (crypto === 'ETH' || crypto === 'SOL' || crypto === 'LINK' || crypto === 'UNI' ||
        crypto === 'AAVE' || crypto === 'COMP' || crypto === 'ARB' || crypto === 'OP' ||
        crypto === 'APT' || crypto === 'SUI' || crypto === 'NEAR' || crypto === 'ICP') {
      profile = 'MODERATE_VOLATILITY';
    }
    // High volatility - meme coins and smaller caps
    else if (crypto === 'DOGE' || crypto === 'SHIB' || crypto === 'PEPE' || crypto === 'BONK' ||
        crypto === 'AVNT' || crypto === 'GMX' || crypto === 'INJ' || crypto === 'WIF') {
      profile = 'HIGH_VOLATILITY';
    }
    // Extreme volatility - Bitcoin and very speculative
    else if (crypto === 'BTC' || crypto === 'BCH' || crypto === 'BSV') {
      profile = 'EXTREME_VOLATILITY';
    }
    // Default for unknown cryptos
    else {
      profile = 'MODERATE_VOLATILITY';
    }
    
    // Cache the result for future use
    ReboundRejectionAgent.volatilityProfileCache.set(baseCrypto, profile);
    
    return profile;
  }
  */

  /**
   * 🧠 AI-Powered Adaptive RSI zones with intelligent caching
   * Analyzes real market data instead of hardcoded classifications
   */
  public async getIntelligentRSIZones(symbol: string, bias: 'long' | 'short'): Promise<{ min: number; max: number }> {
    const cached = await this.getIntelligentThresholds(symbol);
    return bias === 'long' ? cached.rsiZones.long : cached.rsiZones.short;
  }

  /**
   * 🧠 AI-Powered Adaptive ADX thresholds with market regime analysis
   */
  public async getIntelligentADXThresholds(symbol: string): Promise<{ minimum: number; moderate: number; strong: number }> {
    const cached = await this.getIntelligentThresholds(symbol);
    return cached.adxThresholds;
  }

  /**
   * 🧠 AI-Powered Adaptive EMA spread with volatility analysis
   */
  public async getIntelligentEMASpread(symbol: string): Promise<number> {
    const cached = await this.getIntelligentThresholds(symbol);
    return cached.emaSpreadRequired;
  }

  /**
   * 🧠 Core AI Analysis Engine - Analyzes market data to determine optimal thresholds
   */
  public async getIntelligentThresholds(symbol: string): Promise<{
    rsiZones: { long: { min: number; max: number }; short: { min: number; max: number } };
    adxThresholds: { minimum: number; moderate: number; strong: number };
    emaSpreadRequired: number;
    volatilityProfile: string;
    marketRegime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE';
    confidenceScore: number;
  }> {
    // Check intelligent cache first
    const cached = ReboundRejectionAgent.dynamicThresholdsCache.get(symbol);
    const now = Date.now();
    
    if (cached && (now - cached.lastUpdated) < ReboundRejectionAgent.INTELLIGENT_CACHE_TTL_MS) {
      ReboundRejectionAgent.intelligentCacheStats.hits++;
      console.log(`🧠 AI Cache HIT for ${symbol} (age: ${((now - cached.lastUpdated) / (60 * 60 * 1000)).toFixed(1)}h, confidence: ${cached.confidenceScore.toFixed(2)})`);
      return cached;
    }

    // Perform AI analysis
    console.log(`🧠 Performing AI market analysis for ${symbol}...`);
    ReboundRejectionAgent.intelligentCacheStats.aiAnalysis++;
    
    try {
      // Step 1: Analyze volatility metrics with extended data
      const volatilityMetrics = await this.analyzeIntelligentVolatility(symbol);
      
      // Step 2: Detect market regime (bull/bear/sideways)
      const marketRegime = await this.detectAIMarketRegime(symbol);
      
      // Step 3: Calculate optimal thresholds based on analysis
      const analysis = await this.calculateOptimalThresholds(symbol, volatilityMetrics, marketRegime);
      
      console.log(`🧠 AI Analysis complete for ${symbol}: ${analysis.volatilityProfile} profile, ${marketRegime} regime, ${analysis.confidenceScore.toFixed(2)} confidence`);
      
      // Cache the results
      ReboundRejectionAgent.dynamicThresholdsCache.set(symbol, {
        ...analysis,
        marketRegime,
        lastUpdated: now,
        dataPoints: 100, // We analyzed significant data
      });
      
      ReboundRejectionAgent.intelligentCacheStats.updates++;
      return { ...analysis, marketRegime };
      
    } catch (error) {
      console.error(`❌ AI Analysis failed for ${symbol}, falling back to static thresholds:`, error);
      
      // Fallback to enhanced static analysis
      return this.getEnhancedStaticThresholds(symbol);
    }
  }

  /**
   * 🧠 Analyzes intelligent volatility metrics using market data
   */
  public async analyzeIntelligentVolatility(symbol: string): Promise<any> {
    const cached = ReboundRejectionAgent.intelligentVolatilityCache.get(symbol);
    const now = Date.now();
    
    if (cached && (now - cached.lastAnalysis) < ReboundRejectionAgent.VOLATILITY_ANALYSIS_TTL_MS) {
      return cached;
    }

    try {
      // Get extended technical data for analysis
      const { buildTechSnapshot } = await import('../../ai/tech.js');
      const { getOHLCV } = await import('../../data/market.js');
      const snap = await buildTechSnapshot(symbol);
      
      // Get 30-day data for comprehensive analysis
      const ohlcv30d = await getOHLCV(symbol, '1d', 30);
      
      if (!ohlcv30d || ohlcv30d.length < 10) {
        throw new Error('Insufficient historical data');
      }
      
      // Calculate comprehensive volatility metrics
      const closes = ohlcv30d.map(bar => bar[4]);
      const volumes = ohlcv30d.map(bar => Number(bar[5] || 0));
      
      // Calculate ATR 30-day average
      const { atr } = await import('../../data/indicators.js');
      const atr30dArray = atr(ohlcv30d, 14);
      const atr30d = atr30dArray[atr30dArray.length - 1] || 0;
      const atr30dPct = (atr30d / snap.last) * 100;
      
      // Price stability (coefficient of variation)
      const priceMean = closes.reduce((sum, p) => sum + p, 0) / closes.length;
      const priceStdDev = Math.sqrt(closes.reduce((sum, p) => sum + Math.pow(p - priceMean, 2), 0) / closes.length);
      const priceCV = priceStdDev / priceMean;
      
      // Volume stability
      const volumeMean = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
      const volumeStdDev = Math.sqrt(volumes.reduce((sum, v) => sum + Math.pow(v - volumeMean, 2), 0) / volumes.length);
      const volumeCV = volumeStdDev / volumeMean;
      
      // Determine volatility profile based on real metrics
      let currentVolatility = 'MODERATE';
      if (atr30dPct > 4.0 || priceCV > 0.15) currentVolatility = 'HIGH';
      else if (atr30dPct < 1.5 && priceCV < 0.05) currentVolatility = 'LOW';
      
      const analysis = {
        currentVolatility: atr30dPct,
        volatilityTrend: (priceCV > 0.1 ? 'INCREASING' : priceCV < 0.05 ? 'DECREASING' : 'STABLE') as 'INCREASING' | 'DECREASING' | 'STABLE',
        volumeProfile: (volumeCV > 0.8 ? 'HIGH' : volumeCV < 0.3 ? 'LOW' : 'NORMAL') as 'HIGH' | 'NORMAL' | 'LOW',
        priceStability: Math.max(0, 1 - priceCV), // Higher = more stable
        lastAnalysis: now,
        rawMetrics: {
          atr30d: atr30dPct,
          volumeCV,
          priceCV,
          trendStrength: snap.adx14 || 0
        }
      };
      
      ReboundRejectionAgent.intelligentVolatilityCache.set(symbol, analysis);
      console.log(`📊 Volatility analysis for ${symbol}: ATR ${atr30dPct.toFixed(2)}%, CV ${priceCV.toFixed(3)}, Profile: ${currentVolatility}`);
      
      return analysis;
      
    } catch (error) {
      console.error(`❌ Volatility analysis failed for ${symbol}:`, error);
      // Return basic fallback
      return {
        currentVolatility: 2.0,
        volatilityTrend: 'STABLE',
        volumeProfile: 'NORMAL',
        priceStability: 0.7,
        lastAnalysis: now,
        rawMetrics: { atr30d: 2.0, volumeCV: 0.5, priceCV: 0.1, trendStrength: 15 }
      };
    }
  }

  /**
   * 🧠 Detects market regime for AI analysis (bull/bear/sideways) using technical analysis
   */
  public async detectAIMarketRegime(symbol: string): Promise<'BULL' | 'BEAR' | 'SIDEWAYS' | 'VOLATILE'> {
    try {
      const { buildTechSnapshot } = await import('../../ai/tech.js');
      const snap = await buildTechSnapshot(symbol);
      
      const emaSpread = ((snap.ema20 - snap.ema50) / snap.ema50) * 100;
      const adx = snap.adx14 || 0;
      const rsi = snap.rsi14 || 50;
      const atrPct = snap.atrPct || 0;
      
      // Regime detection logic
      if (atrPct > 4.0 && adx < 20) return 'VOLATILE'; // High volatility, low trend
      if (emaSpread > 2.0 && adx > 20 && rsi > 55) return 'BULL'; // Strong uptrend
      if (emaSpread < -2.0 && adx > 20 && rsi < 45) return 'BEAR'; // Strong downtrend
      return 'SIDEWAYS'; // Consolidation
      
    } catch (error) {
      console.error(`❌ Market regime detection failed for ${symbol}:`, error);
      return 'SIDEWAYS';
    }
  }

  /**
   * 🧠 Calculates optimal thresholds based on AI analysis
   */
  public async calculateOptimalThresholds(symbol: string, volatilityMetrics: any, marketRegime: string): Promise<any> {
    const atr = volatilityMetrics.rawMetrics.atr30d;
    const priceCV = volatilityMetrics.rawMetrics.priceCV;
    const trendStrength = volatilityMetrics.rawMetrics.trendStrength;
    
    // AI-driven threshold calculation
    let volatilityProfile = 'MODERATE';
    if (atr > 4.0 || priceCV > 0.15) volatilityProfile = 'HIGH_VOLATILITY';
    else if (atr < 1.5 && priceCV < 0.05) volatilityProfile = 'LOW_VOLATILITY';
    
    // Calculate RSI zones based on volatility and regime
    const rsiAdjustment = marketRegime === 'VOLATILE' ? 10 : marketRegime === 'BULL' ? 5 : 0;
    let rsiZones;
    
    if (volatilityProfile === 'HIGH_VOLATILITY') {
      rsiZones = {
        long: { min: 30 + rsiAdjustment, max: 80 },
        short: { min: 20, max: 70 - rsiAdjustment }
      };
    } else if (volatilityProfile === 'LOW_VOLATILITY') {
      rsiZones = {
        long: { min: 45, max: 65 },
        short: { min: 35, max: 55 }
      };
    } else {
      rsiZones = {
        long: { min: 40, max: 70 },
        short: { min: 30, max: 60 }
      };
    }
    
    // Calculate ADX thresholds
    const adxBase = volatilityProfile === 'HIGH_VOLATILITY' ? [8, 14, 20] : 
                    volatilityProfile === 'LOW_VOLATILITY' ? [15, 22, 30] : [12, 18, 25];
    
    const adxThresholds = {
      minimum: adxBase[0],
      moderate: adxBase[1],
      strong: adxBase[2]
    };
    
    // Calculate EMA spread requirement
    const baseSpread = 0.5;
    const spreadMultiplier = volatilityProfile === 'HIGH_VOLATILITY' ? 1.5 : 
                            volatilityProfile === 'LOW_VOLATILITY' ? 0.7 : 1.0;
    const emaSpreadRequired = baseSpread * spreadMultiplier;
    
    // Confidence score based on data quality
    const confidenceScore = Math.min(1.0, 
      0.7 + // Base confidence
      (volatilityMetrics.priceStability * 0.2) + // Data stability bonus
      (trendStrength > 15 ? 0.1 : 0) // Trend clarity bonus
    );
    
    return {
      rsiZones,
      adxThresholds,
      emaSpreadRequired,
      volatilityProfile,
      confidenceScore
    };
  }

  /**
   * 🧠 Synchronous intelligent EMA spread for diagnostics
   */
  public getIntelligentEMASpreadSync(symbol: string): number {
    const profile = this.getCryptoVolatilityProfile(symbol);
    const baseSpread = 0.5;
    
    // Simple intelligent logic without async complexity
    switch (profile) {
      case 'HIGH_VOLATILITY': // AVNT
        return baseSpread * 1.5; // 0.75% pour les volatiles
      case 'LOW_VOLATILITY': // BTC
        return baseSpread * 0.7; // 0.35% pour les stables
      default:
        return baseSpread; // 0.5% standard
    }
  }

  /**
   * 🧠 Synchronous intelligent ADX thresholds for diagnostics
   */
  public getIntelligentADXThresholdsSync(symbol: string): { minimum: number; moderate: number; strong: number } {
    const profile = this.getCryptoVolatilityProfile(symbol);
    
    let thresholds = { minimum: 12, moderate: 18, strong: 25 }; // Standard defaults
    
    switch (profile) {
      case 'HIGH_VOLATILITY': // AVNT, volatiles
        thresholds = { minimum: 10, moderate: 16, strong: 22 }; // Plus bas pour volatiles
        break;
      case 'LOW_VOLATILITY': // BTC, majors
        thresholds = { minimum: 15, moderate: 20, strong: 28 }; // Plus haut pour stables
        break;
      default:
        thresholds = { minimum: 12, moderate: 18, strong: 25 }; // Standard
        break;
    }
    
    // Apply performance-based adaptation multipliers
    if (this.performanceMetrics && this.plan) {
      const strategy = this.plan.bias || 'long';
      const bias = strategy === 'long' ? 'long' : 'short';
      const multipliers = this.getAdaptationMultipliers(strategy, bias);
      
      // Apply ADX multiplier based on strategy performance
      thresholds.minimum *= multipliers.adx;
      thresholds.moderate *= multipliers.adx;
      thresholds.strong *= multipliers.adx;
      
      console.log(`🎯 Performance-adapted ADX for ${symbol} (${strategy}_${bias}): min=${thresholds.minimum.toFixed(1)}, mod=${thresholds.moderate.toFixed(1)}, str=${thresholds.strong.toFixed(1)} (multiplier: ${multipliers.adx.toFixed(2)})`);
    }
    
    return thresholds;
  }

  /**
   * 🧠 Synchronous intelligent RSI zones for diagnostics
   */
  public getIntelligentRSIZonesSync(symbol: string, bias: 'long' | 'short'): { min: number; max: number } {
    const profile = this.getCryptoVolatilityProfile(symbol);
    
    if (bias === 'long') {
      switch (profile) {
        case 'HIGH_VOLATILITY': // AVNT, DOGE, meme coins
          return { min: 35, max: 75 }; // Plus large pour cryptos volatiles
        case 'LOW_VOLATILITY': // BTC, majors
          return { min: 45, max: 65 }; // Plus serré pour stables
        default:
          return { min: 40, max: 70 }; // Standard
      }
    } else { // short bias
      switch (profile) {
        case 'HIGH_VOLATILITY':
          return { min: 25, max: 65 }; // Plus large pour volatiles
        case 'LOW_VOLATILITY':
          return { min: 35, max: 55 }; // Plus serré
        default:
          return { min: 30, max: 60 }; // Standard
      }
    }
  }

  /**
   * 🧠 Enhanced static thresholds as fallback
   */
  public getEnhancedStaticThresholds(symbol: string): any {
    const rawProfile = this.getCryptoVolatilityProfile(symbol);
    const profile = rawProfile === 'MEME_VOLATILITY' ? 'HIGH_VOLATILITY' : rawProfile;

    return {
      rsiZones: {
        long: profile === 'HIGH_VOLATILITY' ? { min: 35, max: 75 } :
              profile === 'LOW_VOLATILITY' ? { min: 45, max: 65 } : { min: 40, max: 70 },
        short: profile === 'HIGH_VOLATILITY' ? { min: 25, max: 65 } :
               profile === 'LOW_VOLATILITY' ? { min: 35, max: 55 } : { min: 30, max: 60 }
      },
      adxThresholds: profile === 'HIGH_VOLATILITY' ? { minimum: 10, moderate: 16, strong: 22 } :
                     profile === 'LOW_VOLATILITY' ? { minimum: 15, moderate: 20, strong: 28 } :
                     { minimum: 12, moderate: 18, strong: 25 },
      emaSpreadRequired: profile === 'HIGH_VOLATILITY' ? 0.75 :
                        profile === 'LOW_VOLATILITY' ? 0.35 : 0.5,
      volatilityProfile: profile,
      confidenceScore: 0.6
    };
  }

  /**
   * Helper method to get crypto volatility profile (reusing existing logic)
   */
  public normalizeVolatilityProfile(profile: string | null | undefined): string | null {
    if (!profile || typeof profile !== 'string') return null;
    const trimmed = profile.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (upper === 'MODERATE') return 'MODERATE_VOLATILITY';
    if (upper === 'MEME') return 'MEME_VOLATILITY';
    if (upper.endsWith('_VOLATILITY')) return upper;
    if (['HIGH', 'LOW', 'EXTREME', 'MODERATE'].includes(upper)) {
      return upper === 'MODERATE' ? 'MODERATE_VOLATILITY' : `${upper}_VOLATILITY`;
    }
    return upper;
  }

  public resolveVolatilityProfileForFilters(): string | null {
    const metaProfile = this.normalizeVolatilityProfile((this.plan?.plan?.meta as any)?.volatilityProfile);
    if (metaProfile) return metaProfile;

    const regimeProfile = this.normalizeVolatilityProfile((this.regime as any)?.volatilityProfile);
    if (regimeProfile) return regimeProfile;

    if (this.profile?.symbol) {
      const cached = ReboundRejectionAgent.dynamicThresholdsCache.get(this.profile.symbol);
      const cachedProfile = this.normalizeVolatilityProfile(cached?.volatilityProfile);
      if (cachedProfile) return cachedProfile;
      const fallback = this.normalizeVolatilityProfile(this.getCryptoVolatilityProfile(this.profile.symbol));
      if (fallback) return fallback;
    }

    return null;
  }

  public isMemeCoin(symbol?: string | null): boolean {
    if (!symbol) return false;
    const base = symbol.split('/')[0]?.toUpperCase();
    return !!(base && ReboundRejectionAgent.memeSymbols.has(base));
  }

  public resolveAiBiasOverrideTtlMs(): number {
    const mode = this.profile?.aggressiveness || 'reactive';
    if (mode === 'aggressive') return 8 * 60 * 1000;
    if (mode === 'conservative') return 5 * 60 * 1000;
    return 7 * 60 * 1000;
  }

  public clearAiBiasOverride(reason?: string): void {
    if (!this.aiBiasOverride) return;
    const { originalBias } = this.aiBiasOverride;
    if (reason) {
      console.log(`🧠 Clearing AI bias override (${reason})`);
    }
    if (this.plan && originalBias && this.plan.bias !== originalBias) {
      console.log(`🧠 Restoring plan bias to ${originalBias}`);
      this.plan.bias = originalBias;
    }
    this.aiBiasOverride = null;
  }

  public applyActiveAIBiasOverride(_currentPrice: number, snap?: TechnicalSnapshot | null): void {
    if (!this.plan || !this.aiBiasOverride) return;

    const now = Date.now();
    if (now > this.aiBiasOverride.expiresAt) {
      this.clearAiBiasOverride('override_expired');
      return;
    }

    if (snap?.regime?.playbook === 'standby') {
      this.clearAiBiasOverride('regime_standby');
      return;
    }

    if (this.plan.bias !== this.aiBiasOverride.bias) {
      this.plan.bias = this.aiBiasOverride.bias;
    }
  }

  public checkStrongTrend(snap: TechnicalSnapshot, bias: 'long' | 'short' | 'none'): StrongTrendAssessment {
    const adx = Number((snap as any)?.adx14 ?? 0);
    const ema20 = Number((snap as any)?.ema20 ?? snap.last);
    const ema50 = Number((snap as any)?.ema50 ?? snap.last);
    const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
    const emaSpreadPct = ema50 !== 0 ? ((ema20 - ema50) / Math.abs(ema50)) * 100 : 0;
    const emaSlopePct = ema20 !== 0 ? (emaSlope / ema20) * 100 : 0;
    const hurst = Number.isFinite((snap as any)?.hurst) ? Number((snap as any)?.hurst) : undefined;
    const trendBias = ema20 > ema50 ? 'long' : ema20 < ema50 ? 'short' : 'none';
    const multiTimeframeAgreement = (snap.trendBias === 'bullish' && trendBias === 'long')
      || (snap.trendBias === 'bearish' && trendBias === 'short');

    const absSpread = Math.abs(emaSpreadPct);
    const absSlope = Math.abs(emaSlopePct);
    const reasons: string[] = [];

    if (adx >= 25) reasons.push(`adx_${adx.toFixed(1)}`);
    if (absSpread >= 0.8) reasons.push(`ema_spread_${absSpread.toFixed(2)}%`);
    if (absSlope >= 0.08) reasons.push(`slope_${absSlope.toFixed(2)}%`);
    if (multiTimeframeAgreement) reasons.push('htf_alignment');
    if (hurst != null && hurst > 0.58) reasons.push(`hurst_${hurst.toFixed(2)}`);

    const strong = adx >= 27 && absSpread >= 1 && absSlope >= 0.08;
    const moderate = !strong && adx >= 20 && absSpread >= 0.6 && absSlope >= 0.05;
    const direction = strong || moderate ? trendBias : 'none';

    const adxFactor = Math.max(0, Math.min(1, (adx - 15) / 20));
    const spreadFactor = Math.max(0, Math.min(1, absSpread / 2.2));
    const slopeFactor = Math.max(0, Math.min(1, absSlope / 0.18));
    const hurstFactor = hurst != null ? Math.max(0, Math.min(1, (hurst - 0.45) / 0.35)) : 0.5;
    const alignmentFactor = multiTimeframeAgreement ? 1 : 0.4;

    const confidence = Number((
      0.32 * adxFactor
      + 0.28 * spreadFactor
      + 0.16 * slopeFactor
      + 0.12 * hurstFactor
      + 0.12 * alignmentFactor
    ).toFixed(3));

    if (direction === 'none' && bias !== 'none' && (strong || moderate)) {
      reasons.push(`bias_${bias}_override`);
    }

    return {
      strong,
      moderate,
      direction,
      confidence,
      adx,
      emaSpreadPct,
      emaSlopePct,
      hurst,
      reasons,
      multiTimeframeAgreement,
    };
  }

  private refreshEntryDiagnosticsForContext(
    snap: TechnicalSnapshot,
    playbook: 'trend_following' | 'mean_reversion' | 'momentum_breakout'
  ): void {
    if (!this.profile) {
      this.resetQualityPreview();
      return;
    }

    const aggressiveness = this.profile.aggressiveness ?? 'reactive';
    try {
      const profile = this.getQualityScoreProfile(playbook, aggressiveness);
      const diagnostics = this.getQualityFiltersDiagnostics(snap);
      const assessment = this.assessQualityScore(diagnostics, 0, {
        weights: profile.weights,
        majorityRatio: profile.majorityRatio,
        partialCredit: profile.partialCredit,
        minPassCount: profile.minPassCount,
        comboTolerance: profile.comboTolerance,
      }) as QualityAssessmentSnapshot;
      this.previewQualityDiagnostics = {
        snapshotKey: this.getQualitySnapshotKey(snap),
        data: diagnostics,
        assessment,
      };
    } catch (error) {
      console.warn('Failed to refresh entry diagnostics on market context shift:', error);
      this.resetQualityPreview();
    }
  }

  private handleMarketContextShift(
    previous: MarketContext | null,
    next: MarketContext,
    snap: TechnicalSnapshot
  ): void {
    const directionChanged =
      previous != null &&
      previous.direction !== next.direction &&
      previous.direction !== 'none' &&
      next.direction !== 'none';
    const playbookChanged = previous != null && previous.effectivePlaybook !== next.effectivePlaybook;
    const trendStateChanged =
      previous != null && (previous.strongTrend !== next.strongTrend || previous.moderateTrend !== next.moderateTrend);

    if (!previous) {
      this.refreshEntryDiagnosticsForContext(snap, next.effectivePlaybook);
    } else if (directionChanged || playbookChanged || trendStateChanged) {
      recordOpsEvent({
        level: 'info',
        source: 'market_context',
        message: 'market_context_shift',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          fromDirection: previous.direction,
          toDirection: next.direction,
          fromPlaybook: previous.effectivePlaybook,
          toPlaybook: next.effectivePlaybook,
          fromStrongTrend: previous.strongTrend,
          toStrongTrend: next.strongTrend,
          fromModerateTrend: previous.moderateTrend,
          toModerateTrend: next.moderateTrend,
        },
      });
      console.log(
        `🧭 Market context shift detected | dir ${previous.direction}→${next.direction} | playbook ${previous.effectivePlaybook}` +
          `→${next.effectivePlaybook} | trend strong ${previous.strongTrend}→${next.strongTrend}`
      );
      this.resetQualityPreview();
      this.refreshEntryDiagnosticsForContext(snap, next.effectivePlaybook);
      this.lastMomentumGateResult = null;
      this.resetMomentumAwaitContext();
    }

    this.lastMarketContextSignature = {
      direction: next.direction,
      playbook: next.effectivePlaybook,
      updatedAt: Date.now(),
    };
  }

  public resolveMarketContext(
    snap: TechnicalSnapshot,
    basePlaybook: string,
    bias: 'long' | 'short' | 'none'
  ): MarketContext {
    const assessment = this.checkStrongTrend(snap, bias);
    const hurst = assessment.hurst ?? (Number.isFinite((snap as any)?.hurst) ? Number((snap as any)?.hurst) : undefined);
    const regimeTrend = snap.regime?.trend ?? null;
    const externalPlaybook = snap.regime?.playbook ?? null;
    const trendStrength = Number((snap as any)?.trendStrength ?? Math.abs(assessment.emaSpreadPct));
    const ema20Value = Number.isFinite((snap as any)?.ema20) ? Number((snap as any)?.ema20) : Number(snap.last ?? 0);
    const ema50Value = Number.isFinite((snap as any)?.ema50) ? Number((snap as any)?.ema50) : Number(snap.last ?? 0);
    const ema20Slope = Number.isFinite((snap as any)?.ema20Slope) ? Number((snap as any)?.ema20Slope) : 0;
    const slopeBasis = Math.abs(ema20Value) > 1e-8 ? Math.abs(ema20Value) : Math.abs(Number(snap.last ?? ema20Value));
    const slopePct = slopeBasis > 0 ? (ema20Slope / slopeBasis) * 100 : 0;

    let regime: MarketContext['regime'];
    if (assessment.strong) {
      regime = 'trend_following';
    } else if (basePlaybook === 'momentum_breakout' || externalPlaybook === 'momentum_breakout') {
      regime = assessment.moderate ? 'breakout' : 'range';
    } else if (regimeTrend === 'range' || trendStrength < 0.25 || (hurst != null && hurst < 0.48) || assessment.adx < 18) {
      regime = 'range';
    } else if (assessment.moderate) {
      regime = 'trend_following';
    } else {
      regime = regimeTrend === 'uptrend' || regimeTrend === 'downtrend' ? 'trend_following' : 'range';
    }

    if (regime === 'range' && (externalPlaybook === 'momentum_breakout' || basePlaybook === 'momentum_breakout') && assessment.moderate) {
      regime = 'breakout';
    }

    let effectivePlaybook: MarketContext['effectivePlaybook'] = regime === 'range'
      ? 'mean_reversion'
      : regime === 'breakout'
        ? 'momentum_breakout'
        : 'trend_following';

    const notes = assessment.reasons.slice();
    const emaAligned = bias === 'long'
      ? ema20Value >= ema50Value
      : bias === 'short'
        ? ema20Value <= ema50Value
        : true;
    const slopeAgainst = bias === 'long'
      ? slopePct <= 0
      : bias === 'short'
        ? slopePct >= 0
        : slopePct === 0;
    const trendStrengthOk = trendStrength > 0.25;

    if (effectivePlaybook === 'trend_following' && (!emaAligned || slopeAgainst || !trendStrengthOk)) {
      notes.push('trend_following_downgraded_due_to_slope');
      regime = 'range';
      effectivePlaybook = 'mean_reversion';
    }

    let allowMomentumOverride = regime !== 'range' && (assessment.strong || regime === 'breakout');
    let favorMeanReversion = regime === 'range';
    if (regime === 'range') notes.push('range_structure_detected');
    if (regime === 'trend_following' && !assessment.strong && assessment.moderate) notes.push('moderate_trend_following');
    if (externalPlaybook && externalPlaybook !== effectivePlaybook) {
      notes.push(`regime_playbook=${externalPlaybook}`);
    }
    if (basePlaybook !== effectivePlaybook) {
      notes.push(`playbook_adjusted:${basePlaybook}->${effectivePlaybook}`);
    }

    const recognizedStrategies = evaluateRecognizedStrategies(snap, {
      bias,
      regime,
      allowMomentumOverride,
      favorMeanReversion,
    });

    const targetBias: 'long' | 'short' | 'none' = bias !== 'none'
      ? bias
      : assessment.direction;
    const prioritized = recognizedStrategies
      .filter(signal => signal.active && (signal.bias === targetBias || signal.bias === 'both'))
      .sort((a, b) => b.confidence - a.confidence);
    const primaryStrategy = prioritized[0] ?? recognizedStrategies[0] ?? null;

    if (primaryStrategy) {
      notes.push(`recognized_primary=${primaryStrategy.id}:${primaryStrategy.bias}:${primaryStrategy.confidence.toFixed(2)}`);
    }

    const previousContext = this.marketContext;
    const context: MarketContext = {
      regime,
      basePlaybook,
      effectivePlaybook,
      strongTrend: assessment.strong,
      moderateTrend: assessment.moderate,
      direction: assessment.direction,
      allowMomentumOverride,
      favorMeanReversion,
      confidence: assessment.confidence,
      notes,
      hurst,
      trendStrength,
      adx: assessment.adx,
      recognizedStrategies,
      primaryStrategy,
    };

    this.handleMarketContextShift(previousContext, context, snap);
    this.marketContext = context;
    return context;
  }

  public getContextualPlaybook(
    snap?: TechnicalSnapshot | null,
    bias?: 'long' | 'short' | 'none'
  ): { playbook: string; context: MarketContext | null; basePlaybook: string } {
    const fallbackRaw = ((this.plan?.plan?.meta?.playbook as string | undefined)
      ?? (this.regime?.playbook as string | undefined)
      ?? 'mean_reversion') as string;
    const fallback = (['trend_following', 'momentum_breakout', 'mean_reversion'].includes(fallbackRaw)
      ? fallbackRaw
      : 'mean_reversion') as 'trend_following' | 'momentum_breakout' | 'mean_reversion';

    if (snap) {
      const context = this.resolveMarketContext(snap, fallback, bias ?? (this.plan?.bias ?? 'none'));
      return { playbook: context.effectivePlaybook, context, basePlaybook: fallback };
    }

    const context = this.marketContext;
    return {
      playbook: context?.effectivePlaybook ?? fallback,
      context: context ?? null,
      basePlaybook: context?.basePlaybook ?? fallback,
    };
  }

  public getCryptoVolatilityProfile(symbol: string): 'HIGH_VOLATILITY' | 'MODERATE' | 'LOW_VOLATILITY' | 'MEME_VOLATILITY' {
    const baseCrypto = symbol.split('/')[0]?.toUpperCase();
    if (!baseCrypto) return 'MODERATE';

    // Reuse existing volatility classification logic
    if (ReboundRejectionAgent.memeSymbols.has(baseCrypto)) {
      return 'MEME_VOLATILITY';
    }
    if (['BTC', 'USDC', 'USDT', 'DAI'].includes(baseCrypto)) {
      return 'LOW_VOLATILITY';
    }
    return 'MODERATE'; // ETH, BNB, ADA, etc.
  }

  public evaluateMomentumGates(
    snap: TechnicalSnapshot,
    reasonHint: 'enter' | 'reverse',
    emitEvents = true
  ): MomentumGateEvaluation {
    const thresholds = this.effectiveEntryThresholds();
    const memeBias = this.isMemeCoin(this.profile?.symbol);
    const quantFilters = this.quantConfig?.filters;
    const bias = this.plan?.bias || 'none';
    const { playbook, context } = this.getContextualPlaybook(snap, bias);

    const snapshotId = (snap as any)?.id ?? (snap as any)?.snapshotId ?? null;
    const tfLTF = snap.meta?.tf ?? (snap.meta as any)?.ltf ?? null;
    const tfHTF = (snap.meta as any)?.htf ?? null;
    const tfLower = typeof tfLTF === 'string' ? tfLTF.toLowerCase() : null;
    let tfMinutes: number | null = null;
    if (tfLower) {
      const match = tfLower.match(/(\d+)\s*(m|min)/);
      if (match) {
        const parsed = Number(match[1]);
        tfMinutes = Number.isFinite(parsed) ? parsed : null;
      }
    }
    const isLowerTimeframeBreakout = playbook === 'momentum_breakout' && (
      (tfLower != null && (tfLower.includes('ltf') || tfLower.includes('scalp')))
      || (tfMinutes != null && tfMinutes <= 15)
    );
    console.log(
      `🧭 Momentum gates check | playbook=${playbook} bias=${bias} snapshot=${snapshotId ?? 'n/a'} ` +
      `tf=${tfLTF ?? 'n/a'} htf=${tfHTF ?? 'n/a'} regime=${context?.regime ?? 'n/a'} ` +
      `trend=${context?.strongTrend ? 'strong' : context?.moderateTrend ? 'moderate' : 'weak'} conf=${context?.confidence ?? 0}`,
    );

    let minAtr = thresholds.ENTRY_MIN_ATR_PCT;
    let minSlopeAbsPct = Math.max(0.0002, thresholds.ENTRY_MIN_SLOPE_ABS_PCT);

    if (quantFilters) {
      if (Number.isFinite(quantFilters.minAtrPct)) {
        const cfgAtr = Math.max(0.05, Number(quantFilters.minAtrPct));
        minAtr = Math.min(minAtr, cfgAtr);
      }

      const rrReferenceRaw = this.currentRrMin ?? (Number.isFinite(quantFilters.minRr) ? Number(quantFilters.minRr) : undefined);
      if (Number.isFinite(rrReferenceRaw)) {
        const rrTightness = Math.max(1, Number(rrReferenceRaw));
        const relaxedSlope = Math.max(0.0003, minSlopeAbsPct * (rrTightness >= 1.5 ? 0.75 : 0.85));
        minSlopeAbsPct = Math.min(minSlopeAbsPct, relaxedSlope);
      } else {
        minSlopeAbsPct = Math.min(minSlopeAbsPct, 0.0012);
      }
    } else {
      minSlopeAbsPct = Math.min(minSlopeAbsPct, 0.0012);
    }

    if (memeBias) {
      minAtr = Math.max(0.06, minAtr * 0.9);
      minSlopeAbsPct = Math.max(0.00005, minSlopeAbsPct * 0.8);
    }

    if (context?.regime === 'trend_following') {
      const atrFactor = context.strongTrend ? 0.9 : 0.95;
      const slopeFactor = context.strongTrend ? 0.75 : 0.85;
      minAtr = Math.max(0.05, minAtr * atrFactor);
      minSlopeAbsPct = Math.max(0.00015, minSlopeAbsPct * slopeFactor);
    } else if (context?.regime === 'range') {
      minAtr *= 1.1;
      minSlopeAbsPct *= 1.2;
    }

    if (playbook === 'momentum_breakout') {
      minAtr *= 1.15;
      minSlopeAbsPct *= 1.05;
    } else if (playbook === 'trend_following') {
      minSlopeAbsPct = Math.max(0.0002, minSlopeAbsPct * 0.85);
    }

    minSlopeAbsPct = Math.max(0.0002, Math.min(minSlopeAbsPct, 0.0025));

    const adxValue = Number((snap as any)?.adx14 ?? 0);
    const baseAdxRequirement = this.plan?.bias === 'short'
      ? thresholds.ENTRY_SHORT_MIN_ADX
      : thresholds.ENTRY_LONG_MIN_ADX;
    let minAdxRequired = quantFilters && Number.isFinite(quantFilters.minAdx)
      ? Math.min(baseAdxRequirement, Number(quantFilters.minAdx))
      : baseAdxRequirement;

    if (memeBias) {
      minAdxRequired = Math.max(8, minAdxRequired - 2);
    }

    if (context?.regime === 'trend_following') {
      minAdxRequired = Math.max(8, minAdxRequired - (context.strongTrend ? 4 : 2));
    } else if (context?.regime === 'range') {
      minAdxRequired = Math.min(40, minAdxRequired + 2);
    } else if (context?.regime === 'breakout') {
      minAdxRequired = Math.max(10, minAdxRequired - 1);
    }

    const reasons: string[] = [];

    if (adxValue > 0 && adxValue < minAdxRequired) {
      reasons.push(`adx_too_low ${adxValue.toFixed(2)} < ${minAdxRequired.toFixed(2)}`);
      if (emitEvents) {
        recordOpsEvent({
          level: 'info',
          source: 'entry_gate',
          message: 'adx_too_low',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { adx: adxValue, min: minAdxRequired, reason: reasonHint },
        });
      }
    }

    try {
      const sym = this.profile?.symbol || '';
      const adaptedMinAtr = this.getAdaptiveATRThresholdSync(sym, minAtr);
      if (adaptedMinAtr !== minAtr) {
        if (emitEvents) {
          console.log(`🎯 Adaptive ATR for ${sym}: ${minAtr.toFixed(3)}% → ${adaptedMinAtr.toFixed(3)}%`);
        }
        minAtr = adaptedMinAtr;
      }
      this.updateAdaptiveATRCache(sym, minAtr).catch(err =>
        console.warn('Background ATR cache update failed:', err)
      );
    } catch (error) {
      console.error('Error in adaptive ATR calculation:', error);
    }

    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const ema20 = Number((snap as any)?.ema20 ?? snap.last);
    const ema50 = Number((snap as any)?.ema50 ?? snap.last);
    const emaVal = Number((snap as any)?.ema20 ?? snap.last ?? 0);
    const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
    const slopeAbs = emaVal !== 0 ? Math.abs(emaSlope / emaVal) : 0;

    let minSlopeRequirement = minSlopeAbsPct;
    let slopeFloor = playbook === 'momentum_breakout' ? 0.0007 : playbook === 'trend_following' ? 0.0002 : 0.0004;
    if (isLowerTimeframeBreakout && adxValue > minAdxRequired) {
      const floorHeadroom = Math.max(0, adxValue - minAdxRequired - 3);
      if (floorHeadroom > 0) {
        const floorRelax = Math.min(0.00022, floorHeadroom * 0.00002);
        slopeFloor = Math.max(0.00045, slopeFloor - floorRelax);
      }
    }
    const relaxedMultiplier = playbook === 'momentum_breakout' ? 0.7 : playbook === 'trend_following' ? 0.5 : 0.55;
    const relaxation = playbook === 'momentum_breakout' ? 0.0003 : playbook === 'trend_following' ? 0.00015 : 0.0005;
    minSlopeRequirement = Math.max(
      slopeFloor,
      Math.min(minSlopeAbsPct * relaxedMultiplier, Math.max(minSlopeAbsPct - relaxation, slopeFloor))
    );

    if (isLowerTimeframeBreakout && adxValue > minAdxRequired) {
      const headroom = adxValue - minAdxRequired;
      const effectiveHeadroom = Math.max(0, headroom - 2);
      if (effectiveHeadroom > 0) {
        const relaxFactor = Math.min(0.24, effectiveHeadroom * 0.018);
        const relaxedSlope = Math.max(slopeFloor, minSlopeRequirement * (1 - relaxFactor));
        minSlopeRequirement = Math.min(minSlopeRequirement, relaxedSlope);
      }
    }

    if (slopeAbs < minSlopeRequirement) {
      const slopePct = slopeAbs * 100;
      const minSlopePct = minSlopeRequirement * 100;
      reasons.push(`slope_too_flat ${slopePct.toFixed(3)}% < ${minSlopePct.toFixed(3)}%`);
      if (emitEvents) {
        recordOpsEvent({
          level: 'info',
          source: 'entry_gate',
          message: 'slope_too_flat',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { slopeAbs, min: minSlopeRequirement, slopePct, minSlopePct, reason: reasonHint },
        });
      }
    }

    if (atrPct < minAtr) {
      const atrDeficit = minAtr - atrPct;
      const momentumPct = Math.abs(Number((snap as any)?.momentumPct ?? 0));
      const trendAligned = this.checkTrendAlignment(ema20, ema50, bias, {
        atrPct,
        adx: adxValue,
        playbook,
        price: snap.last,
      });
      const strongAdx = adxValue >= Math.max(minAdxRequired, 25);
      const atrBuffer = playbook === 'momentum_breakout' ? 0.5 : playbook === 'trend_following' ? 0.4 : 0.8;
      const allowFlexibility = (
        trendAligned &&
        strongAdx &&
        momentumPct >= (playbook === 'momentum_breakout' ? 1.5 : 0.75) &&
        atrDeficit <= atrBuffer
      );

      if (!allowFlexibility) {
        reasons.push(`atr_too_low ${atrPct.toFixed(3)}% < ${minAtr.toFixed(3)}%`);
        if (emitEvents) {
        recordOpsEvent({
          level: 'info',
          source: 'entry_gate',
          message: 'atr_too_low',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { atrPct, min: minAtr, minPct: minAtr, reason: reasonHint },
        });
      }
      }
    }

    const playbookLower = playbook.toLowerCase();
    let overrideApplied = false;
    let strongTrendOverride = false;
    let recognizedOverride: RecognizedStrategySignal | null = null;
    let status: 'PASS' | 'SOFT_FAIL' | 'FAIL';
    if (reasons.length === 0) {
      status = 'PASS';
    } else if (context?.allowMomentumOverride && context.confidence >= 0.55) {
      const overrideable = reasons.every(reason => (
        reason.startsWith('atr_too_low')
        || reason.startsWith('slope_too_flat')
        || reason.startsWith('adx_too_low')
      ));
      if (overrideable) {
        status = 'PASS';
        overrideApplied = true;
        strongTrendOverride = context.strongTrend || (context.moderateTrend && context.regime !== 'range');
      } else {
        status = playbookLower === 'trend_following' ? 'SOFT_FAIL' : 'FAIL';
      }
    } else {
      status = playbookLower === 'trend_following' ? 'SOFT_FAIL' : 'FAIL';
    }

    if (status !== 'PASS') {
      const recognizedSignals = context?.recognizedStrategies ?? [];
      const targetBias = bias !== 'none' ? bias : context?.direction ?? 'none';
      if (targetBias !== 'none' && recognizedSignals.length > 0) {
        const supportiveSignals = recognizedSignals
          .filter(signal => signal.active && (signal.bias === targetBias || signal.bias === 'both'))
          .sort((a, b) => b.confidence - a.confidence);
        const candidate = supportiveSignals[0];
        if (candidate) {
          const overrideable = reasons.every(reason => (
            reason.startsWith('atr_too_low')
            || reason.startsWith('slope_too_flat')
            || reason.startsWith('adx_too_low')
            || reason.startsWith('volatility')
            || reason.startsWith('rsi')
          ));
          const confidenceThreshold = candidate.id === 'bollinger_mean_reversion' ? 0.5 : 0.6;
          if (overrideable && candidate.confidence >= confidenceThreshold) {
            status = 'PASS';
            overrideApplied = true;
            recognizedOverride = candidate;
            if (!context?.notes?.includes('recognized_strategy_override')) {
              context?.notes?.push('recognized_strategy_override');
            }
            console.log(
              `✅ Recognized strategy ${candidate.id} (${candidate.bias}) override applied ` +
              `with confidence ${candidate.confidence.toFixed(2)}`,
            );
          }
        }
      }
    }

    const result: MomentumGateEvaluation = {
      pass: status === 'PASS',
      status,
      reasons,
      details: {
        snapshotId: (snap as any)?.id ?? (snap as any)?.snapshotId ?? null,
        candleTime: (snap as any)?.candleTime ?? null,
        tfLTF: snap.meta?.tf ?? null,
        tfHTF: (snap.meta as any)?.htf ?? null,
        atrPct,
        minAtr,
        adx: adxValue,
        minAdx: minAdxRequired,
        slopePctAbs: slopeAbs,
        slopePct: slopeAbs * 100,
        minSlope: minSlopeRequirement,
        minSlopePct: minSlopeRequirement * 100,
        playbook,
        bias,
        reasonHint,
        overrideApplied,
        context: context ?? null,
        strongTrendOverride,
        recognizedOverrideId: recognizedOverride?.id ?? null,
        recognizedOverrideConfidence: recognizedOverride?.confidence ?? null,
      },
    };

    this.lastMomentumGateResult = result;
    return result;
  }

  public passesEntryMomentumGates(
    snap: TechnicalSnapshot,
    reasonHint: 'enter' | 'reverse',
    options?: { emitEvents?: boolean; allowSoft?: boolean }
  ): boolean {
    const { emitEvents = true, allowSoft = true } = options ?? {};
    const evaluation = this.evaluateMomentumGates(snap, reasonHint, emitEvents);
    if (!evaluation.pass && evaluation.details.overrideApplied) {
      console.log('⚡ Strong trend override applied to momentum gates');
      return true;
    }
    if (!evaluation.pass && evaluation.status === 'SOFT_FAIL') {
      return allowSoft;
    }
    return evaluation.pass;
  }

  public assessTrendPullbackStructure(price: number, ema20: number, ema50: number, bias: 'long' | 'short') {
    const distanceToEma20 = Number.isFinite(ema20) && ema20 !== 0 ? ((price - ema20) / ema20) * 100 : Number.NaN;
    const distanceToEma50 = Number.isFinite(ema50) && ema50 !== 0 ? ((price - ema50) / ema50) * 100 : Number.NaN;

    if (!Number.isFinite(distanceToEma20) || !Number.isFinite(distanceToEma50)) {
      return { ok: false, distanceToEma20, distanceToEma50, reason: 'missing_ema' };
    }

    if (bias === 'long') {
      const nearEma20 = distanceToEma20 >= -2.6 && distanceToEma20 <= 1.4;
      const holdingEma50 = distanceToEma50 >= -1.8;
      const ok = nearEma20 && holdingEma50;
      return { ok, distanceToEma20, distanceToEma50, reason: ok ? 'healthy_pullback' : 'distance_constraints' };
    }

    if (bias === 'short') {
      const nearEma20 = distanceToEma20 <= 2.6 && distanceToEma20 >= -1.4;
      const holdingEma50 = distanceToEma50 <= 1.8;
      const ok = nearEma20 && holdingEma50;
      return { ok, distanceToEma20, distanceToEma50, reason: ok ? 'healthy_pullback' : 'distance_constraints' };
    }

    return { ok: false, distanceToEma20, distanceToEma50, reason: 'unknown_bias' };
  }

  // Get exchange-specific volume thresholds (cached per agent)
  public exchangeVolumeThresholds: { base: number; floor: number } | null = null;
  public async resolveExchangeVolumeThresholds(): Promise<{ base: number; floor: number }> {
    // Return cached if available
    if (this.exchangeVolumeThresholds) {
      return this.exchangeVolumeThresholds;
    }

    const cfg = getConfig();
    let base = Number(cfg.QUALITY_VOLUME_RATIO_BASE || 0.25);
    let floor = Number(cfg.QUALITY_VOLUME_RATIO_FLOOR || 0.15);

    // Try to get user's active exchange
    try {
      if (this.profile?.userId) {
        const credentials = await getUserCredentials(this.profile.userId);
        if (credentials?.exchange) {
          const exchange = credentials.exchange.toLowerCase();
          
          // Exchange-specific thresholds
          if (exchange === 'binance') {
            // Binance: High volumes, stricter thresholds for quality
            base = 0.40;
            floor = 0.25;
          } else if (exchange === 'crypto.com' || exchange === 'cryptocom') {
            // Crypto.com: Low volumes, relaxed thresholds
            base = 0.20;
            floor = 0.12;
          }
          
          recordOpsEvent({
            level: 'info',
            source: 'quality_filter',
            message: 'exchange_adaptive_thresholds_applied',
            sessionId: this.sessionId || undefined,
            symbol: this.profile?.symbol,
            details: { exchange, base, floor },
          });
        }
      }
    } catch (error) {
      // Fallback to config defaults on error
      recordOpsEvent({
        level: 'warn',
        source: 'quality_filter',
        message: 'failed_to_get_exchange_thresholds',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }

    // Cache the result
    this.exchangeVolumeThresholds = { base, floor };
    return this.exchangeVolumeThresholds;
  }

  public getQualityScoreProfile(playbook: string, aggressiveness: string | null | undefined): QualityScoreProfile {
    const normalized = (playbook || 'mean_reversion').toString().toLowerCase();
    const weights: Record<string, number> = {
      trendAlignment: 1,
      momentum: 1,
      volatility: 1,
      volume: 1,
      rsiPosition: 1,
      recognizedStrategy: 1,
    };

    let majorityRatio = 0.6;
    let partialCredit = 0.5;
    let comboTolerance = 6;
    let minPassCount = 3;

    switch (normalized) {
      case 'momentum_breakout':
        weights.momentum = 1.3;
        weights.trendAlignment = 1.2;
        weights.volatility = 1.1;
        weights.volume = 0.9;
        weights.rsiPosition = 0.7;
        weights.recognizedStrategy = 1.0;
        comboTolerance = 8;
        break;
      case 'trend_following':
        weights.momentum = 1.2;
        weights.trendAlignment = 1.3;
        weights.volatility = 1.0;
        weights.volume = 0.9;
        weights.rsiPosition = 0.8;
        weights.recognizedStrategy = 1.15;
        comboTolerance = 7;
        break;
      default:
        weights.momentum = 0.85;
        weights.trendAlignment = 1.0;
        weights.volatility = 1.1;
        weights.volume = 0.95;
        weights.rsiPosition = 1.2;
        weights.recognizedStrategy = 1.1;
        partialCredit = 0.6;
        comboTolerance = 5;
        break;
    }

    const mode = (aggressiveness || 'reactive').toString().toLowerCase();
    if (mode === 'aggressive') {
      majorityRatio -= 0.05;
      comboTolerance += 2;
      weights.volume *= 0.9;
      weights.volatility *= 0.95;
      weights.recognizedStrategy *= 1.05;
    } else if (mode === 'conservative') {
      majorityRatio += 0.05;
      weights.volume *= 1.05;
      weights.volatility *= 1.05;
      weights.recognizedStrategy *= 0.95;
    }

    majorityRatio = Math.min(0.75, Math.max(0.5, majorityRatio));
    partialCredit = Math.min(0.7, Math.max(0.35, partialCredit));
    comboTolerance = Math.max(3, comboTolerance);
    minPassCount = Math.max(2, minPassCount);

    return { weights, majorityRatio, partialCredit, comboTolerance, minPassCount };
  }

  public computeQualityScoreThreshold(
    playbook: string,
    aggressiveness: string | null | undefined,
    tier?: string | null,
  ): number {
    const normalized = (playbook || 'mean_reversion').toString().toLowerCase();
    let baseThreshold = normalized === 'momentum_breakout' ? 55 : normalized === 'mean_reversion' ? 40 : 50;
    const mode = (aggressiveness || 'reactive').toString().toLowerCase();
    const modeAdjustment = mode === 'aggressive' ? -5 : mode === 'conservative' ? 5 : 0;
    const tierAdjustment = tier ? this.qualityAdjustmentByTier.get(tier) ?? 0 : 0;
    const dynamicAdjustment = this.qualityThresholdAdjustment;
    const total = baseThreshold + modeAdjustment + tierAdjustment + dynamicAdjustment;
    return Math.max(30, Math.min(90, total));
  }

  // Simplified quality filters - keep only essential indicators: EMA20/50, RSI, ATR, ADX, volume
  public async passesQualityFilters(snap: TechnicalSnapshot): Promise<boolean> {
    if (!this.plan) return false;
    const bias = this.plan.bias;
    if (bias === 'none') return false;

    const { playbook, context } = this.getContextualPlaybook(snap, bias ?? 'none');
    const aggressiveness = this.profile?.aggressiveness || 'reactive';
    const tier = this.profile ? this.getTierForSymbol(this.profile.symbol) : null;

    const profile = this.getQualityScoreProfile(playbook, aggressiveness);
    const threshold = this.computeQualityScoreThreshold(playbook, aggressiveness, tier);

    const diagnostics = this.getQualityFiltersDiagnostics(snap);
    const recognizedSignals = context?.recognizedStrategies ?? [];
    const targetBias = (context?.direction ?? bias) as 'long' | 'short' | 'none';
    const recognizedCandidates = targetBias === 'none'
      ? recognizedSignals
      : recognizedSignals.filter(signal => signal.bias === targetBias || signal.bias === 'both');
    const recognizedTop = recognizedCandidates[0] ?? null;
    const assessment = this.assessQualityScore(diagnostics, threshold, {
      weights: profile.weights,
      majorityRatio: profile.majorityRatio,
      partialCredit: profile.partialCredit,
      minPassCount: profile.minPassCount,
      comboTolerance: profile.comboTolerance,
    });

    const momentumStatus = diagnostics?.momentum?.status;
    const trendStatus = diagnostics?.trendAlignment?.status;
    const volatilityStatus = diagnostics?.volatility?.status;
    const volumeStatus = diagnostics?.volume?.status;
    const rsiStatus = diagnostics?.rsiPosition?.status;

    const momentumPass = momentumStatus === 'PASS';
    const trendPass = trendStatus === 'PASS';
    const volatilityPass = volatilityStatus === 'PASS';
    const volumePass = volumeStatus === 'PASS';
    const rsiPass = rsiStatus === 'PASS';

    const totalChecks = assessment.passCount + assessment.failCount + assessment.partialCount;
    const effectivePasses = assessment.effectivePasses
      ?? (assessment.passCount + assessment.partialCount * profile.partialCredit);
    const majorityThreshold = assessment.majorityThreshold
      ?? (totalChecks > 0 ? Math.ceil(totalChecks * profile.majorityRatio) : 0);
    const tolerance = profile.comboTolerance;
    const nearThreshold = assessment.effectivePoints >= Math.max(30, threshold - tolerance);

    let allow = assessment.allow;
    let compensationReason: string | null = null;
    let recognizedCompensation: RecognizedStrategySignal | null = null;

    if (!allow) {
      if (momentumPass && (trendPass || trendStatus === 'PARTIAL') && nearThreshold) {
        allow = true;
        compensationReason = 'momentum_trend_combo';
      } else if (!allow && momentumPass && rsiPass && nearThreshold) {
        allow = true;
        compensationReason = 'momentum_rsi_combo';
      } else if (!allow && trendPass && volumePass && momentumPass && nearThreshold) {
        allow = true;
        compensationReason = 'trend_volume_combo';
      } else if (!allow && totalChecks >= profile.minPassCount) {
        const passesWithPartial = effectivePasses;
        const requiredPasses = Math.max(profile.minPassCount, majorityThreshold);
        if (passesWithPartial >= requiredPasses && nearThreshold) {
          allow = true;
          compensationReason = 'super_majority_compensation';
        }
      } else if (!allow && totalChecks >= 3 && nearThreshold && volumePass && volatilityPass && (momentumPass || trendPass)) {
        allow = true;
        compensationReason = 'volatility_volume_combo';
      } else if (!allow && recognizedCandidates.length > 0 && nearThreshold) {
        const candidate = recognizedCandidates
          .filter(signal => signal.active)
          .sort((a, b) => b.confidence - a.confidence)[0];
        if (candidate) {
          const allowedFailures = new Set([
            'momentum',
            'trendAlignment',
            'volatility',
            'volume',
            'rsiPosition',
          ]);
          const failingKeys = assessment.failingKeys ?? [];
          const compatible = failingKeys.every(key => allowedFailures.has(key));
          const confidenceThreshold = candidate.id === 'bollinger_mean_reversion' ? 0.5 : 0.6;
          if (compatible && candidate.confidence >= confidenceThreshold) {
            allow = true;
            recognizedCompensation = candidate;
            compensationReason = `recognized_strategy_${candidate.id}`;
          }
        }
      }
    }

    const volumeDetails = diagnostics?.volume?.details ?? {};
    const rawRatio = typeof volumeDetails.ratio === 'number' ? Number(volumeDetails.ratio) : undefined;
    let computedRatio = rawRatio;
    if (computedRatio == null) {
      const current = typeof volumeDetails.currentVolume === 'number' ? Number(volumeDetails.currentVolume) : undefined;
      const ma = typeof volumeDetails.volumeMA === 'number' ? Number(volumeDetails.volumeMA) : undefined;
      if (current != null && ma != null && ma > 0) {
        computedRatio = current / ma;
      }
    }
    const usdVolumeMA = typeof volumeDetails.usdVolumeMA === 'number'
      ? Number(volumeDetails.usdVolumeMA)
      : undefined;
    if (this.profile?.symbol) {
      this.updateVolumeContext(this.profile.symbol, computedRatio ?? 0, usdVolumeMA ?? 0, !allow);
    }

    if (!allow) {
      this.lastQualityFilterFailure = {
        code: 'quality.score_insufficient',
        message: 'Quality score below dynamic threshold',
        details: {
          totalPoints: assessment.totalPoints,
          effectivePoints: assessment.effectivePoints,
          threshold,
          passCount: assessment.passCount,
          failCount: assessment.failCount,
          partialCount: assessment.partialCount,
          failingKeys: assessment.failingKeys,
          weights: profile.weights,
          majorityThreshold,
          effectivePasses,
          recognized: recognizedTop
            ? {
              id: recognizedTop.id,
              bias: recognizedTop.bias,
              confidence: recognizedTop.confidence,
              active: recognizedTop.active,
            }
            : null,
        },
      };
      recordOpsEvent({
        level: 'info',
        source: 'quality_filter',
        message: 'quality_score_blocked',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          playbook,
          aggressiveness,
          threshold,
          assessment: {
            totalPoints: assessment.totalPoints,
            effectivePoints: assessment.effectivePoints,
            bonus: assessment.bonus,
            passCount: assessment.passCount,
            failCount: assessment.failCount,
            partialCount: assessment.partialCount,
            failingKeys: assessment.failingKeys,
            majorityThreshold,
            effectivePasses,
            recognizedCompensation: recognizedCompensation
              ? {
                id: recognizedCompensation.id,
                bias: recognizedCompensation.bias,
                confidence: recognizedCompensation.confidence,
                active: recognizedCompensation.active,
              }
              : null,
          },
        },
      });
      return false;
    }

    this.lastQualityFilterFailure = null;
    recordOpsEvent({
      level: 'info',
      source: 'quality_filter',
      message: compensationReason ? 'quality_score_compensated_pass' : 'quality_score_pass',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        playbook,
        aggressiveness,
        threshold,
        compensationReason,
        assessment: {
          totalPoints: assessment.totalPoints,
          effectivePoints: assessment.effectivePoints,
          bonus: assessment.bonus,
          passCount: assessment.passCount,
          failCount: assessment.failCount,
          partialCount: assessment.partialCount,
          failingKeys: assessment.failingKeys,
          majorityThreshold,
          effectivePasses,
          recognizedCompensation: recognizedCompensation
            ? {
              id: recognizedCompensation.id,
              bias: recognizedCompensation.bias,
              confidence: recognizedCompensation.confidence,
              active: recognizedCompensation.active,
            }
            : null,
        },
        weights: profile.weights,
      },
    });

    return true;
  }

  // Anti-whale / manipulation guard: blocks entries on abnormal volume spikes in extreme volatility without strong trend
  public computeAdaptiveStopDistance(params: {
    baseDistance: number;
    atrDistance: number | null;
    atrPct: number;
    riskContextPct: number;
    qualityMultiplier: number;
    recognizedConfidence: number | null;
  }): { distance: number; multiplier: number; confidence: number } | null {
    const { baseDistance, atrDistance, atrPct, riskContextPct, qualityMultiplier, recognizedConfidence } = params;
    if (!(baseDistance > 0)) return null;
    const atrBase = atrDistance != null && atrDistance > 0 ? atrDistance : null;
    if (!atrBase) return null;

    const currentMultiplier = baseDistance / atrBase;
    if (!Number.isFinite(currentMultiplier) || currentMultiplier <= 0) return null;

    const baseRisk = this.profile?.riskPerTradePct ?? 0;
    const riskRatio = baseRisk > 0 ? riskContextPct / baseRisk : 1;
    const boundedRiskRatio = Math.max(0.35, Math.min(1.8, riskRatio));
    const boundedQuality = Math.max(0.5, Math.min(1.6, qualityMultiplier));
    const boundedKelly = this.adaptiveRisk ? Math.max(0.3, Math.min(1.6, this.adaptiveRisk.kellyMultiplier)) : 1;
    const boundedRecognized = recognizedConfidence != null
      ? Math.max(0, Math.min(1.5, recognizedConfidence))
      : 0.35;

    const playbookContext = this.marketContext?.effectivePlaybook
      ?? (typeof (this.plan?.plan?.meta?.playbook) === 'string' ? (this.plan?.plan?.meta?.playbook as string) : null);
    const allowTrendTightening = playbookContext === 'trend_following' || playbookContext === 'momentum_breakout';
    const contextAdx = Number.isFinite(this.marketContext?.adx) ? Number(this.marketContext!.adx) : null;

    const compositeConfidence = Math.max(0.25, Math.min(
      1.85,
      (boundedQuality * 0.35)
        + (boundedRiskRatio * 0.25)
        + (boundedKelly * 0.2)
        + (boundedRecognized * 0.2),
    ));

    let targetMultiplier = currentMultiplier;
    if (compositeConfidence >= 1.35) {
      const tightFloor = allowTrendTightening && (contextAdx ?? 0) >= 25 ? 0.7 : 0.75;
      targetMultiplier = Math.max(currentMultiplier * 0.78, tightFloor);
    } else if (compositeConfidence >= 1.1) {
      const moderateFloor = allowTrendTightening && (contextAdx ?? 0) >= 22 ? 0.78 : 0.85;
      targetMultiplier = Math.max(currentMultiplier * 0.88, moderateFloor);
    } else if (compositeConfidence <= 0.7) {
      targetMultiplier = Math.min(currentMultiplier * 1.45, 2.6);
    } else if (compositeConfidence <= 0.85) {
      targetMultiplier = Math.min(currentMultiplier * 1.2, 2.2);
    }

    const boundedAtrPct = Math.max(0, atrPct);
    if (boundedAtrPct < 0.35) {
      targetMultiplier = Math.max(targetMultiplier, currentMultiplier * 1.1);
    } else if (boundedAtrPct > 1.8) {
      targetMultiplier = Math.min(targetMultiplier, currentMultiplier * 0.9);
    }

    const minDistance = Math.max(
      baseDistance * (allowTrendTightening ? 0.65 : 0.7),
      atrBase * (allowTrendTightening ? 0.5 : 0.55),
    );
    const maxDistance = Math.max(baseDistance * 1.6, atrBase * 2.8);
    const adjustedDistance = Math.max(minDistance, Math.min(maxDistance, atrBase * targetMultiplier));
    if (!Number.isFinite(adjustedDistance) || adjustedDistance <= 0) return null;

    const relativeDelta = Math.abs(adjustedDistance - baseDistance) / baseDistance;
    if (relativeDelta < 0.08) return null;

    return {
      distance: adjustedDistance,
      multiplier: adjustedDistance / atrBase,
      confidence: compositeConfidence,
    };
  }

  // Dynamic position sizing based on setup quality and market conditions
  public computeQualityBasedSizing(snap: TechnicalSnapshot): number {
    if (!this.plan) return 1.0;
    
    const price = snap.last;
    const bias = this.plan.bias;
    if (bias === 'none') return 0.5; // Minimal size for uncertain setups

    const adx = Number((snap as any)?.adx14 ?? 0);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    // Prefer volumeMA from snapshot; fallback to volumeAvg; finally fallback to current volume
    const volumeMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? 0);
    
    let sizeMultiplier = 1.0;
    const level = this.profile?.aggressiveness || 'conservative';
    
    // Base multiplier by aggressiveness (REDUCED PENALTIES)
    const baseMultipliers = {
      'conservative': 0.9,  // ✅ FIX: Was 0.8, now 0.9 (less penalty)
      'reactive': 1.0,      // Standard sizing
      'aggressive': 1.2     // Larger positions on good setups
    };
    sizeMultiplier = baseMultipliers[level] || 1.0;
    
    // ADX strength bonus (up to +30%) - REDUCED PENALTIES
    if (adx >= 30) sizeMultiplier *= 1.3;
    else if (adx >= 25) sizeMultiplier *= 1.2;
    else if (adx >= 20) sizeMultiplier *= 1.1;
    else if (adx < 15) sizeMultiplier *= 0.85; // ✅ FIX: Was 0.7, now 0.85 (less penalty)
    
    // Trend alignment bonus (up to +20%) - REDUCED SIDEWAYS PENALTY
    const emaSpread = ((snap as any)?.ema20 - (snap as any)?.ema50) / Math.abs((snap as any)?.ema50 || 1);
    const trendAligned = bias === 'long' ? emaSpread > 0.5 : emaSpread < -0.5;
    if (trendAligned) {
      if (Math.abs(emaSpread) > 0.02) sizeMultiplier *= 1.2; // Strong trend
      else if (Math.abs(emaSpread) > 0.01) sizeMultiplier *= 1.1; // Moderate trend
    } else if (Math.abs(emaSpread) < 0.002) {
      sizeMultiplier *= 0.85; // ✅ FIX: Was 0.6, now 0.85 (less penalty for sideways)
    }
    
    // Volume confirmation bonus (up to +15%) - REDUCED LOW VOLUME PENALTY
    const volumeRatio = volumeMA > 0 ? volume / volumeMA : 1;
    if (volumeRatio >= 1.5) sizeMultiplier *= 1.15;
    else if (volumeRatio >= 1.2) sizeMultiplier *= 1.1;
    else if (volumeRatio < 0.8) sizeMultiplier *= 0.9; // ✅ FIX: Was 0.8, now 0.9 (less penalty)
    
    // Volatility adjustment
    if (atrPct > 2.0) sizeMultiplier *= 0.9; // Reduce size in high volatility
    else if (atrPct < 0.5) sizeMultiplier *= 0.8; // Reduce size in low volatility
    
    // RSI position adjustment (avoid extremes)
    if (bias === 'long' && rsi > 70) sizeMultiplier *= 0.8;
    else if (bias === 'short' && rsi < 30) sizeMultiplier *= 0.8;
    
    // Backtest quality bonus
    try {
      const quickTest = (this.plan.plan as any)?.meta?.quickTest;
      if (quickTest) {
        const winrate = Number(quickTest.winrate || 0);
        const avgR = Number(quickTest.avgR || 0);
        const count = Number(quickTest.count || 0);
        
        if (count >= 10) {
          if (winrate >= 70 && avgR >= 0.8) sizeMultiplier *= 1.25; // Excellent backtest
          else if (winrate >= 60 && avgR >= 0.5) sizeMultiplier *= 1.15; // Good backtest
          else if (winrate < 45 || avgR < 0.2) sizeMultiplier *= 0.7; // Poor backtest
        }
      }
    } catch {}
    
    // Reduce size further on short-term loss streaks (confidence tightening) - REDUCED PENALTY
    try {
      const cfg = getConfig();
      const window = Math.max(1, Number(cfg.STREAK_WINDOW || 3));
      const streak = this.getLossStreak(window);
      if (streak >= 1) {
        const penalty = Math.min(0.7, (cfg.LOSS_STREAK_SIZE_PENALTY || 0.05) * streak); // ✅ FIX: Was 0.15, now 0.05 (less penalty per loss)
        sizeMultiplier *= (1 - penalty);
      }
      // Increase size modestly on win streaks (confidence relaxation)
      const winstreak = this.getWinStreak(window);
      if (winstreak >= 1) {
        const bonus = Math.min(0.3, (cfg.WIN_STREAK_SIZE_BONUS || 0.10) * winstreak);
        sizeMultiplier *= (1 + bonus);
      }
    } catch {}
    
    // ✅ ADAPTIVE LEARNING: Regime-based sizing adjustment
    if (this.regime?.playbook) {
      const playbook = this.regime.playbook;
      const trendStrength = this.regime.trendStrength || 0;
      
      if (playbook === 'standby' || playbook === 'mean_reversion') {
        // 🟡 Choppy/ranging market: reduce size significantly
        sizeMultiplier *= 0.5; // -50%
        console.log('🟡 Regime: Choppy market → Position size -50%');
      } else if (playbook === 'momentum_breakout' && trendStrength > 0.7) {
        // 🟢 Strong trending market: increase size moderately
        sizeMultiplier *= 1.2; // +20%
        console.log('🟢 Regime: Strong momentum → Position size +20%');
      }
    }
    
    // ✅ FIX: Cap cumulative penalties - max 30% reduction (0.7 floor instead of 0.35)
    // This prevents too many penalties from stacking and making positions too small
    sizeMultiplier = Math.max(0.7, Math.min(1.8, sizeMultiplier));

    return sizeMultiplier;
  }

  // Return consecutive losses in the last N trades (default 3)
  public getLossStreak(window: number = 3): number {
    if (!this.recentTrades.length) return 0;
    const slice = this.recentTrades.slice(-window);
    let streak = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      if (!slice[i].win) streak += 1; else break;
    }
    return streak;
  }

  // Return consecutive wins in the last N trades (default 3)
  public getWinStreak(window: number = 3): number {
    if (!this.recentTrades.length) return 0;
    const slice = this.recentTrades.slice(-window);
    let streak = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      if (slice[i].win) streak += 1; else break;
    }
    return streak;
  }

  // Snapshot of short-run performance over last N trades
  public getRecentPerformance(n: number = 5): { trades: number; winRate: number; avgPnlPct: number } {
    const slice = this.recentTrades.slice(-n);
    const trades = slice.length;
    if (trades === 0) return { trades: 0, winRate: 0, avgPnlPct: 0 };
    const wins = slice.filter(t => t.win).length;
    const winRate = wins / trades;
    const avgPnlPct = slice.reduce((s, t) => s + t.pnlPct, 0) / trades;
    return { trades, winRate, avgPnlPct };
  }

  public getTradeCadenceSnapshot(): TradeCadenceState {
    return { ...this.tradeCadenceState };
  }

  public updateTradeCadenceTelemetry(): void {
    if (!this.performanceMetrics) return;
    const snapshot = this.tradeCadenceState;
    this.performanceMetrics.tradeCadence = {
      stageIndex: snapshot.stageIndex,
      label: snapshot.stageLabel,
      maxTradesPerDay: snapshot.maxTradesPerDay,
      cooldownMs: snapshot.cooldownMs,
      winRate: snapshot.lastWinRate,
      sampleSize: snapshot.sampleSize,
      lastUpdated: snapshot.lastUpdated,
    };
  }

  public buildTradeCadenceConfig(modeParams: ModeParams, aggressiveness: AgentAggressiveness): TradeCadenceConfig {
    const cfg = getConfig();
    const baseStages = cfg.TRADE_FREQUENCY_STAGE_COUNTS.length
      ? cfg.TRADE_FREQUENCY_STAGE_COUNTS
      : [modeParams.maxTradesPerDay];
    const cooldownFallback = cfg.TRADE_COOLDOWN_STAGE_MS.length
      ? cfg.TRADE_COOLDOWN_STAGE_MS[cfg.TRADE_COOLDOWN_STAGE_MS.length - 1]
      : modeParams.tradeCooldownMs;
    const thresholdFallback = cfg.TRADE_FREQUENCY_STAGE_WIN_THRESHOLDS.length
      ? cfg.TRADE_FREQUENCY_STAGE_WIN_THRESHOLDS[cfg.TRADE_FREQUENCY_STAGE_WIN_THRESHOLDS.length - 1]
      : 0;
    const minTradesFallback = cfg.TRADE_FREQUENCY_STAGE_MIN_TRADES.length
      ? cfg.TRADE_FREQUENCY_STAGE_MIN_TRADES[cfg.TRADE_FREQUENCY_STAGE_MIN_TRADES.length - 1]
      : 0;

    const stages: TradeCadenceStageConfig[] = baseStages.map((count, idx) => {
      const cappedCount = Math.max(1, Math.min(count, modeParams.maxTradesPerDay));
      const cooldownSource = cfg.TRADE_COOLDOWN_STAGE_MS[idx] ?? cooldownFallback;
      const thresholdSource = cfg.TRADE_FREQUENCY_STAGE_WIN_THRESHOLDS[idx] ?? thresholdFallback;
      const minTradesSource = cfg.TRADE_FREQUENCY_STAGE_MIN_TRADES[idx] ?? minTradesFallback;
      return {
        maxTrades: cappedCount,
        cooldownMs: Math.max(1_000, Math.round(cooldownSource)),
        winRateThreshold: Math.max(0, Math.min(1, thresholdSource)),
        minTrades: Math.max(0, Math.round(minTradesSource)),
        label: idx === 0 ? 'base' : `expanded_${cappedCount}`,
      };
    });

    if (!stages.length) {
      stages.push({
        maxTrades: modeParams.maxTradesPerDay,
        cooldownMs: Math.max(1_000, modeParams.tradeCooldownMs),
        winRateThreshold: 0,
        minTrades: 0,
        label: 'base',
      });
    }

    for (let i = 1; i < stages.length; i += 1) {
      if (stages[i].maxTrades < stages[i - 1].maxTrades) {
        stages[i].maxTrades = stages[i - 1].maxTrades;
      }
      if (stages[i].cooldownMs > stages[i - 1].cooldownMs && stages[i].maxTrades === stages[i - 1].maxTrades) {
        stages[i].cooldownMs = stages[i - 1].cooldownMs;
      }
    }

    const hysteresis = cfg.TRADE_FREQUENCY_HYSTERESIS ?? 0.05;
    console.log(`⚙️ Trade cadence configuration for ${aggressiveness}:`, stages.map(s => `${s.label}:${s.maxTrades}/${s.cooldownMs}ms`).join(', '));
    return { stages, hysteresis: Math.max(0, Math.min(0.3, hysteresis)) };
  }

  public resolveTradeCadenceStage(winRate: number, trades: number): number {
    if (!this.tradeCadenceConfig || !this.tradeCadenceConfig.stages.length) return 0;
    const { stages, hysteresis } = this.tradeCadenceConfig;
    const currentStage = this.tradeCadenceState.stageIndex ?? 0;
    for (let idx = stages.length - 1; idx >= 0; idx -= 1) {
      const stage = stages[idx];
      if (!stage) continue;
      if (trades < stage.minTrades) continue;
      let threshold = stage.winRateThreshold;
      if (idx === currentStage && threshold > 0) {
        threshold = Math.max(0, threshold - hysteresis);
      }
      if (winRate >= threshold) {
        return idx;
      }
    }
    return 0;
  }

  public applyTradeCadenceStage(stageIndex: number, context: string, metrics: { winRate: number; trades: number }): void {
    if (!this.tradeCadenceConfig || !this.tradeCadenceConfig.stages.length) return;
    const stage = this.tradeCadenceConfig.stages[stageIndex] ?? this.tradeCadenceConfig.stages[0];
    const prevStage = this.tradeCadenceState.stageIndex;
    const now = Date.now();

    this.tradeCadenceState = {
      stageIndex,
      stageLabel: stage.label,
      maxTradesPerDay: stage.maxTrades,
      cooldownMs: stage.cooldownMs,
      lastWinRate: metrics.winRate,
      sampleSize: metrics.trades,
      lastUpdated: now,
      reason: context,
    };

    if (this.quantConfig?.risk) {
      this.quantConfig.risk.dailyTradeLimit = stage.maxTrades;
    }

    this.updateTradeCadenceTelemetry();

    if (stageIndex !== prevStage) {
      const level: 'info' | 'warn' = stageIndex > prevStage ? 'info' : 'warn';
      console.log(`🕒 Trade cadence stage ${prevStage} → ${stageIndex} (${stage.label}) | maxTrades=${stage.maxTrades}, cooldown=${stage.cooldownMs}ms`);
      recordOpsEvent({
        level,
        source: 'risk_manager',
        message: 'trade_cadence_stage_changed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          stageIndex,
          stageLabel: stage.label,
          maxTradesPerDay: stage.maxTrades,
          cooldownMs: stage.cooldownMs,
          winRate: metrics.winRate,
          sampleSize: metrics.trades,
          previousStage: prevStage,
          reason: context,
        },
      });
    }
  }

  public evaluateTradeCadence(context: 'activation' | 'post_trade' | 'readiness' = 'readiness'): TradeCadenceState {
    const aggressiveness = this.profile?.aggressiveness ?? 'reactive';
    if (!this.tradeCadenceConfig || !this.tradeCadenceConfig.stages.length) {
      const modeParams = getModeParams(aggressiveness);
      this.tradeCadenceConfig = this.buildTradeCadenceConfig(modeParams, aggressiveness);
      const baseStage = this.tradeCadenceConfig.stages[0];
      if (baseStage) {
        this.tradeCadenceState = {
          stageIndex: 0,
          stageLabel: baseStage.label,
          maxTradesPerDay: baseStage.maxTrades,
          cooldownMs: baseStage.cooldownMs,
          lastWinRate: this.tradeCadenceState.lastWinRate,
          sampleSize: this.tradeCadenceState.sampleSize,
          lastUpdated: Date.now(),
          reason: 'init',
        };
        if (this.quantConfig?.risk) {
          this.quantConfig.risk.dailyTradeLimit = baseStage.maxTrades;
        }
        this.updateTradeCadenceTelemetry();
      }
    }

    const maxWindow = this.tradeCadenceConfig?.stages.reduce((acc, stage) => Math.max(acc, stage.minTrades), 5) ?? 5;
    const performance = this.getRecentPerformance(Math.max(5, maxWindow));
    const targetStage = this.resolveTradeCadenceStage(performance.winRate, performance.trades);

    if (targetStage !== this.tradeCadenceState.stageIndex) {
      this.applyTradeCadenceStage(targetStage, context, { winRate: performance.winRate, trades: performance.trades });
    } else {
      this.tradeCadenceState = {
        ...this.tradeCadenceState,
        lastWinRate: performance.winRate,
        sampleSize: performance.trades,
        lastUpdated: Date.now(),
        reason: context,
      };
      this.updateTradeCadenceTelemetry();
    }

    return this.getTradeCadenceSnapshot();
  }

  // Market regime detection for adaptive strategy
  public detectMarketRegime(snap: TechnicalSnapshot): 'trending_strong' | 'trending_weak' | 'ranging' | 'choppy' | 'volatile' {
    const adx = Number((snap as any)?.adx14 ?? 0);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const ema20 = Number((snap as any)?.ema20 ?? snap.last);
    const ema50 = Number((snap as any)?.ema50 ?? snap.last);
    const ema20Slope = Number((snap as any)?.ema20Slope ?? 0);
    const realizedVol = Number((snap as any)?.realizedVol ?? 0);
    
    const emaSpread = Math.abs((ema20 - ema50) / ema50) * 100;
    const slopeStrength = Math.abs(ema20Slope / ema20);
    
    // High volatility regime
    if (atrPct > 2.5 || realizedVol > 80) {
      return 'volatile';
    }
    
    // Strong trending regime
    if (adx >= 25 && emaSpread > 1.0 && slopeStrength > 0.0005) {
      return 'trending_strong';
    }

    // Weak trending regime
    if (adx >= 18 && (emaSpread > 0.5 || slopeStrength > 0.0003)) {
      return 'trending_weak';
    }
    
    // Ranging regime (sideways with structure)
    if (adx < 18 && emaSpread < 0.3 && atrPct > 0.8) {
      return 'ranging';
    }
    
    // Choppy regime (low volatility, no clear direction)
    return 'choppy';
  }

  private recordTierPerformance(symbol: string | null | undefined, win: boolean, pnlPct: number, timestamp: number): void {
    if (!symbol) return;
    const tier = this.getTierForSymbol(symbol);
    const existing = this.recentTradesByTier.get(tier) ?? [];
    const now = timestamp;
    const retentionMs = ReboundRejectionAgent.TIER_PERFORMANCE_RETENTION_MS;
    const filtered = existing.filter((trade) => now - trade.timestamp <= retentionMs);
    filtered.push({ symbol, win, pnlPct, timestamp: now });
    const trimmed = filtered.slice(-ReboundRejectionAgent.TIER_PERFORMANCE_MAX);
    this.recentTradesByTier.set(tier, trimmed);

    // Also prune other tiers opportunistically to keep data fresh
    for (const [key, trades] of this.recentTradesByTier.entries()) {
      if (key === tier) continue;
      const pruned = trades.filter((trade) => now - trade.timestamp <= retentionMs);
      if (pruned.length !== trades.length) {
        this.recentTradesByTier.set(key, pruned);
      }
    }
  }

  /**
   * ✅ ULTRA-INTELLIGENT: Adjust quality thresholds BY TIER (contextualized learning)
   * Each tier learns independently: BTC losses don't affect ADA trading
   */
  public adjustQualityThresholds(): void {
    // Process each tier independently
    for (const [tier, trades] of this.recentTradesByTier.entries()) {
      if (trades.length < 10) continue; // Need sufficient data per tier
      
      const recentWinRate = trades.filter(t => t.win).length / trades.length;
      const avgPnlPct = trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;
      const targetWinRate = this.getTargetWinRateForTier(tier);
      const currentAdj = this.qualityAdjustmentByTier.get(tier) || 0;
      
      // Poor performance on THIS tier → Increase selectivity for THIS tier only
      if (recentWinRate < targetWinRate - 0.1 && avgPnlPct < 0) {
        const newAdj = Math.min(20, currentAdj + 5);
        this.qualityAdjustmentByTier.set(tier, newAdj);
        
        recordOpsEvent({
          level: 'warn',
          source: 'adaptive_learning_tier',
          message: `${tier}: Increasing selectivity due to poor performance`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { 
            tier,
            recentWinRate: (recentWinRate * 100).toFixed(1) + '%',
            targetWinRate: (targetWinRate * 100).toFixed(1) + '%',
            avgPnlPct: avgPnlPct.toFixed(2) + '%',
            adjustment: newAdj,
            recentTrades: trades.slice(-5).map(t => `${t.symbol}: ${t.win ? 'WIN' : 'LOSS'} ${t.pnlPct.toFixed(2)}%`)
          },
        });
        
        console.log(`📊 ${tier.toUpperCase()}: Win rate ${(recentWinRate*100).toFixed(1)}% < ${(targetWinRate*100).toFixed(1)}% → Quality +5 (now ${newAdj})`);
      }
      
      // Good performance on THIS tier → Relax selectivity for THIS tier only
      else if (recentWinRate > targetWinRate + 0.1 && avgPnlPct > 0.5) {
        const newAdj = Math.max(-10, currentAdj - 3);
        this.qualityAdjustmentByTier.set(tier, newAdj);
        
        recordOpsEvent({
          level: 'info',
          source: 'adaptive_learning_tier',
          message: `${tier}: Decreasing selectivity due to good performance`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { 
            tier,
            recentWinRate: (recentWinRate * 100).toFixed(1) + '%',
            targetWinRate: (targetWinRate * 100).toFixed(1) + '%',
            avgPnlPct: avgPnlPct.toFixed(2) + '%',
            adjustment: newAdj,
            recentTrades: trades.slice(-5).map(t => `${t.symbol}: ${t.win ? 'WIN' : 'LOSS'} ${t.pnlPct.toFixed(2)}%`)
          },
        });
        
        console.log(`📈 ${tier.toUpperCase()}: Win rate ${(recentWinRate*100).toFixed(1)}% > ${(targetWinRate*100).toFixed(1)}% → Quality -3 (now ${newAdj})`);
      }
    }
    
    // Legacy global adjustment (kept for compatibility)
    if (this.recentTrades.length >= 10) {
      const recentWinRate = this.recentTrades.filter(t => t.win).length / this.recentTrades.length;
      const avgPnlPct = this.recentTrades.reduce((sum, t) => sum + t.pnlPct, 0) / this.recentTrades.length;
      const level = this.profile?.aggressiveness || 'conservative';
      let targetWinRate = 0.65;
      if (level === 'reactive') targetWinRate = 0.58;
      if (level === 'aggressive') targetWinRate = 0.52;
      
      if (recentWinRate < targetWinRate - 0.1 && avgPnlPct < 0) {
        this.qualityThresholdAdjustment = Math.min(15, this.qualityThresholdAdjustment + 5);
      } else if (recentWinRate > targetWinRate + 0.1 && avgPnlPct > 0.5) {
        this.qualityThresholdAdjustment = Math.max(-10, this.qualityThresholdAdjustment - 3);
      }
    }
  }

  /**
   * ✅ ADAPTIVE LEARNING: Detect losing streaks and adjust behavior
   * After 2 consecutive losses: Increase selectivity significantly
   * After 3 consecutive losses: Enter 1h cooldown (circuit breaker)
   */
  public detectLosingStreak(): void {
    const state = this.circuitBreaker.getState();
    const threshold = Math.max(1, this.quantConfig.risk.maxConsecutiveLosses);
    const window = Math.max(3, threshold);
    const tradeLossStreak = this.getLossStreak(window);
    const lossStreak = Math.max(state.consecutiveLosses, tradeLossStreak);

    if (lossStreak <= 0) {
      this.lastLossStreakNotified = 0;
      return;
    }

    if (lossStreak > this.lastLossStreakNotified && lossStreak >= 2) {
      const adjustment = lossStreak === 2 ? 10 : Math.min(20, 10 + (lossStreak - 2) * 5);
      this.qualityThresholdAdjustment = Math.min(20, this.qualityThresholdAdjustment + adjustment);

      recordOpsEvent({
        level: 'warn',
        source: 'adaptive_learning',
        message: `Losing streak detected: ${lossStreak} losses`,
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          consecutiveLosses: lossStreak,
          adjustment: this.qualityThresholdAdjustment,
          threshold,
          sizeMultiplier: this.circuitBreaker.sizeMultiplier(),
        },
      });

      console.log(`🛑 Losing streak: ${lossStreak} losses → Quality threshold +${adjustment} (now ${this.qualityThresholdAdjustment})`);
      this.lastLossStreakNotified = lossStreak;
    }

    const nowMs = Date.now();
    if (lossStreak >= threshold) {
      const existingCooldown = state.cooldownUntil && state.cooldownUntil.getTime() > nowMs
        ? state.cooldownUntil
        : this.circuitBreaker.enforceLossCooldown(new Date(nowMs));
      const cooldownMs = Math.max(60_000, existingCooldown.getTime() - nowMs);

      recordOpsEvent({
        level: 'error',
        source: 'circuit_breaker',
        message: 'loss_streak_cooldown',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          consecutiveLosses: lossStreak,
          threshold,
          cooldownUntil: existingCooldown.toISOString(),
        },
      });

      this.scheduleReactivation('losing_streak_circuit_breaker', cooldownMs);
      console.log(`🔴 CIRCUIT BREAKER: ${lossStreak} consecutive losses → trading pause until ${existingCooldown.toISOString()}`);
    }
  }

  /**
   * Get comprehensive trading diagnostics for frontend display
  */
  public async getDiagnostics(): Promise<any> {
    const cfg = getConfig();
    const symbol = this.profile?.symbol;
    const defaultTrigger = {
      entryReady: false,
      phase: 'warming',
      bias: this.plan?.bias || 'none',
      price: 0,
      zone: this.plan?.zone ? { ...this.plan.zone } : null,
      inZone: false,
      confirmationOk: false,
      momentumOk: false,
      qualityOk: false,
      profitOk: false,
      liquidityOk: false,
      antiWhaleOk: false,
      circuitOk: false,
      cooldownOk: false,
      regimeOk: false,
      biasOk: false,
      tp1ProfitPct: 0,
      minProfitPct: cfg.MIN_TRADE_PROFIT_PCT,
      dir: this.plan?.bias === 'short' ? -1 : 1,
    };

    if (!symbol) {
      const warmupDetails = { last: 0, volume: 0, volumeMA: 0 };
      return {
        canTrade: false,
        reason: 'profile.symbol_unset',
        errorCode: 'profile.symbol_unset',
        warmup: warmupDetails,
        checks: {
          marketData: {
            status: 'FAIL',
            code: 'profile.symbol_unset',
            reason: 'no_symbol_assigned',
            details: warmupDetails,
          },
        },
        summary: { totalChecks: 1, passed: 0, failed: 1, partial: 0, rejected: 0 },
        trigger: defaultTrigger,
        timestamp: Date.now(),
      };
    }

    try {
      const snapshotFetcher = typeof (this as any).getDiagnosticSnapshot === 'function'
        ? (this as any).getDiagnosticSnapshot.bind(this)
        : async () => buildTechSnapshot(symbol);
      const snap = await snapshotFetcher();
      // Guard: if market data is not ready (cold WS or synthetic), avoid incoherent diagnostics
      const vol = Number((snap as any)?.volume || 0);
      const volMA = Number((snap as any)?.volumeMA || 0);
      const lastPx = Number((snap as any)?.last || 0);
      const dataReady = lastPx > 0 && (vol > 0 || volMA > 0);
      if (!dataReady) {
        const warmupDetails = { last: lastPx, volume: vol, volumeMA: volMA };
        return {
          canTrade: false,
          reason: 'data.unavailable',
          errorCode: 'data.unavailable',
          warmup: warmupDetails,
          checks: {
            marketData: {
              status: 'FAIL',
              code: 'data.unavailable',
              reason: 'waiting_for_market_data',
              details: warmupDetails,
            },
          },
          summary: { totalChecks: 1, passed: 0, failed: 1, partial: 0, rejected: 0 },
          trigger: { ...defaultTrigger, price: lastPx },
          timestamp: Date.now()
        };
      }
      let checks = await this.getDiagnosticChecks(snap);
      let summary = this.getDiagnosticSummary(checks);
      let trigger = await this.getDiagnosticTrigger(snap, checks);
      let readiness = this.getTradingReadinessReason(checks);
      let blockers = this.extractDiagnosticBlockers(checks, readiness.failingChecks);
      let canTrade = readiness.failingChecks.length === 0 && trigger.entryReady;

      if (
        !canTrade &&
        trigger.entryReady &&
        checks?.qualityScore?.status === 'PASS' &&
        checks?.momentumGates?.status === 'FAIL' &&
        checks?.qualityFilters?.momentum?.status === 'PASS'
      ) {
        const gateEvaluation = this.lastMomentumGateResult ?? this.evaluateMomentumGates(snap, 'enter', false);
        if (gateEvaluation.status === 'SOFT_FAIL' || gateEvaluation.reasons.length <= 1) {
          canTrade = true;
          checks.momentumGates = {
            ...checks.momentumGates,
            status: 'SOFT_FAIL',
            reason: `${gateEvaluation.reasons.join(' | ') || 'Momentum marginal but supported by quality'} | override:quality_confirmation`,
            code: 'momentum.soft_fail',
            details: {
              ...(checks.momentumGates?.details ?? gateEvaluation.details),
              override: 'quality_confirmation',
            },
          };
          summary = this.getDiagnosticSummary(checks);
          trigger = await this.getDiagnosticTrigger(snap, checks);
          readiness = this.getTradingReadinessReason(checks);
          blockers = this.extractDiagnosticBlockers(checks, readiness.failingChecks);
          canTrade = readiness.failingChecks.length === 0 && trigger.entryReady;
        }
      }

      if (
        !canTrade &&
        trigger.entryReady &&
        trigger.momentumOk &&
        trigger.profitOk &&
        checks?.qualityScore?.status === 'PASS'
      ) {
        const trendFilter = checks?.qualityFilters?.trendAlignment;
        const trendStatus = typeof trendFilter?.status === 'string' ? trendFilter.status : null;
        const otherQualityFailures = Object.entries(checks?.qualityFilters ?? {})
          .filter(([key, filter]) => key !== 'trendAlignment' && (filter as any)?.status === 'FAIL');
        const hasNonTrendBlockers = blockers.some((blocker) => blocker.status === 'FAIL' && blocker.key !== 'qualityFilters.trendAlignment');
        if (
          trendFilter &&
          (trendStatus === 'SOFT_FAIL' || trendStatus === 'FAIL') &&
          otherQualityFailures.length === 0 &&
          !hasNonTrendBlockers
        ) {
          canTrade = true;
          const overrideTag = 'override:trend_alignment_soft';
          const existingReason = typeof trendFilter.reason === 'string' ? trendFilter.reason : '';
          const reasonWithOverride = existingReason.includes(overrideTag)
            ? existingReason
            : `${existingReason}${existingReason ? ' | ' : ''}${overrideTag}`;
          const existingDetails = (trendFilter as any).details && typeof (trendFilter as any).details === 'object'
            ? { ...(trendFilter as any).details }
            : {};
          checks.qualityFilters.trendAlignment = {
            ...trendFilter,
            status: 'SOFT_FAIL',
            reason: reasonWithOverride,
            details: {
              ...existingDetails,
              override: 'trend_alignment_soft',
              sizeMultiplier: typeof existingDetails.sizeMultiplier === 'number'
                ? existingDetails.sizeMultiplier
                : 0.7,
            },
          };
          summary = this.getDiagnosticSummary(checks);
          trigger = await this.getDiagnosticTrigger(snap, checks);
          readiness = this.getTradingReadinessReason(checks);
          blockers = this.extractDiagnosticBlockers(checks, readiness.failingChecks);
          canTrade = readiness.failingChecks.length === 0 && trigger.entryReady;
        }
      }

      if (!canTrade && this.lastDiagnosticCanTrade !== false) {
        this.emitValidatorBlockEvent({ snap, checks, trigger, summary, readiness });
      }
      this.lastDiagnosticCanTrade = canTrade;

      return {
        canTrade,
        reason: readiness.summary,
        checks,
        summary,
        trigger,
        readiness,
        blockers,
        primaryBlocker: blockers[0] ?? null,
        tradeCadence: this.getTradeCadenceSnapshot(),
        timestamp: Date.now()
      };
    } catch (error) {
      if (isInsufficientDataError(error)) {
        return this.buildWarmupDiagnostics(error);
      }
      console.error('Diagnostics error:', error);
      const bias = this.plan?.bias || 'none';
      const dir = bias === 'short' ? -1 : 1;
      const runtimeChecks = {
        runtime: {
          status: 'FAIL',
          code: 'diagnostics.error',
          reason: 'unexpected_runtime_error',
          details: { message: String((error as any)?.message || error) },
        },
      } as const;
      return {
        canTrade: false,
        reason: 'diagnostics.error',
        errorCode: 'diagnostics.error',
        checks: runtimeChecks,
        summary: { totalChecks: 1, passed: 0, failed: 1, partial: 0, rejected: 0 },
        trigger: {
          entryReady: false,
          phase: 'error',
          bias,
          price: undefined,
          zone: this.plan?.zone ? { ...this.plan.zone } : null,
          inZone: false,
          confirmationOk: false,
          momentumOk: false,
          qualityOk: false,
          profitOk: false,
          tp1ProfitPct: 0,
          minProfitPct: cfg.MIN_TRADE_PROFIT_PCT,
          dir,
        },
        error: String((error as any)?.message || error),
        timestamp: Date.now(),
      };
    }
  }

  public canTradeNow(snap: TechnicalSnapshot): boolean {
    if (!this.profile || !this.plan) return false;
    if (this.state !== 'ARMED') return false;
    if (this.pos) return false; // Already have position
    if (this.entering) return false; // Currently entering

    const circuitProbe = this.circuitBreaker.canOpenTrade(new Date(), this.lastKnownEquityUsd);
    this.syncCircuitBreakerTelemetry(circuitProbe);
    if (!circuitProbe.allowed) return false;

    // Check bias switching
    const planBias = this.plan?.bias;
    const recommendedBias = this.performanceMetrics?.biasSwitching?.currentBias;
    if (planBias && recommendedBias && planBias !== recommendedBias && planBias !== 'none') return false;

    // Basic zone check
    const price = snap.last;
    const { playbook } = this.getContextualPlaybook(snap, planBias ?? 'none');
    const { zone, meta } = this.computeVolatilityAdjustedZone(snap, {
      planZone: this.plan.zone,
      bias: planBias ?? 'none',
      playbook,
      price,
    });
    this.runtimeEntryZone = zone;
    this.runtimeZoneDiagnostics = {
      anchor: meta.anchor,
      k: meta.k,
      atr: meta.atr,
      atrPct: meta.atrPct,
      atrPctBase: meta.atrPctBase,
      hysteresis: meta.hysteresis,
      breakoutDistancePct: 0,
      breakoutActive: false,
      breakoutDirection: 'none',
    };
    const zoneMin = Math.min(zone.from, zone.to) - meta.hysteresis;
    const zoneMax = Math.max(zone.from, zone.to) + meta.hysteresis;
    const inZone = price >= zoneMin && price <= zoneMax;
    let breakoutAllowed = false;
    if (!inZone) {
      const isLong = planBias === 'long';
      const isShort = planBias === 'short';
      const breakoutDistance = isLong && price > zoneMax
        ? (price - zoneMax) / price
        : isShort && price < zoneMin
          ? (zoneMin - price) / price
          : 0;
      const breakoutTolerance = 0.25 * (meta.atrPct / 100);
      const momentumGate = this.lastMomentumGateResult ?? this.evaluateMomentumGates(snap, 'enter', false);
      breakoutAllowed = playbook === 'momentum_breakout'
        && breakoutDistance > 0
        && breakoutDistance <= breakoutTolerance
        && momentumGate.status !== 'FAIL';
      if (breakoutAllowed) {
        this.runtimeZoneDiagnostics = {
          anchor: meta.anchor,
          k: meta.k,
          atr: meta.atr,
          atrPct: meta.atrPct,
          atrPctBase: meta.atrPctBase,
          hysteresis: meta.hysteresis,
          breakoutDistancePct: breakoutDistance,
          breakoutActive: true,
          breakoutDirection: isLong ? 'above' : 'below',
        };
      }
    }
    if (!inZone && !breakoutAllowed) return false;

    // Basic momentum gates
    return this.passesEntryMomentumGates(snap, 'enter', { emitEvents: false });
  }

  public async getDiagnosticChecks(snap: TechnicalSnapshot): Promise<any> {
    const checks: any = {};

    const cfg = getConfig();
    const now = Date.now();
    const aggressiveness = this.profile?.aggressiveness || 'reactive';

    // Basic state checks
    checks.hasPosition = {
      status: !this.pos ? 'PASS' : 'FAIL',
      reason: !this.pos ? 'No active position - ready for new entry' : 'Position already exists - cannot enter new trade',
      message: !this.pos ? 'No active position' : 'Position already exists',
      code: !this.pos ? 'state.no_position' : 'state.position_open',
    };

    checks.isArmed = {
      status: this.state === 'ARMED' ? 'PASS' : 'FAIL',
      reason: this.state === 'ARMED' ? 'Agent is armed and ready to trade' : `Agent is in ${this.state} state - must be ARMED to trade`,
      message: this.state === 'ARMED' ? 'Agent is armed' : `Agent state: ${this.state}`,
      code: this.state === 'ARMED' ? 'state.armed' : 'state.not_armed',
    };

    checks.isEntering = {
      status: !this.entering ? 'PASS' : 'FAIL',
      reason: !this.entering ? 'Not currently entering a position' : 'Entry process already in progress - wait for completion',
      message: !this.entering ? 'Not currently entering' : 'Entry in progress',
      code: !this.entering ? 'state.idle' : 'state.entry_in_progress',
    };

    const planBias = this.plan?.bias || 'none';
    const recommendedBias = this.performanceMetrics?.biasSwitching?.currentBias;
    const adaptiveBias = recommendedBias ?? 'none';
    const { playbook } = this.getContextualPlaybook(snap, planBias);

    const regimeLabel = (this.regime as any)?.label || (this.regime as any)?.playbook || 'unknown';
    const regimeAllows = !this.regime || (this.regime as any)?.shouldTrade !== false;
    checks.regimeGuard = {
      status: regimeAllows ? 'PASS' : 'FAIL',
      reason: regimeAllows
        ? 'Market regime allows trading'
        : `Regime ${regimeLabel} is in protective mode`,
      message: regimeAllows ? 'Regime ok' : `Regime: ${regimeLabel}`,
      code: regimeAllows ? 'regime.allowed' : 'regime.blocked',
    };

    const modeParams = getModeParams(aggressiveness);
    const cadence = this.evaluateTradeCadence('readiness');
    const baseCooldownMs = cadence.cooldownMs ?? modeParams?.tradeCooldownMs ?? cfg.TRADE_COOLDOWN_MS ?? 0;
    const timeSinceLastExit = this.lastExitTime > 0 ? now - this.lastExitTime : Number.POSITIVE_INFINITY;
    const cooldownActive = this.lastExitTime > 0 && timeSinceLastExit < baseCooldownMs;
    const cooldownRemainingSec = cooldownActive ? (baseCooldownMs - timeSinceLastExit) / 1000 : 0;
    checks.tradeCooldown = {
      status: cooldownActive ? 'FAIL' : 'PASS',
      reason: cooldownActive
        ? `Trade cooldown active: ${cooldownRemainingSec.toFixed(0)}s remaining`
        : 'Cooldown satisfied - ready for next entry',
      message: cooldownActive ? `${cooldownRemainingSec.toFixed(0)}s remaining` : 'Cooldown cleared',
      code: cooldownActive ? 'cooldown.active' : 'cooldown.clear',
      details: {
        remainingSec: Number(cooldownRemainingSec.toFixed(0)),
        baseCooldownMs,
        lastExitTime: this.lastExitTime || null,
        cadenceStage: cadence.stageLabel,
        cadenceStageIndex: cadence.stageIndex,
        cadenceSample: cadence.sampleSize,
        cadenceWinRate: cadence.lastWinRate,
      },
    };

    const circuitProbe = this.circuitBreaker.canOpenTrade(new Date(now), this.lastKnownEquityUsd);
    this.syncCircuitBreakerTelemetry(circuitProbe);
    checks.circuitBreaker = {
      status: circuitProbe.allowed ? 'PASS' : 'FAIL',
      reason: circuitProbe.allowed
        ? 'Circuit breaker allows new trades'
        : circuitProbe.reason || 'Circuit breaker cooldown active',
      message: circuitProbe.allowed ? 'Circuit breaker ok' : circuitProbe.reason || 'Circuit breaker blocking',
      code: circuitProbe.allowed ? 'circuit.ok' : 'circuit.blocked',
      details: {
        reason: circuitProbe.reason ?? null,
        cooldownUntil: circuitProbe.cooldownUntil ?? null,
      },
    };

    // Risk management checks (mode-adaptive limits)
    const limits = defaultLimits(aggressiveness);
    const maxDailyTrades = Math.max(1, cadence.maxTradesPerDay || limits.maxTradesPerDay);
    const maxConsecStops = limits.maxConsecutiveStops;

    checks.dailyTradeLimit = {
      status: (this.tradesToday || 0) < maxDailyTrades ? 'PASS' : 'FAIL',
      reason: (this.tradesToday || 0) < maxDailyTrades
        ? `Daily trades: ${this.tradesToday || 0}/${maxDailyTrades} - within limit (${aggressiveness} mode)`
        : `Daily trades: ${this.tradesToday || 0}/${maxDailyTrades} - limit exceeded for risk management`,
      message: `Trades today: ${this.tradesToday || 0}`,
      code: (this.tradesToday || 0) < maxDailyTrades ? 'limits.daily_ok' : 'limits.daily_exceeded',
      details: {
        stage: cadence.stageLabel,
        stageIndex: cadence.stageIndex,
        sampleSize: cadence.sampleSize,
        winRate: cadence.lastWinRate,
        maxDailyTrades,
      },
    };

    checks.consecutiveStopsLimit = {
      status: (this.consecutiveStops || 0) < maxConsecStops ? 'PASS' : 'FAIL',
      reason: (this.consecutiveStops || 0) < maxConsecStops
        ? `Consecutive stops: ${this.consecutiveStops || 0}/${maxConsecStops} - acceptable loss streak (${aggressiveness} mode)`
        : `Consecutive stops: ${this.consecutiveStops || 0}/${maxConsecStops} - circuit breaker activated`,
      message: `Consecutive stops: ${this.consecutiveStops || 0}`,
      code: (this.consecutiveStops || 0) < maxConsecStops ? 'limits.stops_ok' : 'limits.stops_exceeded',
    };

    // Liquidity guard (mirrors entry gate)
    if (this.plan?.sizing) {
      let liquidityStatus: 'PASS' | 'FAIL' | 'PARTIAL' = 'PASS';
      let liquidityReason = 'Liquidity sufficient';
      let liquidityCode = 'liquidity.ok';
      let liquidityDetails: Record<string, any> | undefined;

      try {
        const balance = this.broker ? await this.broker.balance() : null;
        const budgetFrac = resolveBudgetFraction(this.profile?.budgetFraction);
        const startBudgetCandidate = Number(this.profile?.startBalanceUsd ?? 0);
        const freeUsd = Number((balance as any)?.freeUsd ?? 0);
        const usableBase = startBudgetCandidate > 0 ? startBudgetCandidate : freeUsd;
        const usableBalance = Math.max(0, usableBase * budgetFrac);
        const riskPct = this.profile?.riskPerTradePct ?? 1.5;
        const leverage = Math.min(10, this.profile?.maxLeverage ?? 10);
        const stopPct = 0.5;
        const estimatedNotional = (usableBalance * (riskPct / 100) * leverage) / (stopPct / 100);
        const volume24h = Number((snap as any)?.volume24h ?? 0);
        const multiplier = cfg.LIQUIDITY_VOLUME_MULTIPLIER;

        if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
          liquidityStatus = 'PARTIAL';
          liquidityReason = 'Unable to estimate position size for liquidity check';
          liquidityCode = 'liquidity.unavailable';
        } else {
          const liquidityCheck = this.hasAdequateLiquidity(snap, estimatedNotional);
          liquidityStatus = liquidityCheck.adequate ? 'PASS' : 'FAIL';
          liquidityReason = liquidityCheck.reason;
          liquidityCode = liquidityCheck.adequate ? 'liquidity.ok' : 'liquidity.insufficient';
        }

        liquidityDetails = {
          estimatedNotional,
          volume24h,
          multiplier,
        };
      } catch (error) {
        liquidityStatus = 'PARTIAL';
        liquidityReason = `Unable to fetch balance for liquidity check: ${error instanceof Error ? error.message : String(error)}`;
        liquidityCode = 'liquidity.unavailable';
      }

      checks.liquidity = {
        status: liquidityStatus,
        reason: liquidityReason,
        message: liquidityReason,
        code: liquidityCode,
        details: liquidityDetails,
      };
    } else {
      checks.liquidity = {
        status: 'PASS',
        reason: 'Liquidity check skipped - sizing configuration unavailable',
        message: 'Sizing not configured',
        code: 'liquidity.skipped',
      };
    }

    // Zone and momentum checks
    const price = snap.last;
    const { zone: adaptiveZone, meta: zoneMeta } = this.computeVolatilityAdjustedZone(snap, {
      planZone: this.plan?.zone ?? null,
      bias: planBias,
      playbook,
      price,
    });
    this.runtimeEntryZone = adaptiveZone;
    const zoneMin = Math.min(adaptiveZone.from, adaptiveZone.to);
    const zoneMax = Math.max(adaptiveZone.from, adaptiveZone.to);
    const inZoneRaw = price >= zoneMin - zoneMeta.hysteresis && price <= zoneMax + zoneMeta.hysteresis;
    const momentumEvaluation = this.evaluateMomentumGates(snap, 'enter', false);
    const isLongBias = planBias === 'long';
    const isShortBias = planBias === 'short';
    const overHighPct = isLongBias && price > zoneMax ? (price - zoneMax) / price : 0;
    const underLowPct = isShortBias && price < zoneMin ? (zoneMin - price) / price : 0;
    const zoneAtrFraction = zoneMeta.atrPct > 0 ? zoneMeta.atrPct / 100 : 0;
    let breakoutTolerance = 0.25 * zoneAtrFraction;
    if (zoneAtrFraction > 0) {
      const breakoutMin = zoneAtrFraction * 0.2;
      const breakoutMax = zoneAtrFraction * 0.3;
      breakoutTolerance = Math.max(breakoutMin, Math.min(breakoutTolerance, breakoutMax));
    }
    const momentumAllowsBreakout = momentumEvaluation.status !== 'FAIL';
    const breakoutActive = playbook === 'momentum_breakout'
      && momentumAllowsBreakout
      && ((isLongBias && overHighPct > 0 && overHighPct <= breakoutTolerance)
        || (isShortBias && underLowPct > 0 && underLowPct <= breakoutTolerance));
    const inZone = inZoneRaw;
    const zonePass = inZone || breakoutActive;

    this.runtimeZoneDiagnostics = {
      anchor: zoneMeta.anchor,
      k: zoneMeta.k,
      atr: zoneMeta.atr,
      atrPct: zoneMeta.atrPct,
      atrPctBase: zoneMeta.atrPctBase,
      hysteresis: zoneMeta.hysteresis,
      breakoutDistancePct: isLongBias ? overHighPct : isShortBias ? underLowPct : 0,
      breakoutActive,
      breakoutDirection: breakoutActive ? (isLongBias ? 'above' : 'below') : 'none',
    };

    checks.inEntryZone = {
      status: zonePass ? 'PASS' : 'FAIL',
      reason: zonePass
        ? inZone
          ? `Price ${price.toFixed(4)} is within adaptive zone [${zoneMin.toFixed(4)}, ${zoneMax.toFixed(4)}]`
          : `Breakout mode: price ${price.toFixed(4)} outside zone by ${(this.runtimeZoneDiagnostics!.breakoutDistancePct * 100).toFixed(2)}% with momentum confirmation`
        : `Price ${price.toFixed(4)} is outside adaptive zone [${zoneMin.toFixed(4)}, ${zoneMax.toFixed(4)}] without breakout conditions`,
      message: `Price: ${price?.toFixed(4)}, Adaptive zone: ${zoneMin.toFixed(4)} - ${zoneMax.toFixed(4)}`,
      code: zonePass ? (inZone ? 'entry_zone.in_zone' : 'entry_zone.breakout_ok') : 'entry_zone.out_of_zone',
      details: {
        anchor: zoneMeta.anchor,
        k: zoneMeta.k,
        zoneLow: zoneMin,
        zoneHigh: zoneMax,
        hysteresis: zoneMeta.hysteresis,
        overHighPct,
        underLowPct,
        breakoutTolerance,
        breakoutActive,
        playbook,
      },
    };

    const requiresConfirmation = planBias !== 'none' && !this.gapEntryOverride;
    if (requiresConfirmation && this.plan) {
      if (breakoutActive && !inZone) {
        checks.entryConfirmation = {
          status: 'PASS',
          reason: 'Breakout momentum confirmed - bypassing pullback confirmation',
          message: 'Breakout confirmation satisfied',
          code: 'entry.breakout_confirmed',
          details: {
            breakoutDistancePct: this.runtimeZoneDiagnostics?.breakoutDistancePct ?? 0,
            breakoutDirection: this.runtimeZoneDiagnostics?.breakoutDirection ?? 'none',
          },
        };
      } else {
        const confirmation = this.confirmEntrySignal(snap, price, adaptiveZone, planBias as 'long' | 'short');
        checks.entryConfirmation = {
          status: confirmation.confirmed ? 'PASS' : 'FAIL',
          reason: confirmation.reason,
          message: confirmation.reason,
          code: confirmation.confirmed ? 'entry.confirmed' : 'entry.waiting_confirmation',
        };
      }
    } else {
      checks.entryConfirmation = {
        status: 'PASS',
        reason: requiresConfirmation ? 'Gap override active - confirmation bypassed' : 'Confirmation not required for this setup',
        message: requiresConfirmation ? 'Gap override - confirmation bypassed' : 'Confirmation not required',
        code: 'entry.confirmation_skipped',
      };
    }

    const antiWhaleEvaluation = this.evaluateAntiWhaleFilters(snap);
    checks.antiWhale = {
      status: antiWhaleEvaluation.status,
      reason: antiWhaleEvaluation.reason,
      message: antiWhaleEvaluation.reason,
      code: antiWhaleEvaluation.status === 'PASS' ? 'anti_whale.ok' : 'anti_whale.blocked',
      details: antiWhaleEvaluation.details,
    };

    checks.momentumGates = {
      status: momentumEvaluation.status,
      reason: momentumEvaluation.reasons.length
        ? momentumEvaluation.reasons.join(' | ')
        : 'All momentum requirements met (ATR, slope, trend alignment)',
      message: 'Momentum gates check',
      code: momentumEvaluation.status === 'FAIL'
        ? 'momentum.blocked'
        : momentumEvaluation.status === 'SOFT_FAIL'
          ? 'momentum.soft_fail'
          : 'momentum.ok',
      details: momentumEvaluation.details,
    };

    // Simplified quality filters (binary pass/fail for essential indicators)
    const previewKey = this.getQualitySnapshotKey(snap);
    let qualityDiagnostics = this.previewQualityDiagnostics && this.previewQualityDiagnostics.snapshotKey === previewKey
      ? this.previewQualityDiagnostics.data
      : null;
    let qualityAssessmentSnapshot = this.previewQualityDiagnostics && this.previewQualityDiagnostics.snapshotKey === previewKey
      ? this.previewQualityDiagnostics.assessment
      : null;
    const diagnosticsTier = this.profile ? this.getTierForSymbol(this.profile.symbol) : null;
    const qualityProfile = this.getQualityScoreProfile(playbook, aggressiveness || 'reactive');
    if (!qualityDiagnostics) {
      qualityDiagnostics = this.getQualityFiltersDiagnostics(snap);
      qualityAssessmentSnapshot = this.assessQualityScore(qualityDiagnostics, 0, {
        weights: qualityProfile.weights,
        majorityRatio: qualityProfile.majorityRatio,
        partialCredit: qualityProfile.partialCredit,
        minPassCount: qualityProfile.minPassCount,
        comboTolerance: qualityProfile.comboTolerance,
      }) as QualityAssessmentSnapshot;
    }
    checks.qualityFilters = qualityDiagnostics;

    // Calculate overall quality score based on points (0-100) - allow trading with 3/5 filters (60 points)
    const qualityAssessment = qualityAssessmentSnapshot ?? this.assessQualityScore(checks.qualityFilters, 0, {
      weights: qualityProfile.weights,
      majorityRatio: qualityProfile.majorityRatio,
      partialCredit: qualityProfile.partialCredit,
      minPassCount: qualityProfile.minPassCount,
      comboTolerance: qualityProfile.comboTolerance,
    });
    const qualityPoints = qualityAssessment.totalPoints;
    const maxPoints = qualityAssessment.maxPoints;
    // Mode-adaptive minimum quality score for diagnostics (aligned with env.ts)
    const minTradingPoints = this.computeQualityScoreThreshold(playbook, aggressiveness || 'reactive', diagnosticsTier);
    const evaluatedQuality = this.assessQualityScore(checks.qualityFilters, minTradingPoints, {
      weights: qualityProfile.weights,
      majorityRatio: qualityProfile.majorityRatio,
      partialCredit: qualityProfile.partialCredit,
      minPassCount: qualityProfile.minPassCount,
      comboTolerance: qualityProfile.comboTolerance,
    });
    checks.qualityScore = {
      current: qualityPoints,
      effective: evaluatedQuality.effectivePoints,
      bonus: evaluatedQuality.bonus,
      required: minTradingPoints, // Changed from maxPoints to minTradingPoints
      status: evaluatedQuality.allow ? 'PASS' : 'FAIL',
      reason: `Quality score: ${qualityPoints}/${maxPoints} points (effective ${evaluatedQuality.effectivePoints.toFixed(1)} with bonus ${evaluatedQuality.bonus.toFixed(1)}) - ${evaluatedQuality.allow ? 'Ready to trade' : 'Insufficient quality'}`,
      code: evaluatedQuality.allow ? 'quality.score_ok' : 'quality.score_below_threshold',
      compensated: evaluatedQuality.compensated,
      failingKeys: evaluatedQuality.failingKeys,
    };

    const momentumBiasAllows = checks.momentumGates?.code !== 'momentum.blocked';
    this.resetQualityPreview();
    const qualityPass = checks.qualityScore?.status === 'PASS';
    const antiWhalePass = checks.antiWhale?.status === 'PASS';
    const circuitPass = checks.circuitBreaker?.status === 'PASS';

    let activeBias = adaptiveBias;
    let biasOverrideReason: string | null = null;
    if (momentumBiasAllows && qualityPass && antiWhalePass && circuitPass) {
      activeBias = planBias;
      biasOverrideReason = 'all_gates_green';
    } else if (adaptiveBias === 'none' && planBias !== 'none') {
      activeBias = planBias;
      biasOverrideReason = 'adaptive_standby_fallback';
    }

    const finalAligned = planBias === 'none' || activeBias === 'none' || activeBias === planBias;
    checks.biasAlignment = {
      status: finalAligned ? 'PASS' : 'FAIL',
      reason: finalAligned
        ? `Active bias ${activeBias} aligned with plan bias ${planBias}`
        : `Active bias ${activeBias} differs from plan bias ${planBias}`,
      message: finalAligned ? 'Bias aligned' : `Bias mismatch (${planBias} vs ${activeBias})`,
      code: finalAligned
        ? biasOverrideReason ? 'bias.override_plan' : 'bias.aligned'
        : 'bias.misaligned',
      details: {
        playbook,
        planBias,
        adaptiveBias,
        activeBias,
        biasOverrideReason,
      },
    };
    this.lastBiasRouting = { playbook, planBias, adaptiveBias, activeBias, reason: biasOverrideReason };

    return checks;
  }

  public async getDiagnosticTrigger(snap: TechnicalSnapshot, checks: any) {
    const bias = this.plan?.bias || 'none';
    const zone = this.runtimeEntryZone ?? this.plan?.zone ?? null;
    const zoneDiagnostics = this.runtimeZoneDiagnostics;
    const price = snap.last;
    const cfg = getConfig();
    const dir = bias === 'short' ? -1 : 1;

    const hysteresis = zoneDiagnostics?.hysteresis ?? 0;
    const zoneMin = zone ? Math.min(zone.from, zone.to) - hysteresis : Number.NEGATIVE_INFINITY;
    const zoneMax = zone ? Math.max(zone.from, zone.to) + hysteresis : Number.POSITIVE_INFINITY;
    const mid = zone ? (zone.from + zone.to) / 2 : price;
    const inZone = zone ? price >= zoneMin && price <= zoneMax : false;
    const breakoutOk = zoneDiagnostics?.breakoutActive ?? false;

    const confirmationOk = this.diagnosticCheckAllows(checks, 'entryConfirmation');

    const momentumOk = this.diagnosticCheckAllows(checks, 'momentumGates') || checks?.qualityFilters?.momentum?.status === 'PASS';

    let qualityOk = this.diagnosticCheckAllows(checks, 'qualityScore');
    if (!qualityOk) {
      qualityOk = await this.passesQualityFilters(snap);
    }

    const liquidityOk = this.diagnosticCheckAllows(checks, 'liquidity');
    const antiWhaleOk = this.diagnosticCheckAllows(checks, 'antiWhale');
    const circuitOk = this.diagnosticCheckAllows(checks, 'circuitBreaker');
    const cooldownOk = this.diagnosticCheckAllows(checks, 'tradeCooldown');
    const regimeOk = this.diagnosticCheckAllows(checks, 'regimeGuard');
    const biasOk = this.diagnosticCheckAllows(checks, 'biasAlignment');
    const limitsOk =
      this.diagnosticCheckAllows(checks, 'dailyTradeLimit') &&
      this.diagnosticCheckAllows(checks, 'consecutiveStopsLimit');
    const baseStateOk =
      this.diagnosticCheckAllows(checks, 'hasPosition') &&
      this.diagnosticCheckAllows(checks, 'isArmed') &&
      this.diagnosticCheckAllows(checks, 'isEntering');

    const levelProfit = this.profile?.aggressiveness || 'reactive';
    let minProfitPct = cfg.MIN_TRADE_PROFIT_PCT;
    if (levelProfit === 'reactive') minProfitPct = Math.max(0.6, minProfitPct - 0.2);
    if (levelProfit === 'aggressive') minProfitPct = Math.max(0.5, minProfitPct - 0.3);

    const firstR = this.plan?.rPrices?.[0]?.r ?? 0;
    const tp1ProfitPct = price > 0 ? Math.abs((firstR * (this.plan?.stopDistance ?? 0)) / price) * 100 : 0;
    const profitOk = tp1ProfitPct >= minProfitPct;

    const readyPrechecks =
      baseStateOk &&
      limitsOk &&
      cooldownOk &&
      circuitOk &&
      regimeOk &&
      biasOk &&
      liquidityOk &&
      antiWhaleOk;

    const entryReady = readyPrechecks && (inZone || breakoutOk) && confirmationOk && momentumOk && qualityOk && profitOk;

    let phase: string;
    if (entryReady) phase = 'entry_ready';
    else if (!readyPrechecks) {
      if (!cooldownOk) phase = 'cooldown';
      else if (!regimeOk) phase = 'regime_blocked';
      else if (!circuitOk) phase = 'circuit_breaker';
      else if (!biasOk) phase = 'bias_blocked';
      else if (!limitsOk) phase = 'limits_reached';
      else if (!liquidityOk) phase = 'liquidity_blocked';
      else if (!antiWhaleOk) phase = 'anti_whale_blocked';
      else if (!this.diagnosticCheckAllows(checks, 'hasPosition')) phase = 'position_open';
      else if (!this.diagnosticCheckAllows(checks, 'isEntering')) phase = 'entering';
      else if (!this.diagnosticCheckAllows(checks, 'isArmed')) phase = 'inactive';
      else phase = 'inactive';
    } else if (!inZone && !breakoutOk) phase = 'out_of_zone';
    else if (!confirmationOk) phase = 'awaiting_confirmation';
    else if (!momentumOk) phase = 'awaiting_momentum';
    else if (!qualityOk) phase = 'awaiting_quality';
    else if (!profitOk) phase = 'awaiting_profit';
    else phase = 'scanning';

    return {
      entryReady,
      phase,
      bias,
      price,
      zone: zone ? { ...zone } : null,
      inZone,
      breakoutOk,
      confirmationOk,
      momentumOk,
      qualityOk,
      profitOk,
      liquidityOk,
      antiWhaleOk,
      circuitOk,
      cooldownOk,
      regimeOk,
      biasOk,
      tp1ProfitPct,
      minProfitPct,
      dir,
      activeBias: this.lastBiasRouting?.activeBias ?? bias,
      adaptiveBias: this.lastBiasRouting?.adaptiveBias ?? (this.performanceMetrics?.biasSwitching?.currentBias ?? 'none'),
      biasOverrideReason: this.lastBiasRouting?.reason ?? null,
      playbook: this.lastBiasRouting?.playbook ?? (this.plan?.plan?.meta?.playbook || this.regime?.playbook || 'unknown'),
      zoneDiagnostics: zoneDiagnostics
        ? {
            anchor: zoneDiagnostics.anchor,
            k: zoneDiagnostics.k,
            zoneLow: zone ? Math.min(zone.from, zone.to) : null,
            zoneHigh: zone ? Math.max(zone.from, zone.to) : null,
            hysteresis: zoneDiagnostics.hysteresis,
            breakoutDistancePct: zoneDiagnostics.breakoutDistancePct,
            breakoutDirection: zoneDiagnostics.breakoutDirection,
          }
        : null,
    };
  }

  public assessQualityScore(
    filters: Record<string, any>,
    minTradingPoints: number,
    opts?: {
      weights?: Record<string, number>;
      majorityRatio?: number;
      partialCredit?: number;
      minPassCount?: number;
      comboTolerance?: number;
    },
  ) {
    const entries = Object.entries(filters ?? {});
    let rawPoints = 0;
    let rawMaxPoints = 0;
    let weightedPoints = 0;
    let weightedMaxPoints = 0;
    let passCount = 0;
    let failCount = 0;
    let partialCount = 0;
    const failingKeys: string[] = [];
    const weightsApplied: Record<string, number> = {};

    const weightMap = opts?.weights ?? {};
    const majorityRatio = typeof opts?.majorityRatio === 'number'
      ? Math.min(0.85, Math.max(0.4, opts.majorityRatio))
      : 0.6;
    const partialCredit = typeof opts?.partialCredit === 'number'
      ? Math.min(0.8, Math.max(0.2, opts.partialCredit))
      : 0.5;
    const minPassCount = Math.max(1, opts?.minPassCount ?? 3);
    const comboTolerance = Math.max(0, opts?.comboTolerance ?? 5);

    for (const [key, filter] of entries) {
      if (!filter || typeof filter !== 'object') continue;
      const basePoints = typeof (filter as any).points === 'number' ? Number((filter as any).points) : 0;
      rawPoints += basePoints;
      rawMaxPoints += 20;
      const weight = (() => {
        const candidate = (weightMap as Record<string, number | undefined>)[key];
        return typeof candidate === 'number' && Number.isFinite(candidate) ? Number(candidate) : 1;
      })();
      weightsApplied[key] = weight;
      weightedPoints += basePoints * weight;
      weightedMaxPoints += 20 * weight;
      const status = (filter as any).status;
      if (status === 'PASS') passCount += 1;
      else if (status === 'FAIL') {
        failCount += 1;
        failingKeys.push(key);
      } else if (status === 'PARTIAL') {
        partialCount += 1;
      }
    }

    const normalizedPoints = weightedMaxPoints > 0 ? (weightedPoints / weightedMaxPoints) * 100 : 0;
    const rawNormalized = rawMaxPoints > 0 ? (rawPoints / rawMaxPoints) * 100 : 0;

    const momentumPass = filters?.momentum?.status === 'PASS';
    const volatilityPass = filters?.volatility?.status === 'PASS';
    const volumePass = filters?.volume?.status === 'PASS';
    const trendPass = filters?.trendAlignment?.status === 'PASS';
    const rsiPass = filters?.rsiPosition?.status === 'PASS';

    let synergyBonus = 0;
    if (momentumPass && volatilityPass && volumePass) synergyBonus += 6;
    if (trendPass && momentumPass) synergyBonus += 3;
    if (volumePass && trendPass) synergyBonus += 2;
    if (rsiPass && trendPass && momentumPass) synergyBonus += 2;
    if (partialCount > 0 && passCount >= 3) synergyBonus += 2;
    synergyBonus = Math.min(10, synergyBonus);

    const effectivePoints = Math.min(100, normalizedPoints + synergyBonus);
    const deficit = Math.max(0, minTradingPoints - effectivePoints);

    let allow = normalizedPoints >= minTradingPoints;
    let compensated = false;

    if (!allow && effectivePoints >= minTradingPoints) {
      const allowVolatilityComp = failingKeys.length === 1 && failingKeys[0] === 'volatility' && momentumPass && volumePass && trendPass;
      const allowTrendComp = failingKeys.length === 1 && failingKeys[0] === 'trendAlignment' && momentumPass && volatilityPass && volumePass;
      const allowRsiComp = failingKeys.length === 1 && failingKeys[0] === 'rsiPosition' && momentumPass && trendPass;
      const allowPartialComp = failingKeys.length === 0 && partialCount > 0;
      if (deficit <= comboTolerance && (allowVolatilityComp || allowTrendComp || allowRsiComp || allowPartialComp)) {
        allow = true;
        compensated = true;
      }
    }

    const totalChecks = passCount + failCount + partialCount;
    const effectivePasses = passCount + partialCount * partialCredit;
    const majorityThreshold = totalChecks > 0 ? Math.ceil(totalChecks * majorityRatio) : 0;

    if (!allow && totalChecks >= minPassCount) {
      const requiredPasses = Math.max(minPassCount, majorityThreshold);
      if (effectivePasses >= requiredPasses && effectivePoints >= Math.max(30, minTradingPoints - comboTolerance)) {
        allow = true;
        compensated = true;
      }
    }

    return {
      totalPoints: normalizedPoints,
      maxPoints: 100,
      effectivePoints,
      bonus: synergyBonus,
      passCount,
      failCount,
      partialCount,
      deficit,
      allow,
      compensated,
      failingKeys,
      rawPoints: rawNormalized,
      rawMaxPoints: 100,
      weightsApplied,
      majorityThreshold,
      effectivePasses,
    } satisfies QualityAssessmentSnapshot;
  }

  public getQualityFiltersDiagnostics(snap: TechnicalSnapshot): any {
    if (!this.plan) return {};

    const { playbook, context } = this.getContextualPlaybook(snap, this.plan.bias ?? 'none');
    const normalizedPlaybook = String(playbook);
    const price = snap.last;
    const bias = this.plan.bias;
    const snapshotId = (snap as any)?.id ?? (snap as any)?.snapshotId ?? null;
    const tfLTF = snap.meta?.tf ?? (snap.meta as any)?.ltf ?? null;
    const tfHTF = (snap.meta as any)?.htf ?? null;
    console.log(
      `🧪 Quality filters check | playbook=${normalizedPlaybook} bias=${bias} snapshot=${snapshotId ?? 'n/a'} ` +
      `tf=${tfLTF ?? 'n/a'} htf=${tfHTF ?? 'n/a'} regime=${context?.regime ?? 'n/a'}`,
    );
    const adx = Number((snap as any)?.adx14 ?? 0);
    const rsi = Number((snap as any)?.rsi14 ?? 50);
    const ema20 = Number((snap as any)?.ema20 ?? price);
    const ema50 = Number((snap as any)?.ema50 ?? price);
    const atrPct = Number((snap as any)?.atrPct ?? 0);
    const volume = Number((snap as any)?.volume ?? 0);
    const volumeMA = Number((snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? volume);

    const recognizedSignals = context?.recognizedStrategies ?? [];
    const targetBias = bias !== 'none' ? bias : context?.direction ?? 'none';
    const recognizedCandidates = targetBias === 'none'
      ? recognizedSignals
      : recognizedSignals.filter(signal => signal.bias === targetBias || signal.bias === 'both');
    const recognizedTop = recognizedCandidates[0] ?? null;
    const recognizedSummary = {
      status: recognizedTop
        ? recognizedTop.active && recognizedTop.confidence >= 0.5
          ? 'PASS'
          : recognizedTop.confidence >= 0.35
            ? 'PARTIAL'
            : 'FAIL'
        : 'FAIL',
      points: recognizedTop ? Math.round(Math.max(0, Math.min(1, recognizedTop.confidence)) * 20) : 0,
      details: {
        primary: recognizedTop
          ? {
            id: recognizedTop.id,
            bias: recognizedTop.bias,
            confidence: recognizedTop.confidence,
            active: recognizedTop.active,
            reasons: recognizedTop.reasons,
          }
          : null,
        candidates: recognizedCandidates.slice(0, 3).map(signal => ({
          id: signal.id,
          bias: signal.bias,
          confidence: signal.confidence,
          active: signal.active,
        })),
      },
      message: recognizedTop
        ? `${recognizedTop.id}:${recognizedTop.bias} conf=${recognizedTop.confidence.toFixed(2)}`
        : 'No recognized strategy alignment',
    };

    const computeVolumeDiagnostics = (opts?: { relax?: number; floorBoost?: number }) => {
      const cfg = getConfig();
      const level = this.profile?.aggressiveness || 'conservative';
      const ratio = volumeMA > 0 ? (volume / volumeMA) : 0;
      const usdVolumeMA = volumeMA > 0 ? volumeMA * price : 0;
      const baseRequired = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_BASE) ? cfg.QUALITY_VOLUME_RATIO_BASE : 0.6;
      const floor = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_FLOOR) ? cfg.QUALITY_VOLUME_RATIO_FLOOR : 0.4;
      const ceiling = Number.isFinite(cfg.QUALITY_VOLUME_RATIO_CEIL) ? cfg.QUALITY_VOLUME_RATIO_CEIL : 0.78;
      let required = baseRequired;
      if (level === 'reactive') required -= 0.05; else if (level === 'aggressive') required -= 0.10; else required += 0.02;
      if (usdVolumeMA >= cfg.QUALITY_VOLUME_RATIO_HIGH_USD) required -= 0.08;
      else if (usdVolumeMA >= cfg.QUALITY_VOLUME_RATIO_MEDIUM_USD) required -= 0.05;
      else if (usdVolumeMA <= cfg.QUALITY_VOLUME_RATIO_LOW_USD && usdVolumeMA > 0) required += 0.07;
      if (atrPct >= 1.4) required -= 0.03; else if (atrPct <= 0.45) required += 0.03;
      if (opts?.relax) required -= opts.relax;
      if (opts?.floorBoost) required = Math.max(required, floor + opts.floorBoost);
      // CMF-based modulation for diagnostics (align with gating behavior)
      try {
        const cmf20 = Number((snap as any)?.cmf20 ?? 0);
        const cmfStrong = Number(cfg.VOLUME_CMF_STRONG || 0.15);
        const cmfMinAdx = Number(cfg.VOLUME_CMF_MIN_ADX || 15);
        const adxVal = Number((snap as any)?.adx14 ?? 0);
        const planBias = this.plan?.bias || 'none';
        const cmfAligned = (planBias === 'long' && cmf20 >= cmfStrong) || (planBias === 'short' && cmf20 <= -cmfStrong);
        if (cmfAligned && adxVal >= cmfMinAdx) {
          const relaxBase = Number(cfg.VOLUME_CMF_RELAX || 0.15);
          const relaxCap = Number(cfg.VOLUME_CMF_RELAX_MAX || relaxBase);
          const magnitude = Math.max(1, Math.abs(cmf20) / Math.max(1e-6, cmfStrong));
          const relaxAmt = Math.min(relaxCap, relaxBase * magnitude);
          const floorCmf = level === 'aggressive' ? 0.20 : level === 'reactive' ? 0.28 : 0.35;
          required = Math.max(floorCmf, required - relaxAmt);
        }
      } catch {}

      required = Math.max(floor, Math.min(ceiling, required));
      const pass = volumeMA <= 0 ? volume > 0 : ratio >= required;
      return {
        status: pass ? 'PASS' : 'FAIL',
        reason: `Volume ratio ${(ratio || 0).toFixed(2)} should be >= ${required.toFixed(2)} (adj. by liquidity/volatility)`,
        points: pass ? 20 : 0,
        details: {
          currentVolume: volume,
          volumeMA,
          ratio: volumeMA > 0 ? ratio.toFixed(2) : 'N/A',
          required: required.toFixed(2),
          usdVolumeMA: Math.round(usdVolumeMA),
          cmf20: Number((snap as any)?.cmf20 ?? 0)
        }
      };
    };

    const emaSpreadPct = ema50 !== 0 ? ((ema20 - ema50) / ema50) * 100 : 0;

    if (normalizedPlaybook === 'trend_following') {
      const trendAligned = this.checkTrendAlignment(ema20, ema50, bias, {
        atrPct,
        adx,
        playbook: normalizedPlaybook,
        price,
      });
      const pullback = bias === 'long' || bias === 'short'
        ? this.assessTrendPullbackStructure(price, ema20, ema50, bias)
        : { ok: false, distanceToEma20: Number.NaN, distanceToEma50: Number.NaN, reason: 'unknown_bias' };
      const comboStatus = trendAligned && pullback.ok ? 'PASS' : (trendAligned || pullback.ok) ? 'PARTIAL' : 'FAIL';
      const comboPoints = trendAligned && pullback.ok ? 20 : (trendAligned || pullback.ok) ? 10 : 0;
      const adxThreshold = Math.max(16, this.getRealisticADXThreshold() + 1);
      const rsiBounds = bias === 'long' ? { min: 28, max: 82 } : { min: 18, max: 72 };
      const rsiPass = bias === 'long' || bias === 'short'
        ? rsi >= rsiBounds.min && rsi <= rsiBounds.max
        : false;

      return {
        trendAlignment: {
          status: comboStatus,
          reason: comboStatus === 'PASS'
            ? 'Trend aligned with healthy pullback toward EMA stack'
            : 'Trend-following entry requires EMA alignment and controlled pullback',
          points: comboPoints,
          details: {
            ema20: ema20.toFixed(4),
            ema50: ema50.toFixed(4),
            spreadPct: `${emaSpreadPct.toFixed(2)}%`,
            pullback,
          }
        },
        momentum: {
          status: adx >= adxThreshold ? 'PASS' : 'FAIL',
          reason: `ADX (${adx.toFixed(1)}) must stay above ${adxThreshold} to confirm trend persistence`,
          points: adx >= adxThreshold ? 20 : 0,
          details: { adx, threshold: adxThreshold }
        },
        rsiPosition: {
          status: rsiPass ? 'PASS' : 'FAIL',
          reason: bias === 'long'
            ? `RSI (${rsi.toFixed(1)}) should stay between ${rsiBounds.min}-${rsiBounds.max} to avoid exhaustion`
            : `RSI (${rsi.toFixed(1)}) should stay between ${rsiBounds.min}-${rsiBounds.max} to avoid exhaustion`,
          points: rsiPass ? 20 : 0,
          details: { rsi, bounds: rsiBounds, bias }
        },
        volatility: (() => {
          const baseMinAtr = this.effectiveEntryThresholds().ENTRY_MIN_ATR_PCT;
          const symForAtr = this.profile?.symbol || '';
          let thr = baseMinAtr;
          try { thr = this.getAdaptiveATRThresholdSync(symForAtr, baseMinAtr); } catch {}
          const pass = atrPct >= thr;
          return {
            status: pass ? 'PASS' : 'FAIL',
            reason: `ATR (${atrPct.toFixed(2)}%) must be >= ${thr}% to sustain trend continuation`,
            points: pass ? 20 : 0,
            details: { currentATR: atrPct, threshold: thr, base: baseMinAtr }
          };
        })(),
        volume: computeVolumeDiagnostics({ relax: 0.05, floorBoost: 0.02 }),
        recognizedStrategy: recognizedSummary,
      };
    }

    if (normalizedPlaybook === 'momentum_breakout') {
      const price = Number.isFinite(snap.last) ? Number(snap.last) : Number((snap as any)?.last ?? 0);
      const atrRequirement = Number.isFinite(atrPct)
        ? Math.max(0.2, 0.4 * Number(atrPct))
        : 0.5;
      const spreadToPricePct = price > 0 ? ((ema20 - ema50) / price) * 100 : 0;
      const directionalSpreadPct = bias === 'short' ? -spreadToPricePct : spreadToPricePct;
      const trendAligned = this.checkTrendAlignment(ema20, ema50, bias, {
        atrPct,
        adx,
        playbook: normalizedPlaybook,
        price,
      });
      const trendStatus: 'PASS' | 'SOFT_FAIL' = trendAligned ? 'PASS' : 'SOFT_FAIL';
      const trendPoints = trendAligned ? 20 : 14;

      return {
        trendAlignment: {
          status: trendStatus,
          reason: trendAligned
            ? 'Trend aligned with EMA stack and dynamic spread requirement met'
            : 'Momentum breakout expects EMA20/EMA50 alignment with dynamic ATR-weighted spread',
          points: trendPoints,
          details: {
            ema20: ema20.toFixed(4),
            ema50: ema50.toFixed(4),
            spreadToEma50Pct: `${emaSpreadPct.toFixed(2)}%`,
            spreadToPricePct: `${directionalSpreadPct.toFixed(2)}%`,
            requiredSpreadPct: `${atrRequirement.toFixed(2)}%`,
            sizeMultiplier: trendAligned ? 1 : 0.7,
          }
        },
        momentum: {
          status: adx >= this.getRealisticADXThreshold() ? 'PASS' : 'FAIL',
          reason: `ADX (${adx.toFixed(1)}) must be >= ${this.getRealisticADXThreshold()} to confirm trend strength (optimized threshold)`,
          points: adx >= this.getRealisticADXThreshold() ? 20 : 0,
          details: {
            currentADX: adx,
            threshold: this.getRealisticADXThreshold()
          }
        },
        rsiPosition: {
          status: this.checkRSIPosition(rsi, bias) ? 'PASS' : 'FAIL',
          reason: bias === 'long'
            ? `RSI (${rsi.toFixed(1)}) should be between 30-80 for long entries (realistic oversold detection)`
            : `RSI (${rsi.toFixed(1)}) should be between 20-70 for short entries (realistic overbought detection)`,
          points: this.checkRSIPosition(rsi, bias) ? 20 : 0,
          details: {
            currentRSI: rsi,
            bias,
            threshold: bias === 'long' ? '30-80' : '20-70'
          }
        },
        volatility: (() => {
          const baseMinAtr = this.effectiveEntryThresholds().ENTRY_MIN_ATR_PCT;
          const symForAtr = this.profile?.symbol || '';
          let thr = baseMinAtr;
          try { thr = this.getAdaptiveATRThresholdSync(symForAtr, baseMinAtr); } catch {}
          const pass = atrPct >= thr;
          return {
            status: pass ? 'PASS' : 'FAIL',
            reason: `ATR (${atrPct.toFixed(2)}%) must be >= ${thr}% to ensure sufficient volatility (adaptive per symbol)`,
            points: pass ? 20 : 0,
            details: { currentATR: atrPct, threshold: thr, base: baseMinAtr }
          };
        })(),
        volume: computeVolumeDiagnostics(),
        recognizedStrategy: recognizedSummary,
      };
    }

    // Mean reversion or other range-focused playbooks
    const srInfo = (() => {
      const srBias = (snap as any)?.srBias;
      const levels = bias === 'long' ? (snap.supports || []) : (snap.resistances || []);
      let nearest: { price: number; touches?: number; strength?: number } | null = null;
      let nearestDistancePct = Number.POSITIVE_INFINITY;
      for (const level of levels) {
        if (!level || typeof level.price !== 'number') continue;
        const distancePct = Math.abs((price - level.price) / price) * 100;
        if (distancePct < nearestDistancePct) {
          nearestDistancePct = distancePct;
          nearest = level;
        }
      }
      const srAligned = (bias === 'long' && srBias === 'nearSupport') || (bias === 'short' && srBias === 'nearResistance');
      const withinTolerance = nearestDistancePct <= 2.5;
      return {
        srAligned,
        withinTolerance,
        srBias,
        nearestPrice: nearest?.price ?? null,
        nearestTouches: nearest?.touches ?? null,
        distancePct: Number.isFinite(nearestDistancePct) ? nearestDistancePct : null,
      };
    })();
    const emaSlopeRaw = Number((snap as any)?.ema20Slope ?? 0);
    const emaSlopePct = ema20 !== 0 ? (emaSlopeRaw / ema20) * 100 : 0;
    const meanReversionAdxCap = 22;
    const emaFlat = Math.abs(emaSpreadPct) <= 1.0 && Math.abs(emaSlopePct) <= 1.0;
    const srTightAligned = srInfo.srAligned && srInfo.withinTolerance && emaFlat;
    const srTighterThanOnePct = srInfo.distancePct != null && srInfo.distancePct <= 1.0;
    const cmfForRsi = typeof (snap as any)?.cmf20 === 'number'
      ? Number((snap as any).cmf20)
      : 0;
    const rsiProfile = (() => {
      if (bias === 'long') {
        const strictPass = rsi <= 38;
        const relaxedPass = rsi >= 40 && rsi <= 45 && srTighterThanOnePct && srInfo.srAligned && cmfForRsi >= 0;
        return {
          strictPass,
          relaxedPass,
          severe: rsi <= 30,
          status: strictPass || relaxedPass,
          details: {
            strictMax: 38,
            relaxed: [40, 45],
            cmfRequired: '>= 0',
          },
        };
      }
      if (bias === 'short') {
        const strictPass = rsi >= 62;
        const relaxedPass = rsi <= 60 && rsi >= 55 && srTighterThanOnePct && srInfo.srAligned && cmfForRsi <= 0;
        return {
          strictPass,
          relaxedPass,
          severe: rsi >= 70,
          status: strictPass || relaxedPass,
          details: {
            strictMin: 62,
            relaxed: [55, 60],
            cmfRequired: '<= 0',
          },
        };
      }
      return { strictPass: false, relaxedPass: false, severe: false, status: false, details: {} };
    })();

    const moderateAtrBounds = (() => {
      const baseMinAtr = this.effectiveEntryThresholds().ENTRY_MIN_ATR_PCT;
      const lower = Math.max(0, baseMinAtr - 0.15);
      const upper = baseMinAtr + 1.2;
      return { lower, upper, base: baseMinAtr };
    })();

    return {
      trendAlignment: {
        status: srTightAligned ? 'PASS' : srInfo.srAligned ? 'SOFT_FAIL' : 'FAIL',
        reason: srTightAligned
          ? `Range confirmed: ${bias === 'long' ? 'support' : 'resistance'} respected and EMA spread/slope within ±1%.`
          : `Mean reversion requires flat EMA stack (spread & slope ≤ ±1%) and nearby ${bias === 'long' ? 'support' : 'resistance'} (≤2.5%).`,
        points: srTightAligned ? 20 : srInfo.srAligned ? 10 : 0,
        details: {
          ema20: ema20.toFixed(4),
          ema50: ema50.toFixed(4),
          emaSpreadPct: `${emaSpreadPct.toFixed(2)}%`,
          emaSlopePct: `${emaSlopePct.toFixed(2)}%`,
          srBias: srInfo.srBias,
          nearestLevel: srInfo.nearestPrice,
          distancePct: srInfo.distancePct != null ? `${srInfo.distancePct.toFixed(2)}%` : 'N/A',
          adx: adx.toFixed(2),
        }
      },
      momentum: {
        status: adx <= meanReversionAdxCap ? 'PASS' : 'FAIL',
        reason: `ADX (${adx.toFixed(1)}) must stay ≤ ${meanReversionAdxCap} to confirm a true range; higher ADX flips to trend mode.`,
        points: adx <= meanReversionAdxCap ? 20 : adx <= 25 ? 10 : 0,
        details: {
          currentADX: adx,
          tolerance: meanReversionAdxCap,
        }
      },
      rsiPosition: {
        status: rsiProfile.status && srInfo.srAligned ? 'PASS' : 'FAIL',
        reason: bias === 'long'
          ? `RSI (${rsi.toFixed(1)}) must tag ≤38, or 40–45 only if support is <1% away with positive CMF.`
          : `RSI (${rsi.toFixed(1)}) must tag ≥62, or 55–60 only if resistance is <1% away with negative CMF.`,
        points: (() => {
          if (!srInfo.srAligned) return 0;
          if (rsiProfile.strictPass) return rsiProfile.severe ? 20 : 15;
          if (rsiProfile.relaxedPass) return 10;
          return 0;
        })(),
        details: {
          currentRSI: rsi,
          bias,
          severe: rsiProfile.severe,
          srBias: srInfo.srBias,
          srDistancePct: srInfo.distancePct != null ? `${srInfo.distancePct.toFixed(2)}%` : 'N/A',
          cmf20: cmfForRsi,
          relaxedEligible: srTighterThanOnePct && srInfo.srAligned,
        }
      },
      volatility: {
        status: atrPct >= moderateAtrBounds.lower && atrPct <= moderateAtrBounds.upper ? 'PASS' : 'FAIL',
        reason: `ATR (${atrPct.toFixed(2)}%) should be between ${moderateAtrBounds.lower.toFixed(2)}% and ${moderateAtrBounds.upper.toFixed(2)}% for controlled mean-reversion swings.`,
        points: atrPct >= moderateAtrBounds.lower && atrPct <= moderateAtrBounds.upper ? 20 : atrPct >= moderateAtrBounds.lower ? 10 : 0,
        details: {
          currentATR: atrPct,
          lower: moderateAtrBounds.lower,
          upper: moderateAtrBounds.upper,
          base: moderateAtrBounds.base,
        }
      },
        volume: computeVolumeDiagnostics({ relax: 0.12, floorBoost: 0.05 }),
        recognizedStrategy: recognizedSummary,
      };
    }

  public checkTrendAlignment(
    ema20: number,
    ema50: number,
    bias: string,
    opts?: { atrPct?: number; adx?: number; playbook?: string; price?: number }
  ): boolean {
    if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || ema50 === 0) {
      return false;
    }

    const playbook = (opts?.playbook
      ?? (this.plan?.plan?.meta?.playbook as string | undefined)
      ?? (this.regime?.playbook as string | undefined)
      ?? 'mean_reversion').toString().toLowerCase();

    const priceBasis = playbook === 'momentum_breakout' && Number.isFinite(opts?.price) && Number(opts?.price) !== 0
      ? Number(opts?.price)
      : ema50;
    const spreadPct = priceBasis !== 0 ? ((ema20 - ema50) / priceBasis) * 100 : 0;
    const atrPct = Number.isFinite(opts?.atrPct) ? Math.max(0, Number(opts?.atrPct)) : undefined;
    const adx = Number.isFinite(opts?.adx) ? Number(opts?.adx) : undefined;

    let requiredSpread = 0.5;

    if (playbook === 'momentum_breakout') {
      requiredSpread = atrPct != null ? Math.max(0.2, 0.4 * atrPct) : 0.5;
    } else if (playbook === 'trend_following') {
      const atrDerived = atrPct != null ? Math.max(0.2, Math.min(0.6, atrPct * 0.4)) : 0.3;
      let dynamicRequirement = atrDerived;
      if (adx != null && adx >= 25) dynamicRequirement = Math.max(0.2, dynamicRequirement - 0.05);
      if (adx != null && adx >= 35) dynamicRequirement = Math.max(0.18, dynamicRequirement - 0.05);
      requiredSpread = Math.max(0.2, dynamicRequirement);
    } else if (atrPct != null) {
      const base = 0.35 + (atrPct - 0.6) * 0.15;
      requiredSpread = Math.max(0.3, Math.min(0.6, base));
    }

    const directionalSpread = bias === 'short' ? -spreadPct : spreadPct;

    if (bias === 'long') {
      return ema20 > ema50 && directionalSpread >= requiredSpread;
    }
    if (bias === 'short') {
      return ema20 < ema50 && directionalSpread >= requiredSpread;
    }
    return false;
  }

  public checkRSIPosition(rsi: number, bias: string): boolean {
    // Realistic RSI thresholds based on comprehensive analysis
    // These are optimal for all crypto types without false positives
    
    if (bias === 'long') {
      // Accept oversold opportunities (30) while avoiding extreme overbought (80)
      return rsi >= 30 && rsi <= 80;
    }
    
    if (bias === 'short') {
      // Accept deeper oversold for shorts (20) while allowing higher RSI entries (70)
      return rsi >= 20 && rsi <= 70;
    }
    
    return false;
  }

  public checkVolumeConfirmation(volume: number, volumeMA: number): boolean {
    if (volumeMA <= 0) return volume > 0;
    const ratio = volume / volumeMA;
    return ratio >= 0.8;
  }



  public getRealisticADXThreshold(): number {
    // Realistic ADX threshold: 15 is optimal for all crypto types
    // Captures sufficient momentum without being overly restrictive
    return 15;
  }

  public getDiagnosticSummary(checks: any): any {
    const checkValues = Object.values(checks);
    const totalChecks = checkValues.length;
    const passed = checkValues.filter((c: any) => c.status === 'PASS').length;
    const failed = checkValues.filter((c: any) => c.status === 'FAIL').length;
    const partial = checkValues.filter((c: any) => c.status === 'PARTIAL').length;
    const rejected = checkValues.filter((c: any) => c.status === 'REJECT').length;

    return {
      totalChecks,
      passed,
      failed,
      partial,
      rejected
    };
  }

  public getTradingReadinessReason(checks: any): {
    summary: string;
    primary: DiagnosticCheckRef | null;
    failingChecks: DiagnosticCheckRef[];
  } {
    const failingChecks: DiagnosticCheckRef[] = [];

    for (const [key, check] of Object.entries(checks)) {
      if (check && typeof check === 'object' && (check as any).status === 'FAIL') {
        failingChecks.push({
          key,
          code: (check as any).code || `diagnostic.${key}`,
          message: (check as any).message,
          reason: (check as any).reason,
        });
      } else if (key === 'qualityFilters' && check && typeof check === 'object') {
        for (const [subKey, subCheck] of Object.entries(check as Record<string, any>)) {
          if (subCheck && typeof subCheck === 'object' && (subCheck as any).status === 'FAIL') {
            failingChecks.push({
              key: `qualityFilters.${subKey}`,
              code: (subCheck as any).code || `quality.${subKey}.failed`,
              message: (subCheck as any).message,
              reason: (subCheck as any).reason,
            });
          }
        }
      }
    }

    if (failingChecks.length === 0) {
      return {
        summary: 'Ready to trade - all conditions met',
        primary: null,
        failingChecks: [],
      };
    }

    const summary = `Blocked by: ${failingChecks
      .map((check) => `${check.key}${check.message ? ` (${check.message})` : ''}`)
      .join(', ')}`;

    return {
      summary,
      primary: failingChecks[0],
      failingChecks,
    };
  }

  public extractDiagnosticBlockers(checks: any, failingChecks: DiagnosticCheckRef[]): DiagnosticBlocker[] {
    if (!Array.isArray(failingChecks) || failingChecks.length === 0) return [];

    return failingChecks.map((entry) => {
      const detail = this.lookupCheckDetail(checks, entry.key);
      const status = typeof detail?.status === 'string' ? detail.status : 'FAIL';
      const code = entry.code ?? (typeof detail?.code === 'string' ? detail.code : undefined);
      const message = entry.message ?? (typeof detail?.message === 'string' ? detail.message : undefined);
      const reason =
        entry.reason ??
        (typeof detail?.reason === 'string' ? detail.reason : undefined) ??
        message ??
        code ??
        entry.key;

      return {
        key: entry.key,
        code,
        message,
        reason,
        status,
      } satisfies DiagnosticBlocker;
    });
  }

  public lookupCheckDetail(checks: any, key: string): any {
    if (!key) return undefined;
    const segments = key.split('.');
    let current: any = checks;
    for (const segment of segments) {
      if (current == null) return undefined;
      current = (current as any)?.[segment];
    }
    return current;
  }

  public diagnosticCheckAllows(checks: any, key: string): boolean {
    const detail = this.lookupCheckDetail(checks, key);
    if (!detail || typeof detail !== 'object') return true;
    const rawStatus = (detail as any).status;
    if (rawStatus == null) return true;
    const status = String(rawStatus).toUpperCase();
    return status !== 'FAIL' && status !== 'BLOCK' && status !== 'REJECT' && status !== 'ERROR';
  }

  public emitValidatorBlockEvent(params: {
    snap: TechnicalSnapshot;
    checks: any;
    trigger: any;
    summary: any;
    readiness: { summary: string; primary: DiagnosticCheckRef | null; failingChecks: DiagnosticCheckRef[] };
  }): void {
    try {
      const { snap, trigger, readiness } = params;
      const snapshotMetrics = {
        price: snap.last,
        ema20: (snap as any)?.ema20 ?? null,
        ema50: (snap as any)?.ema50 ?? null,
        adx14: (snap as any)?.adx14 ?? null,
        rsi14: (snap as any)?.rsi14 ?? null,
        atrPct: (snap as any)?.atrPct ?? null,
        volume: (snap as any)?.volume ?? null,
        volumeMA: (snap as any)?.volumeMA ?? (snap as any)?.volumeAvg ?? null,
      };

      recordOpsEvent({
        level: 'warn',
        source: 'entry_gate',
        message: 'validator_of_signal_block',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          primary: readiness.primary,
          failingChecks: readiness.failingChecks,
          summary: readiness.summary,
          trigger,
          snapshot: snapshotMetrics,
          agentState: this.state,
          qualityFilterFailure: this.lastQualityFilterFailure,
        },
      });
    } catch (error) {
      console.error('Failed to record validator block event', error);
    }
  }

  public ensurePerformanceMetricsSkeleton(profile: ActivationProfile): void {
    if (this.performanceMetrics) {
      this.performanceMetrics.symbol = profile.symbol;
      const circuitState = this.circuitBreaker.getState();
      this.performanceMetrics.circuitBreaker.lossThreshold = this.quantConfig.risk.maxConsecutiveLosses;
      this.performanceMetrics.circuitBreaker.lossStreak = circuitState.consecutiveLosses;
      this.performanceMetrics.circuitBreaker.winStreak = circuitState.consecutiveWins ?? 0;
      this.performanceMetrics.circuitBreaker.sizeMultiplier = this.circuitBreaker.sizeMultiplier();
      this.performanceMetrics.circuitBreaker.resumeAt = circuitState.cooldownUntil?.getTime() ?? null;
      const cadence = this.getTradeCadenceSnapshot();
      this.performanceMetrics.tradeCadence = {
        stageIndex: cadence.stageIndex,
        label: cadence.stageLabel,
        maxTradesPerDay: cadence.maxTradesPerDay,
        cooldownMs: cadence.cooldownMs,
        winRate: cadence.lastWinRate,
        sampleSize: cadence.sampleSize,
        lastUpdated: cadence.lastUpdated,
      };
      return;
    }
    this.performanceMetrics = {
      symbol: profile.symbol,
      totalTrades: 0,
      winRate: 0,
      profitRatio: 0,
      maxDrawdown: 0,
      dailyPnL: 0,
      strategyPerformance: new Map(),
      circuitBreaker: {
        isActive: false,
        reason: 'ready',
        activatedAt: 0,
        lossThreshold: this.quantConfig.risk.maxConsecutiveLosses,
        winRateThreshold: 0,
        lossStreak: 0,
        winStreak: 0,
        sizeMultiplier: 1,
        resumeAt: null,
      },
      tradeCadence: {
        stageIndex: this.tradeCadenceState.stageIndex,
        label: this.tradeCadenceState.stageLabel,
        maxTradesPerDay: this.tradeCadenceState.maxTradesPerDay,
        cooldownMs: this.tradeCadenceState.cooldownMs,
        winRate: this.tradeCadenceState.lastWinRate,
        sampleSize: this.tradeCadenceState.sampleSize,
        lastUpdated: this.tradeCadenceState.lastUpdated,
      },
      adaptationState: {
        atrMultiplier: 1,
        adxMultiplier: 1,
        qualityThresholdAdjustment: 0,
        lastUpdated: Date.now(),
      },
      biasSwitching: {
        currentBias: 'standby',
        lastBiasSwitch: Date.now(),
        consecutiveLosses: 0,
        triggerThreshold: 0,
      },
    };
  }

  public async computeEffectiveRrThreshold(): Promise<{
    effective: number;
    dynamic?: number;
    winRate?: number;
    trades: number;
    mode: 'base' | 'dynamic';
    hysteresisApplied: boolean;
  }> {
    const cfg = this.rrExpectancyConfig ?? DEFAULT_RR_EXPECTANCY_CONFIG;
    const clampToRange = (value: number) => Math.max(cfg.rrFloor, Math.min(cfg.rrCeil, Math.round(value * 100) / 100));
    const discoveryTrades = this.performanceMetrics?.totalTrades ?? 0;
    let base = clampToRange(cfg.rrBaseMin);
    if (this.isMemeCoin(this.profile?.symbol)) {
      base = clampToRange(base - 0.05);
    }
    const discoveryThreshold = Math.max(10, Math.floor(cfg.minTrades / 2));
    if (discoveryTrades < discoveryThreshold) {
      base = clampToRange(Math.min(base, cfg.rrFloor + 0.2));
    }
    if (this.drySpellState.steps > 0) {
      const rrRelax = Math.min(0.2, this.drySpellState.steps * 0.05);
      base = clampToRange(base - rrRelax);
    }

    if (!cfg.enabled || !this.sessionId) {
      this.rrExpectancyState.lastEffective = base;
      this.currentRrMin = base;
      const snapshot = { effective: base, dynamic: undefined, winRate: undefined, trades: 0, mode: 'base' as const, hysteresisApplied: false };
      this.lastRrSnapshot = snapshot;
      return snapshot;
    }

    let winRate: number | undefined;
    let trades = 0;
    let dynamic: number | undefined;
    let mode: 'base' | 'dynamic' = 'base';
    let hysteresisApplied = false;
    const prevEffective = this.rrExpectancyState.lastEffective;

    try {
      const result = await getAgentRecentWinRate(this.sessionId, {
        maxTrades: Math.max(cfg.minTrades * 2, cfg.minTrades + 20),
        minTrades: cfg.minTrades,
        lookbackDays: cfg.lookbackDays,
        decay: cfg.decay,
      });
      trades = result.trades;
      if (result.p != null && trades >= cfg.minTrades) {
        mode = 'dynamic';
        winRate = result.p;
        const prevWinRate = this.rrExpectancyState.lastWinRate;
        if (prevWinRate != null && Math.abs(prevWinRate - winRate) > 0.1) {
          console.warn(
            `[RR_EXPECTANCY] Win rate swing for session ${this.sessionId}: ${(prevWinRate * 100).toFixed(1)}% → ${(winRate * 100).toFixed(1)}%`,
          );
        }
        this.rrExpectancyState.lastWinRate = winRate;
        dynamic = rrMinFromWinrate(winRate, cfg);
        const blended = blendRR(cfg.rrBaseMin, dynamic, cfg.blend);
        const clamped = clampToRange(blended);
        const withHysteresis = applyHysteresis(prevEffective, clamped, cfg.hysteresis);
        hysteresisApplied = withHysteresis !== clamped;
        const effective = clampToRange(withHysteresis);
        this.rrExpectancyState.lastEffective = effective;
        this.currentRrMin = effective;
        const snapshot = { effective, dynamic, winRate, trades, mode, hysteresisApplied };
        this.lastRrSnapshot = snapshot;
        return snapshot;
      }
      if (result.p != null) {
        this.rrExpectancyState.lastWinRate = result.p;
      }
    } catch (error) {
      console.warn(`[RR_EXPECTANCY] Failed to compute recent win rate for session ${this.sessionId}:`, error);
    }

    this.rrExpectancyState.lastEffective = base;
    this.currentRrMin = base;
    const snapshot = { effective: base, dynamic, winRate, trades, mode, hysteresisApplied };
    this.lastRrSnapshot = snapshot;
    return snapshot;
  }

  public syncCircuitBreakerTelemetry(decision?: CircuitBreakerDecision): void {
    if (!this.performanceMetrics) return;
    const state = this.circuitBreaker.getState();
    const now = Date.now();
    const cooldownActive = !!(state.cooldownUntil && state.cooldownUntil.getTime() > now);
    const blocked = decision?.allowed === false;
    const isActive = blocked || cooldownActive;
    const reason = blocked
      ? decision?.reason || 'circuit_blocked'
      : cooldownActive
        ? `cooldown_until_${state.cooldownUntil?.toISOString()}`
        : 'ready';
    const activatedAt = isActive
      ? (state.cooldownUntil
        ? state.cooldownUntil.getTime() - (this.quantConfig.risk.cooldownMinutes * 60 * 1000)
        : now)
      : 0;
    const prevWinRateThreshold = this.performanceMetrics.circuitBreaker?.winRateThreshold ?? 0;
    const sizeMultiplier = this.circuitBreaker.sizeMultiplier();
    const lossStreak = state.consecutiveLosses;
    const winStreak = state.consecutiveWins ?? 0;
    const resumeAt = cooldownActive ? state.cooldownUntil!.getTime() : null;
    this.performanceMetrics.circuitBreaker = {
      isActive,
      reason,
      activatedAt,
      lossThreshold: this.quantConfig.risk.maxConsecutiveLosses,
      winRateThreshold: prevWinRateThreshold,
      lossStreak,
      winStreak,
      sizeMultiplier,
      resumeAt,
    };
  }

  public noteSignalDrop(message: string, level: 'info' | 'warn' = 'info', details?: Record<string, unknown>): void {
    try {
      recordOpsEvent({
        level,
        source: 'entry_gate',
        message,
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details,
      });
    } catch {}
  }

  public logEntryDecision(
    decision: 'ENTER' | 'SKIP',
    summary: {
      reason?: string | null;
      side: 'buy' | 'sell';
      qty: number;
      notionalUsd: number;
      leverage: number;
      rr?: number | null;
      adx?: number | null;
      atrPct?: number | null;
      tp1Pct?: number | null;
      level?: 'info' | 'warn';
    },
    debug?: Record<string, unknown>,
  ): void {
    const symbol = this.profile?.symbol ?? 'UNKNOWN';
    const reason = summary.reason ?? (decision === 'SKIP' ? 'unspecified' : 'ok');
    const level = summary.level ?? (decision === 'SKIP' ? 'warn' : 'info');
    const decisionId = `${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const formatPct = (value: number | null | undefined, fractionDigits: number) =>
      value != null && Number.isFinite(value)
        ? `${value.toFixed(fractionDigits)}${fractionDigits === 0 ? '' : '%'}`
        : 'n/a';
    const qtyFormatted = summary.qty > 0 ? summary.qty.toFixed(6) : '0.000000';
    const notionalFormatted = summary.notionalUsd > 0 ? `$${summary.notionalUsd.toFixed(2)}` : '$0.00';
    const message = [
      '[ENTRY]',
      `decision=${decision}`,
      `symbol=${symbol}`,
      `side=${summary.side.toUpperCase()}`,
      `reason=${reason}`,
      `qty=${qtyFormatted}`,
      `notion=${notionalFormatted}`,
      `lev_cap=${summary.leverage.toFixed(2)}`,
      `rr=${summary.rr != null && Number.isFinite(summary.rr) ? summary.rr.toFixed(2) : 'n/a'}`,
      `adx=${summary.adx != null && Number.isFinite(summary.adx) ? summary.adx.toFixed(1) : 'n/a'}`,
      `atr%=${formatPct(summary.atrPct ?? null, 2)}`,
      `tp1%=${formatPct(summary.tp1Pct ?? null, 2)}`,
    ].join(' ');

    recordOpsEvent({
      level,
      source: 'entry_gate',
      message,
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        decisionId,
        decision,
        reason,
        qty: summary.qty,
        notionalUsd: summary.notionalUsd,
        leverage: summary.leverage,
        rr: summary.rr ?? null,
        adx: summary.adx ?? null,
        atrPct: summary.atrPct ?? null,
        tp1Pct: summary.tp1Pct ?? null,
      },
    });

    if (debug) {
      recordOpsEvent({
        level: 'debug',
        source: 'entry_gate',
        message: 'entry_decision_detail',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          decisionId,
          decision,
          reason,
          context: debug,
        },
      });
    }
  }

  public resolveDrySpellRelaxation(now = Date.now()): EntryRelaxation | null {
    const cfg = this.quantConfig.filters.dynamic?.drySpell;
    if (!cfg || !cfg.enabled) return null;
    const lastTradeTs = this.drySpellState.lastTradeTs;
    if (!lastTradeTs) return null;
    const minutesSinceTrade = (now - lastTradeTs) / 60000;
    if (minutesSinceTrade < Math.max(0, cfg.minMinutesWithoutTrade)) {
      return null;
    }
    const maxSteps = Math.max(0, cfg.maxSteps ?? 0);
    const steps = Math.min(
      Math.max(0, this.drySpellState.steps),
      maxSteps > 0 ? maxSteps : Math.max(0, this.drySpellState.steps),
    );
    if (steps <= 0) return null;
    const relaxation: EntryRelaxation = {};
    if (cfg.minAdxDeltaPerStep) relaxation.minAdxDelta = cfg.minAdxDeltaPerStep * steps;
    if (cfg.minRrDeltaPerStep) relaxation.minRrDelta = cfg.minRrDeltaPerStep * steps;
    if (cfg.confidenceDeltaPerStep) relaxation.confidenceDelta = cfg.confidenceDeltaPerStep * steps;
    if (cfg.minAtrPctDeltaPerStep) relaxation.minAtrPctDelta = cfg.minAtrPctDeltaPerStep * steps;
    return Object.keys(relaxation).length > 0 ? relaxation : null;
  }

  public registerFilterRejection(reasons?: Record<string, string>): void {
    this.recordFilterRejectionStats(reasons);
    this.drySpellState.rejections = Math.max(0, this.drySpellState.rejections + 1);
    const cfg = this.quantConfig.filters.dynamic?.drySpell;
    if (!cfg || !cfg.enabled) return;
    const now = Date.now();
    const lastTradeTs = this.drySpellState.lastTradeTs;
    if (!lastTradeTs) return;
    const minutesSinceTrade = (now - lastTradeTs) / 60000;
    if (minutesSinceTrade < Math.max(0, cfg.minMinutesWithoutTrade)) {
      return;
    }
    const maxSteps = Math.max(0, cfg.maxSteps ?? 0);
    if (maxSteps === 0) return;
    if (this.drySpellState.steps >= maxSteps) {
      return;
    }
    const threshold = Math.max(1, cfg.rejectionsForStep ?? 1);
    if (this.drySpellState.rejections < threshold) {
      return;
    }
    const cooldownMinutes = Math.max(0, cfg.relaxationStepMinutes ?? 0);
    const minutesSinceLastStep = this.drySpellState.lastStepTs
      ? (now - this.drySpellState.lastStepTs) / 60000
      : Number.POSITIVE_INFINITY;
    if (minutesSinceLastStep < cooldownMinutes) {
      return;
    }
    this.drySpellState.steps += 1;
    this.drySpellState.lastStepTs = now;
    this.drySpellState.rejections = 0;
    recordOpsEvent({
      level: 'info',
      source: 'entry_filters',
      message: 'dry_spell_relaxation_step',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        step: this.drySpellState.steps,
        minutesSinceTrade: Number(minutesSinceTrade.toFixed(1)),
        maxSteps,
        threshold,
        reasons,
      },
    });
  }

  public recordFilterRejectionStats(reasons?: Record<string, string> | null, now = Date.now()): void {
    const stats = this.filterRejectionStats;
    stats.total += 1;
    let recorded = false;
    if (reasons) {
      for (const [key, value] of Object.entries(reasons)) {
        if (typeof value === 'string' && value.toUpperCase().startsWith('FAIL')) {
          stats.failCounts.set(key, (stats.failCounts.get(key) ?? 0) + 1);
          recorded = true;
        }
      }
    }
    if (!recorded) {
      stats.failCounts.set('unknown', (stats.failCounts.get('unknown') ?? 0) + 1);
    }

    const threshold = 8;
    const intervalMs = 10 * 60 * 1000;
    const timeSinceLog = stats.lastLogTs > 0 ? now - stats.lastLogTs : 0;
    const shouldLog = stats.total >= threshold || (stats.total > 0 && timeSinceLog >= intervalMs);
    if (!shouldLog) return;

    const topReasons = Array.from(stats.failCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    try {
      recordOpsEvent({
        level: 'info',
        source: 'entry_filters',
        message: 'entry_filter_rejections_summary',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          total: stats.total,
          topReasons,
          drySpellSteps: this.drySpellState.steps,
          rejectionsSinceTrade: this.drySpellState.rejections,
          minutesSinceLastTrade: this.drySpellState.lastTradeTs
            ? Number(((now - this.drySpellState.lastTradeTs) / 60000).toFixed(1))
            : null,
        },
      });
    } catch {}

    stats.total = 0;
    stats.failCounts.clear();
    stats.lastLogTs = now;
  }

  public registerFilterPass(): void {
    if (this.drySpellState.rejections > 0) {
      this.drySpellState.rejections = Math.max(0, this.drySpellState.rejections - 1);
    }
  }

  public noteDrySpellTrade(now = Date.now()): void {
    this.drySpellState = {
      rejections: 0,
      steps: 0,
      lastStepTs: 0,
      lastTradeTs: now,
    };
    this.resetFilterRejectionStats(now);
  }

  public resetFilterRejectionStats(now = Date.now()): void {
    this.filterRejectionStats.total = 0;
    this.filterRejectionStats.failCounts.clear();
    this.filterRejectionStats.lastLogTs = now;
  }

  public isEntriesOnlyHaltActive(): boolean {
    return this.marginHaltState.active && this.marginHaltState.mode === 'entries_only';
  }

  public setMarginHalt(mode: 'entries_only' | 'full', reason: string, details?: Record<string, unknown>): void {
    const now = Date.now();
    const sameMode = this.marginHaltState.active && this.marginHaltState.mode === mode;
    this.marginHaltState.active = true;
    this.marginHaltState.mode = mode;
    this.marginHaltState.lastBreachTs = now;
    if (!sameMode) {
      this.marginHaltState.activatedAt = now;
    }

    recordOpsEvent({
      level: mode === 'entries_only' ? 'warn' : 'error',
      source: 'margin_guard',
      message: mode === 'entries_only' ? 'margin_halt_entries_only' : 'margin_halt_full',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        reason,
        mode,
        ...(details || {}),
      },
    });

    if (mode === 'full') {
      this.state = 'HALT';
      this.entering = false;
    }
  }

  public clearMarginHalt(reason: string, snapshot?: BrokerMarginSnapshot | null): void {
    if (!this.marginHaltState.active) return;

    const referenceSnapshot = snapshot || this.lastMarginSnapshot;
    const advisor = referenceSnapshot ? createMarginAdvisor(referenceSnapshot) : null;
    const utilisation = advisor ? advisor.utilisationPct() : undefined;

    this.marginHaltState = { active: false, mode: null, activatedAt: 0, lastBreachTs: 0 };

    recordOpsEvent({
      level: 'info',
      source: 'margin_guard',
      message: 'halt_released',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol,
      details: {
        reason,
        utilisationPct: utilisation,
      },
    });
  }

  public maybeReleaseMarginHalt(snapshot: BrokerMarginSnapshot): void {
    this.lastMarginSnapshot = snapshot;
    if (!this.marginHaltState.active || this.marginHaltState.mode !== 'entries_only') return;

    const cfg = getConfig();
    const advisor = createMarginAdvisor(snapshot);
    const utilisation = advisor.utilisationPct();
    const resumeThreshold = Math.max(0, cfg.MARGIN_HALT_RESUME_PCT ?? cfg.MARGIN_UTIL_CRITICAL_PCT);
    const cooldownMs = Math.max(0, cfg.MARGIN_HALT_RELEASE_COOLDOWN_MS ?? 10_000);
    const now = Date.now();

    if (utilisation < resumeThreshold && now - this.marginHaltState.lastBreachTs > cooldownMs) {
      this.clearMarginHalt('auto_resume', snapshot);
    }
  }

  public async enforceMarginAfterFill(effectiveLev: number, executionPrice: number): Promise<void> {
    if (!this.broker || !this.profile || !this.pos) return;

    let snapshot: BrokerMarginSnapshot;
    try {
      snapshot = await this.broker.balance();
    } catch (error) {
      recordOpsEvent({
        level: 'warn',
        source: 'margin_guard',
        message: 'margin_auto_reduce_balance_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { error: String((error as any)?.message || error) },
      });
      return;
    }

    this.maybeReleaseMarginHalt(snapshot);
    const cfg = getConfig();
    const advisor = createMarginAdvisor(snapshot);
    const utilisation = advisor.utilisationPct();
    const critical = cfg.MARGIN_UTIL_CRITICAL_PCT ?? 75;
    if (utilisation <= critical) return;

    const targetBase = cfg.MARGIN_HALT_TARGET_PCT ?? Math.max(0, critical - 7);
    const target = Math.min(targetBase, critical - 1);

    this.setMarginHalt('entries_only', 'post_fill_breach', {
      utilisationPct: utilisation,
      critical,
      target,
    });

    const leverageHint = Math.max(1, Number.isFinite(effectiveLev) && effectiveLev > 0 ? effectiveLev : 1);
    let notionalToReduce = advisor.notionalToReduceTo(target, leverageHint);
    if (!(notionalToReduce > 0)) return;

    const referencePrice = executionPrice > 0 ? executionPrice : this.pos.entry;
    if (!(referencePrice > 0) || !(this.pos.qty > 0)) return;

    const qtyToReduce = Math.min(this.pos.qty, notionalToReduce / referencePrice);
    if (!(qtyToReduce > 0)) return;

    try {
      const reduceSide = this.pos.side === 'buy' ? 'sell' : 'buy';
      const reduceOrder = await this.broker.place({
        symbol: this.profile.symbol,
        side: reduceSide,
        type: 'market',
        qty: qtyToReduce,
        leverage: leverageHint,
        reduceOnly: true,
      });

      const filledQty = Number(reduceOrder?.filledQty ?? 0);
      if (filledQty > 0 && this.pos) {
        this.pos.qty = Math.max(0, this.pos.qty - filledQty);
      }

      recordOpsEvent({
        level: filledQty > 0 ? 'info' : 'warn',
        source: 'margin_guard',
        message: filledQty > 0 ? 'margin_auto_reduce_filled' : 'margin_auto_reduce_submitted',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          utilisationPct: utilisation,
          critical,
          target,
          requestedQty: qtyToReduce,
          filledQty,
        },
      });
    } catch (error) {
      recordOpsEvent({
        level: 'error',
        source: 'margin_guard',
        message: 'margin_auto_reduce_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: {
          utilisationPct: utilisation,
          critical,
          target,
          error: String((error as any)?.message || error),
        },
      });
    }
  }

  public buildWarmupDiagnostics(error: InsufficientDataError): any {
    const cfg = getConfig();
    const bias = this.plan?.bias || 'none';
    const dir = bias === 'short' ? -1 : 1;
    const now = Date.now();
    const warmupMeta = {
      ...error.meta,
      firstBarAtIso: error.meta.firstBarAt ? new Date(error.meta.firstBarAt).toISOString() : null,
      lastBarAtIso: error.meta.lastBarAt ? new Date(error.meta.lastBarAt).toISOString() : null,
      retryMs: error.meta.warmupState?.nextRetryTs ? Math.max(0, error.meta.warmupState.nextRetryTs - now) : undefined,
    };

    const checks = {
      marketData: {
        status: 'FAIL',
        code: 'data.insufficient_bars',
        reason: 'warmup_insufficient_bars_15m',
        details: warmupMeta,
      },
    } as const;

    const summary = { totalChecks: 1, passed: 0, failed: 1, partial: 0, rejected: 0 };

    return {
      canTrade: false,
      reason: 'data.insufficient_bars',
      errorCode: 'data.insufficient_bars',
      warmup: warmupMeta,
      checks,
      summary,
      trigger: {
        entryReady: false,
        phase: 'warming',
        bias,
        price: undefined,
        zone: this.plan?.zone ? { ...this.plan.zone } : null,
        inZone: false,
        confirmationOk: false,
        momentumOk: false,
        qualityOk: false,
        profitOk: false,
        tp1ProfitPct: 0,
        minProfitPct: cfg.MIN_TRADE_PROFIT_PCT,
        dir,
      },
      timestamp: now,
    };
  }

  // Stub implementations for missing methods - to be implemented properly later

  public async logMovement(message: string, details: string, metadata?: any): Promise<void> {
    console.log(`[AGENT ${this.profile?.symbol}] ${message}: ${details}`);
  }

  public formatPrice(price: number): string {
    return price.toFixed(6);
  }

  public halt(mode: 'entries_only' | 'full' = 'full'): void {
    this.setMarginHalt(mode, 'external_halt');
    if (mode === 'full') {
      console.log(`Agent ${this.profile?.symbol} halted`);
    } else {
      console.log(`Agent ${this.profile?.symbol} margin-halt entries only`);
    }
  }

  public async restorePersistedPosition(): Promise<void> {
    if (!this.sessionId) {
      console.log('No session ID available for position restoration');
      return;
    }

    try {
      const persistedPosition = await loadActivePosition(this.sessionId);

      const qty = Number((persistedPosition as any)?.qty ?? 0);
      if (!persistedPosition || !Number.isFinite(qty) || qty <= 1e-8) {
        console.log(`No active position found for session ${this.sessionId}`);
        return;
      }

      const entryPrice = Number((persistedPosition as any)?.entryPrice ?? 0);

      console.log(`Restoring persisted position: ${persistedPosition.symbol} ${persistedPosition.side} qty=${qty} @ ${entryPrice}`);

      // Validate required fields
      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !persistedPosition.openedAt) {
        console.error('Invalid persisted position data: missing entryPrice or openedAt');
        return;
      }

      // Restore position state
      const side = persistedPosition.side as 'buy' | 'sell';
      const entry = entryPrice;
      const stopRaw = (persistedPosition as any)?.stopPrice;
      const stop = Number.isFinite(Number(stopRaw)) && Number(stopRaw) > 0
        ? Number(stopRaw)
        : (side === 'buy' ? entry * 0.95 : entry * 1.05); // Fallback stop
      const tpRaw = Array.isArray(persistedPosition.takeProfit)
        ? persistedPosition.takeProfit
        : (persistedPosition.takeProfit != null ? [persistedPosition.takeProfit] : []);
      const tp = tpRaw
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0);

      // Calculate current P&L and other metrics
      const openedAt = persistedPosition.openedAt.getTime();
      const now = Date.now();

      const restoredArchetype: ExitArchetype = (this.plan?.plan?.meta?.playbook || this.regime?.playbook) === 'momentum_breakout'
        ? 'impulse'
        : 'reversal';

      this.pos = {
        side,
        entry,
        qty,
        stop,
        tp,
        openedAt,
        extended: false,
        partialTaken: false,
        slOrderId: persistedPosition.slOrderId || undefined,
        tpOrderId: persistedPosition.tpOrderId || undefined,
        trail: [{ ts: openedAt, price: stop }],
        maeR: 0, // Will be calculated in manage()
        mfeR: 0, // Will be calculated in manage()
        breakeven: entry,
        partialInfo: null,
        initialStopDistance: Math.max(1e-12, Math.abs(entry - stop)),
        archetype: restoredArchetype,
      };

      // Update agent state
      this.state = 'MANAGE';

      // Log restoration
      recordOpsEvent({
        level: 'info',
        source: 'position_restoration',
        message: 'position_restored_from_persistence',
        sessionId: this.sessionId,
        symbol: persistedPosition.symbol,
        details: {
          side,
          qty,
          entryPrice: entry,
          stopPrice: stop,
          takeProfit: tp,
          openedAt: persistedPosition.openedAt.toISOString()
        }
      });

      console.log(`Position restored successfully: ${side} ${persistedPosition.symbol} qty=${qty} @ ${entry}`);

    } catch (error) {
      console.error(`Failed to restore persisted position for session ${this.sessionId}:`, error);

      recordOpsEvent({
        level: 'error',
        source: 'position_restoration',
        message: 'position_restoration_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { error: String(error) }
      });
    }
  }

  public async syncProtectiveOrders(reason: string): Promise<void> {
    if (!this.pos || !this.broker || !this.profile) {
      console.log(`Cannot sync protective orders: missing position, broker, or profile`);
      return;
    }

    try {
      // Only sync protective orders for live trading
      if (this.profile.mode !== 'live') {
        console.log(`Skipping protective order sync for ${this.profile.mode} mode`);
        return;
      }

      // Check if broker supports syncProtective (LiveBroker does)
      if (typeof (this.broker as any).syncProtective !== 'function') {
        console.log(`Broker does not support protective order sync`);
        return;
      }

      const primaryTp = Array.isArray(this.pos.tp) ? this.pos.tp.find(tp => typeof tp === 'number' && Number.isFinite(tp)) : this.pos.tp;
      const params = {
        symbol: this.profile.symbol,
        side: this.pos.side,
        qty: this.pos.qty,
        stopLoss: this.pos.stop,
        takeProfit: primaryTp,
        slOrderId: this.pos.slOrderId || null,
        tpOrderId: this.pos.tpOrderId || null
      };

      console.log(`Syncing protective orders for ${this.profile.symbol} (${reason}): SL=${this.pos.stop}, TP=${this.pos.tp}`);

      const result = await (this.broker as any).syncProtective(params);

      // Update position with new order IDs
      if (result.slOrderId) {
        this.pos.slOrderId = result.slOrderId;
        console.log(`Updated SL order ID: ${result.slOrderId}`);
      }
      if (result.tpOrderId) {
        this.pos.tpOrderId = result.tpOrderId;
        console.log(`Updated TP order ID: ${result.tpOrderId}`);
      }

      // Log successful sync
      recordOpsEvent({
        level: 'info',
        source: 'protective_orders',
        message: 'protective_orders_synced',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          reason,
          slOrderId: result.slOrderId,
          tpOrderId: result.tpOrderId,
          stopLoss: this.pos.stop,
          takeProfit: this.pos.tp
        },
      });

    } catch (error) {
      console.error(`Failed to sync protective orders for ${this.profile.symbol}:`, error);

      recordOpsEvent({
        level: 'error',
        source: 'protective_orders',
        message: 'protective_orders_sync_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: {
          reason,
          error: String(error),
          stopLoss: this.pos.stop,
          takeProfit: this.pos.tp
        },
      });
    }
  }

  public async applyQuantExitDirective(price: number, snap: TechnicalSnapshot): Promise<boolean> {
    if (!this.pos) return false;
    const targets = Array.isArray(this.pos.tp) ? this.pos.tp : [];
    if (!targets.length) return false;

    const atr = typeof (snap as any)?.atr14 === 'number' ? Number((snap as any).atr14) : this.plan?.atr ?? null;
    if (!(atr && atr > 0)) return false;

    const tradeSide: 'long' | 'short' = this.pos.side === 'buy' ? 'long' : 'short';
    const hitTargets = new Set<number>(this.pos.hitTargets ?? []);
    const minutesOpen = (Date.now() - this.pos.openedAt) / 60000;
    const directive = maybeAdjustOrExit({
      side: tradeSide,
      entryPrice: this.pos.entry,
      stop: this.pos.stop,
      targets,
      lastPrice: price,
      atr,
      adx: typeof (snap as any)?.adx14 === 'number' ? Number((snap as any).adx14) : null,
      cmf: typeof (snap as any)?.cmf20 === 'number' ? Number((snap as any).cmf20) : null,
      cfg: this.resolveDynamicExitConfig(),
      alreadyTriggeredTargets: hitTargets,
      archetype: this.pos.archetype,
      minutesOpen,
    });

    if (directive.action === 'exit') {
      recordOpsEvent({
        level: 'info',
        source: 'quantai_exit',
        message: 'forced_exit',
        sessionId: this.sessionId || undefined,
        symbol: this.profile?.symbol,
        details: { reason: directive.reason },
      });
      await this.exitPosition(price, 'quantai_directive_exit');
      return true;
    }

    if (directive.action === 'move_sl' && typeof directive.stop === 'number') {
      const newStop = Number(directive.stop);
      if (Number.isFinite(newStop) && ((this.pos.side === 'buy' && newStop > this.pos.stop + 1e-8) || (this.pos.side === 'sell' && newStop < this.pos.stop - 1e-8))) {
        await this.updateTrailingStop(newStop, price);
        recordOpsEvent({
          level: 'info',
          source: 'quantai_exit',
          message: 'trail_adjusted',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { newStop, reason: directive.reason },
        });
      }
      return false;
    }

    if (directive.action === 'take_partial' && directive.tpHitIndex != null) {
      if (!this.pos.partialTaken) {
        const tpIndex = directive.tpHitIndex;
        hitTargets.add(tpIndex);
        this.pos.hitTargets = Array.from(hitTargets.values());
        const targetPrice = targets[tpIndex] ?? price;
        await this.executePartialExit(price, targetPrice, `quantai_tp${tpIndex + 1}_hit`);
      }
      return false;
    }

    return false;
  }

  public resolveDynamicExitConfig() {
    const baseCfg = this.quantConfig.exits;
    const { context } = this.getContextualPlaybook(undefined, this.pos ? (this.pos.side === 'buy' ? 'long' : 'short') : 'none');
    if (!context) return baseCfg;

    const dynamicCfg = {
      ...baseCfg,
      earlyExit: { ...baseCfg.earlyExit },
    };

    if (context.regime === 'trend_following') {
      const trailBoost = context.strongTrend ? 1.25 : 1.1;
      dynamicCfg.trailAtrMult = Number((dynamicCfg.trailAtrMult * trailBoost).toFixed(3));
      dynamicCfg.trailAfterR = Math.max(dynamicCfg.trailAfterR, context.strongTrend ? 1.2 : 1.05);
      dynamicCfg.earlyExit.adxBelow = Math.max(14, dynamicCfg.earlyExit.adxBelow - 2);
      dynamicCfg.earlyExit.tightenProfitR = Number((dynamicCfg.earlyExit.tightenProfitR * 0.7).toFixed(3));
    } else if (context.regime === 'range') {
      dynamicCfg.trailAtrMult = Number((dynamicCfg.trailAtrMult * 0.85).toFixed(3));
      dynamicCfg.trailAfterR = Math.min(dynamicCfg.trailAfterR, 0.9);
      dynamicCfg.earlyExit.adxBelow = Math.min(30, dynamicCfg.earlyExit.adxBelow + 3);
      dynamicCfg.earlyExit.tightenProfitR = Number((dynamicCfg.earlyExit.tightenProfitR * 1.25).toFixed(3));
    } else if (context.regime === 'breakout') {
      dynamicCfg.trailAtrMult = Number((dynamicCfg.trailAtrMult * 1.05).toFixed(3));
      dynamicCfg.trailAfterR = Math.max(dynamicCfg.trailAfterR, 1.05);
    }

    return dynamicCfg;
  }

  public async manage(price: number, snap: TechnicalSnapshot): Promise<void> {
    // ✅ FIX: Validate position exists, reset state if missing (prevents stuck MANAGE state)
    if (!this.pos || !this.plan || !this.profile) {
      const hadPos = !!this.pos;
      const hadPlan = !!this.plan;
      const hadProfile = !!this.profile;
      const symbol = this.profile?.symbol;
      this.entering = false;
      this.pos = null;
      this.trendReversalContext = null;

      console.warn(`⚠️  Agent in MANAGE state but missing position/plan/profile - resetting to SCAN`);

      recordOpsEvent({
        level: 'warn',
        source: 'position_validation',
        message: 'manage_without_position',
        sessionId: this.sessionId || undefined,
        symbol,
        details: {
          hasPos: hadPos,
          hasPlan: hadPlan,
          hasProfile: hadProfile
        },
      });

      // Reset to SCAN to allow new opportunities
      this.state = 'SCAN';
      broadcast('agent_state', { 
        state: this.state, 
        reason: 'no_position_in_manage_state' 
      }, this.profile?.symbol, this.sessionId || undefined);
      
      return;
    }

    this.getContextualPlaybook(snap, this.plan.bias ?? 'none');

    try {
      const ticker = await getTicker(this.profile.symbol).catch(() => null as any);
      if (ticker && typeof ticker.last === 'number' && Number.isFinite(ticker.last)) {
        price = Number(ticker.last);
        (snap as any).last = price;
      }
    } catch (error) {
      console.warn(`Failed to refresh live price for ${this.profile.symbol}:`, error);
    }

    // Check if position is still open (both live and paper modes)
    if (this.profile.mode === 'live') {
      try {
        const exposure = await inspectExposure(this.profile.symbol, this.profile.userId);
        if (!exposure || exposure.qty <= 0) {
          // Position closed on exchange, clear local state and exit
          console.log(`Position closed on exchange for ${this.profile.symbol}, clearing local state`);
          this.pos = null;
          this.trendReversalContext = null;
          this.state = 'EXIT';
          this.lastExitTime = Date.now();
          broadcast('agent_state', { state: this.state, reason: 'position_closed_on_exchange' }, this.profile.symbol, this.sessionId || undefined);
          this.scheduleReactivation('position_closed_on_exchange');
          return;
        }
      } catch (error) {
        console.warn(`Failed to check exposure for ${this.profile.symbol}:`, error);
      }
    } else if (this.profile.mode === 'paper') {
      // ✅ NEW: Paper mode position validation (prevents stuck state)
      try {
        // Verify paper position still exists with valid quantity
        const currentQty = Number(this.pos?.qty ?? 0);
        if (!this.pos || !Number.isFinite(currentQty) || currentQty <= 1e-8) {
          console.log(`Paper position cleared for ${this.profile.symbol}, transitioning to EXIT`);
          this.pos = null;
          this.trendReversalContext = null;
          this.state = 'EXIT';
          this.lastExitTime = Date.now();
          broadcast('agent_state', { 
            state: this.state, 
            reason: 'paper_position_cleared' 
          }, this.profile.symbol, this.sessionId || undefined);
          this.scheduleReactivation('paper_position_cleared');
          return;
        }
      } catch (error) {
        console.warn(`Failed to validate paper position for ${this.profile.symbol}:`, error);
      }
    }

    // Update position metrics
    this.updatePositionMetrics(price);

    const quantExitTriggered = await this.applyQuantExitDirective(price, snap);
    if (quantExitTriggered) {
      return;
    }

    // Check for exit conditions
    const exitReason = this.checkExitConditions(price, snap);
    if (exitReason) {
      await this.exitPosition(price, exitReason);
      return;
    }

    // Implement trailing stops
    const newTrailPrice = this.computeDynamicTrail(price, snap, this.calculateUnrealizedR(price), Date.now() - this.pos!.openedAt);
    if (newTrailPrice !== null && this.shouldUpdateTrail(newTrailPrice, price)) {
      await this.updateTrailingStop(newTrailPrice, price);
    }

    // Check for partial exits at profit targets
    await this.checkPartialExits(price, snap);

    // Extend position if profitable and conditions met
    if (this.pos && !this.pos.extended && this.shouldExtendPosition(price, snap)) {
      this.extendPosition(price);
    }

    // Update protective orders if needed
    if (this.shouldSyncProtectiveOrders()) {
      await this.syncProtectiveOrders('management');
    }

    console.log(`Managing position: ${this.pos!.side} ${this.profile.symbol} @ ${price.toFixed(6)}, unrealized R: ${this.calculateUnrealizedR(price).toFixed(2)}, trail: ${this.pos!.stop.toFixed(6)}`);
  }

  public updatePositionMetrics(currentPrice: number): void {
    if (!this.pos || !this.plan) return;

    const entry = this.pos.entry;
    const side = this.pos.side;
    const stopDistance = this.plan.stopDistance;

    // Calculate unrealized P&L in R multiples
    const unrealizedR = this.calculateUnrealizedR(currentPrice);

    // Update MAE (Maximum Adverse Excursion) and MFE (Maximum Favorable Excursion)
    if (this.pos.maeR === undefined || unrealizedR < this.pos.maeR) {
      this.pos.maeR = unrealizedR;
    }
    if (this.pos.mfeR === undefined || unrealizedR > this.pos.mfeR) {
      this.pos.mfeR = unrealizedR;
    }

    // Update breakeven if trailing - 🔧 AJUSTÉ : Attendre +2.5R au lieu de +1.5R
    if (unrealizedR > 2.5 && !this.pos.partialTaken) {
      const trailAdjustment = Math.min(stopDistance * 0.5, (currentPrice - entry) * 0.3 * (side === 'buy' ? 1 : -1));
      this.pos.breakeven = entry + trailAdjustment * (side === 'buy' ? 1 : -1);
    }
  }

  public calculateUnrealizedR(currentPrice: number): number {
    if (!this.pos || !this.plan) return 0;

    const entry = this.pos.entry;
    const stopDistance = this.plan.stopDistance;
    const side = this.pos.side;

    const priceDiff = side === 'buy' ? currentPrice - entry : entry - currentPrice;
    return priceDiff / stopDistance;
  }

  public checkExitConditions(price: number, snap: TechnicalSnapshot): string | null {
    if (!this.pos || !this.plan || !this.profile) return null;

    const unrealizedR = this.calculateUnrealizedR(price);
    const timeHeldMs = Date.now() - this.pos.openedAt;
    const maxHoldHours = this.plan.plan.risk?.max_hold_hours || 36;
    const maxHoldMs = maxHoldHours * 60 * 60 * 1000;

    // ✅ FIX: Early exit on trend reversal (prevents ETH -2.47%, ADA -3.13% losses)
    if (this.shouldExitOnTrendReversal(price, snap, unrealizedR)) {
      return 'trend_reversal_detected';
    }

    // ✅ FIX: Late invalidation exit - price outside original entry zone
    if (this.shouldExitOnLateInvalidation(price)) {
      return 'late_invalidation_exit';
    }

    // ✅ ADAPTIVE LEARNING: Volume dump detection
    if (this.shouldExitOnVolumeDump(snap)) {
      return 'volume_dump_detected';
    }

    // ✅ ADAPTIVE LEARNING: Divergence detection
    if (this.shouldExitOnDivergence(price, snap, unrealizedR)) {
      return 'divergence_detected';
    }

    // Time-based exit
    if (timeHeldMs > maxHoldMs) {
      return 'max_hold_time_exceeded';
    }

    // Profit target reached (final TP)
    if (this.pos.tp.length > 0) {
      const finalTp = this.pos.tp[this.pos.tp.length - 1];
      const hitTp = this.pos.side === 'buy' ? price >= finalTp : price <= finalTp;
      if (hitTp) {
        return 'profit_target_reached';
      }
    }

    // Stop loss hit
    const hitStop = this.pos.side === 'buy' ? price <= this.pos.stop : price >= this.pos.stop;
    if (hitStop) {
      return 'stop_loss_hit';
    }

    // Risk management: cut losses if position moves against us significantly
    if (unrealizedR < -2.0) {
      return 'excessive_loss_cutoff';
    }

    // Market regime change to standby
    if (this.regime?.playbook === 'standby') {
      return 'regime_standby';
    }

    // Volatility spike - exit if ATR increases dramatically
    const currentATR = snap.atr14 || 0;
    const entryATR = this.plan.atr || currentATR;
    if (currentATR > entryATR * 2.0) {
      return 'volatility_spike';
    }

    return null;
  }

  public async exitPosition(price: number, reason: string): Promise<void> {
    if (!this.pos || !this.broker || !this.profile) return;

    try {
      console.log(`Exiting position: ${reason} at ${price}`);

      // Calculate realized P&L
      const realizedPnl = this.calculateRealizedPnL(price);

      const protectiveSnapshot: ProtectiveSnapshot = {
        slOrderId: this.pos.slOrderId || null,
        tpOrderId: this.pos.tpOrderId || null,
        qty: this.pos.qty,
        side: this.pos.side as 'buy' | 'sell',
      };

      // Place exit order
      const exitSide = this.pos.side === 'buy' ? 'sell' : 'buy';
      const exitOrder = await this.broker.place({
        symbol: this.profile.symbol,
        side: exitSide,
        type: 'market',
        qty: this.pos.qty,
        leverage: this.profile.maxLeverage
      });

      if (exitOrder.status === 'filled' && exitOrder.filledQty && exitOrder.filledQty > 0) {
        const balanceAfter = await this.broker.balance().catch(() => null as BrokerMarginSnapshot | null);
        let exitSnapshot: ExitDiagnosticsPayload | null = null;
        try {
          exitSnapshot = await this.captureExitDiagnostics({
            reason,
            exitOrder,
            exitPrice: exitOrder.avgPrice || price,
            realizedPnl,
            protectiveSnapshot,
            balanceAfter,
          });
        } catch (snapshotError) {
          console.warn('Failed to capture exit diagnostics snapshot:', snapshotError);
        }

        // Record exit in database
        await recordExit({
          sessionId: this.sessionId!,
          symbol: this.profile.symbol,
          side: this.pos.side,
          exitPrice: exitOrder.avgPrice || price,
          qty: exitOrder.filledQty,
          realizedPnl,
          latencyMs: exitOrder.latencyMs,
          slippageBps: exitOrder.slippageBps,
          fillRatio: exitOrder.fillRatio,
          cancelCount: exitOrder.cancelCount,
          attempts: exitOrder.attempts,
          reason,
          diagnostics: exitSnapshot,
          protectiveSnapshot,
        });

        // Update performance tracking
        const equityAfter = Number(balanceAfter?.equityUsd ?? this.lastKnownEquityUsd ?? this.profile.startBalanceUsd ?? 0);
        const baseEquity = this.lastKnownEquityUsd > 0 ? this.lastKnownEquityUsd : (this.profile.startBalanceUsd ?? equityAfter);
        const pnlPct = baseEquity > 0 ? (realizedPnl / baseEquity) * 100 : 0;
        this.circuitBreaker.onTradeResult(new Date(), pnlPct, equityAfter);
        this.lastKnownEquityUsd = equityAfter;
        this.syncCircuitBreakerTelemetry();

        const win = realizedPnl > 0;
        if (win) {
          this.lastLossStreakNotified = 0;
        }
        const tradeTimestamp = Date.now();
        const tradePnlPct = (realizedPnl / (this.pos.entry * this.pos.qty)) * 100;
        this.recentTrades.push({
          win,
          pnlPct: tradePnlPct,
          timestamp: tradeTimestamp
        });
        this.recordTierPerformance(this.profile?.symbol, win, tradePnlPct, tradeTimestamp);
        
        // 🆕 Track last trade result for breakout mode logic
        this.lastTradeWasWin = win;
        
        // Reset breakout mode after trade exit
        if (this.breakoutModeActive) {
          console.log('🔄 Resetting breakout mode after trade exit');
          this.breakoutModeActive = false;
          this.lastZoneCheckTime = 0;
        }

        // Keep only last 20 trades
        if (this.recentTrades.length > 20) {
          this.recentTrades = this.recentTrades.slice(-20);
        }

        // ✅ ADAPTIVE LEARNING: Adjust thresholds based on recent performance
        this.adjustQualityThresholds();
        this.detectLosingStreak();
        const cadenceAfterExit = this.evaluateTradeCadence('post_trade');

        // Update daily P&L
        if (this.performanceMetrics) {
          this.performanceMetrics.dailyPnL += realizedPnl;
        }

        // Log exit
        recordOpsEvent({
          level: win ? 'info' : 'warn',
          source: 'position_exit',
          message: `position_exited_${reason}`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            reason,
            exitPrice: exitOrder.avgPrice || price,
            realizedPnl,
            holdTimeMs: Date.now() - this.pos.openedAt,
            maeR: this.pos.maeR,
            mfeR: this.pos.mfeR
          }
        });

        try {
          await (this.broker as any).syncProtective?.({
            symbol: this.profile.symbol,
            side: protectiveSnapshot.side,
            qty: protectiveSnapshot.qty,
            stopLoss: undefined,
            takeProfit: undefined,
            slOrderId: protectiveSnapshot.slOrderId,
            tpOrderId: protectiveSnapshot.tpOrderId,
          });
        } catch (cancelError) {
          console.warn(`Failed to cancel protective orders after exit for ${this.profile.symbol}:`, cancelError);
          recordOpsEvent({
            level: 'warn',
            source: 'protective_orders',
            message: 'protective_orders_cleanup_failed',
            sessionId: this.sessionId || undefined,
            symbol: this.profile.symbol,
            details: { error: String(cancelError) },
          });
        }

        // Clear position and update state
        this.pos = null;
        this.trendReversalContext = null;
        this.state = 'EXIT';
        this.lastExitTime = Date.now();
        this.noteDrySpellTrade(this.lastExitTime);

        broadcast('agent_state', {
          state: this.state,
          reason,
          exitPrice: exitOrder.avgPrice || price,
          realizedPnl,
          tradeCadence: cadenceAfterExit
        }, this.profile.symbol, this.sessionId || undefined);

        const cooldownCfg = getConfig();
        const baseCooldown = cadenceAfterExit.cooldownMs || cooldownCfg.TRADE_COOLDOWN_MS;
        const winMultiplier = Math.max(0.1, cooldownCfg.TRADE_COOLDOWN_WIN_MULTIPLIER || 0.2);
        const lossMultiplier = Math.max(0.5, cooldownCfg.TRADE_COOLDOWN_LOSS_MULTIPLIER || 1);
        const winCooldown = cooldownCfg.TRADE_COOLDOWN_WIN_MS || Math.max(2_000, Math.round(baseCooldown * winMultiplier));
        const lossCooldown = cooldownCfg.TRADE_COOLDOWN_LOSS_MS || Math.max(4_000, Math.round(baseCooldown * lossMultiplier));
        const exitCooldown = realizedPnl > 0 ? winCooldown : lossCooldown;
        this.lastExitCooldownMs = exitCooldown;

        this.scheduleReactivation('position_exit_completed', exitCooldown);

      } else {
        console.error(`Failed to exit position: ${exitOrder.status}`);
      }

    } catch (error) {
      console.error(`Error exiting position:`, error);
      recordOpsEvent({
        level: 'error',
        source: 'position_exit',
        message: 'position_exit_failed',
        sessionId: this.sessionId || undefined,
        symbol: this.profile.symbol,
        details: { reason, error: String(error) }
      });
    }
  }

  public async captureExitDiagnostics(params: {
    reason: string;
    exitOrder: PlacedOrder;
    exitPrice: number;
    realizedPnl: number;
    protectiveSnapshot: ProtectiveSnapshot;
    balanceAfter?: BrokerMarginSnapshot | null;
  }): Promise<ExitDiagnosticsPayload | null> {
    if (!this.profile) return null;

    const capturedAt = new Date().toISOString();
    const symbol = this.profile.symbol;

    const [techSnapshot, diagnostics] = await Promise.all([
      buildTechSnapshot(symbol).catch(error => {
        console.warn('Failed to build technical snapshot for exit diagnostics:', error);
        return null;
      }),
      this.getDiagnostics().catch(error => {
        console.warn('Failed to compute agent diagnostics during exit:', error);
        return null;
      })
    ]);

    const planSummary = this.plan ? {
      bias: this.plan.bias,
      zone: { ...this.plan.zone },
      atr: this.plan.atr,
      atrPct: this.plan.atrPct,
      sizing: { ...this.plan.sizing },
    } : null;

    const positionSummary = this.pos ? {
      side: this.pos.side,
      entry: this.pos.entry,
      qty: this.pos.qty,
      openedAt: this.pos.openedAt,
      maeR: this.pos.maeR,
      mfeR: this.pos.mfeR,
      breakeven: this.pos.breakeven,
    } : null;

    const indicatorSummary = techSnapshot ? {
      last: techSnapshot.last,
      ema20: techSnapshot.ema20,
      ema50: techSnapshot.ema50,
      ema100: techSnapshot.ema100,
      ema200: techSnapshot.ema200,
      rsi14: techSnapshot.rsi14,
      atr14: techSnapshot.atr14,
      atrPct: techSnapshot.atrPct,
      adx14: techSnapshot.adx14,
      cmf20: techSnapshot.cmf20 ?? null,
      support: techSnapshot.support,
      resistance: techSnapshot.resistance,
      trendBias: techSnapshot.trendBias,
      srBias: techSnapshot.srBias,
    } : null;

    const gateStatuses = diagnostics?.checks
      ? Object.fromEntries(
          Object.entries(diagnostics.checks).map(([key, value]) => {
            const normalized = value as any; // eslint-disable-line @typescript-eslint/no-explicit-any
            return [key, {
              status: normalized?.status,
              reason: normalized?.reason ?? normalized?.message ?? null,
              details: normalized?.details,
            }];
          })
        )
      : undefined;

    const diagnosticsSummary = diagnostics ? {
      canTrade: diagnostics.canTrade,
      reason: diagnostics.reason ?? diagnostics.errorCode,
      summary: diagnostics.summary,
      trigger: diagnostics.trigger,
      gates: gateStatuses,
    } : null;

    const accountBefore = this.pos?.accountSnapshot
      ? { ...this.pos.accountSnapshot }
      : null;
    if (accountBefore && (accountBefore.finalNotionalUsd == null || Number.isNaN(accountBefore.finalNotionalUsd))) {
      if (this.pos) {
        accountBefore.finalNotionalUsd = this.pos.qty * this.pos.entry;
      }
    }
    const accountAfter = params.balanceAfter
      ? {
          equityUsd: Number.isFinite(params.balanceAfter.equityUsd)
            ? Number(params.balanceAfter.equityUsd)
            : null,
          freeUsd: Number.isFinite(params.balanceAfter.freeUsd)
            ? Number(params.balanceAfter.freeUsd)
            : null,
          committedUsd: Number.isFinite(params.balanceAfter.committedUsd)
            ? Number(params.balanceAfter.committedUsd)
            : null,
        }
      : null;

    return {
      capturedAt,
      reason: params.reason,
      agentState: this.state,
      sessionId: this.sessionId,
      symbol,
      exitOrderId: params.exitOrder.id,
      exitSide: params.exitOrder.side,
      exitPrice: params.exitPrice,
      realizedPnl: params.realizedPnl,
      plan: planSummary,
      position: positionSummary,
      protectiveSnapshot: params.protectiveSnapshot,
      diagnostics: diagnosticsSummary,
      indicators: indicatorSummary,
      regime: this.regime || null,
      performance: {
        tradesToday: this.tradesToday || 0,
        consecutiveStops: this.consecutiveStops || 0,
        realizedPnlTodayPct: this.realizedPnlTodayPct || 0,
      },
      account: {
        before: accountBefore,
        after: accountAfter,
      },
    };
  }

  /**
   * 🚨 CRITICAL: Detect trend reversal to exit losing positions early
   * Prevents catastrophic losses like ETH -2.47% and ADA -3.13%
   */
  public shouldExitOnTrendReversal(price: number, snap: TechnicalSnapshot, unrealizedR: number): boolean {
    if (!this.pos || !this.plan) return false;

    const now = Date.now();
    if (this.trendReversalContext && now - this.trendReversalContext.lastSignal > 8000) {
      this.trendReversalContext = null;
    }

    // 1. EMA Cross Reversal (bearish for long, bullish for short)
    const ema20 = typeof snap.ema20 === 'number' && Number.isFinite(snap.ema20) ? snap.ema20 : snap.last;
    const ema50 = typeof snap.ema50 === 'number' && Number.isFinite(snap.ema50) ? snap.ema50 : ema20;
    const emaSpread = ema50 ? ((ema20 - ema50) / ema50) * 100 : 0;
    const emaBearish = emaSpread < -0.5;
    const emaBullish = emaSpread > 0.5;
    const adverseMoveR = Math.max(0, -unrealizedR);
    const minAdverseR = 0.35;
    const bufferAdverseR = 0.25;
    const confirmTicks = 3;

    if (this.pos.side === 'buy') {
      if (emaBearish && unrealizedR <= 0) {
        const count = this.noteTrendReversalSignal('bearish', now);
        if (adverseMoveR >= minAdverseR || (count >= confirmTicks && adverseMoveR >= bufferAdverseR)) {
          this.trendReversalContext = null;
          console.log(`🔴 Exit: EMA bearish cross confirmed (spread: ${emaSpread.toFixed(2)}%, adverseR: ${adverseMoveR.toFixed(2)})`);
          return true;
        }
        if (count > 1) {
          console.log(`⚪️ Buffering bearish reversal signal (${count}/${confirmTicks}, adverseR=${adverseMoveR.toFixed(2)})`);
        }
        return false;
      }
    } else if (this.pos.side === 'sell') {
      if (emaBullish && unrealizedR <= 0) {
        const count = this.noteTrendReversalSignal('bullish', now);
        if (adverseMoveR >= minAdverseR || (count >= confirmTicks && adverseMoveR >= bufferAdverseR)) {
          this.trendReversalContext = null;
          console.log(`🔴 Exit: EMA bullish cross confirmed (spread: ${emaSpread.toFixed(2)}%, adverseR: ${adverseMoveR.toFixed(2)})`);
          return true;
        }
        if (count > 1) {
          console.log(`⚪️ Buffering bullish reversal signal (${count}/${confirmTicks}, adverseR=${adverseMoveR.toFixed(2)})`);
        }
        return false;
      }
    }

    this.trendReversalContext = null;

    // 2. Momentum Loss (RSI extreme + losing position)
    const rsi = snap.rsi14 || 50;
    const momentumLoss = (this.pos.side === 'buy' && rsi < 35 && unrealizedR < 0) ||
                         (this.pos.side === 'sell' && rsi > 65 && unrealizedR < 0);

    if (momentumLoss) {
      console.log(`🔴 Exit: Momentum loss (RSI: ${rsi.toFixed(1)}, R: ${unrealizedR.toFixed(2)})`);
      return true;
    }

    // 3. ADX Declining (trend weakening while losing)
    const adx = snap.adx14 || 0;
    const adxWeak = adx < 15;

    if (adxWeak && unrealizedR < -0.3) {
      console.log(`🔴 Exit: Weak trend + losing (ADX: ${adx.toFixed(1)}, R: ${unrealizedR.toFixed(2)})`);
      return true;
    }

    return false;
  }

  public noteTrendReversalSignal(direction: 'bullish' | 'bearish', now: number): number {
    if (!this.trendReversalContext || this.trendReversalContext.direction !== direction) {
      this.trendReversalContext = { direction, count: 1, lastSignal: now };
      return 1;
    }

    const age = now - this.trendReversalContext.lastSignal;
    const withinWindow = age <= 8000;
    const nextCount = withinWindow ? this.trendReversalContext.count + 1 : 1;

    this.trendReversalContext = { direction, count: nextCount, lastSignal: now };
    return nextCount;
  }

  /**
   * ✅ FIX: Check if price has been outside entry zone for too long (late invalidation)
   * Prevents positions from staying open when price breaks out of original zone
   * This addresses the 238 "late_invalidation_exit" alerts issue
   */
  public shouldExitOnLateInvalidation(price: number): boolean {
    if (!this.pos || !this.plan) return false;
    
    const cfg = getConfig();
    const from = Math.min(this.plan.zone.from, this.plan.zone.to);
    const to = Math.max(this.plan.zone.from, this.plan.zone.to);
    const hysteresisPct = cfg.BREAKOUT_HYSTERESIS_PCT || 0.5;
    
    // Check if price is outside zone with hysteresis
    const above = price > to * (1 + hysteresisPct / 100);
    const below = price < from * (1 - hysteresisPct / 100);
    
    // For buy positions, invalid if price drops below zone
    // For sell positions, invalid if price rises above zone
    const invalid = (this.pos.side === 'sell') ? above : below;
    
    if (invalid) {
      // Initialize counter if not exists
      if (!this.invalidationTicks) this.invalidationTicks = 0;
      this.invalidationTicks++;
      
      const confirmTicks = Math.max(3, cfg.BREAKOUT_CONFIRM_TICKS || 2);
      
      if (this.invalidationTicks >= confirmTicks) {
        const direction = this.pos.side === 'buy' ? 'below' : 'above';
        console.log(`🚨 Late Invalidation Exit: Price ${price.toFixed(4)} ${direction} zone [${from.toFixed(4)}, ${to.toFixed(4)}] for ${this.invalidationTicks} ticks`);
        return true;
      }
    } else {
      // Reset counter if price back in zone
      this.invalidationTicks = 0;
    }
    
    return false;
  }

  /**
   * ✅ ADAPTIVE LEARNING: Detect volume dumps (massive sell-offs)
   * Exit immediately if volume spike 2x+ average AND price moving against position
   */
  public shouldExitOnVolumeDump(snap: TechnicalSnapshot): boolean {
    if (!this.pos || !this.plan) return false;
    
    // Calculate volume spike ratio
    const avgVolume = snap.volumeMA || snap.volume24h || 1;
    const currentVolume = snap.volume24h || 0;
    if (currentVolume === 0 || avgVolume === 0) return false;
    
    const volumeSpike = currentVolume / avgVolume;
    
    // Check if price is moving against our position
    const priceMovingAgainst = this.pos.side === 'buy'
      ? snap.last < this.pos.entry * 0.99  // -1% or more for longs
      : snap.last > this.pos.entry * 1.01; // +1% or more for shorts
    
    // Volume dump: 2x+ volume spike + price against position
    if (volumeSpike >= 2.0 && priceMovingAgainst) {
      const direction = this.pos.side === 'buy' ? 'down' : 'up';
      console.log(`🚨 Volume dump detected: ${volumeSpike.toFixed(1)}x avg volume, price moving ${direction}`);
      return true;
    }
    
    return false;
  }

  /**
   * ✅ ADAPTIVE LEARNING: Detect RSI/Price divergences
   * Bearish divergence (LONG): Price rises but RSI doesn't follow
   * Bullish divergence (SHORT): Price falls but RSI doesn't follow
   */
  public shouldExitOnDivergence(price: number, snap: TechnicalSnapshot, unrealizedR: number): boolean {
    if (!this.pos || !this.plan) return false;
    
    // Only check divergence if we're not winning significantly
    if (unrealizedR > 0.5) return false;
    
    const rsi = snap.rsi14 || 50;
    
    // Bearish divergence for LONG positions
    if (this.pos.side === 'buy') {
      const priceHigher = price > this.pos.entry * 1.01; // Price up 1%+
      const rsiWeak = rsi < 45; // But RSI weak (below neutral)
      
      if (priceHigher && rsiWeak) {
        console.log(`🚨 Bearish divergence: Price +${((price / this.pos.entry - 1) * 100).toFixed(1)}% but RSI weak (${rsi.toFixed(1)})`);
        return true;
      }
    }
    
    // Bullish divergence for SHORT positions
    if (this.pos.side === 'sell') {
      const priceLower = price < this.pos.entry * 0.99; // Price down 1%+
      const rsiStrong = rsi > 55; // But RSI strong (above neutral)
      
      if (priceLower && rsiStrong) {
        console.log(`🚨 Bullish divergence: Price ${((1 - price / this.pos.entry) * 100).toFixed(1)}% but RSI strong (${rsi.toFixed(1)})`);
        return true;
      }
    }
    
    return false;
  }

  public calculateRealizedPnL(exitPrice: number): number {
    if (!this.pos) return 0;

    const entry = this.pos.entry;
    const qty = this.pos.qty;
    const side = this.pos.side;

    const entryNet = applyFeesAndSlippage(entry, this.quantConfig.feesSlippage, { side: side });
    const exitSide = side === 'buy' ? 'sell' : 'buy';
    const exitNet = applyFeesAndSlippage(exitPrice, this.quantConfig.feesSlippage, { side: exitSide });
    const priceDiff = side === 'buy' ? exitNet - entryNet : entryNet - exitNet;
    return priceDiff * qty;
  }

  /**
   * 🆕 Recalculate entry zone periodically when ARMED (every 30 min)
   * Allows switch to breakout mode if conditions are met
   */
  public async maybeRecalculateEntryZone(): Promise<void> {
    if (this.state !== 'ARMED' || !this.plan || !this.profile) return;
    
    const now = Date.now();
    const lastRecalc = this.lastZoneRecalcTime || 0;
    const recalcInterval = 30 * 60 * 1000; // 30 minutes
    
    if (now - lastRecalc < recalcInterval) return;
    
    this.lastZoneRecalcTime = now;
    
    try {
      // Recalculer zone avec conditions actuelles
      const snap = await buildTechSnapshot(this.profile.symbol, this.profile.userId);
      const previousZone = this.plan.zone;
      const newZone = await this.calculateDynamicEntryZone(snap, snap.last, this.plan.bias);
      this.plan.zone = newZone;
      this.clearAiBiasOverride('periodic_zone_refresh');

      // Vérifier si passage en breakout mode
      const wasBreakout = this.breakoutModeActive;
      const isBreakout = this.shouldSwitchToBreakoutMode(snap, snap.last);

      if (isBreakout && !wasBreakout) {
        console.log('🔄 Entry zone mise à jour → Mode BREAKOUT');

        // Broadcast pour UI
        broadcast('zone_updated', {
          zone: newZone,
          mode: 'breakout',
          reason: 'strong_trend_detected'
        }, this.profile.symbol, this.sessionId || undefined);
        
        recordOpsEvent({
          level: 'info',
          source: 'zone_recalc',
          message: 'Entry zone updated to breakout mode',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: { oldZone: previousZone, newZone, mode: 'breakout' },
        });
      } else if (!isBreakout && this.lastZoneRecalcTime > 0) {
        console.log('🔄 Entry zone recalculated (pullback mode maintained)');
      }
    } catch (error) {
      console.warn('Failed to recalculate entry zone:', error);
    }
  }
  
  public scheduleReactivation(reason: string, delayOverrideMs?: number): void {
    if (!this.profile || !this.plan) return;

    const cfg = getConfig();
    const baseCooldown = this.lastExitCooldownMs || cfg.TRADE_COOLDOWN_MS;
    const delay = typeof delayOverrideMs === 'number'
      ? Math.max(1000, delayOverrideMs)
      : Math.min(Math.max(4000, Math.floor(baseCooldown * 0.25)), Math.max(4000, Math.min(baseCooldown, 30000)));

    if (this.cooldownTimer) {
      try { clearTimeout(this.cooldownTimer); } catch {}
      this.cooldownTimer = null;
    }

    this.cooldownContext = { reason, triggeredAt: Date.now() };
    this.state = 'COOLDOWN';
    const cooldownReason = reason.startsWith('cooldown_') ? reason : `cooldown_${reason}`;
    broadcast('agent_state', { state: this.state, reason: cooldownReason, cooldownMs: delay }, this.profile.symbol, this.sessionId || undefined);

    this.cooldownTimer = setTimeout(async () => {
      this.cooldownTimer = null;
      this.cooldownContext = null;
      if (!this.profile || !this.plan) return;
      if (this.state === 'HALT') return;
      try {
        await this.validateAndArm();
      } catch (error) {
        console.warn('Failed to re-arm agent after cooldown:', error);
      }
    }, delay);
  }

  public shouldUpdateTrail(newTrailPrice: number, currentPrice: number): boolean {
    if (!this.pos) return false;

    const currentTrail = this.pos.stop;
    const side = this.pos.side;

    // Only trail in the profitable direction
    if (side === 'buy') {
      return newTrailPrice > currentTrail && newTrailPrice < currentPrice;
    } else {
      return newTrailPrice < currentTrail && newTrailPrice > currentPrice;
    }
  }

  public async updateTrailingStop(newTrailPrice: number, currentPrice: number): Promise<void> {
    if (!this.pos) return;

    const oldStop = this.pos.stop;
    this.pos.stop = newTrailPrice;
    this.noteTrail(newTrailPrice);

    console.log(`Updated trailing stop: ${oldStop.toFixed(6)} → ${newTrailPrice.toFixed(6)}`);

    // Update protective orders
    await this.syncProtectiveOrders('trail_update');
  }

  public async checkPartialExits(price: number, snap: TechnicalSnapshot): Promise<void> {
    if (!this.pos || !this.plan || this.pos.partialTaken) return;

    const firstR = Number(this.plan?.plan?.risk?.tp?.[0]?.value ?? this.plan?.rPrices?.[0]?.r ?? 2.0) || 2.0;
    const baseDistance = Math.max(1e-12,
      this.pos.initialStopDistance ?? Math.abs(this.plan.stopDistance) ?? Math.abs(this.pos.entry - this.pos.stop));

    const computedTarget = this.pos.side === 'buy'
      ? this.pos.entry + (firstR * baseDistance)
      : this.pos.entry - (firstR * baseDistance);

    const plannedTarget = this.pos.tp[0] ?? computedTarget;
    const dir = this.pos.side === 'buy' ? 1 : -1;
    const realizedR = (dir * (price - this.pos.entry)) / baseDistance;
    const triggerR = firstR * 0.98; // Trigger slightly before policy kill-switch buffer
    const priceBeyondTarget = this.pos.side === 'buy'
      ? price >= plannedTarget * 0.9995
      : price <= plannedTarget * 1.0005;

    if (realizedR < triggerR && !priceBeyondTarget) {
      return;
    }

    const partialFraction = this.resolvePartialFraction();
    const rawPartialQty = this.pos.qty * partialFraction;
    const partialQty = Number(rawPartialQty.toFixed(8));
    if (!(partialQty > 0 && partialQty < this.pos.qty)) {
      return;
    }

    const minNotional = Number(getConfig().MIN_ORDER_NOTIONAL_USD || 0);
    const partialNotional = partialQty * price;

    if (minNotional > 0 && partialNotional < minNotional) {
      console.log(`Partial exit notional ${partialNotional.toFixed(4)} below minimum ${minNotional} — closing entire position`);
      await this.exitPosition(price, 'partial_too_small_exit');
      return;
    }

    await this.executePartialExit(price, plannedTarget, 'first_target');
  }

  public async executePartialExit(price: number, targetPrice: number, reason: string): Promise<void> {
    if (!this.pos || !this.broker || !this.profile) return;

    try {
      const partialFraction = this.resolvePartialFraction();
      const rawQty = this.pos.qty * partialFraction;
      const partialQty = Number(rawQty.toFixed(8));
      if (!(partialQty > 0 && partialQty < this.pos.qty)) return;

      const exitSide = this.pos.side === 'buy' ? 'sell' : 'buy';
      const partialExit = await this.broker.place({
        symbol: this.profile.symbol,
        side: exitSide,
        type: 'market',
        qty: partialQty,
        leverage: this.profile.maxLeverage
      });

      if (partialExit.filledQty && partialExit.filledQty > 0) {
        // Update position
        this.pos.qty -= partialExit.filledQty;
        this.pos.partialTaken = true;
        this.pos.partialInfo = {
          ts: Date.now(),
          price: partialExit.avgPrice || targetPrice
        };
        const recordedHits = new Set(this.pos.hitTargets ?? []);
        recordedHits.add(0);
        this.pos.hitTargets = Array.from(recordedHits.values());

        // Adjust stop to breakeven or better
        const previousStop = this.pos.stop;
        const volRatio = this.pos.flowSnapshot?.volRatio ?? null;
        const allowBreakeven = volRatio != null ? volRatio >= 1.1 : false;
        const newStop = allowBreakeven ? (this.pos.breakeven || this.pos.entry) : previousStop;
        this.pos.stop = newStop;

        const fillPrice = partialExit.avgPrice || price;
        console.log(`Partial exit: ${partialExit.filledQty} @ ${fillPrice} (${reason})`);

        const now = Date.now();
        const previousConfig = this.pos.trailConfig ?? { mode: 'percent', multiplier: this.quantConfig.exits.trailAtrMult, armed: false };
        const runnerTrailPct = this.resolveRunnerTrailPercent();
        const highWater = this.pos.side === 'buy'
          ? Math.max(previousConfig.highWatermark ?? fillPrice, fillPrice)
          : Math.min(previousConfig.highWatermark ?? fillPrice, fillPrice);
        this.pos.trailConfig = {
          ...previousConfig,
          mode: 'percent',
          multiplier: previousConfig.multiplier ?? this.quantConfig.exits.trailAtrMult,
          armed: true,
          fromHighPct: runnerTrailPct,
          highWatermark: highWater,
          lastUpdateTs: now,
        };
        this.pos.tp = [];
        this.pos.scaleInTriggered = true;

        // Record partial exit
        recordOpsEvent({
          level: 'info',
          source: 'partial_exit',
          message: `partial_exit_${reason}`,
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            partialQty: partialExit.filledQty,
            exitPrice: fillPrice,
            remainingQty: this.pos.qty,
            newStop,
            previousStop,
            volRatio,
            allowBreakeven,
            runnerTrailPct,
          }
        });

        // Sync protective orders
        await this.syncProtectiveOrders('partial_exit');
        await this.maybeScaleInAfterPartial();
      }

    } catch (error) {
      console.error(`Failed to execute partial exit:`, error);
    }
  }

  public shouldExtendPosition(price: number, snap: TechnicalSnapshot): boolean {
    if (!this.pos || !this.plan) return false;

    const unrealizedR = this.calculateUnrealizedR(price);
    const timeHeldMs = Date.now() - this.pos.openedAt;

    // Extend if profitable and trend continues
    if (unrealizedR >= 1.0 && timeHeldMs < 12 * 60 * 60 * 1000) { // Less than 12 hours
      const trendContinues = this.pos.side === 'buy' ?
        (snap.ema20 || price) > (snap.ema50 || price) :
        (snap.ema20 || price) < (snap.ema50 || price);

      return trendContinues;
    }

    return false;
  }

  public extendPosition(price: number): void {
    if (!this.pos || !this.plan) return;

    this.pos.extended = true;

    // Extend hold time by adding time to the plan
    if (this.plan.plan.risk) {
      this.plan.plan.risk.max_hold_hours = (this.plan.plan.risk.max_hold_hours || 36) + 12;
    }

    console.log(`Extended position hold time to ${this.plan.plan.risk?.max_hold_hours || 36} hours`);

    recordOpsEvent({
      level: 'info',
      source: 'position_extension',
      message: 'position_hold_extended',
      sessionId: this.sessionId || undefined,
      symbol: this.profile?.symbol || '',
      details: {
        newMaxHoldHours: this.plan.plan.risk?.max_hold_hours,
        currentPrice: price,
        unrealizedR: this.calculateUnrealizedR(price)
      }
    });
  }

  public shouldSyncProtectiveOrders(): boolean {
    // Sync protective orders periodically or when stop/TP changes
    // For now, sync every 5 minutes or when position changes
    return Math.random() < 0.1; // 10% chance each manage call (~ every 5 minutes)
  }

  public async applyDailyRoiThrottle(riskPct: number): Promise<number> {
    if (!this.performanceMetrics || !this.profile) {
      return riskPct; // No performance data available, return unchanged
    }

    try {
      const cfg = getConfig();
      const configuredMax = Number((cfg as any)?.MAX_DAILY_ROI_PCT);
      const maxDailyRoi = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 5.0; // Default 5%
      const dailyPnL = this.performanceMetrics.dailyPnL || 0;

      const balanceFallback = this.profile.startBalanceUsd
        ?? (this.lastKnownEquityUsd > 0 ? this.lastKnownEquityUsd : null)
        ?? 10000;
      const startBalance = Math.max(1, Number(balanceFallback));
      const dailyRoiPct = (dailyPnL / startBalance) * 100;
      const baselineRisk = Math.max(0, riskPct);
      const profileRisk = Math.max(0, Number(this.profile.riskPerTradePct || baselineRisk));
      const riskFloor = baselineRisk > 0
        ? Math.min(baselineRisk, Math.max(0.35, profileRisk * 0.35))
        : 0;

      console.log(`📊 Daily ROI check: ${dailyRoiPct.toFixed(2)}% (max: ${maxDailyRoi}%, dailyPnL: ${dailyPnL.toFixed(2)})`);

      if (dailyRoiPct > maxDailyRoi) {
        const excessRoi = dailyRoiPct - maxDailyRoi;
        const severity = Math.min(2.5, Math.max(0, excessRoi / maxDailyRoi));
        const reductionFactor = Math.max(0.5, 1 - (severity * 0.55));
        const adjustedRisk = Math.max(riskFloor, baselineRisk * reductionFactor);

        recordOpsEvent({
          level: 'warn',
          source: 'daily_roi_throttle',
          message: 'daily_roi_exceeded_throttling_risk',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            dailyRoiPct: dailyRoiPct.toFixed(2),
            maxDailyRoi,
            excessRoi: excessRoi.toFixed(2),
            originalRisk: baselineRisk.toFixed(3),
            adjustedRisk: adjustedRisk.toFixed(3),
            reductionFactor: reductionFactor.toFixed(3),
            riskFloor: riskFloor.toFixed(3),
          },
        });

        console.log(`⚠️ Daily ROI throttle: ${baselineRisk.toFixed(3)}% → ${adjustedRisk.toFixed(3)}% (excess ROI: ${excessRoi.toFixed(2)}%, floor: ${riskFloor.toFixed(3)}%)`);
        return adjustedRisk;
      }

      if (dailyRoiPct > maxDailyRoi * 0.8) {
        const approachRatio = Math.max(0, (dailyRoiPct - (maxDailyRoi * 0.8)) / (maxDailyRoi * 0.2));
        const reductionFactor = Math.max(0.75, 1 - (0.15 * Math.min(1, approachRatio)));
        const adjustedRisk = Math.max(riskFloor, baselineRisk * reductionFactor);

        recordOpsEvent({
          level: 'info',
          source: 'daily_roi_throttle',
          message: 'daily_roi_approaching_limit_mild_throttle',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: {
            dailyRoiPct: dailyRoiPct.toFixed(2),
            maxDailyRoi,
            originalRisk: baselineRisk.toFixed(3),
            adjustedRisk: adjustedRisk.toFixed(3),
            reductionFactor: reductionFactor.toFixed(3),
            riskFloor: riskFloor.toFixed(3),
          },
        });

        console.log(`📉 Mild daily ROI throttle: ${baselineRisk.toFixed(3)}% → ${adjustedRisk.toFixed(3)}% (floor: ${riskFloor.toFixed(3)}%)`);
        return adjustedRisk;
      }

      return baselineRisk;

    } catch (error) {
      console.error('Failed to apply daily ROI throttle:', error);
      return riskPct; // Return original risk on error
    }
  }

  public async executeWithPlan(
    plan: ExecutionPlan,
    base: {
      side: 'buy'|'sell';
      qty: number;
      stop: number;
      tp: number[];
      entry: number;
      leverage: number;
      ticker?: { bid?: number; ask?: number; last?: number } | null;
    },
  ): Promise<PlacedOrder | null> {
    if (!this.broker || !this.profile) return null;

    const propagatePostOnly = <T extends ExecutionPlan | ExecutionPlan['fallbacks'][number]>(
      step: T,
      isFallback: boolean,
    ) => {
      const shouldPropagate = plan.postOnly === true && step.mode === 'limit' && step.postOnly == null;
      const postOnly = shouldPropagate ? true : step.postOnly;
      return { ...step, postOnly, isFallback };
    };
    const attempts = [
      propagatePostOnly(plan, false),
      ...plan.fallbacks.map(fallback => propagatePostOnly(fallback, true)),
    ] as Array<
      (ExecutionPlan & { isFallback: boolean }) |
      (ExecutionPlan['fallbacks'][number] & { isFallback: boolean })
    >;

    let last: PlacedOrder | null = null;

    for (const attempt of attempts) {
      const step: any = attempt;
      const isFallback = Boolean(step.isFallback);

      if (isFallback) {
        recordOpsEvent({
          level: 'info',
          source: 'execution',
          message: 'execution_fallback_attempt',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: { mode: step.mode, reason: step.reason, delayMs: step.delayMs },
        });
        if (step.delayMs && step.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, step.delayMs));
        }
      }

      try {
        if (step.mode === 'market') {
          last = await this.broker.place({
            symbol: this.profile.symbol,
            side: base.side,
            type: 'market',
            qty: base.qty,
            leverage: base.leverage,
            takeProfit: base.tp[0],
            stopLoss: base.stop,
          });
        } else if (step.mode === 'limit') {
          let limitPrice = step.limitPrice ?? plan.limitPrice ?? this.computePassivePrice(base.side, base.entry, base.ticker || undefined);
          if (step.passiveOffsetBps != null && base.ticker) {
            const slip = step.passiveOffsetBps / 10_000;
            if (base.side === 'buy') {
              const bid = base.ticker?.bid ?? limitPrice;
              limitPrice = Math.max(0, Math.min(limitPrice, bid * (1 - slip)));
            } else {
              const ask = base.ticker?.ask ?? limitPrice;
              limitPrice = Math.max(limitPrice, ask * (1 + slip));
            }
          }
          last = await this.placeLimitAdaptive({
            side: base.side,
            qty: base.qty,
            limitPrice,
            stop: base.stop,
            tp: base.tp,
            entry: base.entry,
            leverage: base.leverage,
            postOnly: Boolean(step.postOnly ?? plan.postOnly),
          });
        } else {
          const slices = step.twapSlices ?? plan.twapSlices ?? 3;
          const intervalMs = step.twapIntervalMs ?? plan.twapIntervalMs ?? 250;
          last = await this.executeTwapOrder({
            side: base.side,
            totalQty: base.qty,
            slices,
            intervalMs,
            stop: base.stop,
            tp: base.tp,
            entry: base.entry,
            leverage: base.leverage,
          });
        }
      } catch (error) {
        recordOpsEvent({
          level: 'warn',
          source: 'execution',
          message: 'execution_step_failed',
          sessionId: this.sessionId || undefined,
          symbol: this.profile.symbol,
          details: { mode: step.mode, reason: step.reason, error: String((error as any)?.message || error) },
        });
        last = null;
      }

      if (last && last.status !== 'rejected' && last.filledQty && last.filledQty > 0) {
        if (isFallback) {
          recordOpsEvent({
            level: 'info',
            source: 'execution',
            message: 'fallback_success',
            sessionId: this.sessionId || undefined,
            symbol: this.profile.symbol,
            details: { mode: step.mode, reason: step.reason, filledQty: last.filledQty },
          });
        }
        return last;
      }
    }

    return last;
  }

  public async placeLimitAdaptive(order: any): Promise<any> {
    const { side, qty, limitPrice, stop, tp, entry, leverage, postOnly } = order;

    if (!this.broker || !this.profile) {
      console.log('Cannot place limit order: missing broker or profile');
      return null;
    }

    try {
      console.log(`Placing adaptive limit order: ${side} ${this.profile.symbol} qty=${qty} @ ${limitPrice} (target: ${entry})`);

      // Place limit order with protective orders
      const placed = await this.broker.place({
        symbol: this.profile.symbol,
        side,
        type: 'limit',
        qty,
        price: limitPrice,
        leverage: Math.max(1, Math.min(this.profile.maxLeverage || 1, leverage || (this.profile.dynamicLeverage !== false ? (this.profile.minLeverage || 1) : (this.profile.maxLeverage || 1)))) ,
        takeProfit: tp[0], // Primary TP
        stopLoss: stop,
        postOnly: Boolean(postOnly),
      });

      if (placed.status === 'rejected' || !placed.filledQty || placed.filledQty <= 0) {
        console.log(`Limit order rejected or unfilled: ${placed.status}`);
        return placed;
      }

      // If we have multiple TPs, place additional TP orders
      if (tp.length > 1) {
        try {
          // Place runner TP as a separate limit order
          const runnerTp = tp[1];
          const runnerQty = Math.floor(placed.filledQty * 0.5); // 50% to runner TP

          if (runnerQty > 0) {
            const runnerOrder = await this.broker.place({
              symbol: this.profile.symbol,
              side: side === 'buy' ? 'sell' : 'buy', // Opposite side for TP
              type: 'limit',
              qty: runnerQty,
              price: runnerTp,
              leverage: Math.max(1, Math.min(this.profile.maxLeverage || 1, leverage || (this.profile.dynamicLeverage !== false ? (this.profile.minLeverage || 1) : (this.profile.maxLeverage || 1))))
            });

            if (runnerOrder.filledQty && runnerOrder.filledQty > 0) {
              console.log(`Placed runner TP: ${runnerQty} @ ${runnerTp}`);
            }
          }
        } catch (runnerError) {
          console.warn('Failed to place runner TP:', runnerError);
          // Continue with primary order
        }
      }

      console.log(`Adaptive limit order placed successfully: ${placed.filledQty} filled @ ${placed.avgPrice || limitPrice}`);
      return placed;

    } catch (error) {
      console.error(`Failed to place adaptive limit order:`, error);
      return null;
    }
  }

  public async executeTwapOrder(order: any): Promise<any> {
    const { side, totalQty, slices, intervalMs, stop, tp, entry, leverage } = order;

    if (!this.broker || !this.profile) {
      console.log('Cannot execute TWAP order: missing broker or profile');
      return null;
    }

    try {
      console.log(`Executing TWAP order: ${side} ${this.profile.symbol} totalQty=${totalQty} in ${slices} slices every ${intervalMs}ms`);

      const sliceQty = Math.floor(totalQty / slices);
      const remainderQty = totalQty % slices;
      let totalFilled = 0;
      let totalCost = 0;
      let avgPrice = 0;
      const executions: Array<{ slice: number; qty: number; price: number; timestamp: number }> = [];

      // Execute slices with time intervals
      for (let i = 0; i < slices; i++) {
        const currentSliceQty = i === slices - 1 ? sliceQty + remainderQty : sliceQty;

        if (currentSliceQty <= 0) continue;

        try {
          // Get fresh price for each slice
          const ticker = await getTicker(this.profile.symbol).catch(() => null);
          const currentPrice = ticker?.last || entry;

          // Calculate limit price for this slice (slightly better than current price)
          const limitPrice = this.computePassivePrice(side, currentPrice, ticker);

          console.log(`TWAP slice ${i + 1}/${slices}: ${currentSliceQty} @ ${limitPrice} (market: ${currentPrice})`);

          // Place limit order for this slice
          const sliceOrder = await this.broker.place({
            symbol: this.profile.symbol,
            side,
            type: 'limit',
            qty: currentSliceQty,
            price: limitPrice,
            leverage: Math.max(1, Math.min(this.profile.maxLeverage || 1, leverage || (this.profile.dynamicLeverage !== false ? (this.profile.minLeverage || 1) : (this.profile.maxLeverage || 1))))
          });

          if (sliceOrder.filledQty && sliceOrder.filledQty > 0) {
            totalFilled += sliceOrder.filledQty;
            if (sliceOrder.avgPrice) {
              totalCost += sliceOrder.avgPrice * sliceOrder.filledQty;
            }
            executions.push({
              slice: i + 1,
              qty: sliceOrder.filledQty,
              price: sliceOrder.avgPrice || limitPrice,
              timestamp: Date.now()
            });
          }

          // Wait for next slice (except for last one)
          if (i < slices - 1) {
            await new Promise(resolve => setTimeout(resolve, intervalMs));
          }

        } catch (sliceError) {
          console.warn(`TWAP slice ${i + 1} failed:`, sliceError);
          // Continue with next slice
        }
      }

      // Calculate average execution price
      if (totalFilled > 0) {
        avgPrice = totalCost / totalFilled;
      }

      // Place protective orders for the total filled quantity
      let slOrderId, tpOrderId;
      if (totalFilled > 0) {
        try {
          const protectiveResult = await (this.broker as any).syncProtective?.({
            symbol: this.profile.symbol,
            side,
            qty: totalFilled,
            stopLoss: stop,
            takeProfit: tp[0]
          });

          slOrderId = protectiveResult?.slOrderId;
          tpOrderId = protectiveResult?.tpOrderId;
        } catch (protectiveError) {
          console.warn('Failed to place protective orders for TWAP:', protectiveError);
        }
      }

      const result = {
        status: totalFilled > 0 ? 'filled' : 'rejected',
        filledQty: totalFilled,
        avgPrice,
        orderId: `twap_${Date.now()}`,
        slOrderId,
        tpOrderId,
        executions,
        telemetry: {
          totalSlices: slices,
          successfulSlices: executions.length,
          totalIntervalMs: (slices - 1) * intervalMs,
          avgSliceQty: sliceQty,
          priceImprovement: avgPrice < entry ? (entry - avgPrice) / entry * 100 : 0
        }
      };

      console.log(`TWAP execution completed: ${totalFilled}/${totalQty} filled @ ${avgPrice?.toFixed(6)} (${executions.length}/${slices} slices successful)`);

      return result;

    } catch (error) {
      console.error(`Failed to execute TWAP order:`, error);
      return null;
    }
  }

  public computeTelemetry(startTs: number, placed: any, details: any): any {
    const { expectedPrice, requestedQty, side } = details;
    const latencyMs = Date.now() - startTs;

    // Calculate slippage in basis points (0.01% = 1 bp)
    let slippageBps = 0;
    if (placed?.avgPrice && expectedPrice) {
      const actualPrice = placed.avgPrice;
      const slippagePct = ((actualPrice - expectedPrice) / expectedPrice) * 100;
      slippageBps = Math.round(slippagePct * 100); // Convert to basis points
    }

    // Calculate fill ratio
    const filledQty = placed?.filledQty || 0;
    const fillRatio = requestedQty > 0 ? filledQty / requestedQty : 0;

    // For now, assume no cancellations (cancelCount = 0)
    // In a real implementation, this would track order cancellations
    const cancelCount = 0;

    // Attempts - for now assume 1 attempt, but could track retries
    const attempts = 1;

    // Additional metrics for analysis
    const priceImprovement = expectedPrice && placed?.avgPrice ?
      (side === 'buy' ?
        (expectedPrice - placed.avgPrice) / expectedPrice * 100 : // Lower is better for buy
        (placed.avgPrice - expectedPrice) / expectedPrice * 100   // Higher is better for sell
      ) : 0;

    return {
      latencyMs,
      slippageBps,
      fillRatio,
      cancelCount,
      attempts,
      priceImprovement,
      requestedPrice: expectedPrice,
      executedPrice: placed?.avgPrice,
      filledQty,
      requestedQty
    };
  }

  public getAdaptationMultipliers(strategy: any, bias: string): any {
    // Default multipliers (no adaptation)
    const multipliers = {
      atr: 1.0,
      adx: 1.0,
      risk: 1.0,
      size: 1.0
    };

    if (!this.performanceMetrics || !this.recentTrades.length) {
      return multipliers; // No performance data available
    }

    try {
      // Analyze recent performance (last 10 trades)
      const recentTrades = this.recentTrades.slice(-10);
      const winRate = recentTrades.filter(t => t.win).length / recentTrades.length;
      const avgPnlPct = recentTrades.reduce((sum, t) => sum + t.pnlPct, 0) / recentTrades.length;

      // Target performance metrics
      const targetWinRate = 0.65;
      const targetAvgPnl = 0.5; // 0.5% average profit

      // Calculate performance score (-1 to 1, where 1 is excellent performance)
      const winRateScore = Math.max(-1, Math.min(1, (winRate - targetWinRate) / 0.2)); // ±20% win rate deviation
      const pnlScore = Math.max(-1, Math.min(1, (avgPnlPct - targetAvgPnl) / targetAvgPnl)); // Relative to target PnL
      const performanceScore = (winRateScore + pnlScore) / 2;

      console.log(`🎯 Performance adaptation for ${strategy}_${bias}: winRate=${winRate.toFixed(2)}, avgPnL=${avgPnlPct.toFixed(2)}%, score=${performanceScore.toFixed(2)}`);

      // Adjust multipliers based on performance
      if (performanceScore > 0.3) {
        // Excellent performance - can be more aggressive
        multipliers.atr *= 0.8;  // Lower ATR threshold (more permissive)
        multipliers.adx *= 0.9;  // Lower ADX threshold (more permissive)
        multipliers.risk *= 1.1; // Slightly higher risk tolerance
        multipliers.size *= 1.05; // Slightly larger position sizes

        recordOpsEvent({
          level: 'info',
          source: 'performance_adaptation',
          message: 'performance_excellent_increasing_aggression',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { performanceScore: performanceScore.toFixed(2), multipliers }
        });

      } else if (performanceScore < -0.3) {
        // Poor performance - be more conservative
        multipliers.atr *= 1.3;  // Higher ATR threshold (more strict)
        multipliers.adx *= 1.2;  // Higher ADX threshold (more strict)
        multipliers.risk *= 0.8; // Lower risk tolerance
        multipliers.size *= 0.9; // Smaller position sizes

        recordOpsEvent({
          level: 'warn',
          source: 'performance_adaptation',
          message: 'performance_poor_increasing_conservatism',
          sessionId: this.sessionId || undefined,
          symbol: this.profile?.symbol,
          details: { performanceScore: performanceScore.toFixed(2), multipliers }
        });

      } else {
        // Neutral performance - slight adjustments based on recent trends
        const recentTrend = this.getRecentPerformance(5);
        if (recentTrend.winRate > winRate) {
          // Improving - slight relaxation
          multipliers.atr *= 0.95;
          multipliers.adx *= 0.97;
        } else if (recentTrend.winRate < winRate) {
          // Declining - slight tightening
          multipliers.atr *= 1.05;
          multipliers.adx *= 1.03;
        }
      }

      // Apply bounds to prevent extreme values
      multipliers.atr = Math.max(0.5, Math.min(2.0, multipliers.atr));
      multipliers.adx = Math.max(0.5, Math.min(2.0, multipliers.adx));
      multipliers.risk = Math.max(0.5, Math.min(1.5, multipliers.risk));
      multipliers.size = Math.max(0.7, Math.min(1.3, multipliers.size));

      console.log(`🎯 Adaptation multipliers: ATR=${multipliers.atr.toFixed(2)}, ADX=${multipliers.adx.toFixed(2)}, Risk=${multipliers.risk.toFixed(2)}, Size=${multipliers.size.toFixed(2)}`);

      return multipliers;

    } catch (error) {
      console.error('Error calculating adaptation multipliers:', error);
      return multipliers; // Return defaults on error
    }
  }

  public async nextPlan(options?: any): Promise<any> {
    try {
      const symbol = this.profile?.symbol;
      if (!symbol) {
        console.warn('nextPlan: No symbol available');
        return this.plan;
      }

      // Get current market snapshot
      const snap = await buildTechSnapshot(symbol);
      const regime = snap.regime;

      // Analyze recent performance to inform plan generation
      const performanceAnalysis = this.analyzeRecentPerformance();
      const adaptationMultipliers = this.getAdaptationMultipliers(
        this.plan?.bias || 'long',
        this.plan?.bias || 'long'
      );

      // Determine if we need a fresh plan or can adapt current one
      const needsFreshPlan = this.shouldGenerateFreshPlan(performanceAnalysis, snap, regime);

      let newPlan: PlanJson;

      if (needsFreshPlan) {
        // Generate completely new plan using AI
        console.log(`🎯 Generating fresh plan for ${symbol} - performance analysis: ${performanceAnalysis.needsAdjustment ? 'needs adjustment' : 'performing well'}`);

        newPlan = await proposePlan(symbol, {
          fresh: true,
          sessionId: this.sessionId || undefined,
          context: performanceAnalysis.killReason ? {
            killReason: performanceAnalysis.killReason,
            killDetails: performanceAnalysis.details
          } : undefined
        });
      } else {
        // Adapt existing plan based on performance and market conditions
        console.log(`🔄 Adapting existing plan for ${symbol}`);
        newPlan = this.adaptExistingPlan(snap, regime, performanceAnalysis, adaptationMultipliers);
      }

      // Apply performance-based adjustments
      newPlan = this.applyPerformanceAdjustments(newPlan, performanceAnalysis, adaptationMultipliers);

      // Validate the new plan
      const validatedPlan = await validatePlan(newPlan);

      // Update agent state
      this.plan = validatedPlan;
      this.aiBiasOverride = null;
      this.regime = regime || null;
      
      // 🔥 PHASE 1: Initialize zone tracking variables
      this.lastZoneCalculation = Date.now();
      this.zoneCalculatedForBias = validatedPlan.bias;
      this.priceInZoneStartTime = 0;
      this.requireStrongerConfirmation = false;

      // Log plan generation
      recordOpsEvent({
        level: 'info',
        source: 'next_plan',
        message: needsFreshPlan ? 'fresh_plan_generated' : 'plan_adapted',
        sessionId: this.sessionId || undefined,
        symbol,
        details: {
          bias: newPlan.bias,
          playbook: newPlan.meta?.playbook,
          performanceScore: performanceAnalysis.performanceScore,
          adaptationApplied: !needsFreshPlan
        }
      });

      return validatedPlan;

    } catch (error) {
      console.error('Error in nextPlan:', error);

      // Fallback: return current plan or generate basic fallback
      if (this.plan) {
        console.log('Returning current plan as fallback');
        return this.plan;
      }

      // Generate emergency fallback plan
      try {
        const symbol = this.profile?.symbol || 'BTC/USDT';
        const snap = await buildTechSnapshot(symbol);
        const fallbackPlan = {
          name: 'Emergency_Fallback',
          symbol,
          timeframe: '1h' as const,
          bias: 'none' as const,
          zone: { type: 'support' as const, price: null, from: 'auto_detect' as const },
          entry_rule: { type: 'rebound' as const, confirm_close: true, max_distance_pct: 0.4 },
          risk: {
            stop: { type: 'atr' as const, mult: 1.0 },
            tp: [{ type: 'R' as const, value: 2.0 }],
            max_hold_hours: 36
          },
          position: { risk_fraction: 0.01, max_leverage: 5 },
          notes: 'Emergency fallback plan due to nextPlan error',
          meta: { playbook: 'standby' as const }
        };

        return await validatePlan(fallbackPlan);
      } catch (fallbackError) {
        console.error('Fallback plan generation failed:', fallbackError);
        return this.plan; // Return whatever we have
      }
    }
  }

  public analyzeRecentPerformance(): {
    performanceScore: number;
    needsAdjustment: boolean;
    killReason?: string;
    details?: any;
    consecutiveLosses: number;
    winRate: number;
    profitRatio: number;
  } {
    const recentTrades = this.recentTrades.slice(-10); // Last 10 trades
    if (recentTrades.length === 0) {
      return {
        performanceScore: 0.5,
        needsAdjustment: false,
        consecutiveLosses: 0,
        winRate: 0,
        profitRatio: 0
      };
    }

    const wins = recentTrades.filter(t => t.win).length;
    const winRate = wins / recentTrades.length;
    const profits = recentTrades.filter(t => t.win).reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);
    const losses = recentTrades.filter(t => !t.win).reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);
    const profitRatio = losses > 0 ? profits / losses : profits > 0 ? 10 : 0;

    // Calculate consecutive losses
    let consecutiveLosses = 0;
    for (let i = recentTrades.length - 1; i >= 0; i--) {
      if (!recentTrades[i].win) {
        consecutiveLosses++;
      } else {
        break;
      }
    }

    // Performance score (0-1, higher is better)
    let performanceScore = 0;
    performanceScore += winRate * 0.4; // 40% weight on win rate
    performanceScore += Math.min(profitRatio / 3, 1) * 0.4; // 40% weight on profit ratio (capped at 3:1)
    performanceScore += Math.max(0, 1 - consecutiveLosses / 5) * 0.2; // 20% weight on consistency

    const needsAdjustment = winRate < 0.4 || consecutiveLosses >= 3 || profitRatio < 0.8;

    let killReason: string | undefined;
    let details: any = {};

    // Determine if we should trigger kill switch (mode-adaptive)
    const limits = defaultLimits(this.profile?.aggressiveness);
    const maxConsecStops = limits.maxConsecutiveStops;
    
    if (consecutiveLosses >= 5) {
      killReason = 'consecutive_losses';
      details = { consecutiveLosses, recentTrades: recentTrades.length };
    } else if (winRate < 0.2 && recentTrades.length >= 5) {
      killReason = 'poor_win_rate';
      details = { winRate, recentTrades: recentTrades.length };
    } else if (this.consecutiveStops >= maxConsecStops) {
      killReason = 'multiple_stops';
      details = { consecutiveStops: this.consecutiveStops, maxAllowed: maxConsecStops, mode: this.profile?.aggressiveness };
    }

    return {
      performanceScore,
      needsAdjustment,
      killReason,
      details,
      consecutiveLosses,
      winRate,
      profitRatio
    };
  }

  public shouldGenerateFreshPlan(
    performance: ReturnType<typeof this.analyzeRecentPerformance>,
    snap: TechnicalSnapshot,
    regime?: any
  ): boolean {
    // Generate fresh plan if:
    // 1. Performance is very poor
    // 2. Regime has changed significantly
    // 3. Current plan is old or ineffective
    // 4. Market conditions have changed dramatically

    if (performance.killReason) return true;
    if (performance.consecutiveLosses >= 3) return true;
    if (performance.winRate < 0.3 && performance.profitRatio < 0.5) return true;

    // Check if regime has changed
    if (this.regime && regime) {
      if (this.regime.playbook !== regime.playbook) return true;
      if (this.regime.trend !== regime.trend) return true;
    }

    // Check if market volatility has changed significantly
    const currentVolatility = snap.atrPct || 0;
    const previousVolatility = this.plan ? (this.plan as any).atrPct || 0 : 0;
    if (Math.abs(currentVolatility - previousVolatility) / previousVolatility > 0.5) return true;

    // Generate fresh plan periodically (every few hours) or after significant drawdown
    const timeSinceLastPlan = this.plan ? Date.now() - (this.plan as any).timestamp || 0 : 0;
    if (timeSinceLastPlan > 4 * 60 * 60 * 1000) return true; // 4 hours

    return false;
  }

  public adaptExistingPlan(
    snap: TechnicalSnapshot,
    regime: any,
    performance: ReturnType<typeof this.analyzeRecentPerformance>,
    multipliers: ReturnType<typeof this.getAdaptationMultipliers>
  ): PlanJson {
    if (!this.plan) throw new Error('No existing plan to adapt');

    const basePlan = { ...this.plan.plan };

    // Apply performance-based adjustments
    if (performance.needsAdjustment) {
      // Tighten risk if performing poorly
      if (performance.winRate < 0.4) {
        basePlan.position.risk_fraction = Math.max(0.005, basePlan.position.risk_fraction * 0.8);
        basePlan.risk.stop.mult = Math.min(2.5, basePlan.risk.stop.mult * 1.1); // Tighter stops
      }

      // Adjust TP targets based on performance
      if (performance.profitRatio < 1.0) {
        // Increase TP targets if profit ratio is poor
        basePlan.risk.tp = basePlan.risk.tp.map(tp => ({
          ...tp,
          value: Math.min(5.0, tp.value * 1.2)
        }));
      }
    }

    // Apply adaptation multipliers
    basePlan.risk.stop.mult *= multipliers.atr;

    // Adjust based on current market regime
    if (regime) {
      const existingPlaybook = basePlan.meta?.playbook;
      const finalPlaybook = existingPlaybook != null ? existingPlaybook : regime.playbook;
      basePlan.meta = {
        ...basePlan.meta,
        playbook: finalPlaybook,
        regime: regime.trend,
        volatility: regime.volatility
      };

      if (regime.playbook === 'standby') {
        basePlan.bias = 'none';
      } else if (regime.playbook === 'momentum_breakout') {
        // Adjust for breakout conditions
        basePlan.entry_rule.confirm_close = false;
        basePlan.entry_rule.max_distance_pct = Math.min(0.6, basePlan.entry_rule.max_distance_pct * 1.2);
      }
    }

    // Update zone based on current market levels
    if (snap.support && snap.resistance) {
      if (basePlan.bias === 'long') {
        basePlan.zone.price = snap.support;
      } else if (basePlan.bias === 'short') {
        basePlan.zone.price = snap.resistance;
      }
    }

    // Add adaptation note
    basePlan.notes = `${basePlan.notes || ''} [Adapted: perf=${performance.performanceScore.toFixed(2)}, mult_atr=${multipliers.atr.toFixed(2)}]`.trim();

    return basePlan;
  }

  public applyPerformanceAdjustments(
    plan: PlanJson,
    performance: ReturnType<typeof this.analyzeRecentPerformance>,
    multipliers: ReturnType<typeof this.getAdaptationMultipliers>
  ): PlanJson {
    const adjusted = { ...plan };

    // Apply ATR multiplier
    adjusted.risk.stop.mult = Math.max(0.4, Math.min(3.0, adjusted.risk.stop.mult * multipliers.atr));

    // Adjust position sizing based on performance
    if (performance.performanceScore < 0.3) {
      // Poor performance - reduce risk
      adjusted.position.risk_fraction = Math.max(0.005, adjusted.position.risk_fraction * 0.7);
    } else if (performance.performanceScore > 0.7) {
      // Good performance - can increase risk slightly
      adjusted.position.risk_fraction = Math.min(0.03, adjusted.position.risk_fraction * 1.1);
    }

    // Update risk fraction range
    if (adjusted.position.risk_fraction_range) {
      const base = adjusted.position.risk_fraction;
      adjusted.position.risk_fraction_range.min = Math.max(0.005, base * 0.8);
      adjusted.position.risk_fraction_range.max = Math.min(0.05, base * 1.2);
      adjusted.position.risk_fraction_range.recommended = base;
    }

    // Adjust leverage based on performance
    if (performance.consecutiveLosses >= 2) {
      adjusted.position.max_leverage = Math.max(1, Math.floor(adjusted.position.max_leverage * 0.8));
    }

    return adjusted;
  }

  /**
   * Détermine si on devrait appeler l'IA pour une prédiction (optimisation coût)
   */
  public shouldCallAIPrediction(snap: TechnicalSnapshot, currentPrice: number): boolean {
    try {
      // 0. COOLDOWN GLOBAL: Minimum 5 minutes entre appels IA (économie de coûts)
      const lastPredictionTime = (this as any).lastAIPredictionTime || 0;
      const timeSinceLastPrediction = Date.now() - lastPredictionTime;
      const minCooldownMs = 5 * 60 * 1000; // 5 minutes minimum
      
      if (timeSinceLastPrediction < minCooldownMs) {
        // Trop tôt depuis dernier appel, skip silencieusement
        return false;
      }

      // 1. Vérifier proximité d'un niveau clé (support/résistance)
      const nearKeyLevel = this.checkNearKeyLevel(currentPrice, snap);
      if (nearKeyLevel) {
        console.log(`🧠 AI call triggered: Near key level (${Math.floor(timeSinceLastPrediction / 60000)}min since last)`);
        return true;
      }

      // 2. Vérifier volatilité récente élevée (ATR > seuil)
      const atrPct = Number((snap as any)?.atrPct ?? 0);
      if (atrPct > 3.0) { // Plus de 3% ATR = marché très volatile
        console.log(`🧠 AI call triggered: High volatility (ATR: ${atrPct.toFixed(2)}%)`);
        return true;
      }

      // 3. Vérifier changement de prix significatif depuis dernière prédiction
      
      // Si plus de 30 minutes depuis dernière prédiction, vérifier changement de prix
      if (timeSinceLastPrediction > 30 * 60 * 1000) {
        const lastPrice = (this as any).lastAIPredictionPrice || currentPrice;
        const priceChangePct = Math.abs((currentPrice - lastPrice) / lastPrice) * 100;
        
        if (priceChangePct > 2.0) { // Plus de 2% changement = appel IA
          console.log(`🧠 AI call triggered: Significant price change (${priceChangePct.toFixed(2)}%)`);
          return true;
        }
      }

      // 4. Vérifier conditions de momentum (slope élevée)
      const emaSlope = Number((snap as any)?.ema20Slope ?? 0);
      const slopeRatio = Math.abs(currentPrice !== 0 ? emaSlope / currentPrice : 0);
      if (slopeRatio > 0.0025) { // Slope > 0.25% = momentum très fort
        console.log(`🧠 AI call triggered: Strong momentum (slope: ${(slopeRatio * 100).toFixed(3)}%)`);
        return true;
      }

      // 5. Appel périodique (toutes les 4 heures minimum)
      if (timeSinceLastPrediction > 4 * 60 * 60 * 1000) {
        console.log(`🧠 AI call triggered: Periodic check (${Math.floor(timeSinceLastPrediction / (60 * 1000))}min since last)`);
        return true;
      }

      return false; // Pas d'appel IA nécessaire

    } catch (error) {
      console.warn('Error checking AI prediction conditions:', error);
      return false; // En cas d'erreur, pas d'appel IA
    }
  }
}
