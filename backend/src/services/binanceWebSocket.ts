/**
 * 🔌 Binance WebSocket Manager
 * 
 * Remplace les appels REST API lourds par des WebSocket streams:
 * - !ticker@arr: Tous les tickers en temps réel (0 weight vs 40 weight fetchTickers)
 * - kline_15m: OHLCV en temps réel (0 weight vs 2 weight × n agents)
 * - user_data: Balance, trades, orders (0 weight vs 40 weight fetchBalance)
 * 
 * Économie: ~620 weight/min → 0 weight/min = Plus de ban possible ✅
 */

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import crypto from 'crypto';
import { getConfig } from '../utils/env.js';
import { isIpBanned, setIpBan } from '../exchange/ccxtClient.js';
import { ipWeightTracker } from './ipWeightTracker.js';
import { binanceRestQueue } from './binanceRestQueue.js';
import { evaluateTickerFrame } from '../data/tickerValidation.js';
import {
  recordMarketFrame,
  recordRestFallback,
  recordWsReconnect,
  setFallbackState,
  updateWsConnectionState,
} from '../monitor/marketMetrics.js';

const MARKET_TYPE = String(process.env.MARKET_TYPE || 'swap').toLowerCase();
type BinanceMarketKind = 'spot' | 'futures';

if (MARKET_TYPE === 'spot') {
  throw new Error('Binance spot streams are disabled: configure MARKET_TYPE=futures for the perpetual engine.');
}

const MARKET_KIND: BinanceMarketKind = 'futures';

const BINANCE_ENDPOINTS = {
  wsMulti: 'wss://fstream.binance.com/stream',
  wsUserBase: 'wss://fstream.binance.com/ws',
  rest: 'https://fapi.binance.com',
  listenKeyPath: '/fapi/v1/listenKey',
  requiresSignature: true,
} as const;

export const BINANCE_REST_BASE_URL = BINANCE_ENDPOINTS.rest;

export interface BinanceTickerData {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  percentage: number;
  baseVolume: number;
  quoteVolume: number;
  high: number;
  low: number;
  open: number;
  timestamp: number;
  receivedAt?: number;
  dataAgeMs?: number;
  stale?: boolean;
}

export interface BinanceKlineData {
  symbol: string;
  timeframe: string;
  timestamp: number;
  closeTime?: number;
  isFinal?: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BinanceBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
  timestamp: number;
}

/**
 * Position data from Binance WebSocket ACCOUNT_UPDATE event
 * 0 weight - Real-time updates vs fetchPositions (5 weight per call)
 */
export interface BinancePositionData {
  symbol: string;          // e.g., "BTCUSDT"
  positionAmt: number;     // Positive = long, negative = short, 0 = no position
  entryPrice: number;
  unrealizedPnl: number;
  marginType: string;      // "cross" or "isolated"
  isolatedWallet: number;  // Isolated margin wallet (if isolated mode)
  side: 'long' | 'short' | 'none';
  timestamp: number;
}

export interface BinanceOrderTradeUpdate {
  userId: string;
  symbol: string; // Binance format, e.g. BTCUSDT
  eventTime: number;
  transactionTime: number;
  executionType: string; // e.g. NEW, TRADE, CANCELED, EXPIRED
  orderStatus: string;   // e.g. NEW, PARTIALLY_FILLED, FILLED, CANCELED
  side: string;          // BUY / SELL
  orderType: string;     // MARKET, STOP_MARKET, TRAILING_STOP_MARKET...
  orderId?: string;
  clientOrderId?: string;
  averagePrice?: number;
  lastFilledQty?: number;
  lastFilledPrice?: number;
  cumulativeFilledQty?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  raw: any;
}

type SymbolRejectionReason = 'format' | 'unknown' | 'cached';

type SymbolValidationResult =
  | { ok: true; cacheSymbol: string }
  | { ok: false; cacheSymbol: string; reason: SymbolRejectionReason };

export type KlineSubscriptionFailureReason =
  | 'invalid_symbol_format'
  | 'unknown_symbol'
  | 'symbol_rejected';

export type KlineSubscriptionResult =
  | { ok: true }
  | { ok: false; reason: KlineSubscriptionFailureReason };

