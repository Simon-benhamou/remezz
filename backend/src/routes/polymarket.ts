import { Router } from 'express';
import type { PrismaClient } from '.prisma/client';
import { authenticateUser, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  getPolymarketLiveState,
  getPolymarketStats,
  startPolymarketWorker,
  stopPolymarketWorker,
  isPolymarketWorkerRunning,
  getUnredeemedTokens,
} from '../services/polymarket/polymarketWorker.js';
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

  // GET /stats — aggregated KPIs (scoped by user)
  router.get('/stats', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const stats = await getPolymarketStats(prisma, req.user!.id);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // GET /history — recent predictions (scoped by user)
  router.get('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const predictions = await prisma.polymarketPrediction.findMany({
        where: { userId: req.user!.id },
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
  router.get('/settings', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const config = await getPolymarketConfig(prisma, req.user!.id);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // PUT /settings — save mode + amount + hedgeAmount
  router.put('/settings', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { mode, amount, hedgeAmount } = req.body;
      if (!mode || !['virtual', 'live'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode (virtual or live)' });
      }
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount < 1) {
        return res.status(400).json({ error: 'Amount must be at least $1' });
      }
      const parsedHedge = parseFloat(hedgeAmount ?? '1');
      if (isNaN(parsedHedge) || parsedHedge < 0) {
        return res.status(400).json({ error: 'Hedge amount must be >= $0' });
      }

      // If switching to live, validate credentials exist
      if (mode === 'live') {
        const config = await getPolymarketConfig(prisma, req.user!.id);
        if (!config.hasCredentials) {
          return res.status(400).json({ error: 'Save valid API credentials before enabling live mode' });
        }
      }

      await savePolymarketConfig(prisma, req.user!.id, mode, parsedAmount, parsedHedge);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // PUT /credentials — save wallet private key (API creds are auto-derived)
  router.put('/credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { privateKey, proxyAddress } = req.body;
      if (!privateKey || typeof privateKey !== 'string' || !privateKey.trim()) {
        return res.status(400).json({ error: 'Private key is required' });
      }
      const result = await savePolymarketCredentials(
        prisma,
        req.user!.id,
        privateKey.trim(),
        proxyAddress?.trim() || undefined,
      );
      res.json({ success: true, address: result.address });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to save credentials' });
    }
  });

  // DELETE /credentials — remove all credentials and reset to virtual
  router.delete('/credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      await deletePolymarketCredentials(prisma, req.user!.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete credentials' });
    }
  });

  // POST /validate-credentials — test credentials are valid
  router.post('/validate-credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await validatePolymarketCredentials(prisma, req.user!.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ valid: false, error: 'Validation failed' });
    }
  });

  // DELETE /history — reset predictions for this user
  router.delete('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { count } = await prisma.polymarketPrediction.deleteMany({
        where: { userId: req.user!.id },
      });
      res.json({ success: true, deleted: count });
    } catch (err) {
      res.status(500).json({ error: 'Failed to reset predictions' });
    }
  });

  // GET /balance — USDC balance on Polymarket
  router.get('/balance', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await getPolymarketBalance(prisma, req.user!.id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ balance: 0, error: 'Failed to fetch balance' });
    }
  });

  // GET /unredeemed — unredeemed winning tokens queue (per-user)
  router.get('/unredeemed', authenticateUser, (req: AuthenticatedRequest, res) => {
    const tokens = getUnredeemedTokens(req.user!.id);
    const totalStuckUsdc = tokens.reduce((sum, t) => sum + t.amount, 0);
    res.json({ count: tokens.length, totalStuckUsdc, tokens });
  });

  // ── Worker control ────────────────────────────────────────────────────────

  // GET /worker — worker status
  router.get('/worker', authenticateUser, (_req: AuthenticatedRequest, res) => {
    res.json({ running: isPolymarketWorkerRunning() });
  });

  // POST /worker/start — start worker
  router.post('/worker/start', authenticateUser, (_req: AuthenticatedRequest, res) => {
    if (isPolymarketWorkerRunning()) {
      return res.json({ running: true, message: 'Already running' });
    }
    startPolymarketWorker(prisma);
    res.json({ running: true, message: 'Worker started' });
  });

  // POST /worker/stop — stop worker (bouton STOP)
  router.post('/worker/stop', authenticateUser, (_req: AuthenticatedRequest, res) => {
    if (!isPolymarketWorkerRunning()) {
      return res.json({ running: false, message: 'Already stopped' });
    }
    stopPolymarketWorker();
    res.json({ running: false, message: 'Worker stopped' });
  });

  return router;
}
