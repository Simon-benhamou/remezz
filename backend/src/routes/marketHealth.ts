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

const router = Router();

/**
 * GET /api/market-health/:symbol
 * 
 * Retourne si les conditions sont favorables pour trader ce symbol:
 * - Strategy compatibility score
 * - Market regime (trending/ranging/choppy)
 * - Volatility fit (ATR-based)
 * - Liquidity fit
 * - Why no trades are happening (if applicable)
 */
router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
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
    
    // 5. Determine if conditions are favorable
    const isFavorable = 
      compatibility.compatible &&
      compatibility.score >= 0.60 &&
      regime.dominant !== 'high_vol' &&
      compatibility.volatilityFit !== 'poor' &&
      compatibility.liquidityFit !== 'poor';
    
    // 5. Build reasons for unfavorable conditions
    const unfavorableReasons: string[] = [];
    if (!compatibility.compatible) {
      unfavorableReasons.push('Strategy compatibility too low');
    }
    if (compatibility.score < 0.60) {
      unfavorableReasons.push(`Compatibility score ${compatibility.score.toFixed(2)} < 0.60`);
    }
    if (regime.dominant === 'high_vol') {
      unfavorableReasons.push('Market is high volatility - strategy may be risky');
    }
    if (compatibility.volatilityFit === 'poor') {
      unfavorableReasons.push('Volatility too low for ATR-based stops');
    }
    if (compatibility.liquidityFit === 'poor') {
      unfavorableReasons.push('Insufficient liquidity for execution');
    }
    if (compatibility.trendQuality === 'poor') {
      unfavorableReasons.push('No clear trend structure');
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
 * GET /api/market-health/:symbol/decisions
 * 
 * Retourne tous les signaux récents (last 100) avec raisons de rejet:
 * - Strategy analyzed
 * - Confidence score
 * - Why rejected (low confidence, weak context, predictor blocked, etc.)
 * - Entry eligibility details
 */
router.get('/:symbol/decisions', async (req, res) => {
  try {
    const { symbol } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    
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
        strategy: d.selectedStrategy || 'unknown',
        strategyLabel: d.selectedStrategy || 'Unknown',
        
        // Scores
        confidenceScore: d.confidenceScore,
        qualityScore: inputMetrics.qualityScore,
        entryEligibilityScore: inputMetrics.entryEligibilityScore,
        
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

export default router;
