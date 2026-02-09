/**
 * PositionOpener - Extracted from SimpleAgent.
 * Handles the full openPosition() flow: pre-entry filters, capital sizing,
 * exchange order placement, multi-position support for both paper and live modes.
 */

import {
  MomentumConfig,
  calculatePositionSize,
  calcSafeLeverage,
  calcDynamicStopLoss,
  calcBollingerBands,
  checkWickBreakout,
  getLiquidityTier,
  LIQUIDATION_CONFIG,
  type Candle,
  type Position,
} from './momentumSimple.js';
import { createLogger } from '../utils/logger.js';
import { globalSignalRanker } from './signalRanker.js';
import { globalRestCircuitBreaker } from '../services/globalRestCircuitBreaker.js';
import { globalCacheManager } from './cacheManager.js';
import { orderQueue, type OrderRequest } from '../services/orderQueue.js';
import { calculateOrderPriority } from '../services/orderPriority.js';
import {
  notifyTradeEntry,
  notifyHighVolatility,
  notifyOrderError,
} from '../services/notificationService.js';
import { notifyPositionOpened } from '../utils/notifications.js';
import {
  getPositionFromWebSocket,
  getTickerFromWebSocket,
} from '../services/binanceWebSocket.js';
import { isIpBanned } from '../exchange/ccxtClient.js';
import { ipWeightTracker } from '../services/ipWeightTracker.js';
import { v4 as uuidv4 } from 'uuid';
import type { Exchange } from '../types/exchange.js';
import type { CapitalPool } from './simpleAgent.js';

const logger = createLogger('position-opener');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PositionOpenerContext {
  symbol: string;
  sessionId: string;
  userId: string;
  mode: 'paper' | 'live';
  exchange: Exchange;
  capitalPool: CapitalPool;
  riskPerTradePct: number;

  // Callbacks (bound from simpleAgent)
  savePositionToDb: (position: Position, action: string, entryFeeUsd?: number) => Promise<void>;
  setStopLossOnExchange: (position: Position, isUpdate?: boolean) => Promise<void>;
  setTrailingStopOnExchange: (position: Position, isWidening?: boolean) => Promise<boolean>;
  formatQtyForExchange: (symbol: string, qty: number) => number;
  startRealtimeExitMonitorIfNeeded: () => void;
  fetchBtcCandles: () => Promise<Candle[]>;
  fetchBtcCandles1h: () => Promise<Candle[]>;
  onTrade?: (trade: { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; orderId: string; timestamp: Date }) => void;
}

export interface OpenPositionResult {
  position: Position | null;
  additionalPositions: Position[];
  lastProcessedExitCandleTs: number | null;
}

export class PositionOpener {
  constructor(private ctx: PositionOpenerContext) {}

