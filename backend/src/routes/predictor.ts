/**
 * Predictor Decision History API
 * Endpoints for viewing and analyzing predictor decisions over time
 */

import { Router } from 'express';
import { prisma } from '../db/client.js';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

interface SymbolDecisionRequest {
  symbol: string;
  limit?: number;
  since?: string;
}

async function buildDecisionPayload(symbol: string, limit: number, sinceDate?: Date) {
  const whereClause: any = { symbol };
  if (sinceDate) {
    whereClause.createdAt = { gte: sinceDate };
  }

  const decisions = await prisma.predictorDecision.findMany({
    where: whereClause,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const chronological = decisions.reverse();

  const analyzed: Array<any> = [];
  for (let i = 0; i < chronological.length; i++) {
    const decision = chronological[i];
    const nextDecision = chronological[i + 1];
    let outcome: 'good' | 'bad' | 'neutral' | 'pending' = 'pending';
    let priceChange: number | null = null;
    let pnlEstimate: number | null = null;
    let durationMinutes: number | null = null;

    if (nextDecision && decision.decision !== 'none') {
      const entryPrice = decision.price;
      const exitPrice = nextDecision.price;
      priceChange = ((exitPrice - entryPrice) / entryPrice) * 100;
      durationMinutes = Math.floor((new Date(nextDecision.createdAt).getTime() - new Date(decision.createdAt).getTime()) / 60000);

      if (decision.decision === 'long') {
        pnlEstimate = priceChange;
        outcome = priceChange > 0 ? 'good' : (priceChange < -0.1 ? 'bad' : 'neutral');
      } else if (decision.decision === 'short') {
        pnlEstimate = -priceChange;
        outcome = priceChange < 0 ? 'good' : (priceChange > 0.1 ? 'bad' : 'neutral');
      }
    }

    analyzed.push({
      ...decision,
      outcome,
      priceChange,
      pnlEstimate,
      durationMinutes,
      exitPrice: nextDecision?.price || null,
      exitTime: nextDecision?.createdAt || null,
    });
  }

  const completedTrades = analyzed.filter(d => d.outcome !== 'pending');
  const goodTrades = completedTrades.filter(d => d.outcome === 'good');
  const badTrades = completedTrades.filter(d => d.outcome === 'bad');
  const neutralTrades = completedTrades.filter(d => d.outcome === 'neutral');

  const winRate = completedTrades.length > 0
    ? (goodTrades.length / completedTrades.length) * 100
    : 0;

  const avgPnl = completedTrades.length > 0
    ? completedTrades.reduce((sum, t) => sum + (t.pnlEstimate || 0), 0) / completedTrades.length
    : 0;

  const totalPnl = completedTrades.reduce((sum, t) => sum + (t.pnlEstimate || 0), 0);

  const avgDuration = completedTrades.length > 0
    ? completedTrades.reduce((sum, t) => sum + (t.durationMinutes || 0), 0) / completedTrades.length
    : 0;

  const metrics = {
    totalDecisions: analyzed.length,
    completedTrades: completedTrades.length,
    pendingTrades: analyzed.filter(d => d.outcome === 'pending').length,
    goodTrades: goodTrades.length,
    badTrades: badTrades.length,
    neutralTrades: neutralTrades.length,
    winRate: parseFloat(winRate.toFixed(2)),
    avgPnl: parseFloat(avgPnl.toFixed(2)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgDurationMinutes: parseFloat(avgDuration.toFixed(1)),
  };

  return {
    symbol,
    decisions: analyzed.reverse(),
    metrics,
  };
}

// POST /api/predictor/decisions - Get predictor decision history for a symbol
router.post('/decisions', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const body = req.body as SymbolDecisionRequest;
    if (!body?.symbol) {
      return res.status(400).json({ error: 'Symbol is required in the request body' });
    }
    const limit = Number.isFinite(body.limit ?? NaN) ? Math.max(1, Math.floor(body.limit!)) : 100;
    const sinceDate = body.since ? new Date(body.since) : undefined;
    const payload = await buildDecisionPayload(body.symbol, limit, sinceDate);
    res.json(payload);
  } catch (error) {
    console.error('Error fetching predictor decisions:', error);
    res.status(500).json({
      error: 'Failed to fetch predictor decisions',
      details: String((error as any)?.message || error),
    });
  }
});

// GET /api/predictor/decisions/:symbol - Legacy helper for compatibility
router.get('/decisions/:symbol', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const sinceDate = req.query.since ? new Date(req.query.since as string) : undefined;

    const payload = await buildDecisionPayload(symbol, limit, sinceDate);
    res.json(payload);
  } catch (error) {
    console.error('Error fetching predictor decisions:', error);
    res.status(500).json({
      error: 'Failed to fetch predictor decisions',
      details: String((error as any)?.message || error),
    });
  }
});

// GET /api/predictor/decisions - Get all recent decisions across all symbols
router.get('/decisions', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    
    const decisions = await prisma.predictorDecision.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Group by symbol for summary
    const bySymbol = decisions.reduce((acc, d) => {
      if (!acc[d.symbol]) {
        acc[d.symbol] = {
          symbol: d.symbol,
          lastDecision: d.decision,
          lastPrice: d.price,
          lastUpdate: d.createdAt,
          count: 0,
        };
      }
      acc[d.symbol].count++;
      return acc;
    }, {} as Record<string, any>);

    res.json({
      recentDecisions: decisions,
      symbolSummary: Object.values(bySymbol),
    });
  } catch (error) {
    console.error('Error fetching all predictor decisions:', error);
    res.status(500).json({ 
      error: 'Failed to fetch predictor decisions', 
      details: String((error as any)?.message || error) 
    });
  }
});

export default router;
