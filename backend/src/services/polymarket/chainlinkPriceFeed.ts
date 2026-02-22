/**
 * Chainlink multi-symbol price feed via Polymarket RTDS WebSocket.
 *
 * Connects to wss://ws-live-data.polymarket.com and subscribes to
 * the `crypto_prices_chainlink` topic to receive real-time Chainlink
 * oracle prices — the same source Polymarket uses for "price to beat"
 * resolution on up/down 5-minute markets.
 *
 * Supports BTC, ETH, SOL, XRP in a single WS connection.
 */

import WebSocket from 'ws';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('chainlink-feed');

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 10_000;  // Check liveness every 10s
const DATA_TIMEOUT_MS = 30_000;       // Force reconnect if no data for 30s
const STALE_LOG_INTERVAL_MS = 60_000; // Throttle stale warnings to once per 60s

/** Feed symbols subscribed via RTDS (lowercase/usd format) */
const FEED_SYMBOLS = ['btc/usd', 'eth/usd', 'sol/usd', 'xrp/usd'] as const;

/** Normalize RTDS symbol ('btc/usd') to short uppercase ('BTC') */
function normalizeSymbol(rtdsSymbol: string): string {
  return rtdsSymbol.split('/')[0].toUpperCase();
}

// ─── Module state ────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
const pricesBySymbol = new Map<string, { price: number; ts: number }>();
let pingTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let running = false;
let lastDataReceivedAt = 0;   // Tracks when we last received ANY data (liveness)
let lastStaleLogAt = 0;       // Throttle stale warnings

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ChainlinkPrice {
  price: number;
  timestamp: number;
}

/**
 * Returns the latest Chainlink price for a given symbol, or null if not yet received / stale.
 */
export function getChainlinkPrice(symbol: string): ChainlinkPrice | null {
  const entry = pricesBySymbol.get(symbol.toUpperCase());
  if (!entry) return null;

  const now = Date.now();
  const age = now - entry.ts;
  if (age > 30_000) {
    if (now - lastStaleLogAt >= STALE_LOG_INTERVAL_MS) {
      log.warn(`Chainlink ${symbol} price stale: ${Math.round(age / 1000)}s old`);
      lastStaleLogAt = now;
    }
    return null;
  }

  return { price: entry.price, timestamp: entry.ts };
}

/**
 * Backward-compatible wrapper: returns BTC price.
 */
export function getChainlinkBtcPrice(): ChainlinkPrice | null {
  return getChainlinkPrice('BTC');
}

/**
 * Start the Chainlink price feed WebSocket connection.
 */
export function startChainlinkFeed(): void {
  if (running) return;
  running = true;
  connect();
}

/**
 * Stop the Chainlink price feed.
 */
export function stopChainlinkFeed(): void {
  running = false;
  cleanup();
}

// ─── Internal ────────────────────────────────────────────────────────────────

function cleanup(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}

function connect(): void {
  cleanup();
  if (!running) return;

  log.info(`Connecting to Polymarket RTDS: ${RTDS_URL}`);

  ws = new WebSocket(RTDS_URL);

  ws.on('open', () => {
    const symbolList = FEED_SYMBOLS.join(', ');
    log.info(`RTDS connected — subscribing to crypto_prices_chainlink [${symbolList}]`);
    reconnectAttempts = 0;

    const subscribeMsg = JSON.stringify({
      action: 'subscribe',
      subscriptions: FEED_SYMBOLS.map((s) => ({
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: JSON.stringify({ symbol: s }),
      })),
    });
    ws!.send(subscribeMsg);

    // Maintain connection with pings every 5s
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send('PING');
      }
    }, PING_INTERVAL_MS);

    // Watchdog: force reconnect if no data received for DATA_TIMEOUT_MS
    lastDataReceivedAt = Date.now();
    watchdogTimer = setInterval(() => {
      const silence = Date.now() - lastDataReceivedAt;
      if (silence > DATA_TIMEOUT_MS) {
        log.warn(`RTDS watchdog: no data for ${Math.round(silence / 1000)}s — forcing reconnect`);
        cleanup();
        scheduleReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
  });

  ws.on('message', (data: WebSocket.Data) => {
    const raw = data.toString();
    // Any message (including PONG) proves the connection is alive
    lastDataReceivedAt = Date.now();
    if (raw === 'PONG') return;

    try {
      const msg = JSON.parse(raw) as {
        topic?: string;
        type?: string;
        payload?: { symbol?: string; timestamp?: number; value?: number };
      };

      if (
        msg.topic === 'crypto_prices_chainlink' &&
        msg.payload?.symbol &&
        typeof msg.payload.value === 'number'
      ) {
        const sym = normalizeSymbol(msg.payload.symbol);
        pricesBySymbol.set(sym, {
          price: msg.payload.value,
          ts: msg.payload.timestamp ?? Date.now(),
        });
      }
    } catch {
      // Ignore non-JSON messages (e.g., subscription confirmations)
    }
  });

  ws.on('close', (code: number) => {
    log.warn(`RTDS disconnected (code=${code})`);
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    log.error(`RTDS error: ${err.message}`);
    // 'close' event will fire after error, triggering reconnect
  });
}

function scheduleReconnect(): void {
  if (!running) return;

  const delay = Math.min(
    RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectAttempts++;

  log.info(`RTDS reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => connect(), delay);
}