export function toBinanceSymbolId(unified: string): string {
  const base = unified.split(':')[0] || unified;
  return base.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

const LAST_VALID_BID_ASK_TTL_MS = 20_000;
const SNAPSHOT_MIN_INTERVAL_MS = 1_500;
const REST_MIN_INTERVAL_MS = 120;
const WS_HEALTH_GRACE_MS = 15_000;
const MAX_BINANCE_SYMBOL_LENGTH = 32;
export const REST_429_BACKOFF_MS = 7_500;

export const BINANCE_REST_429_BACKOFF_MS = REST_429_BACKOFF_MS;

const REST_FALLBACK_COOLDOWN_MS = Math.max(
  10_000,
  Number.isFinite(Number(process.env.BINANCE_REST_FALLBACK_COOLDOWN_MS))
    ? Number(process.env.BINANCE_REST_FALLBACK_COOLDOWN_MS)
    : 12_000,
);
const REST_FALLBACK_WINDOW_MS = Math.max(
  REST_FALLBACK_COOLDOWN_MS,
  Number.isFinite(Number(process.env.BINANCE_REST_FALLBACK_WINDOW_MS))
    ? Number(process.env.BINANCE_REST_FALLBACK_WINDOW_MS)
    : 60_000,
);
const REST_FALLBACK_GLOBAL_MAX = Math.max(
  1,
  Number.isFinite(Number(process.env.BINANCE_REST_FALLBACK_GLOBAL_MAX))
    ? Number(process.env.BINANCE_REST_FALLBACK_GLOBAL_MAX)
    : 18,
);

const WS_UNHEALTHY_LOG_THROTTLE_MS = 2_000;
const lastWsUnhealthyLogTs = new Map<string, number>();

const restFallbackHistory: number[] = [];
const restFallbackSymbolTs = new Map<string, number>();
const restFallbackInflight = new Map<string, Promise<unknown>>();
const exchangeInfoRestLimiter = createBinanceRestLimiter({ minIntervalMs: 250 });

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface RestLimiterOptions {
  minIntervalMs: number;
  now?: () => number;
}

interface RestLimiter {
  run<T>(task: () => Promise<T> | T): Promise<T>;
  backoff(ms: number): void;
}

export function createBinanceRestLimiter(options?: Partial<RestLimiterOptions>): RestLimiter {
  const minIntervalMs = Math.max(0, options?.minIntervalMs ?? REST_MIN_INTERVAL_MS);
  const nowFn = options?.now ?? Date.now;

  let tail: Promise<void> = Promise.resolve();
  let lastRequestTs = 0;
  let backoffUntilTs = 0;

  return {
    async run<T>(task: () => Promise<T> | T): Promise<T> {
      let release: (() => void) | undefined;
      const next = new Promise<void>(resolve => {
        release = resolve;
      });
      const previous = tail;
      tail = next;

      await previous;

      try {
        const now = nowFn();
        const waitUntil = Math.max(backoffUntilTs, lastRequestTs + minIntervalMs);
        if (waitUntil > now) {
          await sleep(waitUntil - now);
        }
        lastRequestTs = nowFn();
        return await task();
      } finally {
        release?.();
      }
    },
    backoff(ms: number) {
      if (ms <= 0) return;
      const target = nowFn() + ms;
      if (target > backoffUntilTs) {
        backoffUntilTs = target;
      }
    },
  };
}

const bookTickerRestLimiter = createBinanceRestLimiter();

function parseTickerNumber(value: any): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const text = String(value).trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

type BidAskSanitization = {
  skip: boolean;
  needsSnapshot: boolean;
  extra?: Record<string, unknown>;
};

function normalizeRestFallbackKey(symbol: string): string {
  try {
    const normalized = toBinanceSymbolId(symbol);
    if (normalized) return normalized;
  } catch {}
  return symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function pruneRestFallbackHistory(now: number): void {
  while (restFallbackHistory.length && now - restFallbackHistory[0] > REST_FALLBACK_WINDOW_MS) {
    restFallbackHistory.shift();
  }
}

function logRestFallbackSuppressed(event: {
  symbol: string;
  reason?: string;
  mode: 'cooldown' | 'quota';
}): void {
  console.warn(
    JSON.stringify({
      event: 'rest_fallback_suppressed',
      symbol: event.symbol,
      reason: event.reason || null,
      mode: event.mode,
      cooldown_ms: REST_FALLBACK_COOLDOWN_MS,
      window_ms: REST_FALLBACK_WINDOW_MS,
      quota: REST_FALLBACK_GLOBAL_MAX,
      ts: Date.now(),
    }),
  );
}

export async function scheduleBinanceRestFallback<T>(
  symbol: string,
  task: () => Promise<T>,
  options?: { reason?: string; force?: boolean; weight?: number },
): Promise<T | null> {
  // Timestamp drift indicates local lag/clock skew; REST won't fix it and can cause 429 storms.
  // So we hard-suppress REST fallback attempts for this reason unless explicitly forced.
  if (!options?.force && options?.reason === 'ws_timestamp_drift') {
    return null;
  }

  const weight = options?.weight ?? 1;

  const key = normalizeRestFallbackKey(symbol);
  const existing = restFallbackInflight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const now = Date.now();
  if (!options?.force) {
    const lastAttempt = restFallbackSymbolTs.get(key) ?? 0;
    if (now - lastAttempt < REST_FALLBACK_COOLDOWN_MS) {
      logRestFallbackSuppressed({ symbol: key, reason: options?.reason, mode: 'cooldown' });
      return null;
    }

    pruneRestFallbackHistory(now);
    if (restFallbackHistory.length >= REST_FALLBACK_GLOBAL_MAX) {
      logRestFallbackSuppressed({ symbol: key, reason: options?.reason, mode: 'quota' });
      return null;
    }
  }

  restFallbackHistory.push(now);
  restFallbackSymbolTs.set(key, now);

  const promise = (async () => {
    try {
      if (weight > 0) {
        // Route through binanceRestQueue — single gateway for weight tracking + IP ban.
        // Ticker calls (weight=1) go through queue. OHLCV calls pass weight=0
        // because the inner fetchBinanceOhlcv already routes through the queue.
        return await binanceRestQueue.enqueue(task, {
          weight,
          priority: 'low',
          tag: `fallback:${key}:${options?.reason ?? 'unknown'}`,
        });
      }
      // weight=0: inner function handles its own queue routing (e.g. fetchBinanceOhlcv)
      return await task();
    } finally {
      restFallbackInflight.delete(key);
    }
  })();

  restFallbackInflight.set(key, promise);
  return promise;
}

export function adaptBinanceTickerToCcxt(symbol: string, ticker: BinanceTickerData) {
  const ts = Number(ticker.timestamp) || Date.now();
  return {
    symbol,
    timestamp: ts,
    datetime: new Date(ts).toISOString(),
    last: ticker.last,
    bid: ticker.bid,
    ask: ticker.ask,
    open: ticker.open,
    close: ticker.last,
    high: ticker.high,
    low: ticker.low,
    percentage: ticker.percentage,
    baseVolume: Number(ticker.baseVolume),
    quoteVolume: Number(ticker.quoteVolume),
    info: ticker,
  };
}

class BinanceWebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 2000; // base 2 secondes
  private readonly maxReconnectDelayMs = 30_000;
  private pingTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private readonly isTestMode = process.env.UNIT_TEST_MODE === 'true';

  // Cache en mémoire pour les données temps réel
  private tickersCache = new Map<string, BinanceTickerData>();
  private klinesCache = new Map<string, BinanceKlineData[]>();
  private balanceCache = new Map<string, BinanceBalance>();
  // Position cache: key = `${userId}_${symbol}` (e.g., "user123_BTCUSDT")
  private positionCache = new Map<string, BinancePositionData>();
  // Order/trade update cache from ORDER_TRADE_UPDATE (user data stream)
  // Key = `${userId}_${symbol}`
  private orderTradeUpdateCache = new Map<string, BinanceOrderTradeUpdate[]>();
  // Key = `${userId}_${orderId}`
  private orderTradeUpdateByOrderId = new Map<string, BinanceOrderTradeUpdate>();
  // Track which users have had their position cache seeded (to avoid REST fallback)
  private positionCacheSeeded = new Set<string>();
  private lastUpdate = Date.now();
  private lastAcceptedTs = 0;
  private timestampDriftCounters = new Map<string, { count: number; firstTs: number; lastAge: number }>();
  private lastTimestampDriftNotice = new Map<string, number>();

  // Callbacks pour notifier les consumers
  private tickerCallbacks: Array<(ticker: BinanceTickerData) => void> = [];
  private klineCallbacks: Array<(kline: BinanceKlineData) => void> = [];
  
  // User data stream management
  private userDataStreams = new Map<string, { ws: WebSocket | null; listenKey: string; userId: string; keepAliveTimer?: NodeJS.Timeout }>();
  private userDataSubscriptions = new Map<string, Promise<void>>();

  private readonly orderUpdateCacheLimitPerSymbol = 200;
  
  private isConnecting = false;
  private isConnected = false;
  private lastHealthy = false;
  private lastHealthReason: string | null = null;
  private lastValidBidAsk = new Map<string, { bid: number; ask: number; ts: number }>();
  private snapshotCooldown = new Map<string, number>();
  private staleFrameBursts: number[] = [];
  private timestampDriftBurstEvents: number[] = [];
  private forcingReconnect = false;
  private lastForcedReconnectTs = 0;
  private readonly staleBurstWindowMs = 45_000; // Increased from 15s to 45s to reduce jitter
  private readonly staleBurstThreshold = 12;    // Increased from 3 to 12 to tolerate more stale frames
  private readonly staleBurstRatio = 0.8;       // Increased from 0.6 to 0.8 (require 80% stale to trigger)
  private readonly staleBurstAgeThresholdMs = 8_000; // Increased from 4s to 8s
  private readonly timestampDriftBurstWindowMs = 30_000; // Increased from 12s to 30s
  private readonly timestampDriftBurstThreshold = 10;    // Increased from 4 to 10
  private timestampDriftForceAgeMs = 90_000;
  private readonly forcedReconnectCooldownMs = 180_000;  // 3 min cooldown for forced reconnects (was 45s)
  private readonly forcedReconnectDelayMs = 400;
  private serverTimeOffsetMs = 0;
  private serverTimeOffsetSamples: number[] = [];
  private serverTimeSyncTimer: NodeJS.Timeout | null = null;
  private serverTimeSyncInFlight: Promise<void> | null = null;
  
  // Health monitor: periodically check health and trigger reconnect if unhealthy too long
  private healthMonitorTimer: NodeJS.Timeout | null = null;
  private unhealthyStartTs = 0;
  private readonly healthMonitorIntervalMs = 5_000;
  private readonly unhealthyReconnectThresholdMs = 60_000; // Reconnect if unhealthy for 60s
  private consecutiveUnhealthyChecks = 0;
  private readonly maxConsecutiveUnhealthyBeforeReconnect = 12; // ~60s at 5s intervals
  private serverTimeLastSyncMs = 0;
  private lastServerTimeLogMs = 0;
  private readonly serverTimeSyncIntervalMs: number;
  private readonly serverTimeAdjustmentThresholdMs: number;
  private readonly maxServerTimeSamples = 5;

  // Streams actifs
  private activeStreams = new Set<string>();
  private desiredKlineStreams = new Map<string, {
    stream: string;
    symbol: string;
    interval: string;
    lastRequestedAt: number;
    lastSubscribedAt?: number;
    active: boolean;
  }>();
  private klineShards: BinanceKlineShard[] = [];
  private readonly klineReconcileIntervalMs = 15_000;
  private readonly klineSubscriptionTtlMs: number;
  private klineReconcileTimer: NodeJS.Timeout | null = null;
  private readonly maxKlineStreamsPerShard: number;
  private tradableSymbols = new Set<string>();
  private tradableSymbolsReady = false;
  private exchangeInfoRefreshPromise: Promise<void> | null = null;
  private exchangeInfoLastFetchedMs = 0;
  private exchangeInfoLastAttemptMs = 0;
  private readonly exchangeInfoTtlMs = 30 * 60 * 1000;
  private readonly exchangeInfoRetryDelayMs = 15_000;
  private readonly invalidSymbolNoticeIntervalMs = 60_000;
  private invalidSymbolNoticeTs = new Map<string, number>();
  private rejectedSymbols = new Set<string>();
  private readonly shardReconnectSkewMs = 2_000;
  private readonly shardReconnectJitterMs = 700;
  private klineZeroLogTs = new Map<string, number>();
  private readonly klineZeroLogIntervalMs = 60_000;
  private reconnectCallbacks: Array<() => void> = [];
  private hasConnectedBefore = false;

  private readonly endpoints = BINANCE_ENDPOINTS;

  constructor() {
    console.log('📡 Initializing Binance WebSocket Manager...');
    const envLimit = Number(process.env.BINANCE_MAX_KLINE_STREAMS || '30');
    const configuredLimit = Number.isFinite(envLimit) ? envLimit : 30;
    this.maxKlineStreamsPerShard = Math.min(200, Math.max(5, configuredLimit));
    console.log(`📊 Binance WS manager limit: max ${this.maxKlineStreamsPerShard} concurrent kline streams per shard`);
    const envTtlRaw = Number(process.env.BINANCE_KLINE_SUBSCRIPTION_TTL_MS);
    const defaultTtl = 600_000; // 10 minutes
    const minTtl = process.env.UNIT_TEST_MODE === 'true' ? 100 : 60_000;
    this.klineSubscriptionTtlMs = Math.max(minTtl, Number.isFinite(envTtlRaw) && envTtlRaw > 0 ? envTtlRaw : defaultTtl);
    const syncIntervalRaw = Number(process.env.BINANCE_SERVER_TIME_SYNC_INTERVAL_MS);
    const adjustThresholdRaw = Number(process.env.BINANCE_SERVER_TIME_ADJUST_THRESHOLD_MS);
    this.serverTimeSyncIntervalMs = Math.max(
      15_000,
      Number.isFinite(syncIntervalRaw) && syncIntervalRaw > 0 ? syncIntervalRaw : 60_000,
    );
    this.serverTimeAdjustmentThresholdMs = Math.max(
      1_000,
      Number.isFinite(adjustThresholdRaw) && adjustThresholdRaw > 0 ? adjustThresholdRaw : 2_500,
    );
    this.klineReconcileTimer = setInterval(() => {
      try {
        this.reconcileKlineStreams();
      } catch (error) {
        console.error('❌ Failed to reconcile kline subscriptions:', error);
      }
    }, this.klineReconcileIntervalMs);
    this.klineReconcileTimer?.unref?.();

    const cfg = getConfig();
    if (Number.isFinite(cfg.WS_MAX_TIMESTAMP_DRIFT_MS) && cfg.WS_MAX_TIMESTAMP_DRIFT_MS > 0) {
      this.timestampDriftForceAgeMs = Math.max(5_000, cfg.WS_MAX_TIMESTAMP_DRIFT_MS - 1_000);
    }

    // NOTE: refreshServerTimeOffset() and ensureExchangeInfoFresh() are NOT called
    // in the constructor. They fire direct REST calls that bypass binanceRestQueue,
    // and at startup preloadMarkets() already loads exchangeInfo via the queue.
    // Time sync starts after WS connects (startServerTimeSync), and exchangeInfo
    // refreshes on its TTL schedule after the first successful load.
    
    // Start health monitor to auto-reconnect if unhealthy for too long
    if (!this.isTestMode) {
      this.startHealthMonitor();
    }
  }

  /**
   * Health monitoring: checks WebSocket health periodically and triggers reconnect
   * if unhealthy for too long. This prevents the system from being stuck in an
   * unhealthy state without attempting recovery.
   */
  private startHealthMonitor(): void {
    if (this.healthMonitorTimer) {
      return;
    }

    this.healthMonitorTimer = setInterval(() => {
      try {
        this.checkHealthAndReconnect();
      } catch (error) {
        console.error('❌ Health monitor check failed:', error);
      }
    }, this.healthMonitorIntervalMs);
    this.healthMonitorTimer.unref?.();
  }

  private stopHealthMonitor(): void {
    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
    }
  }

  private checkHealthAndReconnect(): void {
    if (this.shuttingDown) {
      return;
    }

    // Not connected at all - let normal reconnect logic handle it
    if (!this.isConnected && !this.isConnecting) {
      this.consecutiveUnhealthyChecks = 0;
      this.unhealthyStartTs = 0;
      return;
    }

    const healthy = this.isHealthy();
    const receiving = this.isConnectedAndReceiving();
    const now = Date.now();

    if (healthy) {
      // Reset counters when healthy
      this.consecutiveUnhealthyChecks = 0;
      this.unhealthyStartTs = 0;
      return;
    }

    // We're unhealthy but still connected
    if (receiving) {
      // Receiving data but marked unhealthy (likely timestamp drift)
      // Be more tolerant - only count if truly stale
      const cacheAge = now - this.lastUpdate;
      if (cacheAge < 15_000) {
        // Data is reasonably fresh, don't count as truly unhealthy
        this.consecutiveUnhealthyChecks = Math.max(0, this.consecutiveUnhealthyChecks - 1);
        return;
      }
    }

    // Track unhealthy duration
    if (this.unhealthyStartTs === 0) {
      this.unhealthyStartTs = now;
    }
    this.consecutiveUnhealthyChecks++;

    const unhealthyDuration = now - this.unhealthyStartTs;

    // Log status periodically (every 6th check = ~30s)
    if (this.consecutiveUnhealthyChecks % 6 === 1) {
      console.warn(`⚠️ WebSocket unhealthy for ${Math.round(unhealthyDuration / 1000)}s (checks: ${this.consecutiveUnhealthyChecks}/${this.maxConsecutiveUnhealthyBeforeReconnect})`);
    }

    // Force reconnect if unhealthy for too long
    if (
      this.consecutiveUnhealthyChecks >= this.maxConsecutiveUnhealthyBeforeReconnect ||
      unhealthyDuration >= this.unhealthyReconnectThresholdMs
    ) {
      console.warn(`🔄 WebSocket unhealthy for ${Math.round(unhealthyDuration / 1000)}s - triggering automatic reconnect`);
      this.consecutiveUnhealthyChecks = 0;
      this.unhealthyStartTs = 0;
      this.forceReconnect('health_monitor_timeout');
    }
  }

  private normalizeStreamSymbol(symbol: string): string {
    return toBinanceSymbolId(symbol).toLowerCase();
  }

  private normalizeCacheSymbol(symbol: string): string {
    return toBinanceSymbolId(symbol);
  }

  private validateBinanceSymbol(symbol: string): SymbolValidationResult {
    const cacheSymbol = this.normalizeCacheSymbol(symbol);

    if (cacheSymbol && this.rejectedSymbols.has(cacheSymbol)) {
      this.noteInvalidSymbol(cacheSymbol, symbol, 'cached');
      return { ok: false, cacheSymbol, reason: 'cached' };
    }

    const formatValid =
      /^[A-Z0-9]{2,}$/.test(cacheSymbol)
      && cacheSymbol.length <= MAX_BINANCE_SYMBOL_LENGTH
      && cacheSymbol.length >= 6;

    if (!formatValid) {
      this.noteInvalidSymbol(cacheSymbol || symbol, symbol, 'format');
      if (cacheSymbol) {
        this.rejectedSymbols.add(cacheSymbol);
      }
      return { ok: false, cacheSymbol, reason: 'format' };
    }

    if (!this.tradableSymbolsReady) {
      this.ensureExchangeInfoFresh();
      return { ok: true, cacheSymbol };
    }

    if (!this.tradableSymbols.has(cacheSymbol)) {
      this.noteInvalidSymbol(cacheSymbol, symbol, 'unknown');
      if (cacheSymbol) {
        this.rejectedSymbols.add(cacheSymbol);
      }
      return { ok: false, cacheSymbol, reason: 'unknown' };
    }

    return { ok: true, cacheSymbol };
  }

  private klineCacheKey(symbol: string, interval: string): string {
    return `${this.normalizeCacheSymbol(symbol)}_${interval}`;
  }

  private enqueueKlineSubscription(symbol: string, interval: string, cacheSymbol: string): void {
    const streamSymbol = this.normalizeStreamSymbol(symbol);
    const stream = `${streamSymbol}@kline_${interval}`;
    const now = Date.now();
    this.pruneStaleKlineSubscriptions(now);

    if (!this.isTestMode) {
      this.ensureExchangeInfoFresh();
    }

    const existing = this.desiredKlineStreams.get(stream);
    if (existing) {
      existing.lastRequestedAt = now;
      existing.symbol = symbol;
      existing.interval = interval;
    } else {
      this.desiredKlineStreams.set(stream, {
        stream,
        symbol,
        interval,
        lastRequestedAt: now,
        active: false,
      });
    }

    this.reconcileKlineStreams();
  }

  private sendSubscription(stream: string, isKline = false): boolean {
    if (!this.ws || !this.isConnected) return false;
    if (this.activeStreams.has(stream)) return true;

    const payload = {
      method: 'SUBSCRIBE',
      params: [stream],
      id: Date.now(),
    };

    try {
      this.ws.send(JSON.stringify(payload));
      this.activeStreams.add(stream);
      console.log(`📡 Subscribed to stream ${stream}`);
      if (isKline) {
        const desired = this.desiredKlineStreams.get(stream);
        if (desired) {
          desired.active = true;
          desired.lastSubscribedAt = Date.now();
        }
      }
      return true;
    } catch (error) {
      console.error(`❌ Failed to subscribe to ${stream}:`, error);
      return false;
    }
  }

  private sendUnsubscribe(stream: string, isKline = false): boolean {
    if (!this.ws || !this.isConnected) return false;

    if (!this.activeStreams.has(stream)) return true;

    const payload = {
      method: 'UNSUBSCRIBE',
      params: [stream],
      id: Date.now(),
    };

    try {
      this.ws.send(JSON.stringify(payload));
      this.activeStreams.delete(stream);
      if (isKline) {
        const desired = this.desiredKlineStreams.get(stream);
        if (desired) {
          desired.active = false;
        }
      }
      console.log(`📴 Unsubscribed from stream ${stream}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to unsubscribe from ${stream}:`, error);
      return false;
    }
  }

  private resubscribeKlines(): void {
    this.reconcileKlineStreams();
  }

  private pruneStaleKlineSubscriptions(now: number): void {
    if (this.klineSubscriptionTtlMs <= 0) return;

    for (const entry of [...this.desiredKlineStreams.values()]) {
      if (now - entry.lastRequestedAt < this.klineSubscriptionTtlMs) continue;

      if (entry.active) {
        this.sendUnsubscribe(entry.stream, true);
      }
      this.desiredKlineStreams.delete(entry.stream);
      console.log(`🧹 Pruned inactive kline stream ${entry.symbol} ${entry.interval}`);
    }
  }

  private reconcileKlineStreams(): void {
    const entries = Array.from(this.desiredKlineStreams.values());
    const validEntries: typeof entries = [];

    for (const entry of entries) {
      if (this.tradableSymbolsReady && !this.isSymbolTradable(entry.symbol)) {
        this.noteInvalidSymbol(this.normalizeCacheSymbol(entry.symbol), entry.symbol, 'unknown');
        this.desiredKlineStreams.delete(entry.stream);
        continue;
      }
      validEntries.push(entry);
    }

    if (!validEntries.length) {
      this.klineShards.forEach(shard => shard.setStreams([]));
      return;
    }

    validEntries.sort((a, b) => b.lastRequestedAt - a.lastRequestedAt);

    const batches: typeof entries[] = [];
    for (const entry of validEntries) {
      let batch = batches[batches.length - 1];
      if (!batch || batch.length >= this.maxKlineStreamsPerShard) {
        batch = [];
        batches.push(batch);
      }
      batch.push(entry);
    }

    this.ensureKlineShardCount(batches.length);

    const assigned = new Set<string>();
    batches.forEach((batch, index) => {
      const streams = batch.map(info => info.stream);
      this.klineShards[index].setStreams(streams);
      for (const info of batch) {
        info.active = true;
        info.lastSubscribedAt = info.lastSubscribedAt ?? Date.now();
        assigned.add(info.stream);
      }
    });

    for (let i = batches.length; i < this.klineShards.length; i++) {
      this.klineShards[i].setStreams([]);
    }

    for (const info of this.desiredKlineStreams.values()) {
      if (!assigned.has(info.stream)) {
        info.active = false;
      }
    }
  }

  private ensureKlineShardCount(target: number): void {
    while (this.klineShards.length < target) {
      const shard = new BinanceKlineShard({
        id: this.klineShards.length,
        manager: this,
        endpoints: this.endpoints,
        maxStreams: this.maxKlineStreamsPerShard,
        reconnectSkewMs: this.shardReconnectSkewMs,
        reconnectJitterMs: this.shardReconnectJitterMs,
      });
      this.klineShards.push(shard);
    }

    if (target === 0) {
      return;
    }
  }

  /**
   * Connecte au WebSocket Binance avec auto-reconnect
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isConnected) {
      console.log('⚠️ WebSocket already connecting or connected');
      return;
    }

    this.isConnecting = true;
    
    try {
      // Multi-stream endpoint Binance
      const wsUrl = this.endpoints.wsMulti;

      console.log(`📡 Connecting to Binance ${MARKET_KIND.toUpperCase()} WebSocket: ${wsUrl}`);
      
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('✅ Binance WebSocket connected');
        const isReconnect = this.hasConnectedBefore;
        this.isConnected = true;
        this.isConnecting = false;
        this.shuttingDown = false;
        this.reconnectAttempts = 0;
        this.activeStreams.clear();
        for (const entry of this.desiredKlineStreams.values()) {
          entry.active = false;
        }
        recordWsReconnect('global');
        this.applyReconnectGrace(Date.now());
        this.startServerTimeSync();

        // Subscribe aux streams par défaut
        this.subscribeToAllTickers();
        this.subscribeToBookTickers();
        this.resubscribeKlines();

        this.hasConnectedBefore = true;

        // Fire reconnect callbacks to backfill candle gaps
        if (isReconnect && this.reconnectCallbacks.length > 0) {
          console.log(`🔄 WebSocket reconnected — triggering ${this.reconnectCallbacks.length} backfill callback(s)`);
          for (const cb of this.reconnectCallbacks) {
            try { cb(); } catch (err) {
              console.error('❌ Reconnect callback error:', err);
            }
          }
        }
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('❌ Failed to parse WebSocket message:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('❌ Binance WebSocket error:', error.message);
        updateWsConnectionState({
          connected: this.isConnected,
          healthy: false,
          reason: `ws_error:${error.message}`,
        });
      });

      this.ws.on('close', () => {
        console.log('🔌 Binance WebSocket closed');
        this.isConnected = false;
        this.isConnecting = false;
        this.ws = null;
        this.activeStreams.clear();
        for (const entry of this.desiredKlineStreams.values()) {
          entry.active = false;
        }
        this.lastHealthy = false;
        this.lastAcceptedTs = 0;
        this.lastHealthReason = 'ws_close';
        updateWsConnectionState({ connected: false, healthy: false, reason: 'ws_close' });
        this.stopServerTimeSync();
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        const wasForced = this.forcingReconnect;
        this.forcingReconnect = false;
        if (!this.shuttingDown) {
          if (wasForced) {
            const timer = setTimeout(() => {
              if (!this.shuttingDown) {
                this.connect().catch(error => {
                  console.error('❌ Forced Binance WS reconnect failed:', error);
                });
              }
            }, this.forcedReconnectDelayMs);
            timer.unref?.();
          } else {
            this.scheduleReconnect();
          }
        }
      });

      // Ping/Pong pour garder la connexion alive
      this.pingTimer = setInterval(() => {
        if (this.ws && this.isConnected) {
          try { this.ws.ping(); } catch {}
        }
      }, 30000); // Ping toutes les 30 secondes

    } catch (error) {
      console.error('❌ Failed to connect to Binance WebSocket:', error);
      this.isConnecting = false;
      updateWsConnectionState({ connected: false, healthy: false, reason: 'ws_connect_error' });
      this.scheduleReconnect();
    }
  }

  /**
   * Reconnexion automatique avec backoff exponentiel
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max reconnect attempts reached. Giving up.');
      return;
    }

    const attempt = this.reconnectAttempts;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, attempt), this.maxReconnectDelayMs);

    console.log(`🔄 Scheduling reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay / 1000)}s...`);

    this.reconnectTimer = setTimeout(() => {
      console.log('🔄 Attempting to reconnect...');
      this.connect();
    }, delay);
  }

  /**
   * Subscribe au stream "All Market Tickers" (!ticker@arr)
   * 0 weight - Remplace fetchTickers (40 weight)
   */
  private subscribeToAllTickers(): void {
    if (!this.ws || !this.isConnected) {
      console.warn('⚠️ Cannot subscribe: WebSocket not connected');
      return;
    }

    const stream = '!ticker@arr';
    
    if (this.activeStreams.has(stream)) {
      console.log(`ℹ️ Already subscribed to ${stream}`);
      return;
    }

    console.log(`📡 Subscribing to all tickers stream...`);
    this.sendSubscription(stream);
  }

  private subscribeToBookTickers(): void {
    if (!this.ws || !this.isConnected) {
      console.warn('⚠️ Cannot subscribe: WebSocket not connected');
      return;
    }
    const stream = '!bookTicker';
    if (this.activeStreams.has(stream)) {
      return;
    }
    console.log('📡 Subscribing to bookTicker stream...');
    this.sendSubscription(stream);
  }

  /**
   * Subscribe à un stream de klines (OHLCV) pour un symbole
   * 0 weight - Remplace fetchOHLCV (2 weight × n appels)
  */
  subscribeToKline(symbol: string, interval: string = '15m'): KlineSubscriptionResult {
    const validation = this.validateBinanceSymbol(symbol);
    if (!validation.ok) {
      const reason: KlineSubscriptionFailureReason =
        validation.reason === 'format'
          ? 'invalid_symbol_format'
          : validation.reason === 'unknown'
            ? 'unknown_symbol'
            : 'symbol_rejected';
      return { ok: false, reason };
    }

    const cacheSymbol = validation.cacheSymbol;
    const key = this.klineCacheKey(cacheSymbol, interval);
    if (!this.klinesCache.has(key)) {
      this.klinesCache.set(key, []);
    }

    this.enqueueKlineSubscription(symbol, interval, cacheSymbol);
    return { ok: true };
  }

  private isSymbolTradable(symbol: string): boolean {
    const cacheSymbol = this.normalizeCacheSymbol(symbol);
    return cacheSymbol.length > 0 && this.tradableSymbols.has(cacheSymbol);
  }

  private noteInvalidSymbol(cacheKey: string, originalSymbol: string, reason: 'format' | 'unknown' | 'cached'): void {
    const key = cacheKey || originalSymbol;
    const now = Date.now();
    const lastLog = this.invalidSymbolNoticeTs.get(key) ?? 0;
    if (now - lastLog >= this.invalidSymbolNoticeIntervalMs) {
      const reasonText =
        reason === 'format'
          ? 'fails symbol format checks'
          : reason === 'cached'
            ? 'previously rejected by Binance'
            : 'not listed in Binance exchangeInfo';
      console.warn(`⚠️ Ignoring invalid Binance symbol for kline subscription: ${originalSymbol} (${reasonText})`);
      this.invalidSymbolNoticeTs.set(key, now);
    }
  }

  private ensureExchangeInfoFresh(options?: { force?: boolean }): void {
    if (this.isTestMode) {
      return;
    }

    const now = Date.now();
    const needsRefresh =
      options?.force
      || !this.tradableSymbolsReady
      || now - this.exchangeInfoLastFetchedMs > this.exchangeInfoTtlMs;

    if (!needsRefresh) {
      return;
    }

    if (this.exchangeInfoRefreshPromise) {
      return;
    }

    if (!options?.force && now - this.exchangeInfoLastAttemptMs < this.exchangeInfoRetryDelayMs) {
      return;
    }

    this.exchangeInfoLastAttemptMs = now;
    this.exchangeInfoRefreshPromise = this.refreshExchangeSymbols()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to refresh Binance exchange symbols: ${message}`);
      })
      .finally(() => {
        this.exchangeInfoRefreshPromise = null;
      });
  }

  private async refreshExchangeSymbols(): Promise<void> {
    // Check IP ban + weight budget before making direct REST call
    if (isIpBanned() || !ipWeightTracker.canMakeCall(40)) return;

    const url = `${this.endpoints.rest}/fapi/v1/exchangeInfo`;
    const response = await exchangeInfoRestLimiter.run(() => fetch(url));
    ipWeightTracker.record(40, 'exchangeInfo:refreshSymbols');

    if (!response.ok) {
      if (response.status === 418 || response.status === 429) {
        // Report ban so the rest of the system knows
        const body = await response.text().catch(() => '');
        const banMatch = body.match(/banned until (\d+)/);
        if (banMatch) {
          const ts = parseInt(banMatch[1], 10);
          if (ts > Date.now()) setIpBan(ts);
        } else {
          setIpBan(Date.now() + 5 * 60 * 1000);
        }
        console.debug('⏳ Exchange info fetch skipped (rate limited) - will retry later');
        return;
      }
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${body}`.trim());
    }

    const payload = await response.json();
    const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [];
    const next = new Set<string>();

    for (const entry of symbols) {
      if (!entry) continue;
      const raw = typeof entry.symbol === 'string' ? entry.symbol.toUpperCase() : '';
      const status = typeof entry.status === 'string' ? entry.status.toUpperCase() : '';
      if (!raw) continue;
      if (status === 'TRADING') {
        next.add(raw);
      }
    }

    if (next.size === 0) {
      throw new Error('exchangeInfo returned no tradable symbols');
    }

    this.tradableSymbols = next;
    this.tradableSymbolsReady = true;
    this.exchangeInfoLastFetchedMs = Date.now();
    this.rejectedSymbols.clear();
    this.invalidSymbolNoticeTs = new Map();
    console.log(`✅ Loaded ${next.size} Binance futures symbols from exchangeInfo`);
  }

  seedExchangeSymbols(symbols: string[]): void {
    const normalized = symbols.map(symbol => this.normalizeCacheSymbol(symbol)).filter(Boolean);
    this.tradableSymbols = new Set(normalized);
    this.tradableSymbolsReady = normalized.length > 0;
    this.rejectedSymbols.clear();
    this.invalidSymbolNoticeTs = new Map();
    // Mark as freshly loaded so ensureExchangeInfoFresh() doesn't immediately trigger a redundant REST refresh
    this.exchangeInfoLastFetchedMs = Date.now();
  }

  /**
   * Handler pour les messages WebSocket
   */
  private handleMessage(message: any): void {
    if (!message) return;

    // Some WS libraries forward the data payload directly (legacy behaviour)
    if (Array.isArray(message)) {
      this.handleAllTickersUpdate(message);
      return;
    }

    // Combined stream payloads (current Binance behaviour)
    if (message.stream && message.data !== undefined) {
      const { stream, data } = message;

      if (Array.isArray(data)) {
        // Binance futures sends all-ticker updates on !ticker@arr (miniTicker format)
        if (stream === '!ticker@arr' || stream === '!miniTicker@arr') {
          this.handleAllTickersUpdate(data);
          return;
        }
      }

      if (stream === '!bookTicker' && data) {
        this.handleBookTickerUpdate(data);
        return;
      }

      if (typeof stream === 'string' && stream.includes('@kline_')) {
        this.handleKlineUpdate(stream, data);
        return;
      }
    }

    // Result de subscription
    if (message.result === null && message.id) {
      // Subscription confirmée
      return;
    }
  }

  onShardMessage(stream: string, data: any): void {
    this.handleKlineUpdate(stream, data);
  }

  isShutdownRequested(): boolean {
    return this.shuttingDown;
  }

  getKlineShardSizes(): number[] {
    return this.klineShards.map(shard => shard.getDesiredStreamCount());
  }

  getKlineShardSnapshot(): string[][] {
    return this.klineShards.map(shard => shard.getDesiredStreams());
  }

  /**
   * Update tous les tickers depuis le stream !ticker@arr
   */
  private handleAllTickersUpdate(tickers: any[]): void {
    const receivedTs = Date.now();
    let acceptedCount = 0;
    let processedCount = 0;
    let staleCount = 0;
    let maxStaleAge = 0;
    let maxObservedTimestampAge = 0;

    for (const ticker of tickers) {
      const rawSymbol = String(ticker?.s || '').trim();
      if (!rawSymbol) continue;

      const bidRaw = parseTickerNumber(ticker.b ?? ticker.B ?? ticker.bidPrice ?? ticker.BidPrice);
      const askRaw = parseTickerNumber(ticker.a ?? ticker.A ?? ticker.askPrice ?? ticker.AskPrice);
      const lastRaw = parseTickerNumber(ticker.c ?? ticker.C ?? ticker.lastPrice ?? ticker.price);
      const openRaw = parseTickerNumber(ticker.o ?? ticker.O ?? ticker.openPrice);
      const highRaw = parseTickerNumber(ticker.h ?? ticker.H ?? ticker.highPrice);
      const lowRaw = parseTickerNumber(ticker.l ?? ticker.L ?? ticker.lowPrice);
      const baseVolumeRaw = parseTickerNumber(ticker.v ?? ticker.V ?? ticker.volume);
      const quoteVolumeRaw = parseTickerNumber(ticker.q ?? ticker.Q ?? ticker.quoteVolume);
      const percentageRaw = parseTickerNumber(ticker.P ?? ticker.p ?? ticker.priceChangePercent);
      const timestampRaw = parseTickerNumber(ticker.E ?? ticker.eventTime ?? ticker.closeTime);

      const originalTimestamp = Number.isFinite(timestampRaw) ? Number(timestampRaw) : receivedTs;
      const rawTimestampAge = Math.max(0, receivedTs - originalTimestamp);
      if (rawTimestampAge > maxObservedTimestampAge) {
        maxObservedTimestampAge = rawTimestampAge;
      }
      const adjustedTimestamp = this.adjustFrameTimestamp(originalTimestamp, receivedTs);
      const clockAdjustmentMs = Math.round(adjustedTimestamp - originalTimestamp);

      const tickerData: BinanceTickerData = {
        symbol: rawSymbol,
        last: lastRaw ?? NaN,
        bid: bidRaw ?? NaN,
        ask: askRaw ?? NaN,
        percentage: percentageRaw ?? NaN,
        baseVolume: baseVolumeRaw ?? NaN,
        quoteVolume: quoteVolumeRaw ?? NaN,
        high: highRaw ?? NaN,
        low: lowRaw ?? NaN,
        open: openRaw ?? NaN,
        timestamp: adjustedTimestamp,
      };

      const sanitization = this.sanitizeBidAsk(rawSymbol, tickerData, receivedTs);
      let frameExtra = sanitization.extra ? { ...sanitization.extra } : undefined;

      if (clockAdjustmentMs !== 0 && Number.isFinite(this.serverTimeOffsetMs)) {
        frameExtra = frameExtra ?? {};
        frameExtra.clockOffsetAppliedMs = clockAdjustmentMs;
        frameExtra.serverTimeOffsetMs = Math.round(this.serverTimeOffsetMs);
      }

      if (sanitization.needsSnapshot) {
        this.scheduleBookTickerRefresh(rawSymbol);
      }

      if (sanitization.skip) {
        recordMarketFrame({
          symbol: rawSymbol,
          displaySymbol: rawSymbol,
          source: 'WS',
          status: 'stale',
          ruleId: 'non_positive_bid',
          receivedTs,
          eventTs: receivedTs,
          dataAgeMs: 0,
          expectedSymbolId: rawSymbol,
          rawFrame: tickerData,
          extra: frameExtra ? { recovery: 'snapshot_requested', ...frameExtra } : { recovery: 'snapshot_requested' },
        });
        continue;
      }

      const validation = evaluateTickerFrame({
        symbol: rawSymbol,
        frame: tickerData,
        source: 'WS',
        receivedAt: receivedTs,
        expectedSymbolId: rawSymbol,
      });

      processedCount += 1;
      if (validation.status === 'stale') {
        staleCount += 1;
        if (validation.dataAgeMs && validation.dataAgeMs > maxStaleAge) {
          maxStaleAge = validation.dataAgeMs;
        }
        const reason = validation.ruleId || 'stale';
        setFallbackState(rawSymbol, true, `ws_validation_${reason}`, { increment: false });

        // Timestamp drift typically indicates local event-loop lag or clock skew.
        // Triggering REST fallbacks per symbol can create bursts (and 429s) without improving data quality.
        // We rely on server-time resync + reconnect logic instead.
        if (reason !== 'timestamp_drift') {
          recordRestFallback(rawSymbol, `ws_${reason}`);
          this.scheduleBookTickerRefresh(rawSymbol);
        }
      }

      recordMarketFrame({
        symbol: rawSymbol,
        displaySymbol: rawSymbol,
        source: 'WS',
        status: validation.status,
        ruleId: validation.ruleId,
        receivedTs,
        eventTs: validation.timestamp,
        dataAgeMs: validation.dataAgeMs,
        expectedSymbolId: validation.expectedSymbolId,
        rawFrame: tickerData,
        extra: frameExtra,
      });

      if (validation.status === 'rejected') {
        this.tickersCache.delete(rawSymbol);
        continue;
      }

      tickerData.receivedAt = receivedTs;
      tickerData.dataAgeMs = validation.dataAgeMs;
      tickerData.stale = validation.status === 'stale';
      this.tickersCache.set(rawSymbol, tickerData);

      if (validation.status !== 'accepted') {
        if (validation.ruleId === 'timestamp_drift') {
          this.noteTimestampDrift(rawSymbol, receivedTs, validation.dataAgeMs ?? 0);
        }
        continue;
      }

      this.clearTimestampDrift(rawSymbol);
      setFallbackState(rawSymbol, false);

      acceptedCount += 1;
      for (const cb of this.tickerCallbacks) {
        try {
          cb(tickerData);
        } catch (error) {
          console.error('Error in ticker callback:', error);
        }
      }
    }

    if (acceptedCount > 0) {
      this.lastAcceptedTs = receivedTs;
    }

    if (processedCount > 0) {
      this.considerServerTimeResync(maxObservedTimestampAge, receivedTs);
    }

    this.lastUpdate = receivedTs;
    this.evaluateStaleFrameHealth({
      processedCount,
      staleCount,
      maxStaleAge,
      receivedTs,
    });

    const lastAcceptAge = this.lastAcceptedTs > 0 ? receivedTs - this.lastAcceptedTs : Number.POSITIVE_INFINITY;
    const withinGrace = this.lastAcceptedTs > 0 && lastAcceptAge <= WS_HEALTH_GRACE_MS;
    const nextHealthy = acceptedCount > 0 || withinGrace;
    const reason = acceptedCount > 0
      ? 'ws_frames_accepted'
      : withinGrace
        ? 'ws_recent_accept'
        : 'ws_no_recent_accept';

    if (nextHealthy !== this.lastHealthy || reason !== this.lastHealthReason) {
      this.lastHealthy = nextHealthy;
      this.lastHealthReason = reason;
      updateWsConnectionState({
        connected: this.isConnected,
        healthy: nextHealthy,
        reason,
      });
    }
    
    // Log stats périodiquement
    if (receivedTs % 60000 < 5000) { // ~toutes les minutes
      console.log(`📊 WebSocket cache: ${this.tickersCache.size} tickers, updated ${new Date(this.lastUpdate).toISOString()}`);
    }
  }

  private evaluateStaleFrameHealth(params: { processedCount: number; staleCount: number; maxStaleAge: number; receivedTs: number }): void {
    const { processedCount, staleCount, maxStaleAge, receivedTs } = params;
    if (processedCount <= 0) {
      this.pruneStaleFrameBursts(receivedTs);
      return;
    }

    this.pruneStaleFrameBursts(receivedTs);
    const ratio = staleCount / processedCount;

    if (ratio >= this.staleBurstRatio && maxStaleAge >= this.staleBurstAgeThresholdMs) {
      this.staleFrameBursts.push(receivedTs);
      if (this.staleFrameBursts.length >= this.staleBurstThreshold) {
        console.warn(
          `⚠️ WS stale frame burst detected: ratio ${(ratio * 100).toFixed(1)}% maxAge ${maxStaleAge}ms — forcing reconnect`,
        );
        this.forceReconnect('stale_frames');
      }
    } else if (ratio === 0) {
      this.staleFrameBursts.length = 0;
    }
  }

  private pruneStaleFrameBursts(now: number): void {
    while (this.staleFrameBursts.length && now - this.staleFrameBursts[0] > this.staleBurstWindowMs) {
      this.staleFrameBursts.shift();
    }
  }

  private adjustFrameTimestamp(frameTimestamp: number, receivedTs: number): number {
    const timestamp = Number(frameTimestamp);
    if (!Number.isFinite(timestamp)) {
      return receivedTs;
    }

    const offset = this.serverTimeOffsetMs;
    if (!Number.isFinite(offset)) {
      return timestamp;
    }

    const offsetMagnitude = Math.abs(offset);
    if (offsetMagnitude < this.serverTimeAdjustmentThresholdMs) {
      return timestamp;
    }

    const adjusted = timestamp - offset;
    const originalDiff = Math.abs(receivedTs - timestamp);
    const adjustedDiff = Math.abs(receivedTs - adjusted);

    if (adjustedDiff + 200 < originalDiff) {
      return adjusted;
    }

    return timestamp;
  }

  private considerServerTimeResync(observedAgeMs: number, receivedTs: number): void {
    if (this.isTestMode) return;
    if (observedAgeMs <= this.serverTimeAdjustmentThresholdMs) {
      return;
    }

    const offsetMagnitude = Math.abs(this.serverTimeOffsetMs);
    if (
      offsetMagnitude >= this.serverTimeAdjustmentThresholdMs
      && Math.abs(offsetMagnitude - observedAgeMs) <= 1_500
    ) {
      return;
    }

    if (this.serverTimeSyncInFlight) {
      return;
    }

    if (receivedTs - this.serverTimeLastSyncMs < 5_000) {
      return;
    }

    void this.refreshServerTimeOffset();
  }

  private startServerTimeSync(): void {
    if (this.isTestMode || this.serverTimeSyncTimer) {
      return;
    }

    this.serverTimeSyncTimer = setInterval(() => {
      void this.refreshServerTimeOffset();
    }, this.serverTimeSyncIntervalMs);
    this.serverTimeSyncTimer.unref?.();

    void this.refreshServerTimeOffset();
  }

  private stopServerTimeSync(): void {
    if (this.serverTimeSyncTimer) {
      clearInterval(this.serverTimeSyncTimer);
      this.serverTimeSyncTimer = null;
    }
  }

  private async refreshServerTimeOffset(): Promise<void> {
    if (this.isTestMode) {
      return;
    }

    if (this.serverTimeSyncInFlight) {
      await this.serverTimeSyncInFlight;
      return;
    }

    const task = (async () => {
      try {
        // Check IP ban + weight budget before making direct REST call
        if (isIpBanned() || !ipWeightTracker.canMakeCall(1)) return;

        const start = Date.now();
        const response = await fetch(`${this.endpoints.rest}/fapi/v1/time`);
        ipWeightTracker.record(1, 'time:healthCheck');
        if (!response.ok) {
          if (response.status === 418 || response.status === 429) {
            // Report ban so the rest of the system knows
            const body = await response.text().catch(() => '');
            const banMatch = body.match(/banned until (\d+)/);
            if (banMatch) {
              const ts = parseInt(banMatch[1], 10);
              if (ts > Date.now()) setIpBan(ts);
            } else {
              setIpBan(Date.now() + 5 * 60 * 1000); // fallback 5 min
            }
            return;
          }
          throw new Error(`HTTP ${response.status}`);
        }
        const payload: any = await response.json();
        const serverTimeValue = Number(
          payload?.serverTime
          ?? payload?.server_time
          ?? payload?.serverTimeMs
          ?? payload?.time,
        );
        if (!Number.isFinite(serverTimeValue)) {
          throw new Error('Invalid server time response');
        }

        const end = Date.now();
        const latency = (end - start) / 2;
        const estimatedLocalNow = start + latency;
        const offset = serverTimeValue - estimatedLocalNow;
        this.recordServerTimeOffset(offset);
        this.serverTimeLastSyncMs = Date.now();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // V5.24: Don't spam logs when banned - only log non-418 errors
        if (!message.includes('418') && !message.includes('429')) {
          console.warn(`⚠️ Failed to sync Binance server time: ${message}`);
        }
      }
    })();

    this.serverTimeSyncInFlight = task;
    try {
      await task;
    } finally {
      this.serverTimeSyncInFlight = null;
    }
  }

  private recordServerTimeOffset(offset: number): void {
    if (!Number.isFinite(offset)) {
      return;
    }

    this.serverTimeOffsetSamples.push(offset);
    if (this.serverTimeOffsetSamples.length > this.maxServerTimeSamples) {
      this.serverTimeOffsetSamples.shift();
    }

    const sorted = [...this.serverTimeOffsetSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const previous = this.serverTimeOffsetMs;
    this.serverTimeOffsetMs = median;

    const now = Date.now();
    if (!Number.isFinite(previous) || Math.abs(previous - this.serverTimeOffsetMs) >= 500) {
      if (now - this.lastServerTimeLogMs >= 30_000) {
        console.log(`🕒 Binance server clock offset ${Math.round(this.serverTimeOffsetMs)}ms`);
        this.lastServerTimeLogMs = now;
      }
    }
  }

  setServerTimeOffsetForTest(offsetMs: number): void {
    if (!this.isTestMode) {
      return;
    }
    this.serverTimeOffsetMs = offsetMs;
    this.serverTimeOffsetSamples = [offsetMs];
  }

  private handleBookTickerUpdate(payload: any): void {
    const receivedTs = Date.now();
    const updates = Array.isArray(payload) ? payload : [payload];
    for (const item of updates) {
      const rawSymbol = String(item?.s || '').trim();
      if (!rawSymbol) continue;
      const bid = parseTickerNumber(item?.b ?? item?.bidPrice);
      const ask = parseTickerNumber(item?.a ?? item?.askPrice);
      if (!hasPositive(bid) || !hasPositive(ask)) continue;
      const cacheSymbol = this.normalizeCacheSymbol(rawSymbol);
      this.lastValidBidAsk.set(cacheSymbol, { bid: bid!, ask: ask!, ts: receivedTs });
      const cached = this.tickersCache.get(cacheSymbol);
      if (cached) {
        cached.bid = bid!;
        cached.ask = ask!;
        cached.timestamp = Number.isFinite(Number(item?.T ?? item?.E)) ? Number(item.T ?? item.E) : receivedTs;
        cached.receivedAt = receivedTs;
        cached.stale = false;
        this.tickersCache.set(cacheSymbol, cached);
      }
    }
  }

  private sanitizeBidAsk(symbol: string, ticker: BinanceTickerData, receivedTs: number): BidAskSanitization {
    const extra: Record<string, unknown> = {};
    let needsSnapshot = false;
    let skip = false;
    const prev = this.lastValidBidAsk.get(symbol);
    const canReusePrev = prev && receivedTs - prev.ts <= LAST_VALID_BID_ASK_TTL_MS;

    const lastPrice = hasPositive(ticker.last) ? ticker.last : undefined;
    let bid = hasPositive(ticker.bid) ? ticker.bid : undefined;
    let ask = hasPositive(ticker.ask) ? ticker.ask : undefined;

    if (!bid && !ask && canReusePrev) {
      bid = prev!.bid;
      ask = prev!.ask;
      extra.recoveredFrom = 'previous_bid_ask';
    } else {
      if (!bid && canReusePrev) {
        bid = prev!.bid;
        extra.bidFallback = 'previous';
      }
      if (!ask && canReusePrev) {
        ask = prev!.ask;
        extra.askFallback = 'previous';
      }
    }

    const spreadHint = prev ? Math.max(prev.ask - prev.bid, (prev.bid + prev.ask) * 0.0004) : (lastPrice ? lastPrice * 0.001 : 0.0001);

    if (!bid && lastPrice) {
      const derived = ask ? Math.min(ask * 0.999, lastPrice) : lastPrice - spreadHint / 2;
      if (derived > 0) {
        bid = derived;
        extra.bidFallback = extra.bidFallback || 'derived_from_last';
      }
    }
    if (!ask && lastPrice) {
      const derived = bid ? Math.max(bid * 1.001, lastPrice) : lastPrice + spreadHint / 2;
      if (derived > 0) {
        ask = derived;
        extra.askFallback = extra.askFallback || 'derived_from_last';
      }
    }

    if (bid && ask && bid > ask) {
      const avg = lastPrice ?? (prev ? (prev.bid + prev.ask) / 2 : bid);
      const spread = Math.max(spreadHint, avg * 0.0005);
      bid = Math.max(1e-12, avg - spread / 2);
      ask = avg + spread / 2;
      extra.bidAskAdjusted = 'bid_gt_ask';
    }

    const bidValid = hasPositive(bid);
    const askValid = hasPositive(ask);

    if (bidValid && askValid) {
      ticker.bid = bid!;
      ticker.ask = ask!;
      this.lastValidBidAsk.set(symbol, { bid: bid!, ask: ask!, ts: receivedTs });
    } else {
      needsSnapshot = true;
      skip = true;
      extra.sanitization_failed = {
        hasBid: bidValid,
        hasAsk: askValid,
        hadPrev: Boolean(prev),
        lastPrice,
      };
    }

    return {
      skip,
      needsSnapshot,
      extra: Object.keys(extra).length ? extra : undefined,
    };
  }

  private noteTimestampDrift(symbol: string, receivedTs: number, ageMs: number): void {
    const windowMs = 30_000;
    const threshold = 5;
    const stats = this.timestampDriftCounters.get(symbol);
    let count = 1;
    let firstTs = receivedTs;
    if (stats && receivedTs - stats.firstTs <= windowMs) {
      count = stats.count + 1;
      firstTs = stats.firstTs;
    }
    const nextStats = { count, firstTs, lastAge: ageMs };
    this.timestampDriftCounters.set(symbol, nextStats);

    if (nextStats.count >= threshold) {
      const lastNotified = this.lastTimestampDriftNotice.get(symbol) ?? 0;
      if (receivedTs - lastNotified >= 5_000) {
        console.warn(
          `⚠️ WS timestamp drift for ${symbol}: age ${ageMs}ms (count ${nextStats.count}) — suppressing REST fallback, will resync/reconnect if persistent`,
        );
        this.lastTimestampDriftNotice.set(symbol, receivedTs);
        setFallbackState(symbol, true, 'ws_timestamp_drift', { increment: nextStats.count === threshold });

        // Register drift bursts to trigger reconnect when drift is severe/persistent.
        // (We avoid REST snapshots here to prevent 429 storms; drift is not fixed by REST.)
        this.registerTimestampDriftBurst(receivedTs, ageMs);
      }
    }
  }

  private registerTimestampDriftBurst(receivedTs: number, ageMs: number): void {
    if (ageMs < this.timestampDriftForceAgeMs) {
      return;
    }
    this.pruneTimestampDriftBursts(receivedTs);
    this.timestampDriftBurstEvents.push(receivedTs);
    if (this.timestampDriftBurstEvents.length >= this.timestampDriftBurstThreshold) {
      console.warn(`⚠️ WS timestamp drift burst detected (age ${ageMs}ms) — forcing reconnect`);
      this.forceReconnect('timestamp_drift');
    }
  }

  private pruneTimestampDriftBursts(now: number): void {
    while (this.timestampDriftBurstEvents.length && now - this.timestampDriftBurstEvents[0] > this.timestampDriftBurstWindowMs) {
      this.timestampDriftBurstEvents.shift();
    }
  }

  private applyReconnectGrace(now: number): void {
    const hasSnapshot = this.tickersCache.size > 0;
    if (hasSnapshot) {
      this.lastAcceptedTs = now;
      this.lastUpdate = now;
      this.lastHealthy = true;
      this.lastHealthReason = 'ws_open_grace';
      updateWsConnectionState({ connected: true, healthy: true, reason: 'ws_open_grace' });
    } else {
      this.lastAcceptedTs = 0;
      this.lastHealthy = false;
      this.lastHealthReason = 'ws_open';
      updateWsConnectionState({ connected: true, healthy: false, reason: 'ws_open' });
    }
  }

  private clearTimestampDrift(symbol: string): void {
    if (this.timestampDriftCounters.has(symbol)) {
      this.timestampDriftCounters.delete(symbol);
    }
    if (this.lastTimestampDriftNotice.has(symbol)) {
      this.lastTimestampDriftNotice.delete(symbol);
    }
  }

  private forceReconnect(reason: string): void {
    const now = Date.now();
    if (now - this.lastForcedReconnectTs < this.forcedReconnectCooldownMs) {
      return;
    }

    this.lastForcedReconnectTs = now;
    const socket = this.ws;
    const hasSocket = Boolean(socket);
    this.forcingReconnect = hasSocket;
    this.staleFrameBursts = [];
    this.timestampDriftBurstEvents = [];
    console.warn(`🔄 Forcing Binance WebSocket reconnect due to ${reason} (staleThreshold=${this.staleBurstThreshold}, driftThreshold=${this.timestampDriftBurstThreshold})`);

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.lastHealthy = false;
    this.lastHealthReason = `ws_force_reconnect:${reason}`;
    updateWsConnectionState({ connected: false, healthy: false, reason: this.lastHealthReason });
    this.reconnectAttempts = 0;

    this.forceReconnectKlineShards(reason);

    if (!hasSocket) {
      if (!this.isConnecting && !this.shuttingDown) {
        const timer = setTimeout(() => {
          if (!this.shuttingDown) {
            this.connect().catch(error => {
              console.error('❌ Forced Binance WS reconnect failed:', error);
            });
          }
        }, this.forcedReconnectDelayMs);
        timer.unref?.();
      }
      this.forcingReconnect = false;
      return;
    }

    if (socket) {
      try {
        socket.terminate();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('❌ Failed to terminate Binance WS during forced reconnect:', message);
      }
      this.ws = null;
    }
  }

  private forceReconnectKlineShards(reason: string): void {
    if (!this.klineShards.length) {
      return;
    }
    for (const shard of this.klineShards) {
      try {
        shard.forceReconnect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to force reconnect kline shard due to ${reason}:`, message);
      }
    }
  }

  private scheduleBookTickerRefresh(symbol: string): void {
    try {
      const last = this.snapshotCooldown.get(symbol) || 0;
      if (Date.now() - last < SNAPSHOT_MIN_INTERVAL_MS) return;
      this.snapshotCooldown.set(symbol, Date.now());
      void this.fetchBookTickerSnapshot(symbol);
    } catch {}
  }

  private async fetchBookTickerSnapshot(symbol: string): Promise<void> {
    try {
      if (!ipWeightTracker.canMakeCall(2)) return;
      const url = `${BINANCE_ENDPOINTS.rest}/fapi/v1/ticker/bookTicker?symbol=${symbol}`;
      const response = await bookTickerRestLimiter.run(() => fetch(url));
      ipWeightTracker.record(2, `bookTicker:snapshot:${symbol}`);
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.max(REST_429_BACKOFF_MS, retryAfter * 1_000)
          : REST_429_BACKOFF_MS;
        bookTickerRestLimiter.backoff(backoffMs);
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP 429 ${text || ''}`.trim());
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload: any = await response.json();
      const bid = parseTickerNumber(payload?.bidPrice);
      const ask = parseTickerNumber(payload?.askPrice);
      if (!hasPositive(bid) || !hasPositive(ask)) {
        return;
      }
      const cacheSymbol = this.normalizeCacheSymbol(symbol);
      const cached = this.tickersCache.get(cacheSymbol);
      const now = Date.now();
      if (cached) {
        cached.bid = bid!;
        cached.ask = ask!;
        cached.timestamp = Number.isFinite(Number(payload?.time)) ? Number(payload.time) : now;
        cached.receivedAt = now;
        cached.stale = false;
        this.tickersCache.set(cacheSymbol, cached);
      } else {
        this.tickersCache.set(cacheSymbol, {
          symbol,
          last: hasPositive(parseTickerNumber(payload?.lastPrice)) ? Number(payload.lastPrice) : bid!,
          bid: bid!,
          ask: ask!,
          percentage: NaN,
          baseVolume: NaN,
          quoteVolume: NaN,
          high: NaN,
          low: NaN,
          open: NaN,
          timestamp: now,
          receivedAt: now,
          dataAgeMs: 0,
          stale: false,
        });
      }
      this.lastValidBidAsk.set(cacheSymbol, { bid: bid!, ask: ask!, ts: now });
      recordMarketFrame({
        symbol,
        displaySymbol: symbol,
        source: 'REST',
        status: 'accepted',
        ruleId: undefined,
        receivedTs: now,
        eventTs: now,
        dataAgeMs: 0,
        expectedSymbolId: symbol,
        rawFrame: { bid, ask },
        extra: { snapshot: 'bookTicker_recovery' },
      });
    } catch (error) {
      if (error instanceof Error && /429|too many requests/i.test(error.message)) {
        bookTickerRestLimiter.backoff(REST_429_BACKOFF_MS);
      }
      console.warn(`⚠️ Failed to refresh bookTicker snapshot for ${symbol}:`, error);
    }
  }

  /**
   * Update kline depuis le stream
   */
  private handleKlineUpdate(stream: string, data: any): void {
    const k = data.k;
    
    const klineData: BinanceKlineData = {
      symbol: this.normalizeCacheSymbol(data.s),
      timeframe: k.i,
      timestamp: k.t,
      closeTime: Number.isFinite(Number(k.T)) ? Number(k.T) : undefined,
      isFinal: Boolean(k.x),
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
    };

    const key = this.klineCacheKey(klineData.symbol, klineData.timeframe);
    
    if (!this.klinesCache.has(key)) {
      this.klinesCache.set(key, []);
    }
    
    const cache = this.klinesCache.get(key)!;
    const issues: string[] = [];
    const ohlc = [klineData.open, klineData.high, klineData.low, klineData.close];
    const anyNonFiniteOhlc = ohlc.some((value) => !Number.isFinite(value));
    const allZeroOhlc = ohlc.every((value) => Number.isFinite(value) && value === 0);
    if (anyNonFiniteOhlc) {
      issues.push('non_finite_ohlc');
    }
    if (allZeroOhlc) {
      issues.push('ohlc_all_zero');
    }
    if (!Number.isFinite(klineData.volume)) {
      issues.push('volume_non_finite');
    } else if (klineData.volume === 0) {
      issues.push('volume_zero');
    }

    if (issues.length) {
      const now = Date.now();
      const lastLog = this.klineZeroLogTs.get(key) || 0;
      if (now - lastLog >= this.klineZeroLogIntervalMs) {
        this.klineZeroLogTs.set(key, now);
        console.warn('[WS][KLINE_ANOMALY]', {
          stream,
          symbol: klineData.symbol,
          timeframe: klineData.timeframe,
          timestamp: klineData.timestamp,
          issues,
          raw: {
            open: k.o,
            high: k.h,
            low: k.l,
            close: k.c,
            volume: k.v,
            isFinal: Boolean(k.x),
            startTime: k.t,
            closeTime: k.T,
          },
          cacheSize: cache.length,
        });
      }
    }
    
    // Ajoute ou update la dernière candle
    const lastCandle = cache[cache.length - 1];
    if (lastCandle && lastCandle.timestamp === klineData.timestamp) {
      cache[cache.length - 1] = klineData;
    } else {
      cache.push(klineData);
      // Garde max 500 candles en cache
      if (cache.length > 500) {
        cache.shift();
      }
    }

    // Notify callbacks
    this.klineCallbacks.forEach(cb => {
      try {
        cb(klineData);
      } catch (error) {
        console.error('Error in kline callback:', error);
      }
    });
  }

  /**
   * Récupère un ticker depuis le cache WebSocket
   * 0 weight vs fetchTicker (2 weight)
   */
  getTicker(symbol: string): BinanceTickerData | null {
    // Format Binance: BTCUSDT (pas de slash, no suffix)
    const binanceSymbol = this.normalizeCacheSymbol(symbol);
    return this.tickersCache.get(binanceSymbol) || null;
  }

  /**
   * Récupère tous les tickers depuis le cache
   * 0 weight vs fetchTickers (40 weight) 🚨
   */
  getAllTickers(): Map<string, BinanceTickerData> {
    return new Map(this.tickersCache);
  }

  /**
   * Récupère les klines depuis le cache
   * 0 weight vs fetchOHLCV (2 weight)
   */
  getKlines(symbol: string, interval: string = '15m'): BinanceKlineData[] | null {
    const key = this.klineCacheKey(symbol, interval);
    return this.klinesCache.get(key) || null;
  }

  /**
   * Subscribe à des updates ticker
   */
  onTicker(callback: (ticker: BinanceTickerData) => void): void {
    this.tickerCallbacks.push(callback);
  }

  /**
   * Subscribe à des updates kline
   */
  onKline(callback: (kline: BinanceKlineData) => void): void {
    this.klineCallbacks.push(callback);
  }

  /**
   * Register a callback to fire after WebSocket reconnects (not on first connect).
   * Used to trigger REST backfill for candle gaps.
   */
  onReconnect(callback: () => void): void {
    this.reconnectCallbacks.push(callback);
  }

  /**
   * Subscribe to FINAL kline updates only (when candle closes).
   * Returns an unsubscribe function.
   * Used by agents to trigger immediate tick when candle closes (~1s latency vs 8s polling).
   */
  onFinalKline(callback: (kline: BinanceKlineData) => void): () => void {
    const wrapper = (kline: BinanceKlineData) => {
      if (kline.isFinal) {
        callback(kline);
      }
    };
    this.klineCallbacks.push(wrapper);
    return () => {
      const idx = this.klineCallbacks.indexOf(wrapper);
      if (idx !== -1) {
        this.klineCallbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Check si le WebSocket est connecté et le cache est frais.
   * This is a "strict" health check - returns true only if we have recent accepted frames.
   * For a more lenient check (connected + has data), use isConnectedAndReceiving().
   */
  isHealthy(): boolean {
    if (!this.isConnected) return false;
    if (this.tickersCache.size === 0) return false;

    const now = Date.now();
    const cacheAge = now - this.lastUpdate;
    // Increased from 10s to 20s to be more tolerant of temporary delays
    if (cacheAge >= 20_000) return false;

    if (this.lastAcceptedTs <= 0) return false;

    const sinceLastAccept = now - this.lastAcceptedTs;
    // Increased grace period from 15s to 30s for more stability
    // This allows for temporary timestamp drift without marking as unhealthy
    if (sinceLastAccept > 30_000) return false;

    return true;
  }

  /**
   * Lenient health check: returns true if connected and receiving data (even if stale).
   * Use this for realtime exit monitoring to avoid false positives during timestamp drift.
   */
  isConnectedAndReceiving(): boolean {
    if (!this.isConnected) return false;
    if (this.tickersCache.size === 0) return false;

    const now = Date.now();
    const cacheAge = now - this.lastUpdate;
    // Returns true if we've received ANY data in the last 30s (even if marked stale)
    return cacheAge < 30_000;
  }

  /**
   * Get detailed health status for debugging
   */
  getHealthStatus(): { 
    isConnected: boolean; 
    tickerCount: number; 
    lastUpdateAge: number; 
    lastAcceptAge: number;
    isHealthy: boolean;
    isReceiving: boolean;
  } {
    const now = Date.now();
    return {
      isConnected: this.isConnected,
      tickerCount: this.tickersCache.size,
      lastUpdateAge: now - this.lastUpdate,
      lastAcceptAge: this.lastAcceptedTs > 0 ? now - this.lastAcceptedTs : -1,
      isHealthy: this.isHealthy(),
      isReceiving: this.isConnectedAndReceiving(),
    };
  }

  /**
   * Ferme proprement le WebSocket
   */
  close(): void {
    console.log('🔌 Closing Binance WebSocket...');
    this.shuttingDown = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.klineReconcileTimer) {
      clearInterval(this.klineReconcileTimer);
      this.klineReconcileTimer = null;
    }
    
    // Stop health monitor
    this.stopHealthMonitor();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.lastHealthy = false;
    this.lastAcceptedTs = 0;
    this.consecutiveUnhealthyChecks = 0;
    this.unhealthyStartTs = 0;
    this.lastHealthReason = 'manual_close';
    this.activeStreams.clear();
    this.desiredKlineStreams.clear();
    this.tickersCache.clear();
    this.klinesCache.clear();
    for (const shard of this.klineShards) {
      shard.close();
    }
    this.klineShards = [];
    // Close any user data streams as well
    for (const [userId, stream] of this.userDataStreams.entries()) {
      try { stream.ws?.close(); } catch {}
      this.userDataStreams.delete(userId);
    }
  }

  /**
   * Seed historical candles - MERGES with existing WebSocket data (V5.79)
   * Adds both older AND newer candles, never overwrites existing timestamps
   */
  seedKlines(symbol: string, interval: string, ohlcv: number[][]): void {
    if (!Array.isArray(ohlcv) || !ohlcv.length) return;

    const cacheSymbol = this.normalizeCacheSymbol(symbol);
    const key = this.klineCacheKey(cacheSymbol, interval);
    const limited = ohlcv.slice(-500);

    // Get existing cache (from WebSocket real-time updates)
    const existing = this.klinesCache.get(key) || [];

    if (existing.length > 0) {
      // MERGE MODE: Add candles older AND newer than what we have
      const oldestExistingTs = existing[0].timestamp;
      const newestExistingTs = existing[existing.length - 1].timestamp;
      const existingTimestamps = new Set(existing.map(k => k.timestamp));

      // V5.86 FIX: Mark all merged candles as isFinal=true
      // When merging with existing cache (which has correct isFinal from WebSocket),
      // we're typically backfilling older historical candles which are all closed.
      // The current in-progress candle is already in existing cache with correct isFinal.
      const toMerge = limited
        .filter(row => !existingTimestamps.has(Number(row[0])))
        .map((row) => ({
          symbol: cacheSymbol,
          timeframe: interval,
          timestamp: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          isFinal: true,  // V5.86: Historical backfill candles are always closed
        } satisfies BinanceKlineData));

      if (toMerge.length > 0) {
        // Merge all candles, sort by timestamp, keep last 500
        const merged = [...existing, ...toMerge]
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-500);
        this.klinesCache.set(key, merged);
      }
    } else {
      // FULL SEED: No existing data (startup), do full replacement
      // V5.86 FIX: Set isFinal correctly - last candle is in-progress, rest are final
      const seeded = limited.map((row, idx) => ({
        symbol: cacheSymbol,
        timeframe: interval,
        timestamp: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        isFinal: idx < limited.length - 1,  // V5.86: Last candle is in-progress
      } satisfies BinanceKlineData));

      this.klinesCache.set(key, seeded);
    }
  }

  /**
   * 💰 Subscribe to User Data Stream (Balance, Orders, Trades)
   * 
   * Uses listenKey endpoint (0 weight) to receive real-time balance updates.
   * Automatically keeps listenKey alive every 30 minutes.
   * 
   * @param userId - User ID for multi-user support
   * @param apiKey - Binance API key
   * @param apiSecret - Binance API secret
   */
  async subscribeToUserData(userId: string, apiKey: string, apiSecret: string): Promise<void> {
    if (this.userDataStreams.has(userId)) {
      console.log(`✅ User ${userId} already subscribed to user data stream`);
      return;
    }

    const inFlight = this.userDataSubscriptions.get(userId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const subscription = (async () => {
      try {
        // Step 1: Create listenKey (0 weight)
        const listenKeyUrl = new URL(this.endpoints.listenKeyPath, this.endpoints.rest);

        if (this.endpoints.requiresSignature) {
          const timestamp = Date.now();
          const params = new URLSearchParams({ timestamp: String(timestamp) });
          const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(params.toString())
            .digest('hex');
          params.append('signature', signature);
          listenKeyUrl.search = params.toString();
        }

        const listenKeyResponse = await fetch(listenKeyUrl.toString(), {
          method: 'POST',
          headers: { 'X-MBX-APIKEY': apiKey },
        });

        if (!listenKeyResponse.ok) {
          throw new Error(`Failed to create listenKey: ${await listenKeyResponse.text()}`);
        }

        const { listenKey } = await listenKeyResponse.json();
        console.log(`✅ Created listenKey for user ${userId}: ${listenKey.substring(0, 10)}...`);

        // Step 2: Connect to user data stream
        const wsUrl = `${this.endpoints.wsUserBase}/${listenKey}`;
        const userWs = new WebSocket(wsUrl);

        userWs.on('open', () => {
          console.log(`🔌 User data stream connected for user ${userId}`);
        });

        userWs.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());

            // ACCOUNT_UPDATE event (balance + position changes)
            if (msg.e === 'ACCOUNT_UPDATE') {
              // Handle balance updates (B array)
              const balances = msg.a?.B || [];
              for (const bal of balances) {
                const asset = String(bal.a || '').toUpperCase();
                const wb = parseFloat(bal.wb || '0'); // Wallet balance
                const cw = parseFloat(bal.cw || '0'); // Cross wallet balance
                
                const free = Math.max(cw, 0);
                const locked = Math.max(wb - cw, 0);

                const balanceData: BinanceBalance = {
                  asset,
                  free,
                  locked,
                  total: wb,
                  timestamp: Date.now(),
                };

                const cacheKey = `${userId}_${asset}`;
                this.balanceCache.set(cacheKey, balanceData);
              }
              
              // Handle position updates (P array) - 0 weight vs fetchPositions!
              const positions = msg.a?.P || [];
              for (const pos of positions) {
                const symbol = String(pos.s || '').toUpperCase(); // e.g., "BTCUSDT"
                const positionAmt = parseFloat(pos.pa || '0');    // Position amount (negative = short)
                const entryPrice = parseFloat(pos.ep || '0');     // Entry price
                const unrealizedPnl = parseFloat(pos.up || '0');  // Unrealized PnL
                const marginType = pos.mt || 'cross';             // Margin type
                const isolatedWallet = parseFloat(pos.iw || '0'); // Isolated wallet (if isolated)
                
                const positionData: BinancePositionData = {
                  symbol,
                  positionAmt,
                  entryPrice,
                  unrealizedPnl,
                  marginType,
                  isolatedWallet,
                  side: positionAmt > 0 ? 'long' : positionAmt < 0 ? 'short' : 'none',
                  timestamp: Date.now(),
                };
                
                const cacheKey = `${userId}_${symbol}`;
                this.positionCache.set(cacheKey, positionData);
                
                // Log position changes (useful for debugging)
                if (positionAmt !== 0) {
                  console.log(`📊 [WS] Position update ${userId}/${symbol}: ${positionData.side} ${Math.abs(positionAmt)} @ $${entryPrice} (uPnL: $${unrealizedPnl.toFixed(2)})`);
                } else {
                  console.log(`📊 [WS] Position closed ${userId}/${symbol}`);
                }
              }
              
              if (balances.length > 0 || positions.length > 0) {
                console.log(`💰 [WS] Account update for ${userId}: ${balances.length} balances, ${positions.length} positions`);
              }
            }

            // ORDER_TRADE_UPDATE event (order updates)
            if (msg.e === 'ORDER_TRADE_UPDATE') {
              const order = msg.o || {};
              const symbol = String(order.s || '').toUpperCase();

              if (symbol) {
                const reduceOnlyRaw = order.R;
                const reduceOnly = reduceOnlyRaw === true || reduceOnlyRaw === 'true';

                const update: BinanceOrderTradeUpdate = {
                  userId,
                  symbol,
                  eventTime: Number(msg.E) || Date.now(),
                  transactionTime: Number(order.T ?? msg.T ?? msg.E) || Date.now(),
                  executionType: String(order.x || ''),
                  orderStatus: String(order.X || ''),
                  side: String(order.S || ''),
                  orderType: String(order.o || ''),
                  orderId: order.i !== undefined ? String(order.i) : undefined,
                  clientOrderId: order.c !== undefined ? String(order.c) : undefined,
                  averagePrice: order.ap !== undefined ? parseFloat(order.ap) : undefined,
                  lastFilledQty: order.l !== undefined ? parseFloat(order.l) : undefined,
                  lastFilledPrice: order.L !== undefined ? parseFloat(order.L) : undefined,
                  cumulativeFilledQty: order.z !== undefined ? parseFloat(order.z) : undefined,
                  stopPrice: order.sp !== undefined ? parseFloat(order.sp) : undefined,
                  reduceOnly,
                  raw: msg,
                };

                this.recordOrderTradeUpdate(update);
              }

              console.log(`📊 Order update for user ${userId}: ${order.s} ${order.S} ${order.X}`);
            }

          } catch (error) {
            console.error(`❌ Failed to parse user data message for ${userId}:`, error);
          }
        });

        userWs.on('error', (error) => {
          console.error(`❌ User data stream error for ${userId}:`, error);
        });

        const streamRecord = { ws: userWs, listenKey, userId } as {
          ws: WebSocket | null;
          listenKey: string;
          userId: string;
          keepAliveTimer?: NodeJS.Timeout;
        };
        this.userDataStreams.set(userId, streamRecord);

        const clearKeepAlive = () => {
          const existing = this.userDataStreams.get(userId);
          if (existing?.keepAliveTimer) {
            clearInterval(existing.keepAliveTimer);
            existing.keepAliveTimer = undefined;
          }
        };

        // ═══════════════════════════════════════════════════════════════════════════
        // V5.65: IMPROVED LISTENKEY KEEP-ALIVE WITH RETRY LOGIC
        // ═══════════════════════════════════════════════════════════════════════════
        // - Reduced interval from 30min to 25min (5min safety margin)
        // - Added retry logic with up to 3 attempts before reconnecting
        // - Better error classification (401 vs 429 vs 5xx)
        // ═══════════════════════════════════════════════════════════════════════════

        const doKeepAlive = async (retryAttempt: number = 0): Promise<boolean> => {
          const maxRetries = 3;

          try {
            const keepAliveUrl = new URL(this.endpoints.listenKeyPath, this.endpoints.rest);
            const params = new URLSearchParams({ listenKey });

            if (this.endpoints.requiresSignature) {
              const ts = Date.now();
              params.append('timestamp', String(ts));
              const signature = crypto
                .createHmac('sha256', apiSecret)
                .update(params.toString())
                .digest('hex');
              params.append('signature', signature);
            }

            keepAliveUrl.search = params.toString();

            const keepAliveResponse = await fetch(keepAliveUrl.toString(), {
              method: 'PUT',
              headers: { 'X-MBX-APIKEY': apiKey },
            });

            if (!keepAliveResponse.ok) {
              const errorText = await keepAliveResponse.text();
              const status = keepAliveResponse.status;

              // V5.65: Classify error and handle appropriately
              if (status === 401 || status === 403) {
                // Invalid API key - no point retrying, reconnect with new listenKey
                console.error(`❌ [${userId}] ListenKey keep-alive: Invalid API key (${status}) - reconnecting...`);
                return false; // Will trigger reconnect
              }

              if (status === 429) {
                // Rate limited - wait and retry
                if (retryAttempt < maxRetries) {
                  const delay = 5000 * (retryAttempt + 1); // 5s, 10s, 15s
                  console.warn(`⚠️ [${userId}] ListenKey keep-alive rate limited - retrying in ${delay}ms (attempt ${retryAttempt + 1}/${maxRetries})`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                  return doKeepAlive(retryAttempt + 1);
                }
                return false;
              }

              if (status >= 500) {
                // Server error - retry with backoff
                if (retryAttempt < maxRetries) {
                  const delay = 2000 * (retryAttempt + 1);
                  console.warn(`⚠️ [${userId}] ListenKey keep-alive server error (${status}) - retrying in ${delay}ms`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                  return doKeepAlive(retryAttempt + 1);
                }
                return false;
              }

              throw new Error(`Keep-alive failed (${status}): ${errorText}`);
            }

            console.log(`✅ [${userId}] ListenKey kept alive successfully`);
            return true;
          } catch (error: any) {
            // Network error - retry
            if (retryAttempt < maxRetries) {
              const delay = 2000 * (retryAttempt + 1);
              console.warn(`⚠️ [${userId}] ListenKey keep-alive network error - retrying in ${delay}ms: ${error.message}`);
              await new Promise(resolve => setTimeout(resolve, delay));
              return doKeepAlive(retryAttempt + 1);
            }
            console.error(`❌ [${userId}] ListenKey keep-alive failed after ${maxRetries} retries:`, error.message);
            return false;
          }
        };

        const keepAliveInterval = setInterval(async () => {
          const success = await doKeepAlive(0);

          if (!success) {
            console.error(`❌ [${userId}] ListenKey keep-alive failed - triggering reconnection...`);
            clearKeepAlive();
            this.userDataStreams.delete(userId);
            try { userWs.close(); } catch {}

            // Use the improved reconnect logic
            setTimeout(() => {
              this.subscribeToUserData(userId, apiKey, apiSecret).catch((err) => {
                console.error(`❌ [${userId}] Failed to resubscribe after keep-alive failure:`, err);
              });
            }, 500);
          }
        }, 25 * 60 * 1000); // V5.65: 25 minutes instead of 30 (5min safety margin)

        streamRecord.keepAliveTimer = keepAliveInterval;

        const cleanup = () => {
          clearKeepAlive();
          this.userDataStreams.delete(userId);
        };

        userWs.on('close', (code, reason) => {
          console.log(`🔌 User data stream closed for user ${userId} (code: ${code}, reason: ${reason?.toString() || 'none'})`);

          // Check if this was an intentional close (from unsubscribeFromUserData)
          const wasIntentional = (streamRecord as any)._intentionalClose === true;
          cleanup();

          if (wasIntentional) {
            console.log(`🔌 User data stream intentionally closed for ${userId}, not reconnecting`);
            return;
          }

          // ═══════════════════════════════════════════════════════════════════════════
          // V5.65: IMPROVED AUTO-RECONNECT WITH EXPONENTIAL BACKOFF
          // ═══════════════════════════════════════════════════════════════════════════
          // Binance closes streams after 24h or network issues - we need to reconnect
          // Use exponential backoff: 500ms, 1s, 2s, 4s, 8s, max 30s
          // ═══════════════════════════════════════════════════════════════════════════
          const maxRetries = 10;
          const baseDelay = 500; // Start with 500ms instead of 2s
          const maxDelay = 30000;

          const attemptReconnect = (attempt: number) => {
            if (attempt > maxRetries) {
              console.error(`❌ [${userId}] User data stream reconnect FAILED after ${maxRetries} attempts. Manual intervention required!`);
              // TODO: Send critical alert via Telegram
              return;
            }

            const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
            console.log(`🔄 [${userId}] Reconnecting user data stream (attempt ${attempt}/${maxRetries}) in ${delay}ms...`);

            setTimeout(() => {
              this.subscribeToUserData(userId, apiKey, apiSecret)
                .then(() => {
                  console.log(`✅ [${userId}] User data stream reconnected successfully on attempt ${attempt}`);
                })
                .catch((err) => {
                  console.error(`❌ [${userId}] Reconnect attempt ${attempt} failed:`, err.message || err);
                  attemptReconnect(attempt + 1);
                });
            }, delay);
          };

          // Start reconnection immediately (attempt 1 = 500ms delay)
          attemptReconnect(1);
        });

        userWs.on('error', (error) => {
          console.error(`❌ User data stream error for ${userId}:`, error);
          cleanup();
        });

      } catch (error) {
        console.error(`❌ Failed to subscribe to user data for ${userId}:`, error);
        throw error;
      }
    })();

    this.userDataSubscriptions.set(userId, subscription);

    try {
      await subscription;
    } finally {
      this.userDataSubscriptions.delete(userId);
    }
  }

  private recordOrderTradeUpdate(update: BinanceOrderTradeUpdate): void {
    const symbolKey = `${update.userId}_${update.symbol}`;
    const existing = this.orderTradeUpdateCache.get(symbolKey) || [];
    existing.push(update);

    if (existing.length > this.orderUpdateCacheLimitPerSymbol) {
      existing.splice(0, existing.length - this.orderUpdateCacheLimitPerSymbol);
    }
    this.orderTradeUpdateCache.set(symbolKey, existing);

    if (update.orderId) {
      const orderKey = `${update.userId}_${update.orderId}`;
      this.orderTradeUpdateByOrderId.set(orderKey, update);

      // Prune order-by-ID cache: keep max 2000 entries, evict oldest on overflow
      if (this.orderTradeUpdateByOrderId.size > 2000) {
        const keysIter = this.orderTradeUpdateByOrderId.keys();
        // Delete oldest 500 entries (Maps iterate in insertion order)
        for (let i = 0; i < 500; i++) {
          const oldest = keysIter.next();
          if (oldest.done) break;
          this.orderTradeUpdateByOrderId.delete(oldest.value);
        }
      }
    }
  }

  getRecentOrderTradeUpdates(userId: string, symbol: string, options?: { sinceMs?: number; limit?: number }): BinanceOrderTradeUpdate[] {
    const normalizedSymbol = toBinanceSymbolId(symbol);
    const key = `${userId}_${normalizedSymbol}`;
    const updates = this.orderTradeUpdateCache.get(key) || [];

    const sinceMs = options?.sinceMs;
    const filtered = sinceMs ? updates.filter((u) => u.eventTime >= sinceMs) : updates;

    const limit = options?.limit ?? filtered.length;
    if (limit <= 0) return [];
    if (filtered.length <= limit) return filtered.slice();
    return filtered.slice(filtered.length - limit);
  }

  getLastFilledOrderTradeUpdate(
    userId: string,
    symbol: string,
    options?: { reduceOnly?: boolean; side?: 'BUY' | 'SELL' }
  ): BinanceOrderTradeUpdate | null {
    const normalizedSymbol = toBinanceSymbolId(symbol);
    const key = `${userId}_${normalizedSymbol}`;
    const updates = this.orderTradeUpdateCache.get(key);
    if (!updates || updates.length === 0) return null;

    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];

      if (options?.reduceOnly !== undefined && u.reduceOnly !== options.reduceOnly) continue;
      if (options?.side && u.side !== options.side) continue;

      const lastQty = Number(u.lastFilledQty ?? 0);
      const cumQty = Number(u.cumulativeFilledQty ?? 0);
      const isTrade = u.executionType === 'TRADE';
      const hasFillQty = lastQty > 0 || cumQty > 0;
      const hasPrice = Number(u.lastFilledPrice ?? 0) > 0 || Number(u.averagePrice ?? 0) > 0;

      if (isTrade && hasFillQty && hasPrice) return u;
      if (u.orderStatus === 'FILLED' && hasFillQty && hasPrice) return u;
    }

    return null;
  }

  /**
   * 📋 Get order update by orderId from WS cache (0 weight)
   * Replaces exchange.fetchOrder() polling (2w per call).
   */
  getOrderTradeUpdateById(userId: string, orderId: string): BinanceOrderTradeUpdate | null {
    const key = `${userId}_${orderId}`;
    return this.orderTradeUpdateByOrderId.get(key) || null;
  }

  /**
   * 💰 Get Balance from Cache (0 weight)
   *
   * Returns cached balance from user data stream.
   * Requires subscribeToUserData to be called first.
   *
   * @param userId - User ID
   * @param asset - Asset symbol (default: 'USDT')
   * @returns Balance data or null if not available
   */
  getBalance(userId: string, asset: string = 'USDT'): BinanceBalance | null {
    const cacheKey = `${userId}_${asset.toUpperCase()}`;
    return this.balanceCache.get(cacheKey) || null;
  }

  /**
   * 📊 Get Position from WebSocket cache (0 weight)
   * 
   * @param userId - User ID
   * @param symbol - Symbol in Binance format (e.g., "BTCUSDT") or unified (e.g., "BTC/USDT:USDT")
   * @returns Position data or null if not available
   */
  getPosition(userId: string, symbol: string): BinancePositionData | null {
    // Normalize symbol to Binance format (BTCUSDT)
    const normalizedSymbol = toBinanceSymbolId(symbol);
    const cacheKey = `${userId}_${normalizedSymbol}`;
    return this.positionCache.get(cacheKey) || null;
  }

  /**
   * 📊 Get All Positions for a user from WebSocket cache (0 weight)
   * 
   * @param userId - User ID
   * @returns Map of symbol -> position data (only non-zero positions)
   */
  getAllPositions(userId: string): Map<string, BinancePositionData> {
    const result = new Map<string, BinancePositionData>();
    const prefix = `${userId}_`;
    
    for (const [key, pos] of this.positionCache.entries()) {
      if (key.startsWith(prefix) && pos.positionAmt !== 0) {
        const symbol = key.slice(prefix.length);
        result.set(symbol, pos);
      }
    }
    
    return result;
  }

  seedBalance(userId: string, asset: string, payload: { free: number; locked: number; total: number; timestamp?: number }): void {
    const normalizedAsset = asset.toUpperCase();
    const cacheKey = `${userId}_${normalizedAsset}`;
    const totalRaw = Number(payload.total);
    const freeRaw = Number(payload.free);
    const lockedRaw = Number(payload.locked);

    const total = Number.isFinite(totalRaw) ? Math.max(totalRaw, 0) : 0;
    const free = Number.isFinite(freeRaw) ? Math.max(Math.min(freeRaw, total), 0) : Math.max(total, 0);
    const locked = Number.isFinite(lockedRaw)
      ? Math.max(Math.min(lockedRaw, total), 0)
      : Math.max(total - free, 0);

    const balanceData: BinanceBalance = {
      asset: normalizedAsset,
      free,
      locked,
      total,
      timestamp: payload.timestamp ? Number(payload.timestamp) : Date.now(),
    };
    this.balanceCache.set(cacheKey, balanceData);
  }

  /**
   * 📦 Seed Position Cache from REST API (called at startup)
   * This is needed because WebSocket only sends position updates when they change
   */
  seedPosition(userId: string, symbol: string, payload: { 
    positionAmt: number; 
    entryPrice: number; 
    unrealizedPnl: number;
    marginType?: string;
    side?: 'long' | 'short';
    updateTime?: number;
  }): void {
    const normalizedSymbol = toBinanceSymbolId(symbol);
    const cacheKey = `${userId}_${normalizedSymbol}`;
    
    const positionData: BinancePositionData = {
      symbol: normalizedSymbol,
      positionAmt: payload.positionAmt,
      entryPrice: payload.entryPrice,
      unrealizedPnl: payload.unrealizedPnl,
      marginType: payload.marginType || 'cross',
      isolatedWallet: 0,
      side: payload.side || (payload.positionAmt > 0 ? 'long' : payload.positionAmt < 0 ? 'short' : 'none'),
      timestamp: payload.updateTime || Date.now(),
    };
    
    this.positionCache.set(cacheKey, positionData);
    // Mark that this user's position cache has been seeded
    this.positionCacheSeeded.add(userId);
  }
  
  /**
   * Check if position cache has been seeded for a user
   * Used to determine if REST fallback is needed
   */
  isPositionCacheSeeded(userId: string): boolean {
    return this.positionCacheSeeded.has(userId);
  }
  
  /**
   * Mark position cache as seeded for a user (even if no positions)
   * Call this after fetching all positions at startup
   */
  markPositionCacheSeeded(userId: string): void {
    this.positionCacheSeeded.add(userId);
  }

  /**
   * 🔌 Check if user data stream is active and healthy
   */
  isUserDataStreamActive(userId: string): boolean {
    const stream = this.userDataStreams.get(userId);
    if (!stream?.ws) return false;
    return stream.ws.readyState === WebSocket.OPEN;
  }
  
  /**
   * 🔌 Get user data stream status for debugging
   */
  getUserDataStreamStatus(userId: string): { 
    connected: boolean; 
    hasListenKey: boolean;
    readyState: number | null;
    cacheAge: { balance: number | null; position: number | null };
  } {
    const stream = this.userDataStreams.get(userId);
    const balanceCache = this.balanceCache.get(`${userId}_USDT`);
    
    // Find most recent position cache entry for this user
    let newestPositionTs: number | null = null;
    for (const [key, pos] of this.positionCache.entries()) {
      if (key.startsWith(`${userId}_`) && pos.timestamp) {
        if (!newestPositionTs || pos.timestamp > newestPositionTs) {
          newestPositionTs = pos.timestamp;
        }
      }
    }
    
    return {
      connected: stream?.ws?.readyState === WebSocket.OPEN,
      hasListenKey: !!stream?.listenKey,
      readyState: stream?.ws?.readyState ?? null,
      cacheAge: {
        balance: balanceCache?.timestamp ? Date.now() - balanceCache.timestamp : null,
        position: newestPositionTs ? Date.now() - newestPositionTs : null,
      }
    };
  }

  /**
   * 🔌 Unsubscribe from User Data Stream
   */
  unsubscribeFromUserData(userId: string): void {
    const stream = this.userDataStreams.get(userId);
    if (stream?.ws) {
      // Mark as intentionally closed to prevent auto-reconnect
      (stream as any)._intentionalClose = true;
      stream.ws.close();
      if (stream.keepAliveTimer) {
        clearInterval(stream.keepAliveTimer);
      }
    }
    this.userDataStreams.delete(userId);
    console.log(`🔌 Unsubscribed user ${userId} from user data stream`);
  }
}

