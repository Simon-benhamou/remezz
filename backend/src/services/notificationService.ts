/**
 * Notification Service
 * 
 * Sends trade notifications via WebSocket to connected clients.
 * The frontend will display browser notifications and toast messages.
 * 
 * Notification Types:
 * - trade_entry/exit: Trade opened/closed
 * - order_error: Order failed on exchange (CRITICAL)
 * - daily_loss_limit: Agent hit daily loss limit
 * - trailing_activated: Trailing stop activated
 * - regime_change: BTC changed from BULL to BEAR or vice versa
 * - high_volatility: Leverage reduced due to high ATR
 * - agent_status: Agent started/stopped
 * - long_hold_warning: Position held > 24h
 * - liquidation_warning: Price approaching liquidation
 * - sync_failure: Exchange balance sync failed
 * - signal_detected: Trading signal detected
 */

import { createLogger } from '../utils/logger.js';
import { notifyRegimeChangeTelegram } from '../utils/notifications.js';

const logger = createLogger('notifications');

export type NotificationType = 
  | 'trade_entry' 
  | 'trade_exit' 
  | 'stop_loss_hit' 
  | 'take_profit_hit'
  | 'order_error'
  | 'daily_loss_limit'
  | 'trailing_activated'
  | 'regime_change'
  | 'high_volatility'
  | 'agent_started'
  | 'agent_stopped'
  | 'long_hold_warning'
  | 'liquidation_warning'
  | 'sync_failure'
  | 'signal_detected';

export interface TradeNotification {
  type: NotificationType;
  symbol: string;
  side?: 'long' | 'short';
  price?: number;
  qty?: number;
  notionalUsd?: number;
  marginUsd?: number;
  leverage?: number;
  pnlUsd?: number;
  pnlPct?: number;
  reason?: string;
  stopLoss?: number;
  mode: 'paper' | 'live';
  timestamp: number;
  // Additional fields for specific notifications
  severity?: 'info' | 'warning' | 'error' | 'success';
  title?: string;
  message?: string;
}

// Broadcast function will be injected from server.ts
let broadcastFn: ((type: string, data: any, symbol?: string) => void) | null = null;

// Track last regime to detect changes
let lastBtcRegime: 'bull' | 'bear' | null = null;

// Track notified long holds to avoid spam (sessionId -> lastNotifiedAt)
const longHoldNotified = new Map<string, number>();

/**
 * Initialize the notification service with the broadcast function from server.ts
 */
export function initNotificationService(broadcast: (type: string, data: any, symbol?: string) => void) {
  broadcastFn = broadcast;
  logger.info('📢 Notification service initialized');
}

/**
 * Send a trade entry notification
 */
