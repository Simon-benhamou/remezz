import { Router } from 'express';
import type { PrismaClient } from '.prisma/client';
import { authenticateUser, type AuthenticatedRequest } from '../middleware/auth.js';
import { getPolymarketLiveState, getPolymarketStats } from '../services/polymarket/polymarketWorker.js';
import {
  getPolymarketConfig,
  savePolymarketConfig,
  savePolymarketCredentials,
  deletePolymarketCredentials,
  validatePolymarketCredentials,
  getPolymarketBalance,
} from '../services/polymarket/polymarketTrader.js';

export function createPolymarketRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── Public endpoints (polled by frontend) ─────────────────────────────────

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

  // ── Authenticated endpoints (settings / trading) ──────────────────────────

  // GET /settings — current polymarket trading config
  router.get('/settings', authenticateUser, async (_req: AuthenticatedRequest, res) => {
    try {
      const config = await getPolymarketConfig(prisma);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // PUT /settings — save mode + amount
  router.put('/settings', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { mode, amount } = req.body;
      if (!mode || !['virtual', 'live'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode (virtual or live)' });
      }
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount < 1) {
        return res.status(400).json({ error: 'Amount must be at least $1' });
      }

      // If switching to live, validate credentials exist
      if (mode === 'live') {
        const config = await getPolymarketConfig(prisma);
        if (!config.hasCredentials) {
          return res.status(400).json({ error: 'Save valid API credentials before enabling live mode' });
        }
      }

      await savePolymarketConfig(prisma, mode, parsedAmount);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // PUT /credentials — save encrypted API credentials
  router.put('/credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { privateKey, apiKey, apiSecret, apiPassphrase } = req.body;
      if (!privateKey || !apiKey || !apiSecret || !apiPassphrase) {
        return res.status(400).json({ error: 'All 4 fields required (privateKey, apiKey, apiSecret, apiPassphrase)' });
      }
      await savePolymarketCredentials(prisma, privateKey, apiKey, apiSecret, apiPassphrase);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save credentials' });
    }
  });

  // DELETE /credentials — remove all credentials and reset to virtual
  router.delete('/credentials', authenticateUser, async (_req: AuthenticatedRequest, res) => {
    try {
      await deletePolymarketCredentials(prisma);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete credentials' });
    }
  });

  // POST /validate-credentials — test credentials are valid
  router.post('/validate-credentials', authenticateUser, async (_req: AuthenticatedRequest, res) => {
    try {
      const result = await validatePolymarketCredentials(prisma);
      res.json(result);
    } catch (err) {
      res.status(500).json({ valid: false, error: 'Validation failed' });
    }
  });

  // GET /balance — USDC balance on Polymarket
  router.get('/balance', authenticateUser, async (_req: AuthenticatedRequest, res) => {
    try {
      const result = await getPolymarketBalance(prisma);
      res.json(result);
    } catch (err) {
      res.status(500).json({ balance: 0, error: 'Failed to fetch balance' });
    }
  });

  return router;
}
