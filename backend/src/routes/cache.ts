import { Router } from 'express';
import { prisma } from '../db/client.js';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';

export const router = Router();

// Cache for trading diagnostics with intelligent refresh
router.get('/trading-diagnostics/:symbol', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol } = req.params;
    const userId = req.user!.id;
    
    // Check if we have recent cached data (within 12 hours)
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    
    const cached = await prisma.diagnosticsCache.findFirst({
      where: {
        userId,
        symbol: symbol.toUpperCase(),
        createdAt: { gte: twelveHoursAgo }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    if (cached) {
      return res.json({
        data: cached.data,
        cached: true,
        timestamp: cached.createdAt,
        dailyCallsUsed: await getDailyCallsCount(userId)
      });
    }
    
    // Check daily limit (5 calls per day)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayCalls = await prisma.diagnosticsCache.count({
      where: {
        userId,
        createdAt: { gte: todayStart }
      }
    });
    
    if (todayCalls >= 5) {
      return res.status(429).json({ 
        error: 'daily_limit_exceeded',
        message: 'You have reached the daily limit of 5 diagnostics calls. Use cached data or wait until tomorrow.',
        dailyCallsUsed: todayCalls
      });
    }
    
    // Generate new analysis (this would trigger AI analysis)
    const analysisData = await generateTradingDiagnostics(symbol, userId);
    
    // Cache the result
    await prisma.diagnosticsCache.create({
      data: {
        userId,
        symbol: symbol.toUpperCase(),
        data: analysisData as any,
      }
    });
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      dailyCallsUsed: todayCalls + 1
    });
    
  } catch (error) {
    console.error('Trading diagnostics error:', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Force refresh endpoint
router.post('/trading-diagnostics/:symbol/refresh', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { symbol } = req.params;
    const userId = req.user!.id;
    
    // Check daily limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayCalls = await prisma.diagnosticsCache.count({
      where: {
        userId,
        createdAt: { gte: todayStart }
      }
    });
    
    if (todayCalls >= 5) {
      return res.status(429).json({ 
        error: 'daily_limit_exceeded',
        message: 'You have reached the daily limit of 5 diagnostics calls.',
        dailyCallsUsed: todayCalls
      });
    }
    
    // Generate fresh analysis
    const analysisData = await generateTradingDiagnostics(symbol, userId);
    
    // Cache the result
    await prisma.diagnosticsCache.create({
      data: {
        userId,
        symbol: symbol.toUpperCase(),
        data: analysisData as any,
      }
    });
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      dailyCallsUsed: todayCalls + 1
    });
    
  } catch (error) {
    console.error('Trading diagnostics refresh error:', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

async function getDailyCallsCount(userId: string): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  
  return await prisma.diagnosticsCache.count({
    where: {
      userId,
      createdAt: { gte: todayStart }
    }
  });
}

async function generateTradingDiagnostics(symbol: string, userId: string) {
  // Import the existing trading analysis logic
  const { buildTechSnapshot } = await import('../ai/tech.js');
  const { requestStrategy } = await import('../ai/strategyManager.js');
  
  try {
    const [tech, strategy] = await Promise.all([
      buildTechSnapshot(symbol),
      requestStrategy({ 
        symbol, 
        trigger: 'diagnostics',
        fresh: true,
        force: false // Don't force to respect AI limits
      }).catch(() => null)
    ]);
    
    return {
      symbol,
      technical: tech,
      strategy: strategy?.strategy || null,
      levels: strategy?.levels || null,
      timestamp: new Date().toISOString(),
      source: 'fresh_analysis'
    };
  } catch (error) {
    console.error('Error generating trading diagnostics:', error);
    throw error;
  }
}