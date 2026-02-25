/**
 * Telegram Reporter Service
 *
 * Periodic reports for monitoring trading agents:
 * - Heartbeat every 4h (agent status, balance, position)
 * - Top 3 rejected signals every 4h
 * - Daily report at 20h Israel time (UTC+2)
 */

import { createLogger } from '../utils/logger.js';
import { prisma } from '../db/client.js';
import { runBacktest } from './backtestService.js';
import { sendSystemMessage } from '../utils/notifications.js';

const logger = createLogger('telegram-reporter');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Chat IDs are now per-user (stored in UserSetting table), no global TELEGRAM_CHAT_ID needed
const isEnabled = Boolean(TELEGRAM_BOT_TOKEN);

// ============================================================================
// TYPES
// ============================================================================

export interface RejectedSignal {
  timestamp: number;
  symbol: string;
  side: 'long' | 'short';
  score: number;
  reason: string;
  price: number;
}

interface AgentState {
  symbol: string;
  mode: 'paper' | 'live';
  balance: number;
  position: {
    side: 'long' | 'short';
    entryPrice: number;
    pnlPct: number;
  } | null;
  lastUpdate: number;
}

interface DailyStats {
  trades: number;
  wins: number;
  losses: number;
  pnlUsd: number;
  pnlPct: number;
}

// ============================================================================
// STATE
// ============================================================================

// Buffer of rejected signals (last 4h window)
const rejectedSignals: RejectedSignal[] = [];
const MAX_REJECTED_SIGNALS = 200;

// Agent states (keyed by symbol)
const agentStates = new Map<string, AgentState>();

// Daily stats
let dailyStats: DailyStats = { trades: 0, wins: 0, losses: 0, pnlUsd: 0, pnlPct: 0 };
let lastDailyReportDate: string | null = null;

// Timing
let startTime = Date.now();
let lastHeartbeat = 0;
let lastRejectReport = 0;

// Interval IDs for cleanup
let heartbeatInterval: NodeJS.Timeout | null = null;
let dailyReportInterval: NodeJS.Timeout | null = null;

// Daily BT vs Live report config
// V5.131: Top combined-BT contributors
const REPORT_SYMBOLS = [
  'FET/USDT:USDT', 'UNI/USDT:USDT', 'ARB/USDT:USDT', 'WIF/USDT:USDT',
  'STX/USDT:USDT', 'NEAR/USDT:USDT', 'APT/USDT:USDT', 'ETH/USDT:USDT',
  'RENDER/USDT:USDT', 'BTC/USDT:USDT',
];
const WARMUP_DAYS = 14; // SMA200 on 1h needs 200h ~8.3d, use 14d

// ============================================================================
// PUBLIC API - TRACKING
// (Per-user notifications are handled by notifications.ts, not this reporter)
// ============================================================================

/**
 * Track a rejected signal for reporting
 * Only track signals with score > 40 (meaningful rejections)
 */
export function trackRejectedSignal(signal: RejectedSignal): void {
  if (signal.score < 40) return; // Ignore low-quality signals

  rejectedSignals.push(signal);

  // Keep buffer bounded
  if (rejectedSignals.length > MAX_REJECTED_SIGNALS) {
    rejectedSignals.shift();
  }
}

/**
 * Update agent state for heartbeat reports
 */
export function updateAgentState(state: AgentState): void {
  agentStates.set(state.symbol, state);
}

/**
 * Record a completed trade for daily stats
 */
export function recordTrade(pnlUsd: number): void {
  dailyStats.trades++;
  if (pnlUsd > 0) {
    dailyStats.wins++;
  } else {
    dailyStats.losses++;
  }
  dailyStats.pnlUsd += pnlUsd;
}

/**
 * Update daily PnL percentage (called with current balance)
 */
export function updateDailyPnlPct(pnlPct: number): void {
  dailyStats.pnlPct = pnlPct;
}

// ============================================================================
// REPORTS
// ============================================================================

/**
 * Send heartbeat report (agent status)
 */
async function sendHeartbeat(): Promise<void> {
  // Disabled: only entry/exit notifications are sent to Telegram
  lastHeartbeat = Date.now();
  return;
}

/**
 * Send top 3 rejected signals report
 */
async function sendRejectedSignalsReport(): Promise<void> {
  // Disabled: only entry/exit notifications are sent to Telegram
  lastRejectReport = Date.now();
  return;
}

/**
 * Normalize symbol for comparison (e.g. "AVAX/USDT:USDT" -> "avaxusdt", "AVAXUSDT" -> "avaxusdt")
 */
function normalizeSymbol(s: string): string {
  return s.replace(/[/:]/g, '').toLowerCase().replace('usdt', '').replace('usdt', '');
}

/**
 * Send daily BT vs Live comparison report at 20h Israel time.
 * Runs backtest for today, queries live trades, matches them, and reports discrepancies.
 */
