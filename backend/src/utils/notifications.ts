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
 * NOTE: For entry orders, we skip this and let notifyPositionOpened handle it
 * to avoid duplicate notifications. Only used for exit orders in orderQueue.
 */
export async function notifyOrderFilled(order: {
  id: string;
  symbol: string;
  side: string;
  filled: number;
  average?: number;
  price?: number;
  status?: string;
  isEntry?: boolean; // If true, skip notification (will be handled by notifyPositionOpened)
}): Promise<void> {
  if (!isEnabled) return;
  
  // Skip entry order notifications - they'll be combined with position opened
  if (order.isEntry) return;

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
  retriesUsed?: number;
  isEntry?: boolean;
}): Promise<void> {
  if (!isEnabled) return;

  const orderType = order.isEntry ? 'ENTRY' : 'EXIT';
  const message = `
❌ ORDER FAILED (${orderType})

Symbol: ${order.symbol}
Side: ${order.side.toUpperCase()}
Qty: ${order.quantity}
Error: ${order.error}
Retries: ${order.retriesUsed ?? 0}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify when agent opens a position (combines order filled + position opened)
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
  mode: 'paper' | 'live';
  notionalUsd?: number;
  marginUsd?: number;
}): Promise<void> {
  if (!isEnabled) return;

  const modeTag = position.mode === 'live' ? '🔴 LIVE' : '📝 PAPER';
  const leverageInfo = position.leverage ? `${position.leverage}x` : '';
  const slInfo = position.stopLoss ? `\nSL: $${position.stopLoss.toFixed(4)}` : '';
  const tpInfo = position.takeProfit ? `\nTP: $${position.takeProfit.toFixed(4)}` : '';
  const notionalInfo = position.notionalUsd ? `\nNotional: $${position.notionalUsd.toFixed(0)}` : '';
  const marginInfo = position.marginUsd ? `\nMargin: $${position.marginUsd.toFixed(0)}` : '';

  const message = `
🚀 POSITION OPENED ${modeTag}

${position.symbol} ${position.side.toUpperCase()} ${leverageInfo}
Entry: $${position.entryPrice.toFixed(4)}
Qty: ${position.quantity.toFixed(4)}${notionalInfo}${marginInfo}${slInfo}${tpInfo}

⏰ ${new Date().toLocaleTimeString()}
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
  mode: 'paper' | 'live';
  balanceAfter?: number;
  feesUsd?: number;
}): Promise<void> {
  if (!isEnabled) return;

  const modeTag = position.mode === 'live' ? '🔴 LIVE' : '📝 PAPER';
  const pnlEmoji = position.pnl > 0 ? '🟢' : '🔴';
  const pnlSign = position.pnl > 0 ? '+' : '';
  const feeInfo = position.feesUsd ? `\nFees: $${position.feesUsd.toFixed(2)}` : '';
  const balanceInfo = position.balanceAfter ? `\n💰 Balance: $${position.balanceAfter.toFixed(2)}` : '';

  const message = `
${pnlEmoji} POSITION CLOSED ${modeTag}

${position.symbol} ${position.side.toUpperCase()}
Entry: $${position.entryPrice.toFixed(4)}
Exit: $${position.exitPrice.toFixed(4)}

PnL: ${pnlSign}$${position.pnl.toFixed(2)} (${pnlSign}${position.pnlPct.toFixed(2)}%)${feeInfo}
Reason: ${position.reason}${balanceInfo}

⏰ ${new Date().toLocaleTimeString()}
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
 * V5.65: Notify when slippage exceeds threshold
 */
export async function notifySlippageAlert(data: {
  symbol: string;
  side: string;
  type: 'entry' | 'exit';
  expectedPrice: number;
  filledPrice: number;
  slippagePct: number;
  maxSlippagePct: number;
}): Promise<void> {
  if (!isEnabled) return;

  const emoji = data.slippagePct > data.maxSlippagePct * 2 ? '🚨' : '⚠️';
  const lossDirection = data.type === 'entry'
    ? (data.side === 'long' ? 'Higher' : 'Lower')
    : (data.side === 'long' ? 'Lower' : 'Higher');

  const message = `
${emoji} HIGH SLIPPAGE ALERT

Symbol: ${data.symbol}
Type: ${data.type.toUpperCase()}
Side: ${data.side.toUpperCase()}

Expected: $${data.expectedPrice.toFixed(4)}
Filled: $${data.filledPrice.toFixed(4)}
${lossDirection} by: ${data.slippagePct.toFixed(2)}%

⚠️ Exceeds max: ${data.maxSlippagePct.toFixed(1)}%

⏰ ${new Date().toLocaleTimeString()}
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

/**
 * V5.71: Notify when BTC regime changes (goes to Telegram)
 */
export async function notifyRegimeChangeTelegram(params: {
  newRegime: 'bull' | 'bear';
  btcPrice: number;
  sma200: number;
}): Promise<void> {
  if (!isEnabled) return;

  const isBull = params.newRegime === 'bull';
  const emoji = isBull ? '🐂' : '🐻';
  const direction = isBull ? 'BULL' : 'BEAR';
  const action = isBull ? 'crossed above' : 'dropped below';

  const message = `
${emoji} REGIME CHANGE → ${direction}

BTC ${action} SMA200
Price: $${params.btcPrice.toFixed(0)}
SMA200: $${params.sma200.toFixed(0)}

Strategy: ${isBull ? 'LONG only' : 'SHORT only'}

⏰ ${new Date().toLocaleTimeString()}
  `.trim();

  await sendTelegramMessage(message);
}
