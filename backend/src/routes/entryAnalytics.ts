/**
 * Enhanced Entry Analytics Routes
 * 
 * Provides visibility into entry decisions, threshold configurations,
 * and adaptive learning progress.
 */

import { Router } from 'express';
import { authenticateUser, type AuthenticatedRequest } from '../middleware/auth.js';
import { AgentHub } from '../agent/hub.js';
import { prisma } from '../db/client.js';
import { 
  getRecentEntryDecisions, 
  getEntryDecisionStats,
  generateRecommendation,
  type EntryDecisionSummary,
} from '../services/entryDecisionVisibility.js';
import {
  getAdaptiveLearningState,
  analyzeThresholdPerformance,
  initializeAdaptiveLearning,
} from '../services/adaptiveThresholdLearning.js';
import {
  getThresholdsForSymbol,
  getSymbolTier,
  explainThresholds,
} from '../services/regimeAwareThresholds.js';
import { buildTechSnapshot } from '../ai/tech.js';

export const router = Router();

/**
 * Get current regime-aware thresholds for a symbol
 */
router.get('/thresholds/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const aggressiveness = (req.query.aggressiveness as any) || 'reactive';

    // Get technical snapshot
    const tech = await buildTechSnapshot(symbol);

    // Calculate regime-aware thresholds
    const thresholds = getThresholdsForSymbol(symbol, tech, aggressiveness);

    // Get explanation
    const explanation = explainThresholds(thresholds, symbol, aggressiveness);

    res.json({
      ok: true,
      symbol,
      thresholds: {
        confidence: thresholds.confidence,
        atr: thresholds.atr,
        adx: thresholds.adx,
        eligibility: thresholds.eligibility,
        rrMin: thresholds.rrMin,
      },
      regime: {
        type: thresholds.regime.regime,
        direction: thresholds.regime.direction,
        momentum: thresholds.regime.momentumScore,
        volatility: thresholds.regime.volatilityScore,
        tags: thresholds.regime.tags,
      },
      tier: thresholds.tier,
      explanation,
    });
  } catch (error) {
    console.error('Failed to get thresholds:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to calculate thresholds',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get entry decision history for a session
 */
router.get('/entry-decisions/:sessionId', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

    // Verify session access
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true },
    });

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    // Get entry decisions
    const decisions = await getRecentEntryDecisions(sessionId, limit);

    // Get stats
    const stats = await getEntryDecisionStats(sessionId);
    const recommendation = generateRecommendation(stats);

    res.json({
      ok: true,
      sessionId,
      decisions,
      stats: {
        ...stats,
        recommendation,
      },
    });
  } catch (error) {
    console.error('Failed to get entry decisions:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get entry decisions',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get entry decision stats summary for a session
 */
router.get('/entry-stats/:sessionId', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    const stats = await getEntryDecisionStats(sessionId);
    const recommendation = generateRecommendation(stats);

    res.json({
      ok: true,
      sessionId,
      stats: {
        ...stats,
        recommendation,
      },
    });
  } catch (error) {
    console.error('Failed to get entry stats:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get entry stats',
    });
  }
});

/**
 * Get adaptive learning state for a symbol
 */
router.get('/adaptive-learning/:symbol', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol } = req.params;
    const aggressiveness = (req.query.aggressiveness as any) || 'reactive';

    // Get technical snapshot for current thresholds
    const tech = await buildTechSnapshot(symbol);
    const currentThresholds = getThresholdsForSymbol(symbol, tech, aggressiveness);

    // Get adaptive learning state
    const learningState = await getAdaptiveLearningState(
      symbol,
      {
        confidence: currentThresholds.confidence,
        atr: currentThresholds.atr,
        adx: currentThresholds.adx,
        eligibility: currentThresholds.eligibility,
        rrMin: currentThresholds.rrMin,
      },
      aggressiveness
    );

    res.json({
      ok: true,
      symbol,
      learning: learningState,
      tier: getSymbolTier(symbol),
    });
  } catch (error) {
    console.error('Failed to get adaptive learning state:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get adaptive learning state',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get threshold performance analysis for a symbol
 */
router.get('/threshold-performance/:symbol', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol } = req.params;
    const lookbackDays = Math.min(90, parseInt(req.query.lookbackDays as string) || 30);

    const performance = await analyzeThresholdPerformance(symbol, lookbackDays);

    res.json({
      ok: true,
      symbol,
      lookbackDays,
      performance,
    });
  } catch (error) {
    console.error('Failed to get threshold performance:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get threshold performance',
    });
  }
});

