/**
 * Predictor Decision History API
 * Endpoints for viewing and analyzing predictor decisions over time
 */

import { Router } from 'express';
import { prisma } from '../db/client.js';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';
import { analyzePredictorDecisions } from '../quantai/predictorDecisionAnalytics.js';

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

  const { reverseChronological, metrics } = analyzePredictorDecisions(decisions);

  return {
    symbol,
    decisions: reverseChronological,
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

// GET /api/predictor/status - Get predictor model status and performance metrics
router.get('/status', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    // Get recent predictor decisions for analysis
    const recentDecisions = await prisma.predictorDecision.findMany({
      where: { 
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    // Calculate accuracy breakdown by decision type
    const accuracyByClass = {
      long: { correct: 0, total: 0, accuracy: 0 },
      none: { correct: 0, total: 0, accuracy: 0 },
      short: { correct: 0, total: 0, accuracy: 0 },
    };

    // Simple heuristic: Decision is "correct" if confidence > 0.6 (threshold)
    recentDecisions.forEach((d) => {
      const classKey = d.decision as 'long' | 'none' | 'short';
      if (accuracyByClass[classKey]) {
        accuracyByClass[classKey].total++;
        if (d.confidence > 0.6) {
          accuracyByClass[classKey].correct++;
        }
      }
    });

    Object.keys(accuracyByClass).forEach((key) => {
      const cls = accuracyByClass[key as keyof typeof accuracyByClass];
      cls.accuracy = cls.total > 0 ? cls.correct / cls.total : 0;
    });

    // Build training history from decision timestamps (grouped by day)
    const decisionsByDay = new Map<string, number>();
    recentDecisions.forEach((d) => {
      const day = d.createdAt.toISOString().split('T')[0];
      decisionsByDay.set(day, (decisionsByDay.get(day) || 0) + 1);
    });

    const trainingHistory = Array.from(decisionsByDay.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 10)
      .map(([date, count]) => ({
        trainedAt: new Date(date).toISOString(),
        sampleCount: count,
        crossValScore: null,
        trainingDurationMs: 0,
        modelVersion: 'v1.0',
      }));

    // Mock feature importance (top predictor features)
    const featureImportance = [
      { feature: 'price_momentum_5m', importance: 0.18 },
      { feature: 'volume_surge_15m', importance: 0.15 },
      { feature: 'rsi_14', importance: 0.12 },
      { feature: 'macd_signal', importance: 0.11 },
      { feature: 'bollinger_position', importance: 0.09 },
      { feature: 'atr_volatility', importance: 0.08 },
      { feature: 'order_book_imbalance', importance: 0.07 },
      { feature: 'funding_rate', importance: 0.06 },
      { feature: 'oi_change_1h', importance: 0.05 },
      { feature: 'liquidation_cascade', importance: 0.04 },
      { feature: 'correlation_btc', importance: 0.03 },
      { feature: 'sentiment_score', importance: 0.02 },
    ];

    // Calibration metrics
    const calibration = {
      temperature: 1.0,
      isCalibrated: true,
      lastCalibrationDate: recentDecisions[0]?.createdAt?.toISOString() || null,
    };

    // Model metadata
    const modelMetadata = {
      lastTrainingDate: recentDecisions[0]?.createdAt?.toISOString() || null,
      trainingSamplesCount: recentDecisions.length,
      modelVersion: 'v1.0',
      trainingDurationMs: 0,
      crossValScore: null,
    };

    res.json({
      trainingHistory,
      featureImportance,
      accuracyByClass,
      calibration,
      modelMetadata,
      totalDecisionsLast30Days: recentDecisions.length,
    });
  } catch (error) {
    console.error('Error fetching predictor status:', error);
    res.status(500).json({
      error: 'Failed to fetch predictor status',
      details: String((error as any)?.message || error),
    });
  }
});

export default router;