interface BinanceKlineShardOptions {
  id: number;
  manager: BinanceWebSocketManager;
  endpoints: typeof BINANCE_ENDPOINTS;
  maxStreams: number;
  reconnectSkewMs: number;
  reconnectJitterMs: number;
  socketFactory?: (url: string) => WebSocket;
  testModeOverride?: boolean;
}

class BinanceKlineShard {
  private readonly id: number;
  private readonly manager: BinanceWebSocketManager;
  private readonly endpoints: typeof BINANCE_ENDPOINTS;
  private readonly maxStreams: number;
  private readonly reconnectSkewMs: number;
  private readonly reconnectJitterMs: number;
  private readonly socketFactory?: (url: string) => WebSocket;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isConnected = false;
  private desiredStreams = new Set<string>();
  private activeStreams = new Set<string>();
  private reconnectAttempts = 0;
  private readonly baseBackoffMs = 2_000;
  private readonly maxBackoffMs = 60_000;
  private readonly heartbeatIntervalMs = 30_000;
  private readonly heartbeatTimeoutMs = 90_000;
  private lastPongTs = 0;
  private lastMessageTs = 0;
  private readonly isTestMode: boolean;
  private hasConnectedOnce = false;
  private initialConnectTimer: NodeJS.Timeout | null = null;
  private lastCloseCode: number | null = null;
  private pendingSubscriptions = new Set<string>();
  private pendingUnsubscriptions = new Set<string>();
  private subscriptionDrainTimer: NodeJS.Timeout | null = null;
  private readonly subscriptionBatchSize = 16;
  private readonly subscriptionRetryDelayMs = 150;

