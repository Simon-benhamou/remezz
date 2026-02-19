import type { PrismaClient } from '.prisma/client';
import { getBinanceWebSocket, getKlinesWithMeta } from '../binanceWebSocket.js';
import { createLogger } from '../../utils/logger.js';
import { computeFiveMinScore } from './fiveMinScorer.js';
import { buildSlug, fetchPolymarketOdds } from './polymarketClient.js';
import {
  getChainlinkBtcPrice,
  startChainlinkFeed,
  stopChainlinkFeed,
} from './chainlinkPriceFeed.js';
import { getLiveTradingConfig, placePolymarketBet } from './polymarketTrader.js';
import type {
  Candle1m,
  PredictionStats,
  WindowState,
} from './polymarketTypes.js';

const log = createLogger('polymarket');

// ─── Constants ────────────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1000;           // 5 minutes
const DECISION_OFFSET_MS = 2.5 * 60 * 1000; // 2.5 minutes into the window
const POLL_INTERVAL_MS = 1000;               // 1 second
const SYMBOL = 'BTCUSDT';
const SYMBOL_SHORT = 'BTC';

// ─── Module state ─────────────────────────────────────────────────────────────

let currentWindow: WindowState | null = null;
let decisionMade = false;
let resolutionDone = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let pendingResolution: WindowState | null = null; // Previous window awaiting DB persist

// Prevent placing a new live bet before the previous window's order is fully handled
let activeLiveBetWindow: number | null = null; // windowStart of the window with an active live bet

