/**
 * Signal Generator - Per-Symbol Signal Calculation
 *
 * Calculates trading signals for a specific symbol and broadcasts to all subscribed agents.
 * This eliminates redundant calculations when multiple agents trade the same symbol.
 *
 * Benefits:
 * - 100× CPU reduction (1 calculation vs 100 agents calculating the same signal)
 * - Consistent signals across all agents (same entry/exit triggers)
 * - Centralized signal logic (easier to update strategy)
 * - Lower memory footprint (shared candle data)
 *
 * Architecture:
 * 1. Receives candle updates from WebSocket manager
 * 2. Calculates momentum signal (V5.36+ logic)
 * 3. Broadcasts to SignalBroker
 * 4. Agents subscribe via SignalBroker to receive updates
 */

import { logger } from '../../utils/logger.js';
import { signalBroker } from './signalBroker.js';
import type { Candle } from '../../types/market.js';

export interface SignalContext {
  symbol: string;
  timeframe: string;
  price: number;
  signal: 'long' | 'short' | 'neutral';
  strength: number; // 0-100
  roc: number;
  volumeRatio: number;
  btcTrend: 'bullish' | 'bearish' | 'neutral';
  mtfAlignment: boolean;
  calculatedAt: number;
}

export interface SignalGeneratorConfig {
  symbol: string;
  timeframe: string;
  updateIntervalMs: number; // How often to recalculate (e.g., 15000 = 15s)
}

/**
 * SignalGenerator - Calculates signals for one symbol
 */
export class SignalGenerator {
  private symbol: string;
  private timeframe: string;
  private updateIntervalMs: number;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  // Cached candle data (shared across agents)
  private candles1h: Candle[] = [];
  private candles2h: Candle[] = [];
  private btcCandles1h: Candle[] = [];

  // Last calculated signal
  private lastSignal: SignalContext | null = null;

  constructor(config: SignalGeneratorConfig) {
    this.symbol = config.symbol;
    this.timeframe = config.timeframe;
    this.updateIntervalMs = config.updateIntervalMs;
  }

  /**
   * Start signal generation
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn(`[SignalGenerator] ${this.symbol} already running`);
      return;
    }

    this.isRunning = true;

    logger.info(`[SignalGenerator] Starting for ${this.symbol} (interval: ${this.updateIntervalMs}ms)`);

    // Initial calculation
    await this.calculateAndBroadcast();

    // Set up periodic calculation
    this.intervalTimer = setInterval(async () => {
      await this.calculateAndBroadcast();
    }, this.updateIntervalMs);
  }

  /**
   * Stop signal generation
   */
  stop(): void {
    if (!this.isRunning) return;

    logger.info(`[SignalGenerator] Stopping ${this.symbol}`);

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    this.isRunning = false;
  }

  /**
   * Update candle data (called by WebSocket manager)
   */
  updateCandles(timeframe: string, candles: Candle[]): void {
    if (timeframe === '1h') {
      if (candles[0]?.symbol === this.symbol) {
        this.candles1h = candles;
      } else if (candles[0]?.symbol === 'BTC/USDT:USDT' || candles[0]?.symbol === 'BTCUSDT') {
        this.btcCandles1h = candles;
      }
    } else if (timeframe === '2h' && candles[0]?.symbol === this.symbol) {
      this.candles2h = candles;
    }

    // Trigger immediate recalculation on new candle
    if (this.isRunning) {
      this.calculateAndBroadcast().catch((error) => {
        logger.error(`[SignalGenerator] ${this.symbol} calculation error:`, error);
      });
    }
  }

  /**
   * Calculate signal and broadcast to subscribers
   */
  private async calculateAndBroadcast(): Promise<void> {
    try {
      const signal = await this.calculateSignal();

      if (signal) {
        this.lastSignal = signal;

        // Broadcast to SignalBroker
        signalBroker.broadcastSignal(this.symbol, signal);

        logger.debug(`[SignalGenerator] ${this.symbol} signal: ${signal.signal} (strength: ${signal.strength})`);
      }
    } catch (error) {
      logger.error(`[SignalGenerator] ${this.symbol} calculation failed:`, error);
    }
  }