  constructor(options: BinanceKlineShardOptions) {
    this.id = options.id;
    this.manager = options.manager;
    this.endpoints = options.endpoints;
    this.maxStreams = options.maxStreams;
    this.reconnectSkewMs = options.reconnectSkewMs;
    this.reconnectJitterMs = options.reconnectJitterMs;
    this.socketFactory = options.socketFactory;
    this.isTestMode = options.testModeOverride ?? process.env.UNIT_TEST_MODE === 'true';
  }

  setStreams(streams: string[]): void {
    if (streams.length > this.maxStreams) {
      console.warn(`⚠️ Kline shard ${this.id} received ${streams.length} streams (max ${this.maxStreams}), trimming.`);
      streams = streams.slice(0, this.maxStreams);
    }

    const next = new Set(streams);
    this.desiredStreams = next;

    if (this.desiredStreams.size === 0) {
      this.activeStreams.clear();
      this.stopSocket();
      return;
    }

    if (!this.ws && !this.isConnecting && !this.hasConnectedOnce && !this.initialConnectTimer) {
      const staggerDelay = Math.min(3_000, Math.max(0, this.reconnectSkewMs * (this.id + 1)));
      this.initialConnectTimer = setTimeout(() => {
        this.initialConnectTimer = null;
        this.ensureConnected();
        this.flushSubscriptions();
      }, staggerDelay);
      this.initialConnectTimer.unref?.();
      return;
    }

    this.ensureConnected();
    this.flushSubscriptions();
  }