async function sendDailyReport(): Promise<void> {
  // Guard: only send once per day
  const todayStr = new Date().toISOString().slice(0, 10);
  if (lastDailyReportDate === todayStr) return;
  lastDailyReportDate = todayStr;

  logger.info('[DailyReport] Generating BT vs Live report...');

  try {
    // Define time range: today 00:00 UTC -> now
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    // Data start = 14 days before today for indicator warmup
    const dataStartDate = new Date(todayStart);
    dataStartDate.setDate(dataStartDate.getDate() - WARMUP_DAYS);

    // 1. Run backtest in parityMode for today
    let btResult;
    try {
      btResult = await runBacktest({
        startDate: todayStart,
        endDate: now,
        initialCapital: 10000,
        symbols: REPORT_SYMBOLS,
        leverage: 10,
        parityMode: true,
        dataStartDate,
      });
    } catch (btErr: unknown) {
      const msg = btErr instanceof Error ? btErr.message : String(btErr);
      logger.error('[DailyReport] Backtest failed:', msg);
      await sendSystemMessage(`📊 Daily BT vs Live Report\n\n❌ Backtest failed: ${msg.substring(0, 200)}\n\n⏰ ${now.toISOString()}`);
      return;
    }

    const btTrades = btResult.trades || [];
    const btSignals = btResult.validSignals || [];

    // 2. Query live trades today from DB
    const liveTrades = await prisma.trade.findMany({
      where: {
        entryTs: { gte: todayStart },
        session: { mode: 'live' },
      },
      include: { session: { select: { mode: true, symbol: true } } },
      orderBy: { entryTs: 'asc' },
    });

    // 3. Match BT trades to live trades
    const MATCH_WINDOW_MS = 30 * 60 * 1000; // 30 min

    interface MatchResult {
      type: 'MATCHED' | 'MISSED_BY_LIVE' | 'LIVE_ONLY';
      symbol: string;
      side: string;
      btEntry?: string;
      btExit?: string;
      btExitReason?: string;
      btPnl?: number;
      liveEntry?: string;
      liveExit?: string;
      liveExitReason?: string;
      livePnl?: number;
    }

    const results: MatchResult[] = [];
    const matchedLiveIds = new Set<string>();

    // For each BT trade, find matching live trade
    for (const bt of btTrades) {
      const btEntryMs = new Date(bt.entryTime).getTime();
      const btSymNorm = normalizeSymbol(bt.symbol);

      const match = liveTrades.find(lt => {
        if (matchedLiveIds.has(lt.id)) return false;
        const ltSymNorm = normalizeSymbol(lt.symbol);
        const ltSide = lt.positionSide.toLowerCase();
        const timeDiff = Math.abs(lt.entryTs.getTime() - btEntryMs);
        return ltSymNorm === btSymNorm && ltSide === bt.side && timeDiff <= MATCH_WINDOW_MS;
      });

      if (match) {
        matchedLiveIds.add(match.id);
        results.push({
          type: 'MATCHED',
          symbol: bt.symbol.replace('/USDT:USDT', ''),
          side: bt.side,
          btEntry: new Date(bt.entryTime).toISOString().slice(11, 16),
          btExitReason: bt.exitReason,
          btPnl: bt.netPnlUsd,
          liveEntry: match.entryTs.toISOString().slice(11, 16),
          liveExitReason: match.exitReason || '?',
          livePnl: match.realizedPnlUsd - match.feesUsd,
        });
      } else {
        results.push({
          type: 'MISSED_BY_LIVE',
          symbol: bt.symbol.replace('/USDT:USDT', ''),
          side: bt.side,
          btEntry: new Date(bt.entryTime).toISOString().slice(11, 16),
          btExit: new Date(bt.exitTime).toISOString().slice(11, 16),
          btExitReason: bt.exitReason,
          btPnl: bt.netPnlUsd,
        });
      }
    }

    // Live-only trades (no BT match)
    for (const lt of liveTrades) {
      if (!matchedLiveIds.has(lt.id)) {
        results.push({
          type: 'LIVE_ONLY',
          symbol: lt.symbol.replace('/USDT:USDT', ''),
          side: lt.positionSide.toLowerCase(),
          liveEntry: lt.entryTs.toISOString().slice(11, 16),
          liveExit: lt.exitTs.toISOString().slice(11, 16),
          liveExitReason: lt.exitReason || '?',
          livePnl: lt.realizedPnlUsd - lt.feesUsd,
        });
      }
    }

    // 4. Format message
    const matched = results.filter(r => r.type === 'MATCHED');
    const missed = results.filter(r => r.type === 'MISSED_BY_LIVE');
    const liveOnly = results.filter(r => r.type === 'LIVE_ONLY');

    let msg = `📊 DAILY BT vs LIVE REPORT\n${todayStr}\n\n`;
    msg += `BT signals: ${btSignals.length} | BT trades: ${btTrades.length}\n`;
    msg += `Live trades: ${liveTrades.length}\n`;
    msg += `✅ Matched: ${matched.length} | ❌ Missed: ${missed.length} | 🔵 Live-only: ${liveOnly.length}\n`;

    if (missed.length > 0) {
      msg += `\n❌ MISSED BY LIVE (BT had signal, live didn't):\n`;
      for (const m of missed) {
        msg += `  ${m.symbol} ${m.side} @ ${m.btEntry}-${m.btExit} | ${m.btExitReason} | $${m.btPnl?.toFixed(1)}\n`;
      }
    }

    if (matched.length > 0) {
      msg += `\n✅ MATCHED:\n`;
      for (const m of matched) {
        msg += `  ${m.symbol} ${m.side} | BT:${m.btEntry} Live:${m.liveEntry} | BT$${m.btPnl?.toFixed(1)} Live$${m.livePnl?.toFixed(1)}\n`;
      }
    }

    if (liveOnly.length > 0) {
      msg += `\n🔵 LIVE-ONLY (no BT match):\n`;
      for (const m of liveOnly) {
        msg += `  ${m.symbol} ${m.side} @ ${m.liveEntry} | ${m.liveExitReason} | $${m.livePnl?.toFixed(1)}\n`;
      }
    }

    // Summary PnL
    const btTotalPnl = btTrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const liveTotalPnl = liveTrades.reduce((s, t) => s + (t.realizedPnlUsd - t.feesUsd), 0);
    const missedPnl = missed.reduce((s, m) => s + (m.btPnl || 0), 0);
    msg += `\n💰 BT PnL: $${btTotalPnl.toFixed(1)} | Live PnL: $${liveTotalPnl.toFixed(1)}`;
    if (missed.length > 0) {
      msg += `\n⚠️ Missed opportunity: $${missedPnl.toFixed(1)}`;
    }
    msg += `\n\n⏰ ${now.toISOString()}`;

    // Truncate to 4000 chars (Telegram limit is 4096)
    if (msg.length > 4000) {
      msg = msg.substring(0, 3990) + '\n...(truncated)';
    }

    await sendSystemMessage(msg);
    logger.info(`[DailyReport] Sent. BT:${btTrades.length} trades, Live:${liveTrades.length} trades, Missed:${missed.length}`);

    // Reset daily stats
    dailyStats = { trades: 0, wins: 0, losses: 0, pnlUsd: 0, pnlPct: 0 };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[DailyReport] Error:', msg);
  }
}

