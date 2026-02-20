import type { PrismaClient } from '.prisma/client';
import { getBinanceWebSocket, getKlinesWithMeta } from '../binanceWebSocket.js';
import { createLogger } from '../../utils/logger.js';
import { computeFiveMinScore } from './fiveMinScorer.js';
import { buildSlug, fetchPolymarketOdds, fetchPolymarketResult } from './polymarketClient.js';
import {
  getChainlinkBtcPrice,
  startChainlinkFeed,
  stopChainlinkFeed,
} from './chainlinkPriceFeed.js';
import { getLiveTradingConfig, placePolymarketBet, getPolymarketBalance, getPolymarketConfig } from './polymarketTrader.js';
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

// Prevent concurrent tick() executions: setInterval fires every 1s but tick() can take 3-5s
// (balance fetch, rederive, etc). Without this guard multiple ticks see decisionMade=false
// simultaneously → multiple bets placed per window.
let tickInProgress = false;

// Prevent placing a new live bet before the previous window's order is fully handled.
// Set to the windowStart when a bet is ATTEMPTED (not just on success) to prevent retry loops.
let activeLiveBetWindow: number | null = null; // windowStart of the window with an active live bet

// ─── Polymarket resolution verification ───────────────────────────────────────
// Our preliminary resolution uses BTC price (start vs end). But Polymarket's oracle
// (Chainlink) may give a different result. We verify against the Gamma API ~3min
// after the window closes and correct the DB record if needed.

interface PendingVerification {
  windowStart: number;         // ms timestamp — DB key
  slug: string;                // Polymarket slug for Gamma API lookup
  predictionDirection: 'UP' | 'DOWN' | null; // what we predicted
  entryOdds: number | null;    // Gamma API odds (for display)
  executionPrice: number | null; // Actual CLOB price paid (for PnL)
  betAmount: number | null;    // USDC amount for dollar PnL
  verifyAfterMs: number;       // don't check until this time (wait for oracle)
  giveUpAfterMs: number;       // stop retrying after this time
}

const pendingVerifications: PendingVerification[] = [];

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
  // Preliminary result from our own price sampling — will be verified against Polymarket oracle.
  // isCorrect and simulatedPnl stay NULL until oracle confirms — never trust preliminary.
  const preliminaryResult: 'UP' | 'DOWN' = endPrice >= w.startPrice ? 'UP' : 'DOWN';

  // Release the active-bet guard so the next window can place a new order
  if (activeLiveBetWindow === w.windowStart) {
    activeLiveBetWindow = null;
  }

  const skipped = w.status === 'skipped';
  const slug = buildSlug(SYMBOL_SHORT, w.windowStart);

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
        actualResult: preliminaryResult,
        entryOdds: w.entryOdds,
        executionPrice: w.executionPrice,  // Actual CLOB price (null for virtual mode)
        betAmount: w.betAmount,
        simulatedPnl: null,       // Set by oracle verification only
        scoreBreakdown: w.prediction?.score
          ? JSON.parse(JSON.stringify(w.prediction.score))
          : undefined,
        isCorrect: null,           // Set by oracle verification only — never trust preliminary
        skipped,
        polymarketSlug: w.prediction ? slug : null,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`DB persist error: ${msg}`);
  }

  const hasPrediction = w.prediction && w.entryOdds !== null;
  const preliminaryMatch = hasPrediction ? w.prediction!.direction === preliminaryResult : null;
  const correctStr = preliminaryMatch !== null ? (preliminaryMatch ? 'WIN?' : 'LOSS?') : 'SKIP';
  log.info(
    `Resolved (PRELIMINARY — awaiting oracle): actual=${preliminaryResult} | ${correctStr} | ${w.startPrice.toFixed(2)} → ${endPrice.toFixed(2)}`,
  );

  // Schedule Polymarket oracle verification in 3 minutes (time for Chainlink to publish)
  // Skipped windows have no slug and don't need verification
  if (!skipped) {
    pendingVerifications.push({
      windowStart: w.windowStart,
      slug,
      predictionDirection: w.prediction?.direction ?? null,
      entryOdds: w.entryOdds,
      executionPrice: w.executionPrice,
      betAmount: w.betAmount,
      verifyAfterMs: Date.now() + 3 * 60 * 1000,   // check after 3 min
      giveUpAfterMs: Date.now() + 60 * 60 * 1000,  // give up after 60 min (was 15 — too short)
    });
  }
}