  getDesiredStreamCount(): number {
    return this.desiredStreams.size;
  }

  getDesiredStreams(): string[] {
    return Array.from(this.desiredStreams);
  }

  close(): void {
    this.desiredStreams.clear();
    this.activeStreams.clear();
    this.stopSocket();
    if (this.initialConnectTimer) {
      clearTimeout(this.initialConnectTimer);
      this.initialConnectTimer = null;
    }
  }

  forceReconnect(): void {
    const hasStreams = this.desiredStreams.size > 0;
    this.stopSocket();
    this.activeStreams.clear();

    if (!hasStreams) {
      return;
    }

    if (this.isTestMode) {
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.activeStreams = new Set(this.desiredStreams);
      return;
    }

    this.ensureConnected();
    this.flushSubscriptions();
  }

  private ensureConnected(): void {
    if (this.desiredStreams.size === 0) {
      return;
    }

    if (this.isTestMode) {
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.activeStreams = new Set(this.desiredStreams);
      return;
    }

    if (this.ws || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    const ws = this.socketFactory ? this.socketFactory(this.endpoints.wsMulti) : new WebSocket(this.endpoints.wsMulti);
    this.ws = ws;

    ws.on('open', () => {
      console.log(`✅ Binance kline shard ${this.id} connected`);
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.activeStreams.clear();
      this.startHeartbeatMonitoring();
      this.flushSubscriptions();
      this.scheduleSubscriptionDrain();
      this.hasConnectedOnce = true;
      this.lastCloseCode = null;
    });

    ws.on('message', (buffer: Buffer) => {
      try {
        const payload = JSON.parse(buffer.toString());
        if (payload && typeof payload === 'object') {
          if (Array.isArray(payload)) {
            return;
          }
          const stream = payload.stream;
          const data = payload.data;
          if (typeof stream === 'string' && stream.includes('@kline_')) {
            this.lastMessageTs = Date.now();
            this.manager.onShardMessage(stream, data);
          }
        }
      } catch (error) {
        console.error(`❌ Failed to parse kline shard ${this.id} message:`, error);
      }
    });

    ws.on('pong', () => {
      this.lastPongTs = Date.now();
    });

    ws.on('ping', () => {
      try { ws.pong(); } catch {}
    });

    ws.on('close', (code, reason) => {
      const reasonText = typeof reason?.toString === 'function' ? reason.toString('utf8') : '';
      const trimmed = reasonText.trim();
      const suffix = trimmed ? ` (code ${code}, reason: ${trimmed})` : code ? ` (code ${code})` : '';
      console.warn(`⚠️ Binance kline shard ${this.id} closed${suffix}`);
      this.isConnected = false;
      this.isConnecting = false;
      this.ws = null;
      this.stopHeartbeatMonitoring();
      this.activeStreams.clear();
      this.lastCloseCode = typeof code === 'number' ? code : null;
      if (this.desiredStreams.size > 0 && !this.manager.isShutdownRequested()) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (error) => {
      console.error(`❌ Binance kline shard ${this.id} error:`, error instanceof Error ? error.message : error);
      if (!this.isTestMode) {
        try { this.ws?.terminate(); } catch {}
      }
    });
  }

  private flushSubscriptions(): void {
    if (this.isTestMode) {
      this.activeStreams = new Set(this.desiredStreams);
      this.pendingSubscriptions.clear();
      this.pendingUnsubscriptions.clear();
      return;
    }

    if (!this.ws || !this.isConnected) {
      return;
    }

    for (const stream of [...this.activeStreams]) {
      if (!this.desiredStreams.has(stream)) {
        this.sendUnsubscribe(stream);
      }
    }

    for (const stream of this.desiredStreams) {
      if (!this.activeStreams.has(stream)) {
        this.sendSubscribe(stream);
      }
    }
  }

  private sendSubscribe(stream: string): void {
    if (this.activeStreams.has(stream) && !this.pendingUnsubscriptions.has(stream)) {
      this.pendingSubscriptions.delete(stream);
      return;
    }

    this.pendingUnsubscriptions.delete(stream);
    if (this.pendingSubscriptions.has(stream)) {
      return;
    }

    this.pendingSubscriptions.add(stream);
    this.scheduleSubscriptionDrain();
  }

  private sendUnsubscribe(stream: string): void {
    this.pendingSubscriptions.delete(stream);

    if (this.pendingUnsubscriptions.has(stream)) {
      return;
    }

    if (!this.ws || !this.isConnected) {
      this.activeStreams.delete(stream);
      return;
    }

    if (!this.activeStreams.has(stream)) {
      return;
    }

    this.pendingUnsubscriptions.add(stream);
    this.scheduleSubscriptionDrain();
  }

  private scheduleSubscriptionDrain(delay = 0): void {
    if (this.subscriptionDrainTimer) {
      return;
    }

    this.subscriptionDrainTimer = setTimeout(() => {
      this.subscriptionDrainTimer = null;
      this.drainPendingSubscriptions();
    }, delay);
    this.subscriptionDrainTimer.unref?.();
  }

  private clearSubscriptionDrainTimer(): void {
    if (this.subscriptionDrainTimer) {
      clearTimeout(this.subscriptionDrainTimer);
      this.subscriptionDrainTimer = null;
    }
  }

  private drainPendingSubscriptions(): void {
    if (this.isTestMode) {
      for (const stream of this.pendingSubscriptions) {
        this.activeStreams.add(stream);
      }
      this.pendingSubscriptions.clear();
      this.pendingUnsubscriptions.clear();
      return;
    }

    const ws = this.ws;
    if (!ws || !this.isConnected || ws.readyState !== WebSocket.OPEN) {
      if (this.pendingSubscriptions.size > 0 || this.pendingUnsubscriptions.size > 0) {
        this.scheduleSubscriptionDrain(this.subscriptionRetryDelayMs);
      }
      return;
    }

    const takeBatch = (set: Set<string>): string[] => {
      const chunk: string[] = [];
      for (const stream of set) {
        chunk.push(stream);
        if (chunk.length >= this.subscriptionBatchSize) {
          break;
        }
      }
      return chunk;
    };

    while (this.pendingSubscriptions.size > 0) {
      const batch = takeBatch(this.pendingSubscriptions);
      if (!batch.length) {
        break;
      }
      if (!this.dispatchSubscriptionBatch(ws, 'SUBSCRIBE', batch)) {
        this.scheduleSubscriptionDrain(this.subscriptionRetryDelayMs);
        return;
      }
    }

    while (this.pendingUnsubscriptions.size > 0) {
      const batch = takeBatch(this.pendingUnsubscriptions);
      if (!batch.length) {
        break;
      }
      if (!this.dispatchSubscriptionBatch(ws, 'UNSUBSCRIBE', batch)) {
        this.scheduleSubscriptionDrain(this.subscriptionRetryDelayMs);
        return;
      }
    }

    const remaining = this.pendingSubscriptions.size + this.pendingUnsubscriptions.size;
    if (remaining > 0) {
      this.scheduleSubscriptionDrain(this.subscriptionRetryDelayMs);
    }
  }

  private dispatchSubscriptionBatch(ws: WebSocket, method: 'SUBSCRIBE' | 'UNSUBSCRIBE', streams: string[]): boolean {
    if (!streams.length) {
      return true;
    }

    const payload = { method, params: streams, id: Date.now() };
    try {
      ws.send(JSON.stringify(payload));
      if (method === 'SUBSCRIBE') {
        for (const stream of streams) {
          this.pendingSubscriptions.delete(stream);
          this.activeStreams.add(stream);
        }
      } else {
        for (const stream of streams) {
          this.pendingUnsubscriptions.delete(stream);
          this.activeStreams.delete(stream);
        }
      }
      return true;
    } catch (error) {
      const action = method === 'SUBSCRIBE' ? 'subscribe' : 'unsubscribe';
      const targets = streams.join(', ');
      console.error(`❌ Failed to ${action} shard ${this.id} ${method === 'SUBSCRIBE' ? 'to' : 'from'} ${targets}:`, error);
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.isTestMode || this.desiredStreams.size === 0) {
      return;
    }
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    const exponentialDelay = Math.min(this.baseBackoffMs * Math.pow(2, attempt), this.maxBackoffMs);
    const rateLimitPenalty = this.lastCloseCode === 1008 ? Math.min(30_000, exponentialDelay) : 0;
    const offset = Math.max(0, this.reconnectSkewMs * this.id);
    const jitter = this.reconnectJitterMs > 0 ? Math.floor(Math.random() * this.reconnectJitterMs) : 0;
    const delay = Math.min(this.maxBackoffMs, exponentialDelay + rateLimitPenalty) + offset + jitter;
    console.warn(`🔄 Scheduling Binance kline shard ${this.id} reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.ensureConnected();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private stopSocket(): void {
    this.clearReconnectTimer();
    this.stopHeartbeatMonitoring();
    this.clearSubscriptionDrainTimer();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.lastCloseCode = null;
    this.pendingSubscriptions.clear();
    this.pendingUnsubscriptions.clear();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeatMonitoring(): void {
    if (this.isTestMode) {
      return;
    }
    this.stopHeartbeatMonitoring();
    this.lastPongTs = Date.now();
    this.lastMessageTs = Date.now();
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeatCheck();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatMonitoring(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private runHeartbeatCheck(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const now = Date.now();
    try {
      this.ws.ping();
    } catch (error) {
      console.error(`❌ Binance kline shard ${this.id} failed to send ping:`, error instanceof Error ? error.message : error);
      return;
    }

    const sinceLastPong = now - this.lastPongTs;
    const sinceLastMessage = now - this.lastMessageTs;
    if (sinceLastPong > this.heartbeatTimeoutMs && sinceLastMessage > this.heartbeatTimeoutMs) {
      console.warn(`⚠️ Binance kline shard ${this.id} heartbeat timeout (pong ${sinceLastPong}ms, message ${sinceLastMessage}ms), forcing reconnect`);
      try { this.ws.terminate(); } catch {}
    }
  }
}

// Singleton instance
let binanceWsManager: BinanceWebSocketManager | null = null;
const balanceFetchPromises = new Map<string, Promise<any>>();

/**
 * Get or create the singleton WebSocket manager
 */
export function getBinanceWebSocket(): BinanceWebSocketManager {
  if (!binanceWsManager) {
    binanceWsManager = new BinanceWebSocketManager();
    // Auto-connect
    binanceWsManager.connect().catch(err => {
      console.error('Failed to auto-connect Binance WebSocket:', err);
    });
  }
  return binanceWsManager;
}

/**
 * Wait until the Binance WS cache is healthy (tickers available and recent)
 * Returns true if healthy within timeout, false otherwise.
 */
export async function waitForWsHealthy(timeoutMs: number = 4000): Promise<boolean> {
  const ws = getBinanceWebSocket();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (ws.isHealthy()) {
        const map = ws.getAllTickers();
        if (map && map.size > 0) return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

export async function runExclusiveBalanceFetch<T>(userId: string, asset: string, fetcher: () => Promise<T>): Promise<T> {
  const key = `${userId}_${asset.toUpperCase()}`;
  const existing = balanceFetchPromises.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const wrapped = (async () => {
    try {
      return await fetcher();
    } finally {
      balanceFetchPromises.delete(key);
    }
  })();

  balanceFetchPromises.set(key, wrapped);
  return wrapped;
}

export function createTestBinanceWebSocketHarness() {
  if (process.env.UNIT_TEST_MODE !== 'true') {
    console.warn('createTestBinanceWebSocketHarness should only be used in UNIT_TEST_MODE.');
  }

  const manager = new BinanceWebSocketManager();
  const internal = manager as unknown as {
    isConnected: boolean;
    handleAllTickersUpdate: (tickers: any[]) => void;
    setServerTimeOffsetForTest?: (offsetMs: number) => void;
  };

  internal.isConnected = true;
  manager.seedExchangeSymbols([
    'ADAUSDT',
    'ARBUSDT',
    'DYDXUSDT',
    'SNXUSDT',
    'CRVUSDT',
    'LINKUSDT',
    'OPUSDT',
    'BTCUSDT',
    'ETHUSDT',
  ]);

  const withFakeNow = <T>(now: number, fn: () => T): T => {
    const originalNow = Date.now;
    (Date as any).now = () => now;
    try {
      return fn();
    } finally {
      (Date as any).now = originalNow;
    }
  };

  return {
    manager,
    feedBatch(tickers: any[], now: number) {
      withFakeNow(now, () => internal.handleAllTickersUpdate(tickers));
    },
    isHealthyAt(now: number) {
      return withFakeNow(now, () => manager.isHealthy());
    },
    setConnected(connected: boolean) {
      internal.isConnected = connected;
    },
    applyGrace(now: number) {
      withFakeNow(now, () => (internal as any).applyReconnectGrace(now));
    },
    getShardSizes() {
      return manager.getKlineShardSizes();
    },
    getShardStreams() {
      return manager.getKlineShardSnapshot();
    },
    setServerOffset(offsetMs: number) {
      internal.setServerTimeOffsetForTest?.(offsetMs);
    },
    seedExchangeSymbols(symbols: string[]) {
      manager.seedExchangeSymbols(symbols);
    },
  };
}

export function createKlineShardQueueTestHarness() {
  class StubSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    attempts: string[] = [];
    sent: string[] = [];

    send(data: string): void {
      this.attempts.push(data);
      if (this.readyState !== WebSocket.OPEN) {
        throw new Error(`WebSocket is not open: readyState ${this.readyState}`);
      }
      this.sent.push(data);
    }

    ping(): void {}

    pong(): void {}

    close(): void {}

    terminate(): void {}
  }

  const socket = new StubSocket();
  const managerStub = {
    onShardMessage: () => {},
    isShutdownRequested: () => false,
  };
  const shard = new BinanceKlineShard({
    id: 0,
    manager: managerStub as unknown as BinanceWebSocketManager,
    endpoints: BINANCE_ENDPOINTS,
    maxStreams: 64,
    reconnectSkewMs: 0,
    reconnectJitterMs: 0,
    socketFactory: () => socket as unknown as WebSocket,
    testModeOverride: false,
  });

  return {
    shard,
    socket,
    attempts(): string[] {
      return [...socket.attempts];
    },
    sent(): any[] {
      return socket.sent.map(entry => JSON.parse(entry));
    },
    async flush(): Promise<void> {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
    emitOpen(): void {
      socket.readyState = WebSocket.OPEN;
      socket.emit('open');
    },
    setReadyState(state: number): void {
      socket.readyState = state;
    },
  };
}

/**
 * Helper: Récupère un ticker via WebSocket avec fallback REST API
 */
export async function getTickerFromWebSocket(symbol: string): Promise<BinanceTickerData | null> {
  const ws = getBinanceWebSocket();

  if (!ws.isHealthy()) {
    const now = Date.now();
    const lastLogTs = lastWsUnhealthyLogTs.get(symbol) ?? 0;
    if (now - lastLogTs >= WS_UNHEALTHY_LOG_THROTTLE_MS) {
      console.warn(`⚠️ WebSocket not healthy for ${symbol}, fallback required`);
      lastWsUnhealthyLogTs.set(symbol, now);
    }
    setFallbackState(symbol, true, 'ws_unhealthy', { increment: false });
    return null;
  }

  const ticker = ws.getTicker(symbol);
  if (!ticker) {
    console.warn(`⚠️ WebSocket cache miss for ${symbol}, will fallback to REST API`);
    setFallbackState(symbol, true, 'ws_cache_miss', { increment: false });
    return null;
  }

  const cfg = getConfig();
  const now = Date.now();
  const timestamp = Number.isFinite(Number(ticker.timestamp)) ? Number(ticker.timestamp) : now;
  const dataAgeMs = Math.max(0, now - timestamp);

  if (ticker.stale || dataAgeMs > cfg.MARKET_STALE_THRESHOLD_MS) {
    console.warn(`⚠️ WebSocket ticker stale for ${symbol} (age ${dataAgeMs}ms), fallback to REST`);
    setFallbackState(symbol, true, 'ws_cache_stale', { increment: false });
    return null;
  }

  ticker.dataAgeMs = dataAgeMs;
  ticker.receivedAt = ticker.receivedAt ?? now;
  ticker.stale = false;
  setFallbackState(symbol, false);
  lastWsUnhealthyLogTs.delete(symbol);
  return ticker;
}

/**
 * Helper: Récupère tous les tickers via WebSocket avec fallback REST API
 */
export async function getAllTickersFromWebSocket(): Promise<Map<string, BinanceTickerData> | null> {
  const ws = getBinanceWebSocket();
  
  if (ws.isHealthy()) {
    return ws.getAllTickers();
  }
  
  console.warn('⚠️ WebSocket not healthy, will fallback to REST API');
  return null;
}

/**
 * 🔑 Validate Binance API Keys (0 weight)
 * 
 * Uses listenKey creation endpoint which:
 * - Requires valid API key + signature
 * - Returns 0 weight if successful
 * - Returns error if invalid keys
 * - No market data loaded
 * 
 * This is the ONLY safe way to validate Binance keys without consuming weight.
 */
export async function validateBinanceApiKey(apiKey: string, apiSecret: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const timestamp = Date.now();
    const crypto = await import('crypto');
    
    // Create signature for authenticated endpoint
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');
    
    // Test with listenKey creation (0 weight, requires valid signature)
    const url = `https://fapi.binance.com/fapi/v1/listenKey?${queryString}&signature=${signature}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ Binance API key validation successful (0 weight used)');
      return { valid: true };
    } else {
      const error = await response.text();
      console.warn('❌ Binance API key validation failed:', error);
      
      // Parse error
      try {
        const errorJson = JSON.parse(error);
        return { 
          valid: false, 
          error: errorJson.msg || 'Invalid API keys or signature' 
        };
      } catch {
        return { 
          valid: false, 
          error: error.substring(0, 200) 
        };
      }
    }
  } catch (error: any) {
    console.error('❌ Binance API key validation error:', error);
    return { 
      valid: false, 
      error: error.message || 'Network error' 
    };
  }
}

/**
 * 🔑 Validate Crypto.com API Keys (lightweight)
 * 
 * Crypto.com doesn't have IP bans like Binance.
 * Can safely use minimal endpoint for validation.
 */
export async function validateCryptocomApiKey(apiKey: string, apiSecret: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const ccxt = await import('ccxt');
    const exchange = new ccxt.cryptocom({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true
    });
    
    // Crypto.com: safe to use fetchBalance for validation (no aggressive bans)
    await exchange.fetchBalance();
    console.log('✅ Crypto.com API key validation successful');
    return { valid: true };
    
  } catch (error: any) {
    console.warn('❌ Crypto.com API key validation failed:', error.message);
    return { 
      valid: false, 
      error: error.message || 'Invalid API keys' 
    };
  }
}

export function seedKlinesFromWebSocket(symbol: string, interval: string, ohlcv: number[][]): void {
  const ws = getBinanceWebSocket();
  ws.seedKlines(symbol, interval, ohlcv);
}

/**
 * 🛡️ Strip candles before the last gap in a kline series.
 * When REST historical candles are merged with WS live candles and there's a gap
 * (missing candles), indicators like SMA200/ATR would be calculated on non-contiguous
 * data, producing wrong values and bad trading decisions.
 * Returns only the most recent contiguous block of candles.
 */
function stripGappedPrefix(klines: BinanceKlineData[], interval: string): BinanceKlineData[] {
  if (klines.length <= 1) return klines;

  const intervalMsMap: Record<string, number> = {
    '1m': 60_000,
    '3m': 3 * 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 3_600_000,
    '2h': 2 * 3_600_000,
    '4h': 4 * 3_600_000,
    '1d': 86_400_000,
  };
  const intervalMs = intervalMsMap[interval];
  if (!intervalMs) return klines;

  // Allow 1.5x interval tolerance for slight timestamp drift
  const maxGap = intervalMs * 1.5;

  for (let i = klines.length - 1; i > 0; i--) {
    const diff = klines[i].timestamp - klines[i - 1].timestamp;
    if (diff > maxGap) {
      const missingCandles = Math.round(diff / intervalMs) - 1;
      const gapMinutes = Math.round(diff / 60_000);
      console.warn(
        `[WS][GAP_STRIPPED] ${interval}: ${missingCandles} candles missing ` +
        `(${gapMinutes}min gap) at ${new Date(klines[i - 1].timestamp).toISOString()} -> ` +
        `${new Date(klines[i].timestamp).toISOString()}, ` +
        `keeping ${klines.length - i} contiguous candles (dropped ${i} old)`
      );
      return klines.slice(i);
    }
  }
  return klines;
}

/**
 * V5.50: Get klines with metadata (including isFinal) for accurate candle close detection
 * This preserves the isFinal flag from WebSocket which is essential for matching backtest timing
 */
export function getKlinesWithMeta(symbol: string, interval: string): { timestamp: number; open: number; high: number; low: number; close: number; volume: number; isFinal: boolean }[] | null {
  const ws = getBinanceWebSocket();
  const klines = ws.getKlines(symbol, interval);
  if (!klines?.length) return null;

  // Same staleness check as getKlinesOhlcvFromWebSocket
  const lastKline = klines[klines.length - 1];
  const lastBarAge = Date.now() - lastKline.timestamp;
  const intervalToMaxAge: Record<string, number> = {
    '1m': 5 * 60_000,
    '3m': 12 * 60_000,
    '5m': 20 * 60_000,
    '15m': 45 * 60_000,
    '30m': 90 * 60_000,
    '1h': 150 * 60_000,
    '2h': 5 * 60 * 60_000,
    '4h': 10 * 60 * 60_000,
    '1d': 48 * 60 * 60_000,
  };
  const MAX_STALE_MS = intervalToMaxAge[interval] || 5 * 60_000;
  if (lastBarAge > MAX_STALE_MS) {
    console.warn(`[WS][STALE_CACHE] ${symbol} ${interval}: Last bar is ${Math.round(lastBarAge / 60_000)}min old (max: ${Math.round(MAX_STALE_MS / 60_000)}min), cache stale`);
    return null;
  }

  // 🛡️ GAP DETECTION: Strip candles before any gap to prevent corrupt indicators (SMA200, ATR, etc.)
  const contiguous = stripGappedPrefix(klines, interval);

  return contiguous.map(k => ({
    timestamp: k.timestamp,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    isFinal: k.isFinal ?? true, // Historical candles are always final
  }));
}

export function getKlinesOhlcvFromWebSocket(symbol: string, interval: string): number[][] | null {
  const ws = getBinanceWebSocket();
  const klines = ws.getKlines(symbol, interval);
  if (!klines?.length) return null;
  
  // 🎯 ADAPTIVE staleness check: Adjust threshold based on candle timeframe
  // - 1m/5m/15m candles: Allow 2 full bars as tolerance for reconnection delays
  // - 1h+ candles: max 1.5-2 bars age
  // This ensures we detect WebSocket disconnections WITHOUT rejecting valid historical data
  const lastKline = klines[klines.length - 1];
  const lastBarAge = Date.now() - lastKline.timestamp;
  
  // Map interval to max acceptable age (in milliseconds)
  // For 15m candles: Allow up to 45 min (3 bars) to handle reconnect delays
  const intervalToMaxAge: Record<string, number> = {
    '1m': 5 * 60_000,       // 5 minutes (5 bars)
    '3m': 12 * 60_000,      // 12 minutes (4 bars)
    '5m': 20 * 60_000,      // 20 minutes (4 bars)
    '15m': 45 * 60_000,     // 45 minutes (3 bars) - increased from 25min
    '30m': 90 * 60_000,     // 90 minutes (3 bars)
    '1h': 150 * 60_000,     // 2.5 hours (2.5 bars)
    '2h': 5 * 60 * 60_000,  // 5 hours (2.5 bars)
    '4h': 10 * 60 * 60_000, // 10 hours (2.5 bars)
    '1d': 48 * 60 * 60_000, // 48 hours (2 bars)
  };
  
  const MAX_STALE_MS = intervalToMaxAge[interval] || 5 * 60_000; // Default: 5 minutes
  
  if (lastBarAge > MAX_STALE_MS) {
    // Data is stale (WebSocket likely disconnected), force REST fallback
    console.warn(`[WS][STALE_CACHE] ${symbol} ${interval}: Last bar is ${Math.round(lastBarAge / 60_000)}min old (max: ${Math.round(MAX_STALE_MS / 60_000)}min), cache stale`);
    return null;
  }
  
  // 🛡️ GAP DETECTION: Strip candles before any gap to prevent corrupt indicators
  const contiguous = stripGappedPrefix(klines, interval);

  // ✅ Data is fresh - return contiguous klines only
  return contiguous.map(k => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]);
}

