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
  saveBuilderCredentials,
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
  // Includes shared virtual rows (userId=null) so predictions that weren't traded
  // (e.g. EV too low) still appear in history.
  router.get('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const allRows = await prisma.polymarketPrediction.findMany({
        where: { OR: [{ userId: req.user!.id }, { userId: null }] },
        orderBy: { windowStart: 'desc' },
      });

      // Deduplicate by windowStart:symbol: prefer per-user row (has execution data) over shared row
      const byWindowSymbol = new Map<string, (typeof allRows)[0]>();
      for (const row of allRows) {
        const key = `${row.windowStart.getTime()}:${row.symbol}`;
        const existing = byWindowSymbol.get(key);
        if (!existing || (existing.userId === null && row.userId !== null)) {
          byWindowSymbol.set(key, row);
        }
      }
      // Determine trade type per row:
      // - userId=null → prediction only (shared signal row)
      // - userId set + executionPrice → traded (virtual or live)
      // - userId set + no executionPrice → shouldn't happen but treat as prediction
      const config = await getPolymarketConfig(prisma, req.user!.id);
      const predictions = [...byWindowSymbol.values()]
        .sort((a, b) => b.windowStart.getTime() - a.windowStart.getTime())
        .map((row) => {
          let tradeType: 'prediction' | 'virtual' | 'live';
          if (row.userId === null || row.executionPrice == null) {
            tradeType = 'prediction';
          } else if (row.soldAt || row.usdcReceived) {
            // Has real sell data → was definitely a live trade
            tradeType = 'live';
          } else {
            // Per-user row with CLOB price but no sell → use current mode as best guess
            tradeType = config.mode === 'live' ? 'live' : 'virtual';
          }
          return { ...row, tradeType };
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

  // PUT /settings — save mode + amount + hedgeAmount + symbols
  router.put('/settings', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { mode, amount, hedgeAmount, symbols } = req.body;
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

      // Validate symbols array if provided
      let parsedSymbols: string[] | undefined;
      if (symbols && Array.isArray(symbols)) {
        parsedSymbols = symbols.map((s: string) => String(s).toUpperCase());
        if (parsedSymbols.length === 0) {
          return res.status(400).json({ error: 'At least one symbol must be active' });
        }
      }

      // If switching to live, validate credentials exist
      if (mode === 'live') {
        const config = await getPolymarketConfig(prisma, req.user!.id);
        if (!config.hasCredentials) {
          return res.status(400).json({ error: 'Save valid API credentials before enabling live mode' });
        }
      }

      await savePolymarketConfig(prisma, req.user!.id, mode, parsedAmount, parsedHedge, parsedSymbols);
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

  // PUT /builder-credentials — save Builder API credentials (for relay-based CTF redemption)
  router.put('/builder-credentials', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { key, secret, passphrase } = req.body;
      if (!key || !secret || !passphrase) {
        return res.status(400).json({ error: 'Builder key, secret, and passphrase are all required' });
      }
      await saveBuilderCredentials(prisma, req.user!.id, key, secret, passphrase);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to save builder credentials' });
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

  // DELETE /history — reset predictions for this user (including shared virtual rows)
  router.delete('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
    try {
      const { count } = await prisma.polymarketPrediction.deleteMany({
        where: { OR: [{ userId: req.user!.id }, { userId: null }] },
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
