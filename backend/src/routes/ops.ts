import { Router } from 'express';
import { computeOpsMetrics, recentOpsEvents } from '../monitor/ops.js';
import { prisma } from '../db/client.js';

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

router.get('/llm/logs', async (req, res) => {
  const limitRaw = Number(req.query.limit ?? 25);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 25;
  try {
    const rows = await prisma.aiPromptLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json(rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      symbol: r.symbol,
      kind: r.kind,
      provider: r.provider,
      model: r.model,
      cached: r.cached,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costUsd: r.costUsd,
      createdAt: r.createdAt,
      error: r.error,
    })));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
