import { Router } from 'express';
import { getTicker } from '../data/market.js';

export const router = Router();

// Get live ticker data for a symbol
router.get('/ticker/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required' });
    }
    
    const ticker = await getTicker(symbol);
    
    // Add timestamp for frontend caching
    const response = {
      ...ticker,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString()
    };
    
    res.json(response);
  } catch (err) {
    console.error('Failed to get ticker:', err);
    res.status(500).json({ 
      error: 'Failed to get ticker data', 
      details: String((err as any)?.message || err) 
    });
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

// Get 24h historical OHLCV data for chart initialization
router.get('/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol parameter is required' });
    }
    
    // For now, return mock historical data until we fix the exchange import
    // This will give you a chart with realistic-looking data
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const mockData: Array<{time: number, value: number}> = [];
    
    // Generate 1440 points (1 per minute for 24h) with realistic price movement
    let basePrice = 242.47; // SOL price from your screenshot
    const volatility = 0.003; // 0.3% volatility per minute
    
    for (let i = 0; i < 1440; i++) {
      const timestamp = Math.floor((oneDayAgo + i * 60 * 1000) / 1000);
      // Random walk with some trending
      const change = (Math.random() - 0.5) * volatility * basePrice;
      basePrice = Math.max(basePrice + change, 1); // Prevent negative prices
      
      mockData.push({
        time: timestamp,
        value: Number(basePrice.toFixed(4))
      });
    }
    
    res.json({
      symbol,
      timeframe: '1m',
      data: mockData,
      count: mockData.length,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString(),
      note: 'Mock data - will be replaced with real CCXT data'
    });
  } catch (err) {
    console.error('Failed to get historical data:', err);
    res.status(500).json({ 
      error: 'Failed to get historical data', 
      details: String((err as any)?.message || err) 
    });
  }
});