// ─── Polymarket oracle verification ─────────────────────────────────────────

/**
 * Checks pending windows against the Polymarket Gamma API.
 * Corrects the DB record if the real oracle result differs from our preliminary price comparison.
 * Called on every tick — skips silently if nothing is due yet.
 */
async function verifyPendingResolutions(prisma: PrismaClient): Promise<void> {
  const now = Date.now();
  const toRemove: number[] = [];

  for (let i = 0; i < pendingVerifications.length; i++) {
    const v = pendingVerifications[i];

    // Not ready yet
    if (now < v.verifyAfterMs) continue;

    // Timed out — give up
    if (now > v.giveUpAfterMs) {
      log.warn(`Polymarket verification timed out for ${v.slug} — keeping preliminary result`);
      toRemove.push(i);
      continue;
    }

    try {
      const oracleResult = await fetchPolymarketResult(v.slug);

      if (oracleResult === null) {
        // Not yet resolved — retry on next tick
        continue;
      }

      // Oracle resolved — always update DB with authoritative result + compute isCorrect
      const isCorrect = v.predictionDirection ? v.predictionDirection === oracleResult : null;
      // Dollar PnL using ACTUAL execution price (CLOB), not Gamma odds
      //   Buy N = amt/price tokens at price P
      //   WIN: N × $1 → profit = amt × (1-P)/P
      //   LOSE: N × $0 → loss = -amt (entire stake)
      const amt = v.betAmount ?? 5;
      const price = v.executionPrice ?? v.entryOdds; // CLOB price if available, Gamma fallback
      const simulatedPnl =
        isCorrect !== null && price !== null
          ? isCorrect ? amt * (1 - price) / price : -amt
          : null;

      const existing = await prisma.polymarketPrediction.findFirst({
        where: { windowStart: new Date(v.windowStart), symbol: SYMBOL_SHORT },
        select: { actualResult: true },
      });

      const preliminaryMatched = existing?.actualResult === oracleResult;

      await prisma.polymarketPrediction.updateMany({
        where: { windowStart: new Date(v.windowStart), symbol: SYMBOL_SHORT },
        data: { actualResult: oracleResult, isCorrect, simulatedPnl },
      });

      if (preliminaryMatched) {
        log.info(`Oracle confirmed: ${v.slug} → ${oracleResult} | isCorrect=${isCorrect}`);
      } else {
        log.warn(
          `Oracle CORRECTION: ${v.slug} | preliminary=${existing?.actualResult} → oracle=${oracleResult} | isCorrect=${isCorrect}`,
        );
      }

      toRemove.push(i);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Oracle verification error for ${v.slug}: ${msg} — retrying`);
    }
  }

  // Remove resolved/timed-out entries (iterate backwards to keep indices valid)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    pendingVerifications.splice(toRemove[i], 1);
  }
}

// ─── Core tick ────────────────────────────────────────────────────────────────

async function tick(prisma: PrismaClient): Promise<void> {
  // Guard against concurrent ticks: setInterval fires every 1s but tick() can take 3-5s.
  // Without this, multiple ticks execute in parallel and all see decisionMade=false.
  if (tickInProgress) return;
  tickInProgress = true;

  try {
  // Re-subscribe every tick to prevent TTL pruning (klineSubscriptionTtlMs = 10min).
  // subscribeToKline is idempotent — just refreshes lastRequestedAt.
  const ws = getBinanceWebSocket();
  ws.subscribeToKline(SYMBOL, '1m');

  const nowMs = Date.now();
  const { start, end } = getWindowBoundaries(nowMs);
  const elapsed = nowMs - start;
  const klines = getKlines1m();

  // ── Resolve previous window on new-window boundary ──────────────────────
  if (pendingResolution) {
    await resolveWindow(pendingResolution, prisma);
    pendingResolution = null;
  }

  // ── Verify pending Polymarket oracle resolutions ─────────────────────────
  if (pendingVerifications.length > 0) {
    await verifyPendingResolutions(prisma);
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
      executionPrice: null,
      betAmount: null,
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
    decisionMade = true; // Set IMMEDIATELY before any async work to prevent concurrent ticks from re-entering

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

      // Store bet amount for dollar PnL calculation (from config, same for virtual + live)
      const pmConfig = await getPolymarketConfig(prisma);
      currentWindow.betAmount = pmConfig.amount;

      log.info(
        `Prediction: ${result.direction} (score=${result.score.total}, conf=${result.confidence}) | odds=${entryOdds.toFixed(3)} | amount=$${pmConfig.amount} | slug=${slug}`,
      );

      // ── Live trading: place real bet if enabled ──────────────────────
      const liveConfig = await getLiveTradingConfig(prisma);
      if (liveConfig && tokenId) {
        // Guard: 1 order at a time — skip if a bet is still active from a previous window
        if (activeLiveBetWindow !== null && activeLiveBetWindow !== start) {
          log.warn(`LIVE MODE: skipping bet — previous window ${activeLiveBetWindow} still has an active bet`);
        } else {
          // Mark BEFORE placing (not after success) to prevent concurrent ticks from re-entering
          activeLiveBetWindow = start;

          // Pre-order balance check — skip if insufficient funds
          const { balance } = await getPolymarketBalance(prisma);
          if (balance < liveConfig.amount) {
            log.warn(`LIVE MODE: insufficient balance $${balance.toFixed(2)} < $${liveConfig.amount} — skipping bet`);
            activeLiveBetWindow = null; // Reset — no bet was placed
          } else {
            log.info(`LIVE MODE: placing $${liveConfig.amount} bet on ${result.direction} (balance=$${balance.toFixed(2)})...`);
            const betResult = await placePolymarketBet(
              prisma,
              result.direction,
              tokenId,
              liveConfig.amount,
              entryOdds,
            );
            if (betResult.success) {
              log.info(`LIVE BET OK: orderId=${betResult.orderId} @ CLOB ${betResult.executionPrice?.toFixed(3)}`);
              // Store actual CLOB execution price for accurate PnL
              if (betResult.executionPrice) {
                currentWindow.executionPrice = betResult.executionPrice;
              }
            } else {
              log.error(`LIVE BET FAILED: ${betResult.error}`);
              activeLiveBetWindow = null; // Reset on failure so next window can try
            }
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
  }

  // ── Update live state ─────────────────────────────────────────────────────
  liveState = {
    window: currentWindow ? { ...currentWindow } : null,
    klines1m: klines,
  };
  } finally {
    tickInProgress = false;
  }
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

  // Recovery: re-queue unverified predictions from the last 2 hours
  recoverPendingVerifications(prisma).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Recovery failed: ${msg}`);
  });

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
 * On startup, re-queue predictions that were never oracle-verified.
 * This handles server restarts that lost in-memory pendingVerifications.
 */
