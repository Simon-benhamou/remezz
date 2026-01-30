/**
 * V5.78: Candle Seeding Service
 *
 * Seeds WebSocket cache with fresh candles from REST API at startup.
 * All REST calls go through BinanceRestQueue for rate limiting.
 *
 * Architecture:
 * - Startup: Seed from local files (instant) + REST API via queue (fresh data)
 * - Runtime: WebSocket for live data
 * - Background: Refresh every 15 minutes via queue
 */

import { seedKlinesFromWebSocket } from './binanceWebSocket.js';
import { getCachedExchange } from '../exchange/ccxtClient.js';
import { createLogger } from '../utils/logger.js';
import { binanceRestQueue, BINANCE_WEIGHTS } from './binanceRestQueue.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const logger = createLogger('CandleSeeder');

// Symbols to seed - matches the trading universe
const SEED_SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'DOGE/USDT:USDT',
  'AVAX/USDT:USDT',
  'SUI/USDT:USDT',
  'SEI/USDT:USDT',
  'IMX/USDT:USDT',
  'APT/USDT:USDT',
  'ARB/USDT:USDT',
  'OP/USDT:USDT',
  'NEAR/USDT:USDT',
  'FTM/USDT:USDT',
  'ATOM/USDT:USDT',
  'DOT/USDT:USDT',
  'ADA/USDT:USDT',
  'XRP/USDT:USDT',
  'LINK/USDT:USDT',
  'UNI/USDT:USDT',
  'BCH/USDT:USDT',
  'LTC/USDT:USDT',
  'SONIC/USDT:USDT',
];

// How many candles to fetch
const CANDLES_TO_FETCH = 300; // ~3 days of 15m candles

// Background refresh interval
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let refreshInterval: NodeJS.Timeout | null = null;

/**
 * Convert CCXT symbol to Binance symbol format
 * "BTC/USDT:USDT" -> "BTCUSDT"
 */
function toBinanceSymbol(ccxtSymbol: string): string {
  return ccxtSymbol.replace('/', '').replace(':USDT', '');
}

/**
 * Seed candles from local JSON files (instant, 0 REST calls)
 * Used as initial data before REST fetch completes
 */
export async function seedFromLocalFiles(): Promise<{ seeded: number; symbols: number }> {
  const dataDir = path.resolve(process.cwd(), 'data');
  logger.info(`📂 Seeding from local files in ${dataDir}...`);

  let totalSeeded = 0;
  let symbolsSeeded = 0;

  try {
    await fs.access(dataDir);
  } catch {
    logger.info('📋 No local data directory - skipping');
    return { seeded: 0, symbols: 0 };
  }

  try {
    const files = await fs.readdir(dataDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    for (const file of jsonFiles) {
      try {
        // Parse filename: BTC_USDT_15m.json
        const match = file.match(/^([A-Z]+)_USDT_(\d+[mh])\.json$/);
        if (!match) continue;

        const [, base, timeframe] = match;
        const binanceSymbol = `${base}USDT`;

        const filePath = path.join(dataDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);

        let ohlcv: number[][];

        if (Array.isArray(parsed)) {
          // Format: [{openTime, open, high, low, close, volume}, ...]
          ohlcv = parsed.map((c: any) => [
            c.openTime, c.open, c.high, c.low, c.close, c.volume,
          ]);
        } else if (parsed.candles && Array.isArray(parsed.candles)) {
          // Format: {candles: [[ts, o, h, l, c, v], ...]}
          ohlcv = parsed.candles;
        } else {
          continue;
        }

        if (ohlcv.length > 0) {
          seedKlinesFromWebSocket(binanceSymbol, timeframe, ohlcv);
          totalSeeded += ohlcv.length;
          symbolsSeeded++;
          logger.debug(`✅ Local: ${binanceSymbol} ${timeframe}: ${ohlcv.length} candles`);
        }
      } catch (err: any) {
        logger.debug(`⚠️ Failed to read ${file}: ${err?.message}`);
      }
    }

    if (totalSeeded > 0) {
      logger.info(`✅ Seeded ${totalSeeded} candles for ${symbolsSeeded} symbols from local files`);
    }

    return { seeded: totalSeeded, symbols: symbolsSeeded };
  } catch (error: any) {
    logger.warn('⚠️ Failed to seed from local files:', error?.message);
    return { seeded: 0, symbols: 0 };
  }
}

/**
 * Seed fresh candles from REST API via queue
 * This is the main function to call at startup
 */
export async function seedFreshCandles(symbols?: string[]): Promise<{ seeded: number; failed: number }> {
  const exchange = await getCachedExchange();
  if (!exchange) {
    logger.warn('⚠️ No exchange available for candle seeding');
    return { seeded: 0, failed: 0 };
  }

  const symbolsToSeed = symbols || SEED_SYMBOLS;
  logger.info(`📥 Seeding fresh candles for ${symbolsToSeed.length} symbols via queue...`);

  let seeded = 0;
  let failed = 0;

  // Queue all fetches - the queue handles rate limiting
  const promises = symbolsToSeed.map(async (symbol) => {
    const binanceSymbol = toBinanceSymbol(symbol);

    try {
      const ohlcv = await binanceRestQueue.enqueue<number[][]>(
        () => exchange.fetchOHLCV(symbol, '15m', undefined, CANDLES_TO_FETCH),
        {
          weight: BINANCE_WEIGHTS.FETCH_OHLCV,
          priority: 'normal', // Startup seeding = normal priority
          tag: `seed_${binanceSymbol}_15m`,
        }
      );

      if (ohlcv && ohlcv.length > 0) {
        seedKlinesFromWebSocket(binanceSymbol, '15m', ohlcv);
        seeded++;
        logger.debug(`✅ Fresh: ${binanceSymbol}: ${ohlcv.length} candles`);
      }
    } catch (error: any) {
      failed++;
      logger.warn(`⚠️ Failed ${symbol}: ${error?.message}`);
    }
  });

  await Promise.all(promises);

  // Also fetch BTC 1h candles for MTF filter
  try {
    const ohlcv1h = await binanceRestQueue.enqueue<number[][]>(
      () => exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 100),
      {
        weight: BINANCE_WEIGHTS.FETCH_OHLCV,
        priority: 'normal',
        tag: 'seed_BTC_1h',
      }
    );

    if (ohlcv1h && ohlcv1h.length > 0) {
      seedKlinesFromWebSocket('BTCUSDT', '1h', ohlcv1h);
      logger.debug(`✅ Fresh: BTC 1h: ${ohlcv1h.length} candles`);
    }
  } catch (error: any) {
    logger.warn(`⚠️ Failed BTC 1h: ${error?.message}`);
  }

  logger.info(`✅ Fresh candle seeding complete: ${seeded}/${symbolsToSeed.length} symbols, ${failed} failed`);
  return { seeded, failed };
}