/** Live state exposed to the frontend */
let liveState: { window: WindowState | null; klines1m: Candle1m[] } = {
  window: null,
  klines1m: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWindowBoundaries(nowMs: number): { start: number; end: number } {
  const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const end = start + WINDOW_MS;
  return { start, end };
}

function getKlines1m(): Candle1m[] {
  const raw = getKlinesWithMeta(SYMBOL, '1m');
  if (!raw) return [];
  return raw.map((k) => ({
    timestamp: k.timestamp,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    isFinal: k.isFinal,
  }));
}

/**
 * Get BTC price from Chainlink (Polymarket's source), falling back to Binance WS.
 */
function getBtcPrice(klines: Candle1m[]): number {
  const chainlink = getChainlinkBtcPrice();
  if (chainlink) return chainlink.price;

  // Fallback: use latest Binance 1m candle close
  if (klines.length > 0) return klines[klines.length - 1].close;

  return 0;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

async function resolveWindow(w: WindowState, prisma: PrismaClient): Promise<void> {
  const endPrice = w.currentPrice;
  const actualResult: 'UP' | 'DOWN' = endPrice >= w.startPrice ? 'UP' : 'DOWN';

  let isCorrect: boolean | null = null;
  let simulatedPnl: number | null = null;

  if (w.prediction && w.entryOdds !== null) {
    isCorrect = w.prediction.direction === actualResult;
    simulatedPnl = isCorrect
      ? 1 - w.entryOdds
      : -w.entryOdds;
  }

  // Release the active-bet guard so the next window can place a new order
  if (activeLiveBetWindow === w.windowStart) {
    activeLiveBetWindow = null;
  }

  const skipped = w.status === 'skipped';

  try {
    await prisma.polymarketPrediction.create({
      data: {
        symbol: SYMBOL_SHORT,
        windowStart: new Date(w.windowStart),
        windowEnd: new Date(w.windowEnd),
        startPrice: w.startPrice,
        endPrice,
        prediction: w.prediction?.direction ?? null,
        confidence: w.prediction?.confidence ?? null,
        actualResult,
        entryOdds: w.entryOdds,
        simulatedPnl,
        scoreBreakdown: w.prediction?.score
          ? JSON.parse(JSON.stringify(w.prediction.score))
          : undefined,
        isCorrect,
        skipped,
        polymarketSlug: w.prediction
          ? buildSlug(SYMBOL_SHORT, w.windowStart)
          : null,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`DB persist error: ${msg}`);
  }

  const pnlStr = simulatedPnl !== null ? simulatedPnl.toFixed(3) : 'N/A';
  const correctStr = isCorrect !== null ? (isCorrect ? 'WIN' : 'LOSS') : 'SKIP';
  log.info(
    `Resolved: actual=${actualResult} | ${correctStr} | pnl=${pnlStr} | ${w.startPrice.toFixed(2)} → ${endPrice.toFixed(2)}`,
  );
}

// ─── Core tick ────────────────────────────────────────────────────────────────

async function tick(prisma: PrismaClient): Promise<void> {
  // Re-subscribe every tick to prevent TTL pruning (klineSubscriptionTtlMs = 10min).
  // subscribeToKline is idempotent — just refreshes lastRequestedAt.
  const ws = getBinanceWebSocket();
  ws.subscribeToKline(SYMBOL, '1m');

  const nowMs = Date.now();
  const { start, end } = getWindowBoundaries(nowMs);
  const elapsed = nowMs - start;
  const klines = getKlines1m();

  // ── Resolve previous window on new-window boundary ──────────────────────
  // The old approach (resolve at WINDOW_MS - 500ms) had a race condition:
  // with 1000ms poll interval, ~50% of ticks skip the 500ms resolution window.
  // Fix: snapshot the previous window and resolve it when we detect a new one.
  if (pendingResolution) {
    await resolveWindow(pendingResolution, prisma);
    pendingResolution = null;
  }

  // ── New window detection ──────────────────────────────────────────────────
  if (!currentWindow || currentWindow.windowStart !== start) {
    // Snapshot previous window for resolution (uses final currentPrice)
    if (currentWindow && !resolutionDone) {
      pendingResolution = { ...currentWindow };
    }

    decisionMade = false;
    resolutionDone = false;

    // Use Chainlink price as "price to beat" (same source as Polymarket resolution)
    const startPrice = getBtcPrice(klines);

    // Skip window if no price available (e.g. right after restart before feeds are ready)
    if (startPrice === 0) {
      log.warn('No price available yet (Chainlink + Binance both offline) — skipping window');
      currentWindow = null as any;
      return;
    }

    currentWindow = {
      windowStart: start,
      windowEnd: end,
      startPrice,
      currentPrice: startPrice,
      elapsed,
      prediction: null,
      entryOdds: null,
      status: 'accumulating',
    };

    const source = getChainlinkBtcPrice() ? 'chainlink' : 'binance-fallback';
    log.info(
      `New window ${new Date(start).toISOString()} → ${new Date(end).toISOString()} | startPrice=${startPrice.toFixed(2)} (${source})`,
    );
  }

  // ── Guard: no window (price unavailable at startup) ──────────────────────
  if (!currentWindow) return;

  // ── Update current price + elapsed ────────────────────────────────────────
  currentWindow.currentPrice = getBtcPrice(klines);
  currentWindow.elapsed = elapsed;

  // ── Decision at T+2.5min ──────────────────────────────────────────────────
  if (elapsed >= DECISION_OFFSET_MS && !decisionMade) {
    const windowCandles = klines.filter(
      (k) => k.isFinal && k.timestamp >= start,
    );
    const preWindowCandles = klines
      .filter((k) => k.isFinal && k.timestamp < start)
      .slice(-20);

    const result = computeFiveMinScore(
      windowCandles,
      preWindowCandles,
      currentWindow.startPrice,
    );

    if (result) {
      // Prediction meets threshold — fetch odds + token IDs
      const slug = buildSlug(SYMBOL_SHORT, start);
      const odds = await fetchPolymarketOdds(slug);
      const entryOdds =
        result.direction === 'UP' ? odds.upPrice : odds.downPrice;
      const tokenId =
        result.direction === 'UP' ? odds.upTokenId : odds.downTokenId;

      currentWindow.prediction = result;
      currentWindow.entryOdds = entryOdds;
      currentWindow.status = 'predicted';

      log.info(
        `Prediction: ${result.direction} (score=${result.score.total}, conf=${result.confidence}) | odds=${entryOdds.toFixed(3)} | slug=${slug}`,
      );

      // ── Live trading: place real bet if enabled ──────────────────────
      const liveConfig = await getLiveTradingConfig(prisma);
      if (liveConfig && tokenId) {
        // Guard: 1 order at a time — skip if a bet is still active from a previous window
        if (activeLiveBetWindow !== null && activeLiveBetWindow !== start) {
          log.warn(`LIVE MODE: skipping bet — previous window ${activeLiveBetWindow} still has an active bet`);
        } else {
          log.info(`LIVE MODE: placing $${liveConfig.amount} bet on ${result.direction}...`);
          const betResult = await placePolymarketBet(
            prisma,
            result.direction,
            tokenId,
            liveConfig.amount,
            entryOdds,
          );
          if (betResult.success) {
            activeLiveBetWindow = start; // Mark this window as having an active live bet
            log.info(`LIVE BET OK: orderId=${betResult.orderId}`);
          } else {
            log.error(`LIVE BET FAILED: ${betResult.error}`);
          }
        }
      } else if (liveConfig && !tokenId) {
        log.warn('Live mode active but no token ID available for this market');
      }
    } else {
      // Score below threshold — skip this window
      currentWindow.status = 'skipped';
      log.info('Window skipped (score < 40)');
    }

    decisionMade = true;
  }

  // ── Update live state ─────────────────────────────────────────────────────
  liveState = {
    window: currentWindow ? { ...currentWindow } : null,
    klines1m: klines,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns current window state + klines1m for the frontend.
 */
export function getPolymarketLiveState(): {
  window: WindowState | null;
  klines1m: Candle1m[];
} {
  return { ...liveState };
}

/**
 * Start the background worker polling every 1s.
 */
export function startPolymarketWorker(prisma: PrismaClient): void {
  if (intervalHandle) {
    log.warn('Worker already running');
    return;
  }

  // Start Chainlink price feed (Polymarket's "price to beat" source)
  startChainlinkFeed();

  const ws = getBinanceWebSocket();
  ws.subscribeToKline(SYMBOL, '1m');

  intervalHandle = setInterval(() => {
    tick(prisma).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tick error: ${msg}`);
    });
  }, POLL_INTERVAL_MS);

  log.info(
    `Worker started — polling every ${POLL_INTERVAL_MS}ms, symbol=${SYMBOL}, window=${WINDOW_MS / 1000}s`,
  );
}

/**
 * Stop the background worker.
 */
export function stopPolymarketWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('Worker stopped');
  }
  stopChainlinkFeed();
  activeLiveBetWindow = null; // Reset so a restart can place bets immediately
}

/**
 * Returns whether the worker is currently running.
 */
export function isPolymarketWorkerRunning(): boolean {
  return intervalHandle !== null;
}

/**
 * Aggregated prediction stats from the database.
 */
export async function getPolymarketStats(
  prisma: PrismaClient,
): Promise<PredictionStats> {
  const predictions = await prisma.polymarketPrediction.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let totalWindows = predictions.length;
  let totalPredictions = 0;
  let wins = 0;
  let losses = 0;
  let skips = 0;
  let cumulativePnl = 0;

  let todayWindows = 0;
  let todayPredictions = 0;
  let todayWins = 0;
  let todayLosses = 0;
  let todayPnl = 0;

  for (const p of predictions) {
    const isToday = p.createdAt >= todayStart;

    if (p.skipped) {
      skips++;
    } else {
      totalPredictions++;
      if (p.isCorrect === true) {
        wins++;
      } else if (p.isCorrect === false) {
        losses++;
      }
      if (p.simulatedPnl !== null) {
        cumulativePnl += p.simulatedPnl;
      }
    }

    if (isToday) {
      todayWindows++;
      if (!p.skipped) {
        todayPredictions++;
        if (p.isCorrect === true) todayWins++;
        else if (p.isCorrect === false) todayLosses++;
        if (p.simulatedPnl !== null) todayPnl += p.simulatedPnl;
      }
    }
  }

  const winRate = totalPredictions > 0 ? (wins / totalPredictions) * 100 : 0;
  const todayWinRate =
    todayPredictions > 0 ? (todayWins / todayPredictions) * 100 : 0;

  return {
    totalWindows,
    totalPredictions,
    wins,
    losses,
    skips,
    winRate,
    cumulativePnl,
    todayWindows,
    todayPredictions,
    todayWins,
    todayLosses,
    todayWinRate,
    todayPnl,
  };
}