/**
 * Initialize adaptive learning (admin only)
 */
router.post('/adaptive-learning/initialize', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    // Check if user is admin
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    await initializeAdaptiveLearning();

    res.json({
      ok: true,
      message: 'Adaptive learning initialized',
    });
  } catch (error) {
    console.error('Failed to initialize adaptive learning:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to initialize adaptive learning',
    });
  }
});

/**
 * Get symbol-specific optimization status
 */
router.get('/symbol-optimization/:symbol', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol } = req.params;
    
    const { getSymbolProfile } = await import('../services/symbolSpecificOptimization.js');
    const profile = await getSymbolProfile(symbol);

    res.json({
      ok: true,
      symbol,
      profile: profile || { message: 'No custom profile found - using regime-aware defaults' },
    });
  } catch (error) {
    console.error('Failed to get symbol optimization:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get symbol optimization',
    });
  }
});

/**
 * Trigger symbol optimization (admin only)
 */
router.post('/symbol-optimization/:symbol/optimize', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    const { symbol } = req.params;
    const lookbackDays = parseInt(req.query.lookbackDays as string) || 30;

    const { optimizeSymbolThresholds } = await import('../services/symbolSpecificOptimization.js');
    const optimized = await optimizeSymbolThresholds(symbol, lookbackDays);

    if (optimized) {
      res.json({
        ok: true,
        symbol,
        optimized,
        message: 'Symbol thresholds optimized successfully',
      });
    } else {
      res.json({
        ok: false,
        symbol,
        message: 'Not enough data to optimize (need 10+ trades)',
      });
    }
  } catch (error) {
    console.error('Failed to optimize symbol:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to optimize symbol',
    });
  }
});

/**
 * Create A/B test (admin only)
 */
router.post('/ab-test/create', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    const { createABTest } = await import('../services/abTesting.js');
    const testId = await createABTest(req.body);

    res.json({
      ok: true,
      testId,
      message: 'A/B test created successfully',
    });
  } catch (error) {
    console.error('Failed to create A/B test:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to create A/B test',
    });
  }
});

/**
 * Get A/B test results
 */
router.get('/ab-test/:testId/results', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { testId } = req.params;

    const { compareABTestVariants } = await import('../services/abTesting.js');
    const comparison = await compareABTestVariants(testId);

    res.json({
      ok: true,
      comparison,
    });
  } catch (error) {
    console.error('Failed to get A/B test results:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get A/B test results',
    });
  }
});

/**
 * Get comprehensive analytics dashboard data
 */
router.get('/dashboard/:sessionId', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionId } = req.params;

    // Get session details
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        symbol: true,
        profileJson: true,
        userId: true,
      },
    });

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    const profile = (session.profileJson as any) || {};
    const aggressiveness = profile.aggressiveness || 'reactive';

    // Get all analytics in parallel
    const [entryStats, recentDecisions, tech, learningState] = await Promise.all([
      getEntryDecisionStats(sessionId),
      getRecentEntryDecisions(sessionId, 10),
      buildTechSnapshot(session.symbol),
      getAdaptiveLearningState(
        session.symbol,
        {
          confidence: profile.confidence || 0.68,
          atr: profile.atr || 0.55,
          adx: profile.adx || 16,
          eligibility: profile.eligibility || 0.58,
          rrMin: profile.rrMin || 1.8,
        },
        aggressiveness
      ).catch(() => null),
    ]);

    const currentThresholds = getThresholdsForSymbol(session.symbol, tech, aggressiveness);
    const recommendation = generateRecommendation(entryStats);

    res.json({
      ok: true,
      sessionId,
      symbol: session.symbol,
      dashboard: {
        entryStats: {
          ...entryStats,
          recommendation,
        },
        recentDecisions,
        currentThresholds: {
          confidence: currentThresholds.confidence,
          atr: currentThresholds.atr,
          adx: currentThresholds.adx,
          eligibility: currentThresholds.eligibility,
          rrMin: currentThresholds.rrMin,
        },
        regime: {
          type: currentThresholds.regime.regime,
          direction: currentThresholds.regime.direction,
          tags: currentThresholds.regime.tags,
          momentum: currentThresholds.regime.momentumScore,
          volatility: currentThresholds.regime.volatilityScore,
        },
        tier: currentThresholds.tier,
        learning: learningState,
      },
    });
  } catch (error) {
    console.error('Failed to get dashboard data:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to get dashboard data',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
