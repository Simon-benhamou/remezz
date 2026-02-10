/**
 * SymbolEngine - Phase 1: Signal Computation Sharing
 *
 * One instance per actively-traded symbol. Computes signals ONCE per symbol
 * instead of N times (once per user agent). All user sessions can subscribe
 * to its results, reducing candle-close CPU from O(N×M) to O(M).
 *
 * Phase 1: Compute signals independently and log for comparison.
 * Phase 2+: Agents consume SymbolEngine results directly.
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import {
  checkMomentumSignal,
  getMarketConditions,
  detectMarketRegime,
  calcROC,
  calcATR,
  calcBBPosition,
  calcVolRatio,
  calcTrendStrength,
  type Candle,
  type SignalResult,
  type MarketConditions,
  type MarketRegime,
} from './momentumSimple.js';
import { calculateSignalScore } from './signalRanker.js';
import { getKlinesWithMeta, toBinanceSymbolId } from '../services/binanceWebSocket.js';
import { globalCacheManager } from './cacheManager.js';
import { type SignalFeatures } from '../services/signalRadarService.js';

const logger = createLogger('symbol-engine');

const TICK_INTERVAL_MS = 15_000; // 15 seconds, aligned with agent ticks
const MIN_CANDLES = 61;           // Minimum candles for indicators (match agent threshold)
const MIN_BTC_15M_CANDLES = 201;  // Need 200 for SMA200 + 1 current (match agent + checkMomentumSignal)
const MIN_BTC_1H_CANDLES = 201;   // Need 200 for SMA200 regime + 1 current (match backtest)

export interface SymbolSignalResult {
  signal: SignalResult;
  score: number;
  features: SignalFeatures | null;
  marketConditions: MarketConditions | null;
  regime: MarketRegime | null;
  timestamp: number;
  /** Timestamp of the closed candle that triggered this signal */
  candleCloseTs: number;
  /** Closed candles used for signal computation (agents can reuse for position sizing) */
  closedCandles: Candle[];
  /** BTC 15m closed candles used */
  btcCandles: Candle[];
  /** BTC 1h closed candles used */
  btcCandles1h: Candle[];
  /** Current price from latest candle (including in-progress) */
  currentPrice: number;
}

export class SymbolEngine extends EventEmitter {
  private symbol: string;
  private shortSymbol: string;
  private lastProcessedCandleTs: number = 0;
  private tickInterval: NodeJS.Timeout | null = null;
  private candles: Candle[] = [];
  private lastSignal: SymbolSignalResult | null = null;
  private marketConditions: MarketConditions | null = null;
  private running: boolean = false;
  private tickCount: number = 0;
  private tickInProgress: boolean = false;

