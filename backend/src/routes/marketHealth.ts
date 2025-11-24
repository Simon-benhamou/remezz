/**
 * Market Health & Strategy Transparency API
 * 
 * Endpoints pour afficher:
 * - Si les conditions de marché sont favorables à nos stratégies
 * - Tous les signaux analysés (accepted/rejected avec raisons)
 * - Activité des agents en temps réel
 */

import { Router } from 'express';
import { prisma } from '../db/client.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { getMarketContext } from '../analytics/marketContext.js';
import { evaluateStrategyCompatibility } from '../quantai/strategies/metaAdaptive/cryptoSelection.js';
import { detectMarketRegime } from '../quantai/regime/marketRegimeDetector.js';
import { evaluateAdaptiveEntry, getAdaptiveThresholdSummary } from '../learning/adaptiveThresholds.js';

const router = Router();

/**
 * POST /api/market-health
 * 
 * Retourne si les conditions sont favorables pour trader ce symbol:
 * - Strategy compatibility score
 * - Market regime (trending/ranging/choppy)
 * - Volatility fit (ATR-based)
 * - Liquidity fit
 * - Why no trades are happening (if applicable)
 */
router.post('/', async (req, res) => {
  try {
    const { symbol } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }
    
    // 1. Get technical snapshot
    const tech = await buildTechSnapshot(symbol);
    const marketContext = await getMarketContext(symbol);
    
    // 2. Evaluate strategy compatibility
    const volumeUsd24h = marketContext?.derivatives?.volumeUsd24h || 10_000_000;
    const cryptoInfo = {
      symbol,
      volumeUsd24h,
      change24h: ((tech as any).change24h as number) || 0,
      price: tech.last,
      volumeRank: 0, // Not critical here
    };
    
    const compatibility = evaluateStrategyCompatibility(cryptoInfo, tech);
    
    // 3. Detect market regime
    const atrPct = (tech.atr14 / tech.last) * 100;
    const regime = detectMarketRegime({
      snap: tech,
      atr15mPct: atrPct,
      atr1h: tech.atr14,
      atr4h: tech.atr14,
      realizedVol: ((tech as any).realizedVol as number) || 0.02,
      hurst: 0.5,
      isMajor: true,
      derivatives: marketContext?.derivatives || null,
      onChain: marketContext?.onChain || null,
    });
    
    // 4. Check recent trade attempts
    const recentAttempts = await prisma.tradeEvaluation.findMany({
      where: {
        symbol,
        createdAt: {
          gte: new Date(Date.now() - 3600000), // Last hour
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    
    const rejectedCount = recentAttempts.filter(t => t.decision === 'order_blocked' || t.decision === 'order_blocked_rotation').length;
    const acceptedCount = recentAttempts.filter(t => t.decision === 'order_placed').length;
    
    // 5. 🧠 ADAPTIVE EVALUATION: Learn from historical performance
    const latestDecision = await prisma.aiDecision.findFirst({
      where: { symbol },
      orderBy: { createdAt: 'desc' },
      select: { confidence: true },
    });
    
    const predictorConfidence = latestDecision?.confidence || 0.5;
    const atrPct = Number((tech as any).atrPct || 1.0);
    const volumeRatio = Number((tech as any).volumeRatio || 1.0);
    
    const adaptiveEval = await evaluateAdaptiveEntry({
      symbol,
      compatibilityScore: compatibility.score,
      predictorConfidence,
      atrPct,
      volumeRatio,
      volumeUsd: volumeUsd24h,
      trendQuality: compatibility.trendQuality,
    });
    
    // 6. Determine if conditions are favorable (ADAPTIVE)
    // Old rigid rule: compatibility.score >= 0.60
    // New adaptive: Use learned thresholds from performance data
    const isFavorable = adaptiveEval.allowed;
    
    // 7. Build reasons for unfavorable conditions
    const unfavorableReasons: string[] = [];
    
    // Show adaptive reasoning
    if (!adaptiveEval.allowed) {
      unfavorableReasons.push(adaptiveEval.threshold.reasoning);
      unfavorableReasons.push(`Required compatibility: ${adaptiveEval.threshold.recommendedMinCompatibility.toFixed(2)} (actual: ${compatibility.score.toFixed(2)})`);
      unfavorableReasons.push(`Required predictor conf: ${adaptiveEval.threshold.recommendedMinPredictorConf.toFixed(2)} (actual: ${predictorConfidence.toFixed(2)})`);
    }
    
    // Show override if present
    if (adaptiveEval.override) {
      unfavorableReasons.length = 0; // Clear other reasons
      unfavorableReasons.push(adaptiveEval.override);
    }
    
    // Add traditional warnings as context
    if (!compatibility.compatible) {
      unfavorableReasons.push('⚠️ Base compatibility check failed');
    }
    if (regime.dominant === 'high_vol') {
      unfavorableReasons.push('⚠️ High volatility regime detected');
    }
    if (compatibility.volatilityFit === 'poor') {
      unfavorableReasons.push('⚠️ Volatility may be suboptimal');
    }
    if (compatibility.liquidityFit === 'poor') {
      unfavorableReasons.push('⚠️ Liquidity concerns');
    }
    if (compatibility.trendQuality === 'poor') {
      unfavorableReasons.push('⚠️ Weak trend structure');
    }
    
    // 7. Check if predictor is blocking
    const recentPredictorBlocks = recentAttempts.filter(t => 
      t.blockedReason?.includes('predictor') || 
      t.blockedReason?.includes('confidence')
    ).length;
    
    res.json({
      symbol,
      timestamp: Date.now(),
      
      // Overall health
      isFavorable,
      healthScore: compatibility.score,
      unfavorableReasons,
      
      // 🧠 ADAPTIVE LEARNING DATA
      adaptiveLearning: {
        allowed: adaptiveEval.allowed,
        recommendedMinCompatibility: adaptiveEval.threshold.recommendedMinCompatibility,
        recommendedMinPredictorConf: adaptiveEval.threshold.recommendedMinPredictorConf,
        reasoning: adaptiveEval.threshold.reasoning,
        override: adaptiveEval.override,
        historicalPerformance: adaptiveEval.threshold.performance.totalTrades > 0 ? {
          trades: adaptiveEval.threshold.performance.totalTrades,
          winRate: (adaptiveEval.threshold.performance.winRate * 100).toFixed(1) + '%',
          avgPnl: adaptiveEval.threshold.performance.avgPnl.toFixed(3),
          sharpe: adaptiveEval.threshold.performance.sharpeRatio.toFixed(2),
          confidence: adaptiveEval.threshold.performance.confidence,
        } : null,
      },
      
      // Strategy compatibility
      strategyCompatibility: {
        score: compatibility.score,
        tier: compatibility.tier,
        volatilityFit: compatibility.volatilityFit,
        liquidityFit: compatibility.liquidityFit,
        trendQuality: compatibility.trendQuality,
        accumulationDetectable: compatibility.accumulationDetectable,
        estimatedWinRate: compatibility.estimatedWinRate,
        reasons: compatibility.reasons,
        warnings: compatibility.warnings,
      },
      
      // Market regime
      marketRegime: {
        dominant: regime.dominant,
        confidence: regime.confidence,
        notes: regime.notes, // Changed from reason to notes array
      },
      
      // Recent activity
      recentActivity: {
        lastHour: {
          totalAttempts: recentAttempts.length,
          accepted: acceptedCount,
          rejected: rejectedCount,
          rejectionRate: recentAttempts.length > 0 
            ? (rejectedCount / recentAttempts.length * 100).toFixed(1) + '%'
            : 'N/A',
        },
        predictorBlocks: recentPredictorBlocks,
      },
      
      // Technical snapshot
      technicals: {
        price: tech.last,
        atr14: tech.atr14,
        atrPct: ((tech.atr14 / tech.last) * 100).toFixed(2) + '%',
        adx14: tech.adx14,
        rsi14: tech.rsi14,
        volumeRatio: ((tech as any).volumeRatio || 1).toFixed(2),
      },
    });
    
  } catch (error) {
    console.error('Error fetching market health:', error);
    res.status(500).json({
      error: 'Failed to fetch market health',
      details: String((error as any)?.message || error),
    });
  }
});

/**
 * POST /api/market-health/decisions
 * 
 * Retourne tous les signaux récents (last 100) avec raisons de rejet:
 * - Strategy analyzed
 * - Confidence score
 * - Why rejected (low confidence, weak context, predictor blocked, etc.)
 * - Entry eligibility details
 */
router.post('/decisions', async (req, res) => {
  try {
    const { symbol, limit: reqLimit } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }
    
    const limit = Math.min(Number(reqLimit) || 50, 200);
    
    const decisions = await prisma.tradeEvaluation.findMany({
      where: { symbol },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    
    const formatted = decisions.map(d => {
      // TradeEvaluation has inputMetrics, regimeContext, but no metadata field
      const inputMetrics = (d.inputMetrics as any) || {};
      const regimeContext = (d.regimeContext as any) || {};
      
      return {
        timestamp: d.createdAt.toISOString(),
        decision: d.decision,
        strategy: d.strategyId || 'unknown',
        strategyLabel: d.strategyFamily || 'Unknown',
        
        // Scores
        confidenceScore: d.confidenceScore,
        qualityScore: inputMetrics.qualityScore,
        entryEligibilityScore: d.eligibilityScore ?? inputMetrics.entryEligibilityScore,
        
        // Gates
        confidencePassed: inputMetrics.confidenceGatePassed ?? null,
        eligibilityPassed: inputMetrics.entryEligibilityGatePassed ?? null,
        
        // Rejection reason
        blockedReason: d.blockedReason || (d.decision.includes('blocked') ? 'threshold_not_met' : null),
        
        // Entry details
        entryReasons: inputMetrics.entryEligibilityReasons || [],
        
        // Predictor influence
        predictorDecision: inputMetrics.predictorDecision || inputMetrics.pythonSignal?.decision,
        predictorConfidence: inputMetrics.predictorConfidence,
        predictorUsage: inputMetrics.predictorUsage,
        
        // Market inputs
        inputMetrics: inputMetrics || {},
      };
    });
    
    // Stats
    const total = formatted.length;
    const accepted = formatted.filter(d => d.decision === 'order_placed').length;
    const rejected = formatted.filter(d => d.decision.includes('blocked')).length;
    const lowConfidence = formatted.filter(d => d.blockedReason?.includes('confidence')).length;
    const weakContext = formatted.filter(d => d.blockedReason?.includes('context')).length;
    const predictorBlocked = formatted.filter(d => d.blockedReason?.includes('predictor')).length;
    
    res.json({
      symbol,
      stats: {
        total,
        accepted,
        rejected,
        acceptanceRate: total > 0 ? ((accepted / total) * 100).toFixed(1) + '%' : 'N/A',
        rejectionReasons: {
          lowConfidence,
          weakContext,
          predictorBlocked,
          other: rejected - lowConfidence - weakContext - predictorBlocked,
        },
      },
      decisions: formatted,
    });
    
  } catch (error) {
    console.error('Error fetching decisions:', error);
    res.status(500).json({
      error: 'Failed to fetch decisions',
      details: String((error as any)?.message || error),
    });
  }
});

/**
 * GET /api/market-health/agent-activity
 * 
 * Retourne l'activité globale des agents:
 * - Combien d'analyses par minute
 * - Combien de symboles actifs
 * - Santé des services (predictor, sentiment, risk, etc.)
 */
router.get('/agent-activity', async (req, res) => {
  try {
    // Recent trade evaluations (last 5 minutes)
    const recentEvals = await prisma.tradeEvaluation.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 300000), // 5 min
        },
      },
    });
    
    const last1min = recentEvals.filter(e => e.createdAt > new Date(Date.now() - 60000));
    const symbolsAnalyzed = new Set(recentEvals.map(e => e.symbol)).size;
    const analysisRate = (recentEvals.length / 5).toFixed(1); // per minute
    
    // Active sessions (sessions that haven't been stopped)
    const activeSessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null, // Not stopped means active
      },
      select: {
        id: true,
        symbol: true,
        mode: true,
        startedAt: true,
      },
      take: 50,
    });
    
    // Check recent telemetry updates for service health indication
    const recentTelemetry = await prisma.agentOpsTelemetry.findMany({
      where: {
        updatedAt: {
          gte: new Date(Date.now() - 300000), // Last 5 minutes
        },
      },
      take: 20,
    });
    
    res.json({
      timestamp: Date.now(),
      
      analysis: {
        last5min: recentEvals.length,
        last1min: last1min.length,
        ratePerMinute: analysisRate,
        symbolsAnalyzed,
      },
      
      activeSessions: {
        count: activeSessions.length,
        sessions: activeSessions.map(s => ({
          sessionId: s.id,
          symbol: s.symbol,
          mode: s.mode,
          lastUpdate: s.startedAt, // Use startedAt since updatedAt doesn't exist
        })),
      },
      
      serviceHealth: {
        activeAgents: activeSessions.length,
        recentActivity: recentTelemetry.length > 0,
        telemetryUpdates: recentTelemetry.length,
      },
    });
    
  } catch (error) {
    console.error('Error fetching agent activity:', error);
    res.status(500).json({
      error: 'Failed to fetch agent activity',
      details: String((error as any)?.message || error),
    });
  }
});

/**
 * POST /api/market-health/adaptive-summary
 * 
 * Get adaptive learning summary for a specific symbol
 */
router.post('/adaptive-summary', async (req, res) => {
  try {
    const { symbol, lookbackDays } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }
    
    const days = lookbackDays || 30;
    const summary = await getAdaptiveThresholdSummary(symbol, days);
    
    res.json(summary);
  } catch (error) {
    console.error('Error fetching adaptive summary:', error);
    res.status(500).json({
      error: 'Failed to fetch adaptive summary',
      details: String((error as any)?.message || error),
    });
  }
});

export default router;
