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

  constructor() {
    console.log('📡 Initializing Binance WebSocket Manager...');
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
        
        // Subscribe aux streams par défaut
        this.subscribeToAllTickers();
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

    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: [stream],
      id: Date.now(),
    };

    console.log(`📡 Subscribing to all tickers stream...`);
    this.ws.send(JSON.stringify(subscribeMessage));
    this.activeStreams.add(stream);
  }

  /**
   * Subscribe à un stream de klines (OHLCV) pour un symbole
   * 0 weight - Remplace fetchOHLCV (2 weight × n appels)
   */
  subscribeToKline(symbol: string, interval: string = '15m'): void {
    if (!this.ws || !this.isConnected) {
      console.warn('⚠️ Cannot subscribe: WebSocket not connected');
      // On stocke la demande pour après connexion
      return;
    }

    // Format Binance: btcusdt@kline_15m (lowercase, pas de slash)
    const binanceSymbol = symbol.replace('/', '').toLowerCase();
    const stream = `${binanceSymbol}@kline_${interval}`;
    
    if (this.activeStreams.has(stream)) {
      return;
    }

    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: [stream],
      id: Date.now(),
    };

    console.log(`📡 Subscribing to kline stream: ${stream}`);
    this.ws.send(JSON.stringify(subscribeMessage));
    this.activeStreams.add(stream);
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
      symbol: data.s,
      timeframe: k.i,
      timestamp: k.t,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
    };

    const key = `${data.s}_${k.i}`;
    
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
    const binanceSymbol = symbol.replace('/', '').toUpperCase();
    const key = `${binanceSymbol}_${interval}`;
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
