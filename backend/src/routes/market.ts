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