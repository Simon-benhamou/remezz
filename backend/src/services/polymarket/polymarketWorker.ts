import type { PrismaClient } from '.prisma/client';
import { getBinanceWebSocket, getKlinesWithMeta } from '../binanceWebSocket.js';
import { createLogger } from '../../utils/logger.js';
import { computeFiveMinScore } from './fiveMinScorer.js';
import { buildSlug, fetchPolymarketOdds, fetchPolymarketResult, fetchConditionId } from './polymarketClient.js';
import {
  getChainlinkBtcPrice,
  startChainlinkFeed,
  stopChainlinkFeed,
} from './chainlinkPriceFeed.js';
import { getLiveTradingConfig, placePolymarketBet, getPolymarketBalance, getPolymarketConfig, sellWinningTokens, redeemWinningTokens, getClobAskPrice, placeTakeProfitSell, checkOrderStatus, cancelClobOrder, MAX_CLOB_PRICE, getMaxPriceForScore, getActivePolymarketUserIds } from './polymarketTrader.js';
import type {
  Candle1m,
  PredictionStats,
  WindowState,
} from './polymarketTypes.js';

const log = createLogger('polymarket');

// ─── Constants ────────────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1000;           // 5 minutes
const DECISION_OFFSET_MS = 1 * 60 * 1000;   // 1 minute into the window ("Early Bird")
const POLL_INTERVAL_MS = 1000;               // 1 second
const SYMBOL = 'BTCUSDT';
const SYMBOL_SHORT = 'BTC';

// ─── Last-second reversal / hedge constants ─────────────────────────────────
const REVERSAL_OFFSET_MS = 4 * 60 * 1000;  // T+4:00 — check for last-second reversal/hedge
const REVERSAL_MAX_TOKEN_PRICE = 0.20;      // Only buy tokens below 20¢
const REVERSAL_MIN_ROC_PCT = 0.08;          // Minimum 2-candle reversal strength (%) — lottery only

// ─── Pre-sell constants ──────────────────────────────────────────────────────
// Sell winning tokens BEFORE the market closes (orderbook removed at resolution).
// Multiple attempts from T+4:00 to T+4:55 with progressive bid lowering.
const PRE_SELL_START_MS = 4 * 60 * 1000;        // T+4:00 — start attempting sells
const PRE_SELL_RETRY_MS = 10 * 1000;             // Retry every 10 seconds

// ─── Take-profit constants ──────────────────────────────────────────────────
// Place a GTC SELL limit order at 2.0x execution price for cheap entries.
// Only activates when executionPrice < 0.50 (entries < 50c). Expensive entries
// resolve normally — the $1 payout on a 55c entry is already good risk/reward.
const TP_MULTIPLIER = 2.0;                        // Sell at 2.0x the entry price
const TP_MAX_ENTRY_PRICE = 0.50;                  // TP on entries below 50c (widened from 40c for tiered pricing)
const TP_CHECK_INTERVAL_MS = 5_000;                // Check TP order status every 5s

// ─── Module state ─────────────────────────────────────────────────────────────

let currentWindow: WindowState | null = null;
let decisionMade = false;
let reversalChecked = false;
let lastPreSellAttemptMs = 0;
let lastTpCheckMs = 0;
let resolutionDone = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let pendingResolution: WindowState | null = null; // Previous window awaiting DB persist

// Prevent concurrent tick() executions: setInterval fires every 1s but tick() can take 3-5s
// (balance fetch, rederive, etc). Without this guard multiple ticks see decisionMade=false
// simultaneously → multiple bets placed per window.
let tickInProgress = false;

// Prevent placing a new live bet before the previous window's order is fully handled.
// Per-user: each userId maps to the windowStart of their active live bet.
const activeLiveBetByUser = new Map<string, number | null>(); // userId → windowStart

// ─── Pre-sell tracking ──────────────────────────────────────────────────────
// Tracks live bets placed this window so we can sell winning tokens at T+4:50.
interface PendingAutoSell {
  userId: string;
  tokenId: string;
  betAmount: number;
  executionPrice: number;
  direction: 'UP' | 'DOWN';
  isHedge: boolean;
  sold: boolean;
  tpOrderId: string | null;       // GTC sell order for mid-window take-profit
  tpTargetPrice: number | null;   // Target sell price (executionPrice * TP_MULTIPLIER)
}
let pendingAutoSells: PendingAutoSell[] = [];

// ─── Unredeemed token queue (post-resolution) ───────────────────────────────
// Tracks winning tokens that weren't pre-sold. Retries periodically.
interface UnredeemedToken {
  userId: string;
  windowStart: number;
  slug: string;
  tokenId: string;
  betAmount: number;
  executionPrice: number;
  direction: 'UP' | 'DOWN';
  isHedge: boolean;
  addedAt: number;
  attempts: number;
  lastAttemptAt: number;
  giveUpAt: number;           // Stop retrying after this time
}
let unredeemedTokens: UnredeemedToken[] = [];

// (GTC limit fallback removed — dips often signal reversals, FOK-or-skip is cleaner)

// ─── Polymarket resolution verification ───────────────────────────────────────
// Our preliminary resolution uses BTC price (start vs end). But Polymarket's oracle
// (Chainlink) may give a different result. We verify against the Gamma API ~3min
// after the window closes and correct the DB record if needed.

