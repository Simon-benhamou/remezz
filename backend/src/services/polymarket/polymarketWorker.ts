import type { PrismaClient } from '.prisma/client';
import { getBinanceWebSocket, getKlinesWithMeta } from '../binanceWebSocket.js';
import { createLogger } from '../../utils/logger.js';
import { computeFiveMinScore } from './fiveMinScorer.js';
import { buildSlug, fetchPolymarketOdds, fetchPolymarketResult, fetchConditionId } from './polymarketClient.js';
import {
  getChainlinkPrice,
  startChainlinkFeed,
  stopChainlinkFeed,
} from './chainlinkPriceFeed.js';
import { getLiveTradingConfig, placePolymarketBet, getPolymarketBalance, getPolymarketConfig, sellWinningTokens, redeemWinningTokens, getClobAskPrice, placeTakeProfitSell, checkOrderStatus, cancelClobOrder, placeGtcLimitBuy, MAX_CLOB_PRICE, getMaxPriceForScore, getActivePolymarketUserIds, getVirtualPolymarketUserIds, simulatePolymarketBet, ALL_POLYMARKET_SYMBOLS } from './polymarketTrader.js';
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

/** Map short symbol → Binance pair */
const BINANCE_SYMBOL = (s: string) => `${s}USDT`;

// ─── Pre-sell constants ──────────────────────────────────────────────────────
const PRE_SELL_START_MS = 3 * 60 * 1000;        // T+3:00 — start attempting sells (V5.124: was T+4:00)
const PRE_SELL_RETRY_MS = 10 * 1000;             // Retry every 10 seconds

// ─── Take-profit constants ──────────────────────────────────────────────────
const TP_MULTIPLIER = 2.0;                        // Sell at 2.0x the entry price
const TP_MAX_ENTRY_PRICE = 0.50;                  // TP on entries below 50c
const TP_CHECK_INTERVAL_MS = 5_000;                // Check TP order status every 5s

// ─── Per-symbol module state (Maps keyed by symbol short e.g. 'BTC') ────────

const windowBySymbol = new Map<string, WindowState | null>();
const decisionMadeBySymbol = new Map<string, boolean>();
const lastPreSellBySymbol = new Map<string, number>();
const lastTpCheckBySymbol = new Map<string, number>();
const resolutionDoneBySymbol = new Map<string, boolean>();
const autoSellsBySymbol = new Map<string, PendingAutoSell[]>();

// ─── Virtual bet tracking (CLOB-priced, no real order) ──────────────────────
interface VirtualBet {
  userId: string;
  symbol: string;
  tokenId: string;
  betAmount: number;
  clobAsk: number;
  direction: 'UP' | 'DOWN';
}
const virtualBetsBySymbol = new Map<string, VirtualBet[]>();

// ─── Virtual observation tracking (mirrors live observation, no real GTC) ────
interface VirtualObservation {
  symbol: string;
  tokenId: string;
  direction: 'UP' | 'DOWN';
  tierMax: number;
  initialAsk: number;
  bestAsk: number;
  startedAt: number;
  users: Array<{ userId: string; amount: number }>;
}
const virtualObservationBySymbol = new Map<string, VirtualObservation>();

const liveStateBySymbol = new Map<string, { window: WindowState | null; klines1m: Candle1m[] }>();

// ─── Observation mode state (V5.124: smart entry with GTC limit) ────────────
const OBSERVATION_MAX_OVERSHOOT = 0.10; // Enter observation if CLOB ask <= tierCap + 0.10
const OBSERVATION_TIMEOUT_MS = 120_000; // 2 min max observation
const OBSERVATION_REVERSAL_PCT = 0.85;  // Cancel if ask drops >15% from initial

interface ObservationOrder {
  userId: string;
  orderId: string;
  tokenId: string;
  sym: string;
  limitPrice: number;
  amount: number;
  direction: 'UP' | 'DOWN';
  initialAsk: number;
  bestAsk: number;
  startedAt: number;
}
const observationOrderBySymbol = new Map<string, ObservationOrder>();

// ─── Global state (not per-symbol) ──────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

// Per-user active bets: keyed by `${userId}:${symbol}` → windowStart
const activeLiveBetByUser = new Map<string, number | null>();

// ─── Pre-sell tracking ──────────────────────────────────────────────────────
interface PendingAutoSell {
  userId: string;
  symbol: string;
  tokenId: string;
  betAmount: number;
  executionPrice: number;
  direction: 'UP' | 'DOWN';
  sold: boolean;
  tpOrderId: string | null;
  tpTargetPrice: number | null;
}

// ─── Unredeemed token queue (post-resolution) ───────────────────────────────
interface UnredeemedToken {
  userId: string;
  symbol: string;
  windowStart: number;
  slug: string;
  tokenId: string;
  betAmount: number;
  executionPrice: number;
  direction: 'UP' | 'DOWN';
  addedAt: number;
  attempts: number;
  lastAttemptAt: number;
  giveUpAt: number;
}
let unredeemedTokens: UnredeemedToken[] = [];

// ─── Polymarket resolution verification ───────────────────────────────────────

interface PendingVerification {
  userId: string | null;
  symbol: string;
  windowStart: number;
  slug: string;
  predictionDirection: 'UP' | 'DOWN' | null;
  entryOdds: number | null;
  executionPrice: number | null;
  betAmount: number | null;
  tokenId: string | null;
  verifyAfterMs: number;
  giveUpAfterMs: number;
  isVirtual?: boolean;
}

