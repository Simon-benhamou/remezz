/**
 * orchestrator.ts — Agent Orchestrator (formerly SimpleAgent)
 *
 * V5.108: Renamed from simpleAgent.ts for clarity.
 * Each AgentOrchestrator instance manages the full trading lifecycle for one symbol:
 *   - Entry signal detection (via SymbolEngine or self-computation)
 *   - Exit management (trailing stops, stagnant detection, NFS)
 *   - Position sync with exchange (WebSocket + REST fallback)
 *   - Real-time monitoring via RealtimeExitHandler
 *
 * CapitalPool extracted to capitalPool.ts (shared capital management).
 * simpleAgent.ts is now a barrel re-export for backward compatibility.
 */

import { PrismaClient } from '@prisma/client';
import {
  MomentumConfig,
  checkMomentumSignal,
  shouldExitPosition,
  updatePositionWaterMarks,
  getMarketConditions,
  calculateExitNowMs,  // V5.45: Shared exit time calculation for parity
  calcROC,             // Shared indicator
  calcATR,             // Shared indicator
  calcBBPosition,      // Shared indicator
  calcTrendStrength,   // Shared indicator
  calcVolRatio,        // Shared indicator

  type Candle,
  type Position,
  type MarketConditions,
} from './momentumSimple.js';
import { createLogger, runWithUserId } from '../utils/logger.js';
import { globalSignalRanker, getSignalTier } from './signalRanker.js';

import {
  getBinanceWebSocket,
  type BinanceKlineData,
} from '../services/binanceWebSocket.js';
import {
  notifyTrailingActivated,
  notifyRegimeChange,
  notifyAgentStarted,
  notifyAgentStopped,
  notifyLongHold,
  notifyLiquidationWarning,
  notifySignalDetected,
} from '../services/notificationService.js';
import { notifySystemAlert } from '../utils/notifications.js';
import { trackRejectedSignal, updateAgentState } from '../services/telegramReporter.js';
import { type ExitReason } from '../services/orderPriority.js';
import { CACHE_TTLS, SYNC_INTERVALS } from '../config/constants.js';
import { PositionPersistence } from './positionPersistence.js';
import {
  EXIT_TRAIL, EXIT_TRAIL_NFS_HIGH_15M,
  EXIT_TRAIL_NFS_MED_15M, EXIT_TRAIL_NFS_LOW_15M, EXIT_TRAIL_PROACTIVE_15M,
  EXIT_TRAIL_CRASH_SAFETY,
  EXIT_SL_EXCHANGE, EXIT_TRAIL_EXCHANGE,
  EXIT_STAGNANT,
  EXIT_SIGNAL_REASON_MAP, toCanonical,
} from '../types/exitReasons.js';
import { ExchangeOrderManager } from './exchangeOrderManager.js';
import { PositionOpener } from './positionOpener.js';
import { RealtimeExitHandler } from './realtimeExitHandler.js';
import { symbolEngineManager } from './symbolEngineManager.js';
import {
  type Candle as NfsCandle,
} from '../services/nfsRealtimeExit.js';
import {
  updateSymbolState,
  calculateProximityScore,
  type SignalFeatures,
} from '../services/signalRadarService.js';

const logger = createLogger('agent');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Global caches (BTC candles, leverage) are managed by globalCacheManager

// Exchange type imported from centralized types
import type { Exchange } from '../types/exchange.js';
import { CapitalPool, getCapitalPool, resetCapitalPool } from './capitalPool.js';
import { CandleFetcher } from './agent/candleFetcher.js';
import { ExchangeSync } from './agent/exchangeSync.js';
import { PositionCloser } from './agent/positionCloser.js';
import { buildAgentState, type AgentStateResult, type TradeEvent } from './agent/agentState.js';
import { getBtcDataService } from '../services/btcDataService.js';

// CapitalPool extracted to capitalPool.ts


// ============================================================================
// CONFIGURATION
// ============================================================================

export interface SimpleAgentConfig {
  // Exchange
  exchange: Exchange;
  
  // Database
  prisma: PrismaClient;
  
  // Session
  userId: string;
  sessionId: string;
  
  // Capital - Use shared pool
  capitalPool: CapitalPool;
  riskPerTradePct: number;  // Ex: 1 = 1%
  
  // Symbol for this agent
  symbol: string;  // Ex: 'BTC/USDT:USDT'
  
  // Mode
  mode: 'paper' | 'live';
  
  // Optionnel: callbacks
  onSignal?: (signal: SignalEvent) => void;
  onTrade?: (trade: TradeEvent) => void;
  onError?: (error: Error) => void;
  onMarketConditions?: (conditions: MarketConditions) => void;
  onTick?: (tick: TickEvent) => void;
}

export interface TickEvent {
  symbol: string;
  price: number;
  hasPosition: boolean;
  positionSide?: 'long' | 'short';
  support?: number;
  resistance?: number;
  tickCount: number;
  timestamp: Date;
}

export interface SignalEvent {
  symbol: string;
  side: 'long' | 'short';
  reason: string;
  timestamp: Date;
}

// TradeEvent moved to agent/agentState.ts — re-exported for backward compatibility
export type { TradeEvent };

// ============================================================================
// SIMPLE AGENT CLASS
// ============================================================================

export class AgentOrchestrator {
  private config: SimpleAgentConfig;
  private persistence: PositionPersistence;
  private orderManager: ExchangeOrderManager;
  private positionOpener: PositionOpener;
  private rtExitHandler: RealtimeExitHandler;
  private position: Position | null = null;

  // V5.30: Multi-position support - additional positions for large accounts
  private additionalPositions: Position[] = [];

  private running = false;
  private tickIntervalId: NodeJS.Timeout | null = null;
  private tickAlignTimeoutId: NodeJS.Timeout | null = null; // V5.39: For synchronized tick alignment
  private finalKlineUnsubscribe: (() => void) | null = null; // V5.50: Instant candle close detection

  private closingPosition = false;

  private lastMarketConditions: MarketConditions | null = null;
  private tickCount: number = 0;
  private lastTickAt: number = 0;
  private lastPrice: number = 0;
  private lastRejectReason: string = ''; // Track why no signal
  
  // Current trading state for frontend display
  private currentBias: 'long' | 'short' | null = null;
  private lastSignal: {
    entryZone?: [number, number];
    stopDistance?: number;
    targets?: number[];
    targetPcts?: number[];
  } | null = null;
  private lastExit: { ts: number; price: number; reason: string } | null = null;
  
  // V5.5: Track signal features for market quality assessment
  private lastSignalFeatures: {
    volRatio: number;
    roc: number;
    roc5: number;
    bbDistance: number;  // % distance from BB upper/lower
    reason: string;
  } | null = null;

  // V5.71: Cache last known BTC regime for real-time Signal Radar
  private lastKnownRegime: 'BULL' | 'BEAR' | 'NEUTRAL' | null = null; // null = not yet calculated

  // Consecutive tick error tracking for Telegram alerts
  private consecutiveTickErrors = 0;
  private lastErrorAlertTs = 0;
  
  // Track trailing stop activation (to notify only once)
  private trailingNotified: boolean = false;
  
  // V5.12: Track if trailing has been widened (for SMART trailing)
  private trailingWidened: boolean = false;
  private stagnantSlUpdated: boolean = false;  // V5.81: Track if exchange SL was tightened for stagnant
  
  // V5.11: Track last processed candle timestamp to sync with backtest
  // Only check entry signals when a NEW 15m candle closes (not on every tick)
  private lastProcessedCandleTs: number = 0;

  // Backtest parity: only evaluate exits on NEWLY CLOSED candles too.
  private lastProcessedExitCandleTs: number = 0;
  
  // V5.22/V5.23: Helper methods for signal scoring
  // Indicator helpers removed - using shared imports from momentumSimple.ts

  // Backtest parity: apply a post-exit cooldown to avoid immediate re-entries.
  // Backtest service uses 8 bars (2h) cooldown after any exit.
  private readonly ENTRY_COOLDOWN_BARS = 8;
  private entryCooldownBarsRemaining: number = 0;
  
  // V5.108: Extracted modules
  private candleFetcher: CandleFetcher;
  private exchangeSync: ExchangeSync;
  private positionCloser: PositionCloser;

  // Guard against concurrent tick execution (prevents re-entrancy/recursion)
  private tickInProgress = false;
  
