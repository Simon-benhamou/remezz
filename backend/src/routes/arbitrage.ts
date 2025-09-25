import { Router } from 'express';
import { getArbitrageSpreads } from '../arbitrage/spreadScanner.js';

export const router = Router();

router.get('/spreads', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true';
    const spreads = await getArbitrageSpreads({ forceRefresh: refresh });
    res.json({ spreads, refreshedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Arbitrage spreads error:', error);
    res.status(500).json({ error: 'failed_to_fetch_spreads', details: String((error as any)?.message || error) });
  }
});

export default router;
