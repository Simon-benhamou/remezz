/**
 * Simple Agent - Remplace 15,000 lignes de code complexe
 * 
 * Stratégie validée: Vol 5x + BTC MA50 + 6h momentum > 0.75%
 * Performance: 91% mois positifs (10/11)
 * 
 * Features:
 * - Capital Pool partagé entre agents
 * - Trailing Stop intelligent
 * - Support Long ET Short
 * - Market Conditions Status
 */

import { PrismaClient } from '@prisma/client';
import { 
  MomentumConfig, 
  checkMomentumSignal, 
  shouldExitPosition, 
  calculatePositionSize,
  updatePositionWaterMarks,
  getMarketConditions,
  getLiquidityTier,
  calcSafeLeverage,
  calcDynamicStopLoss,  // V5.7: Dynamic SL based on ATR
  LIQUIDATION_CONFIG,
  type Candle,
  type Position,
  type MarketConditions,
} from './momentumSimple.js';
import { createLogger } from '../utils/logger.js';
import { getBinanceWebSocket, getKlinesOhlcvFromWebSocket, seedKlinesFromWebSocket, getBalanceFromWebSocket, getTickerFromWebSocket } from '../services/binanceWebSocket.js';

const logger = createLogger('agent');

// ============================================================================
// GLOBAL BTC CACHE - Shared between all agents to reduce API calls
// ============================================================================
// Uses WebSocket first (0 API weight), falls back to REST with cache

const GLOBAL_BTC_CACHE_TTL_MS = 300_000; // 5 minutes (longer TTL since WS is primary)
let globalBtcCandleCache: { candles: Candle[]; fetchedAt: number } | null = null;
let globalBtcCacheFetchingPromise: Promise<Candle[]> | null = null;
let btcWsSubscribed = false;

// Type for exchange (we avoid importing ccxt directly to reduce bundle size)
type Exchange = {
  fetchOHLCV: (symbol: string, timeframe: string, since?: number, limit?: number) => Promise<number[][]>;
  setLeverage: (leverage: number, symbol: string) => Promise<void>;
  createMarketBuyOrder: (symbol: string, qty: number, params?: Record<string, any>) => Promise<any>;
  createMarketSellOrder: (symbol: string, qty: number, params?: Record<string, any>) => Promise<any>;
  createOrder: (symbol: string, type: string, side: string, qty: number, price?: number, params?: Record<string, any>) => Promise<any>;
  // For live sync
  fetchPositions?: (symbols?: string[]) => Promise<any[]>;
  fetchMyTrades?: (symbol: string, since?: number, limit?: number) => Promise<any[]>;
  cancelOrder?: (orderId: string, symbol: string) => Promise<any>;
  cancelAllOrders?: (symbol: string) => Promise<any>;
  // For quantity precision (CCXT method)
  amountToPrecision?: (symbol: string, amount: number) => string;
  markets?: Record<string, any>;
};

// ============================================================================
// CAPITAL POOL - Shared between all agents
// ============================================================================

export class CapitalPool {
  private totalCapitalUsd: number;
  private reservedByAgent: Map<string, number> = new Map();
  private inPositionByAgent: Map<string, number> = new Map();
  
  // Live mode: sync with real Binance balance
  private mode: 'paper' | 'live';
  private userId: string | null = null;
  private lastBalanceSync: number = 0;
  private readonly BALANCE_SYNC_INTERVAL_MS = 30_000; // Sync every 30s max
  private hasEverSynced: boolean = false; // Track if we've ever successfully synced
  
  constructor(initialCapitalUsd: number, mode: 'paper' | 'live' = 'paper', userId?: string) {
    this.totalCapitalUsd = initialCapitalUsd;
    this.mode = mode;
    this.userId = userId || null;
    // For live mode, mark as not synced until we get real balance
    this.hasEverSynced = mode === 'paper'; // Paper mode doesn't need sync
    console.log(`[CapitalPool] Created ${mode} pool with $${initialCapitalUsd}${mode === 'live' ? ' (will sync with Binance)' : ''}`);
  }
  
  /**
   * Get available capital for new positions
   * In live mode: uses real Binance balance minus our reservations
   */
  getAvailableCapital(): number {
    let reserved = 0;
    let inPosition = 0;
    this.reservedByAgent.forEach(v => reserved += v);
    this.inPositionByAgent.forEach(v => inPosition += v);
    return Math.max(0, this.totalCapitalUsd - reserved - inPosition);
  }
  
  /**
   * Sync total capital with real Binance balance (live mode only)
   * @param force - If true, skip the throttle check and force sync
   * @returns true if sync was successful, false otherwise
   */
  async syncWithExchange(force: boolean = false): Promise<boolean> {
    if (this.mode !== 'live' || !this.userId) return true; // Paper mode always "synced"
    
    const now = Date.now();
    if (!force && now - this.lastBalanceSync < this.BALANCE_SYNC_INTERVAL_MS) {
      return this.hasEverSynced; // Return whether we've ever synced successfully
    }
    
    try {
      const balance = await getBalanceFromWebSocket(this.userId, 'USDT');
      if (balance && balance.total > 0) {
        const oldTotal = this.totalCapitalUsd;
        // Use wallet balance (free + locked/margin)
        this.totalCapitalUsd = balance.total;
        this.lastBalanceSync = now;
        this.hasEverSynced = true;
        
        if (Math.abs(oldTotal - this.totalCapitalUsd) > 0.01) {
          console.log(`[CapitalPool] Live balance synced: $${oldTotal.toFixed(2)} -> $${this.totalCapitalUsd.toFixed(2)}`);
        }
        return true;
      } else {
        console.warn(`[CapitalPool] Balance fetch returned empty or zero - keeping existing: $${this.totalCapitalUsd.toFixed(2)}`);
        return this.hasEverSynced;
      }
    } catch (err) {
      console.warn(`[CapitalPool] Failed to sync balance:`, err);
      return this.hasEverSynced;
    }
  }
  
  /**
   * Check if the pool has ever successfully synced with the exchange
   */
  isSynced(): boolean {
    return this.hasEverSynced;
  }
  