const pendingVerifications: PendingVerification[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWindowBoundaries(nowMs: number): { start: number; end: number } {
  const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const end = start + WINDOW_MS;
  return { start, end };
}

function getKlines1m(binanceSymbol: string): Candle1m[] {
  const raw = getKlinesWithMeta(binanceSymbol, '1m');
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
 * Get price from Chainlink (Polymarket's source), falling back to Binance WS.
 */
function getPrice(symbol: string, klines: Candle1m[]): number {
  const chainlink = getChainlinkPrice(symbol);
  if (chainlink) return chainlink.price;

  // Fallback: use latest Binance 1m candle close
  if (klines.length > 0) return klines[klines.length - 1].close;

  return 0;
}

function activeBetKey(userId: string, symbol: string): string {
  return `${userId}:${symbol}`;
}

function getAutoSells(symbol: string): PendingAutoSell[] {
  let arr = autoSellsBySymbol.get(symbol);
  if (!arr) {
    arr = [];
    autoSellsBySymbol.set(symbol, arr);
  }
  return arr;
}

function getVirtualBets(symbol: string): VirtualBet[] {
  let arr = virtualBetsBySymbol.get(symbol);
  if (!arr) {
    arr = [];
    virtualBetsBySymbol.set(symbol, arr);
  }
  return arr;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

async function resolveWindow(w: WindowState, prisma: PrismaClient): Promise<void> {
  const sym = w.symbol;
  const endPrice = w.currentPrice;
  const preliminaryResult: 'UP' | 'DOWN' = endPrice >= w.startPrice ? 'UP' : 'DOWN';

  // Release per-user active-bet guards for this window
  for (const [key, ws] of activeLiveBetByUser) {
    if (key.endsWith(`:${sym}`) && ws === w.windowStart) activeLiveBetByUser.delete(key);
  }

  const skipped = w.status === 'skipped';
  const slug = buildSlug(sym, w.windowStart);

  const autoSells = getAutoSells(sym);

  // ── Shared prediction row (userId=null) — virtual signal/result ───────
  try {
    await prisma.polymarketPrediction.create({
      data: {
        userId: null,
        symbol: sym,
        windowStart: new Date(w.windowStart),
        windowEnd: new Date(w.windowEnd),
        startPrice: w.startPrice,
        endPrice,
        prediction: w.prediction?.direction ?? null,
        confidence: w.prediction?.confidence ?? null,
        actualResult: preliminaryResult,
        entryOdds: w.entryOdds,
        executionPrice: null,
        tokenId: null,
        betAmount: w.betAmount,
        simulatedPnl: null,
        scoreBreakdown: w.prediction?.score
          ? JSON.parse(JSON.stringify(w.prediction.score))
          : undefined,
        isCorrect: null,
        skipped,
        polymarketSlug: w.prediction ? slug : null,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`DB persist error (shared row, ${sym}): ${msg}`);
  }

  // ── Per-user live trade rows ──────────────────────────────────────────
  const seenUsers = new Set<string>();
  for (const sell of autoSells) {
    if (seenUsers.has(sell.userId)) continue;
    seenUsers.add(sell.userId);

    try {
      await prisma.polymarketPrediction.create({
        data: {
          userId: sell.userId,
          symbol: sym,
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
      log.error(`DB persist error (user ${sell.userId.slice(0, 8)}, ${sym}): ${msg}`);
    }
  }

  // ── Per-user virtual bet rows (CLOB-priced, no real order) ──────────
  const virtualBets = getVirtualBets(sym);
  const seenVirtualUsers = new Set<string>();
  for (const vb of virtualBets) {
    if (seenVirtualUsers.has(vb.userId)) continue;
    seenVirtualUsers.add(vb.userId);

    try {
      await prisma.polymarketPrediction.create({
        data: {
          userId: vb.userId,
          symbol: sym,
          windowStart: new Date(w.windowStart),
          windowEnd: new Date(w.windowEnd),
          startPrice: w.startPrice,
          endPrice,
          prediction: w.prediction?.direction ?? null,
          confidence: w.prediction?.confidence ?? null,
          actualResult: preliminaryResult,
          entryOdds: w.entryOdds,
          executionPrice: vb.clobAsk,  // CLOB price, not Gamma
          tokenId: vb.tokenId,
          betAmount: vb.betAmount,
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
      log.error(`DB persist error (virtual ${vb.userId.slice(0, 8)}, ${sym}): ${msg}`);
    }
  }

  const hasPrediction = w.prediction && w.entryOdds !== null;
  const preliminaryMatch = hasPrediction ? w.prediction!.direction === preliminaryResult : null;
  const correctStr = preliminaryMatch !== null ? (preliminaryMatch ? 'WIN?' : 'LOSS?') : 'SKIP';
  log.info(
    `[${sym}] Resolved (PRELIMINARY): actual=${preliminaryResult} | ${correctStr} | ${w.startPrice.toFixed(2)} → ${endPrice.toFixed(2)}`,
  );

  // Schedule Polymarket oracle verification
  if (!skipped) {
    pendingVerifications.push({
      userId: null,
      symbol: sym,
      windowStart: w.windowStart,
      slug,
      predictionDirection: w.prediction?.direction ?? null,
      entryOdds: w.entryOdds,
      executionPrice: null,
      betAmount: w.betAmount,
      tokenId: null,
      verifyAfterMs: Date.now() + 3 * 60 * 1000,
      giveUpAfterMs: Date.now() + 60 * 60 * 1000,
    });

    const verifiedUsers = new Set<string>();
    for (const sell of autoSells) {
      if (verifiedUsers.has(sell.userId)) continue;
      verifiedUsers.add(sell.userId);
      pendingVerifications.push({
        userId: sell.userId,
        symbol: sym,
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

    // Schedule verification for virtual bets
    for (const vb of virtualBets) {
      if (seenVirtualUsers.has(vb.userId) && verifiedUsers.has(vb.userId)) continue;
      pendingVerifications.push({
        userId: vb.userId,
        symbol: sym,
        windowStart: w.windowStart,
        slug,
        predictionDirection: w.prediction?.direction ?? null,
        entryOdds: w.entryOdds,
        executionPrice: vb.clobAsk,
        betAmount: vb.betAmount,
        tokenId: vb.tokenId,
        verifyAfterMs: Date.now() + 3 * 60 * 1000,
        giveUpAfterMs: Date.now() + 60 * 60 * 1000,
        isVirtual: true,
      });
    }
  }
}

// ─── Polymarket oracle verification ─────────────────────────────────────────

async function verifyPendingResolutions(prisma: PrismaClient): Promise<void> {
  const now = Date.now();
  const toRemove: number[] = [];

  for (let i = 0; i < pendingVerifications.length; i++) {
    const v = pendingVerifications[i];

    if (now < v.verifyAfterMs) continue;

    if (now > v.giveUpAfterMs) {
      log.warn(`Polymarket verification timed out for ${v.slug} — keeping preliminary result`);
      toRemove.push(i);
      continue;
    }

    try {
      const oracleResult = await fetchPolymarketResult(v.slug);
      if (oracleResult === null) continue;

      const isCorrect = v.predictionDirection ? v.predictionDirection === oracleResult : null;
      const amt = v.betAmount ?? 5;
      const price = v.executionPrice ?? v.entryOdds;
      const simulatedPnl =
        isCorrect !== null && price !== null
          ? isCorrect ? amt * (1 - price) / price : -amt
          : null;

      const userLabel = v.userId ? `[${v.userId.slice(0, 8)}]` : '[shared]';

      // ── Virtual bets: update DB with PnL, skip auto-sell/redeem ────
      if (v.isVirtual) {
        if (!v.userId) { toRemove.push(i); continue; }

        const dbWhere = { windowStart: new Date(v.windowStart), symbol: v.symbol, userId: v.userId };

        await prisma.polymarketPrediction.updateMany({
          where: dbWhere,
          data: { actualResult: oracleResult, isCorrect, simulatedPnl, realPnl: simulatedPnl },
        });

        const resultStr = isCorrect === true ? 'WIN' : isCorrect === false ? 'LOSS' : '?';
        log.info(`Oracle VIRTUAL ${userLabel}: ${v.slug} → ${oracleResult} | ${resultStr} | PnL $${simulatedPnl?.toFixed(2)} (CLOB=${v.executionPrice?.toFixed(3)})`);

        toRemove.push(i);
        continue;
      }

      // ── Update DB with authoritative oracle result ────────────────
      const dbWhere = v.userId
        ? { windowStart: new Date(v.windowStart), symbol: v.symbol, userId: v.userId }
        : { windowStart: new Date(v.windowStart), symbol: v.symbol, userId: { equals: null } };

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
              log.warn(`CTF redeem failed ${userLabel} for ${v.slug}: ${redeemResult.error} — queuing for retry`);
              queueUnredeemed(v);
            }
          } else {
            log.warn(`No conditionId ${userLabel} for ${v.slug} — queuing for retry`);
            queueUnredeemed(v);
          }
        } else {
          queueUnredeemed(v);
          log.info(`UNREDEEMED ${userLabel}: queued ${v.slug} for retry (CLOB sell failed: ${sellResult.error})`);
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

  for (let i = toRemove.length - 1; i >= 0; i--) {
    pendingVerifications.splice(toRemove[i], 1);
  }
}

function queueUnredeemed(v: PendingVerification): void {
  if (!v.userId || !v.tokenId || !v.betAmount || !v.executionPrice) return;
  const alreadyQueued = unredeemedTokens.some((u) => u.windowStart === v.windowStart && u.tokenId === v.tokenId && u.userId === v.userId);
  if (!alreadyQueued) {
    unredeemedTokens.push({
      userId: v.userId,
      symbol: v.symbol,
      windowStart: v.windowStart, slug: v.slug, tokenId: v.tokenId,
      betAmount: v.betAmount, executionPrice: v.executionPrice,
      direction: v.predictionDirection ?? 'UP',
      addedAt: Date.now(), attempts: 0, lastAttemptAt: 0,
      giveUpAt: Date.now() + 30 * 60 * 1000,
    });
  }
}

// ─── Unredeemed token retry ──────────────────────────────────────────────────

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

    const age = now - u.addedAt;
    const retryInterval = age < 10 * 60 * 1000 ? 30_000 : 2 * 60 * 1000;
    if (now - u.lastAttemptAt < retryInterval) continue;

    u.lastAttemptAt = now;
    u.attempts++;

    const uLabel = `[${u.userId.slice(0, 8)}]`;
    try {
      const sellResult = await sellWinningTokens(prisma, u.userId, u.tokenId, u.betAmount, u.executionPrice, 0.50);
      if (sellResult.success) {
        log.info(`UNREDEEMED SOLD ${uLabel}: ${u.slug} — $${sellResult.usdcReceived?.toFixed(2)} USDC @ ${sellResult.sellPrice?.toFixed(3)} (attempt ${u.attempts})`);
        const realPnl = (sellResult.usdcReceived ?? 0) - u.betAmount;
        const dbWhere = { windowStart: new Date(u.windowStart), symbol: u.symbol, userId: u.userId };
        await prisma.polymarketPrediction.updateMany({
          where: dbWhere,
          data: {
            usdcReceived: sellResult.usdcReceived,
            sellPrice: sellResult.sellPrice,
            soldAt: new Date(),
            realPnl,
          },
        }).catch(() => {});
        toRemove.push(i);
      } else {
        log.info(`UNREDEEMED ${uLabel}: CLOB sell failed for ${u.slug} (${sellResult.error}), trying CTF redeem...`);
        const conditionId = await fetchConditionId(u.slug);
        if (conditionId) {
          const redeemResult = await redeemWinningTokens(prisma, u.userId, conditionId, u.betAmount, u.executionPrice);
          if (redeemResult.success) {
            log.info(`UNREDEEMED REDEEMED ${uLabel}: ${u.slug} — ~$${redeemResult.usdcReceived?.toFixed(2)} USDC via CTF`);
            const realPnl = (redeemResult.usdcReceived ?? 0) - u.betAmount;
            const dbWhere = { windowStart: new Date(u.windowStart), symbol: u.symbol, userId: u.userId };
            await prisma.polymarketPrediction.updateMany({
              where: dbWhere,
              data: {
                usdcReceived: redeemResult.usdcReceived,
                sellPrice: 1.0,
                soldAt: new Date(),
                realPnl,
              },
            }).catch(() => {});
            toRemove.push(i);
          } else {
            log.warn(`CTF redeem failed ${uLabel} for ${u.slug}: ${redeemResult.error} — claim manually on Polymarket`);
            toRemove.push(i);
          }
        } else {
          log.warn(`No conditionId found ${uLabel} for ${u.slug} — claim manually on Polymarket`);
          toRemove.push(i);
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
  if (tickInProgress) return;
  tickInProgress = true;

  try {
  const ws = getBinanceWebSocket();
  const nowMs = Date.now();
  const { start, end } = getWindowBoundaries(nowMs);
  const elapsed = nowMs - start;

  // ── 1. Subscribe all symbols klines (idempotent, prevents TTL pruning) ──
  for (const sym of ALL_POLYMARKET_SYMBOLS) {
    ws.subscribeToKline(BINANCE_SYMBOL(sym), '1m');
  }

  // ── 2. Global: verify pending resolutions + process unredeemed ──────────
  if (pendingVerifications.length > 0) {
    await verifyPendingResolutions(prisma);
  }
  if (unredeemedTokens.length > 0) {
    await processUnredeemedTokens(prisma);
  }

  // ── 3. Per-symbol window management ─────────────────────────────────────
  interface ReadyForDecision { sym: string; klines: Candle1m[]; startPrice: number }
  const readyForDecision: ReadyForDecision[] = [];

  for (const sym of ALL_POLYMARKET_SYMBOLS) {
    const binSym = BINANCE_SYMBOL(sym);
    const klines = getKlines1m(binSym);
    const currentWindow = windowBySymbol.get(sym) ?? null;
    const autoSells = getAutoSells(sym);

    // ── New window detection ─────────────────────────────────────────
    if (!currentWindow || currentWindow.windowStart !== start) {
      // Resolve previous window
      if (currentWindow && !resolutionDoneBySymbol.get(sym)) {
        try {
          await resolveWindow({ ...currentWindow } as WindowState, prisma);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[${sym}] resolveWindow error: ${msg}`);
        }
      }

      // Cancel outstanding TP orders
      for (const s of autoSells) {
        if (s.tpOrderId && !s.sold) {
          await cancelClobOrder(prisma, s.userId, s.tpOrderId).catch(() => {});
          s.tpOrderId = null;
        }
      }

      // V5.124: Final sell attempt at aggressive minBid before giving up
      const finalUnsold = autoSells.filter((s) => !s.sold);
      for (const s of finalUnsold) {
        try {
          const sellResult = await sellWinningTokens(prisma, s.userId, s.tokenId, s.betAmount, s.executionPrice, 0.70);
          if (sellResult.success) {
            s.sold = true;
            log.info(`[${sym}] FINAL SELL OK [${s.userId.slice(0, 8)}]: ${s.direction} — $${sellResult.usdcReceived?.toFixed(2)} USDC @ ${sellResult.sellPrice?.toFixed(3)}`);
            if (currentWindow) {
              const realPnl = (sellResult.usdcReceived ?? 0) - s.betAmount;
              await prisma.polymarketPrediction.updateMany({
                where: { windowStart: new Date(currentWindow.windowStart), symbol: sym, userId: s.userId },
                data: { usdcReceived: sellResult.usdcReceived, sellPrice: sellResult.sellPrice, soldAt: new Date(), realPnl },
              }).catch(() => {});
            }
          }
        } catch (_) { /* ignore — will be queued as unredeemed */ }
      }

      // Move unsold tokens to unredeemed queue
      if (currentWindow) {
        const unsold = autoSells.filter((s) => !s.sold);
        const slug = buildSlug(sym, currentWindow.windowStart);
        for (const s of unsold) {
          if (s.executionPrice > 0) {
            unredeemedTokens.push({
              userId: s.userId,
              symbol: sym,
              windowStart: currentWindow.windowStart,
              slug,
              tokenId: s.tokenId,
              betAmount: s.betAmount,
              executionPrice: s.executionPrice,
              direction: s.direction,
              addedAt: Date.now(),
              attempts: 0,
              lastAttemptAt: 0,
              giveUpAt: Date.now() + 30 * 60 * 1000,
            });
            log.info(`UNREDEEMED [${s.userId.slice(0, 8)}]: queued ${s.direction} ${sym} from ${slug} for retry`);
          }
        }
      }

      // Cancel any pending observation GTC order
      const pendingObs = observationOrderBySymbol.get(sym);
      if (pendingObs) {
        await cancelClobOrder(prisma, pendingObs.userId, pendingObs.orderId).catch(() => {});
        observationOrderBySymbol.delete(sym);
      }
      virtualObservationBySymbol.delete(sym);

      // Reset per-symbol flags
      decisionMadeBySymbol.set(sym, false);
      lastPreSellBySymbol.set(sym, 0);
      lastTpCheckBySymbol.set(sym, 0);
      resolutionDoneBySymbol.set(sym, false);
      autoSellsBySymbol.set(sym, []);
      virtualBetsBySymbol.set(sym, []);

      const startPrice = getPrice(sym, klines);
      if (startPrice === 0) {
        windowBySymbol.set(sym, null);
        continue;
      }

      const newWindow: WindowState = {
        symbol: sym,
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
      windowBySymbol.set(sym, newWindow);

      const source = getChainlinkPrice(sym) ? 'chainlink' : 'binance-fallback';
      log.info(
        `[${sym}] New window ${new Date(start).toISOString()} → ${new Date(end).toISOString()} | startPrice=${startPrice.toFixed(2)} (${source})`,
      );
    }

    const w = windowBySymbol.get(sym);
    if (!w) continue;

    // Update current price + elapsed
    w.currentPrice = getPrice(sym, klines);
    w.elapsed = elapsed;

    // Collect symbols ready for decision at T+1min
    if (elapsed >= DECISION_OFFSET_MS && !decisionMadeBySymbol.get(sym)) {
      decisionMadeBySymbol.set(sym, true);

      readyForDecision.push({ sym, klines, startPrice: w.startPrice });
    }
  }

  // ── 4. PARALLEL scoring + odds for ready symbols ───────────────────────
  if (readyForDecision.length > 0) {
    const scoringResults = await Promise.all(readyForDecision.map(async ({ sym, klines, startPrice }) => {
      const windowCandles = klines.filter((k) => k.isFinal && k.timestamp >= start);
      const preWindowCandles = klines
        .filter((k) => k.isFinal && k.timestamp < start)
        .slice(-20);

      const result = computeFiveMinScore(windowCandles, preWindowCandles, startPrice);
      if (!result) return { sym, result: null, odds: null, slug: '' };

      const slug = buildSlug(sym, start);
      const odds = await fetchPolymarketOdds(slug);
      return { sym, result, odds, slug };
    }));

    // ── 5. SERIAL betting (shared wallet) — sorted by confidence DESC ──
    const scored = scoringResults.filter((r) => r.result !== null);

    // ── Consensus filter: only trade if 3+ symbols predict the same direction ──
    const upCount = scored.filter(r => r.result!.direction === 'UP').length;
    const downCount = scored.filter(r => r.result!.direction === 'DOWN').length;
    const consensusDir: 'UP' | 'DOWN' = upCount >= downCount ? 'UP' : 'DOWN';
    const consensusCount = Math.max(upCount, downCount);

    let tradeable: typeof scored;
    if (consensusCount >= 3) {
      tradeable = scored
        .filter(r => r.result!.direction === consensusDir)
        .sort((a, b) => (b.result?.confidence ?? 0) - (a.result?.confidence ?? 0));

      const rejected = scored.filter(r => r.result!.direction !== consensusDir);
      for (const { sym } of rejected) {
        const w = windowBySymbol.get(sym);
        if (w) w.status = 'skipped';
        log.info(`[${sym}] Skipped — against consensus (${consensusDir} ${consensusCount}/${scored.length})`);
      }
      log.info(`Consensus: ${consensusDir} ${consensusCount}/${scored.length} — trading ${tradeable.length} symbols`);
    } else {
      tradeable = [];
      for (const { sym } of scored) {
        const w = windowBySymbol.get(sym);
        if (w) w.status = 'skipped';
        log.info(`[${sym}] Skipped — no consensus (UP=${upCount}, DOWN=${downCount}, need 3+)`);
      }
      if (scored.length > 0) {
        log.info(`No consensus: UP=${upCount}, DOWN=${downCount} — skipping all`);
      }
    }

    for (const { sym, result, odds, slug } of tradeable) {
      if (!result || !odds) continue;

      const w = windowBySymbol.get(sym);
      if (!w) continue;

      const entryOdds = result.direction === 'UP' ? odds.upPrice : odds.downPrice;
      const tokenId = result.direction === 'UP' ? odds.upTokenId : odds.downTokenId;

      w.prediction = result;
      w.entryOdds = entryOdds;
      w.tokenId = tokenId;
      w.status = 'predicted';
      w.betAmount = 5;

      log.info(
        `[${sym}] Prediction: ${result.direction} (score=${result.score.total}, conf=${result.confidence}) | odds=${entryOdds.toFixed(3)} | slug=${slug}`,
      );

      // Per-user live trading
      const activeUsers = await getActivePolymarketUserIds(prisma);
      let anyUserFilled = false;

      for (const userId of activeUsers) {
        const uLabel = `[${userId.slice(0, 8)}]`;

        // Check if this user has this symbol enabled
        const pmConfig = await getPolymarketConfig(prisma, userId);
        if (!pmConfig.symbols.includes(sym)) continue;

        const liveConfig = await getLiveTradingConfig(prisma, userId);
        if (!liveConfig || !tokenId) continue;

        const betKey = activeBetKey(userId, sym);
        const userActiveBet = activeLiveBetByUser.get(betKey) ?? null;
        if (userActiveBet !== null && userActiveBet !== start) {
          log.warn(`LIVE MODE ${uLabel} [${sym}]: skipping bet — previous window still active`);
          continue;
        }

        activeLiveBetByUser.set(betKey, start);

        const { balance } = await getPolymarketBalance(prisma, userId);
        if (balance < liveConfig.amount) {
          log.warn(`LIVE MODE ${uLabel} [${sym}]: insufficient balance $${balance.toFixed(2)} < $${liveConfig.amount} — skipping`);
          activeLiveBetByUser.delete(betKey);
          continue;
        }

        const score = result.confidence;
        const tierMax = getMaxPriceForScore(score);

        const betResult = await placePolymarketBet(
          prisma, userId, result.direction, tokenId, liveConfig.amount, entryOdds, false, score,
        );

        if (betResult.success) {
          log.info(`LIVE BET OK ${uLabel} [${sym}]: orderId=${betResult.orderId} @ CLOB ${betResult.executionPrice?.toFixed(3)} (score=${score}, cap=${tierMax})`);
          anyUserFilled = true;
          if (betResult.executionPrice) {
            w.executionPrice = betResult.executionPrice;
            w.betAmount = liveConfig.amount;

            const sell: PendingAutoSell = {
              userId,
              symbol: sym,
              tokenId,
              betAmount: liveConfig.amount,
              executionPrice: betResult.executionPrice,
              direction: result.direction,
              sold: false,
              tpOrderId: null,
              tpTargetPrice: null,
            };
            getAutoSells(sym).push(sell);

            if (betResult.executionPrice < TP_MAX_ENTRY_PRICE) {
              const tpPrice = Math.min(betResult.executionPrice * TP_MULTIPLIER, 0.95);
              const tpResult = await placeTakeProfitSell(prisma, userId, tokenId, liveConfig.amount, betResult.executionPrice, tpPrice);
              if (tpResult.success && tpResult.orderId) {
                sell.tpOrderId = tpResult.orderId;
                sell.tpTargetPrice = tpPrice;
                log.info(`TP ORDER ${uLabel} [${sym}]: sell @ ${(tpPrice * 100).toFixed(0)}c (entry ${(betResult.executionPrice * 100).toFixed(0)}c, ${TP_MULTIPLIER}x)`);
              }
            }
          }
        } else if (betResult.error?.startsWith('EV too low')) {
          // V5.124: Observation mode — place GTC limit at cap and wait for dip
          const clobAsk = await getClobAskPrice(prisma, userId, tokenId);
          if (clobAsk && clobAsk <= tierMax + OBSERVATION_MAX_OVERSHOOT && !observationOrderBySymbol.has(sym)) {
            const gtcResult = await placeGtcLimitBuy(prisma, userId, tokenId, liveConfig.amount, tierMax);
            if (gtcResult.success && gtcResult.orderId) {
              observationOrderBySymbol.set(sym, {
                userId, orderId: gtcResult.orderId, tokenId, sym,
                limitPrice: tierMax, amount: liveConfig.amount, direction: result.direction,
                initialAsk: clobAsk, bestAsk: clobAsk, startedAt: Date.now(),
              });
              w.observationStatus = 'observing';
              w.observationInitialAsk = clobAsk;
              w.observationBestAsk = clobAsk;
              log.info(`[${sym}] OBSERVATION ${uLabel}: GTC limit BUY @ ${tierMax.toFixed(3)} (ask=${clobAsk.toFixed(3)}, cap+${OBSERVATION_MAX_OVERSHOOT}) — waiting for dip`);
            } else {
              log.info(`CLOB above cap ${uLabel} [${sym}] ${tierMax.toFixed(2)} (score=${score}) — GTC failed: ${gtcResult.error}`);
              activeLiveBetByUser.delete(betKey);
            }
          } else {
            const reason = !clobAsk ? 'no CLOB price' : clobAsk > tierMax + OBSERVATION_MAX_OVERSHOOT ? `too far (${clobAsk.toFixed(3)} > ${(tierMax + OBSERVATION_MAX_OVERSHOOT).toFixed(2)})` : 'already observing';
            log.info(`CLOB above cap ${uLabel} [${sym}] ${tierMax.toFixed(2)} (score=${score}) — ${reason}`);
            activeLiveBetByUser.delete(betKey);
          }
        } else {
          log.error(`LIVE BET FAILED ${uLabel} [${sym}]: ${betResult.error}`);
          activeLiveBetByUser.delete(betKey);
        }
      }

      w.observationStatus = anyUserFilled ? 'filled' : (activeUsers.length > 0 ? 'skipped_ev' : 'idle');

      // ── Virtual user simulation (CLOB price, no order) ──────────────
      if (tokenId) {
      const virtualUsers = await getVirtualPolymarketUserIds(prisma);
      for (const userId of virtualUsers) {
        const uLabel = `[${userId.slice(0, 8)}]`;
        const pmConfig = await getPolymarketConfig(prisma, userId);
        if (!pmConfig.symbols.includes(sym)) continue;

        const score = result.confidence;
        const tierMax = getMaxPriceForScore(score);

        const simResult = await simulatePolymarketBet(
          prisma, userId, result.direction, tokenId, pmConfig.amount, entryOdds, score,
        );

        if (simResult.success && simResult.clobAsk) {
          getVirtualBets(sym).push({
            userId, symbol: sym, tokenId,
            betAmount: pmConfig.amount, clobAsk: simResult.clobAsk, direction: result.direction,
          });
          log.info(`VIRTUAL BET OK ${uLabel} [${sym}]: simulated @ CLOB ${simResult.clobAsk.toFixed(3)} (score=${score}, cap=${tierMax.toFixed(2)})`);
        } else if (simResult.error?.startsWith('EV too low') && simResult.clobAsk) {
          // Observation mode: CLOB ask above cap but maybe within reach — track and wait for dip
          if (simResult.clobAsk <= tierMax + OBSERVATION_MAX_OVERSHOOT && !virtualObservationBySymbol.has(sym)) {
            virtualObservationBySymbol.set(sym, {
              symbol: sym, tokenId, direction: result.direction,
              tierMax, initialAsk: simResult.clobAsk, bestAsk: simResult.clobAsk,
              startedAt: Date.now(),
              users: [{ userId, amount: pmConfig.amount }],
            });
            log.info(`[${sym}] VIRTUAL OBSERVATION ${uLabel}: waiting for dip to ${tierMax.toFixed(3)} (ask=${simResult.clobAsk.toFixed(3)}, cap+${OBSERVATION_MAX_OVERSHOOT})`);
          } else if (virtualObservationBySymbol.has(sym)) {
            // Already observing — add this user to the existing observation
            virtualObservationBySymbol.get(sym)!.users.push({ userId, amount: pmConfig.amount });
            log.info(`[${sym}] VIRTUAL OBSERVATION ${uLabel}: joined existing observation`);
          } else {
            log.info(`VIRTUAL SKIP ${uLabel} [${sym}]: ${simResult.error} (too far for observation)`);
          }
        } else {
          log.info(`VIRTUAL SKIP ${uLabel} [${sym}]: ${simResult.error}`);
        }
      }
      }
    }

    // Mark symbols that scored below threshold
    for (const { sym, result } of scoringResults) {
      if (result === null) {
        const w = windowBySymbol.get(sym);
        if (w) {
          w.status = 'skipped';
          log.info(`[${sym}] Window skipped (score < 40)`);
        }
      }
    }
  }

  // ── 6. Per-symbol: observation, pre-sell, TP check ─────────────────────
  for (const sym of ALL_POLYMARKET_SYMBOLS) {
    const w = windowBySymbol.get(sym);
    if (!w) continue;
    const autoSells = getAutoSells(sym);
    const binSym = BINANCE_SYMBOL(sym);
    const klines = getKlines1m(binSym);

    // ── Observation mode: poll GTC limit buy (V5.124) ──────────────────
    const obs = observationOrderBySymbol.get(sym);
    if (obs) {
      const obsElapsed = Date.now() - obs.startedAt;

      // Deadline: 2 minutes max observation
      if (obsElapsed > OBSERVATION_TIMEOUT_MS) {
        await cancelClobOrder(prisma, obs.userId, obs.orderId).catch(() => {});
        observationOrderBySymbol.delete(sym);
        activeLiveBetByUser.delete(activeBetKey(obs.userId, sym));
        log.info(`[${sym}] Observation timeout — cancelled GTC after ${(obsElapsed / 1000).toFixed(0)}s`);
      } else {
        // Check fill status
        const status = await checkOrderStatus(prisma, obs.userId, obs.orderId);
        if (status === 'MATCHED' || status === 'FILLED') {
          // Filled! Record execution
          if (w) {
            w.executionPrice = obs.limitPrice;
            w.observationStatus = 'filled';
            w.observationTrigger = 'dip';
            w.betAmount = obs.amount;
          }
          getAutoSells(sym).push({
            userId: obs.userId,
            symbol: sym,
            tokenId: obs.tokenId,
            betAmount: obs.amount,
            executionPrice: obs.limitPrice,
            direction: obs.direction,
            sold: false,
            tpOrderId: null,
            tpTargetPrice: null,
          });
          observationOrderBySymbol.delete(sym);
          log.info(`[${sym}] GTC FILLED [${obs.userId.slice(0, 8)}] @ ${obs.limitPrice.toFixed(3)} after ${(obsElapsed / 1000).toFixed(0)}s (initial=${obs.initialAsk.toFixed(3)}, best=${obs.bestAsk.toFixed(3)})`);
        } else if (status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED') {
          observationOrderBySymbol.delete(sym);
          activeLiveBetByUser.delete(activeBetKey(obs.userId, sym));
          log.info(`[${sym}] Observation GTC ${status} by exchange`);
        } else {
          // Still open — check reversal
          const currentAsk = await getClobAskPrice(prisma, obs.userId, obs.tokenId);
          if (currentAsk && currentAsk < obs.initialAsk * OBSERVATION_REVERSAL_PCT) {
            await cancelClobOrder(prisma, obs.userId, obs.orderId).catch(() => {});
            observationOrderBySymbol.delete(sym);
            activeLiveBetByUser.delete(activeBetKey(obs.userId, sym));
            log.info(`[${sym}] Reversal detected — ask dropped ${obs.initialAsk.toFixed(3)} → ${currentAsk.toFixed(3)} (>${((1 - OBSERVATION_REVERSAL_PCT) * 100).toFixed(0)}%) — cancelled GTC`);
          } else if (currentAsk) {
            obs.bestAsk = Math.min(obs.bestAsk, currentAsk);
            if (w) w.observationBestAsk = obs.bestAsk;
          }
        }
      }
    }

    // ── Virtual observation: poll CLOB for dip (mirrors live observation) ──
    const vObs = virtualObservationBySymbol.get(sym);
    if (vObs) {
      const vObsElapsed = Date.now() - vObs.startedAt;

      if (vObsElapsed > OBSERVATION_TIMEOUT_MS) {
        virtualObservationBySymbol.delete(sym);
        log.info(`[${sym}] Virtual observation timeout after ${(vObsElapsed / 1000).toFixed(0)}s`);
      } else {
        // Need any virtual user's credentials to fetch CLOB price
        const probeUserId = vObs.users[0]?.userId;
        const currentAsk = probeUserId ? await getClobAskPrice(prisma, probeUserId, vObs.tokenId) : null;

        if (currentAsk && currentAsk <= vObs.tierMax) {
          // Dip! Record virtual fill for all tracked users
          for (const u of vObs.users) {
            getVirtualBets(sym).push({
              userId: u.userId, symbol: sym, tokenId: vObs.tokenId,
              betAmount: u.amount, clobAsk: vObs.tierMax, direction: vObs.direction,
            });
            log.info(`[${sym}] VIRTUAL OBSERVATION FILLED [${u.userId.slice(0, 8)}] @ ${vObs.tierMax.toFixed(3)} after ${(vObsElapsed / 1000).toFixed(0)}s (initial=${vObs.initialAsk.toFixed(3)}, best=${vObs.bestAsk.toFixed(3)})`);
          }
          virtualObservationBySymbol.delete(sym);
        } else if (currentAsk && currentAsk < vObs.initialAsk * OBSERVATION_REVERSAL_PCT) {
          virtualObservationBySymbol.delete(sym);
          log.info(`[${sym}] Virtual observation reversal — ask dropped ${vObs.initialAsk.toFixed(3)} → ${currentAsk.toFixed(3)} — cancelled`);
        } else if (currentAsk) {
          vObs.bestAsk = Math.min(vObs.bestAsk, currentAsk);
        }
      }
    }

    // ── Take-profit monitoring ──────────────────────────────────────────
    if (autoSells.length > 0) {
      const hasTpOrders = autoSells.some((s) => s.tpOrderId && !s.sold);
      const now = Date.now();

      if (hasTpOrders) {
        if (elapsed >= PRE_SELL_START_MS) {
          for (const sell of autoSells) {
            if (sell.tpOrderId && !sell.sold) {
              await cancelClobOrder(prisma, sell.userId, sell.tpOrderId).catch(() => {});
              log.info(`[${sym}] TP ORDER cancelled at T+4:00 [${sell.userId.slice(0, 8)}]: ${sell.direction} (switching to pre-sell)`);
              sell.tpOrderId = null;
            }
          }
        } else if (now - (lastTpCheckBySymbol.get(sym) ?? 0) >= TP_CHECK_INTERVAL_MS) {
          lastTpCheckBySymbol.set(sym, now);

          for (const sell of autoSells) {
            if (!sell.tpOrderId || sell.sold) continue;

            const status = await checkOrderStatus(prisma, sell.userId, sell.tpOrderId);
            if (status === 'MATCHED' || status === 'FILLED') {
              sell.sold = true;
              const tokenAmount = sell.betAmount / sell.executionPrice;
              const usdcReceived = tokenAmount * (sell.tpTargetPrice ?? sell.executionPrice);
              const realPnl = usdcReceived - sell.betAmount;

              log.info(
                `[${sym}] TP FILLED [${sell.userId.slice(0, 8)}]: ${sell.direction} — ` +
                `$${usdcReceived.toFixed(2)} USDC @ ${((sell.tpTargetPrice ?? 0) * 100).toFixed(0)}c (entry ${(sell.executionPrice * 100).toFixed(0)}c, profit +$${realPnl.toFixed(2)})`,
              );

              await prisma.polymarketPrediction.updateMany({
                where: { windowStart: new Date(w.windowStart), symbol: sym, userId: sell.userId },
                data: { usdcReceived, sellPrice: sell.tpTargetPrice, soldAt: new Date(), realPnl },
              }).catch(() => {});

              sell.tpOrderId = null;
            } else if (status === 'CANCELED' || status === 'CANCELLED' || status === 'EXPIRED') {
              log.warn(`[${sym}] TP ORDER ${status} [${sell.userId.slice(0, 8)}]: ${sell.direction}`);
              sell.tpOrderId = null;
            }
          }
        }
      }
    }

    // ── Aggressive pre-sell: T+3:00 → T+4:55 (V5.124: was T+4:00, lower minBid) ──
    if (elapsed >= PRE_SELL_START_MS && autoSells.length > 0) {
      const unsold = autoSells.filter((s) => !s.sold);
      const now = Date.now();

      if (unsold.length > 0 && now - (lastPreSellBySymbol.get(sym) ?? 0) >= PRE_SELL_RETRY_MS) {
        lastPreSellBySymbol.set(sym, now);

        const minBid = elapsed >= 280_000 ? 0.75 : elapsed >= 240_000 ? 0.80 : 0.85;

        for (const sell of unsold) {
          try {
            const sellResult = await sellWinningTokens(prisma, sell.userId, sell.tokenId, sell.betAmount, sell.executionPrice, minBid);
            if (sellResult.success) {
              sell.sold = true;
              log.info(
                `[${sym}] PRE-SELL OK [${sell.userId.slice(0, 8)}]: ${sell.direction} — ` +
                `$${sellResult.usdcReceived?.toFixed(2)} USDC @ ${sellResult.sellPrice?.toFixed(3)}`,
              );

              const realPnl = (sellResult.usdcReceived ?? 0) - sell.betAmount;
              await prisma.polymarketPrediction.updateMany({
                where: { windowStart: new Date(w.windowStart), symbol: sym, userId: sell.userId },
                data: {
                  usdcReceived: sellResult.usdcReceived,
                  sellPrice: sellResult.sellPrice,
                  soldAt: new Date(),
                  realPnl,
                },
              });
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[${sym}] PRE-SELL error [${sell.userId.slice(0, 8)}] for ${sell.direction}: ${msg}`);
          }
        }
      }
    }

    // ── Update live state for this symbol ────────────────────────────────
    liveStateBySymbol.set(sym, {
      window: w ? { ...w } : null,
      klines1m: klines,
    });
  }
  } finally {
    tickInProgress = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns current window state + klines1m for all symbols.
 */
export function getPolymarketLiveState(): {
  symbols: Record<string, { window: WindowState | null; klines1m: Candle1m[] }>;
} {
  const symbols: Record<string, { window: WindowState | null; klines1m: Candle1m[] }> = {};
  for (const sym of ALL_POLYMARKET_SYMBOLS) {
    const state = liveStateBySymbol.get(sym);
    symbols[sym] = state ? { ...state } : { window: null, klines1m: [] };
  }
  return { symbols };
}

/**
 * Start the background worker polling every 1s.
 */
export function startPolymarketWorker(prisma: PrismaClient): void {
  if (intervalHandle) {
    log.warn('Worker already running');
    return;
  }

  startChainlinkFeed();

  const ws = getBinanceWebSocket();
  for (const sym of ALL_POLYMARKET_SYMBOLS) {
    ws.subscribeToKline(BINANCE_SYMBOL(sym), '1m');
  }

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
    `Worker started — polling every ${POLL_INTERVAL_MS}ms, symbols=[${ALL_POLYMARKET_SYMBOLS.join(',')}], window=${WINDOW_MS / 1000}s`,
  );
}

/**
 * On startup, re-queue predictions that were never oracle-verified.
 */
async function recoverPendingVerifications(prisma: PrismaClient): Promise<void> {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const unverified = await prisma.polymarketPrediction.findMany({
    where: {
      createdAt: { gte: twoHoursAgo },
      skipped: false,
      prediction: { not: null },
      polymarketSlug: { not: null },
      isCorrect: null,
    },
    select: {
      userId: true,
      symbol: true,
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

  // Detect virtual users so recovered verifications don't go through live sell path
  const virtualUserIds = new Set(await getVirtualPolymarketUserIds(prisma));

  for (const p of unverified) {
    const uid = p.userId ?? null;
    pendingVerifications.push({
      userId: uid,
      symbol: p.symbol,
      windowStart: p.windowStart.getTime(),
      slug: p.polymarketSlug!,
      predictionDirection: p.prediction as 'UP' | 'DOWN',
      entryOdds: p.entryOdds,
      executionPrice: p.executionPrice,
      betAmount: p.betAmount,
      tokenId: p.tokenId,
      verifyAfterMs: Date.now(),
      giveUpAfterMs: Date.now() + 60 * 60 * 1000,
      isVirtual: uid !== null && virtualUserIds.has(uid),
    });
  }

  log.info(`Recovery: re-queued ${unverified.length} unverified predictions for oracle check (${virtualUserIds.size} virtual users)`);
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
  activeLiveBetByUser.clear();
  tickInProgress = false;

  // Clear all per-symbol state
  windowBySymbol.clear();
  decisionMadeBySymbol.clear();
  lastPreSellBySymbol.clear();
  lastTpCheckBySymbol.clear();
  resolutionDoneBySymbol.clear();
  autoSellsBySymbol.clear();
  virtualBetsBySymbol.clear();
  virtualObservationBySymbol.clear();
  observationOrderBySymbol.clear();
  liveStateBySymbol.clear();
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
    amount: u.betAmount / u.executionPrice,
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
  const allRows = await prisma.polymarketPrediction.findMany({
    where: userId ? { OR: [{ userId }, { userId: null }] } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  // Deduplicate by windowStart:symbol: prefer per-user row (has execution data) over shared row
  const byWindowSymbol = new Map<string, (typeof allRows)[0]>();
  for (const row of allRows) {
    const key = `${row.windowStart.getTime()}:${row.symbol}`;
    const existing = byWindowSymbol.get(key);
    if (!existing || (existing.userId === null && row.userId !== null)) {
      byWindowSymbol.set(key, row);
    }
  }
  const predictions = [...byWindowSymbol.values()];

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

  let tradedWins = 0;
  let tradedLosses = 0;
  let tradedPnl = 0;
  let todayTradedWins = 0;
  let todayTradedLosses = 0;
  let todayTradedPnl = 0;

  for (const p of predictions) {
    const isToday = p.createdAt >= todayStart;
    const hasExecution = p.executionPrice != null;

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

  const verified = wins + losses;
  const winRate = verified > 0 ? (wins / verified) * 100 : 0;
  const todayVerified = todayWins + todayLosses;
  const todayWinRate = todayVerified > 0 ? (todayWins / todayVerified) * 100 : 0;

  const tradedVerified = tradedWins + tradedLosses;
  const tradedWinRate = tradedVerified > 0 ? (tradedWins / tradedVerified) * 100 : 0;
  const todayTradedVerified = todayTradedWins + todayTradedLosses;
  const todayTradedWinRate = todayTradedVerified > 0 ? (todayTradedWins / todayTradedVerified) * 100 : 0;

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