/**
 * 💰 Get Balance from WebSocket (0 weight)
 * 
 * Uses user data stream for real-time balance updates.
 * Requires listenKey to be active.
 * 
 * @param userId - User ID for multi-user support
 * @param asset - Asset symbol (default: 'USDT')
 * @returns Balance data or null if not available
 */
export async function getBalanceFromWebSocket(userId: string, asset: string = 'USDT'): Promise<BinanceBalance | null> {
  const ws = getBinanceWebSocket();
  return ws.getBalance(userId, asset);
}

/**
 * � Get Position from WebSocket (0 weight)
 * 
 * Uses user data stream for real-time position updates.
 * Returns cached position data from ACCOUNT_UPDATE events.
 * 
 * @param userId - User ID for multi-user support
 * @param symbol - Symbol in Binance format (e.g., "BTCUSDT") or unified format (e.g., "BTC/USDT:USDT")
 * @returns Position data or null if no position/not available
 */
export function getPositionFromWebSocket(userId: string, symbol: string): BinancePositionData | null {
  const ws = getBinanceWebSocket();
  return ws.getPosition(userId, symbol);
}

/**
 * 📊 Get All Positions from WebSocket (0 weight)
 * 
 * Returns all cached positions for a user.
 * 
 * @param userId - User ID
 * @returns Map of symbol -> position data
 */
