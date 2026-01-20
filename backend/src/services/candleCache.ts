/**
 * V5.77: PostgreSQL Candle Cache Service
 *
 * Eliminates REST API calls at startup by caching candles in PostgreSQL.
 * Background job updates candles with rate-limited REST calls.
 *
 * Architecture:
 * - Startup: Load from DB → seed WebSocket cache (0 REST calls, ~100ms)
 * - Runtime: WebSocket for live data (same reactivity as before)
 * - Background: Update DB every 15 minutes (rate-limited REST, 1 call/min)
 */

import { prisma } from '../db/client.js';
import { seedKlinesFromWebSocket } from './binanceWebSocket.js';
import { getCachedExchange, isIpBanned, setIpBan, getIpBanExpiry } from '../exchange/ccxtClient.js';
import { createLogger } from '../utils/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const logger = createLogger('CandleCache');

// Symbols to cache - matches the trading universe
const CACHE_SYMBOLS = [
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
];

// How many candles to keep per symbol/timeframe
const MAX_CANDLES_PER_SYMBOL = 500;

// Rate limiting for background updates
const UPDATE_CONFIG = {
  DELAY_BETWEEN_SYMBOLS_MS: 3000, // 3s between symbols (conservative)
  POST_BAN_DELAY_MS: 10000, // 10s if recently banned
  UPDATE_INTERVAL_MS: 15 * 60 * 1000, // Every 15 minutes
};

let updateJobInterval: NodeJS.Timeout | null = null;

/**
 * Load candles from PostgreSQL and seed WebSocket cache.
 * Called at startup - 0 REST API calls.
 */
