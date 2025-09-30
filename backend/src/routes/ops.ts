import { Router } from 'express';
import { computeOpsMetrics, recentOpsEvents } from '../monitor/ops.js';

export const router = Router();

router.get('/metrics', async (_req, res) => {
  try {
    const snapshot = await computeOpsMetrics();
    res.json(snapshot);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

router.get('/events', (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const rows = recentOpsEvents(Number.isFinite(limit) ? limit : 50);
  res.json(rows);
});
