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
  const uptimeHours = Math.floor((Date.now() - startTime) / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((Date.now() - startTime) / (1000 * 60)) % 60;

  const agents = Array.from(agentStates.values());
  if (agents.length === 0) {
    // No agents registered yet
    return;
  }

  // Aggregate balance from all agents
  const totalBalance = agents.reduce((sum, a) => sum + a.balance, 0);

  // Find active positions
  const activePositions = agents.filter(a => a.position !== null);

  let positionInfo = 'Aucune position ouverte';
  if (activePositions.length > 0) {
    positionInfo = activePositions.map(a => {
      const pos = a.position!;
      const pnlSign = pos.pnlPct >= 0 ? '+' : '';
      return `${a.symbol} ${pos.side.toUpperCase()} (${pnlSign}${pos.pnlPct.toFixed(2)}%)`;
    }).join('\n');
  }

  const message = `
📊 HEARTBEAT

Actif depuis ${uptimeHours}h${uptimeMinutes.toString().padStart(2, '0')}
Balance: $${totalBalance.toFixed(2)}

${positionInfo}

⏰ ${new Date().toLocaleTimeString('fr-FR', { timeZone: 'Asia/Jerusalem' })}
  `.trim();

  await sendTelegramMessage(message);
  lastHeartbeat = Date.now();
  logger.info(`[TelegramReporter] Heartbeat sent`);
}

/**
 * Send top 3 rejected signals report
 */
async function sendRejectedSignalsReport(): Promise<void> {
  const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);

  // Filter signals from last 4h
  const recentSignals = rejectedSignals.filter(s => s.timestamp > fourHoursAgo);

  if (recentSignals.length === 0) {
    // No signals to report
    logger.debug(`[TelegramReporter] No rejected signals in last 4h`);
    return;
  }

  // Sort by score descending and take top 3
  const top3 = recentSignals
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Format reason for display
  const formatReason = (reason: string): string => {
    // Extract key part: "bull_regime:vol_low(1.1x < 1.15x)" -> "vol_low (1.1x < 1.15x)"
    const parts = reason.split(':');
    const mainReason = parts[parts.length - 1] || reason;
    return mainReason.replace('_', ' ').replace('(', ' (');
  };

  const signalsList = top3.map((s, i) => {
    return `${i + 1}. ${s.symbol} ${s.side.toUpperCase()} (score: ${s.score})
   ${formatReason(s.reason)}`;
  }).join('\n\n');

  // Count reasons for summary
  const reasonCounts = new Map<string, number>();
  for (const s of recentSignals) {
    const key = s.reason.split(':')[0] || s.reason.split('(')[0] || 'other';
    reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
  }

  const message = `
📋 SIGNAUX REJETÉS (4h)

${recentSignals.length} signaux analysés

Top 3:
${signalsList}

⏰ ${new Date().toLocaleTimeString('fr-FR', { timeZone: 'Asia/Jerusalem' })}
  `.trim();

  await sendTelegramMessage(message);
  lastRejectReport = Date.now();

  // Clear old signals
  const cutoff = Date.now() - (4 * 60 * 60 * 1000);
  while (rejectedSignals.length > 0 && rejectedSignals[0].timestamp < cutoff) {
    rejectedSignals.shift();
  }

  logger.info(`[TelegramReporter] Rejected signals report sent (${recentSignals.length} signals)`);
}

/**
 * Send daily report at 20h Israel time
 */
async function sendDailyReport(): Promise<void> {
  const today = new Date().toLocaleDateString('fr-FR', { timeZone: 'Asia/Jerusalem' });

  // Avoid sending twice on same day
  if (lastDailyReportDate === today) {
    return;
  }

  const agents = Array.from(agentStates.values());
  const totalBalance = agents.reduce((sum, a) => sum + a.balance, 0);

  const winRate = dailyStats.trades > 0
    ? ((dailyStats.wins / dailyStats.trades) * 100).toFixed(0)
    : '0';

  const pnlSign = dailyStats.pnlUsd >= 0 ? '+' : '';
  const pnlPctSign = dailyStats.pnlPct >= 0 ? '+' : '';

  const message = `
📈 RAPPORT JOURNALIER
${today}

Trades: ${dailyStats.trades} (${dailyStats.wins}W / ${dailyStats.losses}L)
PnL: ${pnlSign}$${dailyStats.pnlUsd.toFixed(2)} (${pnlPctSign}${dailyStats.pnlPct.toFixed(2)}%)
Win Rate: ${winRate}%
Balance: $${totalBalance.toFixed(2)}

⏰ 20:00 Israel
  `.trim();

  await sendTelegramMessage(message);
  lastDailyReportDate = today;

  // Reset daily stats for next day
  dailyStats = { trades: 0, wins: 0, losses: 0, pnlUsd: 0, pnlPct: 0 };

  logger.info(`[TelegramReporter] Daily report sent`);
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
