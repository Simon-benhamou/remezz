/**
 * RealtimeExitHandler - Extracted from SimpleAgent.
 * Owns all real-time exit state and logic: checkRealtimeExit(), NFS system,
 * proactive limit tracking, trailing breach detection, kline-based exits.
 */

import {
  MomentumConfig,
  shouldExitPosition,
  updatePositionWaterMarks,
  type Candle,
  type Position,
} from './momentumSimple.js';
import { createLogger, runWithUserId } from '../utils/logger.js';
import {
  getBinanceWebSocket,
} from '../services/binanceWebSocket.js';
import {
  NfsCalculator,
  NfsExitStateMachine,
  createNfsExitSystem,
  type NfsConfig,
  type NfsResult,
  type Candle as NfsCandle,
} from '../services/nfsRealtimeExit.js';
import {
  MomentumExhaustionCalculator,
  type ExhaustionResult,
  type ExhaustionCandle,
} from '../services/momentumExhaustion.js';
import {
  EXIT_TRAIL_RT,
  EXIT_TRAIL_NFS_HIGH,
  EXIT_TRAIL_NFS_MED,
  EXIT_TRAIL_NFS_LOW,
  EXIT_TRAIL_PROACTIVE,
  EXIT_TRAIL_CRASH_SAFETY,
  EXIT_SL_RT,
  EXIT_STAGNANT,
} from '../types/exitReasons.js';
import { WS_THROTTLE } from '../config/constants.js';
import type { ExchangeOrderManager } from './exchangeOrderManager.js';

const logger = createLogger('rt-exit');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RealtimeExitContext {
  symbol: string;
  mode: 'paper' | 'live';
  userId: string;

  // Read-only accessors
  getPosition: () => Position | null;
  isRunning: () => boolean;
  isClosingPosition: () => boolean;
  setClosingPosition: (val: boolean) => void;

  // Data fetchers
  fetchCandles: () => Promise<Candle[]>;

  // Exchange order manager for proactive limits
  orderManager: ExchangeOrderManager;

  // Exit callback
  closePosition: (position: Position, price: number, reason: string) => Promise<void>;

  // State mutation
  setLastPrice: (price: number) => void;

  // Position mutation (for watermark updates)
  setPosition: (position: Position) => void;
}

export class RealtimeExitHandler {
  // RT exit state
  private realtimeExitInProgress = false;
  private rtBreachSinceMs: number | null = null;
  private rtBreachTicks = 0;
  private rtTrailingBreachCandles = 0;
  private nfsBreachCount = 0;
  private lastNfsResult: NfsResult | null = null;
  private lastRtTrailingKlineTs: number | null = null;
  private lastAppTrailingStop: number | null = null;
  private lastWsUnhealthyWarnTs = 0;
  private static readonly WS_UNHEALTHY_WARN_THROTTLE_MS = WS_THROTTLE.UNHEALTHY_WARN_MS;

  // Trailing tracking (for frontend display)
  trailingActivatedAt: number | null = null;
  trailingUpdateCount: number = 0;

  private intervalId: NodeJS.Timeout | null = null;

  // NFS system
  private nfsCalculator: NfsCalculator | null = null;
  nfsStateMachine: NfsExitStateMachine | null = null;

  // Momentum exhaustion detector (V5.110)
  private exhaustionCalculator: MomentumExhaustionCalculator | null = null;
  private lastExhaustionScore: number = 0;

  // Proactive stop state (V5.110: STOP_MARKET, was LIMIT)
  proactiveLimitOrderId: string | null = null;
  proactiveLimitPrice: number | null = null;

  // V5.136: Crash safety STOP state (permanent 3% below trailing)
  private crashSafetyOrderId: string | null = null;
  private crashSafetyPrice: number | null = null;

  constructor(private ctx: RealtimeExitContext) {}

  // ═══════════════════════════════════════════════════════════════════════
  // NFS SYSTEM INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  initializeNfsSystem(): void {
    const nfsEnabled = MomentumConfig.EXIT.NFS_ENABLED ?? false;
    if (!nfsEnabled) {
      logger.debug(`[${this.ctx.symbol}] NFS system disabled`);
      return;
    }

    const exitConfig = MomentumConfig.EXIT;
    const nfsConfig: Partial<NfsConfig> = {
      HIGH_CONFIDENCE_THRESHOLD: exitConfig.NFS_HIGH_SCORE_THRESHOLD ?? 70,
      MEDIUM_CONFIDENCE_THRESHOLD: exitConfig.NFS_MEDIUM_SCORE_THRESHOLD ?? 40,
      LIMIT_ORDER_TIMEOUT_MS: exitConfig.NFS_LIMIT_ORDER_TIMEOUT_MS ?? 3000,
      MAX_SLIPPAGE_PCT: exitConfig.NFS_MAX_SLIPPAGE_PCT ?? 0.5,
      PARTIAL_FILL_MIN_RATIO: exitConfig.NFS_PARTIAL_FILL_MIN_RATIO ?? 0.7,
      WEIGHTS: {
        breachATR: {
          threshold: exitConfig.NFS_BREACH_ATR_THRESHOLD ?? 0.40,
          weight: exitConfig.NFS_WEIGHT_BREACH_ATR ?? 35
        },
        breachDepth: {
          threshold: exitConfig.NFS_BREACH_DEPTH_THRESHOLD ?? 0.25,
          weight: exitConfig.NFS_WEIGHT_BREACH_DEPTH ?? 25
        },
        volumeRatio: {
          threshold: exitConfig.NFS_VOLUME_RATIO_THRESHOLD ?? 1.5,
          weight: exitConfig.NFS_WEIGHT_VOLUME ?? 20
        },
        candleBody: {
          threshold: exitConfig.NFS_CANDLE_BODY_RATIO_THRESHOLD ?? 0.5,
          weight: exitConfig.NFS_WEIGHT_CANDLE_BODY ?? 10
        },
        momentum: {
          threshold: exitConfig.NFS_MOMENTUM_ROC5_THRESHOLD ?? 0.5,
          weight: exitConfig.NFS_WEIGHT_MOMENTUM ?? 10
        },
      },
    };

