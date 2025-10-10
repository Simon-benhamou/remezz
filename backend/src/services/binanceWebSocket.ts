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
import crypto from 'crypto';
import { getConfig } from '../utils/env.js';
import { evaluateTickerFrame } from '../data/tickerValidation.js';
import { recordMarketFrame, recordWsReconnect, setFallbackState, updateWsConnectionState } from '../monitor/marketMetrics.js';

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

export function toBinanceSymbolId(unified: string): string {
  const base = unified.split(':')[0] || unified;
  return base.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

const LAST_VALID_BID_ASK_TTL_MS = 20_000;
const SNAPSHOT_MIN_INTERVAL_MS = 1_500;

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
  private reconnectDelay = 5000; // 5 secondes
  private pingTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  
  // Cache en mémoire pour les données temps réel
  private tickersCache = new Map<string, BinanceTickerData>();
  private klinesCache = new Map<string, BinanceKlineData[]>();
  private balanceCache = new Map<string, BinanceBalance>();
  private lastUpdate = Date.now();
  
  // Callbacks pour notifier les consumers
  private tickerCallbacks: Array<(ticker: BinanceTickerData) => void> = [];
  private klineCallbacks: Array<(kline: BinanceKlineData) => void> = [];
  
  // User data stream management
  private userDataStreams = new Map<string, { ws: WebSocket | null; listenKey: string; userId: string; keepAliveTimer?: NodeJS.Timeout }>();
  private userDataSubscriptions = new Map<string, Promise<void>>();
  
  private isConnecting = false;
  private isConnected = false;
  private lastHealthy = false;
  private lastValidBidAsk = new Map<string, { bid: number; ask: number; ts: number }>();
  private snapshotCooldown = new Map<string, number>();
  
  // Streams actifs
  private activeStreams = new Set<string>();
  private desiredKlineStreams = new Map<string, { stream: string; symbol: string; interval: string }>();
  private throttledKlineStreams = new Set<string>();
  private readonly maxKlineStreams: number;

  private readonly endpoints = BINANCE_ENDPOINTS;

  constructor() {
    console.log('📡 Initializing Binance WebSocket Manager...');
    const envLimit = Number(process.env.BINANCE_MAX_KLINE_STREAMS || '30');
    this.maxKlineStreams = Math.max(5, Number.isFinite(envLimit) ? envLimit : 30);
    console.log(`📊 Binance WS manager limit: max ${this.maxKlineStreams} concurrent kline streams`);
  }

  private normalizeStreamSymbol(symbol: string): string {
    return toBinanceSymbolId(symbol).toLowerCase();
  }

  private normalizeCacheSymbol(symbol: string): string {
    return toBinanceSymbolId(symbol);
  }

  private klineCacheKey(symbol: string, interval: string): string {
    return `${this.normalizeCacheSymbol(symbol)}_${interval}`;
  }

  private enqueueKlineSubscription(symbol: string, interval: string): boolean {
    const streamSymbol = this.normalizeStreamSymbol(symbol);
    const stream = `${streamSymbol}@kline_${interval}`;
    if (this.desiredKlineStreams.has(stream)) return true;
    if (this.desiredKlineStreams.size >= this.maxKlineStreams) {
      this.throttledKlineStreams.add(stream);
      console.warn(`⚠️ Binance WS kline limit (${this.maxKlineStreams}) reached. Skipping live stream for ${symbol} ${interval}`);
      return false;
    }
    this.desiredKlineStreams.set(stream, { stream, symbol, interval });
    if (this.isConnected) {
      const ok = this.sendSubscription(stream, true);
      if (!ok) {
        this.desiredKlineStreams.delete(stream);
        return false;
      }
    }
    return true;
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
      if (isKline) this.throttledKlineStreams.delete(stream);
      return true;
    } catch (error) {
      console.error(`❌ Failed to subscribe to ${stream}:`, error);
      return false;
    }
  }

  private resubscribeKlines(): void {
    if (!this.ws || !this.isConnected) return;
    for (const { stream } of this.desiredKlineStreams.values()) {
      if (this.activeStreams.has(stream)) continue;
      this.sendSubscription(stream, true);
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
        this.isConnected = true;
      this.isConnecting = false;
      this.shuttingDown = false;
      this.reconnectAttempts = 0;
      this.activeStreams.clear();
      this.throttledKlineStreams.clear();
      recordWsReconnect('global');
       this.lastHealthy = false;
       updateWsConnectionState({ connected: true, healthy: false, reason: 'ws_open' });
        
        // Subscribe aux streams par défaut
        this.subscribeToAllTickers();
        this.resubscribeKlines();
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
      this.activeStreams.clear();
      this.throttledKlineStreams.clear();
      this.lastHealthy = false;
        updateWsConnectionState({ connected: false, healthy: false, reason: 'ws_close' });
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        if (!this.shuttingDown) {
          this.scheduleReconnect();
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

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(`🔄 Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay/1000}s...`);

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

  /**
   * Subscribe à un stream de klines (OHLCV) pour un symbole
   * 0 weight - Remplace fetchOHLCV (2 weight × n appels)
   */
  subscribeToKline(symbol: string, interval: string = '15m'): boolean {
    const cacheSymbol = this.normalizeCacheSymbol(symbol);
    const key = this.klineCacheKey(cacheSymbol, interval);
    if (!this.klinesCache.has(key)) {
      this.klinesCache.set(key, []);
    }
    return this.enqueueKlineSubscription(symbol, interval);
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

  /**
   * Update tous les tickers depuis le stream !ticker@arr
   */
  private handleAllTickersUpdate(tickers: any[]): void {
    const receivedTs = Date.now();
    let acceptedCount = 0;

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
        timestamp: timestampRaw ?? receivedTs,
      };

      const sanitization = this.sanitizeBidAsk(rawSymbol, tickerData, receivedTs);

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
          extra: { recovery: 'snapshot_requested', ...sanitization.extra },
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
        extra: sanitization.extra,
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
        continue;
      }

      acceptedCount += 1;
      for (const cb of this.tickerCallbacks) {
        try {
          cb(tickerData);
        } catch (error) {
          console.error('Error in ticker callback:', error);
        }
      }
    }

    this.lastUpdate = receivedTs;
    const isHealthy = acceptedCount > 0;
    if (isHealthy !== this.lastHealthy) {
      this.lastHealthy = isHealthy;
      updateWsConnectionState({
        connected: this.isConnected,
        healthy: isHealthy,
        reason: isHealthy ? 'ws_frames_accepted' : 'ws_frames_rejected',
      });
    }
    
    // Log stats périodiquement
    if (receivedTs % 60000 < 5000) { // ~toutes les minutes
      console.log(`📊 WebSocket cache: ${this.tickersCache.size} tickers, updated ${new Date(this.lastUpdate).toISOString()}`);
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
      const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${symbol}`);
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
   * Check si le WebSocket est connecté et le cache est frais
   */
  isHealthy(): boolean {
    if (!this.isConnected) return false;
    const cacheAge = Date.now() - this.lastUpdate;
    // Cache considéré frais si < 10 secondes
    return cacheAge < 10000 && this.tickersCache.size > 0 && this.lastHealthy;
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

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.activeStreams.clear();
    this.tickersCache.clear();
    this.klinesCache.clear();
    // Close any user data streams as well
    for (const [userId, stream] of this.userDataStreams.entries()) {
      try { stream.ws?.close(); } catch {}
      this.userDataStreams.delete(userId);
    }
  }

  seedKlines(symbol: string, interval: string, ohlcv: number[][]): void {
    if (!Array.isArray(ohlcv) || !ohlcv.length) return;

    const cacheSymbol = this.normalizeCacheSymbol(symbol);
    const key = this.klineCacheKey(cacheSymbol, interval);
    const limited = ohlcv.slice(-500);
    const seeded = limited.map((row) => ({
      symbol: cacheSymbol,
      timeframe: interval,
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    } satisfies BinanceKlineData));

    this.klinesCache.set(key, seeded);
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

            // ACCOUNT_UPDATE event (balance changes)
            if (msg.e === 'ACCOUNT_UPDATE') {
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
              console.log(`💰 Balance updated for user ${userId}: ${balances.length} assets`);
            }

            // ORDER_TRADE_UPDATE event (order updates)
            if (msg.e === 'ORDER_TRADE_UPDATE') {
              console.log(`📊 Order update for user ${userId}: ${msg.o?.s} ${msg.o?.S} ${msg.o?.X}`);
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

        // Step 3: Keep listenKey alive (every 30 minutes)
        const keepAliveInterval = setInterval(async () => {
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
              throw new Error(`Keep-alive failed (${keepAliveResponse.status}): ${errorText}`);
            }

            console.log(`✅ ListenKey kept alive for user ${userId}`);
          } catch (error) {
            console.error(`❌ Failed to keep listenKey alive for ${userId}:`, error);
            clearKeepAlive();
            this.userDataStreams.delete(userId);
            try { userWs.close(); } catch {}
            setTimeout(() => {
              this.subscribeToUserData(userId, apiKey, apiSecret).catch((err) => {
                console.error(`❌ Failed to resubscribe user data stream for ${userId}:`, err);
              });
            }, 1000);
          }
        }, 30 * 60 * 1000); // 30 minutes

        streamRecord.keepAliveTimer = keepAliveInterval;

        const cleanup = () => {
          clearKeepAlive();
          this.userDataStreams.delete(userId);
        };

        userWs.on('close', () => {
          console.log(`🔌 User data stream closed for user ${userId}`);
          cleanup();
        });

        userWs.on('error', () => {
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
   * 🔌 Unsubscribe from User Data Stream
   */
  unsubscribeFromUserData(userId: string): void {
    const stream = this.userDataStreams.get(userId);
    if (stream?.ws) {
      stream.ws.close();
      if (stream.keepAliveTimer) {
        clearInterval(stream.keepAliveTimer);
      }
    }
    this.userDataStreams.delete(userId);
    console.log(`🔌 Unsubscribed user ${userId} from user data stream`);
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

/**
 * Helper: Récupère un ticker via WebSocket avec fallback REST API
 */
export async function getTickerFromWebSocket(symbol: string): Promise<BinanceTickerData | null> {
  const ws = getBinanceWebSocket();

  if (!ws.isHealthy()) {
    console.warn(`⚠️ WebSocket not healthy for ${symbol}, fallback required`);
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

export function getKlinesOhlcvFromWebSocket(symbol: string, interval: string): number[][] | null {
  const ws = getBinanceWebSocket();
  const klines = ws.getKlines(symbol, interval);
  if (!klines?.length) return null;
  return klines.map(k => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]);
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
 * 🔌 Subscribe to User Data Stream (0 weight)
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
