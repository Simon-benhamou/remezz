/**
 * Notification Service
 * 
 * Sends trade notifications via WebSocket to connected clients.
 * The frontend will display browser notifications and toast messages.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('notifications');

export interface TradeNotification {
  type: 'trade_entry' | 'trade_exit' | 'stop_loss_hit' | 'take_profit_hit';
  symbol: string;
  side: 'long' | 'short';
  price: number;
  qty: number;
  notionalUsd: number;
  marginUsd?: number;
  leverage?: number;
  pnlUsd?: number;
  pnlPct?: number;
  reason?: string;
  stopLoss?: number;
  mode: 'paper' | 'live';
  timestamp: number;
}

// Broadcast function will be injected from server.ts
let broadcastFn: ((type: string, data: any, symbol?: string) => void) | null = null;

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
