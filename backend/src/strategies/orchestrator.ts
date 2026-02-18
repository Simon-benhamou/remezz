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
  getCooldownBars,  // V5.41: Shared cooldown logic
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
import { globalSignalRanker } from './signalRanker.js';

import {
  getBinanceWebSocket,
  getPositionFromWebSocket,
  type BinanceKlineData,
} from '../services/binanceWebSocket.js';
import {
  notifyTradeExit,
  notifyOrderError,
  notifyTrailingActivated,
  notifyRegimeChange,
  notifyAgentStarted,
  notifyAgentStopped,
  notifyLongHold,
  notifyLiquidationWarning,
  notifySignalDetected,
} from '../services/notificationService.js';
import { notifyPositionClosed, notifySystemAlert } from '../utils/notifications.js';
import { trackRejectedSignal, recordTrade, updateAgentState } from '../services/telegramReporter.js';
import { orderQueue, type OrderRequest } from '../services/orderQueue.js';
import { calculateOrderPriority, type ExitReason } from '../services/orderPriority.js';
import { v4 as uuidv4 } from 'uuid';
import { CACHE_TTLS, SYNC_INTERVALS } from '../config/constants.js';
import { PositionPersistence } from './positionPersistence.js';
import {
  EXIT_TRAIL, EXIT_TRAIL_NFS_HIGH_15M,
  EXIT_TRAIL_NFS_MED_15M, EXIT_TRAIL_NFS_LOW_15M, EXIT_TRAIL_PROACTIVE_15M,
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

export interface TradeEvent {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  orderId: string;
  timestamp: Date;
}

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
  private exitAttemptCount = 0;
  private lastExitAttemptTs = 0;

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
      fetchBtcCandles: () => this.candleFetcher.fetchBtcCandles(),
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
      fetchBtcCandles: () => this.candleFetcher.fetchBtcCandles(),
      fetchBtcCandles1h: () => this.candleFetcher.fetchBtcCandles1h(),
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
      
      // Update market conditions: prefer SymbolEngine cache, fallback to self-computation
      const engineForConditions = symbolEngineManager.getEngine(this.config.symbol);
      const engineConditions = engineForConditions?.getMarketConditions();
      const newConditions = engineConditions || getMarketConditions(
        (await this.candleFetcher.fetchBtcCandles()),
        (await this.candleFetcher.fetchBtcCandles1h()).filter(c => c.isFinal !== false)
      );
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
          ? `vol=${f.volRatio.toFixed(1)}x roc=${f.roc.toFixed(1)}% bb=${f.bbDistance > 0 ? '+' : ''}${f.bbDistance.toFixed(1)}%`
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

        // Fetch BTC data (only needed in fallback path)
        const allBtcCandles = await this.candleFetcher.fetchBtcCandles();
        const MIN_BTC_CANDLES = 201;
        if (allBtcCandles.length < MIN_BTC_CANDLES) {
          if (this.tickCount % 10 === 1) {
            logger.info(`⚠️ [${shortSymbol}] Waiting for BTC data (${allBtcCandles.length}/${MIN_BTC_CANDLES})`);
          }
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        let btcLastClosedIdx = allBtcCandles.length - 1;
        if (allBtcCandles.length > 0 && allBtcCandles[btcLastClosedIdx].isFinal === false) {
          btcLastClosedIdx = allBtcCandles.length - 2;
        }
        btcCandles = btcLastClosedIdx >= 0 ? allBtcCandles.slice(0, btcLastClosedIdx + 1) : allBtcCandles;

        // V5.102: Use BTC 15m candles for regime (was 1h) — faster regime switches for momentum breakout
        const btcCandlesForRegime = btcCandles;
        const MIN_BTC_REGIME_CANDLES = 201; // Need 200 for SMA200 + 1
        if (btcCandlesForRegime.length < MIN_BTC_REGIME_CANDLES) {
          if (this.tickCount % 10 === 1) {
            logger.info(`⚠️ [${shortSymbol}] Waiting for BTC 15m data (${btcCandlesForRegime.length}/${MIN_BTC_REGIME_CANDLES})`);
          }
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        signal = checkMomentumSignal(symbol, candles, btcCandles, {
          nowMs: now,
          btcCandles1h: btcCandlesForRegime,  // V5.102: 15m candles for regime/MTF
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

      // Fetch BTC candles for regime detection (V5.13)
      const allBtcCandles = await this.candleFetcher.fetchBtcCandles();

      // V5.50 FIX: Use isFinal flag from WebSocket instead of time-based heuristic
      // This ensures live trading detects candle close at the EXACT same moment as backtest
      // Previously: used (now - timestamp < 15min) which caused 15-min delay
      // Now: use isFinal flag directly from Binance WebSocket
      let lastClosedIdx = allCandles.length - 1;
      const lastCandle = allCandles[lastClosedIdx];
      
      // If the last candle is not final (still in progress), use the previous one
      if (lastCandle.isFinal === false) {
        lastClosedIdx = allCandles.length - 2;
      }
      
      if (lastClosedIdx < 0) {
        return;
      }
      
      const candles = allCandles.slice(0, lastClosedIdx + 1);
      const latestClosedCandle = candles[candles.length - 1];
      
      // V5.50 FIX: Use isFinal for BTC candles too (aligned with backtest)
      // This ensures regime detection uses the same closed candle data as backtest
      let lastClosedBtcIdx = allBtcCandles.length - 1;
      if (allBtcCandles.length > 0) {
        const lastBtcCandle = allBtcCandles[lastClosedBtcIdx];
        if (lastBtcCandle.isFinal === false) {
          lastClosedBtcIdx = allBtcCandles.length - 2;
        }
      }
      const btcCandles = lastClosedBtcIdx >= 0 ? allBtcCandles.slice(0, lastClosedBtcIdx + 1) : [];

      // V5.102: Use BTC 15m candles for regime (was 1h — faster regime for momentum breakout)
      const btcCandles1h = btcCandles; // 15m candles used for regime/MTF

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
        btcCandles1h: btcCandles1h,  // V5.102: 15m candles for regime SMA200
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
            // HIGH confidence: Exit at trailing stop price (backtest) or candle close (paper realistic)
            // V5.87: Paper now uses candle close to simulate market order execution (more realistic)
            // Live will place market order anyway, so this just affects paper realism
            // Proactive limit (when it works) will give both paper and live exact trailing price
            const highExitPrice = this.config.mode === 'paper' ? currentPrice : trailingStopPrice;
            logger.info(`⚡⚡⚡ [${symbol}] 15m NFS HIGH EXIT | exec=${highExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)}, mode=${this.config.mode})`);
            await this.closePosition(this.position!, highExitPrice, EXIT_TRAIL_NFS_HIGH_15M);
            return;
          } else if (nfsResult.confidence === 'MEDIUM' && breachCount >= 1) {
            // V5.81 PARITY FIX: Use best of trailing stop price or current price
            // Parity data shows MED exits lose 3-5% vs backtest because candle close
            // is worse than trailing stop price. Use trailing price when it's better.
            const medExitPrice = this.position!.side === 'long'
              ? Math.max(trailingStopPrice, currentPrice)
              : Math.min(trailingStopPrice, currentPrice);
            logger.info(`⚡⚡ [${symbol}] 15m NFS MEDIUM EXIT | exec=${medExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)})`);
            await this.closePosition(this.position!, medExitPrice, EXIT_TRAIL_NFS_MED_15M);
            return;
          } else if (breachCount >= 2) {
            // V5.81: Same fix for LOW - use best of trailing stop or close
            const lowExitPrice = this.position!.side === 'long'
              ? Math.max(trailingStopPrice, currentPrice)
              : Math.min(trailingStopPrice, currentPrice);
            logger.info(`⚡ [${symbol}] 15m NFS LOW EXIT (2-close) | exec=${lowExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)})`);
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
  
  private async closePosition(
    position: Position,
    currentPrice: number,
    reason: ExitReason | string
  ): Promise<void> {
    const symbol = this.config.symbol;

    // Prevent duplicate close attempts and stop realtime monitor before placing orders.
    if (this.closingPosition) {
      logger.debug(`⚠️ [${symbol}] Close already in progress, skipping duplicate close (${reason})`);
      return;
    }

    // V5.105: Guard against exit loop — max 3 attempts per 30s, then force sync
    const now = Date.now();
    if (now - this.lastExitAttemptTs < 30_000) {
      this.exitAttemptCount++;
      if (this.exitAttemptCount > 3) {
        logger.warn(`🔄 [${symbol}] Exceeded 3 exit attempts in 30s — forcing syncWithExchange instead of retrying`);
        this.exitAttemptCount = 0;
        this.lastExitAttemptTs = now;
        await this.exchangeSync.syncWithExchange();
        return;
      }
    } else {
      this.exitAttemptCount = 1;
      this.lastExitAttemptTs = now;
    }

    this.closingPosition = true;
    this.stopRealtimeExitMonitor();

    try {
    
    // Calculate PnL based on side
    let pnlPct: number;
    let pnlUsd: number;
    
    if (position.side === 'long') {
      pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      pnlUsd = position.qty * (currentPrice - position.entryPrice);
    } else {
      pnlPct = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      pnlUsd = position.qty * (position.entryPrice - currentPrice);
    }
    
    const notionalUsd = position.qty * position.entryPrice;
    // V5.6: Use stored margin for capital release, fallback to notional/leverage or notional
    const marginToRelease = position.marginUsd ?? (position.leverage ? notionalUsd / position.leverage : notionalUsd);
    
    logger.info(`🚪 [${symbol}] CLOSING ${position.side.toUpperCase()} | entry=$${position.entryPrice.toFixed(4)} | exit=$${currentPrice.toFixed(4)} | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | reason=${reason}`);
    
    // Reset trailing flags for next position
    this.trailingNotified = false;
    this.trailingWidened = false;
    this.stagnantSlUpdated = false;

    // Reset NFS + proactive limit + trailing tracking state (owned by rtExitHandler)
    this.rtExitHandler.resetState();

    // V5.41: Use shared cooldown logic from momentumSimple.ts
    const cooldownBars = getCooldownBars(reason, this.ENTRY_COOLDOWN_BARS);
    this.entryCooldownBarsRemaining = cooldownBars;
    logger.info(`⏱️ [${symbol}] Cooldown: ${cooldownBars} bars (${cooldownBars * 15}min) - exit reason: ${reason}`);

    // Store exit info for frontend display
    this.lastExit = {
      ts: Date.now(),
      price: currentPrice,
      reason,
    };
    this.currentBias = null;
    this.lastSignal = null;

    if (this.config.mode === 'paper') {
      // Paper close — position nulled AFTER DB save (see below) to prevent orphans on DB failure.
      // closingPosition flag prevents re-entry in the meantime.

      // V5.30: Close additional positions too
      let totalPnlUsd = pnlUsd;
      let totalMarginReleased = marginToRelease;
      
      for (const addPos of this.additionalPositions) {
        let addPnlUsd: number;
        if (addPos.side === 'long') {
          addPnlUsd = addPos.qty * (currentPrice - addPos.entryPrice);
        } else {
          addPnlUsd = addPos.qty * (addPos.entryPrice - currentPrice);
        }
        const addMargin = addPos.marginUsd ?? (addPos.leverage ? (addPos.qty * addPos.entryPrice) / addPos.leverage : addPos.qty * addPos.entryPrice);
        const addPnlPct = addPos.side === 'long'
          ? ((currentPrice - addPos.entryPrice) / addPos.entryPrice) * 100
          : ((addPos.entryPrice - currentPrice) / addPos.entryPrice) * 100;
        
        this.config.capitalPool.release(`${this.config.sessionId}_multi_${addPos.entryIndex}`, addMargin, addPnlUsd);
        totalPnlUsd += addPnlUsd;
        totalMarginReleased += addMargin;
        
        // V5.30: Save additional position as separate trade in DB
        const addNotional = addPos.qty * currentPrice;
        const addFeeUsd = addNotional * 0.0004;
        await this.saveExitToDb(addPos, currentPrice, `${reason}_MULTI${(addPos.entryIndex || 0) + 1}`, addPnlPct, addPnlUsd, undefined, addFeeUsd);
        
        logger.info(`📝 [${symbol}] PAPER MULTI-POS ${(addPos.entryIndex || 0) + 1} CLOSED | PnL=$${addPnlUsd.toFixed(2)}`);
      }
      this.additionalPositions = [];
      
      // Release MARGIN (not notional) with PnL
      this.config.capitalPool.release(this.config.sessionId, marginToRelease, pnlUsd);
      
      // V5.41: Paper mode realistic costs (aligned with backtest for fair comparison)
      // Backtest uses: 0.04% × 2 (entry+exit) + 0.05% × 2 (slippage) + 0.01%/8h (funding)
      const exitNotionalUsd = position.qty * currentPrice;
      const entryNotionalUsd = position.qty * position.entryPrice;
      const tradingFeeEntry = entryNotionalUsd * 0.0004;  // 0.04% on entry
      const tradingFeeExit = exitNotionalUsd * 0.0004;    // 0.04% on exit
      const slippageEntry = entryNotionalUsd * 0.0005;    // 0.05% slippage on entry
      const slippageExit = exitNotionalUsd * 0.0005;      // 0.05% slippage on exit
      
      // Calculate funding: 0.01% per 8h period held
      const holdMinutes = (Date.now() - position.entryTime) / 60000;
      const holdBars = Math.floor(holdMinutes / 15);
      const fundingPeriods = Math.floor(holdBars / 32); // 32 bars = 8 hours
      const fundingFee = fundingPeriods * (entryNotionalUsd * 0.0001); // 0.01% per period
      
      const paperFeeUsd = tradingFeeEntry + tradingFeeExit + slippageEntry + slippageExit + fundingFee;

      // V5.78 FIX: Only send notifications if DB save succeeds
      // This prevents false notifications when position is still open due to DB failure
      const dbSaveSuccess = await this.saveExitToDb(position, currentPrice, reason, pnlPct, totalPnlUsd, undefined, paperFeeUsd);

      if (!dbSaveSuccess) {
        logger.error(`❌ [${symbol}] PAPER close DB save FAILED - position may still exist in DB. Skipping notifications.`);
        // Don't send notification - position might still be open
        return;
      }

      // V5.91: Null position AFTER DB save succeeds — prevents orphan if DB fails
      this.position = null;

      logger.info(`📝 [${symbol}] PAPER CLOSED | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${totalPnlUsd.toFixed(2)}) | margin released=$${totalMarginReleased.toFixed(2)} | costs=$${paperFeeUsd.toFixed(2)}`);

      // 📢 Send Telegram notification for paper exit avec P&L et balance
      // V5.78: Only sent AFTER successful DB save
      const balanceAfterPaper = this.config.capitalPool.getTotalCapital();
      void notifyPositionClosed({
        agentId: this.config.sessionId,
        symbol,
        side: position.side,
        quantity: position.qty,
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        pnl: totalPnlUsd,
        pnlPct: pnlPct,
        reason,
        mode: 'paper',
        balanceAfter: balanceAfterPaper,
        feesUsd: paperFeeUsd,
        userId: this.config.userId,
      });

      // Old notification system (kept for compatibility)
      notifyTradeExit({
        symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        qty: position.qty,
        notionalUsd,
        pnlUsd,
        pnlPct,
        reason,
        mode: 'paper',
        userId: this.config.userId || undefined,
      });

      // V5.63: Record trade result for consecutive loser tracking
      // Winner = positive net PnL after fees (use totalPnlUsd which includes multi-positions)
      const isWinner = (totalPnlUsd - paperFeeUsd) > 0;
      this.config.capitalPool.recordTradeResult(isWinner, symbol);

      // V5.79: Record trade for daily Telegram report
      recordTrade(totalPnlUsd - paperFeeUsd);

    } else {
      // Live close
      try {
        // V5.105: Removed circuit breaker check here (was double-gate bug).
        // The order queue already handles circuit breaker + CRITICAL exit priority.
        // Having both caused a timing bug: agent consumed the 5s rate-limit slot,
        // then the queue's check failed for 5s, blocking all exits.

        // FIRST: Cancel any open SL/TP orders to avoid orphaned orders
        await this.cancelStopLossOnExchange();

        // Format quantity to exchange precision
        const formattedQty = this.formatQtyForExchange(symbol, position.qty);

        // ========================================================================
        // ORDER QUEUE INTEGRATION - Submit exit order via global queue
        // ========================================================================

        // Calculate PnL for priority calculation
        const pnlPct = position.side === 'long'
          ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

        const holdTimeMs = Date.now() - position.entryTime;

        const exitReason = reason as ExitReason;
        const orderRequest: OrderRequest = {
          id: uuidv4(),
          agentId: this.config.sessionId,
          userId: this.config.userId || 'unknown',
          priority: calculateOrderPriority({
            reason: exitReason,
            isEntry: false,
            positionPnlPct: pnlPct,
            positionHoldTimeMs: holdTimeMs,
            positionLeverage: position.leverage,
          }),
          symbol,
          side: position.side === 'long' ? 'sell' : 'buy',
          type: 'market',
          quantity: formattedQty,
          params: { reduceOnly: true },
          isEntry: false,
          reason,
          priorityContext: {
            isEntry: false,
            reason: exitReason,
            positionPnlPct: pnlPct,
            positionHoldTimeMs: holdTimeMs,
          },
          submittedAt: Date.now(),
          retries: 0,
          timeoutMs: 30_000,
        };

        logger.info(
          `[${symbol}] Submitting ${position.side} exit order to queue | ` +
          `reason=${reason} | orderId=${orderRequest.id} | priority=${orderRequest.priority}`
        );

        const result = await orderQueue.submitOrder(orderRequest);

        if (!result.success) {
          // V5.105: Check if position is already closed on exchange (e.g. SL fired)
          const errorStr = (result.error || '').toLowerCase();
          const isAlreadyClosed = errorStr.includes('reduceonly') ||
                                  errorStr.includes('reduce only') ||
                                  errorStr.includes('position side does not match') ||
                                  errorStr.includes('position does not exist');
          if (isAlreadyClosed) {
            logger.warn(`🔄 [${symbol}] Exit order rejected (position already closed on exchange) — triggering syncWithExchange`);
            this.closingPosition = false;
            await this.exchangeSync.syncWithExchange();
            return;
          }

          // Also check WS position cache — if exchange shows no position, don't restart RT monitor
          const wsPos = getPositionFromWebSocket(this.config.userId, symbol);
          if (!wsPos || Math.abs(wsPos.positionAmt) === 0) {
            logger.warn(`🔄 [${symbol}] Exit order failed but WS shows no position — triggering syncWithExchange`);
            this.closingPosition = false;
            await this.exchangeSync.syncWithExchange();
            return;
          }

          logger.error(`[${symbol}] Exit order FAILED: ${result.error} (${result.errorCode})`);
          this.closingPosition = false;
          // Restart RT monitor — close failed, position still needs real-time SL protection
          this.startRealtimeExitMonitorIfNeeded();
          return;
        }

        const order = result.order!;
        const closeSide = position.side === 'long' ? 'sell' : 'buy';
        const exitPrice = order.average || order.price || currentPrice;

        // ═══════════════════════════════════════════════════════════════════════════
        // V5.80: PARTIAL FILL DETECTION AND RETRY (BUG FIX)
        //
        // Previous bug: Compared order.filled against position.qty, but we sent formattedQty.
        // If formattedQty < position.qty (due to floor rounding), the check would pass even
        // when a residual remains. Example:
        //   - position.qty = 10.0025
        //   - formattedQty = 10.002 (after floor)
        //   - order.filled = 10.002 (100% of what we sent)
        //   - Old ratio = 10.002 / 10.0025 = 99.97% > 99% → no retry triggered!
        //   - But 0.0005 residual remains on exchange
        //
        // Fix: Compare against formattedQty AND check for formatting loss separately.
        // ═══════════════════════════════════════════════════════════════════════════
        const filledQty = order.filled ?? 0;

        // Check 1: Did exchange fill what we actually requested?
        const exchangeFillRatio = filledQty / formattedQty;

        // Check 2: Did formatting lose any quantity? (floor rounding residual)
        const formattingLoss = position.qty - formattedQty;
        const hasFormattingResidual = formattingLoss > 0.000001; // Epsilon for float comparison

        if (exchangeFillRatio < 0.99) {
          // Exchange partial fill - retry for unfilled portion of what we sent
          const remainingQty = formattedQty - filledQty;
          logger.warn(
            `⚠️ [${symbol}] EXCHANGE PARTIAL FILL! ` +
            `Sent=${formattedQty} Filled=${filledQty} (${(exchangeFillRatio * 100).toFixed(1)}%) ` +
            `Remaining=${remainingQty.toFixed(6)}`
          );

          // Retry close for remaining amount
          try {
            const retryFormattedQty = this.formatQtyForExchange(symbol, remainingQty);

            // Only retry if remaining qty meets minimum order size
            if (retryFormattedQty > 0) {
              const retryOrderRequest: OrderRequest = {
                id: uuidv4(),
                agentId: this.config.sessionId,
                userId: this.config.userId || 'unknown',
                priority: 95, // CRITICAL priority for cleanup
                symbol,
                side: closeSide,
                type: 'market',
                quantity: retryFormattedQty,
                params: { reduceOnly: true },
                isEntry: false,
                reason: 'partial_fill_cleanup',
                priorityContext: { isEntry: false, reason: 'partial_fill_cleanup' },
                submittedAt: Date.now(),
                retries: 0,
                timeoutMs: 30_000,
              };

              logger.info(`🔄 [${symbol}] Submitting RETRY order for remaining ${retryFormattedQty} qty`);
              const retryResult = await orderQueue.submitOrder(retryOrderRequest);

              if (retryResult.success) {
                logger.info(`✅ [${symbol}] Partial fill cleanup SUCCESS | filled=${retryResult.order?.filled}`);
              } else {
                logger.error(`❌ [${symbol}] Partial fill cleanup FAILED: ${retryResult.error}`);
                // Position may still be partially open - will be caught by syncWithExchange
              }
            } else {
              logger.warn(`⚠️ [${symbol}] Remaining qty ${remainingQty} too small to close (below min order size)`);
            }
          } catch (retryError: any) {
            logger.error(`❌ [${symbol}] Partial fill retry error: ${retryError.message}`);
          }
        }

        // V5.81: Close formatting residual (floor rounding left dust on exchange)
        // Previously this only warned; now we send a second reduceOnly order to fully close.
        if (hasFormattingResidual && exchangeFillRatio >= 0.99) {
          logger.warn(
            `⚠️ [${symbol}] FORMATTING RESIDUAL: position.qty=${position.qty.toFixed(6)} but ` +
            `only sent formattedQty=${formattedQty.toFixed(6)} (residual=${formattingLoss.toFixed(6)}). ` +
            `Sending cleanup order...`
          );

          try {
            const residualQty = this.formatQtyForExchange(symbol, formattingLoss);
            if (residualQty > 0) {
              const residualOrder: OrderRequest = {
                id: uuidv4(),
                agentId: this.config.sessionId,
                userId: this.config.userId || 'unknown',
                priority: 95, // CRITICAL priority for cleanup
                symbol,
                side: closeSide,
                type: 'market',
                quantity: residualQty,
                params: { reduceOnly: true },
                isEntry: false,
                reason: 'formatting_residual_cleanup',
                priorityContext: { isEntry: false, reason: 'formatting_residual_cleanup' },
                submittedAt: Date.now(),
                retries: 0,
                timeoutMs: 30_000,
              };

              logger.info(`🧹 [${symbol}] Submitting residual cleanup order for ${residualQty} qty`);
              const residualResult = await orderQueue.submitOrder(residualOrder);

              if (residualResult.success) {
                logger.info(`✅ [${symbol}] Residual cleanup SUCCESS | filled=${residualResult.order?.filled}`);
              } else {
                logger.error(`❌ [${symbol}] Residual cleanup FAILED: ${residualResult.error}`);
              }
            } else {
              logger.warn(`⚠️ [${symbol}] Residual ${formattingLoss.toFixed(6)} too small to close (below step size)`);
            }
          } catch (residualError: any) {
            logger.error(`❌ [${symbol}] Residual cleanup error: ${residualError.message}`);
          }
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // V5.65: SLIPPAGE VALIDATION FOR EXIT ORDERS
        // ═══════════════════════════════════════════════════════════════════════════
        const expectedExitPrice = currentPrice;
        const exitSlippage = position.side === 'long'
          ? ((expectedExitPrice - exitPrice) / expectedExitPrice) * 100  // Positive = worse for long exit (sold lower)
          : ((exitPrice - expectedExitPrice) / expectedExitPrice) * 100; // Positive = worse for short exit (bought higher)

        const maxExitSlippage = MomentumConfig.EXIT.MAX_EXIT_SLIPPAGE_PCT ?? 2.0;
        const slippageAlertEnabled = MomentumConfig.EXIT.SLIPPAGE_ALERT_ENABLED ?? true;

        if (exitSlippage > maxExitSlippage) {
          logger.warn(
            `⚠️ [${symbol}] HIGH EXIT SLIPPAGE | ` +
            `expected=$${expectedExitPrice.toFixed(4)} | filled=$${exitPrice.toFixed(4)} | ` +
            `slippage=${exitSlippage.toFixed(2)}% (max=${maxExitSlippage}%)`
          );
          // Slippage alert removed from Telegram (V5.79) - log only
        } else if (exitSlippage > 0.1) {
          logger.info(`📊 [${symbol}] Exit slippage: ${exitSlippage.toFixed(3)}%`);
        }

        // Recalculate actual PnL
        let actualPnlPct: number;
        let actualPnlUsd: number;
        if (position.side === 'long') {
          actualPnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
          actualPnlUsd = position.qty * (exitPrice - position.entryPrice);
        } else {
          actualPnlPct = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
          actualPnlUsd = position.qty * (position.entryPrice - exitPrice);
        }
        
        this.position = null;
        
        // V5.30: Close additional positions too (LIVE mode)
        let totalPnlUsd = actualPnlUsd;
        let totalMarginReleased = marginToRelease;
        
        for (const addPos of this.additionalPositions) {
          try {
            // Submit close order for each additional position
            const addFormattedQty = this.formatQtyForExchange(symbol, addPos.qty);
            
            const addOrderRequest: OrderRequest = {
              id: uuidv4(),
              agentId: this.config.sessionId,
              userId: this.config.userId || 'unknown',
              priority: calculateOrderPriority({
                reason: exitReason,
                isEntry: false,
                positionPnlPct: actualPnlPct,
                positionHoldTimeMs: Date.now() - addPos.entryTime,
              }),
              symbol,
              side: addPos.side === 'long' ? 'sell' : 'buy',
              type: 'market',
              quantity: addFormattedQty,
              params: { reduceOnly: true },
              isEntry: false,
              reason: `multi_exit_${(addPos.entryIndex || 0) + 1}`,
              priorityContext: { isEntry: false, reason: exitReason },
              submittedAt: Date.now(),
              retries: 0,
              timeoutMs: 30_000,
            };
            
            const addResult = await orderQueue.submitOrder(addOrderRequest);
            
            if (addResult.success && addResult.order) {
              const addExitPrice = addResult.order.average || addResult.order.price || currentPrice;
              let addPnlUsd: number;
              if (addPos.side === 'long') {
                addPnlUsd = addPos.qty * (addExitPrice - addPos.entryPrice);
              } else {
                addPnlUsd = addPos.qty * (addPos.entryPrice - addExitPrice);
              }
              const addPnlPct = addPos.side === 'long'
                ? ((addExitPrice - addPos.entryPrice) / addPos.entryPrice) * 100
                : ((addPos.entryPrice - addExitPrice) / addPos.entryPrice) * 100;
              const addMargin = addPos.marginUsd ?? 0;
              
              this.config.capitalPool.release(`${this.config.sessionId}_multi_${addPos.entryIndex}`, addMargin, addPnlUsd);
              totalPnlUsd += addPnlUsd;
              totalMarginReleased += addMargin;
              
              // V5.30: Save additional position as separate trade in DB
              const addNotional = addPos.qty * addExitPrice;
              const addFeeUsd = addResult.order.fee?.cost ?? (addNotional * 0.0004);
              await this.saveExitToDb(addPos, addExitPrice, `${reason}_MULTI${(addPos.entryIndex || 0) + 1}`, addPnlPct, addPnlUsd, addResult.order.id, addFeeUsd);
              
              logger.info(`🔴 [${symbol}] LIVE MULTI-POS ${(addPos.entryIndex || 0) + 1} CLOSED @ $${addExitPrice.toFixed(4)} | PnL=$${addPnlUsd.toFixed(2)}`);
            } else {
              logger.error(`❌ [${symbol}] Multi-pos ${(addPos.entryIndex || 0) + 1} close FAILED: ${addResult.error}`);
            }
          } catch (addErr: any) {
            logger.error(`❌ [${symbol}] Multi-pos ${(addPos.entryIndex || 0) + 1} close error:`, addErr?.message);
          }
        }
        this.additionalPositions = [];
        
        // Release margin from our tracking (PnL is passed for logging but NOT added to totalCapitalUsd in live mode)
        this.config.capitalPool.release(this.config.sessionId, marginToRelease, actualPnlUsd);
        
        // 🔧 CRITICAL: Sync with exchange to get the real balance after position close
        // This ensures totalCapitalUsd reflects the actual Binance balance (which includes realized PnL)
        await this.config.capitalPool.syncAfterPositionClose();
        
        // Log the updated capital state
        const newStatus = this.config.capitalPool.getStatus();
        logger.info(`💰 [${symbol}] Capital after close: total=$${newStatus.totalUsd.toFixed(2)} | available=$${newStatus.availableUsd.toFixed(2)} | inPositions=$${newStatus.inPositionsUsd.toFixed(2)}`);
        
        // Extract fee from CCXT order response, fallback to 0.04% calculation
        const exitNotionalUsd = position.qty * exitPrice;
        const liveFeeUsd = order.fee?.cost ?? (exitNotionalUsd * 0.0004);

        // V5.78 FIX: Only send notifications if DB save succeeds
        // Pass the real exchange orderId and fee for proper tracking
        const dbSaveSuccessLive = await this.saveExitToDb(position, exitPrice, reason, actualPnlPct, actualPnlUsd, order.id, liveFeeUsd);

        if (!dbSaveSuccessLive) {
          logger.error(`❌ [${symbol}] LIVE close DB save FAILED - position may still exist in DB. Skipping notifications.`);
          // Don't send notification but position IS closed on exchange
          return;
        }

        logger.info(`🔴 [${symbol}] LIVE CLOSED @ $${exitPrice} | PnL=${actualPnlPct >= 0 ? '+' : ''}${actualPnlPct.toFixed(2)}% ($${actualPnlUsd.toFixed(2)}) | fee=$${liveFeeUsd.toFixed(2)} | margin released=$${marginToRelease.toFixed(2)} | orderId=${order.id}`)

        // 📢 Send Telegram notification for live exit avec tous les détails
        // V5.78: Only sent AFTER successful DB save
        const balanceAfterLive = this.config.capitalPool.getTotalCapital();
        void notifyPositionClosed({
          agentId: this.config.sessionId,
          symbol,
          side: position.side,
          quantity: position.qty,
          entryPrice: position.entryPrice,
          exitPrice,
          pnl: actualPnlUsd,
          pnlPct: actualPnlPct,
          reason,
          mode: 'live',
          balanceAfter: balanceAfterLive,
          feesUsd: liveFeeUsd,
          userId: this.config.userId,
        });

        // Old notification system (kept for compatibility)
        notifyTradeExit({
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          qty: position.qty,
          notionalUsd,
          pnlUsd: actualPnlUsd,
          pnlPct: actualPnlPct,
          reason,
          mode: 'live',
          userId: this.config.userId || undefined,
        });

        // V5.63: Record trade result for consecutive loser tracking
        // Winner = positive net PnL after fees
        const isWinnerLive = (actualPnlUsd - liveFeeUsd) > 0;
        this.config.capitalPool.recordTradeResult(isWinnerLive, symbol);

        // V5.79: Record trade for daily Telegram report
        recordTrade(actualPnlUsd - liveFeeUsd);

        this.config.onTrade?.({
          symbol,
          side: closeSide,
          qty: position.qty,
          price: exitPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error: unknown) {
        logger.error(`❌ [${symbol}] Failed to close live position:`, error);
        
        // 📢 NOTIFICATION: Exit order error (CRITICAL)
        notifyOrderError({
          symbol,
          side: position.side,
          orderType: 'exit',
          error: errMsg(error),
          mode: 'live',
          userId: this.config.userId || undefined,
        });
      }
    }
    } finally {
      this.closingPosition = false;
    }
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
  getAgentState(): {
    pos: (Position & {
      currentPrice?: number;
      pnlPct?: number;
      pnlUsd?: number;
      notionalUsd?: number;
      duration?: number;
      trailDistance?: number;
      // Frontend aliases
      entry?: number;
      leverage?: number;
      openedAt?: number;
      stopPrice?: number;
      stop?: number;
      targets?: number[];
      // V5.72: Trailing state for frontend
      trailingState?: {
        active: boolean;
        activatedAt: number | null;
        updateCount: number;
        currentStopPrice: number | undefined;
        peakPrice: number;
        distanceFromPeak: number;
      };
      // V5.72: Health status for frontend
      healthStatus?: 'progressing' | 'watching' | 'stagnant' | 'at_risk';
      healthReason?: string;
      peakPrice?: number;
      distanceFromPeak?: number;
      stopDistancePct?: number;
    }) | null;
    plan: { 
      bias?: 'long' | 'short' | null; 
      zone?: { from: number; to: number; mid: number } | null;
      stopDistance?: number;
      rPrices?: Array<{ r: number; price: number; pct: number }>;
    } | null;
    exit: { ts: number; price: number; reason: string } | null;
    profile: {
      riskPerTradePct: number;
      dailyLossLimitPct: number;
      maxLeverage: number;
      aggressiveness: string;
      availableUsd: number;
    };
    balance: {
      freeUsd: number;
      totalUsd: number;
    };
    lastTickAt: number;
    tickCount: number;
  } {
    // Calculate live position metrics
    let posWithMetrics: any = null;
    
    if (this.position) {
      const currentPrice = this.lastPrice || this.position.entryPrice;
      const pnlPct = this.position.side === 'long'
        ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
        : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100;
      const pnlUsd = this.position.side === 'long'
        ? this.position.qty * (currentPrice - this.position.entryPrice)
        : this.position.qty * (this.position.entryPrice - currentPrice);
      const notionalUsd = this.position.qty * this.position.entryPrice;
      const duration = Date.now() - this.position.entryTime;
      
      // Trail distance from current price to stop
      const trailDistance = this.position.stopLoss
        ? this.position.side === 'long'
          ? ((currentPrice - this.position.stopLoss) / currentPrice) * 100
          : ((this.position.stopLoss - currentPrice) / currentPrice) * 100
        : 0;
      
      // V5.72: Calculate peak price and distance from peak
      const peakPrice = this.position.side === 'long'
        ? this.position.highWaterMark || this.position.entryPrice
        : this.position.lowWaterMark || this.position.entryPrice;
      const distanceFromPeak = this.position.side === 'long'
        ? peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice) * 100 : 0
        : peakPrice > 0 ? ((currentPrice - peakPrice) / peakPrice) * 100 : 0;

      // V5.72: Calculate health status based on backend state
      const holdMinutes = duration / 60000;
      const minHoldForJudgment = 15; // 15 minutes minimum before judging
      const stopDistancePct = trailDistance;
      const isStagnant = this.position.stagnantState?.confirmed && !this.position.stagnantState?.cancelled;
      const isAtRisk = stopDistancePct < 0.5; // Less than 0.5% from stop

      let healthStatus: 'progressing' | 'watching' | 'stagnant' | 'at_risk' = 'progressing';
      let healthReason = 'Price moving favorably';

      if (holdMinutes < minHoldForJudgment) {
        healthStatus = 'watching';
        healthReason = `Monitoring (${Math.round(holdMinutes)}m / ${minHoldForJudgment}m min)`;
      } else if (isAtRisk) {
        healthStatus = 'at_risk';
        healthReason = `Near stop loss (${stopDistancePct.toFixed(2)}% away)`;
      } else if (isStagnant) {
        healthStatus = 'stagnant';
        healthReason = 'Trade stagnant - not progressing';
      } else if (pnlPct > 0) {
        healthStatus = 'progressing';
        healthReason = `In profit (+${pnlPct.toFixed(2)}%)`;
      }

      // V5.72: Build trailing state object
      const trailingState = {
        active: this.position.trailingActive || false,
        activatedAt: this.rtExitHandler.trailingActivatedAt,
        updateCount: this.rtExitHandler.trailingUpdateCount,
        currentStopPrice: this.position.appTrailingStop || this.position.stopLoss,
        peakPrice,
        distanceFromPeak,
      };

      posWithMetrics = {
        ...this.position,
        // Add entry as alias for frontend compatibility (PositionInfoCard expects 'entry')
        entry: this.position.entryPrice,
        // Add leverage for frontend display
        leverage: MomentumConfig.LEVERAGE[this.position.symbol] || 5,
        // Add openedAt for frontend time-held calculation
        openedAt: this.position.entryTime,
        // Add stopPrice as alias for frontend compatibility
        stopPrice: this.position.appTrailingStop || this.position.stopLoss,
        stop: this.position.appTrailingStop || this.position.stopLoss,
        // Add targets from lastSignal
        targets: this.lastSignal?.targets || [],
        currentPrice,
        pnlPct,
        pnlUsd,
        notionalUsd,
        duration,
        trailDistance,
        // V5.72: Add trailing state for frontend
        trailingState,
        // V5.72: Add health status for frontend
        healthStatus,
        healthReason,
        // V5.72: Add additional context
        peakPrice,
        distanceFromPeak,
        stopDistancePct,
      };
    }
    
    return {
      pos: posWithMetrics,
      plan: this.currentBias ? {
        bias: this.currentBias,
        zone: this.lastSignal?.entryZone ? {
          from: this.lastSignal.entryZone[0],
          to: this.lastSignal.entryZone[1],
          mid: (this.lastSignal.entryZone[0] + this.lastSignal.entryZone[1]) / 2,
        } : null,
        stopDistance: this.lastSignal?.stopDistance,
        rPrices: this.lastSignal?.targets?.map((t, i) => ({
          r: i + 1,
          price: t,
          pct: this.lastSignal?.targetPcts?.[i] || (i + 1) * 0.5,
        })),
      } : null,
      exit: this.lastExit,
      profile: {
        riskPerTradePct: this.config.riskPerTradePct,
        dailyLossLimitPct: 3, // Default
        maxLeverage: MomentumConfig.LEVERAGE[this.config.symbol] || 4,
        aggressiveness: 'reactive', // Default
        availableUsd: this.config.capitalPool.getAvailableCapital(),
      },
      balance: {
        freeUsd: this.config.capitalPool.getAvailableCapital(),
        totalUsd: this.config.capitalPool.getStatus().totalUsd,
      },
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
    };
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