export function getAllPositionsFromWebSocket(userId: string): Map<string, BinancePositionData> {
  const ws = getBinanceWebSocket();
  return ws.getAllPositions(userId);
}

/**
 * �🔌 Subscribe to User Data Stream (0 weight)
 * 
 * Subscribes to balance, orders, and trades updates.
 * Uses listenKey for authentication (0 weight).
 * 
 * @param userId - User ID
 * @param apiKey - Binance API key
 * @param apiSecret - Binance API secret
 */
export async function subscribeToUserData(userId: string, apiKey: string, apiSecret: string): Promise<void> {
  const ws = getBinanceWebSocket();
  await ws.subscribeToUserData(userId, apiKey, apiSecret);
}

export function seedBalanceCache(userId: string, asset: string, payload: { free: number; locked: number; total: number; timestamp?: number }): void {
  const ws = getBinanceWebSocket();
  ws.seedBalance(userId, asset, payload);
}

export function seedPositionCache(userId: string, symbol: string, payload: { 
  positionAmt: number; 
  entryPrice: number; 
  unrealizedPnl: number;
  marginType?: string;
  side?: 'long' | 'short';
  updateTime?: number;
}): void {
  const ws = getBinanceWebSocket();
  ws.seedPosition(userId, symbol, payload);
}