  async open(side: 'long' | 'short', candles: Candle[]): Promise<OpenPositionResult> {
    const symbol = this.ctx.symbol;
    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle.close;

    // ═══════════════════════════════════════════════════════════════════════════
    // V5.80: LOSS REDUCTION FILTERS - Validated on 24 months of data (4297 trades)
    // Baseline WR: 74.1% | Only filter hours with significantly lower WR
    // Days (including weekend) are NOT filtered - they perform at or above baseline
    // ═══════════════════════════════════════════════════════════════════════════

    // 1. SYMBOL BLACKLIST - Prevent trading on untested/incompatible symbols
    if (MomentumConfig.SYMBOLS_NOT_COMPATIBLE.includes(symbol)) {
      logger.warn(`🚫 [${symbol}] BLOCKED: Symbol in NOT_COMPATIBLE list`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // 2. TOXIC HOURS FILTER - Hours with WR significantly below 74.1% baseline
    // Validated on 4297 trades over 24 months:
    // 04:00: 58.2% WR (-15.9pp) | 05:00: 66.7% WR (-7.4pp) | 09:00: 65.6% WR (-8.5pp)
    // 18:00: 61.7% WR (-12.4pp) | 21:00: 62.1% WR (-12.0pp)
    const hourUtc = new Date().getUTCHours();
    if (hourUtc === 4 || hourUtc === 5 || hourUtc === 9 || hourUtc === 18 || hourUtc === 21) {
      logger.warn(`🚫 [${symbol}] BLOCKED: Toxic hour ${hourUtc}:00 UTC (WR < 67% on 24mo)`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // V5.56 FIX: Re-validate BTC regime before entering position
    // This catches cases where signal was generated with stale BTC data
    try {
      // V5.82: Use 1h candles for regime validation (same as entry signal)
      const btcCandles1hVal = (await this.ctx.fetchBtcCandles1h()).filter(c => c.isFinal !== false);
      let btcSma200: number;
      let btcNow: number;
      if (btcCandles1hVal.length >= 200) {
        const btcCloses1h = btcCandles1hVal.map(c => c.close);
        btcSma200 = btcCloses1h.slice(-200).reduce((a, b) => a + b, 0) / 200;
        btcNow = btcCloses1h[btcCloses1h.length - 1];
      } else {
        // Fallback to 15m
        const btcCandlesForValidation = await this.ctx.fetchBtcCandles();
        if (btcCandlesForValidation.length >= 201) {
          const btcCloses = btcCandlesForValidation.map(c => c.close);
          btcSma200 = btcCloses.slice(-200).reduce((a, b) => a + b, 0) / 200;
          btcNow = btcCloses[btcCloses.length - 1];
        } else {
          logger.warn(`⚠️ [${symbol}] Not enough BTC candles for regime validation`);
          btcSma200 = 0;
          btcNow = 0;
        }
      }
      if (btcSma200 > 0 && btcNow > 0) {
        const btcInBullRegime = btcNow > btcSma200;
        const btcInBearRegime = btcNow < btcSma200;

        // Block SHORT in BULL regime and LONG in BEAR regime
        if (side === 'short' && btcInBullRegime) {
          logger.error(`🚫 [${symbol}] BLOCKED: SHORT in BULL regime! BTC=${btcNow.toFixed(0)} > SMA200(1h)=${btcSma200.toFixed(0)}`);
          return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
        }
        if (side === 'long' && btcInBearRegime) {
          logger.error(`🚫 [${symbol}] BLOCKED: LONG in BEAR regime! BTC=${btcNow.toFixed(0)} < SMA200(1h)=${btcSma200.toFixed(0)}`);
          return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
        }
      }
    } catch (err) {
      logger.warn(`⚠️ [${symbol}] Failed to validate BTC regime:`, err);
    }

    // V5.63: Skip-N-trades-then-resume rule
    // After 2 consecutive losers, skip the next 1 trade, then resume
    // Testing showed: Skip 1 = +70% PnL, skips 2x more losers than winners
    if (this.ctx.capitalPool.shouldSkipEntry()) {
      const skipState = this.ctx.capitalPool.getSkipState();
      logger.info(`🛑 [${symbol}] SKIPPED (skip rule active, ${skipState.tradesToSkip} more to skip after this)`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // Sync with exchange balance before checking capital (live mode)
    // For live mode, force sync on first position attempt to ensure we have real balance
    if (this.ctx.mode === 'live') {
      // Force sync if we haven't successfully synced yet
      await this.ctx.capitalPool.syncWithExchange(!this.ctx.capitalPool.isSynced());

      // In live mode, don't open positions if we haven't successfully synced with exchange
      if (!this.ctx.capitalPool.isSynced()) {
        logger.error(`❌ [${symbol}] Cannot open live position - failed to sync with exchange balance. Please check API connection.`);
        return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // V5.65: POSITION VERIFICATION PRE-ORDER
      // ═══════════════════════════════════════════════════════════════════════════
      // Check that no position already exists on the exchange for this symbol.
      // This prevents double positions after reconnection or crash recovery.
      // ═══════════════════════════════════════════════════════════════════════════
      try {
        const existingPosition = getPositionFromWebSocket(this.ctx.userId, symbol);
        if (existingPosition && Math.abs(existingPosition.positionAmt) > 0) {
          logger.warn(
            `⚠️ [${symbol}] POSITION ALREADY EXISTS on exchange | ` +
            `qty=${existingPosition.positionAmt} | entryPrice=${existingPosition.entryPrice} | ` +
            `unrealizedPnl=${existingPosition.unrealizedPnl.toFixed(2)} | ` +
            `SKIPPING new entry to prevent double position`
          );
          return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
        }
      } catch (posCheckError) {
        // If we can't verify, log warning but allow entry (conservative approach could block here)
        logger.warn(`⚠️ [${symbol}] Could not verify exchange position status - proceeding with caution`);
      }
    }

    // V5.18: Check if we're at max positions before proceeding
    const openPositionCount = this.ctx.capitalPool.getOpenPositionCount();
    const maxPositions = this.ctx.capitalPool.getMaxPositions();
    if (openPositionCount >= maxPositions) {
      logger.info(`⚠️ [${symbol}] Max positions reached (${openPositionCount}/${maxPositions}) - waiting for existing positions to close | mode=${this.ctx.mode}`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // V5.22: Check if this signal is ranked high enough to execute
    // Calculate how many position slots are available
    const availableSlots = maxPositions - openPositionCount;

    // V5.58: Log ranking state for paper/live parity debugging
    const allPendingSignals = globalSignalRanker.getPendingSignals(this.ctx.mode, this.ctx.userId);
    const slotsConsumed = globalSignalRanker.getSlotsConsumedInBatch(this.ctx.mode, this.ctx.userId);
    if (allPendingSignals.length > 0) {
      const sortedByScore = [...allPendingSignals].sort((a, b) => b.score - a.score);
      const rankingLog = sortedByScore.map((s, i) => `${i + 1}.${s.symbol.replace('/USDT:USDT', '')}(${s.score.toFixed(1)})`).join(' ');
      const effectiveSlots = Math.max(0, availableSlots - slotsConsumed);
      logger.info(`📊 [${symbol.replace('/USDT:USDT', '')}] RANKING CHECK | mode=${this.ctx.mode} | slots=${effectiveSlots}/${maxPositions} (${slotsConsumed} consumed) | signals: ${rankingLog}`);
    }

    const shouldExecute = globalSignalRanker.shouldExecuteSignal(symbol, availableSlots, this.ctx.mode, this.ctx.userId);

    if (!shouldExecute) {
      // V5.58 FIX: Remove deferred signal from pool to prevent stale signals
      // polluting future batches and causing paper/live mismatch
      globalSignalRanker.removeSignal(symbol, this.ctx.mode, this.ctx.userId);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // Signal approved for execution - remove from pending
    globalSignalRanker.removeSignal(symbol, this.ctx.mode, this.ctx.userId);

    // Get available capital from pool
    const availableCapital = this.ctx.capitalPool.getAvailableCapital();
    const poolStatus = this.ctx.capitalPool.getStatus();

    // Log available capital for debugging - include full pool state
    logger.info(`💰 [${symbol}] Capital Pool Status | mode=${this.ctx.mode} | total=$${poolStatus.totalUsd.toFixed(2)} | inPositions=$${poolStatus.inPositionsUsd.toFixed(2)} | available=$${availableCapital.toFixed(2)} | synced=${this.ctx.capitalPool.isSynced()}`);

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

      // 📢 NOTIFICATION: High volatility detected
      notifyHighVolatility({
        symbol,
        atrPct: leverageCalc.atrPct || 0,
        originalLeverage: baseLeverage,
        reducedLeverage: leverageCalc.leverage,
        mode: this.ctx.mode,
        userId: this.ctx.userId,
      });
    }

    // V5.18: Get initial capital for adaptive sizing
    const initialCapitalUsd = this.ctx.capitalPool.getTotalCapital();

    // Calculate position size V5.18 - now with liquidity awareness, dynamic leverage, AND adaptive sizing
    const sizing = calculatePositionSize({
      symbol,
      currentPrice,
      totalCapitalUsd: availableCapital,
      riskPerTradePct: this.ctx.riskPerTradePct,
      stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
      volume24h, // V5.5: Pass volume for liquidity-aware sizing
      safeLeverage: leverageCalc.leverage, // V5.6: Pass ATR-adjusted leverage
      initialCapitalUsd, // V5.18: Pass initial capital for adaptive sizing
    });

    // V5.18: Calculate adaptive sizing % for logging
    const adaptiveSizingPct = Math.min(
      MomentumConfig.RISK.POSITION_SIZE_PCT_BASE + (initialCapitalUsd / 5000) * MomentumConfig.RISK.POSITION_SIZE_PCT_BOOST_PER_5K,
      MomentumConfig.RISK.POSITION_SIZE_PCT_MAX
    );

    // V5.5: Log if position was capped due to liquidity
    if (sizing.wasLiquidityCapped) {
      const targetNotional = availableCapital * adaptiveSizingPct * sizing.suggestedLeverage;
      logger.warn(`🚨 [${symbol}] Position CAPPED by liquidity! Target notional=$${targetNotional.toFixed(0)} → Capped=$${sizing.notionalUsd.toFixed(0)} (max safe=$${sizing.maxSafePosition?.toFixed(0)}, tier=${sizing.liquidityTier})`);
    }

    // 🔧 SAFETY CHECK: Validate position size is reasonable compared to available capital
    // This catches cases where capital sync might have failed or returned wrong values
    const maxReasonableNotional = availableCapital * 10; // Max 10x leverage equivalent
    if (sizing.notionalUsd > maxReasonableNotional) {
      logger.error(`🚫 [${symbol}] POSITION REJECTED - Notional ($${sizing.notionalUsd.toFixed(2)}) exceeds 10x available capital ($${availableCapital.toFixed(2)}). Likely capital sync issue.`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // 🔧 SAFETY CHECK: Margin should not exceed 100% of capital
    if (sizing.marginUsd > availableCapital) {
      logger.error(`🚫 [${symbol}] POSITION REJECTED - Margin ($${sizing.marginUsd.toFixed(2)}) exceeds available capital ($${availableCapital.toFixed(2)}).`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // Check if position size is valid (minimum $20 notional)
    if (sizing.notionalUsd < 20) {
      logger.info(`⚠️ [${symbol}] Cannot open position - insufficient capital (available $${availableCapital.toFixed(2)}, min $20 notional required)`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // Try to reserve MARGIN (not notional) - this is what we actually risk
    // V5.65: reserve() is now async with atomic locking
    if (!await this.ctx.capitalPool.reserve(this.ctx.sessionId, sizing.marginUsd)) {
      logger.info(`⚠️ [${symbol}] Cannot open position - failed to reserve margin $${sizing.marginUsd.toFixed(2)}`);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // V5.5: Include liquidity info in log
    const slippageInfo = sizing.estimatedSlippage ? ` | est.slip=${sizing.estimatedSlippage.toFixed(3)}%` : '';
    const liquidityInfo = sizing.liquidityTier ? ` | tier=${sizing.liquidityTier}` : '';

    // V5.30: Check for multi-position plan (only for large accounts with liquidity caps)
    const multiPlan = sizing.multiPositionPlan;
    if (multiPlan?.enabled && multiPlan.totalPositions > 1) {
      logger.info(`📊 [${symbol}] MULTI-POSITION PLAN ACTIVE | positions=${multiPlan.totalPositions} | perPosition=$${multiPlan.positionSizeUsd.toFixed(0)} | total=$${multiPlan.totalNotionalUsd.toFixed(0)} | efficiency=${(multiPlan.efficiency * 100).toFixed(1)}%`);
    }

    logger.info(`🚀 [${symbol}] OPENING ${side.toUpperCase()} | price=$${currentPrice.toFixed(4)} | qty=${sizing.qty.toFixed(6)} | notional=$${sizing.notionalUsd.toFixed(2)} | margin=$${sizing.marginUsd.toFixed(2)} | lev=${sizing.suggestedLeverage}x${liquidityInfo}${slippageInfo}`);

    // V5.7: Calculate dynamic stop-loss based on ATR
    // V5.85: Now includes tier-based SL for different crypto types
    const slCalc = calcDynamicStopLoss(candles, symbol);
    const slPct = slCalc.slPct;
    if (slCalc.isDynamic) {
      const tierInfo = slCalc.tier ? ` | tier=${slCalc.tier}` : '';
      logger.info(`🎯 [${symbol}] Dynamic SL: ATR=${slCalc.atrPct?.toFixed(2)}%${tierInfo} → SL=${slPct.toFixed(2)}%`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V5.64: WICK BREAKOUT EARLY ENTRY
    // ═══════════════════════════════════════════════════════════════════════════
    // Same shared functions as backtestService.ts for exact parity
    // Entry price is improved when wick touches BB buffer before candle close
    // ═══════════════════════════════════════════════════════════════════════════
    const closes = candles.map((c: Candle) => c.close);
    const bb = calcBollingerBands(closes, MomentumConfig.ENTRY.BB_PERIOD, MomentumConfig.ENTRY.BB_STD);
    const wickBreakout = checkWickBreakout(lastCandle, bb, side);

    // V5.78 FIX: Always use market price (currentPrice = candle close) for entries
    // Wick breakout price is theoretical (achievable during candle formation, not after close)
    const entryPrice = currentPrice;

    if (wickBreakout.triggered && wickBreakout.improvement) {
      // Log wick breakout detection but DON'T use the price
      logger.info(`📊 [${symbol}] WICK BREAKOUT DETECTED (not used) | side=${side.toUpperCase()} | close=$${currentPrice.toFixed(4)} | theoreticalWickEntry=$${wickBreakout.entryPrice?.toFixed(4)} | potentialImprovement=+${(wickBreakout.improvement * 100).toFixed(2)}%`);
    }

    if (this.ctx.mode === 'paper') {
      return this.openPaper(side, symbol, entryPrice, lastCandle, sizing, slPct, multiPlan, wickBreakout);
    } else {
      return this.openLive(side, symbol, entryPrice, currentPrice, lastCandle, candles, sizing, slPct, multiPlan, wickBreakout);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAPER MODE EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  private async openPaper(
    side: 'long' | 'short',
    symbol: string,
    entryPrice: number,
    lastCandle: Candle,
    sizing: ReturnType<typeof calculatePositionSize>,
    slPct: number,
    multiPlan: ReturnType<typeof calculatePositionSize>['multiPositionPlan'],
    wickBreakout: ReturnType<typeof checkWickBreakout>,
  ): Promise<OpenPositionResult> {
    // Paper trade
    // V5.46 FIX: Use candle.timestamp for entryTime (same as backtest)
    const position: Position = {
      symbol,
      side,
      entryPrice,
      qty: sizing.qty,
      entryTime: lastCandle.timestamp,  // V5.46: Use candle timestamp for backtest parity
      realEntryTime: Date.now(),        // V5.86: Actual entry time for stagnant detection
      leverage: sizing.suggestedLeverage,
      marginUsd: sizing.marginUsd,
      stopLoss: side === 'long'
        ? entryPrice * (1 - slPct / 100)
        : entryPrice * (1 + slPct / 100),
      stopLossPct: slPct,
      highWaterMark: side === 'long' ? entryPrice : undefined,
      lowWaterMark: side === 'short' ? entryPrice : undefined,
      positionId: multiPlan?.enabled ? `${this.ctx.sessionId}_0` : undefined,
      groupId: multiPlan?.enabled ? `group_${Date.now()}_${symbol}` : undefined,
      entryIndex: multiPlan?.enabled ? 0 : undefined,
    };

    // Calculate entry fee: 0.04% taker on entry notional
    const paperEntryFee = sizing.notionalUsd * 0.0004;

    // V5.44 FIX: Save to DB FIRST, before committing capital
    // If DB save fails, cancel reservation and don't send notification
    try {
      await this.ctx.savePositionToDb(position, 'paper_entry', paperEntryFee);
    } catch (dbError) {
      logger.error(`❌ [${symbol}] PAPER position DB save failed - cancelling entry:`, dbError);
      this.ctx.capitalPool.cancelReservation(this.ctx.sessionId);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }

    // Commit MARGIN (not notional)
    this.ctx.capitalPool.commit(this.ctx.sessionId, sizing.marginUsd);

    // V5.30: Open additional positions if multi-position plan is active
    const additionalPositions: Position[] = [];
    if (multiPlan?.enabled && multiPlan.totalPositions > 1) {
      const groupId = position.groupId!;
      let totalAdditionalMargin = 0;

      for (let i = 1; i < multiPlan.totalPositions; i++) {
        const addEntryPrice = multiPlan.entryPrices[i];
        const marginPerPosition = multiPlan.positionSizeUsd / sizing.suggestedLeverage;
        const qtyPerPosition = multiPlan.positionSizeUsd / addEntryPrice;

        // V5.73 FIX: Reserve THEN commit for multi-position (atomic protection)
        const multiPosId = `${this.ctx.sessionId}_multi_${i}`;
        if (!await this.ctx.capitalPool.reserve(multiPosId, marginPerPosition)) {
          logger.warn(`⚠️ [${symbol}] Multi-position ${i+1}/${multiPlan.totalPositions} skipped - failed to reserve margin $${marginPerPosition.toFixed(2)}`);
          break;
        }

        const additionalPosition: Position = {
          symbol,
          side,
          entryPrice: addEntryPrice,
          qty: qtyPerPosition,
          entryTime: lastCandle.timestamp,
          leverage: sizing.suggestedLeverage,
          marginUsd: marginPerPosition,
          stopLoss: side === 'long'
            ? addEntryPrice * (1 - slPct / 100)
            : addEntryPrice * (1 + slPct / 100),
          stopLossPct: slPct,
          highWaterMark: side === 'long' ? addEntryPrice : undefined,
          lowWaterMark: side === 'short' ? addEntryPrice : undefined,
          positionId: `${this.ctx.sessionId}_${i}`,
          groupId,
          entryIndex: i,
        };

        additionalPositions.push(additionalPosition);
        totalAdditionalMargin += marginPerPosition;

        // Commit the reserved margin
        this.ctx.capitalPool.commit(multiPosId, marginPerPosition);

        logger.info(`📝 [${symbol}] PAPER MULTI-POS ${i+1}/${multiPlan.totalPositions} @ $${addEntryPrice.toFixed(4)} | margin=$${marginPerPosition.toFixed(2)}`);
      }

      logger.info(`✅ [${symbol}] Opened ${1 + additionalPositions.length} positions | totalMargin=$${(sizing.marginUsd + totalAdditionalMargin).toFixed(2)}`);
    }

    // Log the updated capital state after commit
    const statusAfterCommit = this.ctx.capitalPool.getStatus();
    logger.info(`💰 [${symbol}] Capital after PAPER entry: total=$${statusAfterCommit.totalUsd.toFixed(2)} | inPositions=$${statusAfterCommit.inPositionsUsd.toFixed(2)} | available=$${statusAfterCommit.availableUsd.toFixed(2)}`);

    logger.info(`📝 [${symbol}] PAPER ${side.toUpperCase()} OPENED @ $${entryPrice.toFixed(4)} | notional=$${sizing.notionalUsd.toFixed(2)} | margin=$${sizing.marginUsd.toFixed(2)} | lev=${sizing.suggestedLeverage}x | SL=${slPct.toFixed(2)}% ($${position.stopLoss?.toFixed(4)})`);

    // 📢 Send Telegram notification for paper entry (only after DB confirm)
    void notifyPositionOpened({
      agentId: this.ctx.sessionId,
      symbol,
      side,
      quantity: sizing.qty,
      entryPrice,
      leverage: sizing.suggestedLeverage,
      stopLoss: position.stopLoss,
      mode: 'paper',
      notionalUsd: sizing.notionalUsd,
      marginUsd: sizing.marginUsd,
    });

    // Old notification system (kept for compatibility)
    notifyTradeEntry({
      symbol,
      side,
      price: entryPrice,
      qty: sizing.qty,
      notionalUsd: sizing.notionalUsd,
      marginUsd: sizing.marginUsd,
      leverage: sizing.suggestedLeverage,
      stopLoss: position.stopLoss,
      mode: 'paper',
      userId: this.ctx.userId,
    });

    // V5.89: Start RT exit monitor for paper too (parity with live mode)
    this.ctx.startRealtimeExitMonitorIfNeeded();

    return {
      position,
      additionalPositions,
      lastProcessedExitCandleTs: lastCandle.timestamp,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIVE MODE EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  private async openLive(
    side: 'long' | 'short',
    symbol: string,
    _entryPrice: number,
    currentPrice: number,
    lastCandle: Candle,
    candles: Candle[],
    sizing: ReturnType<typeof calculatePositionSize>,
    slPct: number,
    multiPlan: ReturnType<typeof calculatePositionSize>['multiPositionPlan'],
    wickBreakout: ReturnType<typeof checkWickBreakout>,
  ): Promise<OpenPositionResult> {
    try {
      // 🚫 Check circuit breaker FIRST - don't attempt REST calls if IP is banned
      if (!globalRestCircuitBreaker.canMakeRequest()) {
        const state = globalRestCircuitBreaker.getState();
        const remainingMs = state.closesAt ? state.closesAt - Date.now() : 0;
        const remainingSec = Math.round(remainingMs / 1000);
        logger.warn(`🚫 [${symbol}] REST circuit breaker is OPEN - cannot open position (${remainingSec}s remaining)`);
        this.ctx.capitalPool.cancelReservation(this.ctx.sessionId);
        return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
      }

      // V5.26: Check if markets are loaded before any exchange operation
      const exchangeMarkets = this.ctx.exchange.markets;
      if (!exchangeMarkets || Object.keys(exchangeMarkets).length === 0) {
        if (isIpBanned()) {
          logger.error(`🚫 [${symbol}] Markets not loaded and IP is banned - cannot open position`);
          this.ctx.capitalPool.cancelReservation(this.ctx.sessionId);
          return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
        }
        logger.warn(`⚠️ [${symbol}] Markets not loaded - this should have been done at startup!`);
      }

      // Set leverage - Binance Futures requires integer leverage
      const intLeverage = Math.round(sizing.suggestedLeverage);

      // V5.66: Check leverage cache to avoid redundant API calls
      const userId = this.ctx.userId || 'unknown';
      if (globalCacheManager.isLeverageCached(userId, symbol, intLeverage)) {
        logger.debug(`✅ [${symbol}] Leverage ${intLeverage}x already cached - skipping API call`);
      } else {
        logger.info(`🔧 [${symbol}] Setting leverage: ${sizing.suggestedLeverage} → ${intLeverage} (rounded to integer for Binance)`);

        const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
        try {
          await this.ctx.exchange.setLeverage(intLeverage, symbol);
          ipWeightTracker.record(1, `setLeverage:${symbol}`);
          globalCacheManager.cacheLeverage(userId, symbol, intLeverage);
        } catch (levErr: any) {
          if (levErr?.message?.includes('leverage') || levErr?.code === -1102) {
            logger.warn(`⚠️ [${symbol}] setLeverage failed with CCXT symbol, trying Binance format: ${binanceSymbol}`);
            try {
              await this.ctx.exchange.setLeverage(intLeverage, binanceSymbol);
              ipWeightTracker.record(1, `setLeverage:${binanceSymbol}`);
              logger.info(`✅ [${symbol}] Leverage set successfully with Binance format`);
              globalCacheManager.cacheLeverage(userId, symbol, intLeverage);
            } catch (retryErr: any) {
              logger.error(`❌ [${symbol}] setLeverage failed even with Binance format:`, retryErr?.message);
              throw retryErr;
            }
          } else {
            throw levErr;
          }
        }
      }

      // Format quantity to exchange precision (critical for Binance Futures)
      const formattedQty = this.ctx.formatQtyForExchange(symbol, sizing.qty);

      // Validate formatted quantity is still valid
      if (formattedQty <= 0) {
        logger.error(`❌ [${symbol}] Formatted quantity is 0 or negative (raw: ${sizing.qty})`);
        this.ctx.capitalPool.cancelReservation(this.ctx.sessionId);
        return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
      }

      // ========================================================================
      // ORDER QUEUE INTEGRATION - Submit order via global queue
      // V5.78 FIX: Disabled wick limit orders - always use market order
      // ========================================================================
      const wickConfig = MomentumConfig.WICK_BREAKOUT;
      const useWickLimitOrder = false;  // V5.78: Disabled - use market order for reliability

      let filledPrice: number;
      let filledQty: number;
      let orderId: string | undefined;
      let usedLimitOrder = false;

      if (useWickLimitOrder) {
        // ════════════════════════════════════════════════════════════════════
        // V5.72: LIMIT ORDER AT WICK PRICE
        // ════════════════════════════════════════════════════════════════════
        const limitPrice = wickBreakout.entryPrice!;
        logger.info(`⚡ [${symbol}] WICK LIMIT ORDER | ${side.toUpperCase()} @ $${limitPrice.toFixed(4)} (current: $${currentPrice.toFixed(4)}) | improvement potential: +${(wickBreakout.improvement! * 100).toFixed(2)}%`);

        try {
          const orderSide = side === 'long' ? 'buy' : 'sell';
          const limitOrder = await this.ctx.exchange.createOrder(
            symbol,
            'limit',
            orderSide,
            formattedQty,
            limitPrice,
            { timeInForce: 'GTC' }
          );

          const timeoutMs = wickConfig.LIMIT_ORDER_TIMEOUT_MS || 10_000;
          const startTime = Date.now();
          let lastStatus = limitOrder;

          // Poll for fill
          while ((Date.now() - startTime) < timeoutMs) {
            const filled = (lastStatus.filled || 0) >= formattedQty * 0.99;
            const isClosed = lastStatus.status === 'closed';

            if (filled || isClosed) {
              filledPrice = lastStatus.average || lastStatus.price || limitPrice;
              filledQty = lastStatus.filled || formattedQty;
              orderId = lastStatus.id;
              usedLimitOrder = true;

              const improvement = side === 'long'
                ? ((currentPrice - filledPrice) / currentPrice) * 100
                : ((filledPrice - currentPrice) / currentPrice) * 100;
              logger.info(`✅ [${symbol}] WICK LIMIT FILLED | $${filledPrice.toFixed(4)} | saved ${improvement.toFixed(2)}% vs market`);
              break;
            }

            // Wait and check again
            await new Promise(resolve => setTimeout(resolve, 500));

            // Fetch fresh order status
            try {
              const orders = await this.ctx.exchange.fetchMyTrades?.(symbol, undefined, 1);
              if (orders && orders.length > 0 && orders[0].order === lastStatus.id) {
                lastStatus = { ...lastStatus, filled: orders[0].amount, status: 'closed' };
              }
            } catch {
              // Ignore fetch errors, continue polling
            }
          }

          // If not filled after timeout, cancel and fall back to market
          if (!usedLimitOrder) {
            if (wickConfig.LIMIT_ORDER_FALLBACK) {
              logger.warn(`⏱️ [${symbol}] Limit order timeout after ${timeoutMs}ms - cancelling and using market order`);
              try {
                await this.ctx.exchange.cancelOrder?.(limitOrder.id, symbol);
              } catch (cancelErr) {
                logger.debug(`[${symbol}] Cancel order error (may already be filled/cancelled): ${cancelErr}`);
              }
            } else {
              logger.error(`❌ [${symbol}] Limit order not filled and fallback disabled - aborting entry`);
              try {
                await this.ctx.exchange.cancelOrder?.(limitOrder.id, symbol);
              } catch {
                // Ignore
              }
              this.ctx.capitalPool.cancelReservation(this.ctx.sessionId);
              return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
            }
          }
        } catch (limitErr) {
          logger.warn(`⚠️ [${symbol}] Limit order failed, falling back to market | error: ${limitErr}`);
          // Fall through to market order
        }
      }

      // Market order (default or fallback from limit)
      if (!usedLimitOrder) {
        const orderRequest: OrderRequest = {
          id: uuidv4(),
          agentId: this.ctx.sessionId,
          userId: this.ctx.userId || 'unknown',
          priority: calculateOrderPriority({
            reason: 'signal_entry',
            isEntry: true,
            urgency: 'medium',
          }),
          symbol,
          side: side === 'long' ? 'buy' : 'sell',
          type: 'market',
          quantity: formattedQty,
          params: { reduceOnly: false },
          isEntry: true,
          reason: 'signal_entry',
          priorityContext: {
            isEntry: true,
            reason: 'signal_entry',
            urgency: 'medium',
          },
          submittedAt: Date.now(),
          retries: 0,
          timeoutMs: 30_000,
        };

        logger.info(`[${symbol}] Submitting ${side} MARKET entry order to queue | orderId=${orderRequest.id}`);

        const result = await orderQueue.submitOrder(orderRequest);

        if (!result.success) {
          logger.error(`[${symbol}] Order FAILED: ${result.error} (${result.errorCode})`);
          this.ctx.capitalPool.cancelReservation(this.ctx.sessionId);
          notifyOrderError({
            symbol,
            side,
            orderType: 'entry',
            error: result.error || 'Unknown error',
            mode: this.ctx.mode,
            userId: this.ctx.userId,
          });
          return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
        }

        const order = result.order!;
        filledPrice = order.average || order.price || currentPrice;
        filledQty = order.filled || formattedQty;
        orderId = order.id;
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // V5.65: SLIPPAGE VALIDATION FOR ENTRY ORDERS
      // ═══════════════════════════════════════════════════════════════════════════
      const expectedPrice = currentPrice;
      const entrySlippage = side === 'long'
        ? ((filledPrice! - expectedPrice) / expectedPrice) * 100
        : ((expectedPrice - filledPrice!) / expectedPrice) * 100;

      const maxEntrySlippage = MomentumConfig.EXIT.MAX_ENTRY_SLIPPAGE_PCT ?? 1.0;

      if (entrySlippage > maxEntrySlippage) {
        logger.warn(
          `⚠️ [${symbol}] HIGH ENTRY SLIPPAGE | ` +
          `expected=$${expectedPrice.toFixed(4)} | filled=$${filledPrice!.toFixed(4)} | ` +
          `slippage=${entrySlippage.toFixed(2)}% (max=${maxEntrySlippage}%)`
        );
      } else if (entrySlippage > 0.1) {
        logger.info(`📊 [${symbol}] Entry slippage: ${entrySlippage.toFixed(3)}%`);
      }

      // V5.46 FIX: Use candle.timestamp for entryTime (same as backtest)
      const entryTimeMs = lastCandle.timestamp;

      const position: Position = {
        symbol,
        side,
        entryPrice: filledPrice!,
        qty: filledQty!,
        entryTime: entryTimeMs,
        realEntryTime: Date.now(),
        leverage: sizing.suggestedLeverage,
        marginUsd: sizing.marginUsd,
        stopLoss: side === 'long'
          ? filledPrice! * (1 - slPct / 100)
          : filledPrice! * (1 + slPct / 100),
        stopLossPct: slPct,
        orderId: orderId,
        highWaterMark: side === 'long' ? filledPrice! : undefined,
        lowWaterMark: side === 'short' ? filledPrice! : undefined,
        positionId: multiPlan?.enabled ? `${this.ctx.sessionId}_0` : undefined,
        groupId: multiPlan?.enabled ? `group_${Date.now()}_${symbol}` : undefined,
        entryIndex: multiPlan?.enabled ? 0 : undefined,
      };

      // Commit MARGIN (not notional)
      this.ctx.capitalPool.commit(this.ctx.sessionId, sizing.marginUsd);

      // V5.30: Open additional positions if multi-position plan is active (LIVE mode)
      const additionalPositions: Position[] = [];
      if (multiPlan?.enabled && multiPlan.totalPositions > 1) {
        const groupId = position.groupId!;

        for (let i = 1; i < multiPlan.totalPositions; i++) {
          const targetEntryPrice = multiPlan.entryPrices[i];
          const marginPerPosition = multiPlan.positionSizeUsd / sizing.suggestedLeverage;
          const qtyPerPosition = this.ctx.formatQtyForExchange(symbol, multiPlan.positionSizeUsd / targetEntryPrice);

          // V5.73 FIX: Reserve FIRST with atomic protection
          const multiPosId = `${this.ctx.sessionId}_multi_${i}`;
          if (!await this.ctx.capitalPool.reserve(multiPosId, marginPerPosition)) {
            logger.warn(`⚠️ [${symbol}] LIVE multi-pos ${i+1}/${multiPlan.totalPositions} skipped - failed to reserve margin $${marginPerPosition.toFixed(2)}`);
            break;
          }

          // Submit additional order via queue
          const additionalOrderRequest: OrderRequest = {
            id: uuidv4(),
            agentId: this.ctx.sessionId,
            userId: this.ctx.userId || 'unknown',
            priority: calculateOrderPriority({
              reason: 'signal_entry',
              isEntry: true,
              urgency: 'medium',
            }),
            symbol,
            side: side === 'long' ? 'buy' : 'sell',
            type: 'market',
            quantity: qtyPerPosition,
            params: { reduceOnly: false },
            isEntry: true,
            reason: `multi_entry_${i+1}`,
            priorityContext: {
              isEntry: true,
              reason: 'signal_entry',
              urgency: 'medium',
            },
            submittedAt: Date.now(),
            retries: 0,
            timeoutMs: 30_000,
          };

          logger.info(`[${symbol}] Submitting multi-pos ${i+1}/${multiPlan.totalPositions} | orderId=${additionalOrderRequest.id}`);

          const additionalResult = await orderQueue.submitOrder(additionalOrderRequest);

          if (!additionalResult.success) {
            logger.error(`[${symbol}] Multi-pos ${i+1} FAILED: ${additionalResult.error}`);
            // V5.73 FIX: Cancel reservation if order fails
            this.ctx.capitalPool.cancelReservation(multiPosId);
            continue;
          }

          const addOrder = additionalResult.order!;
          const addFilledPrice = addOrder.average || addOrder.price || targetEntryPrice;
          const addFilledQty = addOrder.filled || qtyPerPosition;

          const additionalPosition: Position = {
            symbol,
            side,
            entryPrice: addFilledPrice,
            qty: addFilledQty,
            entryTime: addOrder.timestamp || Date.now(),
            leverage: sizing.suggestedLeverage,
            marginUsd: marginPerPosition,
            stopLoss: side === 'long'
              ? addFilledPrice * (1 - slPct / 100)
              : addFilledPrice * (1 + slPct / 100),
            stopLossPct: slPct,
            orderId: addOrder.id,
            highWaterMark: side === 'long' ? addFilledPrice : undefined,
            lowWaterMark: side === 'short' ? addFilledPrice : undefined,
            positionId: `${this.ctx.sessionId}_${i}`,
            groupId,
            entryIndex: i,
          };

          additionalPositions.push(additionalPosition);
          // Commit the reserved margin
          this.ctx.capitalPool.commit(multiPosId, marginPerPosition);

          // Set SL for this position too
          await this.ctx.setStopLossOnExchange(additionalPosition);

          logger.info(`🟢 [${symbol}] LIVE MULTI-POS ${i+1}/${multiPlan.totalPositions} @ $${addFilledPrice.toFixed(4)} | margin=$${marginPerPosition.toFixed(2)}`);

          // Delay between orders to avoid rate limits
          await new Promise(r => setTimeout(r, 500));
        }

        logger.info(`✅ [${symbol}] Opened ${1 + additionalPositions.length} LIVE positions`);
      }

      // Log the updated capital state after commit
      const statusAfterCommit = this.ctx.capitalPool.getStatus();
      logger.info(`💰 [${symbol}] Capital after LIVE entry: total=$${statusAfterCommit.totalUsd.toFixed(2)} | inPositions=$${statusAfterCommit.inPositionsUsd.toFixed(2)} | available=$${statusAfterCommit.availableUsd.toFixed(2)}`);

      // Extract entry fee from CCXT order, fallback to 0.04% calculation
      const liveEntryNotional = filledQty! * filledPrice!;
      const liveEntryFee = liveEntryNotional * 0.0004;

      // Exchange-side protection: EMERGENCY STOP ONLY (wide, crash protection)
      const baseSlPct = position.stopLossPct || 2.0;
      const emergencyTargetPct = baseSlPct * (MomentumConfig.EXIT.EMERGENCY_STOP_MULTIPLIER || 2.5);
      const emergencyMaxPct = MomentumConfig.EXIT.EMERGENCY_STOP_MAX_PCT ?? 3.0;
      const emergencySlPct = Math.min(emergencyTargetPct, emergencyMaxPct);
      const emergencyStop = position.side === 'long'
        ? position.entryPrice * (1 - emergencySlPct / 100)
        : position.entryPrice * (1 + emergencySlPct / 100);

      position.stopLoss = emergencyStop;
      position.emergencyStopPrice = emergencyStop;
      await this.ctx.setStopLossOnExchange(position);

      logger.info(`🛡️ [${symbol}] Emergency STOP_MARKET set @ $${emergencyStop.toFixed(4)} (${emergencySlPct.toFixed(2)}%) | trailing exit = app-side`);

      // Save to DB with fee
      await this.ctx.savePositionToDb(position, 'live_entry', liveEntryFee);

      // Realtime app-side exits (WS-based) for fast trailing/stoploss reaction.
      this.ctx.startRealtimeExitMonitorIfNeeded();

      // Optional: native exchange trailing (disabled by default)
      if (MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) {
        const trailingSuccess = await this.ctx.setTrailingStopOnExchange(position);

        if (trailingSuccess) {
          logger.info(`✅ [${symbol}] DUAL PROTECTION: Fixed SL @ $${position.stopLoss?.toFixed(4)} + Trailing @ +0.8%`);
        } else {
          logger.warn(`⚠️ [${symbol}] SINGLE PROTECTION: Only fixed SL active (trailing failed)`);
        }
      }

      logger.info(`🟢 [${symbol}] LIVE ${side.toUpperCase()} OPENED @ $${filledPrice!} | qty=${filledQty!} | margin=$${sizing.marginUsd.toFixed(2)} | notional=$${sizing.notionalUsd.toFixed(2)} | lev=${sizing.suggestedLeverage}x | SL=$${position.stopLoss?.toFixed(4)}`);

      // 📢 Send Telegram notification for live entry
      void notifyPositionOpened({
        agentId: this.ctx.sessionId,
        symbol,
        side,
        quantity: filledQty!,
        entryPrice: filledPrice!,
        leverage: sizing.suggestedLeverage,
        stopLoss: position.stopLoss,
        mode: 'live',
        notionalUsd: sizing.notionalUsd,
        marginUsd: sizing.marginUsd,
      });

      // Old notification system (kept for compatibility)
      notifyTradeEntry({
        symbol,
        side,
        price: filledPrice!,
        qty: filledQty!,
        notionalUsd: sizing.notionalUsd,
        marginUsd: sizing.marginUsd,
        leverage: sizing.suggestedLeverage,
        stopLoss: position.stopLoss,
        mode: 'live',
        userId: this.ctx.userId,
      });

      this.ctx.onTrade?.({
        symbol,
        side: side === 'long' ? 'buy' : 'sell',
        qty: filledQty!,
        price: filledPrice!,
        orderId: orderId!,
        timestamp: new Date(),
      });

      return {
        position,
        additionalPositions,
        lastProcessedExitCandleTs: lastCandle.timestamp,
      };

    } catch (error: unknown) {
      // Enhanced error logging for debugging
      const err = error as Record<string, unknown>;
      logger.error(`❌ [${symbol}] Failed to open live position:`, {
        name: err?.name,
        message: err?.message,
        code: err?.code,
        info: err?.info,
      });

      // 📢 NOTIFICATION: Order error (CRITICAL in live mode)
      notifyOrderError({
        symbol,
        side,
        orderType: 'entry',
        error: errMsg(error),
        mode: 'live',
        userId: this.ctx.userId,
      });

      // Cancel reservation on failure
      this.ctx.capitalPool.cancelReservation(this.ctx.sessionId);
      return { position: null, additionalPositions: [], lastProcessedExitCandleTs: null };
    }
  }
}