interface PendingVerification {
  userId: string | null;       // null = virtual-only prediction (no live trade)
  windowStart: number;         // ms timestamp — DB key
  slug: string;                // Polymarket slug for Gamma API lookup
  predictionDirection: 'UP' | 'DOWN' | null; // what we predicted
  entryOdds: number | null;    // Gamma API odds (for display)
  executionPrice: number | null; // Actual CLOB price paid (for PnL)
  betAmount: number | null;    // USDC amount for dollar PnL
  tokenId: string | null;      // CLOB token ID (needed for auto-sell)
  verifyAfterMs: number;       // don't check until this time (wait for oracle)
  giveUpAfterMs: number;       // stop retrying after this time
  isHedge?: boolean;           // true = hedge bet (skip DB update, only auto-sell)
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

  // Release per-user active-bet guards for this window
  for (const [userId, ws] of activeLiveBetByUser) {
    if (ws === w.windowStart) activeLiveBetByUser.delete(userId);
  }

  const skipped = w.status === 'skipped';
  const slug = buildSlug(SYMBOL_SHORT, w.windowStart);

  // ── Shared prediction row (userId=null) — virtual signal/result ───────
  try {
    await prisma.polymarketPrediction.create({
      data: {
        userId: null,
        symbol: SYMBOL_SHORT,
        windowStart: new Date(w.windowStart),
        windowEnd: new Date(w.windowEnd),
        startPrice: w.startPrice,
        endPrice,
        prediction: w.prediction?.direction ?? null,
        confidence: w.prediction?.confidence ?? null,
        actualResult: preliminaryResult,
        entryOdds: w.entryOdds,
        executionPrice: null,      // Shared row has no execution (that's per-user)
        tokenId: null,
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
    log.error(`DB persist error (shared row): ${msg}`);
  }

  // ── Per-user live trade rows ──────────────────────────────────────────
  // Each user who traded in this window gets their own prediction row with
  // their userId, executionPrice, betAmount, and tokenId.
  const userSells = pendingAutoSells.filter((s) => !s.isHedge);
  const seenUsers = new Set<string>();
  for (const sell of userSells) {
    if (seenUsers.has(sell.userId)) continue; // One row per user per window
    seenUsers.add(sell.userId);

    try {
      await prisma.polymarketPrediction.create({
        data: {
          userId: sell.userId,
          symbol: SYMBOL_SHORT,
          windowStart: new Date(w.windowStart),
          windowEnd: new Date(w.windowEnd),
          startPrice: w.startPrice,
          endPrice,
          prediction: w.prediction?.direction ?? null,
          confidence: w.prediction?.confidence ?? null,
          actualResult: preliminaryResult,
          entryOdds: w.entryOdds,
          executionPrice: sell.executionPrice,
          tokenId: sell.tokenId,
          betAmount: sell.betAmount,
          simulatedPnl: null,
          scoreBreakdown: w.prediction?.score
            ? JSON.parse(JSON.stringify(w.prediction.score))
            : undefined,
          isCorrect: null,
          skipped: false,
          polymarketSlug: slug,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`DB persist error (user ${sell.userId.slice(0, 8)}): ${msg}`);
    }
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
    // Shared (virtual) verification entry
    pendingVerifications.push({
      userId: null,
      windowStart: w.windowStart,
      slug,
      predictionDirection: w.prediction?.direction ?? null,
      entryOdds: w.entryOdds,
      executionPrice: null,
      betAmount: w.betAmount,
      tokenId: null,
      verifyAfterMs: Date.now() + 3 * 60 * 1000,   // check after 3 min
      giveUpAfterMs: Date.now() + 60 * 60 * 1000,  // give up after 60 min
    });

    // Per-user verification entries (for auto-sell after oracle confirmation)
    const verifiedUsers = new Set<string>();
    for (const sell of userSells) {
      if (verifiedUsers.has(sell.userId)) continue; // One verification per user
      verifiedUsers.add(sell.userId);
      pendingVerifications.push({
        userId: sell.userId,
        windowStart: w.windowStart,
        slug,
        predictionDirection: w.prediction?.direction ?? null,
        entryOdds: w.entryOdds,
        executionPrice: sell.executionPrice,
        betAmount: sell.betAmount,
        tokenId: sell.tokenId,
        verifyAfterMs: Date.now() + 3 * 60 * 1000,
        giveUpAfterMs: Date.now() + 60 * 60 * 1000,
      });
    }
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

      // Oracle resolved — compute isCorrect for this bet's direction
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

      const userLabel = v.userId ? `[${v.userId.slice(0, 8)}]` : '[shared]';

      // ── Hedge bets: skip DB update, only auto-sell ────────────────
      if (v.isHedge) {
        if (!v.userId) { toRemove.push(i); continue; } // Hedge must have a userId

        const hedgeLabel = `HEDGE ${v.predictionDirection} $${amt}`;
        if (isCorrect) {
          log.info(`Oracle ${userLabel}: ${hedgeLabel} → WIN (PnL +$${simulatedPnl?.toFixed(2)}) | ${v.slug}`);
        } else {
          log.info(`Oracle ${userLabel}: ${hedgeLabel} → LOSS (PnL $${simulatedPnl?.toFixed(2)}) | ${v.slug}`);
        }

        if (isCorrect && v.tokenId && v.betAmount && v.executionPrice) {
          const sellResult = await sellWinningTokens(prisma, v.userId, v.tokenId, v.betAmount, v.executionPrice, 0.80);
          if (sellResult.success) {
            log.info(`HEDGE auto-sell OK ${userLabel}: $${sellResult.usdcReceived?.toFixed(2)} USDC from ${v.slug}`);
          } else if (sellResult.error?.includes('Market closed') || sellResult.error?.includes('orderbook')) {
            // CLOB gone — try CTF on-chain redeem
            const conditionId = await fetchConditionId(v.slug);
            if (conditionId) {
              const redeemResult = await redeemWinningTokens(prisma, v.userId, conditionId, v.betAmount, v.executionPrice);
              if (redeemResult.success) {
                log.info(`HEDGE CTF redeem OK ${userLabel}: ~$${redeemResult.usdcReceived?.toFixed(2)} USDC from ${v.slug}`);
              } else {
                log.warn(`HEDGE CTF redeem failed ${userLabel} for ${v.slug}: ${redeemResult.error} — claim manually`);
              }
            } else {
              log.warn(`HEDGE ${userLabel}: no conditionId for ${v.slug} — claim manually`);
            }
          } else {
            const alreadyQueued = unredeemedTokens.some((u) => u.windowStart === v.windowStart && u.tokenId === v.tokenId && u.userId === v.userId);
            if (!alreadyQueued) {
              unredeemedTokens.push({
                userId: v.userId,
                windowStart: v.windowStart,
                slug: v.slug,
                tokenId: v.tokenId,
                betAmount: v.betAmount,
                executionPrice: v.executionPrice,
                direction: v.predictionDirection ?? 'UP',
                isHedge: true,
                addedAt: Date.now(),
                attempts: 0,
                lastAttemptAt: 0,
                giveUpAt: Date.now() + 30 * 60 * 1000,
              });
              log.info(`HEDGE UNREDEEMED ${userLabel}: queued ${v.slug} for retry`);
            }
          }
        }

        toRemove.push(i);
        continue;
      }

      // ── Update DB with authoritative oracle result ────────────────
      // Build WHERE clause: scoped by userId (null for shared, specific for per-user)
      const dbWhere = v.userId
        ? { windowStart: new Date(v.windowStart), symbol: SYMBOL_SHORT, userId: v.userId }
        : { windowStart: new Date(v.windowStart), symbol: SYMBOL_SHORT, userId: { equals: null } };

      const existing = await prisma.polymarketPrediction.findFirst({
        where: dbWhere,
        select: { actualResult: true },
      });

      const preliminaryMatched = existing?.actualResult === oracleResult;

      await prisma.polymarketPrediction.updateMany({
        where: dbWhere,
        data: { actualResult: oracleResult, isCorrect, simulatedPnl },
      });

      if (preliminaryMatched) {
        log.info(`Oracle confirmed ${userLabel}: ${v.slug} → ${oracleResult} | isCorrect=${isCorrect}`);
      } else {
        log.warn(
          `Oracle CORRECTION ${userLabel}: ${v.slug} | preliminary=${existing?.actualResult} → oracle=${oracleResult} | isCorrect=${isCorrect}`,
        );
      }

      // ── Recover USDC from winning tokens (per-user only) ─────────
      // Shared (userId=null) verifications don't have tokens to sell
      if (v.userId && isCorrect && v.tokenId && v.betAmount && v.executionPrice) {
        const sellResult = await sellWinningTokens(prisma, v.userId, v.tokenId, v.betAmount, v.executionPrice, 0.80);
        if (sellResult.success) {
          log.info(`Auto-sell OK ${userLabel}: $${sellResult.usdcReceived?.toFixed(2)} USDC from ${v.slug}`);
          const realPnl = (sellResult.usdcReceived ?? 0) - v.betAmount;
          await prisma.polymarketPrediction.updateMany({
            where: dbWhere,
            data: {
              usdcReceived: sellResult.usdcReceived,
              sellPrice: sellResult.sellPrice,
              soldAt: new Date(),
              realPnl,
            },
          }).catch(() => {});
        } else if (sellResult.error?.includes('Market closed') || sellResult.error?.includes('orderbook')) {
          // CLOB orderbook removed — try CTF on-chain redeem
          log.info(`CLOB closed for ${v.slug} ${userLabel}, trying CTF redeem...`);
          const conditionId = await fetchConditionId(v.slug);
          if (conditionId) {
            const redeemResult = await redeemWinningTokens(prisma, v.userId, conditionId, v.betAmount, v.executionPrice);
            if (redeemResult.success) {
              log.info(`CTF redeem OK ${userLabel}: $${redeemResult.usdcReceived?.toFixed(2)} USDC from ${v.slug}`);
              const realPnl = (redeemResult.usdcReceived ?? 0) - v.betAmount;
              await prisma.polymarketPrediction.updateMany({
                where: dbWhere,
                data: {
                  usdcReceived: redeemResult.usdcReceived,
                  sellPrice: 1.0,
                  soldAt: new Date(),
                  realPnl,
                },
              }).catch(() => {});
            } else {
              // CTF failed (likely proxy wallet issue) — queue for retry
              log.warn(`CTF redeem failed ${userLabel} for ${v.slug}: ${redeemResult.error} — queuing for retry`);
              const alreadyQueued = unredeemedTokens.some((u) => u.windowStart === v.windowStart && u.tokenId === v.tokenId && u.userId === v.userId);
              if (!alreadyQueued) {
                unredeemedTokens.push({
                  userId: v.userId,
                  windowStart: v.windowStart, slug: v.slug, tokenId: v.tokenId,
                  betAmount: v.betAmount, executionPrice: v.executionPrice,
                  direction: v.predictionDirection ?? 'UP', isHedge: false,
                  addedAt: Date.now(), attempts: 0, lastAttemptAt: 0,
                  giveUpAt: Date.now() + 30 * 60 * 1000,
                });
              }
            }
          } else {
            log.warn(`No conditionId ${userLabel} for ${v.slug} — queuing for retry`);
            const alreadyQueued = unredeemedTokens.some((u) => u.windowStart === v.windowStart && u.tokenId === v.tokenId && u.userId === v.userId);
            if (!alreadyQueued) {
              unredeemedTokens.push({
                userId: v.userId,
                windowStart: v.windowStart, slug: v.slug, tokenId: v.tokenId,
                betAmount: v.betAmount, executionPrice: v.executionPrice,
                direction: v.predictionDirection ?? 'UP', isHedge: false,
                addedAt: Date.now(), attempts: 0, lastAttemptAt: 0,
                giveUpAt: Date.now() + 30 * 60 * 1000,
              });
            }
          }
        } else {
          // Other CLOB error — queue for retry
          const alreadyQueued = unredeemedTokens.some((u) => u.windowStart === v.windowStart && u.tokenId === v.tokenId && u.userId === v.userId);
          if (!alreadyQueued) {
            unredeemedTokens.push({
              userId: v.userId,
              windowStart: v.windowStart, slug: v.slug, tokenId: v.tokenId,
              betAmount: v.betAmount, executionPrice: v.executionPrice,
              direction: v.predictionDirection ?? 'UP', isHedge: false,
              addedAt: Date.now(), attempts: 0, lastAttemptAt: 0,
              giveUpAt: Date.now() + 30 * 60 * 1000,
            });
            log.info(`UNREDEEMED ${userLabel}: queued ${v.slug} for retry (CLOB sell failed: ${sellResult.error})`);
          }
        }
      }

      // Set realPnl for losses immediately (per-user rows)
      if (v.userId && isCorrect === false && v.betAmount) {
        await prisma.polymarketPrediction.updateMany({
          where: dbWhere,
          data: { realPnl: -v.betAmount },
        }).catch(() => {});
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

// ─── Unredeemed token retry ──────────────────────────────────────────────────

/**
 * Retry selling unredeemed winning tokens.
 * Schedule: every 30s for 10min, every 2min for 20min, then give up.
 */
async function processUnredeemedTokens(prisma: PrismaClient): Promise<void> {
  const now = Date.now();
  const toRemove: number[] = [];

  for (let i = 0; i < unredeemedTokens.length; i++) {
    const u = unredeemedTokens[i];

    if (now > u.giveUpAt) {
      log.warn(`UNREDEEMED: gave up on ${u.slug} after ${u.attempts} attempts — $${(u.betAmount / u.executionPrice).toFixed(2)} tokens stuck`);
      toRemove.push(i);
      continue;
    }

    // Retry interval: 30s for first 10min, 2min after that
    const age = now - u.addedAt;
    const retryInterval = age < 10 * 60 * 1000 ? 30_000 : 2 * 60 * 1000;
    if (now - u.lastAttemptAt < retryInterval) continue;

    u.lastAttemptAt = now;
    u.attempts++;

    const uLabel = `[${u.userId.slice(0, 8)}]`;
    try {
      const sellResult = await sellWinningTokens(prisma, u.userId, u.tokenId, u.betAmount, u.executionPrice, 0.80);
      if (sellResult.success) {
        log.info(`UNREDEEMED SOLD ${uLabel}: ${u.slug} — $${sellResult.usdcReceived?.toFixed(2)} USDC @ ${sellResult.sellPrice?.toFixed(3)} (attempt ${u.attempts})`);
        if (!u.isHedge) {
          const realPnl = (sellResult.usdcReceived ?? 0) - u.betAmount;
          const dbWhere = { windowStart: new Date(u.windowStart), symbol: 'BTC' as const, userId: u.userId };
          await prisma.polymarketPrediction.updateMany({
            where: dbWhere,
            data: {
              usdcReceived: sellResult.usdcReceived,
              sellPrice: sellResult.sellPrice,
              soldAt: new Date(),
              realPnl,
            },
          }).catch(() => {});
        }
        toRemove.push(i);
      } else {
        // CLOB sell failed (orderbook removed, bid too low, or unknown error) — try CTF on-chain redeem
        log.info(`UNREDEEMED ${uLabel}: CLOB sell failed for ${u.slug} (${sellResult.error}), trying CTF redeem...`);
        const conditionId = await fetchConditionId(u.slug);
        if (conditionId) {
          const redeemResult = await redeemWinningTokens(prisma, u.userId, conditionId, u.betAmount, u.executionPrice);
          if (redeemResult.success) {
            log.info(`UNREDEEMED REDEEMED ${uLabel}: ${u.slug} — ~$${redeemResult.usdcReceived?.toFixed(2)} USDC via CTF`);
            if (!u.isHedge) {
              const realPnl = (redeemResult.usdcReceived ?? 0) - u.betAmount;
              const dbWhere = { windowStart: new Date(u.windowStart), symbol: 'BTC' as const, userId: u.userId };
              await prisma.polymarketPrediction.updateMany({
                where: dbWhere,
                data: {
                  usdcReceived: redeemResult.usdcReceived,
                  sellPrice: 1.0,
                  soldAt: new Date(),
                  realPnl,
                },
              }).catch(() => {});
            }
            toRemove.push(i);
          } else {
            log.warn(`CTF redeem failed ${uLabel} for ${u.slug}: ${redeemResult.error} — claim manually on Polymarket`);
            toRemove.push(i); // Stop retrying, CLOB is gone and CTF failed
          }
        } else {
          log.warn(`No conditionId found ${uLabel} for ${u.slug} — claim manually on Polymarket`);
          toRemove.push(i); // Stop retrying
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`UNREDEEMED retry error ${uLabel} for ${u.slug}: ${msg}`);
    }
  }

  for (let i = toRemove.length - 1; i >= 0; i--) {
    unredeemedTokens.splice(toRemove[i], 1);
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

  // ── Process unredeemed token retries ──────────────────────────────────
  if (unredeemedTokens.length > 0) {
    await processUnredeemedTokens(prisma);
  }

  // ── New window detection ──────────────────────────────────────────────────
  if (!currentWindow || currentWindow.windowStart !== start) {
    // Snapshot previous window for resolution (uses final currentPrice)
    if (currentWindow && !resolutionDone) {
      pendingResolution = { ...currentWindow };
    }

    // Cancel any outstanding TP orders before window transition (per-user)
    for (const s of pendingAutoSells) {
      if (s.tpOrderId && !s.sold) {
        await cancelClobOrder(prisma, s.userId, s.tpOrderId).catch(() => {});
        s.tpOrderId = null;
      }
    }

    // Move unsold tokens to unredeemed queue for post-resolution retry (per-user)
    if (currentWindow) {
      const unsold = pendingAutoSells.filter((s) => !s.sold);
      const slug = buildSlug(SYMBOL_SHORT, currentWindow.windowStart);
      for (const s of unsold) {
        if (s.executionPrice > 0) {
          unredeemedTokens.push({
            userId: s.userId,
            windowStart: currentWindow.windowStart,
            slug,
            tokenId: s.tokenId,
            betAmount: s.betAmount,
            executionPrice: s.executionPrice,
            direction: s.direction,
            isHedge: s.isHedge,
            addedAt: Date.now(),
            attempts: 0,
            lastAttemptAt: 0,
            giveUpAt: Date.now() + 30 * 60 * 1000,
          });
          log.info(`UNREDEEMED [${s.userId.slice(0, 8)}]: queued ${s.isHedge ? 'HEDGE' : 'Early Bird'} ${s.direction} from ${slug} for retry`);
        }
      }
    }

    decisionMade = false;
    reversalChecked = false;
    lastPreSellAttemptMs = 0;
    lastTpCheckMs = 0;
    resolutionDone = false;
    pendingAutoSells = [];

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
      tokenId: null,
      observationStatus: null,
      observationInitialAsk: null,
      observationBestAsk: null,
      observationTrigger: null,
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
      currentWindow.tokenId = tokenId;
      currentWindow.status = 'predicted';

      // Default bet amount for virtual PnL calculation
      currentWindow.betAmount = 5; // default, overridden per-user below

      log.info(
        `Prediction: ${result.direction} (score=${result.score.total}, conf=${result.confidence}) | odds=${entryOdds.toFixed(3)} | slug=${slug}`,
      );

      // ── Per-user live trading ─────────────────────────────────────────
      // Market data (candles, scoring) is shared. Trading iterates over active users.
      const activeUsers = await getActivePolymarketUserIds(prisma);
      let anyUserFilled = false;

      for (const userId of activeUsers) {
        const uLabel = `[${userId.slice(0, 8)}]`;
        const liveConfig = await getLiveTradingConfig(prisma, userId);
        if (!liveConfig || !tokenId) continue;

        const userActiveBet = activeLiveBetByUser.get(userId) ?? null;
        if (userActiveBet !== null && userActiveBet !== start) {
          log.warn(`LIVE MODE ${uLabel}: skipping bet — previous window ${userActiveBet} still active`);
          continue;
        }

        activeLiveBetByUser.set(userId, start);

        const { balance } = await getPolymarketBalance(prisma, userId);
        if (balance < liveConfig.amount) {
          log.warn(`LIVE MODE ${uLabel}: insufficient balance $${balance.toFixed(2)} < $${liveConfig.amount} — skipping bet`);
          activeLiveBetByUser.delete(userId);
          continue;
        }

        const score = result.confidence;
        const tierMax = getMaxPriceForScore(score);

        // Try immediate entry — placePolymarketBet fetches CLOB ask and checks tier cap
        const betResult = await placePolymarketBet(
          prisma, userId, result.direction, tokenId, liveConfig.amount, entryOdds, false, score,
        );

        if (betResult.success) {
          log.info(`LIVE BET OK ${uLabel}: orderId=${betResult.orderId} @ CLOB ${betResult.executionPrice?.toFixed(3)} (score=${score}, cap=${tierMax})`);
          anyUserFilled = true;
          if (betResult.executionPrice) {
            // Update shared window state with last user's execution (for display)
            currentWindow.executionPrice = betResult.executionPrice;
            currentWindow.betAmount = liveConfig.amount;

            const sell: PendingAutoSell = {
              userId,
              tokenId,
              betAmount: liveConfig.amount,
              executionPrice: betResult.executionPrice,
              direction: result.direction,
              isHedge: false,
              sold: false,
              tpOrderId: null,
              tpTargetPrice: null,
            };
            pendingAutoSells.push(sell);

            // Place take-profit GTC sell for entries below 50c
            if (betResult.executionPrice < TP_MAX_ENTRY_PRICE) {
              const tpPrice = Math.min(betResult.executionPrice * TP_MULTIPLIER, 0.95);
              const tpResult = await placeTakeProfitSell(prisma, userId, tokenId, liveConfig.amount, betResult.executionPrice, tpPrice);
              if (tpResult.success && tpResult.orderId) {
                sell.tpOrderId = tpResult.orderId;
                sell.tpTargetPrice = tpPrice;
                log.info(`TP ORDER ${uLabel}: sell @ ${(tpPrice * 100).toFixed(0)}c (entry ${(betResult.executionPrice * 100).toFixed(0)}c, ${TP_MULTIPLIER}x)`);
              }
            }
          }
        } else if (betResult.error?.startsWith('EV too low')) {
          // CLOB ask > tier cap → skip (no GTC limit — dips often signal reversals)
          log.info(`CLOB above cap ${uLabel} ${tierMax.toFixed(2)} (score=${score}) — skipping (no limit fallback)`);
          activeLiveBetByUser.delete(userId);
        } else {
          log.error(`LIVE BET FAILED ${uLabel}: ${betResult.error}`);
          activeLiveBetByUser.delete(userId);
        }
      }

      // Update observation status for display
      currentWindow.observationStatus = anyUserFilled ? 'filled' : (activeUsers.length > 0 ? 'skipped_ev' : 'idle');
    } else {
      // Score below threshold — skip this window
      currentWindow.status = 'skipped';
      log.info('Window skipped (score < 40)');
    }
  }

  // ── Last-second reversal / hedge (T+4:00) — per-user ─────────────────────
  // Two modes:
  //   HEDGE:   Early Bird active → $1 insurance on opposite token (no signal needed)
  //   LOTTERY: No Early Bird → full amount on reversal (strong signal required)
  // Both only buy if opposite token < 20¢ (massive asymmetry).
  if (elapsed >= REVERSAL_OFFSET_MS && !reversalChecked && currentWindow) {
    reversalChecked = true;

    // Window trend based on price movement so far (shared analysis)
    const trend: 'UP' | 'DOWN' = currentWindow.currentPrice >= currentWindow.startPrice ? 'UP' : 'DOWN';
    const reverseDir: 'UP' | 'DOWN' = trend === 'UP' ? 'DOWN' : 'UP';

    // Check reversal signal once (shared — not per-user)
    let lotterySignalOk = false;
    const recentCandles = klines
      .filter((k) => k.isFinal && k.timestamp >= start)
      .slice(-2);

    if (recentCandles.length >= 2) {
      const allReversed = recentCandles.every((c) =>
        reverseDir === 'UP' ? c.close > c.open : c.close < c.open,
      );
      const bodiesStrong = recentCandles.every((c) => {
        const range = c.high - c.low;
        return range > 0 && Math.abs(c.close - c.open) / range > 0.5;
      });
      const moveStart = recentCandles[0].open;
      const moveEnd = recentCandles[recentCandles.length - 1].close;
      const moveRocPct = Math.abs((moveEnd - moveStart) / moveStart) * 100;

      lotterySignalOk = allReversed && bodiesStrong && moveRocPct >= REVERSAL_MIN_ROC_PCT;

      if (lotterySignalOk) {
        log.info(`LOTTERY signal: trend=${trend}, reverse=${reverseDir}, ROC=${moveRocPct.toFixed(3)}%`);
      }
    }

    // Fetch reverse token once (shared — avoids duplicate Gamma API calls)
    const slug = buildSlug(SYMBOL_SHORT, start);
    const odds = await fetchPolymarketOdds(slug);
    const reverseTokenId = reverseDir === 'UP' ? odds.upTokenId : odds.downTokenId;
    const reverseEntryOdds = reverseDir === 'UP' ? odds.upPrice : odds.downPrice;

    // Per-user hedge/lottery trading
    const activeUsers = await getActivePolymarketUserIds(prisma);
    for (const userId of activeUsers) {
      const uLabel = `[${userId.slice(0, 8)}]`;
      const liveConfig = await getLiveTradingConfig(prisma, userId);
      if (!liveConfig) continue;

      const hasEarlyBird = activeLiveBetByUser.get(userId) === start;
      const signalOk = hasEarlyBird || lotterySignalOk; // hedge always OK, lottery needs signal

      if (!signalOk) continue;

      const mode = hasEarlyBird ? 'HEDGE' : 'LOTTERY';
      const pmConfig = await getPolymarketConfig(prisma, userId);
      const betAmount = hasEarlyBird ? pmConfig.hedgeAmount : liveConfig.amount;

      if (!reverseTokenId) continue;

      // getClobAskPrice needs userId for credentials
      const clobAsk = await getClobAskPrice(prisma, userId, reverseTokenId);

      // HEDGE: accept up to MAX_CLOB_PRICE (insurance, even at poor odds)
      // LOTTERY: only buy below 20¢ (need massive asymmetry to justify)
      const maxPrice = hasEarlyBird ? MAX_CLOB_PRICE : REVERSAL_MAX_TOKEN_PRICE;

      if (clobAsk !== null && clobAsk > 0 && clobAsk <= maxPrice) {
        const potentialWin = betAmount / clobAsk;
        log.info(
          `${mode} ${uLabel}: ${reverseDir} @ CLOB ${clobAsk.toFixed(3)} ` +
          `($${betAmount} → potential $${potentialWin.toFixed(2)} if WIN)`,
        );

        // Balance check
        const { balance } = await getPolymarketBalance(prisma, userId);
        if (balance < betAmount) {
          log.warn(`${mode} ${uLabel}: insufficient balance $${balance.toFixed(2)} — skipping`);
          continue;
        }

        // For LOTTERY: track in window state (it becomes the prediction)
        // For HEDGE: don't overwrite Early Bird prediction
        if (!hasEarlyBird) {
          activeLiveBetByUser.set(userId, start);
          currentWindow.prediction = {
            direction: reverseDir,
            confidence: 0,
            score: { volumeSpike: 0, microRoc: 0, bodyRatio: 0, wickRejection: 0, candleAlignment: 0, preWindowMomentum: 0, total: 0 },
            microRocPct: 0,
          };
          currentWindow.entryOdds = reverseEntryOdds;
          currentWindow.tokenId = reverseTokenId;
          currentWindow.betAmount = betAmount;
          currentWindow.status = 'predicted';
        }

        const betResult = await placePolymarketBet(prisma, userId, reverseDir, reverseTokenId, betAmount, reverseEntryOdds, hasEarlyBird);
        if (betResult.success) {
          log.info(`${mode} OK ${uLabel}: orderId=${betResult.orderId} @ CLOB ${betResult.executionPrice?.toFixed(3)}`);
          if (!hasEarlyBird && betResult.executionPrice) {
            currentWindow.executionPrice = betResult.executionPrice;
          }

          // Track for pre-sell at T+4:50
          if (betResult.executionPrice) {
            pendingAutoSells.push({
              userId,
              tokenId: reverseTokenId,
              betAmount,
              executionPrice: betResult.executionPrice,
              direction: reverseDir,
              isHedge: hasEarlyBird,
              sold: false,
              tpOrderId: null,   // No TP for hedge/reversal bets (placed at T+4:00, too late)
              tpTargetPrice: null,
            });
          }

          // Track hedge bet for oracle verification (DB update skip + fallback auto-sell)
          if (hasEarlyBird) {
            pendingVerifications.push({
              userId,
              windowStart: start,
              slug,
              predictionDirection: reverseDir,
              entryOdds: reverseEntryOdds,
              executionPrice: betResult.executionPrice ?? null,
              betAmount,
              tokenId: reverseTokenId,
              verifyAfterMs: Date.now() + 3 * 60 * 1000,
              giveUpAfterMs: Date.now() + 60 * 60 * 1000,
              isHedge: true,
            });
          }
        } else {
          log.error(`${mode} FAILED ${uLabel}: ${betResult.error}`);
          if (!hasEarlyBird) activeLiveBetByUser.delete(userId);
        }
      } else if (clobAsk !== null) {
        log.info(
          `${mode} ${uLabel}: ${reverseDir} token @ ${clobAsk.toFixed(3)} > ${maxPrice} — too expensive`,
        );
      }
    }
  }

  // ── Take-profit monitoring: check GTC sell order status (per-user) ──────
  // Between buy time and T+4:00, check if any TP orders have been filled.
  // At T+4:00, cancel unfilled TP orders so pre-sell can take over.
  if (currentWindow && pendingAutoSells.length > 0) {
    const hasTpOrders = pendingAutoSells.some((s) => s.tpOrderId && !s.sold);
    const now = Date.now();

    if (hasTpOrders) {
      if (elapsed >= PRE_SELL_START_MS) {
        // T+4:00 reached — cancel all unfilled TP orders, pre-sell takes over
        for (const sell of pendingAutoSells) {
          if (sell.tpOrderId && !sell.sold) {
            await cancelClobOrder(prisma, sell.userId, sell.tpOrderId).catch(() => {});
            log.info(`TP ORDER cancelled at T+4:00 [${sell.userId.slice(0, 8)}]: ${sell.direction} (switching to pre-sell)`);
            sell.tpOrderId = null;
          }
        }
      } else if (now - lastTpCheckMs >= TP_CHECK_INTERVAL_MS) {
        // Check TP order status every 5s
        lastTpCheckMs = now;

        for (const sell of pendingAutoSells) {
          if (!sell.tpOrderId || sell.sold) continue;

          const status = await checkOrderStatus(prisma, sell.userId, sell.tpOrderId);
          if (status === 'MATCHED' || status === 'FILLED') {
            sell.sold = true;
            const tokenAmount = sell.betAmount / sell.executionPrice;
            const usdcReceived = tokenAmount * (sell.tpTargetPrice ?? sell.executionPrice);
            const realPnl = usdcReceived - sell.betAmount;

            log.info(
              `TP FILLED [${sell.userId.slice(0, 8)}]: ${sell.isHedge ? 'HEDGE' : 'Early Bird'} ${sell.direction} — ` +
              `$${usdcReceived.toFixed(2)} USDC @ ${((sell.tpTargetPrice ?? 0) * 100).toFixed(0)}c ` +
              `(entry ${(sell.executionPrice * 100).toFixed(0)}c, profit +$${realPnl.toFixed(2)})`,
            );

            // Update DB with real PnL (scoped to user)
            if (!sell.isHedge) {
              await prisma.polymarketPrediction.updateMany({
                where: { windowStart: new Date(currentWindow.windowStart), symbol: 'BTC', userId: sell.userId },
                data: {
                  usdcReceived,
                  sellPrice: sell.tpTargetPrice,
                  soldAt: new Date(),
                  realPnl,
                },
              }).catch(() => {});
            }

            sell.tpOrderId = null; // Clear the order reference
          } else if (status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED') {
            log.warn(`TP ORDER ${status} [${sell.userId.slice(0, 8)}]: ${sell.direction}`);
            sell.tpOrderId = null;
          }
          // 'LIVE' = still open, keep waiting
        }
      }
    }
  }

  // ── Aggressive pre-sell: T+4:00 → T+4:55 (per-user, multiple attempts) ─
  // Retry every 10s with progressive bid lowering:
  //   T+4:00-4:19 → bid >= 0.90
  //   T+4:20-4:39 → bid >= 0.85
  //   T+4:40-4:55 → bid >= 0.80
  if (elapsed >= PRE_SELL_START_MS && currentWindow && pendingAutoSells.length > 0) {
    const unsold = pendingAutoSells.filter((s) => !s.sold);
    const now = Date.now();

    if (unsold.length > 0 && now - lastPreSellAttemptMs >= PRE_SELL_RETRY_MS) {
      lastPreSellAttemptMs = now;

      // Progressive bid threshold
      const minBid = elapsed >= 280_000 ? 0.80 : elapsed >= 260_000 ? 0.85 : 0.90;

      for (const sell of unsold) {
        try {
          const sellResult = await sellWinningTokens(prisma, sell.userId, sell.tokenId, sell.betAmount, sell.executionPrice, minBid);
          if (sellResult.success) {
            sell.sold = true;
            log.info(
              `PRE-SELL OK [${sell.userId.slice(0, 8)}]: ${sell.isHedge ? 'HEDGE' : 'Early Bird'} ${sell.direction} — ` +
              `$${sellResult.usdcReceived?.toFixed(2)} USDC @ ${sellResult.sellPrice?.toFixed(3)}`,
            );

            // Update DB with real PnL data (scoped to user)
            if (!sell.isHedge) {
              const realPnl = (sellResult.usdcReceived ?? 0) - sell.betAmount;
              await prisma.polymarketPrediction.updateMany({
                where: { windowStart: new Date(currentWindow.windowStart), symbol: 'BTC', userId: sell.userId },
                data: {
                  usdcReceived: sellResult.usdcReceived,
                  sellPrice: sellResult.sellPrice,
                  soldAt: new Date(),
                  realPnl,
                },
              });
            }
          }
          // If sell fails (bid too low = likely losing token), silent — will retry next cycle
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`PRE-SELL error [${sell.userId.slice(0, 8)}] for ${sell.direction}: ${msg}`);
        }
      }
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
      userId: true,
      windowStart: true,
      polymarketSlug: true,
      prediction: true,
      entryOdds: true,
      executionPrice: true,
      betAmount: true,
      tokenId: true,
    },
  });

  if (unverified.length === 0) return;

  for (const p of unverified) {
    pendingVerifications.push({
      userId: p.userId ?? null,
      windowStart: p.windowStart.getTime(),
      slug: p.polymarketSlug!,
      predictionDirection: p.prediction as 'UP' | 'DOWN',
      entryOdds: p.entryOdds,
      executionPrice: p.executionPrice,
      betAmount: p.betAmount,
      tokenId: p.tokenId,
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
  activeLiveBetByUser.clear(); // Reset so a restart can place bets immediately
  tickInProgress = false; // Reset in case a tick was in progress when stopped
  pendingAutoSells = [];
  lastPreSellAttemptMs = 0;
  lastTpCheckMs = 0;
  unredeemedTokens = [];
}

/**
 * Returns whether the worker is currently running.
 */
export function isPolymarketWorkerRunning(): boolean {
  return intervalHandle !== null;
}

/**
 * Returns the current unredeemed token queue for API/frontend visibility.
 */
export function getUnredeemedTokens(userId?: string): Array<{
  slug: string;
  direction: string;
  amount: number;
  status: string;
  attempts: number;
  addedAt: number;
}> {
  const filtered = userId
    ? unredeemedTokens.filter((u) => u.userId === userId)
    : unredeemedTokens;
  return filtered.map((u) => ({
    slug: u.slug,
    direction: u.direction,
    amount: u.betAmount / u.executionPrice, // tokens held
    status: Date.now() > u.giveUpAt ? 'stuck' : 'retrying',
    attempts: u.attempts,
    addedAt: u.addedAt,
  }));
}

/**
 * Aggregated prediction stats from the database.
 */
export async function getPolymarketStats(
  prisma: PrismaClient,
  userId?: string,
): Promise<PredictionStats> {
  const predictions = await prisma.polymarketPrediction.findMany({
    where: userId ? { userId } : undefined,
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

  // Real traded stats (orders actually placed & filled)
  let tradedWins = 0;
  let tradedLosses = 0;
  let tradedPnl = 0;
  let todayTradedWins = 0;
  let todayTradedLosses = 0;
  let todayTradedPnl = 0;

  for (const p of predictions) {
    const isToday = p.createdAt >= todayStart;
    const hasExecution = p.executionPrice != null; // Order was actually placed & filled

    if (p.skipped) {
      skips++;
    } else {
      totalPredictions++;
      if (p.isCorrect === true) {
        wins++;
        if (hasExecution) tradedWins++;
      } else if (p.isCorrect === false) {
        losses++;
        if (hasExecution) tradedLosses++;
      }
      if (p.simulatedPnl !== null) {
        cumulativePnl += p.simulatedPnl;
      }
      // Use realPnl when available, fall back to simulatedPnl
      if (hasExecution) {
        const pnl = p.realPnl ?? p.simulatedPnl ?? 0;
        tradedPnl += pnl;
      }
    }

    if (isToday) {
      todayWindows++;
      if (!p.skipped) {
        todayPredictions++;
        if (p.isCorrect === true) {
          todayWins++;
          if (hasExecution) todayTradedWins++;
        } else if (p.isCorrect === false) {
          todayLosses++;
          if (hasExecution) todayTradedLosses++;
        }
        if (p.simulatedPnl !== null) todayPnl += p.simulatedPnl;
        if (hasExecution) {
          const pnl = p.realPnl ?? p.simulatedPnl ?? 0;
          todayTradedPnl += pnl;
        }
      }
    }
  }

  // Win rate based on ORACLE-VERIFIED predictions only (wins + losses, excluding pending)
  const verified = wins + losses;
  const winRate = verified > 0 ? (wins / verified) * 100 : 0;
  const todayVerified = todayWins + todayLosses;
  const todayWinRate = todayVerified > 0 ? (todayWins / todayVerified) * 100 : 0;

  const tradedVerified = tradedWins + tradedLosses;
  const tradedWinRate = tradedVerified > 0 ? (tradedWins / tradedVerified) * 100 : 0;
  const todayTradedVerified = todayTradedWins + todayTradedLosses;
  const todayTradedWinRate = todayTradedVerified > 0 ? (todayTradedWins / todayTradedVerified) * 100 : 0;

  // Unredeemed tokens from queue (scoped by userId if provided)
  const unredeemed = getUnredeemedTokens(userId);
  const unredeemedCount = unredeemed.length;
  const unredeemedUsdc = unredeemed.reduce((sum, u) => sum + u.amount, 0);

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
    tradedWins,
    tradedLosses,
    tradedWinRate,
    tradedPnl,
    todayTradedWins,
    todayTradedLosses,
    todayTradedWinRate,
    todayTradedPnl,
    unredeemedCount,
    unredeemedUsdc,
  };
}
