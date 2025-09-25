import { Router } from 'express';
import { getArbitrageSpreads } from '../arbitrage/spreadScanner.js';
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

export default router;
