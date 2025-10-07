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
  private userDataStreams = new Map<string, { ws: WebSocket | null; listenKey: string; userId: string }>();
  private userDataSubscriptions = new Map<string, Promise<void>>();
  
  private isConnecting = false;
  private isConnected = false;
  
  // Streams actifs
  private activeStreams = new Set<string>();
  private desiredKlineStreams = new Map<string, { stream: string; symbol: string; interval: string }>();

  constructor() {
    console.log('📡 Initializing Binance WebSocket Manager...');
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

  private enqueueKlineSubscription(symbol: string, interval: string): void {
    const streamSymbol = this.normalizeStreamSymbol(symbol);
    const stream = `${streamSymbol}@kline_${interval}`;
    this.desiredKlineStreams.set(stream, { stream, symbol, interval });
    if (this.isConnected) {
      this.sendSubscription(stream);
    }
  }

  private sendSubscription(stream: string): void {
    if (!this.ws || !this.isConnected) return;
    if (this.activeStreams.has(stream)) return;

    const payload = {
      method: 'SUBSCRIBE',
      params: [stream],
      id: Date.now(),
    };

    try {
      this.ws.send(JSON.stringify(payload));
      this.activeStreams.add(stream);
      console.log(`📡 Subscribed to stream ${stream}`);
    } catch (error) {
      console.error(`❌ Failed to subscribe to ${stream}:`, error);
    }
  }

  private resubscribeKlines(): void {
    if (!this.ws || !this.isConnected) return;
    for (const { stream } of this.desiredKlineStreams.values()) {
      this.sendSubscription(stream);
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
      const wsUrl = 'wss://fstream.binance.com/stream';
      
      console.log(`📡 Connecting to Binance WebSocket: ${wsUrl}`);
      
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('✅ Binance WebSocket connected');
        this.isConnected = true;
        this.isConnecting = false;
        this.shuttingDown = false;
        this.reconnectAttempts = 0;
        this.activeStreams.clear();
        
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
      });

      this.ws.on('close', () => {
        console.log('🔌 Binance WebSocket closed');
        this.isConnected = false;
        this.isConnecting = false;
        this.activeStreams.clear();
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
  subscribeToKline(symbol: string, interval: string = '15m'): void {
    const cacheSymbol = this.normalizeCacheSymbol(symbol);
    const key = this.klineCacheKey(cacheSymbol, interval);
    if (!this.klinesCache.has(key)) {
      this.klinesCache.set(key, []);
    }

    this.enqueueKlineSubscription(symbol, interval);
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
    const now = Date.now();
    
    for (const ticker of tickers) {
      // Format Binance miniTicker
      const tickerData: BinanceTickerData = {
        symbol: ticker.s, // e.g., "BTCUSDT"
        last: parseFloat(ticker.c), // close price
        bid: parseFloat(ticker.b), // best bid
        ask: parseFloat(ticker.a), // best ask
        percentage: parseFloat(ticker.P), // price change percent
        baseVolume: parseFloat(ticker.v), // base volume
        quoteVolume: parseFloat(ticker.q), // quote volume
        high: parseFloat(ticker.h), // high price
        low: parseFloat(ticker.l), // low price
        open: parseFloat(ticker.o), // open price
        timestamp: ticker.E, // event time
      };

      this.tickersCache.set(ticker.s, tickerData);
      
      // Notify callbacks
      this.tickerCallbacks.forEach(cb => {
        try {
          cb(tickerData);
        } catch (error) {
          console.error('Error in ticker callback:', error);
        }
      });
    }

    this.lastUpdate = now;
    
    // Log stats périodiquement
    if (now % 60000 < 5000) { // ~toutes les minutes
      console.log(`📊 WebSocket cache: ${this.tickersCache.size} tickers, updated ${new Date(this.lastUpdate).toISOString()}`);
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
    return cacheAge < 10000 && this.tickersCache.size > 0;
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
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = crypto
          .createHmac('sha256', apiSecret)
          .update(queryString)
          .digest('hex');

        const listenKeyUrl = `https://fapi.binance.com/fapi/v1/listenKey?${queryString}&signature=${signature}`;
        const response = await fetch(listenKeyUrl, {
          method: 'POST',
          headers: { 'X-MBX-APIKEY': apiKey }
        });

        if (!response.ok) {
          throw new Error(`Failed to create listenKey: ${await response.text()}`);
        }

        const { listenKey } = await response.json();
        console.log(`✅ Created listenKey for user ${userId}: ${listenKey.substring(0, 10)}...`);

        // Step 2: Connect to user data stream
        const wsUrl = `wss://fstream.binance.com/ws/${listenKey}`;
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
                
                const balanceData: BinanceBalance = {
                  asset,
                  free: wb - cw, // Free = wallet - cross
                  locked: cw,
                  total: wb,
                  timestamp: Date.now()
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

        userWs.on('close', () => {
          console.log(`🔌 User data stream closed for user ${userId}`);
          this.userDataStreams.delete(userId);
        });

        // Store stream reference
        this.userDataStreams.set(userId, { ws: userWs, listenKey, userId });

        // Step 3: Keep listenKey alive (every 30 minutes)
        const keepAliveInterval = setInterval(async () => {
          try {
            const keepAliveTimestamp = Date.now();
            const keepAliveQuery = `timestamp=${keepAliveTimestamp}`;
            const keepAliveSignature = crypto
              .createHmac('sha256', apiSecret)
              .update(keepAliveQuery)
              .digest('hex');

            const keepAliveUrl = `https://fapi.binance.com/fapi/v1/listenKey?${keepAliveQuery}&signature=${keepAliveSignature}`;
            await fetch(keepAliveUrl, {
              method: 'PUT',
              headers: { 'X-MBX-APIKEY': apiKey }
            });

            console.log(`✅ ListenKey kept alive for user ${userId}`);
          } catch (error) {
            console.error(`❌ Failed to keep listenKey alive for ${userId}:`, error);
          }
        }, 30 * 60 * 1000); // 30 minutes

        // Clean up on close
        userWs.on('close', () => {
          clearInterval(keepAliveInterval);
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
    const balanceData: BinanceBalance = {
      asset: normalizedAsset,
      free: Number(payload.free) || 0,
      locked: Number(payload.locked) || 0,
      total: Number(payload.total) || 0,
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
      this.userDataStreams.delete(userId);
      console.log(`🔌 Unsubscribed user ${userId} from user data stream`);
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

/**
 * Helper: Récupère un ticker via WebSocket avec fallback REST API
 */
export async function getTickerFromWebSocket(symbol: string): Promise<BinanceTickerData | null> {
  const ws = getBinanceWebSocket();
  
  // Si le WebSocket est healthy, utilise le cache
  if (ws.isHealthy()) {
    const ticker = ws.getTicker(symbol);
    if (ticker) {
      return ticker;
    }
  }
  
  // Fallback: retourne null, le caller fera un fetchTicker REST
  console.warn(`⚠️ WebSocket cache miss for ${symbol}, will fallback to REST API`);
  return null;
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