    const { calculator, stateMachine } = createNfsExitSystem(
      nfsConfig,
      (oldState, newState) => {
        logger.info(`[${this.ctx.symbol}] NFS state: ${oldState} → ${newState}`);
      }
    );

    this.nfsCalculator = calculator;
    this.nfsStateMachine = stateMachine;
    logger.info(`[${this.ctx.symbol}] NFS system initialized | high=${nfsConfig.HIGH_CONFIDENCE_THRESHOLD} medium=${nfsConfig.MEDIUM_CONFIDENCE_THRESHOLD}`);

    // V5.110: Initialize momentum exhaustion detector
    const exhaustionEnabled = (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED ?? true;
    if (exhaustionEnabled) {
      this.exhaustionCalculator = new MomentumExhaustionCalculator({
        PLACEMENT_THRESHOLD: (MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD ?? 25,
        CANCEL_THRESHOLD: (MomentumConfig.EXIT as any).EXHAUSTION_CANCEL_THRESHOLD ?? 15,
        MIN_CANDLES: (MomentumConfig.EXIT as any).EXHAUSTION_MIN_CANDLES ?? 10,
        SHARP_REVERSAL_ENABLED: (MomentumConfig.EXIT as any).EXHAUSTION_SHARP_REVERSAL_ENABLED ?? false,
      });
      logger.info(`[${this.ctx.symbol}] Exhaustion detector initialized | place=${(MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD ?? 25} cancel=${(MomentumConfig.EXIT as any).EXHAUSTION_CANCEL_THRESHOLD ?? 15}`);
    }
  }

  getNfsStateMachine(): NfsExitStateMachine | null {
    return this.nfsStateMachine;
  }

  getNfsCalculator(): NfsCalculator | null {
    return this.nfsCalculator;
  }

  getLastNfsResult(): NfsResult | null {
    return this.lastNfsResult;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // START / STOP
  // ═══════════════════════════════════════════════════════════════════════

  startIfNeeded(): void {
    if (!this.ctx.isRunning()) return;
    if (!this.ctx.getPosition()) return;
    if (!MomentumConfig.EXIT.REALTIME_APP_EXIT_ENABLED) return;
    if (this.intervalId) return;

    const pollMs = Math.max(250, Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_POLL_MS ?? 1000));

    this.rtBreachSinceMs = null;
    this.rtBreachTicks = 0;
    this.lastAppTrailingStop = null;
    this.lastRtTrailingKlineTs = null;
    this.rtTrailingBreachCandles = 0;
    // V5.105: Removed setClosingPosition(false) — was breaking the re-entry guard in closePosition().
    // When closePosition() failed and restarted the RT monitor, this reset allowed immediate re-entry
    // into closePosition(), causing an infinite exit loop. closingPosition is managed by closePosition() only.

    // If realtime trailing is enabled and we use kline-close mode, subscribe to 1m klines.
    try {
      const trailingEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_ENABLED ?? false);
      const trailingMode = MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_MODE as string | undefined;
      const klineInterval = MomentumConfig.EXIT.REALTIME_APP_EXIT_KLINE_INTERVAL as string | undefined;
      if (trailingEnabled && trailingMode === 'kline_1m_close') {
        const ws = getBinanceWebSocket();
        ws.subscribeToKline(this.ctx.symbol, klineInterval || '1m');
      }
    } catch {
      // Non-fatal
    }

    this.intervalId = setInterval(() => {
      void runWithUserId(this.ctx.userId, () => this.check()).catch(err => {
        logger.debug(`⚠️ [${this.ctx.symbol}] Realtime exit check error: ${errMsg(err)}`);
      });
    }, pollMs);

    const trailingEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_ENABLED ?? false);
    const slEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_STOPLOSS_ENABLED ?? true);
    const trailingMode = MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_MODE as string | undefined;
    const mode = trailingEnabled
      ? (slEnabled ? `trail(${trailingMode || 'ticker'})+sl` : `trail(${trailingMode || 'ticker'})`)
      : (slEnabled ? 'sl_only' : 'disabled');
    logger.info(`📡 [${this.ctx.symbol}] Realtime WS exits enabled (poll ${pollMs}ms, mode=${mode})`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.rtBreachSinceMs = null;
    this.rtBreachTicks = 0;
    this.lastAppTrailingStop = null;
    this.lastRtTrailingKlineTs = null;
    this.rtTrailingBreachCandles = 0;
    this.realtimeExitInProgress = false;

    // V5.136: Cancel crash safety STOP on exit
    if (this.crashSafetyOrderId) {
      void this.ctx.orderManager.cancelCrashSafetyStop(this.ctx.symbol).catch(() => {});
      this.crashSafetyOrderId = null;
      this.crashSafetyPrice = null;
    }
  }

  resetState(): void {
    this.nfsBreachCount = 0;
    this.lastNfsResult = null;
    this.proactiveLimitOrderId = null;
    this.proactiveLimitPrice = null;
    this.crashSafetyOrderId = null;
    this.crashSafetyPrice = null;
    if (this.nfsStateMachine) {
      this.nfsStateMachine.reset();
    }
    this.trailingActivatedAt = null;
    this.trailingUpdateCount = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROACTIVE LIMIT HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private async placeProactiveLimit(
    symbol: string, orderSide: 'buy' | 'sell', qty: number, price: number,
  ): Promise<string | null> {
    return this.ctx.orderManager.placeProactiveLimit(symbol, orderSide, qty, price);
  }

  private async cancelProactiveLimit(symbol: string): Promise<void> {
    const orderId = this.proactiveLimitOrderId;
    if (!orderId) return;

    // Clear local state first
    this.proactiveLimitOrderId = null;
    this.proactiveLimitPrice = null;

    // Sync to orderManager and cancel
    this.ctx.orderManager.proactiveLimitOrderId = orderId;
    this.ctx.orderManager.proactiveLimitPrice = null;
    await this.ctx.orderManager.cancelProactiveLimit(symbol, this.nfsStateMachine);
  }

  private async checkProactiveLimitFill(symbol: string, position: Position | null, lastPrice: number): Promise<{ filled: boolean; avgPrice: number } | null> {
    // Sync state to orderManager for checking
    this.ctx.orderManager.proactiveLimitOrderId = this.proactiveLimitOrderId;
    this.ctx.orderManager.proactiveLimitPrice = this.proactiveLimitPrice;
    return this.ctx.orderManager.checkProactiveLimitFill(symbol, position, lastPrice);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN CHECK METHOD (~650 lines)
  // ═══════════════════════════════════════════════════════════════════════

  private async check(): Promise<void> {
    if (!this.ctx.isRunning()) return;
    if (!MomentumConfig.EXIT.REALTIME_APP_EXIT_ENABLED) return;
    if (this.realtimeExitInProgress) return;
    if (this.ctx.isClosingPosition()) return;

    const position = this.ctx.getPosition();
    if (!position) return;

    this.realtimeExitInProgress = true;
    try {
      const symbol = this.ctx.symbol;

      // ═══════════════════════════════════════════════════════════════════
      // V5.136: Check crash safety STOP fill FIRST (critical path)
      // ═══════════════════════════════════════════════════════════════════
      if (this.crashSafetyOrderId) {
        const crashFill = await this.ctx.orderManager.checkCrashSafetyFill(symbol, position, 0);
        if (crashFill?.filled) {
          this.stop();
          logger.warn(
            `🚨🚨🚨 [${symbol}] CRASH SAFETY STOP FILLED @ $${crashFill.avgPrice.toFixed(4)} | ` +
            `crashPrice=$${this.crashSafetyPrice?.toFixed(4)} | FLASH CRASH DETECTED`
          );
          this.crashSafetyOrderId = null;
          this.crashSafetyPrice = null;
          await this.ctx.closePosition(position, crashFill.avgPrice, EXIT_TRAIL_CRASH_SAFETY);
          return;
        }
        // If order was cancelled (e.g. by cancelAllOrders), orderManager clears its state.
        // Detect this and clear local state — will be re-placed below.
        if (!this.ctx.orderManager.getCrashSafetyOrderId()) {
          this.crashSafetyOrderId = null;
          this.crashSafetyPrice = null;
        }
      }

      // WebSocket ticker is 0 weight; if WS is not receiving data we do nothing here.
      const ws = getBinanceWebSocket();
      const wsConnected = ws.isConnectedAndReceiving();
      const wsHealthy = ws.isHealthy();

      if (!wsConnected) {
        const now = Date.now();
        if (now - this.lastWsUnhealthyWarnTs >= RealtimeExitHandler.WS_UNHEALTHY_WARN_THROTTLE_MS) {
          this.lastWsUnhealthyWarnTs = now;
          const status = ws.getHealthStatus();
          logger.warn(`⚠️ [${symbol}] WebSocket NOT CONNECTED - realtime exit monitoring paused | connected=${status.isConnected}, tickers=${status.tickerCount}, lastUpdate=${status.lastUpdateAge}ms ago`);
        }
        return;
      }

      // If connected but not strictly "healthy", just log debug (no warning spam)
      if (!wsHealthy) {
        logger.debug(`[${symbol}] WebSocket connected but stale - continuing with cached data`);
      }

      // Clear throttle timestamp when connected
      this.lastWsUnhealthyWarnTs = 0;

      const ticker = ws.getTicker(symbol);
      if (!ticker) {
        logger.debug(`⚠️ [${symbol}] No ticker data from WebSocket`);
        return;
      }
      const tickerTs = Number.isFinite(Number(ticker.timestamp)) ? Number(ticker.timestamp) : Date.now();
      if (Date.now() - tickerTs > 10_000) return;

      const useMid = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_USE_MID_PRICE ?? true);
      const mid = ticker.bid > 0 && ticker.ask > 0 ? (ticker.bid + ticker.ask) / 2 : 0;
      const currentPrice = useMid && mid > 0 ? mid : ticker.last;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

      this.ctx.setLastPrice(currentPrice);

      const rtTrailingEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_ENABLED ?? false);
      const rtStoplossEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_STOPLOSS_ENABLED ?? true);
      const trailingMode = MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_MODE as string | undefined;

      // ──────────────────────────────────────────────────────────────────
      // 🚨 CRITICAL: Check REGIME_CHANGE and MOMENTUM_REVERSAL FIRST
      // ──────────────────────────────────────────────────────────────────
      try {
        const symbolCandles = await this.ctx.fetchCandles();
        const candles = symbolCandles.length > 1 ? symbolCandles.slice(0, -1) : symbolCandles;

        // ⚠️  STRATEGIC EXITS ONLY ON 15M CLOSE
        // Regime change and momentum reversal are checked in checkExit() on 15m candle close
        // for 100% backtest parity. Ticker monitor focuses only on protective stops.
      } catch (err) {
        logger.debug(`[${symbol}] Failed to monitor in RT: ${errMsg(err)}`);
        // Continue to stop loss check if monitoring fails
      }

      // ──────────────────────────────────────────────────────────────────
      // 1) STOPLOSS realtime (ticker-based, protective)
      // ──────────────────────────────────────────────────────────────────
      if (rtStoplossEnabled) {
        const bufferPct = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_BUFFER_PCT ?? 0.05);
        const confirmMs = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_MS ?? 1800);
        const confirmTicks = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_TICKS ?? 2);
        const now = Date.now();

        // V5.28 FIX: If trailing is active, use trailing stop instead of fixed SL
        const trailingActive = position.trailingActive && position.appTrailingStop;

        // V5.36: Use stagnant state from position
        const isStagnantConfirmed = position.stagnantState?.confirmed && !position.stagnantState?.cancelled;
        const stagnantTightenSlRatio = MomentumConfig.EXIT.STAGNANT_TRADE_TIGHTEN_SL_RATIO ?? 0.5;
        const currentBaseSl = position.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;

        // V5.84: Stagnant SL respects adaptive SL — ratio of current base SL
        const effectiveSlPct = isStagnantConfirmed
          ? currentBaseSl * stagnantTightenSlRatio
          : currentBaseSl;

        const fixedSlPrice = position.side === 'long'
          ? position.entryPrice * (1 - effectiveSlPct / 100)
          : position.entryPrice * (1 + effectiveSlPct / 100);

        const slPrice = trailingActive ? position.appTrailingStop! : fixedSlPrice;

        const slBreach = position.side === 'long'
          ? currentPrice <= slPrice * (1 - bufferPct / 100)
          : currentPrice >= slPrice * (1 + bufferPct / 100);

        if (!slBreach) {
          this.rtBreachSinceMs = null;
          this.rtBreachTicks = 0;
        } else {
          if (this.rtBreachSinceMs == null) {
            this.rtBreachSinceMs = now;
            this.rtBreachTicks = 1;
          } else {
            this.rtBreachTicks += 1;
          }

          const elapsed = now - (this.rtBreachSinceMs ?? now);
          const confirmed = elapsed >= confirmMs || this.rtBreachTicks >= confirmTicks;
          if (confirmed) {
            this.stop();
            let exitReason: string;
            let stopType: string;
            if (trailingActive) {
              exitReason = EXIT_TRAIL_RT;
              stopType = 'trailing';
            } else if (isStagnantConfirmed) {
              exitReason = EXIT_STAGNANT;
              stopType = 'stagnant';
            } else {
              exitReason = EXIT_SL_RT;
              stopType = 'fixed';
            }
            const holdMinutes = (now - position.entryTime) / 60000;
            const maxPnlRaw = position.maxPnlPct ?? 0;
            logger.info(
              `⚡ [${symbol}] REALTIME EXIT confirmed (${exitReason}) price=$${currentPrice.toFixed(4)} ${stopType}_sl=$${slPrice.toFixed(4)} sl_pct=${effectiveSlPct.toFixed(1)}% | confirm=${Math.round(elapsed)}ms/${this.rtBreachTicks}ticks${isStagnantConfirmed ? ` | STAGNANT: held ${Math.round(holdMinutes)}m, maxPnl=${maxPnlRaw.toFixed(2)}%` : ''}`,
            );
            await this.ctx.closePosition(position, currentPrice, exitReason);
            return;
          }
        }
      }

      // ──────────────────────────────────────────────────────────────────
      // 2) TRAILING realtime (noise-filtered)
      // ──────────────────────────────────────────────────────────────────
      if (!rtTrailingEnabled) return;

      if (trailingMode === 'kline_1m_close') {
        const interval = (MomentumConfig.EXIT.REALTIME_APP_EXIT_KLINE_INTERVAL as string | undefined) || '1m';
        const confirmCandles = Math.max(1, Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_KLINE_CONFIRM_CANDLES ?? 2));

        // Ensure we are subscribed.
        ws.subscribeToKline(symbol, interval);

        const klines = ws.getKlines(symbol, interval);
        const last = klines && klines.length ? klines[klines.length - 1] : null;

        if (!last) {
          logger.debug(`⚠️ [${symbol}] No 1m klines received from WebSocket yet`);
          return;
        }

        if (!last.isFinal) {
          // ═══════════════════════════════════════════════════════════════
          // V5.110: On non-final candles — only check if proactive STOP filled
          // (Exhaustion detection runs on CLOSED candles for reliable data)
          // ═══════════════════════════════════════════════════════════════
          if (this.proactiveLimitOrderId && position) {
            const fillResult = await this.checkProactiveLimitFill(symbol, position, currentPrice);
            if (fillResult?.filled) {
              const execPx = fillResult.avgPrice;
              this.stop();
              logger.info(
                `🎯🎯🎯 [${symbol}] EXHAUSTION STOP FILLED (intra-candle) @ $${execPx.toFixed(4)} | ` +
                `trailing=$${this.proactiveLimitPrice?.toFixed(4)} | exhaustion=${this.lastExhaustionScore.toFixed(0)}`
              );
              this.proactiveLimitOrderId = null;
              this.proactiveLimitPrice = null;
              await this.ctx.closePosition(position, execPx, EXIT_TRAIL_PROACTIVE);
              return;
            }
          }

          const now = Date.now();
          const candleAge = now - last.timestamp;
          logger.debug(`⏳ [${symbol}] Waiting for 1m candle to close (age: ${Math.round(candleAge/1000)}s, close: ${last.close.toFixed(4)})`);
          return;
        }

        // Process once per newly-closed 1m candle.
        if (this.lastRtTrailingKlineTs === last.timestamp) return;

        const detectionDelay = Date.now() - (last.closeTime || last.timestamp);
        logger.info(`📍 [${symbol}] NEW 1m candle closed | close=${last.close.toFixed(4)} | detection_delay=${detectionDelay}ms`);
        this.lastRtTrailingKlineTs = last.timestamp;

        // ═══════════════════════════════════════════════════════════════════
        // V5.110: Check if exhaustion STOP_MARKET was filled during this candle
        // ═══════════════════════════════════════════════════════════════════
        if (this.proactiveLimitOrderId && position) {
          const fillResult = await this.checkProactiveLimitFill(symbol, position, currentPrice);
          if (fillResult?.filled) {
            const execPx = fillResult.avgPrice;
            this.stop();
            logger.info(
              `🔋🔋🔋 [${symbol}] EXHAUSTION STOP FILLED @ $${execPx.toFixed(4)} | ` +
              `trailing=$${this.proactiveLimitPrice?.toFixed(4)} | ` +
              `exhaustion=${this.lastExhaustionScore.toFixed(0)}`
            );
            this.proactiveLimitOrderId = null;
            this.proactiveLimitPrice = null;
            await this.ctx.closePosition(position, execPx, EXIT_TRAIL_PROACTIVE);
            return;
          }
        }

        // Update trailing state using the candle close for breach detection.
        const closePx = last.close;
        if (!Number.isFinite(closePx) || closePx <= 0) return;

        const priceHigh = last.high;
        const priceLow = last.low;

        // V5.25 FIX: Update watermarks with 1m candle data
        const updatedPosition = updatePositionWaterMarks(position, closePx, priceHigh, priceLow);
        this.ctx.setPosition(updatedPosition);

        const symbolCandles = await this.ctx.fetchCandles();
        const candles = symbolCandles.length > 1 ? symbolCandles.slice(0, -1) : symbolCandles;

        const exitSignal = shouldExitPosition(updatedPosition, closePx, candles, {
          nowMs: Date.now(),
          priceHigh,
          priceLow,
          btcCandles: undefined,
        });

        const candidateStop = exitSignal.newStopLoss;
        if (Number.isFinite(Number(candidateStop))) {
          this.lastAppTrailingStop = candidateStop as number;
          updatedPosition.appTrailingStop = candidateStop as number;
        }

        // V5.26: Persist trailing activation
        if (exitSignal.trailingActivated) {
          if (!updatedPosition.trailingActive) {
            this.trailingActivatedAt = Date.now();
          }
          updatedPosition.trailingActive = true;
        }

        // V5.72: Track trailing stop updates
        if (updatedPosition.appTrailingStop && updatedPosition.appTrailingStop !== this.lastAppTrailingStop) {
          this.trailingUpdateCount++;
        }

        // ═══════════════════════════════════════════════════════════════════
        // V5.136: CRASH SAFETY STOP — place/update when trailing is active
        // Permanent STOP_MARKET 3% below trailing stop. Flash crash insurance.
        // Re-placed on every trailing ratchet (>0.1% move) and after cancelAllOrders.
        // ═══════════════════════════════════════════════════════════════════
        if (updatedPosition.trailingActive && updatedPosition.appTrailingStop) {
          const crashEnabled = (MomentumConfig.EXIT as any).CRASH_SAFETY_STOP_ENABLED ?? false;
          if (crashEnabled) {
            const crashDistPct = (MomentumConfig.EXIT as any).CRASH_SAFETY_DISTANCE_PCT ?? 3.0;
            const side = updatedPosition.side;
            const trailingStop = updatedPosition.appTrailingStop;
            const newCrashPrice = side === 'long'
              ? trailingStop * (1 - crashDistPct / 100)
              : trailingStop * (1 + crashDistPct / 100);

            if (!this.crashSafetyOrderId) {
              // Place new crash safety (first time or after cancel)
              const orderSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy';
              const orderId = await this.ctx.orderManager.placeCrashSafetyStop(
                symbol, orderSide, updatedPosition.qty, newCrashPrice,
              );
              if (orderId) {
                this.crashSafetyOrderId = orderId;
                this.crashSafetyPrice = newCrashPrice;
                logger.info(`🛡️ [${symbol}] Crash safety STOP placed @ $${newCrashPrice.toFixed(4)} (trail=$${trailingStop.toFixed(4)} -${crashDistPct}%)`);
              }
            } else if (this.crashSafetyPrice && Math.abs(newCrashPrice - this.crashSafetyPrice) / this.crashSafetyPrice > 0.001) {
              // Trailing ratcheted — update crash safety (cancel + re-place)
              await this.ctx.orderManager.cancelCrashSafetyStop(symbol);
              const orderSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy';
              const orderId = await this.ctx.orderManager.placeCrashSafetyStop(
                symbol, orderSide, updatedPosition.qty, newCrashPrice,
              );
              if (orderId) {
                this.crashSafetyOrderId = orderId;
                this.crashSafetyPrice = newCrashPrice;
              }
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════════
        // V5.110: EXHAUSTION-BASED PROACTIVE STOP
        // Runs on CLOSED candles (reliable data, not partial candle noise).
        // When momentum exhaustion is detected, places STOP_MARKET at trailing.
        // The exhaustion score IS the noise filter — replaces blind wick stops.
        // ═══════════════════════════════════════════════════════════════════
        if (this.exhaustionCalculator && updatedPosition.trailingActive && updatedPosition.appTrailingStop && klines && klines.length > 0) {
          const trailingStop = updatedPosition.appTrailingStop;
          const side = updatedPosition.side;

          // Build candle array from closed 1m klines for exhaustion calc
          const exhaustionCandles: ExhaustionCandle[] = (klines || [])
            .filter(k => k.isFinal)
            .slice(-20)
            .map(k => ({
              timestamp: k.timestamp,
              open: k.open,
              high: k.high,
              low: k.low,
              close: k.close,
              volume: k.volume || 0,
            }));

          const exhaustionResult = this.exhaustionCalculator.calculate(
            exhaustionCandles, side, trailingStop, closePx,
          );
          this.lastExhaustionScore = exhaustionResult.score;
          const exhaustionConfig = this.exhaustionCalculator.getConfig();

          if (exhaustionResult.shouldPlaceStop) {
            // Exhaustion confirmed — ensure STOP_MARKET is at trailing
            const orderSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy';

            if (!this.proactiveLimitOrderId) {
              // No stop order yet — place one
              logger.info(
                `🔋 [${symbol}] EXHAUSTION DETECTED (${exhaustionResult.score.toFixed(0)}/100): ` +
                `ROC=${exhaustionResult.components.rocDeceleration} vol=${exhaustionResult.components.volumeDryUp} ` +
                `body=${exhaustionResult.components.bodyShrinkage} wick=${exhaustionResult.components.rejectionWicks} ` +
                `prox=${exhaustionResult.components.proximityToTrailing} | ` +
                `placing STOP_MARKET @ $${trailingStop.toFixed(4)}`
              );
              try {
                const plOrderId = await this.placeProactiveLimit(symbol, orderSide, updatedPosition.qty, trailingStop);
                if (plOrderId) {
                  this.proactiveLimitOrderId = plOrderId;
                  this.proactiveLimitPrice = trailingStop;
                  if (this.nfsStateMachine) {
                    this.nfsStateMachine.setProactiveLimitOrderPending(plOrderId, trailingStop);
                  }
                  logger.info(`🔋 [${symbol}] Exhaustion STOP_MARKET placed: orderId=${plOrderId} @ $${trailingStop.toFixed(4)}`);
                }
              } catch (e) {
                logger.warn(`[${symbol}] Failed to place exhaustion STOP_MARKET: ${e}`);
              }
            } else if (this.proactiveLimitPrice && Math.abs(trailingStop - this.proactiveLimitPrice) / this.proactiveLimitPrice > 0.001) {
              // Trailing stop moved by > 0.1% — update the stop order
              logger.info(
                `🔋 [${symbol}] Trailing stop moved: $${this.proactiveLimitPrice.toFixed(4)} → $${trailingStop.toFixed(4)} | ` +
                `exhaustion=${exhaustionResult.score.toFixed(0)} | updating STOP_MARKET`
              );
              try {
                await this.cancelProactiveLimit(symbol);
                const plOrderId = await this.placeProactiveLimit(symbol, orderSide, updatedPosition.qty, trailingStop);
                if (plOrderId) {
                  this.proactiveLimitOrderId = plOrderId;
                  this.proactiveLimitPrice = trailingStop;
                  if (this.nfsStateMachine) {
                    this.nfsStateMachine.setProactiveLimitOrderPending(plOrderId, trailingStop);
                  }
                }
              } catch (e) {
                logger.warn(`[${symbol}] Failed to update exhaustion STOP_MARKET: ${e}`);
              }
            }
          } else if (this.proactiveLimitOrderId && exhaustionResult.score < exhaustionConfig.CANCEL_THRESHOLD) {
            // Exhaustion score dropped below cancel threshold (hysteresis)
            // Momentum recovered — cancel the stop
            logger.info(
              `🔋 [${symbol}] Exhaustion RECOVERED (${exhaustionResult.score.toFixed(0)}/${exhaustionConfig.CANCEL_THRESHOLD}) — cancelling STOP_MARKET`
            );
            try {
              await this.cancelProactiveLimit(symbol);
            } catch (e) {
              logger.warn(`[${symbol}] Failed to cancel exhaustion STOP_MARKET: ${e}`);
            }
          }
        }

        // ONLY react to trailing exits in realtime
        // V5.117c FIX: shouldExitPosition returns {shouldExit:false, reason:'trailing_breach'}
        // for close breaches (caller handles confirmation). The old check for
        // 'trailing' with shouldExit=true NEVER matched, so NFS logic below never ran.
        if (exitSignal.reason !== 'trailing_breach') {
          if (this.rtTrailingBreachCandles > 0 || this.nfsBreachCount > 0) {
            logger.info(`✅ [${symbol}] Trailing breach CLEARED (was ${this.rtTrailingBreachCandles}/${confirmCandles}, nfs=${this.nfsBreachCount}) | close=${closePx.toFixed(4)} | stop=${(candidateStop as number | undefined)?.toFixed(4) || 'n/a'}`);
          }
          this.rtTrailingBreachCandles = 0;
          this.nfsBreachCount = 0;
          this.lastNfsResult = null;
          if (this.nfsStateMachine) {
            this.nfsStateMachine.reset();
          }
          // V5.117c: Exhaustion STOP persists — only cancelled by hysteresis (score < 20).
          return;
        }

        // ═══════════════════════════════════════════════════════════════════
        // V5.110: If exhaustion STOP is in play and breach confirmed, check fill
        // ═══════════════════════════════════════════════════════════════════
        if (this.proactiveLimitOrderId && position) {
          const fillResult = await this.checkProactiveLimitFill(symbol, position, currentPrice);
          if (fillResult?.filled) {
            const execPx = fillResult.avgPrice;
            this.stop();
            logger.info(
              `🔋🔋🔋 [${symbol}] EXHAUSTION STOP FILLED on breach confirm @ $${execPx.toFixed(4)} | ` +
              `trailing=$${this.proactiveLimitPrice?.toFixed(4)} | exhaustion=${this.lastExhaustionScore.toFixed(0)}`
            );
            this.proactiveLimitOrderId = null;
            this.proactiveLimitPrice = null;
            await this.ctx.closePosition(position, execPx, EXIT_TRAIL_PROACTIVE);
            return;
          }
          // Exhaustion STOP didn't fill yet — cancel and fall through to normal NFS logic
          logger.info(`🔋 [${symbol}] Exhaustion STOP not filled on breach — cancelling, using normal NFS flow`);
          await this.cancelProactiveLimit(symbol);
        }

        // ═══════════════════════════════════════════════════════════════════
        // NFS INTEGRATION: Use Noise Filter Score for smarter exit decisions
        // ═══════════════════════════════════════════════════════════════════
        const nfsEnabled = MomentumConfig.EXIT.NFS_ENABLED ?? false;
        const trailingStopPrice = candidateStop as number;

        if (nfsEnabled && this.nfsCalculator && trailingStopPrice && klines && klines.length > 0) {
          const nfsCandles: NfsCandle[] = klines.slice(-25).map(k => ({
            timestamp: k.timestamp,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume || 0,
            isFinal: k.isFinal,
          }));

          const currentNfsCandle: NfsCandle = {
            timestamp: last.timestamp,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close,
            volume: last.volume || 0,
            isFinal: true,
          };

          // Calculate NFS score
          const nfsResult = this.nfsCalculator.calculate(
            currentNfsCandle,
            nfsCandles.slice(0, -1),
            updatedPosition.side,
            trailingStopPrice
          );
          this.lastNfsResult = nfsResult;
          this.nfsBreachCount++;

          const stopPrice = trailingStopPrice.toFixed(4);
          logger.warn(
            `🚨 [${symbol}] NFS TRAILING BREACH (${this.nfsBreachCount}/${confirmCandles}) | NFS=${nfsResult.score.toFixed(0)} (${nfsResult.confidence}) | close=${closePx.toFixed(4)} | stop=${stopPrice} | action=${nfsResult.recommendation}`,
          );

          logger.debug(
            `[${symbol}] NFS components: breachATR=${nfsResult.components.breachATRRatio.toFixed(3)} breachDepth=${nfsResult.components.breachDepthPct.toFixed(3)}% vol=${nfsResult.components.volumeRatio.toFixed(2)}x body=${nfsResult.components.candleBodyRatio.toFixed(2)} roc5=${nfsResult.components.momentumROC5.toFixed(3)}%`
          );

          // ═══════════════════════════════════════════════════════════════════
          // V5.62: NFS_ADAPTIVE EXIT LOGIC (matches backtest)
          // ═══════════════════════════════════════════════════════════════════
          if (nfsResult.shouldExitImmediately) {
            // HIGH confidence — exit immediately at trailing stop price (target).
            // V5.92/V5.134 lesson: trailingStopPrice is the TARGET the system achieves via
            // proactive STOP_MARKET placement. Exiting on 1m is faster than waiting for 15m,
            // saving time. The exhaustion detector should have placed a STOP_MARKET at this
            // price already; NFS HIGH confirms the breach is real, not noise.
            this.stop();
            const execPx = trailingStopPrice;
            logger.info(
              `⚡⚡⚡ [${symbol}] NFS HIGH EXIT (score=${nfsResult.score.toFixed(0)}) | exec=${execPx.toFixed(4)} | stop=${stopPrice} | close=${closePx.toFixed(4)} | reason=high_confidence_breach`,
            );
            await this.ctx.closePosition(updatedPosition, execPx, EXIT_TRAIL_NFS_HIGH);
            return;
          } else {
            // V5.90: MED/LOW confidence — defer to 15m layer to avoid 1m noise exits
            // Only HIGH NFS exits from RT (strong signal, needs fast execution).
            // MED/LOW are noise-prone on 1m klines — let 15m candle close confirm.
            logger.info(
              `⏳ [${symbol}] NFS ${nfsResult.confidence} (score=${nfsResult.score.toFixed(0)}) on 1m — deferring to 15m layer (breaches=${this.nfsBreachCount})`,
            );
          }
        }

        // ═══════════════════════════════════════════════════════════════════
        // V5.90: Only count RT breach candles when NFS is disabled (legacy mode)
        // When NFS is enabled, MED/LOW are deferred to 15m layer — no RT exit.
        // ═══════════════════════════════════════════════════════════════════
        if (!nfsEnabled) {
          this.rtTrailingBreachCandles += 1;
          const stopPriceStr = (candidateStop as number | undefined)?.toFixed(4) || 'n/a';

          logger.warn(
            `🚨 [${symbol}] TRAILING BREACH detected! (${this.rtTrailingBreachCandles}/${confirmCandles}) | close=${closePx.toFixed(4)} | stop=${stopPriceStr} | side=${updatedPosition.side}`,
          );

          if (this.rtTrailingBreachCandles < confirmCandles) {
            logger.info(`⏳ [${symbol}] Waiting for confirmation... (need ${confirmCandles - this.rtTrailingBreachCandles} more candle${confirmCandles - this.rtTrailingBreachCandles > 1 ? 's' : ''})`);
            return;
          }

          this.stop();
          const trailingStopPx = candidateStop ?? updatedPosition.appTrailingStop ?? this.lastAppTrailingStop;
          const execPx = closePx;
          const exitReason = EXIT_TRAIL_RT;
          logger.info(
            `⚡⚡⚡ [${symbol}] REALTIME EXIT CONFIRMED (${exitReason}, 2-close) | exec=${execPx.toFixed(4)} | trailStop=${trailingStopPx?.toFixed(4) ?? 'n/a'} | close=${closePx.toFixed(4)} | confirmCandles=${confirmCandles}`,
          );
          await this.ctx.closePosition(updatedPosition, execPx, exitReason);
          return;
        }
      }

      // Fallback: ticker-based trailing (legacy).
      const updatedPosition = updatePositionWaterMarks(position, currentPrice, currentPrice, currentPrice);
      this.ctx.setPosition(updatedPosition);

      const symbolCandles = await this.ctx.fetchCandles();
      const candles = symbolCandles.length > 1 ? symbolCandles.slice(0, -1) : symbolCandles;

      const exitSignal = shouldExitPosition(updatedPosition, currentPrice, candles, {
        nowMs: Date.now(),
        priceHigh: currentPrice,
        priceLow: currentPrice,
      });

      const candidateStop = exitSignal.newStopLoss;
      if (Number.isFinite(Number(candidateStop))) {
        this.lastAppTrailingStop = candidateStop as number;
        updatedPosition.appTrailingStop = candidateStop as number;
      }

      if (exitSignal.trailingActivated) {
        if (!updatedPosition.trailingActive) {
          this.trailingActivatedAt = Date.now();
        }
        updatedPosition.trailingActive = true;
      }

      if (!(exitSignal.shouldExit && exitSignal.reason === 'trailing')) {
        this.rtBreachSinceMs = null;
        this.rtBreachTicks = 0;
        return;
      }

      const bufferPct = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_BUFFER_PCT ?? 0.05);
      const confirmMs = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_MS ?? 1800);
      const confirmTicks = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_TICKS ?? 2);
      const now = Date.now();
      const stopPrice = candidateStop as number | undefined;
      if (!stopPrice) return;

      const breach = updatedPosition.side === 'long'
        ? currentPrice <= stopPrice * (1 - bufferPct / 100)
        : currentPrice >= stopPrice * (1 + bufferPct / 100);

      if (!breach) {
        this.rtBreachSinceMs = null;
        this.rtBreachTicks = 0;
        return;
      }

      if (this.rtBreachSinceMs == null) {
        this.rtBreachSinceMs = now;
        this.rtBreachTicks = 1;
        logger.debug(`🔎 [${symbol}] Realtime trailing breach started (ticker) price=$${currentPrice.toFixed(4)} stop=$${stopPrice.toFixed(4)}`);
        return;
      }

      this.rtBreachTicks += 1;
      const elapsed = now - this.rtBreachSinceMs;
      const confirmed = elapsed >= confirmMs || this.rtBreachTicks >= confirmTicks;
      if (!confirmed) return;

      this.stop();
      const trailingStopPx = updatedPosition.appTrailingStop ?? this.lastAppTrailingStop ?? stopPrice;
      logger.info(`⚡ [${symbol}] REALTIME EXIT confirmed (trailing_rt) price=$${currentPrice.toFixed(4)} exitAt=$${trailingStopPx.toFixed(4)} | confirm=${Math.round(elapsed)}ms/${this.rtBreachTicks}ticks`);
      await this.ctx.closePosition(updatedPosition, trailingStopPx, EXIT_TRAIL_RT);
    } finally {
      this.realtimeExitInProgress = false;
    }
  }
}
