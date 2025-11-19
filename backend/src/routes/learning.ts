import { Router } from 'express';
import { prisma } from '../db/client.js';
import type { SubagentKind } from '../services/subagentLearning.js';

export const router = Router();

/**
 * GET /api/learning/sessions/:sessionId
 * Returns learning state for all 7 subagents for a specific session
 */
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: { id: true, symbol: true, mode: true },
    });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const subagentTypes: SubagentKind[] = [
      'risk_governor',
      'execution',
      'predictor',
      'sentiment',
      'market_quality',
      'entry_timing',
      'exit_strategy',
    ];
    
    const learningStates = await Promise.all(
      subagentTypes.map(async (subagent) => {
        const state = await prisma.subagentLearningState.findFirst({
          where: {
            symbol: session.symbol,
            mode: session.mode,
            subagent,
          },
          orderBy: { updatedAt: 'desc' },
        });
        
        if (!state) {
          // Return neutral defaults if no learning state exists
          return {
            subagent,
            symbol: session.symbol,
            mode: session.mode,
            confidence: 0.50,
            sampleCount: 0,
            score: 0.50,
            tuning: getNeutralDefaults(subagent),
            lastUpdated: null,
          };
        }
        
        return {
          subagent: state.subagent,
          symbol: state.symbol,
          mode: state.mode,
          confidence: calculateConfidence(state.sampleCount),
          sampleCount: state.sampleCount,
          score: state.score,
          tuning: state.tuning,
          metrics: state.metrics,
          lastUpdated: state.updatedAt,
        };
      })
    );
    
    // Get performance ledger summary
    const ledgerEntries = await prisma.agentPerformanceLedger.findMany({
      where: { symbol: session.symbol },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    
    const totalTrades = ledgerEntries.length;
    const winningTrades = ledgerEntries.filter(e => {
      const stats = e.stats as any;
      return stats?.pnl && Number(stats.pnl) > 0;
    }).length;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    
    res.json({
      sessionId,
      symbol: session.symbol,
      mode: session.mode,
      learningStates,
      performance: {
        totalTrades,
        winningTrades,
        winRate,
        avgConfidence: learningStates.reduce((sum, s) => sum + s.confidence, 0) / learningStates.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch learning state', details: error.message });
  }
});

/**
 * GET /api/learning/subagents/:symbol/:subagent
 * Returns detailed learning state for a specific subagent
 */
router.get('/subagents/:symbol/:subagent', async (req, res) => {
  try {
    const { symbol, subagent } = req.params;
    const mode = (req.query.mode as 'paper' | 'live') || 'paper';
    
    const state = await prisma.subagentLearningState.findFirst({
      where: {
        symbol,
        mode,
        subagent: subagent as SubagentKind,
      },
      orderBy: { updatedAt: 'desc' },
    });
    
    if (!state) {
      return res.status(404).json({ 
        error: 'No learning state found',
        neutral: getNeutralDefaults(subagent as SubagentKind),
      });
    }
    
    res.json({
      subagent: state.subagent,
      symbol: state.symbol,
      mode: state.mode,
      confidence: calculateConfidence(state.sampleCount),
      sampleCount: state.sampleCount,
      score: state.score,
      tuning: state.tuning,
      metrics: state.metrics,
      regime: state.regime,
      reason: state.reason,
      lastUpdated: state.updatedAt,
      createdAt: state.createdAt,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch subagent state', details: error.message });
  }
});

/**
 * GET /api/learning/summary
 * Returns learning summary across all active sessions
 */
router.get('/summary', async (req, res) => {
  try {
    const activeSessions = await prisma.agentSession.findMany({
      where: { stoppedAt: null },
      select: { id: true, symbol: true, mode: true },
    });
    
    const summaries = await Promise.all(
      activeSessions.map(async (session) => {
        const states = await prisma.subagentLearningState.findMany({
          where: {
            symbol: session.symbol,
            mode: session.mode,
          },
          orderBy: { updatedAt: 'desc' },
        });
        
        const avgConfidence = states.length > 0
          ? states.reduce((sum, s) => sum + calculateConfidence(s.sampleCount), 0) / states.length
          : 0.50;
        
        const totalSamples = states.reduce((sum, s) => sum + s.sampleCount, 0);
        
        return {
          sessionId: session.id,
          symbol: session.symbol,
          mode: session.mode,
          subagentCount: states.length,
          avgConfidence,
          totalSamples,
          lastUpdated: states[0]?.updatedAt || null,
        };
      })
    );
    
    res.json({
      activeSessions: activeSessions.length,
      summaries,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch learning summary', details: error.message });
  }
});

/**
 * PHASE 3: GET /api/learning/insights
 * Returns comprehensive learning insights across all symbols
 */
router.get('/insights', async (req, res) => {
  try {
    const mode = (req.query.mode as 'paper' | 'live') || 'paper';
    
    // Get all learning states
    const allStates = await prisma.subagentLearningState.findMany({
      where: { mode },
      orderBy: { updatedAt: 'desc' },
    });
    
    // Group by symbol
    const symbolMap = new Map<string, any[]>();
    allStates.forEach(state => {
      if (!symbolMap.has(state.symbol)) {
        symbolMap.set(state.symbol, []);
      }
      symbolMap.get(state.symbol)!.push(state);
    });
    
    // Build learning progress array (per symbol)
    const learningProgress = Array.from(symbolMap.entries()).map(([symbol, states]) => {
      const avgConfidence = states.reduce((sum, s) => sum + calculateConfidence(s.sampleCount), 0) / states.length;
      const totalSamples = states.reduce((sum, s) => sum + s.sampleCount, 0);
      const tradesNeeded = 40; // Standard learning threshold
      
      return {
        symbol,
        confidence: avgConfidence,
        tradesCompleted: totalSamples,
        tradesNeeded,
        status: avgConfidence >= 0.8 ? 'confident' as const : avgConfidence >= 0.5 ? 'learning' as const : 'uncertain' as const,
      };
    });
    
    // Get subagent performance comparison
    const subagentTypes: SubagentKind[] = [
      'risk_governor', 'execution', 'predictor', 'sentiment',
      'market_quality', 'entry_timing', 'exit_strategy'
    ];
    
    const subagentPerformance = await Promise.all(subagentTypes.map(async (subagent) => {
      const states = allStates.filter(s => s.subagent === subagent);
      const avgConfidence = states.length > 0 
        ? states.reduce((sum, s) => sum + calculateConfidence(s.sampleCount), 0) / states.length
        : 0.25;
      
      const decisionsCount = states.reduce((sum, s) => sum + s.sampleCount, 0);
      
      // Simple heuristic: success rate based on how well learning progressed
      const successRate = avgConfidence;
      const learningProgress = avgConfidence >= 0.8 ? 1.0 : avgConfidence / 0.8;
      
      return {
        subagent,
        successRate,
        avgConfidence,
        decisionsCount,
        learningProgress,
      };
    }));
    
    // Get parameter evolution (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentSessions = await prisma.agentSession.findMany({
      where: {
        mode,
        startedAt: { gte: thirtyDaysAgo },
      },
      orderBy: { startedAt: 'asc' },
      select: {
        startedAt: true,
        profileJson: true,
      },
    });
    
    // Group by day and calculate averages
    const dailyStats = new Map<string, { leverage: number[]; positionSize: number[]; confidence: number[]; count: number }>();
    
    recentSessions.forEach(session => {
      const day = session.startedAt.toISOString().split('T')[0];
      if (!dailyStats.has(day)) {
        dailyStats.set(day, { leverage: [], positionSize: [], confidence: [], count: 0 });
      }
      
      const profile = (session.profileJson as any) || {};
      const stats = dailyStats.get(day)!;
      
      if (profile.maxLeverage) stats.leverage.push(Number(profile.maxLeverage));
      if (profile.budgetFraction) stats.positionSize.push(Number(profile.budgetFraction));
      
      // Get symbol states for this session
      const symbol = profile.symbol || '';
      const symbolStates = allStates.filter(s => s.symbol === symbol);
      if (symbolStates.length > 0) {
        const avgConf = symbolStates.reduce((sum, s) => sum + calculateConfidence(s.sampleCount), 0) / symbolStates.length;
        stats.confidence.push(avgConf);
      }
      
      stats.count++;
    });
    
    const parameterEvolution = Array.from(dailyStats.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, stats]) => ({
        date,
        avgLeverage: stats.leverage.length > 0 ? stats.leverage.reduce((a, b) => a + b, 0) / stats.leverage.length : 3,
        avgPositionSize: stats.positionSize.length > 0 ? stats.positionSize.reduce((a, b) => a + b, 0) / stats.positionSize.length : 0.15,
        avgConfidence: stats.confidence.length > 0 ? stats.confidence.reduce((a, b) => a + b, 0) / stats.confidence.length : 0.5,
        tradesCount: stats.count,
      }));
    
    // Calculate summary statistics
    const confidentSymbols = learningProgress.filter(s => s.status === 'confident').length;
    const learningSymbols = learningProgress.filter(s => s.status === 'learning').length;
    const avgConfidence = learningProgress.length > 0
      ? learningProgress.reduce((sum, s) => sum + s.confidence, 0) / learningProgress.length
      : 0;
    const totalTrades = learningProgress.reduce((sum, s) => sum + s.tradesCompleted, 0);
    
    res.json({
      learningProgress,
      subagentPerformance,
      parameterEvolution,
      summary: {
        totalSymbols: symbolMap.size,
        confidentSymbols,
        learningSymbols,
        avgConfidence,
        totalTrades,
      },
    });
  } catch (error: any) {
    console.error('Learning insights error:', error);
    res.status(500).json({ error: 'Failed to fetch learning insights', details: error.message });
  }
});

/**
 * Helper: Calculate confidence from sample count
 * Confidence = clamp(sampleCount / 40, 0.25, 1.0)
 */
function calculateConfidence(sampleCount: number): number {
  const confidence = sampleCount / 40;
  return Math.max(0.25, Math.min(1.0, confidence));
}

/**
 * Helper: Get neutral defaults for each subagent type
 */
function getNeutralDefaults(subagent: SubagentKind): any {
  switch (subagent) {
    case 'risk_governor':
      return {
        recommendedMaxLeverage: 3.5,
        recommendedMaxPositionPct: 0.18,
        hedgingTension: 0.30,
        correlationLimit: 0.70,
      };
    case 'execution':
      return {
        executionStrategy: 'market',
        slippageTolerance: 0.005,
        twapSlices: 3,
      };
    case 'predictor':
      return {
        confidenceThreshold: 0.55,
        directionBias: 'neutral',
      };
    case 'sentiment':
      return {
        newsWeight: 0.50,
        whaleWeight: 0.50,
        socialWeight: 0.30,
      };
    case 'market_quality':
      return {
        minLiquidityScore: 0.60,
        maxSpreadPct: 0.005,
        minDepthScore: 0.50,
      };
    case 'entry_timing':
      return {
        patience: 0.50,
        recommendation: 'immediate',
        pullbackThreshold: 0.02,
      };
    case 'exit_strategy':
      return {
        scaleOutPlan: [0.25, 0.50, 0.75, 1.0],
        trailingStopDistance: 0.025,
        rMultipleTargets: [1.5, 2.5, 4.0],
      };
    default:
      return {};
  }
}

export default router;
