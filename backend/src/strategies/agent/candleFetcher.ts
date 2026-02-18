/**
 * candleFetcher.ts — Candle Data Acquisition
 *
 * V5.108: Extracted from orchestrator.ts (formerly simpleAgent.ts).
 * Handles all candle fetching for the agent: symbol 15m, BTC 15m, BTC 1h.
 *
 * Data sources (priority order):
 *   1. WebSocket kline streams (0 API weight)
 *   2. Global cache (shared between agents)
 *   3. REST API fallback (BTC 1h only, weight=10)
 *
 * Owns per-symbol candle cache; BTC caches are global (via globalCacheManager).
 */

import {
  getBinanceWebSocket,
  getKlinesWithMeta,
  seedKlinesFromWebSocket,
} from '../../services/binanceWebSocket.js';
import { globalCacheManager } from '../cacheManager.js';
import { ipWeightTracker } from '../../services/ipWeightTracker.js';
import { isIpBanned, setGeoBlock } from '../../exchange/ccxtClient.js';
import { createLogger } from '../../utils/logger.js';
import type { Candle } from '../momentumSimple.js';
import type { Exchange } from '../../types/exchange.js';

const logger = createLogger('candle-fetcher');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CandleFetcher {
  // Per-symbol cache
  private candleCache: { candles: Candle[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL_MS: number;
  private wsSubscribed = false;

  constructor(
    private symbol: string,
    private exchange: Exchange,
    cacheTtlMs: number,
  ) {
    this.CACHE_TTL_MS = cacheTtlMs;
  }

  /**
   * Fetch 15m candles for this agent's symbol.
   * WebSocket-only (no REST fallback) to avoid IP bans.
   */
  async fetchCandles(): Promise<Candle[]> {
    const symbol = this.symbol;
    // Convert CCXT symbol to Binance format: "ETH/USDT:USDT" -> "ETHUSDT"
    const binanceSymbol = symbol.split('/')[0] + 'USDT';

    // 1. Subscribe to WebSocket stream (re-subscribe each time to keep TTL alive)
    try {
      const ws = getBinanceWebSocket();
      ws.subscribeToKline(binanceSymbol, '15m');
      if (!this.wsSubscribed) {
        this.wsSubscribed = true;
        logger.info(`📡 [${symbol}] Subscribed to WebSocket kline stream (0 API weight)`);
      }
    } catch (error) {
      if (!this.wsSubscribed) {
        logger.warn(`⚠️ [${symbol}] Failed to subscribe to WebSocket, will use REST`);
      }
    }

    // 2. Try WebSocket cache first (0 API weight!)
    // V5.50: Use getKlinesWithMeta to preserve isFinal flag for accurate candle close detection
    try {
      const wsKlines = getKlinesWithMeta(binanceSymbol, '15m');
      if (wsKlines && wsKlines.length >= 50) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          isFinal: c.isFinal,
        }));

        // Update local cache with WS data
        this.candleCache = { candles, fetchedAt: Date.now() };
        return candles;
      }
    } catch (error) {
      // WebSocket not ready, fall through to cache/wait
    }

    // 3. Check local cache (from previous WS data)
    if (this.candleCache && Date.now() - this.candleCache.fetchedAt < this.CACHE_TTL_MS) {
      return this.candleCache.candles;
    }

    // 4. NO REST FALLBACK - WebSocket only to avoid IP bans
    // If WebSocket doesn't have enough data yet, use whatever we have
    // V5.29: Removed REST fallback - caused IP bans from Binance
    // V5.50: Use getKlinesWithMeta to preserve isFinal flag
    const wsKlinesPartial = getKlinesWithMeta(binanceSymbol, '15m');
    if (wsKlinesPartial && wsKlinesPartial.length > 0) {
      const candles: Candle[] = wsKlinesPartial.map(c => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        isFinal: c.isFinal,
      }));
      this.candleCache = { candles, fetchedAt: Date.now() };
      return candles;
    }

    // No data - return cached or empty (agent will skip tick)
    return this.candleCache?.candles || [];
  }

  /**
   * Fetch BTC 15m candles (shared across all agents via globalCacheManager).
   */
  async fetchBtcCandles(): Promise<Candle[]> {
    const btcSymbol = 'BTCUSDT';

    // 1. Subscribe to BTC WebSocket stream
    try {
      const ws = getBinanceWebSocket();
      ws.subscribeToKline(btcSymbol, '15m');
      if (!globalCacheManager.getBtc15mWsSubscribed()) {
        globalCacheManager.setBtc15mWsSubscribed(true);
        logger.info('📡 [BTC] Subscribed to WebSocket kline stream (0 API weight)');
      }
    } catch (error) {
      if (!globalCacheManager.getBtc15mWsSubscribed()) {
        logger.warn('⚠️ [BTC] Failed to subscribe to WebSocket, will use REST');
      }
    }

    // 2. Try WebSocket cache first (0 API weight!)
    try {
      const wsKlines = getKlinesWithMeta(btcSymbol, '15m');
      if (wsKlines && wsKlines.length >= 200) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c.timestamp, open: c.open, high: c.high,
          low: c.low, close: c.close, volume: c.volume, isFinal: c.isFinal,
        }));
        globalCacheManager.setBtc15mCache(candles);
        return candles;
      }
    } catch (error) {
      // WebSocket cache miss
    }

    // 3. Check global cache
    if (globalCacheManager.isBtc15mCacheValid()) {
      return globalCacheManager.getBtc15mCache()!.candles;
    }

    // 4. WebSocket partial data
    const wsKlinesPartial = getKlinesWithMeta(btcSymbol, '15m');
    if (wsKlinesPartial && wsKlinesPartial.length > 0) {
      const candles: Candle[] = wsKlinesPartial.map(c => ({
        timestamp: c.timestamp, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume, isFinal: c.isFinal,
      }));
      globalCacheManager.setBtc15mCache(candles);
      return candles;
    }

    return globalCacheManager.getBtc15mCache()?.candles || [];
  }

  /**
   * Fetch BTC 1h candles for Multi-Timeframe Confluence filter.
   * V5.36: Uses WS → global cache → REST fallback.
   */
  async fetchBtcCandles1h(): Promise<Candle[]> {
    const btcSymbol = 'BTCUSDT';
    const MIN_FINAL_CANDLES = 11;

    // 0. Check global cache first
    if (globalCacheManager.isBtc1hCacheValid(MIN_FINAL_CANDLES)) {
      return globalCacheManager.getBtc1hCache()!.candles;
    }

    // Prevent multiple concurrent fetches
    const existing = globalCacheManager.getBtc1hFetchingPromise();
    if (existing) return existing;

    const fetchPromise = (async () => {
      try {
        // 1. Subscribe to BTC 1h WebSocket stream
        try {
          const ws = getBinanceWebSocket();
          ws.subscribeToKline(btcSymbol, '1h');
        } catch (error) {
          // Silently fail
        }

        // 2. Try WebSocket cache first (0 API weight!)
        try {
          const wsKlines = getKlinesWithMeta(btcSymbol, '1h');
          if (wsKlines && wsKlines.length >= 20) {
            const candles: Candle[] = wsKlines.map(c => ({
              timestamp: c.timestamp, open: c.open, high: c.high,
              low: c.low, close: c.close, volume: c.volume, isFinal: c.isFinal,
            }));
            globalCacheManager.setBtc1hCache(candles);
            return candles;
          }
        } catch (error) {
          // WebSocket cache miss
        }

        // 3. REST API fallback (V5.86: 250 candles for SMA200 regime)
        try {
          if (this.exchange.fetchOHLCV && !isIpBanned() && ipWeightTracker.canMakeCall(10)) {
            const ohlcv = await this.exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 250);
            ipWeightTracker.record(10, 'fetchOHLCV:BTC_1h:fallback');
            if (ohlcv && ohlcv.length >= 11) {
              const candles: Candle[] = ohlcv.map((c, idx) => ({
                timestamp: c[0] as number, open: c[1] as number,
                high: c[2] as number, low: c[3] as number,
                close: c[4] as number, volume: c[5] as number,
                isFinal: idx < ohlcv.length - 1,
              }));
              globalCacheManager.setBtc1hCache(candles);
              seedKlinesFromWebSocket(btcSymbol, '1h', ohlcv);
              logger.info(`[fetchBtcCandles1h] REST seeded ${ohlcv.length} candles to WebSocket cache`);
              return candles;
            }
          }
        } catch (error: unknown) {
          const msg = errMsg(error);
          if (msg.includes('451') || msg.includes('restricted location')) {
            setGeoBlock('fetchBtcCandles1h');
          }
          logger.warn(`[fetchBtcCandles1h] REST fallback failed: ${msg}`);
        }

        logger.warn('[fetchBtcCandles1h] No BTC 1h data available - MTF filter will be bypassed');
        return [];
      } finally {
        globalCacheManager.setBtc1hFetchingPromise(null);
      }
    })();

    globalCacheManager.setBtc1hFetchingPromise(fetchPromise);
    return fetchPromise;
  }
}
