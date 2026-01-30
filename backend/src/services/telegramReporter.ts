/**
 * Telegram Reporter Service
 *
 * Periodic reports for monitoring trading agents:
 * - Heartbeat every 4h (agent status, balance, position)
 * - Top 3 rejected signals every 4h
 * - Daily report at 20h Israel time (UTC+2)
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('telegram-reporter');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const isEnabled = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

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

// ============================================================================
// TELEGRAM SEND
// ============================================================================

async function sendTelegramMessage(text: string): Promise<void> {
  if (!isEnabled) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error(`[TelegramReporter] Failed to send: ${error}`);
    }
  } catch (error: any) {
    logger.error(`[TelegramReporter] Error:`, error.message);
  }
}

// ============================================================================
// PUBLIC API - TRACKING
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
 * Send daily report at 20h Israel time
 */
async function sendDailyReport(): Promise<void> {
  // Disabled: only entry/exit notifications are sent to Telegram
  return;
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
    logger.warn(`[TelegramReporter] Disabled - missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID`);
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