// ============================================================================
// SCHEDULER
// ============================================================================

/**
 * Check if it's time for daily report (20h Israel = UTC+2)
 */
function shouldSendDailyReport(): boolean {
  const now = new Date();
  // Get current hour in Israel timezone
  const israelHour = parseInt(now.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: 'numeric',
    hour12: false
  }));
  const israelMinute = now.getMinutes();

  // Check if it's between 20:00 and 20:15 (window to catch it)
  return israelHour === 20 && israelMinute < 15;
}

/**
 * Main scheduler tick - runs every minute
 */
async function schedulerTick(): Promise<void> {
  const now = Date.now();
  const fourHours = 4 * 60 * 60 * 1000;

  // Heartbeat every 4h
  if (now - lastHeartbeat >= fourHours) {
    await sendHeartbeat();
  }

  // Rejected signals report every 4h (offset by 5 min from heartbeat)
  if (now - lastRejectReport >= fourHours && now - lastHeartbeat > 5 * 60 * 1000) {
    await sendRejectedSignalsReport();
  }

  // Daily report at 20h Israel
  if (shouldSendDailyReport()) {
    await sendDailyReport();
  }
}

/**
 * Start the telegram reporter scheduler
 */
export function startTelegramReporter(): void {
  if (!isEnabled) {
    logger.warn(`[TelegramReporter] Disabled - missing TELEGRAM_BOT_TOKEN`);
    return;
  }

  startTime = Date.now();
  lastHeartbeat = Date.now(); // Don't send immediately, wait 4h
  lastRejectReport = Date.now();

  // Run scheduler every minute
  heartbeatInterval = setInterval(() => {
    schedulerTick().catch(err => {
      logger.error(`[TelegramReporter] Scheduler error:`, err);
    });
  }, 60 * 1000);

  logger.info(`[TelegramReporter] Started - heartbeat every 4h, daily report at 20h Israel`);
}

/**
 * Stop the telegram reporter scheduler
 */
export function stopTelegramReporter(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (dailyReportInterval) {
    clearInterval(dailyReportInterval);
    dailyReportInterval = null;
  }
  logger.info(`[TelegramReporter] Stopped`);
}

/**
 * Force send a heartbeat (for testing or manual trigger)
 */
export async function forceHeartbeat(): Promise<void> {
  await sendHeartbeat();
}

/**
 * Force send rejected signals report (for testing)
 */
export async function forceRejectedSignalsReport(): Promise<void> {
  await sendRejectedSignalsReport();
}

/**
 * Force send daily BT vs Live report (for testing/manual trigger)
 */
export async function forceDailyReport(): Promise<void> {
  lastDailyReportDate = null;
  await sendDailyReport();
}