export function isPositionCacheSeeded(userId: string): boolean {
  const ws = getBinanceWebSocket();
  return ws.isPositionCacheSeeded(userId);
}

export function markPositionCacheSeeded(userId: string): void {
  const ws = getBinanceWebSocket();
  ws.markPositionCacheSeeded(userId);
}

export function isUserDataStreamActive(userId: string): boolean {
  const ws = getBinanceWebSocket();
  return ws.isUserDataStreamActive(userId);
}

export function getRecentOrderTradeUpdatesFromWebSocket(
  userId: string,
  symbol: string,
  options?: { sinceMs?: number; limit?: number }
): BinanceOrderTradeUpdate[] {
  const ws = getBinanceWebSocket();
  return ws.getRecentOrderTradeUpdates(userId, symbol, options);
}

export function getLastFilledOrderTradeUpdateFromWebSocket(
  userId: string,
  symbol: string,
  options?: { reduceOnly?: boolean; side?: 'BUY' | 'SELL' }
): BinanceOrderTradeUpdate | null {
  const ws = getBinanceWebSocket();
  return ws.getLastFilledOrderTradeUpdate(userId, symbol, options);
}

export function getOrderTradeUpdateByIdFromWebSocket(
  userId: string,
  orderId: string,
): BinanceOrderTradeUpdate | null {
  const ws = getBinanceWebSocket();
  return ws.getOrderTradeUpdateById(userId, orderId);
}

export function getUserDataStreamStatus(userId: string): { 
  connected: boolean; 
  hasListenKey: boolean;
  readyState: number | null;
  cacheAge: { balance: number | null; position: number | null };
} {
  const ws = getBinanceWebSocket();
  return ws.getUserDataStreamStatus(userId);
}