  constructor(config: SimpleAgentConfig) {
    this.config = config;
    this.persistence = new PositionPersistence({
      prisma: config.prisma,
      sessionId: config.sessionId,
      symbol: config.symbol,
      mode: config.mode,
    });
    this.orderManager = new ExchangeOrderManager(config.exchange, config.symbol, config.mode, config.userId);

    // V5.108: Initialize extracted modules
    this.candleFetcher = new CandleFetcher(config.symbol, config.exchange, CACHE_TTLS.SYMBOL_CANDLE_MS);
    this.exchangeSync = new ExchangeSync(
      {
        symbol: config.symbol,
        mode: config.mode,
        userId: config.userId,
        sessionId: config.sessionId,
        exchange: config.exchange,
        prisma: config.prisma,
        capitalPool: config.capitalPool,
        persistence: this.persistence,
        getPosition: () => this.position,
        setPosition: (pos: Position | null) => { this.position = pos; },
        isClosingPosition: () => this.closingPosition,
        savePositionToDb: (pos, action, fee) => this.savePositionToDb(pos, action, fee),
        saveExitToDb: (pos, price, reason, pnlPct, pnlUsd, orderId, fee) => this.saveExitToDb(pos, price, reason, pnlPct, pnlUsd, orderId, fee),
        cancelStopLossOnExchange: () => this.cancelStopLossOnExchange(),
        setStopLossOnExchange: (pos, isUpdate) => this.setStopLossOnExchange(pos, isUpdate),
        startRealtimeExitMonitorIfNeeded: () => this.startRealtimeExitMonitorIfNeeded(),
        formatQtyForExchange: (sym, qty) => this.formatQtyForExchange(sym, qty),
        resetTrailingState: () => {
          this.trailingNotified = false;
          this.trailingWidened = false;
          this.stagnantSlUpdated = false;
          this.rtExitHandler.resetState();
          this.currentBias = null;
          this.lastSignal = null;
        },
      },
      SYNC_INTERVALS.POSITION_MS,
      SYNC_INTERVALS.MISSING_TRADES_MS,
    );

    // Initialize RealtimeExitHandler (owns NFS system + proactive limit state)
    this.rtExitHandler = new RealtimeExitHandler({
      symbol: config.symbol,
      mode: config.mode,
      userId: config.userId,
      getPosition: () => this.position,
      isRunning: () => this.running,
      isClosingPosition: () => this.closingPosition,
      setClosingPosition: (val: boolean) => { this.closingPosition = val; },
      fetchCandles: () => this.candleFetcher.fetchCandles(),
      orderManager: this.orderManager,
      closePosition: (pos, price, reason) => this.closePosition(pos, price, reason),
      setLastPrice: (price: number) => { this.lastPrice = price; },
      setPosition: (pos: Position) => { this.position = pos; },
    });
    this.rtExitHandler.initializeNfsSystem();

    // Initialize PositionOpener
    this.positionOpener = new PositionOpener({
      symbol: config.symbol,
      sessionId: config.sessionId,
      userId: config.userId,
      mode: config.mode,
      exchange: config.exchange,
      capitalPool: config.capitalPool,
      riskPerTradePct: config.riskPerTradePct,
      savePositionToDb: (pos, action, fee) => this.savePositionToDb(pos, action, fee),
      setStopLossOnExchange: (pos, isUpdate) => this.setStopLossOnExchange(pos, isUpdate),
      setTrailingStopOnExchange: (pos, isWidening) => this.setTrailingStopOnExchange(pos, isWidening),
      formatQtyForExchange: (sym, qty) => this.formatQtyForExchange(sym, qty),
      startRealtimeExitMonitorIfNeeded: () => this.startRealtimeExitMonitorIfNeeded(),
      onTrade: config.onTrade ? (trade) => config.onTrade!(trade) : undefined,
    });

    // V5.108 Phase 4: Initialize PositionCloser
    this.positionCloser = new PositionCloser({
      symbol: config.symbol,
      mode: config.mode,
      sessionId: config.sessionId,
      userId: config.userId,
      capitalPool: config.capitalPool,
      entryCooldownBars: this.ENTRY_COOLDOWN_BARS,
      getPosition: () => this.position,
      setPosition: (pos: Position | null) => { this.position = pos; },
      getAdditionalPositions: () => this.additionalPositions,
      clearAdditionalPositions: () => { this.additionalPositions = []; },
      isClosingPosition: () => this.closingPosition,
      setClosingPosition: (val: boolean) => { this.closingPosition = val; },
      setEntryCooldownBarsRemaining: (val: number) => { this.entryCooldownBarsRemaining = val; },
      setLastExit: (exit) => { this.lastExit = exit; },
      stopRealtimeExitMonitor: () => this.stopRealtimeExitMonitor(),
      resetTrailingAndSignalState: () => {
        this.trailingNotified = false;
        this.trailingWidened = false;
        this.stagnantSlUpdated = false;
        this.rtExitHandler.resetState();
        this.currentBias = null;
        this.lastSignal = null;
      },
      syncWithExchange: () => this.exchangeSync.syncWithExchange(),
      cancelStopLossOnExchange: () => this.cancelStopLossOnExchange(),
      formatQtyForExchange: (sym, qty) => this.formatQtyForExchange(sym, qty),
      saveExitToDb: (pos, price, reason, pnlPct, pnlUsd, orderId, fee) =>
        this.saveExitToDb(pos, price, reason, pnlPct, pnlUsd, orderId, fee),
      startRealtimeExitMonitorIfNeeded: () => this.startRealtimeExitMonitorIfNeeded(),
      onTrade: config.onTrade ? (trade) => config.onTrade!(trade) : undefined,
    });
  }

  // NFS system initialization delegated to rtExitHandler (see constructor)
  
  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================
  
  async start(): Promise<void> {
    return runWithUserId(this.config.userId, async () => {
    if (this.running) {
      logger.info(`⚠️ [${this.config.symbol}] Already running`);
      return;
    }

    this.running = true;

    // 🔄 LIVE MODE: Sync balance FIRST before logging (to show correct capital)
    if (this.config.mode === 'live') {
      logger.info(`🔄 [${this.config.symbol}] Syncing with exchange...`);
      await this.config.capitalPool.syncWithExchange(true);
    }
    
    // Now log with correct capital (showing pool total and available)
    const poolStatus = this.config.capitalPool.getStatus();
    logger.info(`✅ [${this.config.symbol}] STARTED | mode=${this.config.mode} | risk=${this.config.riskPerTradePct}% | pool=$${poolStatus.totalUsd.toFixed(2)} (avail=$${poolStatus.availableUsd.toFixed(2)})`);
    
    // 📢 NOTIFICATION: Agent started
    notifyAgentStarted({
      symbol: this.config.symbol,
      sessionId: this.config.sessionId,
      mode: this.config.mode,
      capitalUsd: poolStatus.availableUsd,
      userId: this.config.userId || undefined,
    });
    
    // Charger les positions existantes depuis la DB
    await this.exchangeSync.loadExistingPosition();
    
    // 🔄 LIVE MODE: Sync with exchange to catch any missed stop losses
    if (this.config.mode === 'live') {
      await this.exchangeSync.syncWithExchange();
    }

    // Live mode: if we start with an existing position, enable realtime WS-based exits.
    this.startRealtimeExitMonitorIfNeeded();
    
    // V5.39: SYNCHRONIZED TICK - All agents tick at the same wall-clock times
    // This ensures all agents detect new candles simultaneously, so signals
    // arrive in the same batch window for the signal ranker.
    // 
    // Strategy: Align to 15-second boundaries (:00, :15, :30, :45 of each minute)
    // All agents will tick at exactly the same moments regardless of when they started.
    const TICK_INTERVAL_MS = 15_000;
    const now = Date.now();
    const nextBoundary = Math.ceil(now / TICK_INTERVAL_MS) * TICK_INTERVAL_MS;
    const delayToNextBoundary = nextBoundary - now;
    
    // V5.39: Add small jitter (0-500ms) to spread load across many agents
    // This prevents CPU/DB spikes when 1000+ agents tick at exact same moment
    // 500ms jitter is small enough that all agents still process the same candle
    // but large enough to spread the load smoothly
    const jitterMs = Math.floor(Math.random() * 500);
    
    // Premier tick immédiat pour initialiser l'état
    await this.tick();
    
    // Démarrer l'interval ALIGNÉ sur la prochaine borne de 15 secondes + jitter
    // Agents tickeront ensemble (±500ms): 12:00:00-12:00:00.5, 12:00:15-12:00:15.5, etc.
    this.tickAlignTimeoutId = setTimeout(() => {
      this.tickAlignTimeoutId = null;
      if (!this.running) return;
      void this.tick();
      this.tickIntervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }, delayToNextBoundary + jitterMs);
    
    logger.debug(`⏱️ [${this.config.symbol}] Tick synchronized to next ${TICK_INTERVAL_MS/1000}s boundary in ${delayToNextBoundary}ms (+${jitterMs}ms jitter)`);
    
    // V5.50: Subscribe to WebSocket final kline events for instant candle close detection
    // This reduces detection latency from ~8s (polling) to ~1s (WS event-driven)
    const binanceSymbol = this.config.symbol.split('/')[0] + 'USDT';
    try {
      const ws = getBinanceWebSocket();
      this.finalKlineUnsubscribe = ws.onFinalKline((kline: BinanceKlineData) => {
        // Only trigger for our symbol and 15m timeframe
        if (kline.symbol === binanceSymbol && kline.timeframe === '15m') {
          // Trigger immediate tick (but don't await - fire and forget)
          void this.tick();
        }
      });
      logger.debug(`⚡ [${this.config.symbol}] Subscribed to instant candle close events`);
    } catch (error) {
      logger.warn(`⚠️ [${this.config.symbol}] Failed to subscribe to instant candle events, using polling`);
    }
    }); // end runWithUserId
  }

