/**
 * Smart Selection API Routes
 * Monitoring and control endpoints for the smart selection orchestrator
 */

import express from 'express';
import { 
  selectBestOpportunity,
  evaluateSmartSwitch,
  forceUniverseRefresh,
  getCachedOpportunities,
  clearAllCaches
} from '../services/smartSelectionOrchestrator.js';
import { authMiddleware } from '../utils/security.js';

const router = express.Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * GET /api/smart-selection/best
 * Get current best opportunity
 */
router.get('/best', async (req, res) => {
  try {
    const result = await selectBestOpportunity();
    
    res.json({
      success: true,
      data: {
        symbol: result.symbol,
        score: result.score,
        confidence: result.confidence,
        marketRegime: result.marketRegime,
        alternatives: result.alternatives,
        analysis: {
          score: result.analysis.score,
          confidence: result.analysis.confidence,
          reasoning: result.analysis.reasoning,
          metrics: result.analysis.metrics,
        },
      },
    });
  } catch (error) {
    console.error('Failed to get best opportunity:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/smart-selection/evaluate/:sessionId
 * Evaluate if a session should switch symbols
 */
router.get('/evaluate/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Get session info
    const session = await req.app.locals.prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { symbol: true },
    });
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }
    
    const result = await evaluateSmartSwitch(sessionId, session.symbol, sessionId);
    
    res.json({
      success: true,
      data: {
        shouldSwitch: result.shouldSwitch,
        targetSymbol: result.targetSymbol,
        currentScore: result.currentScore,
        targetScore: result.targetScore,
        reason: result.reason,
        fastTrack: result.fastTrack,
        improvement: result.targetScore && result.currentScore 
          ? ((result.targetScore - result.currentScore) / result.currentScore * 100).toFixed(1) + '%'
          : null,
      },
    });
  } catch (error) {
    console.error('Failed to evaluate switch:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/smart-selection/cached
 * Get currently cached opportunities for monitoring
 */
router.get('/cached', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const opportunities = getCachedOpportunities(limit);
    
    res.json({
      success: true,
      data: {
        count: opportunities.length,
        opportunities: opportunities.map(opp => ({
          symbol: opp.symbol,
          score: opp.score,
          confidence: opp.confidence,
          marketRegime: opp.marketRegime,
          age: Math.floor((Date.now() - opp.timestamp) / 1000), // seconds
          analysisScore: opp.analysis.score,
        })),
      },
    });
  } catch (error) {
    console.error('Failed to get cached opportunities:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/smart-selection/refresh
 * Force refresh the universe cache
 */
router.post('/refresh', async (req, res) => {
  try {
    const symbols = await forceUniverseRefresh();
    
    res.json({
      success: true,
      data: {
        message: 'Universe refreshed successfully',
        symbolCount: symbols.length,
        symbols: symbols.slice(0, 20), // First 20
      },
    });
  } catch (error) {
    console.error('Failed to refresh universe:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/smart-selection/clear-cache
 * Clear all caches (admin only)
 */
router.post('/clear-cache', async (req, res) => {
  try {
    clearAllCaches();
    
    res.json({
      success: true,
      data: {
        message: 'All caches cleared successfully',
      },
    });
  } catch (error) {
    console.error('Failed to clear caches:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/smart-selection/stats
 * Get orchestrator statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const opportunities = getCachedOpportunities(100);
    
    const stats = {
      cachedOpportunities: opportunities.length,
      averageScore: opportunities.length > 0
        ? opportunities.reduce((sum, o) => sum + o.score, 0) / opportunities.length
        : 0,
      averageConfidence: opportunities.length > 0
        ? opportunities.reduce((sum, o) => sum + o.confidence, 0) / opportunities.length
        : 0,
      regimeDistribution: opportunities.reduce((acc, o) => {
        acc[o.marketRegime] = (acc[o.marketRegime] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      topSymbols: opportunities.slice(0, 5).map(o => ({
        symbol: o.symbol,
        score: o.score,
        confidence: o.confidence,
      })),
    };
    
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Failed to get stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
