/**
 * Crypto Ranking API Routes
 * Provides AI-powered crypto ranking and analysis
 */
import { Router } from 'express';
import { getAIRankedOpportunities } from '../ai/cryptoRanking.js';

const router = Router();

/**
 * GET /api/crypto/ranking
 * Returns AI-ranked crypto opportunities with technical analysis
 * Query params:
 *   - limit: number of results (default: 20)
 *   - refresh: force refresh of cached data (default: false)
 */
router.get('/ranking', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const refresh = req.query.refresh === 'true';

    const ranking = await getAIRankedOpportunities({
      useCache: !refresh,
      forceRefresh: refresh,
    });

    // Apply limit after getting results
    const limited = ranking.slice(0, limit);

    res.json(limited);
  } catch (error: any) {
    console.error('[CryptoRanking] Error:', error);
    res.status(500).json({
      error: 'Failed to fetch crypto ranking',
      message: error.message,
    });
  }
});

export default router;
