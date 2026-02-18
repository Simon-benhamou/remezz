import { Router } from 'express';
import type { PrismaClient } from '.prisma/client';
import { getPolymarketLiveState, getPolymarketStats } from '../services/polymarket/polymarketWorker.js';

export function createPolymarketRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET /status — live window state (polled every 3-5s by frontend)
  router.get('/status', (_req, res) => {
    const state = getPolymarketLiveState();
    res.json(state);
  });

  // GET /stats — aggregated KPIs
  router.get('/stats', async (_req, res) => {
    try {
      const stats = await getPolymarketStats(prisma);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // GET /history — recent predictions
  router.get('/history', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const predictions = await prisma.polymarketPrediction.findMany({
        orderBy: { windowStart: 'desc' },
        take: limit,
      });
      res.json({ predictions });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  });

  return router;
}
