/**
 * Telegram Notifications for Trading Orders
 * 
 * Simple notification system to get real-time alerts on your phone
 * 
 * Setup:
 * 1. Add to .env:
 *    TELEGRAM_BOT_TOKEN=your_token_from_botfather
 *    TELEGRAM_CHAT_ID=your_chat_id
 * 2. That's it!
 */

import { createLogger } from './logger.js';

const logger = createLogger('telegram');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const isEnabled = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

if (!isEnabled) {
  logger.warn('[Telegram] Notifications disabled - missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
}

/**
 * Send a message to Telegram
 */
async function sendTelegramMessage(text: string, parseMode: 'MarkdownV2' | 'HTML' | null = null): Promise<void> {
  if (!isEnabled) return;

  try {
    const body: Record<string, unknown> = {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    };
    
    // Only add parse_mode if specified (plain text is safest)
    if (parseMode) {
      body.parse_mode = parseMode;
    }

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error(`[Telegram] Failed to send message: ${error}`);
    }
  } catch (error: any) {
    logger.error(`[Telegram] Error sending message:`, error.message);
  }
}

/**
 * Notify when a new order is submitted to the queue
 */
export async function notifyOrderSubmitted(order: {
  id: string;
  agentId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price?: number;
  reason: string;
  priority: number;
}): Promise<void> {
  if (!isEnabled) return;

  const priceInfo = order.price ? `\nPrice: $${order.price.toFixed(2)}` : '';
  const priorityEmoji = order.priority >= 90 ? '🔴' : order.priority >= 70 ? '🟠' : '🟡';

  const message = `
📝 ORDER QUEUED ${priorityEmoji}

Symbol: ${order.symbol}
Side: ${order.side.toUpperCase()}
Type: ${order.type}
Qty: ${order.quantity}${priceInfo}
Reason: ${order.reason}
Priority: ${order.priority}

Agent: ${order.agentId.substring(0, 8)}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify when an order is successfully executed
 */
export async function notifyOrderFilled(order: {
  id: string;
  symbol: string;
  side: string;
  filled: number;
  average?: number;
  price?: number;
  status?: string;
}): Promise<void> {
  if (!isEnabled) return;

  const executionPrice = order.average || order.price || 0;
  const priceStr = executionPrice > 0 ? `$${executionPrice.toFixed(2)}` : 'Market';

  const message = `
✅ ORDER FILLED

Symbol: ${order.symbol}
Side: ${order.side.toUpperCase()}
Qty: ${order.filled}
Price: ${priceStr}
Time: ${new Date().toLocaleTimeString()}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify when an order fails
 */
export async function notifyOrderFailed(order: {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  error: string;
  retriesUsed: number;
}): Promise<void> {
  if (!isEnabled) return;

  const message = `
❌ ORDER FAILED

Symbol: ${order.symbol}
Side: ${order.side.toUpperCase()}
Qty: ${order.quantity}
Error: ${order.error}
Retries: ${order.retriesUsed}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify when agent opens a position
 */
export async function notifyPositionOpened(position: {
  agentId: string;
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
}): Promise<void> {
  if (!isEnabled) return;

  const leverageInfo = position.leverage ? ` (${position.leverage}x)` : '';
  const slInfo = position.stopLoss ? `\nSL: $${position.stopLoss.toFixed(2)}` : '';
  const tpInfo = position.takeProfit ? `\nTP: $${position.takeProfit.toFixed(2)}` : '';

  const message = `
🚀 POSITION OPENED

${position.symbol} ${position.side.toUpperCase()}${leverageInfo}
Entry: $${position.entryPrice.toFixed(2)}${slInfo}${tpInfo}
Qty: ${position.quantity}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify when agent closes a position
 */
export async function notifyPositionClosed(position: {
  agentId: string;
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  reason: string;
}): Promise<void> {
  if (!isEnabled) return;

  const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
  const pnlSign = position.pnl > 0 ? '+' : '';

  const message = `
${pnlEmoji} POSITION CLOSED

${position.symbol} ${position.side.toUpperCase()}
Entry: $${position.entryPrice.toFixed(2)} → Exit: $${position.exitPrice.toFixed(2)}
PnL: ${pnlSign}$${position.pnl.toFixed(2)} (${pnlSign}${position.pnlPct.toFixed(2)}%)
Reason: ${position.reason}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify critical system events
 */
export async function notifySystemAlert(alert: {
  level: 'warning' | 'error' | 'critical';
  title: string;
  message: string;
}): Promise<void> {
  if (!isEnabled) return;

  const emoji = alert.level === 'critical' ? '🚨' : alert.level === 'error' ? '⚠️' : '⚡';

  const message = `
${emoji} SYSTEM ALERT

${alert.title}
${alert.message}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Send a test notification to verify setup
 */
export async function sendTestNotification(): Promise<boolean> {
  if (!isEnabled) {
    console.log('❌ Telegram not configured - add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env');
    return false;
  }

  try {
    await sendTelegramMessage(`
✅ *Telegram Notifications Enabled*

Your trading bot is now connected!
You'll receive notifications for:
- New orders
- Filled orders
- Positions opened/closed
- System alerts

Time: ${new Date().toLocaleString()}
    `.trim());

    console.log('✅ Test notification sent successfully!');
    return true;
  } catch (error) {
    console.error('❌ Failed to send test notification:', error);
    return false;
  }
}