  constructor(symbol: string) {
    super();
    this.symbol = symbol;
    this.shortSymbol = symbol.split('/')[0]; // "BTC/USDT:USDT" → "BTC"
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(`[SymbolEngine] Starting engine for ${this.shortSymbol}`);

    // Start tick loop
    this.tickInterval = setInterval(() => {
      this.tick().catch(err => {
        logger.error(`[SymbolEngine] [${this.shortSymbol}] Tick error: ${err?.message || err}`);
      });
    }, TICK_INTERVAL_MS);

    // Run first tick immediately
    this.tick().catch(err => {
      logger.error(`[SymbolEngine] [${this.shortSymbol}] Initial tick error: ${err?.message || err}`);
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    logger.info(`[SymbolEngine] Stopped engine for ${this.shortSymbol}`);
    this.removeAllListeners();
  }

  private async tick(): Promise<void> {
    // Re-entrancy guard (matches agent pattern)
    if (this.tickInProgress) return;
    this.tickInProgress = true;

    try {
      await this.tickInner();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async tickInner(): Promise<void> {
    this.tickCount++;

    // 1. Get symbol candles from WS cache
    const binanceSymbol = toBinanceSymbolId(this.symbol);
    const rawCandles = getKlinesWithMeta(binanceSymbol, '15m');
    if (!rawCandles || rawCandles.length < MIN_CANDLES) {
      if (this.tickCount % 10 === 1) {
        logger.debug(`[SymbolEngine] [${this.shortSymbol}] Waiting for candles (${rawCandles?.length || 0}/${MIN_CANDLES})`);
      }
      return;
    }

    // Convert to Candle format (getKlinesWithMeta already returns the right shape)
    this.candles = rawCandles as Candle[];

    // 2. Get BTC 15m candles from global cache (need 200+ for SMA200 in checkMomentumSignal)
    const btcCache = globalCacheManager.getBtc15mCache();
    if (!btcCache || !btcCache.candles || btcCache.candles.length < MIN_BTC_15M_CANDLES) {
      if (this.tickCount % 10 === 1) {
        logger.debug(`[SymbolEngine] [${this.shortSymbol}] Waiting for BTC 15m cache (${btcCache?.candles?.length || 0}/${MIN_BTC_15M_CANDLES})`);
      }
      return;
    }
    const allBtcCandles15m = btcCache.candles;

    // 3. Get BTC 1h candles from global cache
    const btc1hCache = globalCacheManager.getBtc1hCache();
    const allBtcCandles1h = btc1hCache?.candles || [];
    const btcCandles1h = allBtcCandles1h.filter(c => c.isFinal !== false);

    if (btcCandles1h.length < MIN_BTC_1H_CANDLES) {
      if (this.tickCount % 10 === 1) {
        logger.debug(`[SymbolEngine] [${this.shortSymbol}] Waiting for BTC 1h data (${btcCandles1h.length}/${MIN_BTC_1H_CANDLES})`);
      }
      return;
    }

    // 4. Filter to closed candles only (matching agent's checkEntry logic exactly)
    const lastCandle = this.candles[this.candles.length - 1];
    let lastClosedIdx = this.candles.length - 1;
    if (lastCandle.isFinal === false) {
      lastClosedIdx = this.candles.length - 2;
    }
    if (lastClosedIdx < 0) return;
    const closedCandles = this.candles.slice(0, lastClosedIdx + 1);
    const lastClosedCandleTs = closedCandles[closedCandles.length - 1].timestamp;

    // Filter BTC 15m to closed candles too (matching agent logic)
    let btcLastClosedIdx = allBtcCandles15m.length - 1;
    if (allBtcCandles15m.length > 0 && allBtcCandles15m[btcLastClosedIdx].isFinal === false) {
      btcLastClosedIdx = allBtcCandles15m.length - 2;
    }
    const btcCandles = btcLastClosedIdx >= 0
      ? allBtcCandles15m.slice(0, btcLastClosedIdx + 1)
      : allBtcCandles15m;

    const isNewCandle = lastClosedCandleTs !== this.lastProcessedCandleTs;

    // Emit tick event on every tick (for subscribers that want real-time data)
    this.emit('tick', {
      symbol: this.symbol,
      price: lastCandle.close,
      timestamp: Date.now(),
      isNewCandle,
    });

    // 5. Only compute signal on new candle close
    if (!isNewCandle) return;

    this.lastProcessedCandleTs = lastClosedCandleTs;
    const now = Date.now();

    try {
      // 6. Compute signal using same function as agents (with closed candles only)
      const signal = checkMomentumSignal(this.symbol, closedCandles, btcCandles, {
        nowMs: now,
        btcCandles1h,
      });

      // 7. Compute market conditions
      this.marketConditions = getMarketConditions(btcCandles, btcCandles1h);

      // 8. Compute regime
      let regime: MarketRegime | null = null;
      try {
        regime = detectMarketRegime(btcCandles, btcCandles1h);
      } catch {
        // detectMarketRegime may throw if insufficient data
      }

      // 9. Compute signal score and features if signal has data
      let score = 0;
      let features: SignalFeatures | null = null;
      const currentPrice = lastCandle.close;

      const f = signal.features;
      if (f) {
        const closes = closedCandles.map(c => c.close);

        const roc5 = f.roc5 ?? calcROC(closes, 5);
        const volRatio = f.volRatio;
        const bbPosition = calcBBPosition(closedCandles);
        const atrRaw = calcATR(closedCandles);
        const atrPct = atrRaw ? (atrRaw / currentPrice) * 100 : 0;
        const trendStrength = calcTrendStrength(closes);

        if (signal.valid && signal.side) {
          score = calculateSignalScore({
            roc5,
            volumeRatio: volRatio,
            bbPosition,
            atrPct,
            trendStrength,
            side: signal.side,
          });
        }

        // Compute BB distance for features
        const bbDistance = f.btcInBullRegime
          ? ((currentPrice - (f.bbUpper || currentPrice)) / currentPrice) * 100
          : (((f.bbLower || currentPrice) - currentPrice) / currentPrice) * 100;

        features = {
          roc: f.roc || 0,
          volRatio,
          bbDistance,
          atrPct,
          trendStrength,
        };
      }

      // 10. Store result with candle data for agent consumption
      this.lastSignal = {
        signal,
        score,
        features,
        marketConditions: this.marketConditions,
        regime,
        timestamp: now,
        candleCloseTs: lastClosedCandleTs,
        closedCandles,
        btcCandles,
        btcCandles1h,
        currentPrice,
      };

      // 11. Emit signal event
      this.emit('signal', this.lastSignal);

      // 12. Log for monitoring
      if (signal.valid) {
        logger.info(
          `[SymbolEngine] [${this.shortSymbol}] SIGNAL: ${signal.side} score=${score.toFixed(2)} ` +
          `reason="${signal.reason}" regime=${regime || 'unknown'}`
        );
      } else if (this.tickCount % 20 === 0) {
        // Periodic heartbeat log (every ~5 minutes)
        logger.debug(
          `[SymbolEngine] [${this.shortSymbol}] No signal (reason: ${signal.reason || 'none'}) ` +
          `regime=${regime || 'unknown'}`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[SymbolEngine] [${this.shortSymbol}] Signal computation error: ${msg}`);
    }
  }

  // Public getters

  getCandles(): Candle[] {
    return this.candles;
  }

  getMarketConditions(): MarketConditions | null {
    return this.marketConditions;
  }

  getLastSignal(): SymbolSignalResult | null {
    return this.lastSignal;
  }

  getSymbol(): string {
    return this.symbol;
  }

  isRunning(): boolean {
    return this.running;
  }

  getTickCount(): number {
    return this.tickCount;
  }
}
