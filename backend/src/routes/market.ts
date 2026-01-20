import { Router } from 'express';
import { getTicker } from '../data/market.js';

export const router = Router();

// ============================================================================
// V5.73: OHLCV Request Deduplication & Caching
// Prevents IP bans from rapid chart timeframe switches
// ============================================================================
const OHLCV_CACHE_TTL_MS = 10_000; // 10 second cache for chart data
const ohlcvCache = new Map<string, { data: any; timestamp: number }>();
const ohlcvInflight = new Map<string, Promise<any>>(); // Dedupe in-flight requests

function getOhlcvCacheKey(symbol: string, timeframe: string, limit: number): string {
  return `${symbol}:${timeframe}:${limit}`;
}

// Get live ticker data for a symbol (POST to handle symbols with slashes)
router.post('/ticker', async (req, res) => {
  try {
    const { symbol } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required in request body' });
    }
    
    const ticker = await getTicker(symbol);

    if (!ticker || typeof ticker !== 'object') {
      throw new Error('invalid_ticker_response');
    }
    if (ticker.bid === 0 || ticker.ask === 0 || ticker.last === 0) {
      throw new Error('ticker_validation_failed');
    }
    
    // Add timestamp for frontend caching
    const response = {
      ...ticker,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString(),
      // Ensure all fields are present for frontend
      symbol: ticker.symbol || symbol,
      last: ticker.last || 0,
      bid: ticker.bid || 0,
      ask: ticker.ask || 0,
      high: ticker.high || 0,
      low: ticker.low || 0,
      change: ticker.change || 0,
      percentage: ticker.percentage || 0,
      baseVolume: ticker.baseVolume || 0,
      quoteVolume: ticker.quoteVolume || 0
    };
    
    res.json(response);
  } catch (err) {
    console.error('Failed to get ticker:', err);
    return res.status(502).json({
      error: 'ticker_unavailable',
      details: String((err as any)?.message || err)
    });
    
    // Fallback with basic data to prevent UI from breaking
    const fallbackTicker = {
      symbol: req.body.symbol,
      last: 0,
      bid: 0,
      ask: 0,
      high: 0,
      low: 0,
      change: 0,
      percentage: 0,
      baseVolume: 0,
      quoteVolume: 0,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString(),
      error: String((err as any)?.message || err),
      note: 'Fallback data - ticker fetch failed'
    };
    
    res.json(fallbackTicker);
  }
});

// Keep the old GET method for backward compatibility (URL encode the symbol)
router.get('/ticker/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required' });
    }
    
    // Decode the URL-encoded symbol
    const decodedSymbol = decodeURIComponent(symbol);
    const ticker = await getTicker(decodedSymbol);
    
    // Add timestamp for frontend caching
    const response = {
      ...ticker,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString(),
      // Ensure all fields are present for frontend
      symbol: ticker.symbol || decodedSymbol,
      last: ticker.last || 0,
      bid: ticker.bid || 0,
      ask: ticker.ask || 0,
      high: ticker.high || 0,
      low: ticker.low || 0,
      change: ticker.change || 0,
      percentage: ticker.percentage || 0,
      baseVolume: ticker.baseVolume || 0,
      quoteVolume: ticker.quoteVolume || 0
    };
    
    res.json(response);
  } catch (err) {
    console.error('Failed to get ticker:', err);
    
    // Fallback with basic data to prevent UI from breaking
    const fallbackTicker = {
      symbol: decodeURIComponent(req.params.symbol),
      last: 0,
      bid: 0,
      ask: 0,
      high: 0,
      low: 0,
      change: 0,
      percentage: 0,
      baseVolume: 0,
      quoteVolume: 0,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString(),
      error: String((err as any)?.message || err),
      note: 'Fallback data - ticker fetch failed'
    };
    
    res.json(fallbackTicker);
  }
});

// Get live ticker data for multiple symbols
router.post('/tickers', async (req, res) => {
  try {
    const { symbols } = req.body as { symbols: string[] };
    
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: 'Symbols array is required' });
    }
    
    const tickers: any = {};
    const timestamp = Date.now();
    const lastUpdate = new Date().toISOString();
    
    // Fetch all tickers in parallel
    await Promise.allSettled(
      symbols.map(async (symbol) => {
        try {
          const ticker = await getTicker(symbol);
          tickers[symbol] = {
            ...ticker,
            timestamp,
            lastUpdate
          };
        } catch (err) {
          console.error(`Failed to get ticker for ${symbol}:`, err);
          tickers[symbol] = {
            error: String((err as any)?.message || err),
            timestamp,
            lastUpdate
          };
        }
      })
    );
    
    res.json({
      tickers,
      timestamp,
      lastUpdate
    });
  } catch (err) {
    console.error('Failed to get tickers:', err);
    res.status(500).json({ 
      error: 'Failed to get ticker data', 
      details: String((err as any)?.message || err) 
    });
  }
});

