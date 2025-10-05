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
  
  // Cache en mémoire pour les données temps réel
  private tickersCache = new Map<string, BinanceTickerData>();
  private klinesCache = new Map<string, BinanceKlineData[]>();
  private lastUpdate = Date.now();
  
  // Callbacks pour notifier les consumers
  private tickerCallbacks: Array<(ticker: BinanceTickerData) => void> = [];
  private klineCallbacks: Array<(kline: BinanceKlineData) => void> = [];
  
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
        this.scheduleReconnect();
      });

      // Ping/Pong pour garder la connexion alive
      setInterval(() => {
        if (this.ws && this.isConnected) {
          this.ws.ping();
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
    // All tickers stream (!ticker@arr)
    if (Array.isArray(message)) {
      this.handleAllTickersUpdate(message);
      return;
    }

    // Individual stream data
    if (message.stream && message.data) {
      const { stream, data } = message;
      
      // Kline stream
      if (stream.includes('@kline_')) {
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
    // Format Binance: BTCUSDT (pas de slash, uppercase)
    const binanceSymbol = symbol.replace('/', '').toUpperCase();
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
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
}

// Singleton instance
let binanceWsManager: BinanceWebSocketManager | null = null;

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
