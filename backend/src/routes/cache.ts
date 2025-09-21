import { Router } from 'express';
import { prisma } from '../db/client.js';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth.js';

export const router = Router();

// Helper function to normalize symbol for API routes
function normalizeSymbol(symbolParam: string): string {
  // Handle URL encoding and normalize to uppercase
  const decoded = decodeURIComponent(symbolParam);
  return decoded.toUpperCase();
}

// Test endpoint to verify symbol parsing
router.get('/test-symbol/:symbol(*)', (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);
  res.json({ 
    received: req.params.symbol,
    normalized: symbol,
    path: req.path,
    url: req.url
  });
});

// Cache for trading diagnostics with intelligent refresh
// Using wildcard pattern to capture symbols with slashes like AVAX/USDT
router.get('/trading-diagnostics/:symbol(*)', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const userId = req.user!.id;
    
    if (!symbol) {
      return res.status(400).json({ error: 'symbol_required' });
    }
    
    // Validate symbol format (allow letters, numbers, slashes, dashes)
    if (!/^[A-Z0-9\/\-]+$/.test(symbol)) {
      return res.status(400).json({ 
        error: 'invalid_symbol_format', 
        received: symbol,
        expected: 'Letters, numbers, slashes and dashes only'
      });
    }
    
    // Check if we have recent cached data (within 12 hours)
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    
    try {
      const cached = await prisma.diagnosticsCache.findFirst({
        where: {
          userId,
          symbol,
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
    } catch (cacheError) {
      console.warn('Cache lookup failed, proceeding without cache:', cacheError);
    }
    
    // Check daily limit (5 calls per day)
    const todayCalls = await getDailyCallsCount(userId);
    
    if (todayCalls >= 5) {
      return res.status(429).json({ 
        error: 'daily_limit_exceeded',
        message: 'You have reached the daily limit of 5 diagnostics calls. Use cached data or wait until tomorrow.',
        dailyCallsUsed: todayCalls
      });
    }
    
    // Generate new analysis
    const analysisData = await generateTradingDiagnostics(symbol, userId);
    
    // Try to cache the result (non-blocking)
    try {
      await prisma.diagnosticsCache.create({
        data: {
          userId,
          symbol,
          data: analysisData as any,
        }
      });
    } catch (cacheError) {
      console.warn('Failed to cache analysis:', cacheError);
    }
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      dailyCallsUsed: todayCalls + 1
    });
    
  } catch (error) {
    console.error('Trading diagnostics error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'internal_error', details: errorMessage });
  }
});

// Force refresh endpoint
router.post('/trading-diagnostics/:symbol(*)/refresh', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const userId = req.user!.id;
    
    if (!symbol) {
      return res.status(400).json({ error: 'symbol_required' });
    }
    
    // Validate symbol format
    if (!/^[A-Z0-9\/\-]+$/.test(symbol)) {
      return res.status(400).json({ error: 'invalid_symbol_format' });
    }
    
    // Check daily limit
    const todayCalls = await getDailyCallsCount(userId);
    
    if (todayCalls >= 5) {
      return res.status(429).json({ 
        error: 'daily_limit_exceeded',
        message: 'You have reached the daily limit of 5 diagnostics calls.',
        dailyCallsUsed: todayCalls
      });
    }
    
    // Generate fresh analysis
    const analysisData = await generateTradingDiagnostics(symbol, userId);
    
    // Try to cache the result (non-blocking)
    try {
      await prisma.diagnosticsCache.create({
        data: {
          userId,
          symbol,
          data: analysisData as any,
        }
      });
    } catch (cacheError) {
      console.warn('Failed to cache analysis:', cacheError);
    }
    
    res.json({
      data: analysisData,
      cached: false,
      timestamp: new Date(),
      dailyCallsUsed: todayCalls + 1
    });
    
  } catch (error) {
    console.error('Trading diagnostics refresh error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'internal_error', details: errorMessage });
  }
});

async function getDailyCallsCount(userId: string): Promise<number> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    return await prisma.diagnosticsCache.count({
      where: {
        userId,
        createdAt: { gte: todayStart }
      }
    });
  } catch (error) {
    console.warn('Failed to get daily calls count:', error);
    return 0; // Fallback to 0 if cache is unavailable
  }
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