  /**
   * Reserve capital for a potential trade
   */
  reserve(agentId: string, amountUsd: number): boolean {
    const available = this.getAvailableCapital();
    if (amountUsd > available) {
      console.log(`[CapitalPool] Cannot reserve $${amountUsd} for ${agentId}, only $${available.toFixed(2)} available`);
      return false;
    }
    
    const current = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, current + amountUsd);
    console.log(`[CapitalPool] Reserved $${amountUsd.toFixed(2)} for ${agentId} (available: $${(available - amountUsd).toFixed(2)})`);
    return true;
  }
  
  /**
   * Commit reserved capital to a position
   */
  commit(agentId: string, amountUsd: number): void {
    // Move from reserved to in-position
    const reserved = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, Math.max(0, reserved - amountUsd));
    
    const inPos = this.inPositionByAgent.get(agentId) || 0;
    this.inPositionByAgent.set(agentId, inPos + amountUsd);
    console.log(`[CapitalPool] Committed $${amountUsd} for ${agentId}`);
  }
  
  /**
   * Release capital when position is closed
   */
  release(agentId: string, amountUsd: number, pnlUsd: number = 0): void {
    const inPos = this.inPositionByAgent.get(agentId) || 0;
    this.inPositionByAgent.set(agentId, Math.max(0, inPos - amountUsd));
    
    // Add PnL to total capital
    this.totalCapitalUsd += pnlUsd;
    console.log(`[CapitalPool] Released $${amountUsd} for ${agentId}, PnL: $${pnlUsd.toFixed(2)}, Total: $${this.totalCapitalUsd.toFixed(2)}`);
  }
  
  /**
   * Cancel a reservation
   */
  cancelReservation(agentId: string): void {
    this.reservedByAgent.delete(agentId);
  }
  
  /**
   * Get pool status
   */
  getStatus(): {
    totalUsd: number;
    availableUsd: number;
    reservedUsd: number;
    inPositionsUsd: number;
    byAgent: Record<string, { reserved: number; inPosition: number }>;
  } {
    let reservedTotal = 0;
    let inPositionTotal = 0;
    const byAgent: Record<string, { reserved: number; inPosition: number }> = {};
    
    this.reservedByAgent.forEach((v, k) => {
      reservedTotal += v;
      if (!byAgent[k]) byAgent[k] = { reserved: 0, inPosition: 0 };
      byAgent[k].reserved = v;
    });
    
    this.inPositionByAgent.forEach((v, k) => {
      inPositionTotal += v;
      if (!byAgent[k]) byAgent[k] = { reserved: 0, inPosition: 0 };
      byAgent[k].inPosition = v;
    });
    
    return {
      totalUsd: this.totalCapitalUsd,
      availableUsd: this.getAvailableCapital(),
      reservedUsd: reservedTotal,
      inPositionsUsd: inPositionTotal,
      byAgent,
    };
  }
  
  /**
   * Set total capital (used when user updates paper balance)
   */
  setTotalCapital(newTotalUsd: number): void {
    this.totalCapitalUsd = newTotalUsd;
    console.log(`[CapitalPool] Total capital set to $${newTotalUsd}`);
  }
  
  /**
   * Get current mode
   */
  getMode(): 'paper' | 'live' {
    return this.mode;
  }
}

// Per-user capital pools - separate pools for paper and live
const userCapitalPools = new Map<string, CapitalPool>();

/**
 * Get pool key - includes mode to allow paper + live simultaneously
 */
function getPoolKey(userId: string, mode?: 'paper' | 'live'): string {
  return mode ? `${userId}_${mode}` : userId;
}

export function getCapitalPool(userId: string, initialCapital?: number, mode?: 'paper' | 'live'): CapitalPool | null {
  if (!userId) return null;
  
  const key = getPoolKey(userId, mode);
  let pool = userCapitalPools.get(key);
  if (!pool && initialCapital !== undefined) {
    pool = new CapitalPool(initialCapital, mode || 'paper', userId);
    userCapitalPools.set(key, pool);
  }
  return pool || null;
}