export async function loadCandlesFromDB(): Promise<{ loaded: number; symbols: number }> {
  const startTime = Date.now();
  logger.info('📊 Loading candles from database...');

  try {
    // Get all candles from DB, grouped by symbol/timeframe
    const candles = await prisma.marketCandle.findMany({
      orderBy: [
        { symbol: 'asc' },
        { timeframe: 'asc' },
        { openTime: 'asc' },
      ],
    });

    if (candles.length === 0) {
      logger.info('📋 No cached candles in DB - will use background job to populate');
      return { loaded: 0, symbols: 0 };
    }

    // Group by symbol+timeframe
    const grouped = new Map<string, typeof candles>();
    for (const c of candles) {
      const key = `${c.symbol}|${c.timeframe}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(c);
    }

    let totalCandles = 0;
    const symbolsLoaded = new Set<string>();

    for (const [key, candleGroup] of grouped) {
      const [symbol, timeframe] = key.split('|');
      // Convert to Binance symbol format (e.g., "BTC/USDT:USDT" -> "BTCUSDT")
      const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');

      // Convert to OHLCV format expected by seedKlinesFromWebSocket
      const ohlcv: number[][] = candleGroup.map(c => [
        Number(c.openTime), // timestamp
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
      ]);

      seedKlinesFromWebSocket(binanceSymbol, timeframe, ohlcv);
      totalCandles += ohlcv.length;
      symbolsLoaded.add(symbol);
    }

    const elapsed = Date.now() - startTime;
    logger.info(`✅ Loaded ${totalCandles} candles for ${symbolsLoaded.size} symbols from DB in ${elapsed}ms`);

    return { loaded: totalCandles, symbols: symbolsLoaded.size };
  } catch (error: any) {
    logger.error('❌ Failed to load candles from DB:', error?.message);
    return { loaded: 0, symbols: 0 };
  }
}

/**
 * Save candles to PostgreSQL.
 * Upserts to handle duplicates gracefully.
 */
export async function saveCandlesToDB(
  symbol: string,
  timeframe: string,
  ohlcv: number[][]
): Promise<number> {
  if (!ohlcv || ohlcv.length === 0) return 0;

  try {
    // Use transaction for efficiency
    const ops = ohlcv.map(c => ({
      where: {
        symbol_timeframe_openTime: {
          symbol,
          timeframe,
          openTime: BigInt(c[0]),
        },
      },
      update: {
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      },
      create: {
        symbol,
        timeframe,
        openTime: BigInt(c[0]),
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      },
    }));

    // Batch upserts in chunks to avoid query size limits
    const CHUNK_SIZE = 100;
    let saved = 0;

    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const chunk = ops.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(op => prisma.marketCandle.upsert(op)));
      saved += chunk.length;
    }

    return saved;
  } catch (error: any) {
    logger.error(`❌ Failed to save candles for ${symbol} ${timeframe}:`, error?.message);
    return 0;
  }
}

/**
 * Cleanup old candles to keep only MAX_CANDLES_PER_SYMBOL per symbol/timeframe.
 */
export async function cleanupOldCandles(): Promise<number> {
  let deleted = 0;

  try {
    // Get distinct symbol/timeframe combinations
    const combos = await prisma.marketCandle.findMany({
      distinct: ['symbol', 'timeframe'],
      select: { symbol: true, timeframe: true },
    });

    for (const { symbol, timeframe } of combos) {
      // Count candles for this combo
      const count = await prisma.marketCandle.count({
        where: { symbol, timeframe },
      });

      if (count > MAX_CANDLES_PER_SYMBOL) {
        // Find the cutoff openTime (keep the newest MAX_CANDLES_PER_SYMBOL)
        const toDelete = count - MAX_CANDLES_PER_SYMBOL;

        const oldest = await prisma.marketCandle.findMany({
          where: { symbol, timeframe },
          orderBy: { openTime: 'asc' },
          take: toDelete,
          select: { id: true },
        });

        if (oldest.length > 0) {
          await prisma.marketCandle.deleteMany({
            where: { id: { in: oldest.map(c => c.id) } },
          });
          deleted += oldest.length;
        }
      }
    }

    if (deleted > 0) {
      logger.info(`🧹 Cleaned up ${deleted} old candles`);
    }

    return deleted;
  } catch (error: any) {
    logger.error('❌ Failed to cleanup old candles:', error?.message);
    return 0;
  }
}

/**
 * Update candles from Binance REST API with rate limiting.
 * Called by background job.
 */
export async function updateCandlesFromAPI(): Promise<{ updated: number; failed: number }> {
  // Check if IP is banned
  if (isIpBanned()) {
    logger.warn('⚠️ IP is banned - skipping candle update');
    return { updated: 0, failed: 0 };
  }

  const exchange = await getCachedExchange();
  if (!exchange) {
    logger.warn('⚠️ No exchange available for candle update');
    return { updated: 0, failed: 0 };
  }

  // Check if recently banned - use longer delays
  const banExpiry = getIpBanExpiry();
  const recentlyBanned = banExpiry > 0 && Date.now() < banExpiry + 4 * 60 * 60 * 1000;
  const delayMs = recentlyBanned
    ? UPDATE_CONFIG.POST_BAN_DELAY_MS
    : UPDATE_CONFIG.DELAY_BETWEEN_SYMBOLS_MS;

  logger.info(`📥 Updating candles from API ${recentlyBanned ? '[POST-BAN MODE]' : ''}`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < CACHE_SYMBOLS.length; i++) {
    const symbol = CACHE_SYMBOLS[i];
    const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');

    try {
      // Fetch 15m candles
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, MAX_CANDLES_PER_SYMBOL);

      if (ohlcv && ohlcv.length > 0) {
        // Save to DB
        await saveCandlesToDB(symbol, '15m', ohlcv);

        // Also update WebSocket cache for live trading
        seedKlinesFromWebSocket(binanceSymbol, '15m', ohlcv);

        updated++;
        logger.debug(`✅ [${i + 1}/${CACHE_SYMBOLS.length}] ${binanceSymbol}: ${ohlcv.length} candles`);
      }
    } catch (error: any) {
      const msg = error?.message || '';
      failed++;

      // IP BAN - stop immediately
      if (msg.includes('418') || msg.includes('-1003') || msg.includes('banned')) {
        const banMatch = msg.match(/banned until (\d+)/);
        const banUntil = banMatch ? parseInt(banMatch[1]) : Date.now() + 60 * 60 * 1000;
        setIpBan(Math.max(banUntil - Date.now(), 60 * 60 * 1000));
        logger.warn('🚫 IP ban detected during candle update - stopping');
        break;
      }

      // Rate limit - back off significantly
      if (msg.includes('429') || msg.includes('Too many') || msg.includes('-1015')) {
        logger.warn('⚠️ Rate limit warning - backing off for 60s');
        await new Promise(r => setTimeout(r, 60_000));
        i--; // Retry this symbol
        failed--; // Don't count as failed
        continue;
      }

      logger.warn(`⚠️ Failed ${symbol}: ${msg}`);
    }

    // Delay between symbols
    if (i + 1 < CACHE_SYMBOLS.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Also fetch BTC 1h candles for MTF filter
  if (!isIpBanned()) {
    try {
      await new Promise(r => setTimeout(r, delayMs));
      const ohlcv1h = await exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 100);
      if (ohlcv1h && ohlcv1h.length > 0) {
        await saveCandlesToDB('BTC/USDT:USDT', '1h', ohlcv1h);
        seedKlinesFromWebSocket('BTCUSDT', '1h', ohlcv1h);
        logger.debug(`✅ BTC 1h: ${ohlcv1h.length} candles`);
      }
    } catch (error: any) {
      logger.warn(`⚠️ Failed BTC 1h: ${error?.message}`);
    }
  }

  // Cleanup old candles
  await cleanupOldCandles();

  logger.info(`✅ Candle update complete: ${updated}/${CACHE_SYMBOLS.length} symbols, ${failed} failed`);
  return { updated, failed };
}

/**
 * Start the background candle update job.
 * Updates candles every 15 minutes with rate-limited REST calls.
 */
export function startCandleUpdateJob(): void {
  if (updateJobInterval) {
    logger.warn('⚠️ Candle update job already running');
    return;
  }

  logger.info(`🔄 Starting candle update job (every ${UPDATE_CONFIG.UPDATE_INTERVAL_MS / 60000} minutes)`);

  // Run immediately on start
  updateCandlesFromAPI().catch(err => {
    logger.error('❌ Initial candle update failed:', err);
  });

  // Then run periodically
  updateJobInterval = setInterval(async () => {
    try {
      await updateCandlesFromAPI();
    } catch (err: any) {
      logger.error('❌ Candle update job error:', err?.message);
    }
  }, UPDATE_CONFIG.UPDATE_INTERVAL_MS);
}

/**
 * Stop the background candle update job.
 */
export function stopCandleUpdateJob(): void {
  if (updateJobInterval) {
    clearInterval(updateJobInterval);
    updateJobInterval = null;
    logger.info('🛑 Stopped candle update job');
  }
}

/**
 * Check if we have any cached candles in the database.
 */
export async function hasCachedCandles(): Promise<boolean> {
  try {
    const count = await prisma.marketCandle.count();
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * Upsert database from local JSON files in data/ directory.
 * Always merges local files into DB - newer timestamps win via upsert.
 * This ensures committed data files are always used even if DB has older data.
 */
export async function seedFromLocalFiles(): Promise<{ seeded: number; symbols: number }> {
  const dataDir = path.resolve(process.cwd(), 'data');
  logger.info(`📂 Upserting database from local files in ${dataDir}...`);

  let totalSeeded = 0;
  let symbolsSeeded = 0;

  try {
    // Check if data directory exists
    try {
      await fs.access(dataDir);
    } catch {
      logger.info('📋 No local data directory found - skipping seed');
      return { seeded: 0, symbols: 0 };
    }

    // Read all JSON files
    const files = await fs.readdir(dataDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    if (jsonFiles.length === 0) {
      logger.info('📋 No local data files found - skipping seed');
      return { seeded: 0, symbols: 0 };
    }

    for (const file of jsonFiles) {
      try {
        // Parse filename to get symbol and timeframe
        // Format: BTC_USDT_15m.json or BTC_USDT_1h.json
        const match = file.match(/^([A-Z]+)_USDT_(\d+[mh])\.json$/);
        if (!match) {
          logger.debug(`Skipping non-matching file: ${file}`);
          continue;
        }

        const [, base, timeframe] = match;
        const symbol = `${base}/USDT:USDT`; // Convert to CCXT format

        // Read and parse file
        const filePath = path.join(dataDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);

        // Handle two formats:
        // 1. Array of objects: [{openTime, open, high, low, close, volume}, ...]
        // 2. Object with candles array: {"candles": [[ts, o, h, l, c, v], ...]}
        let ohlcv: number[][];

        if (Array.isArray(parsed)) {
          // Format 1: Array of objects (15m files from refresh script)
          const candles = parsed as Array<{
            openTime: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
          }>;
          if (!candles || candles.length === 0) {
            logger.debug(`Empty file: ${file}`);
            continue;
          }
          ohlcv = candles.map(c => [
            c.openTime,
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume,
          ]);
        } else if (parsed.candles && Array.isArray(parsed.candles)) {
          // Format 2: Object with candles array (1h files from backtest data)
          const candles = parsed.candles as number[][];
          if (!candles || candles.length === 0) {
            logger.debug(`Empty file: ${file}`);
            continue;
          }
          ohlcv = candles; // Already in [ts, o, h, l, c, v] format
        } else {
          logger.debug(`Unknown format in file: ${file}`);
          continue;
        }

        // Save to database
        const saved = await saveCandlesToDB(symbol, timeframe, ohlcv);
        if (saved > 0) {
          totalSeeded += saved;
          symbolsSeeded++;
          logger.info(`✅ Seeded ${file}: ${saved} candles`);
        }
      } catch (err: any) {
        logger.warn(`⚠️ Failed to seed from ${file}: ${err?.message}`);
      }
    }

    logger.info(`✅ Seeded ${totalSeeded} candles for ${symbolsSeeded} symbols from local files`);
    return { seeded: totalSeeded, symbols: symbolsSeeded };
  } catch (error: any) {
    logger.error('❌ Failed to seed from local files:', error?.message);
    return { seeded: 0, symbols: 0 };
  }
}