export function notifyTradeEntry(params: {
  symbol: string;
  side: 'long' | 'short';
  price: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  stopLoss?: number;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'trade_entry',
    symbol: params.symbol,
    side: params.side,
    price: params.price,
    qty: params.qty,
    notionalUsd: params.notionalUsd,
    marginUsd: params.marginUsd,
    leverage: params.leverage,
    stopLoss: params.stopLoss,
    mode: params.mode,
    timestamp: Date.now(),
  };
  
  logger.info(`📢 [NOTIFICATION] Trade Entry: ${params.symbol} ${params.side.toUpperCase()} @ $${params.price.toFixed(4)}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

/**
 * Send a trade exit notification
 */
export function notifyTradeExit(params: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notionalUsd: number;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: params.reason.includes('stop_loss') ? 'stop_loss_hit' 
      : params.reason.includes('take_profit') ? 'take_profit_hit' 
      : 'trade_exit',
    symbol: params.symbol,
    side: params.side,
    price: params.exitPrice,
    qty: params.qty,
    notionalUsd: params.notionalUsd,
    pnlUsd: params.pnlUsd,
    pnlPct: params.pnlPct,
    reason: params.reason,
    mode: params.mode,
    timestamp: Date.now(),
  };
  
  const pnlEmoji = params.pnlUsd >= 0 ? '🟢' : '🔴';
  logger.info(`📢 [NOTIFICATION] Trade Exit: ${params.symbol} ${params.side.toUpperCase()} ${pnlEmoji} $${params.pnlUsd.toFixed(2)} (${params.pnlPct >= 0 ? '+' : ''}${params.pnlPct.toFixed(2)}%)`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

/**
 * Send a generic notification (for alerts, warnings, etc.)
 */
export function notifyAlert(params: {
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'success';
  symbol?: string;
}): void {
  logger.info(`📢 [ALERT] ${params.severity.toUpperCase()}: ${params.title} - ${params.message}`);
  
  if (broadcastFn) {
    broadcastFn('alert_notification', {
      title: params.title,
      message: params.message,
      severity: params.severity,
      symbol: params.symbol,
      timestamp: Date.now(),
    }, params.symbol);
  }
}

// =============================================================================
// ORDER ERROR NOTIFICATION (CRITICAL - Live mode)
// =============================================================================

/**
 * Notify when an order fails on the exchange
 */
export function notifyOrderError(params: {
  symbol: string;
  side: 'long' | 'short';
  orderType: 'entry' | 'exit' | 'stop_loss';
  error: string;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'order_error',
    symbol: params.symbol,
    side: params.side,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'error',
    title: `🚨 Order Failed: ${params.symbol}`,
    message: `${params.orderType.toUpperCase()} order failed: ${params.error}`,
  };
  
  logger.error(`🚨 [ORDER ERROR] ${params.symbol} ${params.side} ${params.orderType}: ${params.error}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

// =============================================================================
// DAILY LOSS LIMIT NOTIFICATION
// =============================================================================

/**
 * Notify when agent hits daily loss limit
 */
export function notifyDailyLossLimit(params: {
  symbol: string;
  dailyLossUsd: number;
  limitUsd: number;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'daily_loss_limit',
    symbol: params.symbol,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'warning',
    title: `⛔ Daily Loss Limit: ${params.symbol}`,
    message: `Agent paused. Loss today: $${params.dailyLossUsd.toFixed(2)} (limit: $${params.limitUsd.toFixed(2)})`,
    pnlUsd: params.dailyLossUsd,
  };
  
  logger.warn(`⛔ [DAILY LOSS LIMIT] ${params.symbol}: $${params.dailyLossUsd.toFixed(2)} / $${params.limitUsd.toFixed(2)}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

// =============================================================================
// TRAILING STOP NOTIFICATION
// =============================================================================

/**
 * Notify when trailing stop is activated
 */
export function notifyTrailingActivated(params: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  trailPrice: number;
  pnlPct: number;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'trailing_activated',
    symbol: params.symbol,
    side: params.side,
    price: params.currentPrice,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'success',
    title: `🎯 Trailing Stop Active: ${params.symbol}`,
    message: `+${params.pnlPct.toFixed(1)}% profit locked. Trail @ $${params.trailPrice.toFixed(2)}`,
    pnlPct: params.pnlPct,
    stopLoss: params.trailPrice,
  };
  
  logger.info(`🎯 [TRAILING] ${params.symbol} ${params.side} activated @ +${params.pnlPct.toFixed(1)}%`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

// =============================================================================
// REGIME CHANGE NOTIFICATION
// =============================================================================

/**
 * Notify when BTC regime changes (BULL <-> BEAR)
 */
export function notifyRegimeChange(params: {
  newRegime: 'bull' | 'bear';
  btcPrice: number;
  sma200: number;
}): void {
  // Skip if same regime
  if (lastBtcRegime === params.newRegime) return;
  
  const wasBull = lastBtcRegime === 'bull';
  lastBtcRegime = params.newRegime;
  
  // Skip first notification (initialization)
  if (lastBtcRegime === null) return;
  
  const isBull = params.newRegime === 'bull';
  const notification: TradeNotification = {
    type: 'regime_change',
    symbol: 'BTC/USDT',
    price: params.btcPrice,
    mode: 'paper', // Regime change is global
    timestamp: Date.now(),
    severity: 'info',
    title: isBull ? '🐂 BULL Market Detected' : '🐻 BEAR Market Detected',
    message: `BTC ${isBull ? 'crossed above' : 'dropped below'} SMA200 ($${params.sma200.toFixed(0)}). Strategy: ${isBull ? 'LONG only' : 'SHORT only'}`,
  };
  
  logger.info(`📢 [REGIME CHANGE] ${wasBull ? 'BULL' : 'BEAR'} → ${isBull ? 'BULL' : 'BEAR'} | BTC=$${params.btcPrice.toFixed(0)} vs SMA200=$${params.sma200.toFixed(0)}`);

  if (broadcastFn) {
    broadcastFn('trade_notification', notification);
  }

  // V5.71: Send to Telegram
  notifyRegimeChangeTelegram(params);
}

// =============================================================================
// HIGH VOLATILITY NOTIFICATION
// =============================================================================

/**
 * Notify when leverage is reduced due to high ATR volatility
 */
export function notifyHighVolatility(params: {
  symbol: string;
  atrPct: number;
  originalLeverage: number;
  reducedLeverage: number;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'high_volatility',
    symbol: params.symbol,
    leverage: params.reducedLeverage,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'warning',
    title: `⚡ High Volatility: ${params.symbol}`,
    message: `ATR=${params.atrPct.toFixed(1)}%. Leverage reduced: ${params.originalLeverage}x → ${params.reducedLeverage}x`,
  };
  
  logger.warn(`⚡ [HIGH VOL] ${params.symbol} ATR=${params.atrPct.toFixed(1)}% | Leverage: ${params.originalLeverage}x → ${params.reducedLeverage}x`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

// =============================================================================
// AGENT STATUS NOTIFICATIONS
// =============================================================================

/**
 * Notify when agent starts
 */
export function notifyAgentStarted(params: {
  symbol: string;
  sessionId: string;
  mode: 'paper' | 'live';
  capitalUsd: number;
}): void {
  const notification: TradeNotification = {
    type: 'agent_started',
    symbol: params.symbol,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'success',
    title: `🤖 Agent Started: ${params.symbol}`,
    message: `${params.mode.toUpperCase()} mode with $${params.capitalUsd.toFixed(0)} capital`,
    notionalUsd: params.capitalUsd,
  };
  
  logger.info(`🤖 [AGENT STARTED] ${params.symbol} | ${params.mode} | $${params.capitalUsd.toFixed(0)}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

/**
 * Notify when agent stops
 */
export function notifyAgentStopped(params: {
  symbol: string;
  sessionId: string;
  mode: 'paper' | 'live';
  reason?: string;
  totalPnlUsd?: number;
}): void {
  const notification: TradeNotification = {
    type: 'agent_stopped',
    symbol: params.symbol,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'info',
    title: `⏹️ Agent Stopped: ${params.symbol}`,
    message: params.reason || 'Manual stop',
    pnlUsd: params.totalPnlUsd,
  };
  
  logger.info(`⏹️ [AGENT STOPPED] ${params.symbol} | ${params.mode} | ${params.reason || 'manual'}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

// =============================================================================
// LONG HOLD WARNING
// =============================================================================

/**
 * Notify when position has been held for too long (>24h)
 */
export function notifyLongHold(params: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  holdDurationHours: number;
  pnlPct: number;
  sessionId: string;
  mode: 'paper' | 'live';
}): void {
  // Avoid spam - only notify once per 6 hours
  const lastNotified = longHoldNotified.get(params.sessionId) || 0;
  const sixHoursMs = 6 * 60 * 60 * 1000;
  if (Date.now() - lastNotified < sixHoursMs) return;
  
  longHoldNotified.set(params.sessionId, Date.now());
  
  const notification: TradeNotification = {
    type: 'long_hold_warning',
    symbol: params.symbol,
    side: params.side,
    price: params.currentPrice,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'warning',
    title: `⏰ Long Hold: ${params.symbol}`,
    message: `Position open ${params.holdDurationHours.toFixed(0)}h. PnL: ${params.pnlPct >= 0 ? '+' : ''}${params.pnlPct.toFixed(1)}%`,
    pnlPct: params.pnlPct,
  };
  
  logger.warn(`⏰ [LONG HOLD] ${params.symbol} ${params.side} | ${params.holdDurationHours.toFixed(0)}h | ${params.pnlPct >= 0 ? '+' : ''}${params.pnlPct.toFixed(1)}%`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

// =============================================================================
// LIQUIDATION WARNING
// =============================================================================

/**
 * Notify when price approaches liquidation price
 */
export function notifyLiquidationWarning(params: {
  symbol: string;
  side: 'long' | 'short';
  currentPrice: number;
  liquidationPrice: number;
  distancePct: number;
  leverage: number;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'liquidation_warning',
    symbol: params.symbol,
    side: params.side,
    price: params.currentPrice,
    leverage: params.leverage,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'error',
    title: `🚨 Liquidation Warning: ${params.symbol}`,
    message: `Only ${params.distancePct.toFixed(1)}% from liquidation @ $${params.liquidationPrice.toFixed(2)} (${params.leverage}x)`,
  };
  
  logger.error(`🚨 [LIQUIDATION WARNING] ${params.symbol} ${params.side} | ${params.distancePct.toFixed(1)}% to liq @ $${params.liquidationPrice.toFixed(2)}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}

// =============================================================================
// SYNC FAILURE NOTIFICATION
// =============================================================================

/**
 * Notify when exchange sync fails
 */
export function notifySyncFailure(params: {
  reason: string;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'sync_failure',
    symbol: 'SYSTEM',
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'error',
    title: `🔴 Exchange Sync Failed`,
    message: params.reason,
  };
  
  logger.error(`🔴 [SYNC FAILURE] ${params.mode}: ${params.reason}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification);
  }
}

// =============================================================================
// SIGNAL DETECTED NOTIFICATION
// =============================================================================

/**
 * Notify when a trading signal is detected
 */
export function notifySignalDetected(params: {
  symbol: string;
  side: 'long' | 'short';
  price: number;
  reason: string;
  mode: 'paper' | 'live';
}): void {
  const notification: TradeNotification = {
    type: 'signal_detected',
    symbol: params.symbol,
    side: params.side,
    price: params.price,
    mode: params.mode,
    timestamp: Date.now(),
    severity: 'info',
    title: `📊 Signal: ${params.symbol} ${params.side.toUpperCase()}`,
    message: `${params.reason} @ $${params.price.toFixed(2)}`,
    reason: params.reason,
  };
  
  logger.info(`📊 [SIGNAL] ${params.symbol} ${params.side.toUpperCase()} @ $${params.price.toFixed(2)} | ${params.reason}`);
  
  if (broadcastFn) {
    broadcastFn('trade_notification', notification, params.symbol);
  }
}