export function resetCapitalPool(userId: string, initialCapital: number, mode: 'paper' | 'live' = 'paper'): CapitalPool {
  const key = getPoolKey(userId, mode);
  const pool = new CapitalPool(initialCapital, mode, userId);
  userCapitalPools.set(key, pool);
  console.log(`[CapitalPool] Reset ${mode} pool for user ${userId} with $${initialCapital}`);
  return pool;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface SimpleAgentConfig {
  // Exchange
  exchange: Exchange;
  
  // Database - use any to avoid type conflicts between different prisma versions
  prisma: any;
  
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

export class SimpleAgent {
  private config: SimpleAgentConfig;
  private position: Position | null = null;
  private running = false;
  private tickIntervalId: NodeJS.Timeout | null = null;
  private lastMarketConditions: MarketConditions | null = null;
  private tickCount: number = 0;
  private lastTickAt: number = 0;
  private lastPrice: number = 0;
  
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
  
  // Cache pour éviter trop d'appels API (per-symbol only, BTC is global)
  private candleCache: { candles: Candle[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL_MS = 120_000; // 2 minutes (increased to reduce API calls)
  private wsSubscribed = false; // Track if WebSocket kline subscription is active
  
  // Guard against concurrent tick execution (prevents re-entrancy/recursion)
  private tickInProgress = false;
  
  constructor(config: SimpleAgentConfig) {
    this.config = config;
  }
  
  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================
  
  async start(): Promise<void> {
    if (this.running) {
      logger.info(`⚠️ [${this.config.symbol}] Already running`);
      return;
    }
    
    this.running = true;
    logger.info(`✅ [${this.config.symbol}] STARTED | mode=${this.config.mode} | risk=${this.config.riskPerTradePct}% | capital=$${this.config.capitalPool.getAvailableCapital().toFixed(2)}`);
    
    // Charger les positions existantes depuis la DB
    await this.loadExistingPosition();
    
    // 🔄 LIVE MODE: Initial sync with exchange to catch any missed stop losses
    if (this.config.mode === 'live') {
      logger.info(`🔄 [${this.config.symbol}] Initial exchange sync...`);
      await this.syncWithExchange();
    }
    
    // Tick toutes les minutes
    this.tickIntervalId = setInterval(() => this.tick(), 60_000);
    
    // Premier tick immédiat
    await this.tick();
  }
  
  async stop(): Promise<void> {
    this.running = false;
    
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }
    
    logger.info(`⏹️ [${this.config.symbol}] STOPPED`);
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
      
      // Log every tick to confirm agent is alive
      const positionStatus = this.position 
        ? `IN_${this.position.side.toUpperCase()} @ $${this.position.entryPrice.toFixed(2)}` 
        : 'WATCHING';
      logger.info(`🔄 [${symbol}] Tick #${this.tickCount} | ${positionStatus} | mode=${this.config.mode}`);
      
      // 🔄 LIVE MODE: Sync with exchange first to detect stop loss executions
      if (this.config.mode === 'live') {
        await this.syncWithExchange();
      }
      
      // Fetch BTC candles for market conditions
      const btcCandles = await this.fetchBtcCandles();
      
      // Update and broadcast market conditions
      this.lastMarketConditions = getMarketConditions(btcCandles);
      this.config.onMarketConditions?.(this.lastMarketConditions);
      
      // Log market conditions for decision visibility
      const mc = this.lastMarketConditions;
      logger.info(`📊 [${symbol}] Market: ${mc.overallStatus} | BTC trend=${mc.btcTrend} mom6h=${mc.btcMomentum6h.toFixed(2)}% | Day=${mc.dayOfWeek} trading=${mc.isTradingDay}`);
      
      // Fetch current candles for price and S/R
      const candles = await this.fetchCandles();
      const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : this.lastPrice;
      this.lastPrice = currentPrice;
      
      // Calculate basic S/R from recent highs/lows
      const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
      const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
      
      // 🔔 Broadcast tick to frontend via callback
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
      
      // 1. Si on a une position, checker l'exit avec trailing
      if (this.position) {
        await this.checkExit(this.position);
        return; // Don't look for new entries while in position
      }
      
      // 2. Sinon, chercher une entrée
      await this.checkEntry();
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Tick error:`, error);
      this.config.onError?.(error as Error);
    } finally {
      // Always release the lock, even if an error occurred
      this.tickInProgress = false;
    }
  }
  
  // ==========================================================================
  // ENTRY LOGIC
  // ==========================================================================
  
  private async checkEntry(): Promise<void> {
    const symbol = this.config.symbol;
    
    try {
      // Fetch candles pour le symbol
      const candles = await this.fetchCandles();
      if (candles.length < 60) {
        logger.info(`⚠️ [${symbol}] Not enough candles (${candles.length}/60)`);
        return;
      }
      
      // Store last price for frontend
      const currentPrice = candles[candles.length - 1].close;
      this.lastPrice = currentPrice;
      
      // Fetch BTC candles pour corrélation
      const btcCandles = await this.fetchBtcCandles();
      
      // Check signal (returns side: 'long' or 'short')
      const signal = checkMomentumSignal(symbol, candles, btcCandles);
      
      // Log signal analysis result
      const f = signal.features;
      if (f) {
        logger.info(`🔍 [${symbol}] Signal check @ $${currentPrice.toFixed(2)} | vol=${f.volRatio.toFixed(1)}x | bullish=${f.isBullish} | >MA20=${f.priceAboveMa20} | BTC>MA50=${f.btcAboveMa50} | btcMom=${f.btcMomentum6h.toFixed(2)}% | day=${f.dayOfWeek}`);
        
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
          const isNearBB = Math.abs(bbDistance) < 0.5; // Within 0.5% of BB
          const isConsolidating = isLowVolume && isNearBB;
          
          this.lastMarketConditions = {
            ...this.lastMarketConditions,
            marketQuality: isConsolidating ? 'consolidation' : 'momentum',
            qualityReason: isConsolidating 
              ? `Low vol (${f.volRatio.toFixed(1)}x) + price near BB (${bbDistance.toFixed(2)}%)`
              : `Vol ${f.volRatio.toFixed(1)}x, BB dist ${bbDistance.toFixed(2)}%`,
          };
        }
      }
      
      if (signal.valid && signal.side) {
        logger.info(`✅ [${symbol}] SIGNAL ${signal.side.toUpperCase()} CONFIRMED: ${signal.reason} | confidence=${(signal.confidence || 0).toFixed(2)}`);
        
        // Store signal info for frontend display
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
        
        // Notify
        this.config.onSignal?.({
          symbol,
          side: signal.side,
          reason: signal.reason || 'momentum_signal',
          timestamp: new Date(),
        });
        
        // Execute trade
        await this.openPosition(signal.side, candles);
      } else {
        // Log why signal was rejected
        logger.info(`❌ [${symbol}] No signal: ${signal.reason}`);
      }
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking entry:`, error);
    }
  }
  
  private async openPosition(side: 'long' | 'short', candles: Candle[]): Promise<void> {
    const symbol = this.config.symbol;
    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle.close;
    
    // Sync with exchange balance before checking capital (live mode)
    // For live mode, force sync on first position attempt to ensure we have real balance
    if (this.config.mode === 'live') {
      const forceSync = !this.config.capitalPool.isSynced();
      await this.config.capitalPool.syncWithExchange(forceSync);
      
      // In live mode, don't open positions if we haven't successfully synced with exchange
      if (!this.config.capitalPool.isSynced()) {
        logger.error(`❌ [${symbol}] Cannot open live position - failed to sync with exchange balance. Please check API connection.`);
        return;
      }
    }
    
    // Get available capital from pool
    const availableCapital = this.config.capitalPool.getAvailableCapital();
    
    // Log available capital for debugging
    logger.info(`💰 [${symbol}] Available capital: $${availableCapital.toFixed(2)} | mode=${this.config.mode} | synced=${this.config.capitalPool.isSynced()}`);
    
    // V5.5: Get 24h volume for liquidity-aware position sizing
    let volume24h: number | undefined;
    try {
      const wsTicker = await getTickerFromWebSocket(symbol);
      volume24h = wsTicker?.quoteVolume || undefined;
      if (volume24h) {
        const tier = getLiquidityTier(symbol);
        logger.info(`📊 [${symbol}] 24h Volume: $${(volume24h / 1_000_000).toFixed(1)}M | Liquidity Tier: ${tier}`);
      }
    } catch (e) {
      logger.warn(`⚠️ [${symbol}] Could not fetch 24h volume for sizing - using tier-based caps`);
    }
    
    // V5.6: Calculate safe leverage based on ATR volatility
    const baseLeverage = MomentumConfig.LEVERAGE[symbol] || 4;
    const leverageCalc = calcSafeLeverage(candles, baseLeverage);
    
    if (leverageCalc.wasReduced) {
      logger.warn(`⚡ [${symbol}] HIGH VOLATILITY DETECTED! ATR=${leverageCalc.atrPct?.toFixed(2)}% > ${LIQUIDATION_CONFIG.HIGH_VOLATILITY_ATR_PCT}% threshold | Leverage reduced: ${baseLeverage}x → ${leverageCalc.leverage}x`);
    }
    
    // Calculate position size V5.6 - now with liquidity awareness AND dynamic leverage
    const sizing = calculatePositionSize({
      symbol,
      currentPrice,
      totalCapitalUsd: availableCapital,
      riskPerTradePct: this.config.riskPerTradePct,
      stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
      volume24h, // V5.5: Pass volume for liquidity-aware sizing
      safeLeverage: leverageCalc.leverage, // V5.6: Pass ATR-adjusted leverage
    });
    
    // V5.5: Log if position was capped due to liquidity
    if (sizing.wasLiquidityCapped) {
      const targetNotional = availableCapital * MomentumConfig.RISK.POSITION_SIZE_PCT * sizing.suggestedLeverage;
      logger.warn(`🚨 [${symbol}] Position CAPPED by liquidity! Target notional=$${targetNotional.toFixed(0)} → Capped=$${sizing.notionalUsd.toFixed(0)} (max safe=$${sizing.maxSafePosition?.toFixed(0)}, tier=${sizing.liquidityTier})`);
    }
    
    // Check if position size is valid (minimum $20 notional)
    if (sizing.notionalUsd < 20) {
      logger.info(`⚠️ [${symbol}] Cannot open position - insufficient capital (available $${availableCapital.toFixed(2)}, min $20 notional required)`);
      return;
    }
    
    // Try to reserve MARGIN (not notional) - this is what we actually risk
    if (!this.config.capitalPool.reserve(this.config.sessionId, sizing.marginUsd)) {
      logger.info(`⚠️ [${symbol}] Cannot open position - failed to reserve margin $${sizing.marginUsd.toFixed(2)}`);
      return;
    }
    
    // V5.5: Include liquidity info in log
    const slippageInfo = sizing.estimatedSlippage ? ` | est.slip=${sizing.estimatedSlippage.toFixed(3)}%` : '';
    const liquidityInfo = sizing.liquidityTier ? ` | tier=${sizing.liquidityTier}` : '';
    logger.info(`🚀 [${symbol}] OPENING ${side.toUpperCase()} | price=$${currentPrice.toFixed(4)} | qty=${sizing.qty.toFixed(6)} | notional=$${sizing.notionalUsd.toFixed(2)} | margin=$${sizing.marginUsd.toFixed(2)} | lev=${sizing.suggestedLeverage}x${liquidityInfo}${slippageInfo}`);
    
    // V5.7: Calculate dynamic stop-loss based on ATR
    const slCalc = calcDynamicStopLoss(candles);
    const slPct = slCalc.slPct;
    if (slCalc.isDynamic) {
      logger.info(`🎯 [${symbol}] Dynamic SL: ATR=${slCalc.atrPct?.toFixed(2)}% × 2.0 = ${slPct.toFixed(2)}%`);
    }
    
    if (this.config.mode === 'paper') {
      // Paper trade
      const position: Position = {
        symbol,
        side,
        entryPrice: currentPrice,
        qty: sizing.qty,
        entryTime: Date.now(),
        leverage: sizing.suggestedLeverage,   // V5.6: Store leverage used
        marginUsd: sizing.marginUsd,           // V5.6: Store margin blocked
        stopLoss: side === 'long' 
          ? currentPrice * (1 - slPct / 100)
          : currentPrice * (1 + slPct / 100),
        stopLossPct: slPct,                    // V5.7: Store SL percentage used
        highWaterMark: side === 'long' ? currentPrice : undefined,
        lowWaterMark: side === 'short' ? currentPrice : undefined,
      };
      
      this.position = position;
      
      // Commit MARGIN (not notional)
      this.config.capitalPool.commit(this.config.sessionId, sizing.marginUsd);
      
      // Save to DB
      await this.savePositionToDb(position, 'paper_entry');
      
      logger.info(`📝 [${symbol}] PAPER ${side.toUpperCase()} OPENED @ $${currentPrice.toFixed(4)} | notional=$${sizing.notionalUsd.toFixed(2)} | margin=$${sizing.marginUsd.toFixed(2)} | SL=${slPct.toFixed(2)}% ($${position.stopLoss?.toFixed(4)})`);
      
    } else {
      // Live trade
      try {
        // Set leverage - Binance Futures requires integer leverage
        const intLeverage = Math.round(sizing.suggestedLeverage);
        logger.info(`🔧 [${symbol}] Setting leverage: ${sizing.suggestedLeverage} → ${intLeverage} (rounded to integer for Binance)`);
        await this.config.exchange.setLeverage(intLeverage, symbol);
        
        // Format quantity to exchange precision (critical for Binance Futures)
        const formattedQty = this.formatQtyForExchange(symbol, sizing.qty);
        
        // Validate formatted quantity is still valid
        if (formattedQty <= 0) {
          logger.error(`❌ [${symbol}] Formatted quantity is 0 or negative (raw: ${sizing.qty})`);
          this.config.capitalPool.cancelReservation(this.config.sessionId);
          return;
        }
        
        // Place market order with formatted quantity
        const order = side === 'long'
          ? await this.config.exchange.createMarketBuyOrder(symbol, formattedQty, { reduceOnly: false })
          : await this.config.exchange.createMarketSellOrder(symbol, formattedQty, { reduceOnly: false });
        
        const filledPrice = order.average || order.price || currentPrice;
        const filledQty = order.filled || formattedQty;
        
        const position: Position = {
          symbol,
          side,
          entryPrice: filledPrice,
          qty: filledQty,
          entryTime: Date.now(),
          leverage: sizing.suggestedLeverage,   // V5.6: Store leverage used
          marginUsd: sizing.marginUsd,           // V5.6: Store margin blocked
          stopLoss: side === 'long'
            ? filledPrice * (1 - slPct / 100)
            : filledPrice * (1 + slPct / 100),
          stopLossPct: slPct,                    // V5.7: Store SL percentage used
          orderId: order.id,
          highWaterMark: side === 'long' ? filledPrice : undefined,
          lowWaterMark: side === 'short' ? filledPrice : undefined,
        };
        
        this.position = position;
        
        // Commit MARGIN (not notional)
        this.config.capitalPool.commit(this.config.sessionId, sizing.marginUsd);
        
        // Save to DB
        await this.savePositionToDb(position, 'live_entry');
        
        // Set stop loss on exchange
        await this.setStopLossOnExchange(position);
        
        logger.info(`🟢 [${symbol}] LIVE ${side.toUpperCase()} OPENED @ $${filledPrice} | qty=${filledQty} | SL=$${position.stopLoss?.toFixed(4)}`);
        
        this.config.onTrade?.({
          symbol,
          side: side === 'long' ? 'buy' : 'sell',
          qty: filledQty,
          price: filledPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error: any) {
        // Enhanced error logging for debugging
        logger.error(`❌ [${symbol}] Failed to open live position:`, {
          name: error?.name,
          message: error?.message,
          code: error?.code,
          info: error?.info,
        });
        // Cancel reservation on failure
        this.config.capitalPool.cancelReservation(this.config.sessionId);
      }
    }
  }
  
  // ==========================================================================
  // EXIT LOGIC WITH TRAILING STOP
  // ==========================================================================
  
  private async checkExit(position: Position): Promise<void> {
    const symbol = this.config.symbol;
    
    try {
      const candles = await this.fetchCandles();
      if (candles.length === 0) return;
      
      const currentPrice = candles[candles.length - 1].close;
      this.lastPrice = currentPrice;
      
      // Update water marks for trailing stop
      this.position = updatePositionWaterMarks(position, currentPrice);
      
      // Log position status every tick when in position
      const pnlPct = position.side === 'long'
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      logger.info(`📊 [${symbol}] POSITION ${position.side.toUpperCase()} | entry=$${position.entryPrice.toFixed(2)} | now=$${currentPrice.toFixed(2)} | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | SL=$${this.position?.stopLoss?.toFixed(2) || 'N/A'}`);
      
      const exitSignal = shouldExitPosition(this.position!, currentPrice);
      
      if (exitSignal.shouldExit) {
        logger.info(`🔴 [${symbol}] EXIT SIGNAL: reason=${exitSignal.reason} | PnL=${exitSignal.pnlPct?.toFixed(2)}% | holdMin=${exitSignal.holdMinutes?.toFixed(0)}`);
        await this.closePosition(this.position!, currentPrice, exitSignal.reason || 'unknown');
      } else if (exitSignal.newStopLoss && exitSignal.newStopLoss !== this.position?.stopLoss) {
        // Update trailing stop on exchange (live mode) or just log (paper mode)
        await this.updateTrailingStopOnExchange(exitSignal.newStopLoss);
      }
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking exit:`, error);
    }
  }
  
  private async closePosition(
    position: Position, 
    currentPrice: number,
    reason: string
  ): Promise<void> {
    const symbol = this.config.symbol;
    
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
    
    // Store exit info for frontend display
    this.lastExit = {
      ts: Date.now(),
      price: currentPrice,
      reason,
    };
    this.currentBias = null;
    this.lastSignal = null;
    
    if (this.config.mode === 'paper') {
      // Paper close
      this.position = null;
      
      // Release MARGIN (not notional) with PnL
      this.config.capitalPool.release(this.config.sessionId, marginToRelease, pnlUsd);
      
      await this.saveExitToDb(position, currentPrice, reason, pnlPct, pnlUsd);
      logger.info(`📝 [${symbol}] PAPER CLOSED | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | notional=$${notionalUsd.toFixed(2)} | margin released=$${marginToRelease.toFixed(2)}`);
      
    } else {
      // Live close
      try {
        // FIRST: Cancel any open SL/TP orders to avoid orphaned orders
        await this.cancelStopLossOnExchange();
        
        // Format quantity to exchange precision
        const formattedQty = this.formatQtyForExchange(symbol, position.qty);
        
        const closeSide = position.side === 'long' ? 'sell' : 'buy';
        const order = position.side === 'long'
          ? await this.config.exchange.createMarketSellOrder(symbol, formattedQty, { reduceOnly: true })
          : await this.config.exchange.createMarketBuyOrder(symbol, formattedQty, { reduceOnly: true });
        
        const exitPrice = order.average || order.price || currentPrice;
        
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
        
        // Release MARGIN (not notional) with PnL
        this.config.capitalPool.release(this.config.sessionId, marginToRelease, actualPnlUsd);
        
        // Pass the real exchange orderId for proper tracking
        await this.saveExitToDb(position, exitPrice, reason, actualPnlPct, actualPnlUsd, order.id);
        
        logger.info(`🔴 [${symbol}] LIVE CLOSED @ $${exitPrice} | PnL=${actualPnlPct >= 0 ? '+' : ''}${actualPnlPct.toFixed(2)}% ($${actualPnlUsd.toFixed(2)}) | margin released=$${marginToRelease.toFixed(2)} | orderId=${order.id}`)
        
        this.config.onTrade?.({
          symbol,
          side: closeSide,
          qty: position.qty,
          price: exitPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error) {
        logger.error(`❌ [${symbol}] Failed to close live position:`, error);
      }
    }
  }
  
  // ==========================================================================
  // EXCHANGE HELPERS
  // ==========================================================================
  
  /**
   * Format quantity to exchange precision
   * Uses CCXT's amountToPrecision if available, otherwise applies fallback rounding
   * This is critical for Binance Futures which requires specific step sizes per symbol
   */
  private formatQtyForExchange(symbol: string, qty: number): number {
    // Try CCXT's amountToPrecision first (most reliable)
    if (this.config.exchange.amountToPrecision) {
      try {
        const formatted = this.config.exchange.amountToPrecision(symbol, qty);
        const result = parseFloat(formatted);
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (via amountToPrecision)`);
        return result;
      } catch (e) {
        logger.warn(`⚠️ [${symbol}] amountToPrecision failed, using fallback:`, e);
      }
    }
    
    // Fallback: Get precision from market info if available
    const market = this.config.exchange.markets?.[symbol];
    if (market?.precision?.amount !== undefined) {
      const precision = market.precision.amount;
      // In CCXT, precision can be represented as:
      // - Number of decimal places (integer >= 0, e.g., 3 means 0.001 step)
      // - Direct step size (decimal < 1, e.g., 0.001)
      // CCXT typically uses Number.isInteger() to distinguish, but we use a heuristic:
      // If precision is an integer AND > 0, treat as decimal places
      // Otherwise treat as step size
      if (Number.isInteger(precision) && precision > 0) {
        // It's decimal places (e.g., 3 means 3 decimal places = 0.001 step)
        const factor = Math.pow(10, precision);
        const result = Math.floor(qty * factor) / factor;
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (${precision} decimals)`);
        return result;
      } else {
        // It's step size (e.g., 0.001 or 1)
        const stepSize = precision;
        const result = Math.floor(qty / stepSize) * stepSize;
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (step=${stepSize})`);
        return result;
      }
    }
    
    // Known precision map for Binance Futures symbols (fallback when markets not loaded)
    // These are step sizes (quantity increments) for each symbol
    // ⚠️ WARNING: This is a static fallback - step sizes may change on the exchange
    const knownPrecision: Record<string, number> = {
      'SEI/USDT:USDT': 1,      // Step size = 1 (whole units)
      'IMX/USDT:USDT': 0.1,    // Step size = 0.1
      'SUI/USDT:USDT': 0.1,    // Step size = 0.1
      'DOGE/USDT:USDT': 1,     // Step size = 1
      'XRP/USDT:USDT': 0.1,    // Step size = 0.1
      'ADA/USDT:USDT': 0.1,    // Step size = 0.1
      'DOT/USDT:USDT': 0.1,    // Step size = 0.1
      'LINK/USDT:USDT': 0.01,  // Step size = 0.01
      'AVAX/USDT:USDT': 0.01,  // Step size = 0.01
      'SOL/USDT:USDT': 0.01,   // Step size = 0.01
      'ETH/USDT:USDT': 0.001,  // Step size = 0.001
      'BTC/USDT:USDT': 0.001,  // Step size = 0.001
    };
    
    const stepSize = knownPrecision[symbol];
    if (stepSize !== undefined) {
      // Log warning that we're using static fallback - markets should be loaded
      logger.warn(`⚠️ [${symbol}] Using static precision fallback (step=${stepSize}). Consider checking if exchange markets are loaded correctly.`);
      const result = Math.floor(qty / stepSize) * stepSize;
      logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (known step=${stepSize})`);
      return result;
    }
    
    // Ultimate fallback: round to 3 decimal places (more conservative for safety)
    logger.warn(`⚠️ [${symbol}] No precision info available, using conservative 3 decimal fallback`);
    const result = Math.floor(qty * 1000) / 1000;
    logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (fallback 3 decimals)`);
    return result;
  }
  
  private async fetchCandles(): Promise<Candle[]> {
    const symbol = this.config.symbol;
    // Convert CCXT symbol to Binance format: "ETH/USDT:USDT" -> "ETHUSDT"
    const binanceSymbol = symbol.split('/')[0] + 'USDT';
    
    // 1. Subscribe to WebSocket stream for this symbol (only once per agent)
    if (!this.wsSubscribed) {
      try {
        const ws = getBinanceWebSocket();
        ws.subscribeToKline(binanceSymbol, '15m');
        this.wsSubscribed = true;
        logger.info(`📡 [${symbol}] Subscribed to WebSocket kline stream (0 API weight)`);
      } catch (error) {
        logger.warn(`⚠️ [${symbol}] Failed to subscribe to WebSocket, will use REST`);
      }
    }
    
    // 2. Try WebSocket cache first (0 API weight!)
    try {
      const wsKlines = getKlinesOhlcvFromWebSocket(binanceSymbol, '15m');
      if (wsKlines && wsKlines.length >= 50) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        }));
        
        // Update local cache with WS data
        this.candleCache = { candles, fetchedAt: Date.now() };
        return candles;
      }
    } catch (error) {
      // WebSocket not ready, fall through to REST
    }
    
    // 3. Check local REST cache
    if (this.candleCache && Date.now() - this.candleCache.fetchedAt < this.CACHE_TTL_MS) {
      return this.candleCache.candles;
    }
    
    // 4. REST API fallback
    try {
      logger.info(`🌐 [${symbol}] Fetching via REST API (WebSocket not ready)`);
      const ohlcv = await this.config.exchange.fetchOHLCV(symbol, '15m', undefined, 100);
      
      const candles: Candle[] = ohlcv.map(c => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));
      
      // Seed WebSocket cache with REST data for future use
      seedKlinesFromWebSocket(binanceSymbol, '15m', ohlcv);
      
      this.candleCache = { candles, fetchedAt: Date.now() };
      
      return candles;
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to fetch candles:`, error);
      return this.candleCache?.candles || [];
    }
  }
  
  private async fetchBtcCandles(): Promise<Candle[]> {
    const btcSymbol = 'BTCUSDT'; // Binance format for WebSocket
    const btcSymbolCcxt = 'BTC/USDT:USDT'; // CCXT format for REST fallback
    
    // 1. Subscribe to BTC WebSocket stream (only once, shared globally)
    if (!btcWsSubscribed) {
      try {
        const ws = getBinanceWebSocket();
        ws.subscribeToKline(btcSymbol, '15m');
        btcWsSubscribed = true;
        logger.info('📡 [BTC] Subscribed to WebSocket kline stream (0 API weight)');
      } catch (error) {
        logger.warn('⚠️ [BTC] Failed to subscribe to WebSocket, will use REST');
      }
    }
    
    // 2. Try WebSocket cache first (0 API weight!) 
    try {
      const wsKlines = getKlinesOhlcvFromWebSocket(btcSymbol, '15m');
      if (wsKlines && wsKlines.length >= 200) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        }));
        
        // Update global cache with WS data
        globalBtcCandleCache = { candles, fetchedAt: Date.now() };
        return candles;
      }
    } catch (error) {
      logger.warn('⚠️ [BTC] WebSocket cache miss, checking REST cache');
    }
    
    // 3. Check global REST cache (shared between all agents)
    if (globalBtcCandleCache && Date.now() - globalBtcCandleCache.fetchedAt < GLOBAL_BTC_CACHE_TTL_MS) {
      return globalBtcCandleCache.candles;
    }
    
    // 4. If another agent is already fetching via REST, wait for it
    if (globalBtcCacheFetchingPromise) {
      try {
        return await globalBtcCacheFetchingPromise;
      } catch {
        // Fall through to fetch ourselves
      }
    }
    
    // 5. REST API fallback - set up promise so other agents wait
    const fetchPromise = (async () => {
      try {
        logger.info('🌐 [BTC] Fetching via REST API (WebSocket not ready)');
        // V5: Need 220 candles for SMA200 regime filter with some buffer
        const ohlcv = await this.config.exchange.fetchOHLCV(btcSymbolCcxt, '15m', undefined, 220);
        
        const candles: Candle[] = ohlcv.map(c => ({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        }));
        
        // Seed WebSocket cache with REST data for future use
        seedKlinesFromWebSocket(btcSymbol, '15m', ohlcv);
        
        // Update global cache
        globalBtcCandleCache = { candles, fetchedAt: Date.now() };
        
        return candles;
        
      } catch (error) {
        logger.error(`❌ [BTC] Failed to fetch BTC candles via REST:`, error);
        return globalBtcCandleCache?.candles || [];
      } finally {
        globalBtcCacheFetchingPromise = null;
      }
    })();
    
    globalBtcCacheFetchingPromise = fetchPromise;
    return fetchPromise;
  }
  
  /**
   * Cancel existing stop loss order on exchange
   */
  private async cancelStopLossOnExchange(): Promise<void> {
    if (this.config.mode === 'paper') return;
    
    const symbol = this.config.symbol;
    
    // If we have a specific SL order ID, cancel just that order
    if (this.position?.stopLossOrderId) {
      try {
        await this.config.exchange.cancelOrder?.(this.position.stopLossOrderId, symbol);
        logger.info(`🗑️ [${symbol}] Cancelled SL order ${this.position.stopLossOrderId}`);
        if (this.position) {
          this.position.stopLossOrderId = undefined;
        }
      } catch (error: any) {
        // Order might already be filled or cancelled
        if (!error.message?.includes('Unknown order') && !error.message?.includes('not found')) {
          logger.warn(`⚠️ [${symbol}] Failed to cancel SL order:`, error);
        }
      }
    }
    
    // Also cancel all open orders for safety (in case of orphaned orders)
    if (this.config.exchange.cancelAllOrders) {
      try {
        await this.config.exchange.cancelAllOrders(symbol);
        logger.info(`🗑️ [${symbol}] Cancelled all open orders`);
      } catch (error) {
        logger.warn(`⚠️ [${symbol}] Failed to cancel all orders:`, error);
      }
    }
  }
  
  /**
   * Set or update stop loss on exchange
   * Cancels existing SL first if present
   */
  private async setStopLossOnExchange(position: Position, isUpdate: boolean = false): Promise<void> {
    if (!position.stopLoss) return;
    if (this.config.mode === 'paper') return;
    
    const symbol = this.config.symbol;
    const side = position.side === 'long' ? 'sell' : 'buy';
    
    try {
      // Cancel existing SL order first if updating
      if (isUpdate && this.position?.stopLossOrderId) {
        try {
          await this.config.exchange.cancelOrder?.(this.position.stopLossOrderId, symbol);
          logger.info(`🔄 [${symbol}] Cancelled old SL order for update`);
        } catch (error: any) {
          // Ignore if order doesn't exist
          if (!error.message?.includes('Unknown order') && !error.message?.includes('not found')) {
            logger.warn(`⚠️ [${symbol}] Failed to cancel old SL:`, error);
          }
        }
      }
      
      // Format quantity to exchange precision for SL order
      const formattedQty = this.formatQtyForExchange(symbol, position.qty);
      
      // Create new SL order
      const slOrder = await this.config.exchange.createOrder(
        symbol,
        'STOP_MARKET',  // Use STOP_MARKET for Binance futures
        side,
        formattedQty,
        undefined,
        {
          stopPrice: position.stopLoss,
          reduceOnly: true,
          workingType: 'MARK_PRICE',  // Use mark price to avoid manipulation
        }
      );
      
      // Store the SL order ID for later cancellation/update
      if (this.position) {
        this.position.stopLossOrderId = slOrder.id;
      }
      
      const action = isUpdate ? 'UPDATED' : 'SET';
      logger.info(`🛡️ [${symbol}] Stop loss ${action} at $${position.stopLoss.toFixed(4)} (order: ${slOrder.id})`);
    } catch (error) {
      logger.warn(`⚠️ [${symbol}] Failed to set stop loss on exchange:`, error);
    }
  }
  
  /**
   * Update trailing stop on exchange when price moves favorably
   */
  private async updateTrailingStopOnExchange(newStopPrice: number): Promise<void> {
    if (this.config.mode === 'paper') return;
    if (!this.position) return;
    
    const symbol = this.config.symbol;
    const oldSL = this.position.stopLoss;
    
    // Only update if the new stop is better (higher for long, lower for short)
    if (this.position.side === 'long' && newStopPrice <= (oldSL || 0)) return;
    if (this.position.side === 'short' && newStopPrice >= (oldSL || Infinity)) return;
    
    // Update position with new SL
    this.position.stopLoss = newStopPrice;
    
    // Update on exchange
    await this.setStopLossOnExchange(this.position, true);
    
    logger.info(`📈 [${symbol}] Trailing stop moved: $${oldSL?.toFixed(4)} → $${newStopPrice.toFixed(4)}`);
  }
  
  // ==========================================================================
  // DATABASE HELPERS
  // ==========================================================================
  
  private async loadExistingPosition(): Promise<void> {
    try {
      const dbPosition = await this.config.prisma.position.findFirst({
        where: {
          sessionId: this.config.sessionId,
          symbol: this.config.symbol,
        },
      });
      
      if (dbPosition && dbPosition.entryPrice && dbPosition.qty) {
        // Calculate margin from notional / leverage
        const notional = dbPosition.qty * dbPosition.entryPrice;
        const leverage = dbPosition.leverage || MomentumConfig.LEVERAGE[this.config.symbol] || 4.5;
        const marginUsd = notional / leverage;
        
        this.position = {
          symbol: dbPosition.symbol,
          side: (dbPosition.side as 'long' | 'short') || 'long',
          entryPrice: dbPosition.entryPrice,
          qty: dbPosition.qty,
          entryTime: dbPosition.openedAt?.getTime() || Date.now(),
          stopLoss: dbPosition.stopPrice || undefined,
          orderId: dbPosition.slOrderId || undefined,
          leverage: leverage,
          marginUsd: marginUsd,
          highWaterMark: dbPosition.side === 'long' ? dbPosition.entryPrice : undefined,
          lowWaterMark: dbPosition.side === 'short' ? dbPosition.entryPrice : undefined,
        };
        
        // ⚠️ CRITICAL: Register margin in CapitalPool to prevent double-spending!
        // This is essential for live mode where exchange balance includes locked margin
        this.config.capitalPool.commit(this.config.sessionId, marginUsd);
        
        logger.info(`📥 [${this.config.symbol}] Loaded existing position: ${this.position?.side} @ $${this.position?.entryPrice} | margin=$${marginUsd.toFixed(2)} registered in pool`);
      }
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to load position:`, error);
    }
  }
  
  /**
   * 🔄 SYNC WITH EXCHANGE (Live Mode Only)
   * Fetches real positions from Binance and detects if stop losses were executed
   */
  private async syncWithExchange(): Promise<void> {
    const symbol = this.config.symbol;
    
    if (!this.config.exchange.fetchPositions) {
      logger.info(`⚠️ [${symbol}] Exchange does not support fetchPositions`);
      return;
    }
    
    try {
      // Fetch all positions from exchange
      const exchangePositions = await this.config.exchange.fetchPositions([symbol]);
      
      // Find position for our symbol
      const exchangePos = exchangePositions.find((p: any) => 
        p.symbol === symbol || 
        p.info?.symbol === symbol.replace('/', '').replace(':USDT', '')
      );
      
      const exchangeQty = Math.abs(parseFloat(exchangePos?.contracts || exchangePos?.info?.positionAmt || '0'));
      const exchangeSide = parseFloat(exchangePos?.info?.positionAmt || '0') > 0 ? 'long' : 'short';
      
      // Case 1: We think we have a position but exchange says NO
      if (this.position && exchangeQty === 0) {
        logger.info(`🔴 [${symbol}] SYNC MISMATCH: Position closed on exchange (likely stop loss hit)`);
        
        // Try to get the last trade to find exit price and orderId
        let exitPrice = this.position.entryPrice;
        let reason = 'stop_loss_exchange';
        let exchangeOrderId: string | undefined;
        
        try {
          if (this.config.exchange.fetchMyTrades) {
            const trades = await this.config.exchange.fetchMyTrades(symbol, Date.now() - 3600000, 10);
            if (trades && trades.length > 0) {
              const lastTrade = trades[trades.length - 1];
              exitPrice = lastTrade.price || exitPrice;
              exchangeOrderId = lastTrade.order || lastTrade.info?.orderId;
              logger.info(`📈 [${symbol}] Found exit trade: $${exitPrice} orderId=${exchangeOrderId}`);
            }
          }
        } catch (tradeError) {
          logger.warn(`⚠️ [${symbol}] Could not fetch trades:`, tradeError);
        }
        
        // Calculate PnL
        let pnlPct: number;
        let pnlUsd: number;
        if (this.position.side === 'long') {
          pnlPct = ((exitPrice - this.position.entryPrice) / this.position.entryPrice) * 100;
          pnlUsd = this.position.qty * (exitPrice - this.position.entryPrice);
        } else {
          pnlPct = ((this.position.entryPrice - exitPrice) / this.position.entryPrice) * 100;
          pnlUsd = this.position.qty * (this.position.entryPrice - exitPrice);
        }
        
        const notionalUsd = this.position.qty * this.position.entryPrice;
        // V5.6: Use stored margin, fallback to notional/leverage or notional
        const marginToRelease = this.position.marginUsd ?? (this.position.leverage ? notionalUsd / this.position.leverage : notionalUsd);
        
        // Release MARGIN (not notional)
        this.config.capitalPool.release(this.config.sessionId, marginToRelease, pnlUsd);
        
        // Save exit to DB with exchange orderId if available
        await this.saveExitToDb(this.position, exitPrice, reason, pnlPct, pnlUsd, exchangeOrderId);
        
        logger.info(`✅ [${symbol}] Position synced: Exit @ $${exitPrice.toFixed(4)}, PnL: ${pnlPct.toFixed(2)}%, margin released: $${marginToRelease.toFixed(2)}`);
        
        this.position = null;
      }
      
      // Case 2: Exchange has position but we don't know about it
      else if (!this.position && exchangeQty > 0) {
        logger.info(`⚠️ [${symbol}] SYNC: Found unexpected position on exchange (${exchangeSide} ${exchangeQty})`);
        
        // Load from exchange
        const entryPrice = parseFloat(exchangePos?.entryPrice || exchangePos?.info?.entryPrice || '0');
        
        if (entryPrice > 0) {
          // V5.6: Estimate margin - use asset-specific leverage or default to 5x
          const notionalUsd = exchangeQty * entryPrice;
          const estimatedLeverage = MomentumConfig.LEVERAGE[symbol] || 5;
          const estimatedMargin = notionalUsd / estimatedLeverage;
          
          this.position = {
            symbol,
            side: exchangeSide,
            entryPrice,
            qty: exchangeQty,
            entryTime: Date.now(),
            leverage: estimatedLeverage,      // V5.6: Estimated
            marginUsd: estimatedMargin,       // V5.6: Estimated
            highWaterMark: exchangeSide === 'long' ? entryPrice : undefined,
            lowWaterMark: exchangeSide === 'short' ? entryPrice : undefined,
          };
          
          // Commit MARGIN (not notional) for this position
          this.config.capitalPool.commit(this.config.sessionId, estimatedMargin);
          
          // Save to DB
          await this.savePositionToDb(this.position, 'synced_from_exchange');
          
          logger.info(`✅ [${symbol}] Position synced from exchange: ${exchangeSide} @ $${entryPrice}`);
        }
      }
      
      // Case 3: Both have position - verify they match
      else if (this.position && exchangeQty > 0) {
        // Just log for now, could add reconciliation logic
        const entryPrice = parseFloat(exchangePos?.entryPrice || exchangePos?.info?.entryPrice || '0');
        const unrealizedPnl = parseFloat(exchangePos?.unrealizedPnl || exchangePos?.info?.unRealizedProfit || '0');
        
        logger.info(`✅ [${symbol}] Position verified on exchange: qty=${exchangeQty} entry=$${entryPrice} uPnL=$${unrealizedPnl.toFixed(2)}`);
      }
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to sync with exchange:`, error);
    }
  }
  
  private async savePositionToDb(position: Position, action: string): Promise<void> {
    try {
      // First create an order for the entry (BUY for long, SELL for short)
      const isLive = this.config.mode === 'live';
      // For live mode, use the orderId from exchange if available, otherwise generate one
      const clientOrderId = position.orderId || `${isLive ? 'live' : 'paper'}_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entrySide = position.side === 'long' ? 'buy' : 'sell';
      
      const order = await this.config.prisma.order.create({
        data: {
          clientOrderId,
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          side: entrySide,
          type: 'market',
          qty: position.qty,
          price: position.entryPrice,
          status: 'filled',
          source: 'simple_agent',
          strategyUsed: 'momentum_simple',
        },
      });
      
      // Log entry as a Fill record linked to the order
      await this.config.prisma.fill.create({
        data: {
          orderId: order.id,
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          price: position.entryPrice,
          qty: position.qty,
          side: entrySide,
          realizedPnl: 0, // No PnL on entry
          strategyUsed: 'momentum_simple',
          strategyFamily: 'momentum',
          ts: new Date(position.entryTime),
        },
      });
      
      logger.info(`💾 [${this.config.symbol}] Entry order logged: ${entrySide.toUpperCase()} @ $${position.entryPrice.toFixed(4)}`);
      
      // Then create the position record
      await this.config.prisma.position.create({
        data: {
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          qty: position.qty,
          leverage: MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] || 3,
          stopPrice: position.stopLoss,
          openedAt: new Date(position.entryTime),
        },
      });
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to save position to DB:`, error);
    }
  }
  
  private async saveExitToDb(
    position: Position, 
    exitPrice: number, 
    reason: string,
    pnlPct: number,
    pnlUsd: number,
    exchangeOrderId?: string  // Optional: real orderId from exchange (for live mode)
  ): Promise<void> {
    try {
      // Exit side is opposite of position side (SELL to close LONG, BUY to close SHORT)
      const exitSide = position.side === 'long' ? 'sell' : 'buy';
      const isLive = this.config.mode === 'live';
      const clientOrderId = exchangeOrderId || `${isLive ? 'live' : 'paper'}_exit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      const order = await this.config.prisma.order.create({
        data: {
          clientOrderId,
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          side: exitSide,
          type: 'market',
          qty: position.qty,
          price: exitPrice,
          status: 'filled',
          source: 'simple_agent',
          strategyUsed: 'momentum_simple',
        },
      });
      
      // Log exit as a Fill record linked to the order (using order.id, not clientOrderId)
      await this.config.prisma.fill.create({
        data: {
          orderId: order.id,  // Use the generated Order ID
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          price: exitPrice,
          qty: position.qty,
          side: exitSide,
          realizedPnl: pnlUsd,
          strategyUsed: 'momentum_simple',
          strategyFamily: 'momentum',
          ts: new Date(),
        },
      });
      
      // Delete the position (it's closed)
      await this.config.prisma.position.deleteMany({
        where: {
          sessionId: this.config.sessionId,
          symbol: position.symbol,
        },
      });
      
      // Update SessionKpi with new performance metrics
      await this.updateSessionKpi(pnlUsd, pnlPct);
      
      logger.info(`💾 [${this.config.symbol}] Exit logged: ${reason}, PnL: $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to save exit to DB:`, error);
    }
  }
  
  /**
   * Update SessionKpi after each trade exit
   * Calculates: realizedPnlUsd, winRate, expectancy, maxDrawdownPct, etc.
   */
  private async updateSessionKpi(tradePnlUsd: number, tradePnlPct: number): Promise<void> {
    try {
      const sessionId = this.config.sessionId;
      
      // Aggregate all fills with realized PnL for this session
      const fills = await this.config.prisma.fill.findMany({
        where: { 
          sessionId,
          realizedPnl: { not: null }
        },
        orderBy: { ts: 'asc' }
      });
      
      // Calculate metrics from fills
      const exitFills = fills.filter(f => f.realizedPnl !== null && f.realizedPnl !== 0);
      const tradeCount = exitFills.length;
      const wins = exitFills.filter(f => (f.realizedPnl || 0) > 0).length;
      const losses = exitFills.filter(f => (f.realizedPnl || 0) < 0).length;
      
      const totalRealizedPnl = exitFills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0);
      const totalFees = fills.reduce((sum, f) => sum + (f.fee || 0), 0);
      const netRealizedPnl = totalRealizedPnl - totalFees;
      
      const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
      
      // Calculate expectancy (average PnL per trade)
      const expectancy = tradeCount > 0 ? netRealizedPnl / tradeCount : 0;
      
      // Calculate max drawdown from cumulative PnL
      let peak = 0;
      let cumulative = 0;
      let maxDrawdown = 0;
      
      for (const fill of exitFills) {
        cumulative += (fill.realizedPnl || 0);
        if (cumulative > peak) peak = cumulative;
        const drawdown = peak > 0 ? (cumulative - peak) / peak * 100 : 0;
        if (drawdown < maxDrawdown) maxDrawdown = drawdown;
      }
      
      // Get session start balance for ROI calculation
      const session = await this.config.prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { startBalanceUsd: true }
      });
      const startBalance = session?.startBalanceUsd || 1000; // Default 1000 if not set
      const roiPct = startBalance > 0 ? (netRealizedPnl / startBalance) * 100 : 0;
      
      // Get current unrealized PnL from open position
      let unrealizedPnlUsd = 0;
      if (this.position && this.lastPrice) {
        if (this.position.side === 'long') {
          unrealizedPnlUsd = this.position.qty * (this.lastPrice - this.position.entryPrice);
        } else {
          unrealizedPnlUsd = this.position.qty * (this.position.entryPrice - this.lastPrice);
        }
      }
      
      // Build stats JSON
      const stats = {
        trades: tradeCount,
        wins,
        losses,
        totalFees,
        netRealizedPnl,
        lastTradeAt: new Date().toISOString(),
        avgWinUsd: wins > 0 ? exitFills.filter(f => (f.realizedPnl || 0) > 0).reduce((s, f) => s + (f.realizedPnl || 0), 0) / wins : 0,
        avgLossUsd: losses > 0 ? exitFills.filter(f => (f.realizedPnl || 0) < 0).reduce((s, f) => s + (f.realizedPnl || 0), 0) / losses : 0,
      };
      
      // Upsert SessionKpi
      await this.config.prisma.sessionKpi.upsert({
        where: { sessionId },
        update: {
          realizedPnlUsd: netRealizedPnl,
          unrealizedPnlUsd,
          roiPct,
          winRate,
          expectancy,
          maxDrawdownPct: Math.abs(maxDrawdown),
          stats,
          lastUpdated: new Date(),
        },
        create: {
          sessionId,
          realizedPnlUsd: netRealizedPnl,
          unrealizedPnlUsd,
          roiPct,
          winRate,
          expectancy,
          maxDrawdownPct: Math.abs(maxDrawdown),
          stats,
        },
      });
      
      logger.info(`📊 [${this.config.symbol}] KPI updated: ${tradeCount} trades, ${winRate.toFixed(1)}% WR, $${netRealizedPnl.toFixed(2)} PnL, ${roiPct.toFixed(2)}% ROI`);
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to update SessionKpi:`, error);
    }
  }
  
  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  
  getStatus(): { 
    running: boolean; 
    hasPosition: boolean; 
    symbol: string;
    sessionId: string;
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
      
      posWithMetrics = {
        ...this.position,
        // Add entry as alias for frontend compatibility (PositionInfoCard expects 'entry')
        entry: this.position.entryPrice,
        // Add leverage for frontend display
        leverage: MomentumConfig.LEVERAGE[this.position.symbol] || 5,
        // Add openedAt for frontend time-held calculation
        openedAt: this.position.entryTime,
        // Add stopPrice as alias for frontend compatibility
        stopPrice: this.position.stopLoss,
        stop: this.position.stopLoss,
        // Add targets from lastSignal
        targets: this.lastSignal?.targets || [],
        currentPrice,
        pnlPct,
        pnlUsd,
        notionalUsd,
        duration,
        trailDistance,
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
}): Promise<SimpleAgent> {
  // Use provided pool or get/create pool for this user
  const pool = params.capitalPool || getCapitalPool(params.userId, 10000);
  if (!pool) {
    throw new Error('Capital pool not available');
  }
  
  const agent = new SimpleAgent({
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
  agents: SimpleAgent[];
  capitalPool: CapitalPool;
}> {
  // Create shared capital pool for this user
  const capitalPool = resetCapitalPool(params.userId, params.totalCapitalUsd, params.mode);
  
  const symbols = MomentumConfig.SYMBOLS;
  const sessionIdMap: Record<string, string> = {
    'BTC/USDT:USDT': params.sessionIds.btc,
    'ETH/USDT:USDT': params.sessionIds.eth,
    'SOL/USDT:USDT': params.sessionIds.sol,
    'XRP/USDT:USDT': params.sessionIds.xrp,
  };
  
  const agents: SimpleAgent[] = [];
  
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