async function recoverPendingVerifications(prisma: PrismaClient): Promise<void> {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const unverified = await prisma.polymarketPrediction.findMany({
    where: {
      createdAt: { gte: twoHoursAgo },
      skipped: false,
      prediction: { not: null },
      polymarketSlug: { not: null },
      isCorrect: null,           // Not yet oracle-verified
    },
    select: {
      windowStart: true,
      polymarketSlug: true,
      prediction: true,
      entryOdds: true,
      executionPrice: true,
      betAmount: true,
    },
  });

  if (unverified.length === 0) return;

  for (const p of unverified) {
    pendingVerifications.push({
      windowStart: p.windowStart.getTime(),
      slug: p.polymarketSlug!,
      predictionDirection: p.prediction as 'UP' | 'DOWN',
      entryOdds: p.entryOdds,
      executionPrice: p.executionPrice,
      betAmount: p.betAmount,
      verifyAfterMs: Date.now(),               // check immediately
      giveUpAfterMs: Date.now() + 60 * 60 * 1000, // 60 min from now
    });
  }

  log.info(`Recovery: re-queued ${unverified.length} unverified predictions for oracle check`);
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
  tickInProgress = false; // Reset in case a tick was in progress when stopped
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

  // Win rate based on ORACLE-VERIFIED predictions only (wins + losses, excluding pending)
  const verified = wins + losses;
  const winRate = verified > 0 ? (wins / verified) * 100 : 0;
  const todayVerified = todayWins + todayLosses;
  const todayWinRate = todayVerified > 0 ? (todayWins / todayVerified) * 100 : 0;

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