// Get 24h historical OHLCV data for chart initialization (POST to handle symbols with slashes)
router.post('/history', async (req, res) => {
  try {
    const { symbol } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required in request body' });
    }
    
    const { getOHLCV } = await import('../data/market.js');
    const { resolveSymbol } = await import('../exchange/ccxtClient.js');
    
    // Resolve symbol and get 24h of 1h candles (24 candles for 24h)
    const resolvedSymbol = await resolveSymbol(symbol);
    const timeframe = '1h';
    const limit = 24; // 24h of 1h candles
    
    const ohlcv = await getOHLCV(resolvedSymbol, timeframe, limit);
    
    // Convert to lightweight-charts format
    const chartData = ohlcv.map((candle) => ({
      time: Math.floor(candle[0] / 1000), // timestamp in seconds
      value: candle[4] // close price
    }));
    
    res.json({
      symbol: resolvedSymbol,
      timeframe,
      data: chartData,
      count: chartData.length,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to get historical data:', err);
    
    // Fallback to mock data if CCXT fails
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const mockData: Array<{time: number, value: number}> = [];
    
    let basePrice = 4527.60; // ETH price fallback
    const volatility = 0.02; // 2% volatility per hour
    
    for (let i = 0; i < 24; i++) {
      const timestamp = Math.floor((oneDayAgo + i * 60 * 60 * 1000) / 1000);
      const change = (Math.random() - 0.5) * volatility * basePrice;
      basePrice = Math.max(basePrice + change, 1);
      
      mockData.push({
        time: timestamp,
        value: Number(basePrice.toFixed(2))
      });
    }
    
    res.json({
      symbol: req.body.symbol,
      timeframe: '1h',
      data: mockData,
      count: mockData.length,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString(),
      note: 'Fallback mock data - CCXT failed',
      error: String((err as any)?.message || err)
    });
  }
});

// Get OHLCV candlestick data for professional chart
// V5.73: Added caching and request deduplication to prevent IP bans
router.post('/ohlcv', async (req, res) => {
  try {
    const { symbol, timeframe = '15m', limit: requestedLimit = 300 } = req.body;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required in request body' });
    }

    // V5.73: Cap the limit to prevent excessive REST calls
    // 1m candles: max 200 (enough for ~3h of data)
    // 15m candles: max 200 (enough for ~50h of data)
    // 1h+ candles: max 300
    const maxLimitByTimeframe: Record<string, number> = {
      '1m': 200,
      '5m': 200,
      '15m': 200,
      '1h': 300,
      '4h': 300,
    };
    const maxLimit = maxLimitByTimeframe[timeframe] || 300;
    const limit = Math.min(requestedLimit, maxLimit);

    const { getOHLCV } = await import('../data/market.js');
    const { resolveSymbol } = await import('../exchange/ccxtClient.js');

    // Resolve symbol
    const resolvedSymbol = await resolveSymbol(symbol);
    const cacheKey = getOhlcvCacheKey(resolvedSymbol, timeframe, limit);

    // V5.73: Check cache first
    const cached = ohlcvCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp) < OHLCV_CACHE_TTL_MS) {
      return res.json({
        ...cached.data,
        fromCache: true,
        cacheAge: now - cached.timestamp,
      });
    }

    // V5.73: Check for in-flight request (deduplication)
    let dataPromise = ohlcvInflight.get(cacheKey);
    if (!dataPromise) {
      // No in-flight request, create new one
      dataPromise = (async () => {
        const ohlcv = await getOHLCV(resolvedSymbol, timeframe, limit);

        // Convert to candlestick format
        const candleData = ohlcv.map((candle: number[]) => ({
          timestamp: new Date(candle[0]).toISOString(),
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[5]
        }));

        return {
          symbol: resolvedSymbol,
          timeframe,
          data: candleData,
          count: candleData.length,
          timestamp: Date.now(),
          lastUpdate: new Date().toISOString()
        };
      })();

      ohlcvInflight.set(cacheKey, dataPromise);

      // Clean up after request completes
      dataPromise.finally(() => {
        ohlcvInflight.delete(cacheKey);
      });
    }

    const responseData = await dataPromise;

    // V5.73: Cache the result
    ohlcvCache.set(cacheKey, { data: responseData, timestamp: Date.now() });

    // Clean old cache entries periodically
    if (ohlcvCache.size > 50) {
      for (const [key, entry] of ohlcvCache.entries()) {
        if ((now - entry.timestamp) > OHLCV_CACHE_TTL_MS * 3) {
          ohlcvCache.delete(key);
        }
      }
    }

    res.json(responseData);
  } catch (err) {
    console.error('Failed to get OHLCV data:', err);
    res.status(502).json({
      error: 'ohlcv_unavailable',
      details: String((err as any)?.message || err)
    });
  }
});

// Keep GET method for backward compatibility (URL encode the symbol)
router.get('/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required' });
    }
    
    const decodedSymbol = decodeURIComponent(symbol);
    const { getOHLCV } = await import('../data/market.js');
    const { resolveSymbol } = await import('../exchange/ccxtClient.js');
    
    // Resolve symbol and get 24h of 1h candles (24 candles for 24h)
    const resolvedSymbol = await resolveSymbol(decodedSymbol);
    const timeframe = '1h';
    const limit = 24; // 24h of 1h candles
    
    const ohlcv = await getOHLCV(resolvedSymbol, timeframe, limit);
    
    // Convert to lightweight-charts format
    const chartData = ohlcv.map((candle) => ({
      time: Math.floor(candle[0] / 1000), // timestamp in seconds
      value: candle[4] // close price
    }));
    
    res.json({
      symbol: resolvedSymbol,
      timeframe,
      data: chartData,
      count: chartData.length,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to get historical data:', err);
    
    // Fallback to mock data if CCXT fails
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const mockData: Array<{time: number, value: number}> = [];
    
    let basePrice = 4527.60; // ETH price fallback
    const volatility = 0.02; // 2% volatility per hour
    
    for (let i = 0; i < 24; i++) {
      const timestamp = Math.floor((oneDayAgo + i * 60 * 60 * 1000) / 1000);
      const change = (Math.random() - 0.5) * volatility * basePrice;
      basePrice = Math.max(basePrice + change, 1);
      
      mockData.push({
        time: timestamp,
        value: Number(basePrice.toFixed(2))
      });
    }
    
    res.json({
      symbol: decodeURIComponent(req.params.symbol),
      timeframe: '1h',
      data: mockData,
      count: mockData.length,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString(),
      note: 'Fallback mock data - CCXT failed',
      error: String((err as any)?.message || err)
    });
  }
});