  async stop(): Promise<void> {
    return runWithUserId(this.config.userId, async () => {
    this.running = false;

    // V5.50: Unsubscribe from final kline events
    if (this.finalKlineUnsubscribe) {
      this.finalKlineUnsubscribe();
      this.finalKlineUnsubscribe = null;
    }

    // V5.39: Clear alignment timeout if still pending
    if (this.tickAlignTimeoutId) {
      clearTimeout(this.tickAlignTimeoutId);
      this.tickAlignTimeoutId = null;
    }

    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }

    this.stopRealtimeExitMonitor();

    // V5.22: Remove any pending signal for this agent from ranker
    globalSignalRanker.removeSignal(this.config.symbol, this.config.mode, this.config.userId);

    // 📢 NOTIFICATION: Agent stopped
    notifyAgentStopped({
      symbol: this.config.symbol,
      sessionId: this.config.sessionId,
      mode: this.config.mode,
      reason: 'Manual stop',
      userId: this.config.userId || undefined,
    });

    logger.info(`⏹️ [${this.config.symbol}] STOPPED`);
    }); // end runWithUserId
  }

  // ==========================================================================
  // REALTIME (WS) EXIT MONITOR - Delegated to RealtimeExitHandler
  // ==========================================================================

  private startRealtimeExitMonitorIfNeeded(): void {
    this.rtExitHandler.startIfNeeded();
  }

  private stopRealtimeExitMonitor(): void {
    this.rtExitHandler.stop();
  }
  
  // ==========================================================================
  // PUBLIC SETTERS FOR CALLBACKS
  // ==========================================================================
  
  setOnTick(callback: (tick: TickEvent) => void): void {
    this.config.onTick = callback;
  }
  
  // ==========================================================================
  // PUBLIC GETTERS
  // ==========================================================================
  
  getSymbol(): string {
    return this.config.symbol;
  }
  
  getMode(): 'paper' | 'live' {
    return this.config.mode;
  }
  
  getPosition(): Position | null {
    return this.position;
  }
  
  getMarketConditions(): MarketConditions | null {
    return this.lastMarketConditions;
  }
  
  // ==========================================================================
  // MAIN TICK LOOP
  // ==========================================================================
  
  private async tick(): Promise<void> {
    return runWithUserId(this.config.userId, async () => {
    if (!this.running) return;

    // Prevent re-entrancy: skip if a tick is already in progress
    // This prevents stack overflow when tick() takes longer than the interval
    if (this.tickInProgress) {
      logger.warn(`⚠️ [${this.config.symbol}] Tick skipped - previous tick still in progress`);
      return;
    }

    this.tickInProgress = true;

    try {
      const now = new Date();
      const symbol = this.config.symbol;
      this.tickCount = (this.tickCount || 0) + 1;
      this.lastTickAt = Date.now();
      
      // 🔄 LIVE MODE: Sync with exchange first to detect stop loss executions
      if (this.config.mode === 'live') {
        await this.exchangeSync.syncWithExchange();
      }
      
      // Update market conditions: prefer SymbolEngine cache, then BtcDataService, then self-computation
      const engineForConditions = symbolEngineManager.getEngine(this.config.symbol);
      const engineConditions = engineForConditions?.getMarketConditions();
      let newConditions: typeof engineConditions;
      if (engineConditions) {
        newConditions = engineConditions;
      } else {
        const btcService = getBtcDataService();
        if (btcService.isReady()) {
          newConditions = btcService.getMarketConditions() ?? undefined;
        }
        if (!newConditions) {
          const btc15m = await this.candleFetcher.fetchBtcCandles();
          const btcForRegime = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME === '15m'
            ? btc15m
            : (await this.candleFetcher.fetchBtcCandles1h()).filter(c => c.isFinal !== false);
          newConditions = getMarketConditions(btc15m, btcForRegime);
        }
      }
      this.lastMarketConditions = {
        ...newConditions,
        // Preserve marketQuality from checkEntry() if already set
        marketQuality: this.lastMarketConditions?.marketQuality || 'analyzing',
        qualityReason: this.lastMarketConditions?.qualityReason || 'Waiting for signal check...',
      };
      this.config.onMarketConditions?.(this.lastMarketConditions);
      
      // Fetch current candles for price and S/R
      const candles = await this.candleFetcher.fetchCandles();
      const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : this.lastPrice;
      this.lastPrice = currentPrice;
      
      // Calculate basic S/R from recent highs/lows
      const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
      const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
      
      // � Broadcast tick to frontend via callback
      this.config.onTick?.({
        symbol,
        price: currentPrice,
        hasPosition: !!this.position,
        positionSide: this.position?.side,
        support: recentLow,
        resistance: recentHigh,
        tickCount: this.tickCount,
        timestamp: now,
      });

      // V5.79: Update agent state for Telegram heartbeat (every tick)
      const positionInfo = this.position ? {
        side: this.position.side,
        entryPrice: this.position.entryPrice,
        pnlPct: this.position.side === 'long'
          ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
          : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100,
      } : null;
      updateAgentState({
        symbol,
        mode: this.config.mode,
        balance: this.config.capitalPool.getTotalCapital(),
        position: positionInfo,
        lastUpdate: Date.now(),
      });

      // ═══════════════════════════════════════════════════════════════════════════
      // V5.71: Real-time Signal Radar - Calculate proximity on every tick
      // This detects when price approaches signal thresholds and logs only changes
      // ═══════════════════════════════════════════════════════════════════════════
      try {
        // Calculate BB from recent candles (need at least 20)
        if (candles.length >= 20) {
          const closePrices = candles.slice(-20).map(c => c.close);
          const sma = closePrices.reduce((a, b) => a + b, 0) / 20;
          const stdDev = Math.sqrt(closePrices.map(p => (p - sma) ** 2).reduce((a, b) => a + b, 0) / 20);
          const upperBB = sma + 2 * stdDev;
          const lowerBB = sma - 2 * stdDev;
          const bbWidth = upperBB - lowerBB;

          // BB distance: positive = above SMA, negative = below
          const bbDistance = bbWidth > 0 ? ((currentPrice - sma) / (bbWidth / 2)) * 100 : 0;

          // Volume ratio (current vs 20-period average)
          const volumes = candles.slice(-20).map(c => c.volume);
          const avgVolume = volumes.reduce((a, b) => a + b, 0) / 20;
          const currentVolume = candles[candles.length - 1].volume;
          const volRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

          // ROC (rate of change over 14 periods)
          const rocPeriod = Math.min(14, candles.length - 1);
          const rocPrice = candles[candles.length - 1 - rocPeriod]?.close || currentPrice;
          const roc = rocPrice > 0 ? ((currentPrice - rocPrice) / rocPrice) * 100 : 0;

          // Use last known regime from signal features (calculated in checkEntry from BTC data)
          // Skip radar update if regime hasn't been calculated yet to avoid flip-flopping
          // between NEUTRAL (default) and the real regime from another agent (paper/live)
          const currentRegime = this.lastKnownRegime || 'NEUTRAL';

          const radarFeatures: SignalFeatures = {
            roc,
            volRatio,
            bbDistance,
            atrPct: 0,  // Would need ATR calculation, skip for real-time
            trendStrength: 0,
          };

          const proximityScore = calculateProximityScore(radarFeatures, currentRegime, !!this.position);

          // Calculate PnL if in position
          let positionPnlPct: number | undefined;
          if (this.position) {
            positionPnlPct = this.position.side === 'long'
              ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
              : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100;
          }

          // V5.80: Only one agent per symbol updates the radar to prevent paper/live flip-flop
          // Priority: live > paper. Paper only updates if no live agent exists for this symbol.
          const isRadarOwner = this.config.mode === 'live' || !getCapitalPool(this.config.userId, undefined, 'live');
          if (isRadarOwner) {
            updateSymbolState({
              symbol,
              proximityScore,
              regime: currentRegime,
              features: radarFeatures,
              lastUpdate: Date.now(),
              inPosition: !!this.position,
              positionSide: this.position?.side,
              positionPnlPct,
              trailingActive: this.position?.trailingActive,
            });
          }
        }
      } catch (radarError) {
        // Don't let radar errors crash the tick
        logger.debug(`Signal Radar error for ${symbol}:`, radarError);
      }

      // 1. Si on a une position, checker l'exit avec trailing
      if (this.position) {
        // Avoid per-tick spam: checkExit already logs once per newly-closed 15m candle.
        // Keep detailed tick-level traces available via LOG_LEVEL=debug.
        const shortSymbol = symbol.replace('/USDT:USDT', '');
        logger.debug(`🔄 [${shortSymbol}] #${this.tickCount} IN_${this.position.side.toUpperCase()}@$${this.position.entryPrice.toFixed(2)} | $${currentPrice.toFixed(2)} | ${this.config.mode}`);
        await this.checkExit(this.position);
        // Note: If position was closed, the slot is freed via capitalPool.release()
        // Other agents will see the freed slot when they calculate availableSlots
        // in openPosition() AFTER waitForBatch(). No need to checkEntry() here
        // because this agent has a cooldown anyway.
        return;
      }
      
      // 2. Sinon, chercher une entrée (this sets lastRejectReason)
      await this.checkEntry();
      
      // 📋 LOG: One line per newly-closed candle (not per tick)
      // When waiting for the next candle, stay silent.
      if (this.lastRejectReason !== 'waiting_new_candle') {
        const shortSymbol = symbol.replace('/USDT:USDT', '');
        const f = this.lastSignalFeatures;
        // Show key metrics: vol ratio, ROC%, BB distance
        const featuresSummary = f
          ? `vol=${f.volRatio.toFixed(1)}x roc=${f.roc.toFixed(1)}% roc5=${f.roc5.toFixed(1)}% bb=${f.bbDistance > 0 ? '+' : ''}${f.bbDistance.toFixed(1)}%`
          : 'no_data';
        // Simplified reject reason (just the key part)
        const rejectKey = this.lastRejectReason?.split(':')[1]?.split('(')[0] || this.lastRejectReason?.split(':')[0] || '';
        logger.info(`🕵️ [${shortSymbol}] 15m CHECK | $${currentPrice.toFixed(2)} | ${featuresSummary} | ${rejectKey} | ${this.config.mode}`);
      }
      
      this.consecutiveTickErrors = 0;
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Tick error:`, error);
      this.config.onError?.(error as Error);
      this.consecutiveTickErrors++;
      if (this.consecutiveTickErrors >= 5 && Date.now() - this.lastErrorAlertTs > 30 * 60 * 1000) {
        this.lastErrorAlertTs = Date.now();
        notifySystemAlert({
          level: 'error',
          title: `Agent ${this.config.symbol} failing`,
          message: `${this.consecutiveTickErrors} consecutive tick errors.\nLast: ${errMsg(error)}\nMode: ${this.config.mode}`,
        }).catch(() => {});
      }
    } finally {
      // Always release the lock, even if an error occurred
      this.tickInProgress = false;
    }
    }); // end runWithUserId
  }

  // ==========================================================================
  // ENTRY LOGIC
  // ==========================================================================
  
  private async checkEntry(): Promise<void> {
    const symbol = this.config.symbol;
    const shortSymbol = symbol.replace('/USDT:USDT', '');

    try {
      // ═══════════════════════════════════════════════════════════════════════════
      // SymbolEngine Phase 2: Get signal from shared engine instead of computing
      // independently. Falls back to self-computation if engine has no result.
      // ═══════════════════════════════════════════════════════════════════════════

      const engine = symbolEngineManager.getEngine(symbol);
      const engineResult = engine?.getLastSignal() ?? null;

      // Resolve signal data: engine-first, fallback to self-computation
      let signal: ReturnType<typeof checkMomentumSignal>;
      let candles: Candle[];
      let btcCandles: Candle[];
      let currentPrice: number;
      let lastClosedCandleTs: number;
      const now = Date.now();
      const CANDLE_INTERVAL_MS = 15 * 60 * 1000;

      // Always fetch fresh candles for price + stale-signal validation
      const allCandles = await this.candleFetcher.fetchCandles();

      // Validate engine result freshness: candleCloseTs must match actual latest closed candle
      let useEngine = false;
      if (engineResult && engineResult.closedCandles.length >= 61 && allCandles.length > 0) {
        let latestClosedTs = allCandles[allCandles.length - 1].timestamp;
        if (allCandles[allCandles.length - 1].isFinal === false && allCandles.length >= 2) {
          latestClosedTs = allCandles[allCandles.length - 2].timestamp;
        }
        useEngine = engineResult.candleCloseTs === latestClosedTs;
      }

      if (useEngine && engineResult) {
        // ── Engine path: reuse shared signal computation ──
        signal = engineResult.signal;
        candles = engineResult.closedCandles;
        btcCandles = engineResult.btcCandles;
        // Use fresh price from latest candle (engine price can be up to 15s stale)
        currentPrice = allCandles[allCandles.length - 1].close;
        lastClosedCandleTs = engineResult.candleCloseTs;
        this.lastPrice = currentPrice;
      } else {
        // ── Fallback path: compute signal ourselves (startup / no engine) ──
        // allCandles already fetched above for validation
        if (allCandles.length < 61) {
          if (this.tickCount % 10 === 1) {
            logger.info(`⚠️ [${shortSymbol}] Not enough candles (${allCandles.length}/61)`);
          }
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        currentPrice = allCandles[allCandles.length - 1].close;
        this.lastPrice = currentPrice;

        let lastClosedIdx = allCandles.length - 1;
        if (allCandles[lastClosedIdx].isFinal === false) {
          lastClosedIdx = allCandles.length - 2;
        }
        if (lastClosedIdx < 0) {
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        candles = allCandles.slice(0, lastClosedIdx + 1);
        lastClosedCandleTs = candles[candles.length - 1].timestamp;

        // Check same-candle early (before expensive BTC fetch)
        if (lastClosedCandleTs === this.lastProcessedCandleTs) {
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        // Fetch BTC data from BtcDataService (single source of truth)
        const btcService = getBtcDataService();
        if (!btcService.isReady()) {
          if (this.tickCount % 10 === 1) {
            logger.info(`⚠️ [${shortSymbol}] Waiting for BtcDataService to be ready`);
          }
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }
        btcCandles = btcService.getBtcCandles15m();
        const btcCandlesForRegime = btcService.getBtcCandlesForRegime();

        signal = checkMomentumSignal(symbol, candles, btcCandles, {
          nowMs: now,
          btcCandlesRegime: btcCandlesForRegime,
        });
      }

      // ── Common path: new candle detection + per-user logic ──

      // Check if this is the same closed candle we already processed
      if (lastClosedCandleTs === this.lastProcessedCandleTs) {
        this.lastRejectReason = 'waiting_new_candle';
        return;
      }

      // New closed candle! Mark it as processed
      const isFirstCheck = this.lastProcessedCandleTs === 0;
      const candleStartTime = new Date(lastClosedCandleTs).toISOString().slice(11, 19);
      const candleEndTime = new Date(lastClosedCandleTs + CANDLE_INTERVAL_MS).toISOString().slice(11, 19);
      const detectionDelayMs = now - (lastClosedCandleTs + CANDLE_INTERVAL_MS);
      const detectionDelaySec = Math.round(detectionDelayMs / 1000);

      // V5.80: Skip stale candles on restart
      const STALE_CANDLE_THRESHOLD_SEC = 120;
      if (isFirstCheck && detectionDelaySec > STALE_CANDLE_THRESHOLD_SEC) {
        logger.info(`⏭️ [${shortSymbol}] Skipping stale candle on startup [${candleStartTime}-${candleEndTime} UTC] | Detected +${detectionDelaySec}s (>${STALE_CANDLE_THRESHOLD_SEC}s threshold)`);
        this.lastProcessedCandleTs = lastClosedCandleTs;
        return;
      }

      if (!isFirstCheck) {
        const closedCandle = candles[candles.length - 1];
        const candleColor = closedCandle.close > closedCandle.open ? '🟢' : '🔴';
        const candleChange = ((closedCandle.close - closedCandle.open) / closedCandle.open * 100).toFixed(2);
        const changeNum = parseFloat(candleChange);
        logger.info(`🕯️ [${shortSymbol}] New 15m candle CLOSED [${candleStartTime}-${candleEndTime} UTC] ${candleColor} | $${closedCandle.close.toFixed(2)} (${changeNum > 0 ? '+' : ''}${candleChange}%) | Detected +${detectionDelaySec}s`);
      }

      this.lastProcessedCandleTs = lastClosedCandleTs;

      // Backtest parity: decrement cooldown once per CLOSED candle.
      if (this.entryCooldownBarsRemaining > 0) {
        this.entryCooldownBarsRemaining--;
      }
      if (this.entryCooldownBarsRemaining > 0) {
        this.lastRejectReason = `cooldown_${this.entryCooldownBarsRemaining}bars`;
        return;
      }

      // Process signal features (regime, radar, market quality)
      const f = signal.features;
      if (f) {
        // 📢 NOTIFICATION: Regime change (detect BTC crossing SMA200)
        if (shortSymbol === 'BTC' || shortSymbol === 'ADA') {
          const btcPrice = btcCandles[btcCandles.length - 1]?.close || 0;
          const estimatedSma200 = f.btcInBullRegime ? btcPrice * 0.99 : btcPrice * 1.01;
          notifyRegimeChange({
            newRegime: f.btcInBullRegime ? 'bull' : 'bear',
            btcPrice,
            sma200: estimatedSma200,
            userId: this.config.userId || undefined,
          });
        }

        // V5.5: Store features for market quality assessment
        const bbDistance = f.btcInBullRegime
          ? ((currentPrice - (f.bbUpper || currentPrice)) / currentPrice) * 100
          : (((f.bbLower || currentPrice) - currentPrice) / currentPrice) * 100;

        this.lastSignalFeatures = {
          volRatio: f.volRatio,
          roc: f.roc || 0,
          roc5: f.roc5 || 0,
          bbDistance,
          reason: signal.reason || '',
        };

        // Update market quality in conditions
        if (this.lastMarketConditions) {
          const isLowVolume = f.volRatio < 1.5;
          const isNearBB = Math.abs(bbDistance) < 0.5;
          const isConsolidating = isLowVolume && isNearBB;

          this.lastMarketConditions = {
            ...this.lastMarketConditions,
            marketQuality: isConsolidating ? 'consolidation' : 'momentum',
            qualityReason: isConsolidating
              ? `Low vol (${f.volRatio.toFixed(1)}x) + price near BB (${bbDistance.toFixed(2)}%)`
              : `Vol ${f.volRatio.toFixed(1)}x, BB dist ${bbDistance.toFixed(2)}%`,
          };
          this.config.onMarketConditions?.(this.lastMarketConditions);
        }

        // V5.71: Update Signal Radar with current state
        const radarFeatures: SignalFeatures = {
          roc: f.roc || 0,
          volRatio: f.volRatio,
          bbDistance,
          atrPct: 0,
          trendStrength: 0,
        };
        const currentRegime = f.btcInBullRegime ? 'BULL' : (f.btcInBearRegime ? 'BEAR' : 'NEUTRAL');
        this.lastKnownRegime = currentRegime;
        const proximityScore = calculateProximityScore(radarFeatures, currentRegime, !!this.position);

        let positionPnlPct: number | undefined;
        if (this.position) {
          positionPnlPct = this.position.side === 'long'
            ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
            : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100;
        }

        const isRadarOwnerEntry = this.config.mode === 'live' || !getCapitalPool(this.config.userId, undefined, 'live');
        if (isRadarOwnerEntry) {
          updateSymbolState({
            symbol,
            proximityScore,
            regime: currentRegime,
            features: radarFeatures,
            lastUpdate: Date.now(),
            inPosition: !!this.position,
            positionSide: this.position?.side,
            positionPnlPct,
            trailingActive: this.position?.trailingActive,
          });
        }
      }

      if (signal.valid && signal.side) {
        const btcPrice = btcCandles[btcCandles.length - 1]?.close || 0;
        const btcRegime = signal.features?.btcInBullRegime ? 'BULL' : (signal.features?.btcInBearRegime ? 'BEAR' : 'NEUTRAL');
        logger.info(`✅ [${shortSymbol}] SIGNAL ${signal.side.toUpperCase()} | $${currentPrice.toFixed(2)} | ${signal.reason} | BTC=${btcPrice.toFixed(0)} regime=${btcRegime} btcCandles=${btcCandles.length}`);

        // Use engine-computed score if available, otherwise calculate
        let qualityScore: number;
        let roc5: number;
        let volumeRatio: number;

        if (engineResult && engineResult.score > 0) {
          qualityScore = engineResult.score;
          roc5 = signal.features?.roc5 ?? 0;
          volumeRatio = signal.features?.volRatio ?? 1;
        } else {
          const closes = candles.map(c => c.close);
          const volumes = candles.map(c => c.volume);
          roc5 = calcROC(closes, 5);
          volumeRatio = calcVolRatio(volumes);
          const bbPosition = calcBBPosition(candles, 20, 2);
          const atrRaw = calcATR(candles, 14) ?? 0;
          const atrPct = atrRaw ? (atrRaw / currentPrice) * 100 : 0;
          const trendStrength = calcTrendStrength(closes, 50);

          qualityScore = globalSignalRanker.calculateScore({
            roc5,
            volumeRatio,
            bbPosition,
            atrPct,
            trendStrength,
            side: signal.side,
          });
        }

        logger.info(`📊 [${shortSymbol}] Signal Quality Score: ${qualityScore.toFixed(2)} | ${engineResult ? 'via SymbolEngine' : 'self-computed'}`);

        // V5.22: Add signal to global ranker for prioritization
        globalSignalRanker.addSignal({
          symbol,
          side: signal.side,
          score: qualityScore,
          price: currentPrice,
          timestamp: Date.now(),
          roc5,
          volumeRatio,
          reason: signal.reason || 'momentum_signal',
          tier: getSignalTier(symbol),
          mode: this.config.mode,
          userId: this.config.userId,
        });

        notifySignalDetected({
          symbol,
          side: signal.side,
          price: currentPrice,
          reason: signal.reason || 'momentum_signal',
          mode: this.config.mode,
          userId: this.config.userId || undefined,
        });

        this.currentBias = signal.side;
        this.lastSignal = {
          entryZone: [
            currentPrice * (signal.side === 'long' ? 0.998 : 1.002),
            currentPrice * (signal.side === 'long' ? 1.002 : 0.998),
          ],
          stopDistance: currentPrice * MomentumConfig.EXIT.STOP_LOSS_PCT / 100,
          targets: [
            currentPrice * (signal.side === 'long' ? 1.01 : 0.99),
            currentPrice * (signal.side === 'long' ? 1.02 : 0.98),
            currentPrice * (signal.side === 'long' ? 1.03 : 0.97),
          ],
          targetPcts: [1, 2, 3],
        };

        this.config.onSignal?.({
          symbol,
          side: signal.side,
          reason: signal.reason || 'momentum_signal',
          timestamp: new Date(),
        });

        logger.info(`⏳ [${shortSymbol}] Waiting for signal ranking batch...`);
        await globalSignalRanker.waitForBatch(this.config.mode, this.config.userId);

        this.lastRejectReason = '';
        await this.openPosition(signal.side, candles);
      } else {
        this.lastRejectReason = signal.reason || 'no_signal';

        const rejectReason = signal.reason || 'no_signal';
        if (f && !rejectReason.startsWith('waiting_') && !rejectReason.startsWith('cooldown')) {
          const regime = f.btcInBullRegime ? 'BULL' : (f.btcInBearRegime ? 'BEAR' : 'NEUTRAL');
          const bbDistance = f.btcInBullRegime
            ? ((currentPrice - (f.bbUpper || currentPrice)) / currentPrice) * 100
            : (((f.bbLower || currentPrice) - currentPrice) / currentPrice) * 100;
          const radarFeatures: SignalFeatures = {
            roc: f.roc || 0,
            volRatio: f.volRatio,
            bbDistance,
            atrPct: 0,
            trendStrength: 0,
          };
          const score = calculateProximityScore(radarFeatures, regime, !!this.position);
          const estimatedSide: 'long' | 'short' = regime === 'BULL' ? 'long' : 'short';
          trackRejectedSignal({
            timestamp: Date.now(),
            symbol,
            side: estimatedSide,
            score: Math.round(score),
            reason: rejectReason,
            price: currentPrice,
          });
        }
      }

    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking entry:`, error);
    }
  }
  
  private async openPosition(side: 'long' | 'short', candles: Candle[]): Promise<void> {
    const result = await this.positionOpener.open(side, candles);
    if (result.position) {
      this.position = result.position;
      this.additionalPositions = result.additionalPositions;
      this.closingPosition = false;
      if (result.lastProcessedExitCandleTs !== null) {
        this.lastProcessedExitCandleTs = result.lastProcessedExitCandleTs;
      }
    }
  }

  
  // ==========================================================================
  // EXIT LOGIC WITH TRAILING STOP
  // ==========================================================================
  
  private async checkExit(position: Position): Promise<void> {
    const symbol = this.config.symbol;
    
    try {
      const allCandles = await this.candleFetcher.fetchCandles();
      if (allCandles.length === 0) return;

      // V5.50 FIX: Use isFinal flag from WebSocket instead of time-based heuristic
      let lastClosedIdx = allCandles.length - 1;
      const lastCandle = allCandles[lastClosedIdx];
      if (lastCandle.isFinal === false) {
        lastClosedIdx = allCandles.length - 2;
      }
      if (lastClosedIdx < 0) {
        return;
      }
      const candles = allCandles.slice(0, lastClosedIdx + 1);
      const latestClosedCandle = candles[candles.length - 1];

      // BTC data from BtcDataService (single source of truth, already filtered to closed)
      const btcService = getBtcDataService();
      const btcCandles = btcService.getBtcCandles15m();
      const btcCandlesRegime = btcService.getBtcCandlesForRegime();

      // Only process exit once per newly-closed candle.
      if (latestClosedCandle.timestamp === this.lastProcessedExitCandleTs) {
        return;
      }

      // V5.80: Detect stale candle on restart - use close price instead of wick for SL check
      // After redeployment, the first candle may be old (detected +600s). The wick of that candle
      // could trigger a false SL exit even though price has since recovered. Use close price only.
      const CANDLE_INTERVAL_MS_EXIT = 15 * 60 * 1000;
      const exitDetectionDelayMs = Date.now() - (latestClosedCandle.timestamp + CANDLE_INTERVAL_MS_EXIT);
      const exitDetectionDelaySec = Math.round(exitDetectionDelayMs / 1000);
      const isStaleExitCandle = this.lastProcessedExitCandleTs === 0 && exitDetectionDelaySec > 120;
      if (isStaleExitCandle) {
        logger.info(`⏭️ [${symbol}] Stale candle on startup for exit check (Detected +${exitDetectionDelaySec}s) - using close price instead of wick for SL`);
      }

      // V5.48 FIX: Update HWM for ALL skipped candles, not just the latest!
      // If agent tick was slow and multiple candles closed, we must update HWM
      // with the HIGH of each skipped candle to ensure we don't miss a peak.
      // 
      // This fixes the 9% vs 1.9% trailing capture bug where a candle with
      // a high peak was skipped and its HIGH was never used for the HWM.
      const missedCandlesForHwm: { timestamp: number; high: number; low: number }[] = [];
      if (this.lastProcessedExitCandleTs && this.lastProcessedExitCandleTs > 0) {
        // Find all candles between lastProcessedExitCandleTs and current
        for (const c of candles) {
          if (c.timestamp > this.lastProcessedExitCandleTs && c.timestamp <= latestClosedCandle.timestamp) {
            missedCandlesForHwm.push({ timestamp: c.timestamp, high: c.high, low: c.low });
          }
        }
        
        // Update HWM for each missed candle
        if (missedCandlesForHwm.length > 1) {
          logger.warn(`⚠️ [${symbol}] CATCH-UP: ${missedCandlesForHwm.length} candles since last check - updating HWM for all`);
          for (const missed of missedCandlesForHwm) {
            // Update position HWM with each missed candle's high/low
            if (position.side === 'long') {
              if (!this.position!.highWaterMark || missed.high > this.position!.highWaterMark) {
                this.position!.highWaterMark = missed.high;
                logger.info(`📈 [${symbol}] HWM updated from missed candle: $${missed.high.toFixed(4)} (ts=${new Date(missed.timestamp).toISOString().slice(11, 16)})`);
              }
            } else {
              if (!this.position!.lowWaterMark || missed.low < this.position!.lowWaterMark) {
                this.position!.lowWaterMark = missed.low;
                logger.info(`📉 [${symbol}] LWM updated from missed candle: $${missed.low.toFixed(4)} (ts=${new Date(missed.timestamp).toISOString().slice(11, 16)})`);
              }
            }
          }
        }
      }
      
      this.lastProcessedExitCandleTs = latestClosedCandle.timestamp;

      const currentPrice = latestClosedCandle.close;
      this.lastPrice = currentPrice;
      
      // 🔧 SAFETY CHECK - Ensure position has protection
      // In live mode we require an emergency SL order; exchange trailing is optional.
      if (this.config.mode === 'live' && !position.stopLossOrderId && !position.trailingOrderId) {
        logger.warn(`🚨 [${symbol}] SAFETY: Position has NO PROTECTION! Attempting to re-place orders...`);
        
        // Re-place emergency SL (and trailing only if enabled)
        try {
          await this.setStopLossOnExchange(position, false);
          if (MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) {
            await this.setTrailingStopOnExchange(position, false);
          }
          logger.info(`🛡️ [${symbol}] SAFETY: Re-placed protection orders`);
        } catch (safetyError: any) {
          logger.error(`🚨🚨🚨 [${symbol}] SAFETY: Failed to re-place protection! ${safetyError.message}`);
        }
      }
      
      // Update water marks for trailing stop (this handles the current candle)
      this.position = updatePositionWaterMarks(position, currentPrice, latestClosedCandle.high, latestClosedCandle.low);
      
      // Log position status every tick when in position
      const pnlPct = position.side === 'long'
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      const appTrail = this.position?.appTrailingStop;
      const emergency = this.position?.emergencyStopPrice ?? this.position?.stopLoss;
      logger.info(
        `📊 [${symbol}] POSITION ${position.side.toUpperCase()} | entry=$${position.entryPrice.toFixed(2)} | now=$${currentPrice.toFixed(2)} | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | trail=$${appTrail ? appTrail.toFixed(2) : 'N/A'} | emergencySL=$${emergency ? emergency.toFixed(2) : 'N/A'}`
      );
      
      // 📢 NOTIFICATION: Liquidation warning (check if price is close to liquidation)
      // Liquidation price calculation: 
      // For LONG: liqPrice = entryPrice * (1 - 1/leverage + maintenance_margin_rate)
      // For SHORT: liqPrice = entryPrice * (1 + 1/leverage - maintenance_margin_rate)
      // Simplified: we use ~0.4% maintenance margin for Binance Futures
      const leverage = position.leverage || 4;
      const maintenanceRate = 0.004; // 0.4% maintenance margin
      const liqPrice = position.side === 'long'
        ? position.entryPrice * (1 - 1/leverage + maintenanceRate)
        : position.entryPrice * (1 + 1/leverage - maintenanceRate);
      
      const distanceToLiqPct = position.side === 'long'
        ? ((currentPrice - liqPrice) / currentPrice) * 100
        : ((liqPrice - currentPrice) / currentPrice) * 100;
      
      // Warn if within 5% of liquidation (only in live mode)
      if (this.config.mode === 'live' && distanceToLiqPct <= 5 && distanceToLiqPct > 0) {
        notifyLiquidationWarning({
          symbol,
          side: position.side,
          currentPrice,
          liquidationPrice: liqPrice,
          distancePct: distanceToLiqPct,
          leverage,
          mode: 'live',
          userId: this.config.userId || undefined,
        });
      }
      
      // V5.13: Pass BTC candles for regime detection and symbol candles for momentum reversal
      // V5.46 PARITY FIX: Entry/Exit time alignment with backtest
      // - entryTime = candle.timestamp (same as backtest)
      // - nowMs = calculateExitNowMs(candleTimestamp) = candleTimestamp + 15min
      // - holdMinutes = (nowMs - entryTime) / 60000 = holdBars * 15 (EXACT parity)
      // This ensures trailing stops, stagnant detection, and all time-based exits
      // behave identically between live and backtest.
      // V5.80: On stale candle restart, use close price for high/low to avoid wick-triggered false SL
      const exitHigh = isStaleExitCandle ? currentPrice : latestClosedCandle.high;
      const exitLow = isStaleExitCandle ? currentPrice : latestClosedCandle.low;
      const exitSignal = shouldExitPosition(this.position!, currentPrice, candles, {
        nowMs: calculateExitNowMs(latestClosedCandle.timestamp),
        priceHigh: exitHigh,
        priceLow: exitLow,
        btcCandles: btcCandles,
        btcCandlesRegime: btcCandlesRegime,  // V5.102: 15m candles for regime SMA200
      });

      // 🔍 DEBUG: Log regime change detection for debugging timing issues
      if (exitSignal.shouldExit && exitSignal.reason === 'regime_change') {
        logger.warn(`🚨 [${symbol}] REGIME CHANGE DETECTED on 15m close | candle_ts=${new Date(latestClosedCandle.timestamp).toISOString()} | price=$${currentPrice.toFixed(4)} | PnL=${exitSignal.pnlPct?.toFixed(2)}%`);
      }

      // ════════════════════════════════════════════════════════════════════════
      // V5.81: When stagnant is confirmed, immediately update exchange SL to tightened level
      // This ensures the exchange protects at 0.8% SL instead of the wide 3% emergency.
      // Parity data shows live loses -5% to -11% on stagnant exits vs backtest -4%
      // because the exchange SL was still at the wide emergency level.
      // ════════════════════════════════════════════════════════════════════════
      if (this.position!.stagnantState?.confirmed && !this.position!.stagnantState?.cancelled) {
        if (!this.stagnantSlUpdated) {
          this.stagnantSlUpdated = true;
          const stagnantSlRatio = MomentumConfig.EXIT.STAGNANT_TRADE_TIGHTEN_SL_RATIO ?? 0.5;
          const baseSl = this.position!.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;
          const stagnantSlPct = baseSl * stagnantSlRatio;
          const stagnantSlPrice = this.position!.side === 'long'
            ? this.position!.entryPrice * (1 - stagnantSlPct / 100)
            : this.position!.entryPrice * (1 + stagnantSlPct / 100);

          logger.info(`🔧 [${symbol}] V5.84: Stagnant confirmed — updating exchange SL to ${stagnantSlPct.toFixed(2)}% (${stagnantSlRatio}× base ${baseSl}%) ($${stagnantSlPrice.toFixed(4)})`);

          if (this.position) {
            this.position.stopLoss = stagnantSlPrice;
            this.position.stopLossPct = stagnantSlPct;
          }
          try {
            await this.setStopLossOnExchange(this.position!, true);
          } catch (err: any) {
            logger.warn(`⚠️ [${symbol}] V5.81: Failed to tighten exchange SL for stagnant: ${err.message}`);
          }
        }
      }

      // V5.26: Persist trailing activation - once active, stays active
      if (exitSignal.trailingActivated) {
        // V5.72: Track when trailing first activated
        if (!this.position!.trailingActive) {
          this.rtExitHandler.trailingActivatedAt = Date.now();
        }
        this.position!.trailingActive = true;
      }

      // ════════════════════════════════════════════════════════════════════════
      // V5.62: TRAILING STOP with NFS_ADAPTIVE (aligned with backtest)
      // Uses NFS score to determine exit strategy:
      // - HIGH: Exit at trailing stop price (immediate)
      // - MEDIUM: Exit at candle close with 1-candle confirmation
      // - LOW: Exit at candle close with 2-candle confirmation
      // ════════════════════════════════════════════════════════════════════════
      if (exitSignal.trailingBreached === true) {
        // Initialize breach counter if needed
        if (!this.position!.trailingBreachCandles) {
          this.position!.trailingBreachCandles = 0;
        }

        this.position!.trailingBreachCandles += 1;
        const breachCount = this.position!.trailingBreachCandles;
        const trailingStopPrice = exitSignal.newStopLoss ?? this.position!.appTrailingStop ?? currentPrice;

        // V5.62: NFS_ADAPTIVE on 15m close (backup to 1m realtime monitor)
        const nfsEnabled = MomentumConfig.EXIT.NFS_ENABLED ?? false;
        const nfsAdaptive = MomentumConfig.EXIT.NFS_ADAPTIVE_ENABLED ?? true;

        // V5.86: Check if proactive limit was filled FIRST before doing 15m exit
        // This prevents double-exit when 15m check runs before 1m fill detection
        if (this.rtExitHandler.proactiveLimitOrderId && this.position) {
          logger.info(`[${symbol}] 15m check: proactive LIMIT pending (${this.rtExitHandler.proactiveLimitOrderId}), checking fill status first...`);
          const fillResult = await this.checkProactiveLimitFill(symbol);
          if (fillResult?.filled) {
            const execPx = fillResult.avgPrice;
            this.stopRealtimeExitMonitor();
            logger.info(
              `🎯🎯🎯 [${symbol}] PROACTIVE LIMIT FILLED (detected at 15m check) @ $${execPx.toFixed(4)} | ` +
              `trailing=$${this.rtExitHandler.proactiveLimitPrice?.toFixed(4)} | ` +
              `slippage=0% (exact backtest match!)`
            );
            this.rtExitHandler.proactiveLimitOrderId = null;
            this.rtExitHandler.proactiveLimitPrice = null;
            await this.closePosition(this.position!, execPx, EXIT_TRAIL_PROACTIVE_15M);
            return;
          }
          // If not filled yet, cancel it and proceed with 15m exit logic
          // (price may have gapped through the limit price)
          logger.info(`[${symbol}] Proactive LIMIT not filled yet, cancelling and proceeding with 15m exit...`);
          try {
            await this.cancelProactiveLimit(symbol);
          } catch (e) {
            logger.warn(`[${symbol}] Failed to cancel proactive LIMIT: ${e}`);
          }
        }

        if (nfsEnabled && nfsAdaptive && this.rtExitHandler.getNfsCalculator()) {
          // Calculate NFS score for this breach
          const symbolCandles = await this.candleFetcher.fetchCandles();
          const nfsCandles = symbolCandles.slice(-25).map(c => ({
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume || 0,
            isFinal: true,
          })) as NfsCandle[];

          const currentNfsCandle: NfsCandle = {
            timestamp: latestClosedCandle.timestamp,
            open: latestClosedCandle.open,
            high: latestClosedCandle.high,
            low: latestClosedCandle.low,
            close: latestClosedCandle.close,
            volume: latestClosedCandle.volume || 0,
            isFinal: true,
          };

          const nfsResult = this.rtExitHandler.getNfsCalculator()!.calculate(
            currentNfsCandle,
            nfsCandles.slice(0, -1),
            this.position!.side,
            trailingStopPrice
          );

          // V5.80: Enhanced logging for paper/live parity debugging
          // Log all inputs that could cause NFS score divergence between paper and live
          const hwm = this.position!.side === 'long' ? this.position!.highWaterMark : this.position!.lowWaterMark;
          logger.info(
            `🔴 [${symbol}] 15m TRAILING BREACH | NFS=${nfsResult.score.toFixed(0)} (${nfsResult.confidence}) | ` +
            `breaches=${breachCount} | close=${currentPrice.toFixed(4)} | stop=${trailingStopPrice.toFixed(4)} | ` +
            `hwm=${hwm?.toFixed(4) ?? 'N/A'} | entry=${this.position!.entryPrice.toFixed(4)} | mode=${this.config.mode}`
          );
          // Log NFS components for detailed comparison
          logger.debug(
            `[${symbol}] NFS components: breachATR=${nfsResult.components.breachATRRatio.toFixed(4)} ` +
            `breachDepth=${nfsResult.components.breachDepthPct.toFixed(4)}% ` +
            `vol=${nfsResult.components.volumeRatio.toFixed(2)}x ` +
            `body=${nfsResult.components.candleBodyRatio.toFixed(2)} ` +
            `roc5=${nfsResult.components.momentumROC5.toFixed(4)}%`
          );

          if (nfsResult.shouldExitImmediately) {
            // HIGH confidence: Exit at trailing stop price (target) or candle close (paper realistic)
            // V5.87: Paper uses candle close to simulate market order execution (more realistic)
            // V5.92/V5.134 lesson: trailingStopPrice is a TARGET the system strives for via
            // exhaustion detector + proactive STOP_MARKET. Using currentPrice everywhere destroys
            // the strategy ($86K → -$56 PnL). Paper gets realistic pricing; live/backtest get the target.
            const highExitPrice = this.config.mode === 'paper' ? currentPrice : trailingStopPrice;
            logger.info(`⚡⚡⚡ [${symbol}] 15m NFS HIGH EXIT | exec=${highExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)}, mode=${this.config.mode})`);
            await this.closePosition(this.position!, highExitPrice, EXIT_TRAIL_NFS_HIGH_15M);
            return;
          } else if (nfsResult.confidence === 'MEDIUM' && breachCount >= 1) {
            // V5.137: Paper uses candle close (market order, no exchange orders).
            // Live uses best of trailing/close (proactive STOP_MARKET may fill at trailing).
            const medExitPrice = this.config.mode === 'paper'
              ? currentPrice
              : (this.position!.side === 'long'
                ? Math.max(trailingStopPrice, currentPrice)
                : Math.min(trailingStopPrice, currentPrice));
            logger.info(`⚡⚡ [${symbol}] 15m NFS MEDIUM EXIT | exec=${medExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)}, mode=${this.config.mode})`);
            await this.closePosition(this.position!, medExitPrice, EXIT_TRAIL_NFS_MED_15M);
            return;
          } else if (breachCount >= 2) {
            // V5.137: Same paper realism fix for LOW exits
            const lowExitPrice = this.config.mode === 'paper'
              ? currentPrice
              : (this.position!.side === 'long'
                ? Math.max(trailingStopPrice, currentPrice)
                : Math.min(trailingStopPrice, currentPrice));
            logger.info(`⚡ [${symbol}] 15m NFS LOW EXIT (2-close) | exec=${lowExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)}, mode=${this.config.mode})`);
            await this.closePosition(this.position!, lowExitPrice, EXIT_TRAIL_NFS_LOW_15M);
            return;
          } else {
            // LOW, first breach - wait for confirmation
            logger.warn(`⏳ [${symbol}] 15m NFS LOW (score=${nfsResult.score.toFixed(0)}) - waiting for 2nd close (${breachCount}/2)`);
          }
        } else {
          // Fallback: Standard 2-close confirmation (NFS disabled)
          const REQUIRED_CONFIRMATIONS = 2;
          if (breachCount >= REQUIRED_CONFIRMATIONS) {
            logger.info(`🔴 [${symbol}] TRAILING CONFIRMED (${breachCount}/${REQUIRED_CONFIRMATIONS} closes) | price=$${currentPrice.toFixed(4)} | trailStop=$${trailingStopPrice.toFixed(4)} | PnL=${exitSignal.pnlPct?.toFixed(2)}%`);
            await this.closePosition(this.position!, currentPrice, EXIT_TRAIL);
            return;
          } else {
            logger.warn(`⚠️ [${symbol}] TRAILING BREACH ${breachCount}/${REQUIRED_CONFIRMATIONS} | price=$${currentPrice.toFixed(4)} | trail=$${exitSignal.newStopLoss?.toFixed(4)} | Waiting for confirmation...`);
          }
        }
      } else if (exitSignal.trailingBreached === false) {
        // V5.39 FIX: Explicit reset when trailingBreached is false (wick hit but close recovered)
        // This matches backtest behavior - breach counter resets when close recovers above stop
        if (this.position!.trailingBreachCandles && this.position!.trailingBreachCandles > 0) {
          logger.info(`✅ [${symbol}] Trailing breach CLEARED - wick hit but close recovered above stop`);
        }
        this.position!.trailingBreachCandles = 0;
      } else if (exitSignal.trailingActivated) {
        // trailingBreached is undefined - no wick breach at all, just trailing active
        // Also reset counter to be safe
        if (this.position!.trailingBreachCandles && this.position!.trailingBreachCandles > 0) {
          logger.info(`✅ [${symbol}] Trailing breach CLEARED - price recovered above stop`);
        }
        this.position!.trailingBreachCandles = 0;
      }

      // Emergency profit-protection (exchange-side): ratchet stop only after +2% PnL.
      // This is NOT the primary exit; trailing/app logic remains the priority.
      await this.updateEmergencyStopProfitProtectionIfNeeded(currentPrice, pnlPct);

      // ════════════════════════════════════════════════════════════════════════
      // V5.136: Paper crash safety simulation
      // In paper mode, simulate the crash safety STOP that live places on exchange.
      // Check if candle wick breached crash safety price (3% below trailing).
      // ════════════════════════════════════════════════════════════════════════
      if (this.config.mode === 'paper' && this.position?.trailingActive && this.position?.appTrailingStop) {
        const crashEnabled = (MomentumConfig.EXIT as any).CRASH_SAFETY_STOP_ENABLED ?? false;
        if (crashEnabled) {
          const crashDistPct = (MomentumConfig.EXIT as any).CRASH_SAFETY_DISTANCE_PCT ?? 3.0;
          const crashPrice = this.position.side === 'long'
            ? this.position.appTrailingStop * (1 - crashDistPct / 100)
            : this.position.appTrailingStop * (1 + crashDistPct / 100);
          const breached = this.position.side === 'long'
            ? latestClosedCandle.low <= crashPrice
            : latestClosedCandle.high >= crashPrice;
          if (breached) {
            logger.warn(`🚨🚨🚨 [${symbol}] PAPER CRASH SAFETY triggered | crashPrice=$${crashPrice.toFixed(4)} | trail=$${this.position.appTrailingStop.toFixed(4)} | low=$${latestClosedCandle.low.toFixed(4)}`);
            await this.closePosition(this.position, crashPrice, EXIT_TRAIL_CRASH_SAFETY);
            return;
          }
        }
      }

      if (exitSignal.shouldExit) {
        // ════════════════════════════════════════════════════════════════════════
        // V5.81 PARITY FIX: Use SL price for SL/stagnant exits (matching backtest)
        // ════════════════════════════════════════════════════════════════════════
        // Backtest exits at the exact SL price (entry × (1 ± slPct/100)).
        // Live was exiting at candle close price, which can be significantly worse
        // when the SL is breached mid-candle (parity data shows -3% to -7% gap).
        // Fix: For SL-type exits, compute the theoretical SL price and use it.
        let exitPrice = currentPrice;
        if (exitSignal.reason === 'stoploss' || exitSignal.reason === 'stagnant_trade') {
          const effectiveSlPct = exitSignal.effectiveSlPct ?? this.position!.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;
          const slExitPrice = this.position!.side === 'long'
            ? this.position!.entryPrice * (1 - effectiveSlPct / 100)
            : this.position!.entryPrice * (1 + effectiveSlPct / 100);
          // Use SL price if it's better (closer to entry) than current price,
          // otherwise use current price (market may have recovered slightly)
          if (this.position!.side === 'long') {
            exitPrice = Math.max(slExitPrice, currentPrice); // Best of SL or current
          } else {
            exitPrice = Math.min(slExitPrice, currentPrice); // Best of SL or current
          }
          logger.info(`🎯 [${symbol}] V5.81: Using SL exit price $${exitPrice.toFixed(4)} (SL=$${slExitPrice.toFixed(4)}, close=$${currentPrice.toFixed(4)}, slPct=${effectiveSlPct.toFixed(1)}%)`);
        }
        logger.info(`🔴 [${symbol}] EXIT SIGNAL: reason=${exitSignal.reason} | PnL=${exitSignal.pnlPct?.toFixed(2)}% | holdMin=${exitSignal.holdMinutes?.toFixed(0)}`);
        await this.closePosition(this.position!, exitPrice, EXIT_SIGNAL_REASON_MAP[exitSignal.reason ?? ''] ?? toCanonical(exitSignal.reason ?? 'unknown'));
      } else if (exitSignal.newStopLoss && exitSignal.newStopLoss !== this.position?.appTrailingStop) {
        // Update app trailing stop price
        this.position!.appTrailingStop = exitSignal.newStopLoss;
        
        // 📢 NOTIFICATION: Trailing stop activated (only notify once)
        if (!this.trailingNotified && exitSignal.pnlPct && exitSignal.pnlPct >= 1) {
          this.trailingNotified = true;
          notifyTrailingActivated({
            symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            currentPrice,
            trailPrice: exitSignal.newStopLoss,
            pnlPct: exitSignal.pnlPct,
            mode: this.config.mode,
            userId: this.config.userId || undefined,
          });
        }
        
        // V5.12: SMART TRAILING - Widen callback when profit reaches 2%
        // This lets winners run while protecting early gains
        const widenThreshold = MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT; // 2%
        if (!this.trailingWidened && exitSignal.pnlPct && exitSignal.pnlPct >= widenThreshold) {
          this.trailingWidened = true;
          logger.info(`📈 [${symbol}] Profit +${exitSignal.pnlPct.toFixed(1)}% >= ${widenThreshold}% - WIDENING trailing callback`);
          
          if (this.config.mode === 'live' && this.position) {
            try {
              // Cancel existing trailing and re-place with wider callback
              await this.cancelAllOrdersOnExchange();
              await this.setTrailingStopOnExchange(this.position, true); // true = isWidening
              // Note: setTrailingStopOnExchange now has built-in fallback to STOP_MARKET if trailing fails
              logger.info(`🎯 [${symbol}] Trailing WIDENED: callback now ${MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT}%`);
            } catch (error: unknown) {
              // Error already handled by setTrailingStopOnExchange fallback
              logger.warn(`⚠️ [${symbol}] Failed to widen trailing: ${errMsg(error)}`);
            }
          }
        }
        
        // Update trailing stop on exchange (live mode) or just log (paper mode)
        await this.updateTrailingStopOnExchange(exitSignal.newStopLoss);
      }
      
      // Check for long hold warning (> 24h)
      const holdHours = exitSignal.holdMinutes ? exitSignal.holdMinutes / 60 : 0;
      if (holdHours >= 24) {
        notifyLongHold({
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          currentPrice,
          holdDurationHours: holdHours,
          pnlPct: pnlPct,
          sessionId: this.config.sessionId,
          mode: this.config.mode,
          userId: this.config.userId || undefined,
        });
      }
      
      // V5.39: Periodically save position state to DB (every check)
      // This ensures HWM, maxPnl, trailing state survive restarts
      await this.updatePositionStateInDb();
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking exit:`, error);
    }
  }
  
  
  // Position close logic extracted to agent/positionCloser.ts (V5.108 Phase 4)
  private async closePosition(
    position: Position,
    currentPrice: number,
    reason: ExitReason | string
  ): Promise<void> {
    return this.positionCloser.closePosition(position, currentPrice, reason);
  }
  
  
  // ==========================================================================
  // EXCHANGE HELPERS
  // ==========================================================================
  
  private formatQtyForExchange(symbol: string, qty: number): number {
    return this.orderManager.formatQtyForExchange(symbol, qty);
  }
  

  // Candle fetching extracted to agent/candleFetcher.ts


  /**
   * Cancel ALL orders on exchange (both regular AND algo orders)
   * This is a helper that calls cancelAllOrders twice - once for regular, once for algo
   */
  // ═══════════════════════════════════════════════════════════════════════
  // V5.82: PROACTIVE LIMIT ORDER HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private async placeProactiveLimit(
    symbol: string, orderSide: 'buy' | 'sell', qty: number, price: number,
  ): Promise<string | null> {
    return this.orderManager.placeProactiveLimit(symbol, orderSide, qty, price);
  }

  private async cancelProactiveLimit(symbol: string): Promise<void> {
    await this.orderManager.cancelProactiveLimit(symbol, this.rtExitHandler.getNfsStateMachine());
    this.rtExitHandler.proactiveLimitOrderId = null;
    this.rtExitHandler.proactiveLimitPrice = null;
  }

  private async checkProactiveLimitFill(symbol: string): Promise<{ filled: boolean; avgPrice: number } | null> {
    // Sync proactive limit state to orderManager before checking
    this.orderManager.proactiveLimitOrderId = this.rtExitHandler.proactiveLimitOrderId;
    this.orderManager.proactiveLimitPrice = this.rtExitHandler.proactiveLimitPrice;
    return this.orderManager.checkProactiveLimitFill(symbol, this.position, this.lastPrice);
  }

  private async cancelAllOrdersOnExchange(): Promise<void> {
    await this.orderManager.cancelAllOrdersOnExchange(this.position);
  }

  private async cancelStopLossOnExchange(): Promise<void> {
    await this.orderManager.cancelStopLossOnExchange(this.position);
  }
  
  private async setStopLossOnExchange(position: Position, isUpdate: boolean = false): Promise<void> {
    await this.orderManager.setStopLossOnExchange(position, isUpdate);
  }
  
  /**
   * 🚀 V5.12: SMART Trailing Stop - Starts tight, widens at higher profit
   * 
   * Phase 1 (0.8% → 2%): callback 0.5% (tight protection)
   * Phase 2 (>2%): callback 0.8% (let winner run)
   * 
   * NOTE: Binance doesn't support dynamic callback, so we:
   * 1. Place initial trailing with tight callback (0.5%)
   * 2. When profit reaches 2%, cancel and re-place with wide callback (0.8%)
   * 
   * @returns true if trailing stop was placed successfully, false if fallback to STOP_MARKET was used
   */
  private async setTrailingStopOnExchange(position: Position, isWidening: boolean = false): Promise<boolean> {
    return this.orderManager.setTrailingStopOnExchange(
      position,
      (pos, price, reason) => this.closePosition(pos, price, reason),
      isWidening,
    );
  }
  
  private async updateTrailingStopOnExchange(newStopPrice: number): Promise<void> {
    if (!this.position) return;
    await this.orderManager.updateTrailingStopOnExchange(this.position, newStopPrice);
  }

  private async updateEmergencyStopProfitProtectionIfNeeded(currentPrice: number, pnlPct: number): Promise<void> {
    if (!this.position) return;
    await this.orderManager.updateEmergencyStopProfitProtectionIfNeeded(this.position, currentPrice, pnlPct);
  }

  // ==========================================================================
  // DATABASE HELPERS
  // ==========================================================================
  

  // Exchange sync extracted to agent/exchangeSync.ts

  
  private async savePositionToDb(position: Position, _action: string, entryFeeUsd?: number): Promise<void> {
    await this.persistence.savePositionToDb(position, entryFeeUsd);
  }
  
  private async updatePositionStateInDb(): Promise<void> {
    if (!this.position) return;
    await this.persistence.updatePositionStateInDb(this.position);
  }
  
  private async saveExitToDb(
    position: Position,
    exitPrice: number,
    reason: string,
    pnlPct: number,
    pnlUsd: number,
    exchangeOrderId?: string,
    feeUsd?: number,
  ): Promise<boolean> {
    const result = await this.persistence.saveExitToDb(
      position, exitPrice, reason, pnlPct, pnlUsd, exchangeOrderId, feeUsd,
    );
    if (result.success) {
      // Update SessionKpi (non-critical, outside transaction)
      // Pass null for currentPosition — position was just closed, unrealized should be 0
      await this.persistence.updateSessionKpi(pnlUsd, pnlPct, null, this.lastPrice);
    }
    return result.success;
  }
  
  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  
  getStatus(): { 
    running: boolean; 
    hasPosition: boolean; 
    symbol: string;
    sessionId: string;
    mode: 'paper' | 'live';
    marketConditions: MarketConditions | null;
    capitalPoolStatus: ReturnType<CapitalPool['getStatus']>;
    lastTickAt: number;
    tickCount: number;
  } {
    return {
      running: this.running,
      hasPosition: this.position !== null,
      symbol: this.config.symbol,
      sessionId: this.config.sessionId,
      mode: this.config.mode,
      marketConditions: this.lastMarketConditions,
      capitalPoolStatus: this.config.capitalPool.getStatus(),
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
    };
  }
  
  /**
   * Get detailed agent state for frontend display
   */
  getAgentState(): AgentStateResult {
    return buildAgentState({
      position: this.position,
      lastPrice: this.lastPrice,
      lastSignal: this.lastSignal,
      currentBias: this.currentBias,
      lastExit: this.lastExit,
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
      symbol: this.config.symbol,
      riskPerTradePct: this.config.riskPerTradePct,
      capitalPool: this.config.capitalPool,
      trailingActivatedAt: this.rtExitHandler.trailingActivatedAt,
      trailingUpdateCount: this.rtExitHandler.trailingUpdateCount,
    });
  }
  
  async forceCheck(): Promise<void> {
    await this.tick();
  }
}

// ============================================================================
// FACTORY FUNCTION - Creates 4 agents sharing the same capital pool
// ============================================================================

export async function createSimpleAgent(params: {
  exchange: Exchange;
  prisma: any;
  userId: string;
  sessionId: string;
  symbol: string;
  capitalPool?: CapitalPool;
  mode?: 'paper' | 'live';
}): Promise<AgentOrchestrator> {
  // Use provided pool or get/create pool for this user
  const pool = params.capitalPool || getCapitalPool(params.userId, 10000);
  if (!pool) {
    throw new Error('Capital pool not available');
  }

  const agent = new AgentOrchestrator({
    exchange: params.exchange,
    prisma: params.prisma,
    userId: params.userId,
    sessionId: params.sessionId,
    capitalPool: pool,
    riskPerTradePct: 1,  // 1% risk per trade
    symbol: params.symbol,
    mode: params.mode || 'paper',
  });
  
  return agent;
}

/**
 * Create all 4 agents sharing the same capital pool
 */
export async function createAllAgents(params: {
  exchange: Exchange;
  prisma: any;
  userId: string;
  sessionIds: { btc: string; eth: string; sol: string; xrp: string };
  totalCapitalUsd: number;
  mode?: 'paper' | 'live';
}): Promise<{
  agents: AgentOrchestrator[];
  capitalPool: CapitalPool;
}> {
  // Create shared capital pool for this user
  const capitalPool = resetCapitalPool(params.userId, params.totalCapitalUsd, params.mode);
  
  // 🔧 FIX: Set exchange reference on pool for REST fallback in syncWithExchange (live mode)
  if (params.mode === 'live' && params.exchange) {
    capitalPool.setExchange(params.exchange);
  }
  
  const symbols = MomentumConfig.SYMBOLS;
  const sessionIdMap: Record<string, string> = {
    'BTC/USDT:USDT': params.sessionIds.btc,
    'ETH/USDT:USDT': params.sessionIds.eth,
    'SOL/USDT:USDT': params.sessionIds.sol,
    'XRP/USDT:USDT': params.sessionIds.xrp,
  };
  
  const agents: AgentOrchestrator[] = [];
  
  for (const symbol of symbols) {
    const agent = await createSimpleAgent({
      exchange: params.exchange,
      prisma: params.prisma,
      userId: params.userId,
      sessionId: sessionIdMap[symbol],
      symbol,
      capitalPool,
      mode: params.mode,
    });
    agents.push(agent);
  }
  
  console.log(`[AgentFactory] Created ${agents.length} agents for user ${params.userId} with shared capital pool of $${params.totalCapitalUsd}`);
  
  return { agents, capitalPool };
}
