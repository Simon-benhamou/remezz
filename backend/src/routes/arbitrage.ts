import { Router } from 'express';
import { getArbitrageSpreads, clearArbitrageCache, clearExchangeCache, getExchangeStatus } from '../arbitrage/spreadScanner.js';
import { getLastArbitrageSnapshot } from '../services/arbitrageMonitor.js';
import { getConfig } from '../utils/env.js';

export const router = Router();

router.get('/spreads', async (req, res) => {
  try {
    const cfg = getConfig();
    if (!cfg.ARBITRAGE_ENABLED) {
      return res.json({ spreads: [], generatedAt: null, disabled: true });
    }
    const refresh = req.query.refresh === 'true';
    if (!refresh) {
      const last = getLastArbitrageSnapshot();
      if (last) return res.json(last);
    }
    const spreads = await getArbitrageSpreads({ forceRefresh: refresh });
    const payload = { spreads, generatedAt: new Date().toISOString() };
    res.json(payload);
  } catch (error) {
    console.error('Arbitrage spreads error:', error);
    res.status(500).json({ error: 'failed_to_fetch_spreads', details: String((error as any)?.message || error) });
  }
});

// Get exchange status and configuration
router.get('/status', (req, res) => {
  try {
    const cfg = getConfig();
    const exchangeStatus = getExchangeStatus();

    res.json({
      enabled: cfg.ARBITRAGE_ENABLED,
      exchanges: cfg.ARBITRAGE_EXCHANGES,
      symbols: cfg.ARBITRAGE_SYMBOLS,
      exchangeStatus,
      config: {
        pollIntervalSec: cfg.ARBITRAGE_POLL_INTERVAL_SEC,
        cacheTtlSec: cfg.ARBITRAGE_CACHE_TTL_SEC,
        minSpreadBps: cfg.ARBITRAGE_MIN_SPREAD_BPS,
        maxResults: cfg.ARBITRAGE_MAX_RESULTS,
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get arbitrage status' });
  }
});

// Clear all caches
router.post('/clear-cache', (req, res) => {
  try {
    clearArbitrageCache();
    clearExchangeCache();
    res.json({
      success: true,
      message: 'All arbitrage caches cleared',
      clearedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear caches' });
  }
});

export default router;