/**
 * Lightweight BTC-only backfill for WebSocket reconnect gaps.
 * Uses the REST queue to avoid IP bans. Only fetches BTC 15m + 1h.
 */
export async function backfillBtcCandles(): Promise<void> {
  const exchange = await getCachedExchange();
  if (!exchange) {
    logger.warn('⚠️ No exchange available for BTC backfill');
    return;
  }

  logger.info('📥 Backfilling BTC candles after WebSocket reconnect...');

  try {
    const ohlcv15m = await binanceRestQueue.enqueue<number[][]>(
      () => exchange.fetchOHLCV('BTC/USDT:USDT', '15m', undefined, CANDLES_TO_FETCH),
      {
        weight: BINANCE_WEIGHTS.FETCH_OHLCV,
        priority: 'high',
        tag: 'reconnect_BTC_15m',
      }
    );
    if (ohlcv15m && ohlcv15m.length > 0) {
      seedKlinesFromWebSocket('BTCUSDT', '15m', ohlcv15m);
      logger.info(`✅ BTC 15m backfill: ${ohlcv15m.length} candles`);
    }
  } catch (error: any) {
    logger.warn(`⚠️ BTC 15m backfill failed: ${error?.message}`);
  }

  try {
    const ohlcv1h = await binanceRestQueue.enqueue<number[][]>(
      () => exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 100),
      {
        weight: BINANCE_WEIGHTS.FETCH_OHLCV,
        priority: 'high',
        tag: 'reconnect_BTC_1h',
      }
    );
    if (ohlcv1h && ohlcv1h.length > 0) {
      seedKlinesFromWebSocket('BTCUSDT', '1h', ohlcv1h);
      logger.info(`✅ BTC 1h backfill: ${ohlcv1h.length} candles`);
    }
  } catch (error: any) {
    logger.warn(`⚠️ BTC 1h backfill failed: ${error?.message}`);
  }
}

/**
 * Start background refresh job
 */
export function startCandleRefreshJob(): void {
  if (refreshInterval) {
    logger.warn('⚠️ Candle refresh job already running');
    return;
  }

  logger.info(`🔄 Starting candle refresh job (every ${REFRESH_INTERVAL_MS / 60000} minutes)`);

  refreshInterval = setInterval(async () => {
    try {
      logger.info('📥 Running scheduled candle refresh...');
      await seedFreshCandles();
    } catch (err: any) {
      logger.error('❌ Candle refresh job error:', err?.message);
    }
  }, REFRESH_INTERVAL_MS);
}

/**
 * Stop background refresh job
 */
export function stopCandleRefreshJob(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    logger.info('🛑 Stopped candle refresh job');
  }
}

/**
 * Get list of symbols to seed
 */
export function getSeedSymbols(): string[] {
  return [...SEED_SYMBOLS];
}