  /**
   * Calculate momentum signal (V5.36+ strategy logic)
   *
   * This implements the SAME logic as SimpleAgent.detectMomentumSignal()
   * to ensure consistency across all agents.
   */
  private async calculateSignal(): Promise<SignalContext | null> {
    // Require minimum candles
    if (this.candles1h.length < 50 || this.candles2h.length < 30 || this.btcCandles1h.length < 50) {
      return null;
    }

    const currentCandle = this.candles1h[this.candles1h.length - 1];
    const price = currentCandle.close;

    // Calculate BTC trend (MA50)
    const btcMa50 = this.calculateMA(this.btcCandles1h, 50);
    const btcPrice = this.btcCandles1h[this.btcCandles1h.length - 1].close;
    const btcTrend: 'bullish' | 'bearish' | 'neutral' =
      btcPrice > btcMa50 * 1.005 ? 'bullish' :
      btcPrice < btcMa50 * 0.995 ? 'bearish' : 'neutral';

    // Calculate Rate of Change (2h candles, 6 periods = 12h)
    const roc = this.calculateROC(this.candles2h, 6);

    // Calculate volume ratio
    const volumeRatio = this.calculateVolumeRatio(this.candles1h, 20);

    // MTF alignment (1h and 2h trends align)
    const ma20_1h = this.calculateMA(this.candles1h, 20);
    const ma20_2h = this.calculateMA(this.candles2h, 20);
    const trend1h = price > ma20_1h ? 'bullish' : 'bearish';
    const trend2h = price > ma20_2h ? 'bullish' : 'bearish';
    const mtfAlignment = trend1h === trend2h;

    // Signal detection logic (matches V5.36+)
    let signal: 'long' | 'short' | 'neutral' = 'neutral';
    let strength = 0;

    // Long signal conditions
    if (
      roc > 3.0 && // Strong upward momentum (was ROC_MIN=3)
      volumeRatio > 2.0 && // Volume surge (was VOL_MULTIPLIER=2)
      btcTrend === 'bullish' && // BTC trending up
      mtfAlignment && // 1h and 2h aligned
      trend1h === 'bullish'
    ) {
      signal = 'long';
      strength = Math.min(100, Math.floor(roc * 10 + volumeRatio * 5));
    }
    // Short signal conditions
    else if (
      roc < -3.0 && // Strong downward momentum
      volumeRatio > 2.0 && // Volume surge
      btcTrend === 'bearish' && // BTC trending down
      mtfAlignment && // 1h and 2h aligned
      trend2h === 'bearish'
    ) {
      signal = 'short';
      strength = Math.min(100, Math.floor(Math.abs(roc) * 10 + volumeRatio * 5));
    }

    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      price,
      signal,
      strength,
      roc,
      volumeRatio,
      btcTrend,
      mtfAlignment,
      calculatedAt: Date.now(),
    };
  }

  /**
   * Calculate Simple Moving Average
   */
  private calculateMA(candles: Candle[], period: number): number {
    if (candles.length < period) return 0;

    const relevantCandles = candles.slice(-period);
    const sum = relevantCandles.reduce((acc, c) => acc + c.close, 0);
    return sum / period;
  }

  /**
   * Calculate Rate of Change
   */
  private calculateROC(candles: Candle[], periods: number): number {
    if (candles.length < periods + 1) return 0;

    const currentPrice = candles[candles.length - 1].close;
    const pastPrice = candles[candles.length - 1 - periods].close;

    return ((currentPrice - pastPrice) / pastPrice) * 100;
  }

  /**
   * Calculate Volume Ratio (current vs average)
   */
  private calculateVolumeRatio(candles: Candle[], period: number): number {
    if (candles.length < period + 1) return 0;

    const currentVolume = candles[candles.length - 1].volume;
    const avgVolume = candles
      .slice(-period - 1, -1)
      .reduce((sum, c) => sum + c.volume, 0) / period;

    return avgVolume > 0 ? currentVolume / avgVolume : 0;
  }

  /**
   * Get last calculated signal (for new subscribers)
   */
  getLastSignal(): SignalContext | null {
    return this.lastSignal;
  }

  /**
   * Get running status
   */
  getStatus(): {
    symbol: string;
    isRunning: boolean;
    lastSignalAt: number | null;
    candleCount: { '1h': number; '2h': number; 'btc1h': number };
  } {
    return {
      symbol: this.symbol,
      isRunning: this.isRunning,
      lastSignalAt: this.lastSignal?.calculatedAt || null,
      candleCount: {
        '1h': this.candles1h.length,
        '2h': this.candles2h.length,
        'btc1h': this.btcCandles1h.length,
      },
    };
  }
}
